// Body and station ids can exceed 2^53, which JSON.parse rounds silently.
const BIG_ID = /("(?:id64|system_id64|id)"\s*:\s*)(\d{16,})/g;

export function parseSpanshJson(text: string): unknown {
  return JSON.parse(text.replace(BIG_ID, '$1"$2"'));
}
