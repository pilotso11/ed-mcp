import { describe, expect, it } from "vitest";
import { HttpClient, HttpError } from "../../src/http/client.js";
import { fakeFetch, jsonResponse, unreadResponse } from "../helpers/fakeFetch.js";

const UA = "ed-mcp/0.1.0 (+https://github.com/pilotso11/ed-mcp)";
const any = () => true;

describe("HttpClient", () => {
  it("sends the User-Agent and parses JSON", async () => {
    const f = fakeFetch([{ match: any, respond: () => jsonResponse({ a: 1 }) }]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f });
    expect(await http.json("https://x.test/a")).toEqual({ a: 1 });
    expect(new Headers(f.calls[0]?.init?.headers).get("user-agent")).toBe(UA);
  });

  it("retries once on 5xx", async () => {
    let n = 0;
    const f = fakeFetch([
      {
        match: any,
        respond: () => (n++ === 0 ? new Response("", { status: 502 }) : jsonResponse(1)),
      },
    ]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f, retryDelayMs: 0 });
    expect(await http.json("https://x.test/a")).toBe(1);
    expect(f.calls).toHaveLength(2);
  });

  it("cancels the body of a discarded 5xx response before retrying", async () => {
    let n = 0;
    let cancelled = false;
    const f = fakeFetch([
      {
        match: any,
        respond: () =>
          n++ === 0
            ? new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
                { status: 502 },
              )
            : jsonResponse(1),
      },
    ]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f, retryDelayMs: 0 });
    expect(await http.json("https://x.test/a")).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("cancels the body of a failed response that json() discards", async () => {
    const { res, cancelled } = unreadResponse(404);
    const f = fakeFetch([{ match: any, respond: () => res }]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f });
    await expect(http.json("https://x.test/a")).rejects.toThrow(/HTTP 404/);
    expect(cancelled()).toBe(true);
  });

  it("retries once on a network error, then gives up", async () => {
    const f = fakeFetch([
      {
        match: any,
        respond: () => {
          throw new TypeError("fetch failed");
        },
      },
    ]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f, retryDelayMs: 0 });
    await expect(http.json("https://x.test/a")).rejects.toThrow(/x\.test: fetch failed/);
    expect(f.calls).toHaveLength(2);
  });

  it("does not retry when the caller opts out", async () => {
    const f = fakeFetch([{ match: any, respond: () => new Response("", { status: 503 }) }]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f, retryDelayMs: 0 });
    const err = await http.json("https://x.test/a", {}, { retry: false }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(503);
    expect(f.calls).toHaveLength(1);

    const down = fakeFetch([
      { match: any, respond: () => Promise.reject(new Error("ECONNRESET")) },
    ]);
    const http2 = new HttpClient({ userAgent: UA, fetchFn: down, retryDelayMs: 0 });
    await expect(http2.request("https://x.test/a", {}, { retry: false })).rejects.toThrow(
      "x.test: ECONNRESET",
    );
    expect(down.calls).toHaveLength(1);
  });

  it("does not retry 4xx and reports the status", async () => {
    const f = fakeFetch([{ match: any, respond: () => new Response("", { status: 404 }) }]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f, retryDelayMs: 0 });
    const err = await http.json("https://x.test/a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).toBe("x.test returned HTTP 404");
    expect(f.calls).toHaveLength(1);
  });

  it("times out", async () => {
    const f = fakeFetch([
      {
        match: any,
        respond: (_u, init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      },
    ]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f, timeoutMs: 20, retryDelayMs: 0 });
    await expect(http.json("https://x.test/a")).rejects.toThrow(/x\.test: timed out after 20 ms/);
  });

  it("reports invalid JSON", async () => {
    const f = fakeFetch([{ match: any, respond: () => new Response("<html>") }]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f });
    await expect(http.json("https://x.test/a")).rejects.toThrow("x.test returned invalid JSON");
  });

  it("returns non-2xx responses from request() for the caller to handle", async () => {
    const f = fakeFetch([{ match: any, respond: () => new Response(null, { status: 304 }) }]);
    const http = new HttpClient({ userAgent: UA, fetchFn: f });
    expect((await http.request("https://x.test/a")).status).toBe(304);
  });
});
