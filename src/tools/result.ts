import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UserError } from "../errors.js";

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function wrap<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      console.error(err);
      return fail(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// Warnings go in a second text item so the first stays plain JSON for callers that parse it.
export function wrapWarn<A>(
  fn: (args: A) => Promise<unknown>,
  warnings?: () => Promise<string[]>,
): (args: A) => Promise<CallToolResult> {
  const inner = wrap(fn);
  return async (args: A) => {
    const result = await inner(args);
    const list = warnings ? await warnings().catch(() => [] as string[]) : [];
    if (!list.length) return result;
    return {
      ...result,
      content: [
        ...result.content,
        { type: "text", text: `Warnings:\n${list.map((w) => `- ${w}`).join("\n")}` },
      ],
    };
  };
}
