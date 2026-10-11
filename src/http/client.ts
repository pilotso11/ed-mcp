import { UserError } from "../errors.js";

export type FetchFn = typeof fetch;

export class HttpError extends UserError {
  override name = "HttpError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HttpClientOptions {
  userAgent: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface RequestOptions {
  /** Set false for requests that must not be sent twice, such as token rotation. */
  retry?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
  }

  async request(url: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<Response> {
    if (opts.retry === false) {
      return this.once(url, init).catch((err: unknown) => {
        throw this.wrap(url, err);
      });
    }
    try {
      const res = await this.once(url, init);
      if (res.status < 500) return res;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // fall through to the single retry
    }
    await sleep(this.retryDelayMs);
    return this.once(url, init).catch((err: unknown) => {
      throw this.wrap(url, err);
    });
  }

  async json<T>(url: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<T> {
    const host = new URL(url).host;
    const res = await this.request(url, init, opts);
    if (!res.ok) throw new HttpError(`${host} returned HTTP ${res.status}`, res.status);
    try {
      return (await res.json()) as T;
    } catch {
      throw new HttpError(`${host} returned invalid JSON`, res.status);
    }
  }

  private async once(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("user-agent", this.opts.userAgent);
    const signal = AbortSignal.timeout(this.timeoutMs);
    return this.fetchFn(url, { ...init, headers, signal });
  }

  private wrap(url: string, err: unknown): HttpError {
    const host = new URL(url).host;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return new HttpError(`${host}: timed out after ${this.timeoutMs} ms`);
    }
    return new HttpError(`${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
