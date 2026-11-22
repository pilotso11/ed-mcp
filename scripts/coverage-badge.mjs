// Turns vitest's coverage/coverage-summary.json into the file the README's coverage badge reads.
// The release workflow attaches it to each GitHub Release, and shields.io's dynamic JSON badge
// reads `message` from the latest one (its endpoint badge refuses github.com URLs):
//   node scripts/coverage-badge.mjs [summary.json] [out.json]
import { readFileSync, writeFileSync } from "node:fs";

const [from = "coverage/coverage-summary.json", to = "coverage/coverage.json"] =
  process.argv.slice(2);
const lines = JSON.parse(readFileSync(from, "utf8"))?.total?.lines;
const pct = lines?.pct;
// A summary with no lines at all reports 100%, which is no number for the badge.
if (!(lines?.total > 0) || typeof pct !== "number" || !Number.isFinite(pct))
  throw new Error(`no line coverage in ${from}`);
const badge = { message: `${Math.floor(pct)}%` };
writeFileSync(to, JSON.stringify(badge) + "\n");
console.log(`coverage badge: ${badge.message}`);
