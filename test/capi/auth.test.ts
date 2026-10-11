import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapiAuth } from "../../src/capi/auth.js";
import { TokenStore } from "../../src/capi/tokens.js";
import { HttpClient } from "../../src/http/client.js";
import { NotConfiguredError } from "../../src/errors.js";
import { fakeFetch, jsonResponse } from "../helpers/fakeFetch.js";

const DAY = 86_400_000;
let tokens: TokenStore;
let t: number;
beforeEach(async () => {
  tokens = new TokenStore(path.join(await mkdtemp(path.join(os.tmpdir(), "auth-")), "t.json"));
  t = Date.parse("2026-10-11T00:00:00Z");
});

function make(routes: Parameters<typeof fakeFetch>[0], opened: string[] = []) {
  const f = fakeFetch(routes);
  const auth = new CapiAuth(
    new HttpClient({ userAgent: "EDCD-EdMcp-0.1.0", fetchFn: f, retryDelayMs: 0 }),
    { clientId: "cid" },
    tokens,
    {
      authBase: "https://auth.test",
      openUrl: async (u) => void opened.push(u),
      now: () => t,
      loginTimeoutMs: 2_000,
    },
  );
  return { auth, f };
}

describe("CapiAuth login", () => {
  it("opens the browser, receives the callback and stores tokens", async () => {
    const opened: string[] = [];
    const { auth, f } = make(
      [
        {
          match: (u) => u === "https://auth.test/token",
          respond: () =>
            jsonResponse({
              access_token: "A1",
              refresh_token: "R1",
              expires_in: 14400,
              token_type: "Bearer",
            }),
        },
      ],
      opened,
    );
    const started = await auth.startLogin();
    expect(started.state).toBe("waiting");
    const url = new URL(opened[0]!);
    expect(url.origin + url.pathname).toBe("https://auth.test/auth");
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      response_type: "code",
      audience: "frontier,steam,epic",
      scope: "auth capi",
      client_id: "cid",
      code_challenge_method: "S256",
    });
    const redirect = new URL(q.redirect_uri!);
    expect(redirect.hostname).toBe("localhost");
    expect(redirect.pathname).toBe("/auth");

    // Simulate the browser following the redirect.
    const cb = await fetch(`http://127.0.0.1:${redirect.port}/auth?code=C1&state=${q.state}`);
    expect(await cb.text()).toMatch(/close this tab/i);
    await auth.waitForLogin();

    const form = new URLSearchParams(String(f.calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "cid",
      code: "C1",
      redirect_uri: q.redirect_uri,
    });
    expect(form.get("code_verifier")).toBeTruthy();
    expect(await tokens.load()).toEqual({
      refresh_token: "R1",
      access_token: "A1",
      expires_at: t + 14_400_000,
      authorized_at: t,
    });
    expect((await auth.state()).state).toBe("logged_in");
  });

  it("rejects a callback with the wrong state", async () => {
    const opened: string[] = [];
    const { auth } = make([], opened);
    await auth.startLogin();
    const redirect = new URL(new URL(opened[0]!).searchParams.get("redirect_uri")!);
    const cb = await fetch(`http://127.0.0.1:${redirect.port}/auth?code=C1&state=wrong`);
    expect(cb.status).toBe(400);
    await auth.waitForLogin();
    expect(await auth.state()).toEqual({ state: "failed", error: "Login failed: state mismatch" });
  });

  it("requires config", async () => {
    const auth = new CapiAuth(new HttpClient({ userAgent: "x" }), undefined, tokens);
    await expect(auth.startLogin()).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("CapiAuth tokens", () => {
  it("returns a valid access token without refreshing", async () => {
    await tokens.save({
      refresh_token: "R",
      access_token: "A",
      expires_at: t + 3_600_000,
      authorized_at: t,
    });
    const { auth, f } = make([]);
    expect(await auth.accessToken()).toBe("A");
    expect(f.calls).toHaveLength(0);
  });

  it("refreshes an expired token and stores the rotated refresh token", async () => {
    await tokens.save({
      refresh_token: "R",
      access_token: "A",
      expires_at: t - 1,
      authorized_at: t - DAY,
    });
    const { auth, f } = make([
      {
        match: () => true,
        respond: () => jsonResponse({ access_token: "A2", refresh_token: "R2", expires_in: 14400 }),
      },
    ]);
    expect(await auth.accessToken()).toBe("A2");
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0]!.init!.body)))).toEqual({
      grant_type: "refresh_token",
      client_id: "cid",
      refresh_token: "R",
    });
    expect(await tokens.load()).toMatchObject({ refresh_token: "R2", authorized_at: t - DAY });
  });

  it("asks for a new login after 25 days", async () => {
    await tokens.save({
      refresh_token: "R",
      access_token: null,
      expires_at: 0,
      authorized_at: t - 26 * DAY,
    });
    const { auth } = make([]);
    await expect(auth.accessToken()).rejects.toThrow(/expired.*capi_login/);
  });

  it("clears tokens when refresh is rejected", async () => {
    await tokens.save({ refresh_token: "R", access_token: null, expires_at: 0, authorized_at: t });
    const { auth } = make([
      { match: () => true, respond: () => new Response("", { status: 401 }) },
    ]);
    await expect(auth.accessToken()).rejects.toThrow(/capi_login/);
    expect(await tokens.load()).toBeNull();
  });

  it("explains when not logged in", async () => {
    const { auth } = make([]);
    await expect(auth.accessToken()).rejects.toThrow(
      "Not logged in to Frontier. Call capi_login first.",
    );
  });
});
