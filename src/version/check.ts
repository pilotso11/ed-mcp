import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { lockedWrite } from "../fs/lock.js";
import { HttpError, type HttpClient } from "../http/client.js";

const RELEASE_URL = "https://api.github.com/repos/pilotso11/ed-mcp/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;

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
    this.running = this.check().catch((err: unknown) => {
      // Network and format problems are expected and stay silent.
      if (err instanceof HttpError || err instanceof z.ZodError || err instanceof SyntaxError) {
        return;
      }
      console.error(`ed-mcp version check failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** Resolves when the check started by start() is done. */
  whenIdle(): Promise<void> {
    return this.running;
  }

  /** Reads the saved result only. It never makes a request. */
  async notice(): Promise<string | null> {
    try {
      const cached = await this.read();
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

  private async check(): Promise<void> {
    const cached = await this.read();
    // A clock set back would keep a stale entry fresh for too long, so a future time counts as old.
    const age = cached ? this.now() - cached.checked_at : Infinity;
    if (age >= 0 && age < DAY_MS) return;
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
