import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { lockedWrite } from "../fs/lock.js";
import { UserError } from "../errors.js";
import type { HttpClient } from "../http/client.js";

const RELEASE_URL = "https://api.github.com/repos/pilotso11/ed-mcp/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
// A failed check is not retried on every notice() call while the machine is offline.
const RETRY_MS = 60 * 60 * 1000;

const releaseSchema = z.object({ tag_name: z.string().min(1), html_url: z.string().min(1) });
const cacheSchema = z.object({
  checked_at: z.number(),
  latest: z.string(),
  url: z.string(),
});
type Cached = z.infer<typeof cacheSchema>;

// Only plain major.minor.patch counts. A pre-release tag (1.2.3-beta.1) does not parse, so it is
// never offered as an update.
function parse(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export class VersionCheck {
  private readonly file: string;
  private readonly now: () => number;
  private running: Promise<void> = Promise.resolve();
  private inFlight = false;
  private lastAttempt = -Infinity;

  constructor(
    private readonly opts: {
      http: HttpClient;
      cacheDir: string;
      current: string;
      now?: () => number;
    },
  ) {
    this.file = path.join(opts.cacheDir, "version-check.json");
    this.now = opts.now ?? Date.now;
  }

  /** Starts a check in the background. It never throws and nothing waits for it. */
  start(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastAttempt = this.now();
    this.running = this.check()
      .catch((err: unknown) => {
        // Network, format and lock problems are expected and stay silent. HttpError is a UserError.
        if (err instanceof UserError || err instanceof z.ZodError || err instanceof SyntaxError) {
          return;
        }
        console.error(`ed-mcp version check failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  /** Resolves when the check started by start() is done. */
  whenIdle(): Promise<void> {
    return this.running;
  }

  /**
   * Answers from the saved result only, so it never waits on a request. When that result is
   * missing or over a day old it starts a background check, for servers that run for days.
   */
  async notice(): Promise<string | null> {
    try {
      const cached = await this.read();
      if (this.isStale(cached) && this.now() - this.lastAttempt >= RETRY_MS) this.start();
      if (!cached || !isNewer(cached.latest, this.opts.current)) return null;
      return `ed-mcp ${cached.latest} is available (you have ${this.opts.current}): ${cached.url}`;
    } catch {
      return null;
    }
  }

  private async read(): Promise<Cached | null> {
    try {
      return cacheSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return null;
    }
  }

  // A clock set back would keep a stale entry fresh for too long, so a future time counts as old.
  private isStale(cached: Cached | null): boolean {
    if (!cached) return true;
    const age = this.now() - cached.checked_at;
    return age < 0 || age >= DAY_MS;
  }

  private async check(): Promise<void> {
    if (!this.isStale(await this.read())) return;
    const release = releaseSchema.parse(await this.opts.http.json<unknown>(RELEASE_URL));
    const entry: Cached = {
      checked_at: this.now(),
      latest: release.tag_name.replace(/^v/, ""),
      url: release.html_url,
    };
    await lockedWrite(
      this.file,
      { timeoutMs: 2_000, lockedMessage: "version-check.json is locked" },
      async () => ({ content: JSON.stringify(entry), result: undefined }),
    );
  }
}
