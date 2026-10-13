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
let sessionChanges: number;
beforeEach(async () => {
  sessionChanges = 0;
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
      onSessionChange: () => void sessionChanges++,
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
    expect(sessionChanges).toBe(1);
  });

  it("signals a session change on logout", async () => {
    await tokens.save({
      refresh_token: "R",
      access_token: "A",
      expires_at: t + 1,
      authorized_at: t,
    });
    const { auth } = make([]);
    await auth.logout();
    expect(sessionChanges).toBe(1);
    expect(await tokens.load()).toBeNull();
  });

  it("does not retry the code exchange on a server error", async () => {
    const opened: string[] = [];
    const { auth, f } = make(
      [{ match: () => true, respond: () => new Response("", { status: 502 }) }],
      opened,
    );
    await auth.startLogin();
    const q = new URL(opened[0]!).searchParams;
    const redirect = new URL(q.get("redirect_uri")!);
    await fetch(`http://127.0.0.1:${redirect.port}/auth?code=C1&state=${q.get("state")}`);
    await auth.waitForLogin();
    expect(f.calls).toHaveLength(1);
    expect(await auth.state()).toMatchObject({ state: "failed" });
    expect(sessionChanges).toBe(0);
  });

  it("answers a wrong-state callback with 400 and keeps waiting", async () => {
    const opened: string[] = [];
    const { auth } = make([], opened);
    await auth.startLogin();
    const redirect = new URL(new URL(opened[0]!).searchParams.get("redirect_uri")!);
    const cb = await fetch(`http://127.0.0.1:${redirect.port}/auth?code=C1&state=wrong`);
    expect(cb.status).toBe(400);
    expect((await auth.state()).state).toBe("waiting");
  });

  it("fails the login when the user denies access", async () => {
    const opened: string[] = [];
    const { auth } = make([], opened);
    await auth.startLogin();
    const q = new URL(opened[0]!).searchParams;
    const redirect = new URL(q.get("redirect_uri")!);
    const cb = await fetch(
      `http://127.0.0.1:${redirect.port}/auth?error=access_denied&state=${q.get("state")}`,
    );
    expect(cb.status).toBe(400);
    await auth.waitForLogin();
    expect(await auth.state()).toEqual({ state: "failed", error: "Login failed: access_denied" });
  });

  it("reports logged_in on a second call without opening a browser", async () => {
    await tokens.save({
      refresh_token: "R",
      access_token: "A",
      expires_at: t + 1,
      authorized_at: t,
    });
    const opened: string[] = [];
    const { auth } = make([], opened);
    expect((await auth.startLogin()).state).toBe("logged_in");
    expect(opened).toHaveLength(0);
    expect((await auth.startLogin({ force: true })).state).toBe("waiting");
    expect(opened).toHaveLength(1);
  });

  it("replaces a pending login when forced", async () => {
    const opened: string[] = [];
    const { auth } = make([], opened);
    await auth.startLogin();
    const first = new URL(opened[0]!).searchParams;
    const restarted = await auth.startLogin({ force: true });
    expect(restarted.state).toBe("waiting");
    expect(opened).toHaveLength(2);
    const second = new URL(opened[1]!).searchParams;
    expect(second.get("state")).not.toBe(first.get("state"));
    expect(restarted).toMatchObject({ url: opened[1] });
    const oldPort = new URL(first.get("redirect_uri")!).port;
    await expect(
      fetch(`http://127.0.0.1:${oldPort}/auth?error=access_denied&state=${first.get("state")}`),
    ).rejects.toThrow();
    expect(await auth.state()).toMatchObject({ state: "waiting", url: opened[1] });
  });

  it("does not let a cancelled login's code exchange store tokens", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const opened: string[] = [];
    const { auth, f } = make(
      [
        {
          match: () => true,
          respond: async () => {
            await gate;
            return jsonResponse({ access_token: "A1", refresh_token: "R1", expires_in: 14400 });
          },
        },
      ],
      opened,
    );
    await auth.startLogin();
    const q = new URL(opened[0]!).searchParams;
    const redirect = new URL(q.get("redirect_uri")!);
    const cb = fetch(`http://127.0.0.1:${redirect.port}/auth?code=C1&state=${q.get("state")}`);
    while (f.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    await auth.startLogin({ force: true });
    release();
    await cb;
    expect(await tokens.load()).toBeNull();
    expect(await auth.state()).toMatchObject({ state: "waiting", url: opened[1] });
    expect(sessionChanges).toBe(0);
  });

  it("reports a failure once, then starts a new flow", async () => {
    const opened: string[] = [];
    const { auth } = make([], opened);
    await auth.startLogin();
    const q = new URL(opened[0]!).searchParams;
    const redirect = new URL(q.get("redirect_uri")!);
    await fetch(
      `http://127.0.0.1:${redirect.port}/auth?error=access_denied&state=${q.get("state")}`,
    );
    await auth.waitForLogin();
    expect(await auth.startLogin()).toEqual({
      state: "failed",
      error: "Login failed: access_denied",
    });
    expect(opened).toHaveLength(1);
    expect((await auth.startLogin()).state).toBe("waiting");
    expect(opened).toHaveLength(2);
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

  it("keeps tokens when the refresh fails with a server error, without retrying", async () => {
    await tokens.save({ refresh_token: "R", access_token: null, expires_at: 0, authorized_at: t });
    const { auth, f } = make([
      { match: () => true, respond: () => new Response("", { status: 503 }) },
    ]);
    await expect(auth.accessToken()).rejects.toThrow(/Could not reach Frontier/);
    expect(await tokens.load()).toMatchObject({ refresh_token: "R" });
    // A retry could resend a refresh token that Frontier already rotated.
    expect(f.calls).toHaveLength(1);
  });

  it("keeps tokens when the refresh is rate limited", async () => {
    await tokens.save({ refresh_token: "R", access_token: null, expires_at: 0, authorized_at: t });
    const { auth } = make([
      { match: () => true, respond: () => new Response("", { status: 429 }) },
    ]);
    await expect(auth.accessToken()).rejects.toThrow(/Could not reach Frontier/);
    expect(await tokens.load()).toMatchObject({ refresh_token: "R" });
  });

  it("uses tokens rotated by another process instead of clearing", async () => {
    await tokens.save({ refresh_token: "R", access_token: null, expires_at: 0, authorized_at: t });
    const { auth, f } = make([
      {
        match: () => true,
        respond: async (_u, init) => {
          const rt = new URLSearchParams(String(init!.body)).get("refresh_token");
          if (rt === "R") {
            // Another process rotated the token while this request was in flight.
            await tokens.save({
              refresh_token: "R9",
              access_token: null,
              expires_at: 0,
              authorized_at: t,
            });
            return new Response("", { status: 400 });
          }
          return jsonResponse({ access_token: "A9", refresh_token: "R10", expires_in: 14400 });
        },
      },
    ]);
    expect(await auth.accessToken()).toBe("A9");
    expect(f.calls).toHaveLength(2);
    expect(await tokens.load()).toMatchObject({ refresh_token: "R10" });
  });

  it("does not restore the old refresh token when invalidate runs during a refresh", async () => {
    await tokens.save({ refresh_token: "R", access_token: null, expires_at: 0, authorized_at: t });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { auth, f } = make([
      {
        match: () => true,
        respond: async () => {
          await gate;
          return jsonResponse({ access_token: "A2", refresh_token: "R2", expires_in: 14400 });
        },
      },
    ]);
    const access = auth.accessToken();
    while (f.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    const inval = auth.invalidate();
    release();
    await Promise.all([access, inval]);
    expect(await tokens.load()).toMatchObject({ refresh_token: "R2", access_token: "A2" });
  });
});
