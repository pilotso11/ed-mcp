import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CapiConfig } from "../config.js";
import { NotConfiguredError, UserError } from "../errors.js";
import type { HttpClient } from "../http/client.js";
import { openInBrowser } from "./browser.js";
import { createPkce, randomState } from "./pkce.js";
import type { StoredTokens, TokenStore } from "./tokens.js";

const DAY = 86_400_000;
const REFRESH_WINDOW = 25 * DAY;

export type LoginState =
  | { state: "logged_out" }
  | { state: "waiting"; url: string; expires_at: string }
  | { state: "logged_in"; authorized_at: string; reauth_by: string }
  | { state: "failed"; error: string };

interface Pending {
  url: string;
  expiresAt: number;
  servers: Server[];
  done: Promise<void>;
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>ed-mcp</title><p>${msg}</p>`;

export class CapiAuth {
  private pending: Pending | null = null;
  private failure: string | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly authBase: string;
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly loginTimeoutMs: number;

  constructor(
    private readonly http: HttpClient,
    private readonly cfg: CapiConfig | undefined,
    private readonly tokens: TokenStore,
    opts: {
      authBase?: string;
      openUrl?: (url: string) => Promise<void>;
      now?: () => number;
      loginTimeoutMs?: number;
    } = {},
  ) {
    this.authBase = opts.authBase ?? "https://auth.frontierstore.net";
    this.openUrl = opts.openUrl ?? openInBrowser;
    this.now = opts.now ?? Date.now;
    this.loginTimeoutMs = opts.loginTimeoutMs ?? 5 * 60_000;
  }

  async state(): Promise<LoginState> {
    if (this.pending) {
      return {
        state: "waiting",
        url: this.pending.url,
        expires_at: new Date(this.pending.expiresAt).toISOString(),
      };
    }
    if (this.failure) return { state: "failed", error: this.failure };
    const t = await this.tokens.load();
    if (!t || this.now() - t.authorized_at > REFRESH_WINDOW) return { state: "logged_out" };
    return {
      state: "logged_in",
      authorized_at: new Date(t.authorized_at).toISOString(),
      reauth_by: new Date(t.authorized_at + REFRESH_WINDOW).toISOString(),
    };
  }

  async startLogin(): Promise<LoginState> {
    const cfg = this.requireConfig();
    if (this.pending) return this.state();
    this.failure = null;
    const { verifier, challenge } = createPkce();
    const state = randomState();

    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    const servers: Server[] = [];
    const finish = (error: string | null) => {
      for (const s of servers) s.close();
      clearTimeout(timer);
      this.pending = null;
      this.failure = error;
      settle();
    };

    const handler = createHandler(async (code, gotState) => {
      if (gotState !== state) {
        finish("Login failed: state mismatch");
        return {
          status: 400,
          body: PAGE("Login failed: state mismatch. Start again from Claude."),
        };
      }
      try {
        await this.exchange(cfg, code, verifier, redirectUri);
        finish(null);
        return { status: 200, body: PAGE("Logged in to Frontier. You can close this tab.") };
      } catch (err) {
        finish(`Login failed: ${(err as Error).message}`);
        return { status: 500, body: PAGE("Login failed. Check Claude for details.") };
      }
    });

    // The redirect uses the name "localhost", which may resolve to IPv4 or IPv6.
    const v4 = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      v4.once("error", reject);
      v4.listen(0, "127.0.0.1", resolve);
    });
    servers.push(v4);
    const port = (v4.address() as AddressInfo).port;
    const v6 = createServer(handler);
    await new Promise<void>((resolve) => {
      v6.once("error", () => resolve()); // no IPv6 loopback: IPv4 is enough
      v6.listen(port, "::1", () => {
        servers.push(v6);
        resolve();
      });
    });

    const redirectUri = `http://localhost:${port}/auth`;
    const url = new URL(`${this.authBase}/auth`);
    url.search = new URLSearchParams({
      response_type: "code",
      audience: "frontier,steam,epic",
      scope: "auth capi",
      client_id: cfg.clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      redirect_uri: redirectUri,
    }).toString();

    const timer = setTimeout(
      () => finish("Login timed out. Call capi_login to try again."),
      this.loginTimeoutMs,
    );
    timer.unref();
    this.pending = { url: url.href, expiresAt: this.now() + this.loginTimeoutMs, servers, done };
    await this.openUrl(url.href).catch(() => undefined); // the URL is returned for manual opening
    return this.state();
  }

  /** Resolves when the current login attempt finishes (tests and diagnostics). */
  async waitForLogin(): Promise<void> {
    await this.pending?.done;
  }

  async accessToken(): Promise<string> {
    const cfg = this.requireConfig();
    const t = await this.tokens.load();
    if (!t) throw new UserError("Not logged in to Frontier. Call capi_login first.");
    if (this.now() - t.authorized_at > REFRESH_WINDOW) {
      await this.tokens.clear();
      throw new UserError(
        "Frontier login expired (25-day limit). Call capi_login to log in again.",
      );
    }
    if (t.access_token && t.expires_at - 60_000 > this.now()) return t.access_token;
    // Refresh tokens rotate, so concurrent refreshes must share one request.
    this.refreshing ??= this.refresh(cfg, t).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Forces the next accessToken() call to refresh (after a 401 from CAPI). */
  async invalidate(): Promise<void> {
    const t = await this.tokens.load();
    if (t) await this.tokens.save({ ...t, access_token: null, expires_at: 0 });
  }

  async logout(): Promise<void> {
    await this.tokens.clear();
    this.failure = null;
  }

  private requireConfig(): CapiConfig {
    if (!this.cfg) throw new NotConfiguredError("Frontier CAPI", ["CAPI_CLIENT_ID"]);
    return this.cfg;
  }

  private async exchange(cfg: CapiConfig, code: string, verifier: string, redirectUri: string) {
    const res = await this.token({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code_verifier: verifier,
      code,
      redirect_uri: redirectUri,
    });
    await this.tokens.save({
      refresh_token: res.refresh_token,
      access_token: res.access_token,
      expires_at: this.now() + res.expires_in * 1000,
      authorized_at: this.now(),
    });
  }

  private async refresh(cfg: CapiConfig, t: StoredTokens): Promise<string> {
    let res: { access_token: string; refresh_token: string; expires_in: number };
    try {
      res = await this.token({
        grant_type: "refresh_token",
        client_id: cfg.clientId,
        refresh_token: t.refresh_token,
      });
    } catch (err) {
      await this.tokens.clear();
      throw new UserError(
        `Frontier refused to refresh the login (${(err as Error).message}). Call capi_login to log in again.`,
      );
    }
    await this.tokens.save({
      refresh_token: res.refresh_token,
      access_token: res.access_token,
      expires_at: this.now() + res.expires_in * 1000,
      authorized_at: t.authorized_at,
    });
    return res.access_token;
  }

  private token(form: Record<string, string>) {
    return this.http.json<{ access_token: string; refresh_token: string; expires_in: number }>(
      `${this.authBase}/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      },
    );
  }
}

function createHandler(
  onCallback: (code: string, state: string | null) => Promise<{ status: number; body: string }>,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code");
    if (url.pathname !== "/auth" || !code) {
      res.writeHead(404).end();
      return;
    }
    void onCallback(code, url.searchParams.get("state")).then(({ status, body }) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    });
  };
}
