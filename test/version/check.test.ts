import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http/client.js";
import { JournalService } from "../../src/journal/service.js";
import { SecretStore } from "../../src/settings/secrets.js";
import { Settings } from "../../src/settings/settings.js";
import { SettingsPage } from "../../src/settings/page.js";
import { registerJournalTools } from "../../src/tools/journal.js";
import { registerSettingsTools } from "../../src/tools/settings.js";
import { VersionCheck } from "../../src/version/check.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch, jsonResponse } from "../helpers/fakeFetch.js";

const URL_ = "https://github.com/pilotso11/ed-mcp/releases/tag/v0.4.0";
const NOW = Date.parse("2026-10-18T12:00:00Z");
const HOUR = 3_600_000;

const release = (tag: string) => () => jsonResponse({ tag_name: tag, html_url: URL_ });

const started: VersionCheck[] = [];
afterEach(() => {
  for (const c of started.splice(0)) c.stop();
  vi.useRealTimers();
});

async function setup(respond: () => Response | Promise<Response>, current = "0.3.1") {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "vcheck-"));
  const fetchFn = fakeFetch([{ match: (u) => u.includes("api.github.com"), respond }]);
  const http = new HttpClient({ userAgent: "t", fetchFn, retryDelayMs: 0 });
  const clock = { now: NOW };
  const check = new VersionCheck({ http, cacheDir, current, now: () => clock.now });
  started.push(check);
  return { check, clock, fetchFn, cacheDir, file: path.join(cacheDir, "version-check.json") };
}

async function run(check: VersionCheck) {
  check.start();
  await check.whenIdle();
  return check.notice();
}

describe("VersionCheck", () => {
  it("reports a newer release and strips the leading v", async () => {
    const { check, file } = await setup(release("v0.4.0"));
    expect(await run(check)).toBe(`ed-mcp 0.4.0 is available (you have 0.3.1): ${URL_}`);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      checked_at: NOW,
      latest: "0.4.0",
      url: URL_,
    });
  });

  it("compares numerically, not as text", async () => {
    const { check } = await setup(release("v0.10.0"), "0.9.0");
    expect(await run(check)).toContain("0.10.0 is available");
  });

  it.each(["v0.3.1", "v0.3.0", "v0.2.9"])("gives no notice for %s", async (tag) => {
    const { check } = await setup(release(tag));
    expect(await run(check)).toBeNull();
  });

  it("never reports a pre-release", async () => {
    const { check } = await setup(release("v0.5.0-beta.1"));
    expect(await run(check)).toBeNull();
  });

  it("gives no notice when the current version does not parse", async () => {
    const { check } = await setup(release("v0.4.0"), "dev");
    expect(await run(check)).toBeNull();
  });

  it("stays silent on a 404, a server error, bad JSON and a missing field", async () => {
    const cases = [
      () => new Response("nope", { status: 404 }),
      () => new Response("nope", { status: 500 }),
      () => new Response("not json", { status: 200 }),
      () => jsonResponse({ tag_name: "v9.0.0" }),
    ];
    for (const respond of cases) {
      const { check, file } = await setup(respond);
      expect(await run(check)).toBeNull();
      await expect(readFile(file, "utf8")).rejects.toThrow();
    }
  });

  it("stays silent when the network fails", async () => {
    const { check } = await setup(() => {
      throw new Error("offline");
    });
    expect(await run(check)).toBeNull();
  });

  it("makes no request when the cache is under 24 hours old", async () => {
    const { check, fetchFn, file } = await setup(release("v0.4.0"));
    await writeFile(
      file,
      JSON.stringify({ checked_at: NOW - 23 * HOUR, latest: "0.3.5", url: URL_ }),
    );
    expect(await run(check)).toContain("0.3.5 is available");
    expect(fetchFn.calls).toHaveLength(0);
  });

  it("makes one request when the cache is over 24 hours old", async () => {
    const { check, fetchFn, file } = await setup(release("v0.4.0"));
    await writeFile(
      file,
      JSON.stringify({ checked_at: NOW - 25 * HOUR, latest: "0.3.5", url: URL_ }),
    );
    expect(await run(check)).toContain("0.4.0 is available");
    expect(fetchFn.calls).toHaveLength(1);
  });

  it("refreshes when checked_at is in the future (clock set back)", async () => {
    const { check, fetchFn, file } = await setup(release("v0.4.0"));
    await writeFile(file, JSON.stringify({ checked_at: NOW + HOUR, latest: "0.3.5", url: URL_ }));
    check.start();
    await check.whenIdle();
    expect(fetchFn.calls).toHaveLength(1);
  });

  it("notice() makes no request and writes nothing, even with a stale or missing cache", async () => {
    const { check, fetchFn, file } = await setup(release("v0.4.0"));
    expect(await check.notice()).toBeNull();
    await writeFile(
      file,
      JSON.stringify({ checked_at: NOW - 25 * HOUR, latest: "0.3.5", url: URL_ }),
    );
    expect(await check.notice()).toContain("0.3.5 is available");
    await check.whenIdle();
    expect(fetchFn.calls).toHaveLength(0);
  });

  it("keeps the old cache when a refresh fails", async () => {
    const { check, file } = await setup(() => new Response("", { status: 404 }));
    const old = { checked_at: NOW - 25 * HOUR, latest: "0.3.5", url: URL_ };
    await writeFile(file, JSON.stringify(old));
    expect(await run(check)).toContain("0.3.5 is available");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(old);
  });
});

describe("error logging", () => {
  it("logs one line for an unexpected error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cacheDir = await mkdtemp(path.join(os.tmpdir(), "vcheck-"));
      // HttpClient turns every fetch failure into an HttpError, so a stub is the only way to get a plain Error.
      const http = {
        json: async () => {
          throw new Error("boom");
        },
      } as unknown as HttpClient;
      const check = new VersionCheck({ http, cacheDir, current: "0.3.1", now: () => NOW });
      started.push(check);
      check.start();
      await check.whenIdle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("ed-mcp version check failed: boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("logs nothing for a 404", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { check } = await setup(() => new Response("", { status: 404 }));
      await run(check);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("schedule", () => {
  // Only setTimeout is faked: the check does real file I/O, which fake timers cannot advance.
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("retries a failed check after one hour, not before", async () => {
    fakeTimers();
    let fail = true;
    const { check, clock, fetchFn } = await setup(() =>
      fail ? new Response("", { status: 404 }) : release("v0.4.0")(),
    );
    check.start();
    await check.whenIdle();
    expect(fetchFn.calls).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(HOUR - 1000);
    expect(fetchFn.calls).toHaveLength(1);
    clock.now += HOUR;
    await vi.advanceTimersByTimeAsync(1000);
    await check.whenIdle();
    expect(fetchFn.calls).toHaveLength(2);
    expect(await check.notice()).toContain("0.4.0 is available");
  });

  it("re-checks a day after a successful check, not before", async () => {
    fakeTimers();
    const { check, clock, fetchFn } = await setup(release("v0.4.0"));
    check.start();
    await check.whenIdle();
    expect(fetchFn.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * HOUR - 1000);
    expect(fetchFn.calls).toHaveLength(1);
    clock.now += 24 * HOUR;
    await vi.advanceTimersByTimeAsync(1000);
    await check.whenIdle();
    expect(fetchFn.calls).toHaveLength(2);
  });

  it("stop() cancels the next check", async () => {
    fakeTimers();
    const { check, clock, fetchFn } = await setup(release("v0.4.0"));
    check.start();
    await check.whenIdle();
    check.stop();
    clock.now += 25 * HOUR;
    await vi.advanceTimersByTimeAsync(25 * HOUR);
    expect(fetchFn.calls).toHaveLength(1);
  });
});

describe("tools show the notice", () => {
  const update = async () => "ed-mcp 0.4.0 is available (you have 0.3.1): u";

  it("settings_status has an update field", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vcheck-settings-"));
    const secrets = new SecretStore(path.join(dir, "secrets.json"));
    const settings = new Settings({}, { appName: "ed-mcp", devMode: false }, secrets);
    const page = new SettingsPage({ secrets, settings }, { openUrl: async () => undefined });
    for (const [fn, expected] of [
      [update, await update()],
      [async () => null, null],
      [undefined, null],
    ] as const) {
      const server = new McpServer({ name: "t", version: "0" });
      registerSettingsTools(server, { page, settings, secrets, update: fn });
      const r = (await callTool(await connectTestClient(server), "settings_status")).json as any;
      expect(r.update).toBe(expected);
    }
  });

  it("journal_status adds it to warnings, and works when the check finds nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vcheck-journal-"));
    const run = async (fn?: () => Promise<string | null>) => {
      const server = new McpServer({ name: "t", version: "0" });
      registerJournalTools(server, { journal: new JournalService(dir), update: fn });
      return (await callTool(await connectTestClient(server), "journal_status")).json as any;
    };
    expect((await run(update)).warnings).toContain(await update());
    expect((await run(async () => null)).warnings).not.toContain(await update());
    expect((await run()).exists).toBeDefined();
  });
});
