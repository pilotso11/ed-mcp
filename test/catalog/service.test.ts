import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogService } from "../../src/catalog/service.js";
import type { RawSources } from "../../src/catalog/types.js";
import { HttpClient } from "../../src/http/client.js";
import { fakeFetch, stalledBody, unreadResponse } from "../helpers/fakeFetch.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

const SOURCES: Record<keyof RawSources, string> = {
  blueprints: "https://raw.test/blueprints.json",
  specials: "https://raw.test/specials.json",
  modifications: "https://raw.test/modules.json",
  materials: "https://raw.test/material.csv",
  outfitting: "https://raw.test/outfitting.csv",
};
const DAY = 86_400_000;

let dir: string;
let raw: RawSources;
let t: number;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "catalog-"));
  raw = await rawFixture();
  t = Date.parse("2026-10-11T00:00:00Z");
});

/** Upstream that serves raw texts with ETags and answers If-None-Match with 304. */
function upstream(texts: () => RawSources, failKey?: keyof RawSources) {
  return fakeFetch([
    {
      match: () => true,
      respond: (url, init) => {
        const key = (Object.keys(SOURCES) as Array<keyof RawSources>).find(
          (k) => SOURCES[k] === url,
        )!;
        if (key === failKey) return new Response("", { status: 404 });
        const body = texts()[key];
        const etag = `"${key}-${body.length}"`;
        if (new Headers(init?.headers).get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return new Response(body, { status: 200, headers: { etag } });
      },
    },
  ]);
}

const service = (f: ReturnType<typeof fakeFetch>) =>
  new CatalogService(new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }), dir, {
    statics: staticsFixture,
    now: () => t,
    minimums: SMALL,
    sources: SOURCES,
  });

describe("CatalogService", () => {
  it("downloads on first use and writes the disk cache", async () => {
    const f = upstream(() => raw);
    const s = service(f);
    const cat = await s.get();
    expect(cat.counts().blueprints).toBe(3);
    expect(f.calls).toHaveLength(5);
    expect(await readFile(path.join(dir, "catalog", "materials.raw"), "utf8")).toBe(raw.materials);
    const meta = JSON.parse(await readFile(path.join(dir, "catalog", "meta.json"), "utf8"));
    expect(meta.files.blueprints.etag).toMatch(/^"blueprints-/);
    expect(s.status()).toMatchObject({ state: "ready", checked_at: "2026-10-11T00:00:00.000Z" });
  });

  it("loads from disk without network on the next start", async () => {
    await service(upstream(() => raw)).get();
    const f2 = upstream(() => raw);
    await service(f2).get();
    expect(f2.calls).toHaveLength(0);
  });

  it("uses conditional requests and reports unchanged files", async () => {
    const s = service(upstream(() => raw));
    await s.get();
    expect(await s.refresh()).toEqual({
      changed: [],
      unchanged: ["blueprints", "specials", "modifications", "materials", "outfitting"],
      warnings: expect.any(Number),
    });
  });

  it("swaps in changed data", async () => {
    let current = raw;
    const s = service(upstream(() => current));
    await s.get();
    const extra = raw.materials.trimEnd() + "\n999,Zinc,2,Raw,6,Zinc\n";
    current = { ...raw, materials: extra };
    const r = await s.refresh();
    expect(r.changed).toEqual(["materials"]);
    expect((await s.get()).material("Zinc").grade).toBe(2);
  });

  it("keeps the old catalog when new data is invalid", async () => {
    let current = raw;
    const s = service(upstream(() => current));
    await s.get();
    current = { ...raw, blueprints: "{" };
    await expect(s.refresh()).rejects.toThrow(/keeping current data.*blueprints/);
    expect((await s.get()).counts().blueprints).toBe(3);
    expect(await readFile(path.join(dir, "catalog", "blueprints.raw"), "utf8")).toBe(
      raw.blueprints,
    );
    expect(s.status().last_error).toMatch(/blueprints/);
  });

  it("explains when the first download fails", async () => {
    const s = service(upstream(() => raw, "materials"));
    await expect(s.get()).rejects.toThrow(
      /Game data catalog is not available.*materials.*HTTP 404/,
    );
    expect(s.status().state).toBe("error");
  });

  it("cancels the body of an unexpected status response", async () => {
    const { res, cancelled } = unreadResponse(404);
    const s = service(fakeFetch([{ match: () => true, respond: () => res }]));
    await expect(s.get()).rejects.toThrow(/HTTP 404/);
    expect(cancelled()).toBe(true);
  });

  it("reports a stalled body with the host and timeout", async () => {
    const s = new CatalogService(
      new HttpClient({ userAgent: "t", fetchFn: stalledBody(), timeoutMs: 20, retryDelayMs: 0 }),
      dir,
      { statics: staticsFixture, now: () => t, minimums: SMALL, sources: SOURCES },
    );
    await expect(s.get()).rejects.toThrow(/blueprints: raw\.test: timed out after 20 ms/);
  });

  it("refreshes in the background when older than 7 days", async () => {
    const f = upstream(() => raw);
    const s = service(f);
    await s.get();
    t += 8 * DAY;
    await s.get();
    // The refresh runs in the background; a slow CI runner needs more than a fixed delay.
    await vi.waitFor(() => expect(s.status().checked_at).toBe(new Date(t).toISOString()));
    expect(f.calls.length).toBe(10);
  });

  it("peek returns null without fetching when nothing is cached", async () => {
    const f = fakeFetch([]);
    const s = service(f);
    expect(await s.peek()).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(s.status().state).toBe("empty");
  });

  it("peek loads the disk cache without fetching, even when stale", async () => {
    await service(upstream(() => raw)).get();
    t += 8 * DAY;
    const f = fakeFetch([]);
    const s = service(f);
    expect((await s.peek())?.counts().blueprints).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toHaveLength(0);
    expect(s.status().state).toBe("ready");
  });

  it("peek returns the catalog already in memory", async () => {
    const s = service(upstream(() => raw));
    const cat = await s.get();
    expect(await s.peek()).toBe(cat);
  });

  it("ignores a corrupt disk cache and downloads again", async () => {
    await service(upstream(() => raw)).get();
    await writeFile(path.join(dir, "catalog", "blueprints.raw"), "{");
    const f2 = upstream(() => raw);
    expect((await service(f2).get()).counts().blueprints).toBe(3);
    expect(f2.calls.length).toBe(5);
  });
});
