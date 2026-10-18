import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { lockedWrite } from "../fs/lock.js";
import { UserError } from "../errors.js";
import type { HttpClient } from "../http/client.js";

const RELEASE_URL = "https://api.github.com/repos/pilotso11/ed-mcp/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

// The release page link is built from the version, never taken from the response or the cache
// file, because Claude trusts the notice text and a link from outside could carry instructions.
const RELEASE_PAGE = "https://github.com/pilotso11/ed-mcp/releases/tag";
const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

const releaseSchema = z.object({
  tag_name: z
    .string()
    .transform((t) => t.replace(/^v/, ""))
    .pipe(z.string().regex(STRICT_VERSION)),
});
const cacheSchema = z.object({
  checked_at: z.number(),
  latest: z.string().regex(STRICT_VERSION),
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
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

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

  /**
   * Checks in the background, then again every 24 hours (every hour after a failure), so a
   * server that runs for days still learns of a new release. It never throws.
   */
  start(): void {
    // A second start() must not arm a second chain that stop() could not cancel.
    if (this.timer || this.inFlight) return;
    this.stopped = false;
    this.run();
  }

  /** Cancels the next scheduled check. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolves when the check in progress is done. */
  whenIdle(): Promise<void> {
    return this.running;
  }

  /** Reads the saved result only. It never makes a request or writes. */
  async notice(): Promise<string | null> {
    try {
      const cached = await this.read();
      if (!cached || !isNewer(cached.latest, this.opts.current)) return null;
      return `ed-mcp ${cached.latest} is available (you have ${this.opts.current}): ${RELEASE_PAGE}/v${cached.latest}`;
    } catch {
      return null;
    }
  }

  private run(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) return;
    this.inFlight = true;
    this.running = this.check()
      .then(
        () => true,
        (err: unknown) => {
          // Network, format and lock problems are expected and stay silent. HttpError is a UserError.
          if (!(
            err instanceof UserError ||
            err instanceof z.ZodError ||
            err instanceof SyntaxError
          )) {
            console.error(
              `ed-mcp version check failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          return false;
        },
      )
      .then((ok) => {
        this.inFlight = false;
        if (this.stopped) return;
        clearTimeout(this.timer);
        // unref: the timer must not keep the process alive after the client disconnects.
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            this.run();
          },
          ok ? DAY_MS : RETRY_MS,
        );
        this.timer.unref();
      });
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
      latest: release.tag_name,
    };
    await lockedWrite(
      this.file,
      { timeoutMs: 2_000, lockedMessage: "version-check.json is locked" },
      async () => ({ content: JSON.stringify(entry), result: undefined }),
    );
  }
}
