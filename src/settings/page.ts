import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { openInBrowser } from "../capi/browser.js";
import { UserError } from "../errors.js";
import { SecretsError } from "./crypto.js";
import { WrongPasswordError, type SecretStore, type ServiceKey } from "./secrets.js";
import type { Settings, SourceInfo } from "./settings.js";

const TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 16 * 1024;

class BodyTooLarge extends Error {}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// A short key would be mostly revealed by its last 4 characters.
const mask = (k: string | undefined) =>
  !k ? "not set" : k.length <= 8 ? "set" : `…${esc(k.slice(-4))}`;
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>ed-mcp settings</title>` +
  `<style>body{font:15px system-ui;max-width:640px;margin:2em auto}label{display:block;margin:.6em 0}` +
  `input[type=text],input[type=password]{width:100%}fieldset{margin:1em 0}</style>${body}`;

export class SettingsPage {
  private server: Server | null = null;
  private closed: Promise<void> = Promise.resolve();
  private opening: Promise<unknown> = Promise.resolve();
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly inSyncFolder: boolean;

  constructor(
    private readonly deps: { secrets: SecretStore; settings: Settings },
    opts: {
      openUrl?: (url: string) => Promise<void>;
      timeoutMs?: number;
      /** The secrets file is in a sync folder, so reset and re-encrypt reach other computers. */
      inSyncFolder?: boolean;
    } = {},
  ) {
    this.inSyncFolder = opts.inSyncFolder ?? false;
    this.openUrl = opts.openUrl ?? openInBrowser;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  isOpen(): boolean {
    return this.server !== null;
  }

  waitForClose(): Promise<void> {
    return this.closed;
  }

  // Calls run one after another, so two overlapping calls cannot leave a server nobody tracks.
  open(): Promise<{ url: string; expires_at: string; opened: boolean }> {
    const run = this.opening.then(() => this.start());
    this.opening = run.catch(() => undefined);
    return run;
  }

  private async start(): Promise<{ url: string; expires_at: string; opened: boolean }> {
    this.close();
    // Every request must carry this key, so other programs on the computer cannot use the page.
    const key = randomBytes(24).toString("hex");
    let done!: () => void;
    this.closed = new Promise<void>((r) => (done = r));
    const server = createServer((req, res) => {
      this.handle(req, res, key, server).catch((err) => {
        // Only the message is logged: never form data.
        if (!(err instanceof UserError)) console.error(err instanceof Error ? err.message : err);
        const text = err instanceof UserError ? esc(err.message) : "Something went wrong.";
        if (!res.headersSent) res.writeHead(500).end(page(`<p>${text}</p>`));
      });
    });
    server.on("close", done);
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const timer = setTimeout(() => this.stop(server), this.timeoutMs);
    timer.unref();
    server.on("close", () => clearTimeout(timer));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?key=${key}`;
    // When the browser cannot be opened, the caller hands the URL to the user.
    const opened = await this.openUrl(url).then(
      () => true,
      () => false,
    );
    return { url, expires_at: new Date(Date.now() + this.timeoutMs).toISOString(), opened };
  }

  private close(): void {
    if (this.server) this.stop(this.server);
  }

  private stop(server: Server): void {
    if (this.server === server) this.server = null;
    server.close();
    server.closeAllConnections();
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    server: Server,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const html = (status: number, body: string) =>
      res
        .writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        })
        .end(page(body));
    const denied = () => html(403, "<p>Use the link from Claude.</p>");
    if (req.method === "GET" && url.pathname === "/") {
      if (!sameKey(url.searchParams.get("key"), key)) return void denied();
      return void html(200, await this.form(key));
    }
    if (req.method !== "POST") return void res.writeHead(404).end();
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch (err) {
      if (!(err instanceof BodyTooLarge)) throw err;
      return void res.writeHead(413, { connection: "close" }).end();
    }
    if (!sameKey(form.get("key"), key)) return void denied();
    try {
      if (url.pathname === "/save") {
        await this.deps.secrets.update((d) => {
          for (const s of ["inara", "edsm"] as const) {
            if (form.get(`clear_${s}`) === "on") {
              delete d[s];
              continue;
            }
            const next = entry(form, s, d[s]);
            if (next) d[s] = next;
          }
        });
      } else if (url.pathname === "/reencrypt") {
        await this.deps.secrets.reencrypt(form.get("old_password") ?? "");
      } else if (url.pathname === "/reset") {
        await this.deps.secrets.reset();
      } else {
        return void res.writeHead(404).end();
      }
    } catch (err) {
      // The page stays open so the user can try again.
      if (!(err instanceof UserError)) throw err;
      const text =
        err instanceof WrongPasswordError && url.pathname === "/reencrypt"
          ? "The old password is wrong."
          : err.message;
      return void html(400, `<p>${esc(text)}</p><p>Go back and try again.</p>`);
    }
    // Stop once the reply is sent, so the browser gets the whole page.
    res.once("finish", () => this.stop(server));
    html(200, "<p>Saved. You can close this tab and go back to Claude.</p>");
  }

  private async form(key: string): Promise<string> {
    const k = `<input type="hidden" name="key" value="${key}">`;
    const shared = this.inSyncFolder
      ? "<p><strong>This changes the secrets for every computer that shares the sync folder.</strong></p>"
      : "";
    let stored: { inara?: ServiceKey; edsm?: ServiceKey };
    try {
      stored = await this.deps.secrets.get();
    } catch (err) {
      if (!(err instanceof SecretsError)) throw err;
      return (
        `<h1>ed-mcp settings</h1><p>${esc(err.message)}</p>` +
        `<form method="post" action="/reencrypt">${k}<fieldset><legend>Re-encrypt with the current password</legend>${shared}` +
        `<label>Old password <input type="password" name="old_password" autocomplete="off"></label>` +
        `<button>Re-encrypt</button></fieldset></form>` +
        `<form method="post" action="/reset">${k}<fieldset><legend>Start fresh</legend>${shared}` +
        `<p>Removes the saved keys and the Frontier login. Plans and preferences are not affected.</p>` +
        `<button>Start fresh</button></fieldset></form>`
      );
    }
    const sources = await this.deps.settings.sources();
    const help = {
      inara:
        `Get your key: log in at <a href="https://inara.cz/elite/inara-api/" target="_blank" rel="noopener noreferrer">inara.cz</a>, ` +
        `click the cog next to "Personal content", open API settings and choose "Generate new key". ` +
        `The commander name is your in-game name.`,
      edsm:
        `Get your key: log in at <a href="https://www.edsm.net/" target="_blank" rel="noopener noreferrer">edsm.net</a>, ` +
        `open the user menu and choose "My API Key". ` +
        `Use your EDSM commander name, which may differ from your in-game name.`,
    };
    const section = (s: "inara" | "edsm", title: string, info: SourceInfo) =>
      `<fieldset><legend>${title}</legend><p><small>${help[s]}</small></p>` +
      `<p>In use: ${info.source === "environment" ? "from the environment (it wins on this computer)" : info.source}. Saved key: ${mask(stored[s]?.apiKey)}</p>` +
      `<label>${title} API key <input type="password" name="${s}_key" autocomplete="off" placeholder="leave empty to keep"></label>` +
      `<label>Commander name <input type="text" name="${s}_cmdr" value="${esc(stored[s]?.cmdr ?? "")}"></label>` +
      `<label><input type="checkbox" name="clear_${s}"> Forget the saved ${title} key</label></fieldset>`;
    return (
      `<h1>ed-mcp settings</h1><form method="post" action="/save">${k}${shared}` +
      section("inara", "Inara", sources.inara) +
      section("edsm", "EDSM", sources.edsm) +
      `<button>Save</button></form>`
    );
  }
}

function sameKey(given: string | null, key: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// An empty key field keeps the saved key, so the commander name can change on its own.
function entry(form: URLSearchParams, s: string, current?: ServiceKey): ServiceKey | undefined {
  const apiKey = form.get(`${s}_key`)?.trim() || current?.apiKey;
  const cmdr = form.get(`${s}_cmdr`)?.trim() || current?.cmdr;
  if (!!apiKey !== !!cmdr) {
    const name = s === "inara" ? "Inara" : "EDSM";
    throw new UserError(`Give both the API key and the commander name for ${name}.`);
  }
  return apiKey && cmdr ? { apiKey, cmdr } : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new BodyTooLarge());
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
