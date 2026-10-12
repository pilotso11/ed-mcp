import type { FetchFn } from "../../src/http/client.js";

export interface FakeCall {
  url: string;
  init?: RequestInit;
}
export interface FakeRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export function fakeFetch(routes: FakeRoute[]): FetchFn & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route.respond(url, init);
  };
  return Object.assign(fn as FetchFn, { calls });
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Reads a JSON fixture from test/fixtures. */
export async function fixture<T = unknown>(rel: string): Promise<T> {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(`../fixtures/${rel}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as T;
}

/** A response whose body is never read; `cancelled()` reports whether the body was cancelled. */
export function unreadResponse(status: number): { res: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(body, { status }), cancelled: () => cancelled };
}
