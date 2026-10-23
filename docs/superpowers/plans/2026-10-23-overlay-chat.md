# Chat overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows app that shows a small Claude chat overlay on top of Elite Dangerous, streams short replies into a click-through card, and copies marked system names to the clipboard by hotkey.

**Architecture:** Electron app in a new repository, `ed-overlay`. All logic that can run without Electron lives in `src/core/` and is unit tested with vitest in plain Node. That covers settings, the anchor grid, chips, the stream-json parser, the Claude session, the approval MCP server, the state reducer, the view model, the stores and focus logic. `src/main/` wires the core to Electron and Win32 (through `koffi`). `src/renderer/` is a small React UI driven by one view model pushed over IPC.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), Electron, electron-vite, React, zod 4, `@modelcontextprotocol/sdk`, koffi, vitest, prettier (printWidth 100), electron-builder (NSIS).

Spec: `docs/superpowers/specs/2026-10-23-overlay-chat-design.md` (ed-mcp repository; Task 1 copies it into the new repository).

## Global Constraints

- Target: Windows 10 and 11, x64. Development and `npm run check` must also work on macOS and Linux.
- `src/core/**` must not import `electron` or `koffi`. Only `src/main/**` and `src/preload/**` may import `electron`. Only `src/main/win32.ts` may import `koffi`.
- TypeScript `strict` and `noUncheckedIndexedAccess`. ESM with `.js` extensions in relative imports.
- Run `npx prettier --write <changed files>` and then `npm run check` (typecheck, format check, tests) before every commit.
- Tests use temp directories (`mkdtemp(path.join(os.tmpdir(), "ed-overlay-"))`) and no network except `127.0.0.1`.
- Chat text is never written to the log.
- The GitHub repository stays **private** until Anthropic confirms that a published app may start the player's logged-in `claude` CLI.
- Exact user-facing texts (each notice includes its icon):
  - `⚠ ed-mcp not connected. Run: claude mcp add ed-mcp -s user -- npx -y ed-mcp`
  - `⚠ ed-mcp failed to start; run claude mcp list`
  - `⚠ Elite is in fullscreen; switch to Borderless to see the overlay`
  - `⚠ claude not found: install Claude Code or set claude.path`
  - `⚠ Claude stopped` (with `: <last stderr line>` when there is one)
  - `⚠ Claude keeps stopping` (with `: <last stderr line>` when there is one)
  - `⚠ click the game to refocus`
  - `⛔ in danger: chat blocked`
  - `⚠ ship is moving`
  - `⚠ auto mode unavailable, using manual approvals`
  - `⚠ settings.json: <problem>`
  - `⚠ hotkeys not registered: <names>`
  - Approval answers: `Player denied`, `Player did not answer`
- Comments explain why, not what. Few comments.
- Commit messages: short, plain, active voice, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Testing on the Windows PC

Development happens on a Mac; the game runs on a Windows PC.

- Tasks 1–12 run on the Mac. Task 11's smoke test uses `"scope": "always"`, because the game-only hotkey scope needs Win32.
- On the Mac, set `"journalDir"` to the Syncthing copy of the journal (`/Users/<you>/EliteDangerous`). Then the docked and in-danger flags follow the game on the PC.
- Win32 focus, topmost, koffi and the fullscreen check run only on the PC (Task 13).
- Task 13 needs the private GitHub repository. Ask the owner to create it before Task 12's CI step. On the PC, iterate with `git pull && npm ci && npm run dev`. Use the CI installer artifact for the release checklist.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/core/settings.ts` | zod schema, defaults, `parseSettings`, `defaultSettingsText` |
| `src/core/anchor.ts` | Anchor grid steps, window placement, display choice |
| `src/core/chips.ts` | `⟦name⟧` parsing, first line |
| `src/core/prompt.ts` | The appended system prompt |
| `src/core/status.ts` | `Status.json` flags, `DisplaySettings.xml` mode, `StatusWatcher` |
| `src/core/streamJson.ts` | stream-json lines → `SessionEvent` |
| `src/core/crashTracker.ts` | Restart back-off |
| `src/core/claudeCommand.ts` | Find `claude`, quote for cmd, build args, version compare, ed-mcp check |
| `src/core/claudeSession.ts` | Owns the CLI process |
| `src/core/approvalServer.ts` | MCP server with the `approve` tool |
| `src/core/controller.ts` | `OverlayState`, `reduce`, `windowProps`, `canOpenChat` |
| `src/core/view.ts` | `ViewModel` for the renderer |
| `src/core/hotkeys.ts` | Settings → bindings, `HotkeyManager` |
| `src/core/stores.ts` | `SettingsStore`, `StateStore`, position precedence, `HistoryStore` |
| `src/core/logger.ts` | Rotating log file |
| `src/core/focus.ts` | `Win32` interface, `FocusManager` |
| `src/shared/ipc.ts` | IPC channel names and the preload API type |
| `src/main/win32.ts` | koffi implementation of `Win32` |
| `src/main/window.ts` | Create the overlay window, apply `WindowProps` |
| `src/main/index.ts` | Wiring |
| `src/preload/index.ts` | `contextBridge` API |
| `src/renderer/*` | React UI |
| `test/fake-claude.mjs` | Fake CLI that replays fixtures |
| `test/fixtures/stream/*` | Hand-written and recorded stream-json |
| `scripts/probe-approval.ts` | Manual probe: real CLI against `ApprovalServer` |

---

### Task 1: Repository scaffold and settings

**Files:**
- Create: `~/projects/personal/ed-overlay/` (new git repository), `package.json`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc`, `.prettierignore`, `.gitignore`, `LICENSE`, `.github/workflows/ci.yml`, `src/core/settings.ts`, `docs/superpowers/specs/2026-10-23-overlay-chat-design.md`, `docs/superpowers/specs/2026-10-23-overlay-roadmap-design.md`, `docs/superpowers/plans/2026-10-23-overlay-chat.md`
- Test: `test/settings.test.ts`

**Interfaces:**
- Produces:
  - `ANCHORS` (readonly tuple), `type Anchor`
  - `PositionSchema`, `type Position = { anchor: Anchor; offsetX: number; offsetY: number; display: "primary" | number }`
  - `SettingsSchema`, `type Settings`, `DEFAULT_SETTINGS: Settings`
  - `type ParseResult = { ok: true; settings: Settings } | { ok: false; error: string }`
  - `parseSettings(text: string): ParseResult`
  - `defaultSettingsText(): string`

- [ ] **Step 1: Create the repository**

```bash
mkdir -p ~/projects/personal/ed-overlay && cd ~/projects/personal/ed-overlay
git init -b main
mkdir -p docs/superpowers/specs docs/superpowers/plans src/core test
cp ~/projects/personal/inara-mcp/docs/superpowers/specs/2026-10-23-overlay-*.md docs/superpowers/specs/
cp ~/projects/personal/inara-mcp/docs/superpowers/plans/2026-10-23-overlay-chat.md docs/superpowers/plans/
cp ~/projects/personal/inara-mcp/LICENSE .
```

Do not create the GitHub repository in this task. The owner creates it (private) when they are ready.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "ed-overlay",
  "version": "0.0.0",
  "private": true,
  "description": "Claude chat overlay for Elite Dangerous on Windows",
  "license": "MIT",
  "author": "Seth Osher",
  "type": "module",
  "main": "out/main/index.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "check": "npm run typecheck && npm run format:check && npm test",
    "dist": "npm run build && electron-builder --win --publish never"
  }
}
```

Then install:

```bash
npm install zod @modelcontextprotocol/sdk koffi react react-dom
npm install -D typescript vitest prettier tsx @types/node @types/react @types/react-dom electron electron-vite vite @vitejs/plugin-react electron-builder
```

- [ ] **Step 3: Write the config files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts", "*.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 10_000 },
});
```

`.prettierrc`: `{ "printWidth": 100 }`

`.prettierignore`:

```
out
dist
coverage
node_modules
test/fixtures
*.md
package-lock.json
```

`.gitignore`:

```
node_modules
out
dist
coverage
```

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run check
```

- [ ] **Step 4: Write the failing test**

`test/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultSettingsText, parseSettings } from "../src/core/settings.js";

describe("parseSettings", () => {
  it("fills every default from an empty object", () => {
    const r = parseSettings("{}");
    expect(r).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS.hotkeys.openChat).toBe("Ctrl+Shift+Space");
    expect(DEFAULT_SETTINGS.hotkeys.scope).toBe("game");
    expect(DEFAULT_SETTINGS.strip).toEqual({ lines: 2, keepChips: true });
    expect(DEFAULT_SETTINGS.card).toEqual({ maxLines: 4, fadeSeconds: 20, width: 420 });
    expect(DEFAULT_SETTINGS.position).toEqual({
      anchor: "top-right",
      offsetX: 24,
      offsetY: 24,
      display: "primary",
    });
    expect(DEFAULT_SETTINGS.claude).toEqual({ path: null, permissionMode: "auto", extraArgs: [] });
  });

  it("keeps defaults next to a partial override", () => {
    const r = parseSettings('{"card":{"maxLines":6}}');
    expect(r.ok && r.settings.card).toEqual({ maxLines: 6, fadeSeconds: 20, width: 420 });
  });

  it("reports invalid JSON", () => {
    const r = parseSettings("{");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^not valid JSON/);
  });

  it("reports an unknown key", () => {
    const r = parseSettings('{"foo":1}');
    expect(!r.ok && r.error).toContain("foo");
  });

  it("reports a value out of range with its path", () => {
    const r = parseSettings('{"card":{"maxLines":9}}');
    expect(!r.ok && r.error).toMatch(/^card\.maxLines: /);
  });

  it("requires {n} in copyChip", () => {
    const r = parseSettings('{"hotkeys":{"copyChip":"Ctrl+Shift+1"}}');
    expect(!r.ok && r.error).toMatch(/^hotkeys\.copyChip: /);
  });

  it("writes defaults that parse back to the defaults", () => {
    expect(parseSettings(defaultSettingsText())).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });
});
```

- [ ] **Step 5: Run the test and check that it fails**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL, cannot resolve `../src/core/settings.js`.

- [ ] **Step 6: Write `src/core/settings.ts`**

```ts
import { z } from "zod";

export const ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type Anchor = (typeof ANCHORS)[number];

const key = z.string().min(1);

// zod 4: .default() skips inner defaults, .prefault() parses them.
const HotkeysSchema = z.strictObject({
  scope: z.enum(["game", "always"]).default("game"),
  openChat: key.default("Ctrl+Shift+Space"),
  toggleOverlay: key.default("Ctrl+Shift+O"),
  showHistory: key.default("Ctrl+Shift+H"),
  approve: key.default("Ctrl+Shift+Y"),
  deny: key.default("Ctrl+Shift+N"),
  cancel: key.default("Ctrl+Shift+X"),
  copyChip: key.refine((s) => s.includes("{n}"), "must contain {n}").default("Ctrl+Shift+{n}"),
  moveUp: key.default("Ctrl+Alt+Up"),
  moveDown: key.default("Ctrl+Alt+Down"),
  moveLeft: key.default("Ctrl+Alt+Left"),
  moveRight: key.default("Ctrl+Alt+Right"),
  nextDisplay: key.default("Ctrl+Alt+M"),
});

export const PositionSchema = z.strictObject({
  anchor: z.enum(ANCHORS).default("top-right"),
  offsetX: z.number().int().min(0).default(24),
  offsetY: z.number().int().min(0).default(24),
  display: z.union([z.literal("primary"), z.number().int().min(0)]).default("primary"),
});
export type Position = z.infer<typeof PositionSchema>;

export const SettingsSchema = z.strictObject({
  hotkeys: HotkeysSchema.prefault({}),
  strip: z
    .strictObject({
      lines: z.union([z.literal(1), z.literal(2)]).default(2),
      keepChips: z.boolean().default(true),
    })
    .prefault({}),
  card: z
    .strictObject({
      maxLines: z.number().int().min(2).max(8).default(4),
      fadeSeconds: z.number().min(0).default(20),
      width: z.number().int().min(200).max(1200).default(420),
    })
    .prefault({}),
  chat: z.strictObject({ lines: z.number().int().min(4).max(40).default(14) }).prefault({}),
  style: z.strictObject({ fontSize: z.number().min(8).max(48).default(14) }).prefault({}),
  position: PositionSchema.prefault({}),
  safety: z.strictObject({ blockWhenInDanger: z.boolean().default(true) }).prefault({}),
  approval: z
    .strictObject({ timeoutSeconds: z.number().int().min(5).max(3600).default(120) })
    .prefault({}),
  claude: z
    .strictObject({
      path: z.string().min(1).nullable().default(null),
      permissionMode: z.enum(["auto", "default"]).default("auto"),
      extraArgs: z.array(z.string()).default([]),
    })
    .prefault({}),
  journalDir: z.string().min(1).nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export type ParseResult = { ok: true; settings: Settings } | { ok: false; error: string };

export function parseSettings(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
  const r = SettingsSchema.safeParse(raw);
  if (r.success) return { ok: true, settings: r.data };
  const issue = r.error.issues[0]!;
  const where = issue.path.length ? issue.path.join(".") : "(top level)";
  return { ok: false, error: `${where}: ${issue.message}` };
}

export function defaultSettingsText(): string {
  return JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n";
}
```

- [ ] **Step 7: Run the checks and check that they pass**

Run: `npx prettier --write . && npm run check`
Expected: typecheck clean, format clean, 7 tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Scaffold ed-overlay and add the settings schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Record stream-json fixtures (phase 0, part A)

This task checks spike items 1 and 2 (default mode only) from the spec against the real CLI. It needs a logged-in `claude` CLI on the machine. It can run on macOS.

**Files:**
- Create: `test/fixtures/stream/VERSION`, `test/fixtures/stream/recorded-text.jsonl`, `test/fixtures/stream/recorded-tool.jsonl`, `test/fixtures/stream/recorded-denied.jsonl`, `test/fixtures/stream/handwritten.jsonl`
- Modify: `docs/superpowers/specs/2026-10-23-overlay-chat-design.md` (add a "Phase 0 results" section)

**Interfaces:**
- Produces: fixture files that Tasks 4 and 5 read. `handwritten.jsonl` has session ID `sess-1` and these events in order: `init`, text delta, `tool_use` `toolu_1` (`mcp__ed-mcp__journal_status`), its `tool_result`, text delta with `⟦Jameson Memorial⟧`, `result` with one denial (`Bash`).

- [ ] **Step 1: Record the CLI version**

```bash
cd ~/projects/personal/ed-overlay && mkdir -p test/fixtures/stream
claude --version > test/fixtures/stream/VERSION && cat test/fixtures/stream/VERSION
```

- [ ] **Step 2: Record a text-only turn**

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What is 2+2? Reply in one line."}]}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  > test/fixtures/stream/recorded-text.jsonl
```

- [ ] **Step 3: Record a turn with an allowed tool**

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Run the Bash command `echo hi`, then reply with its output in one line."}]}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
      --allowedTools "Bash(echo:*)" \
  > test/fixtures/stream/recorded-tool.jsonl
```

- [ ] **Step 4: Record a turn with a denied tool**

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Run the Bash command `ls /`, then reply in one line."}]}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
      --permission-mode default \
  > test/fixtures/stream/recorded-denied.jsonl
```

- [ ] **Step 5: Check the recordings against the expected shapes**

```bash
for f in test/fixtures/stream/recorded-*.jsonl; do
  echo "== $f"; node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const seen = new Set(lines.map(l => l.type + (l.subtype ? "/" + l.subtype : "") + (l.event ? ":" + l.event.type : "")));
    console.log([...seen].join("\n"));
    const r = lines.at(-1); console.log("last:", r.type, "is_error", r.is_error, "denials", JSON.stringify(r.permission_denials));
    const init = lines.find(l => l.type === "system" && l.subtype === "init");
    console.log("init keys:", Object.keys(init ?? {}).join(","));
  ' "$f"
done
```

Expected:
- Every file starts with `system/init`, which has `session_id`, `tools`, `mcp_servers` and `permissionMode`.
- Every file ends with a `result` line that has `is_error`, `duration_ms`, `result` and `session_id`.
- Text arrives in `stream_event` lines with `event.type` `content_block_delta` and `delta.type` `text_delta`.
- `recorded-tool.jsonl` has an `assistant` line with a `tool_use` block (`id`, `name`) and a `user` line with a `tool_result` block (`tool_use_id`, `is_error`).
- `recorded-denied.jsonl` has a `permission_denials` entry with `tool_name` `Bash`.

When a field has a different name or place, write the real one in the spec (Step 7). Then change the parser code in Task 4 to match **before** writing it, and change `handwritten.jsonl` (Step 6) to the real shape.

- [ ] **Step 6: Write the hand-written fixture**

`test/fixtures/stream/handwritten.jsonl` (one JSON object per line, with no blank lines):

```
{"type":"system","subtype":"init","session_id":"sess-1","tools":["Bash","mcp__ed-mcp__journal_status","mcp__ed_overlay__approve"],"mcp_servers":[{"name":"ed-mcp","status":"connected"},{"name":"ed_overlay","status":"connected"}],"permissionMode":"auto"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking. "}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"mcp__ed-mcp__journal_status","input":{}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":false,"content":"ok"}]}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Docked at ⟦Jameson Memorial⟧."}}}
{"type":"stream_event","event":{"type":"message_stop"}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"result":"Checking. Docked at ⟦Jameson Memorial⟧.","session_id":"sess-1","permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_2","tool_input":{}}]}
```

- [ ] **Step 7: Record the results in the spec**

Add a section to the end of `docs/superpowers/specs/2026-10-23-overlay-chat-design.md`:

```markdown
## Phase 0 results

- CLI version used for the fixtures: <contents of test/fixtures/stream/VERSION>.
- stream-json shapes: <"as listed in Events" or each difference found in Step 5>.
- Denied tools appear in `result.permission_denials[].tool_name`.
```

Replace each `<…>` with what Steps 1 and 5 showed.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures docs
git commit -m "Record stream-json fixtures from the claude CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Anchor grid, chips and the system prompt

**Files:**
- Create: `src/core/anchor.ts`, `src/core/chips.ts`, `src/core/prompt.ts`
- Test: `test/anchor.test.ts`, `test/chips.test.ts`

**Interfaces:**
- Consumes: `type Anchor` from `src/core/settings.ts`.
- Produces:
  - `type Direction = "up" | "down" | "left" | "right"`
  - `interface Rect { x: number; y: number; width: number; height: number }`
  - `step(anchor: Anchor, dir: Direction): Anchor`
  - `place(anchor: Anchor, offsetX: number, offsetY: number, area: Rect, size: { width: number; height: number }): { x: number; y: number }`
  - `growsUp(anchor: Anchor): boolean`
  - `chooseDisplay<T>(all: T[], primary: T, which: "primary" | number): T`
  - `interface Chip { n: number; text: string }`
  - `parseChips(text: string): { plain: string; chips: Chip[] }`
  - `firstLine(plain: string): string | null`
  - `HUD_PROMPT: string`

- [ ] **Step 1: Write the failing tests**

`test/anchor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chooseDisplay, growsUp, place, step } from "../src/core/anchor.js";

describe("step", () => {
  it.each([
    ["top-right", "left", "top"],
    ["top", "left", "top-left"],
    ["top-right", "down", "right"],
    ["right", "down", "bottom-right"],
    ["top", "down", "bottom"],
    ["left", "right", "right"],
    ["top-left", "up", "top-left"],
    ["top-left", "left", "top-left"],
    ["bottom-right", "right", "bottom-right"],
  ] as const)("%s + %s = %s", (from, dir, to) => {
    expect(step(from, dir)).toBe(to);
  });
});

describe("place", () => {
  const area = { x: 0, y: 40, width: 1920, height: 1040 };
  const size = { width: 420, height: 70 };
  it.each([
    ["top-left", { x: 24, y: 64 }],
    ["top", { x: 750, y: 64 }],
    ["top-right", { x: 1476, y: 64 }],
    ["left", { x: 24, y: 525 }],
    ["right", { x: 1476, y: 525 }],
    ["bottom-left", { x: 24, y: 986 }],
    ["bottom", { x: 750, y: 986 }],
    ["bottom-right", { x: 1476, y: 986 }],
  ] as const)("%s", (anchor, xy) => {
    expect(place(anchor, 24, 24, area, size)).toEqual(xy);
  });

  it("uses the display's origin", () => {
    expect(place("top-left", 10, 10, { x: -1920, y: 0, width: 1920, height: 1080 }, size)).toEqual(
      { x: -1910, y: 10 },
    );
  });
});

describe("growsUp", () => {
  it("is true only for bottom anchors", () => {
    expect(growsUp("bottom-left")).toBe(true);
    expect(growsUp("bottom")).toBe(true);
    expect(growsUp("right")).toBe(false);
    expect(growsUp("top")).toBe(false);
  });
});

describe("chooseDisplay", () => {
  it("picks by index, else the primary", () => {
    expect(chooseDisplay(["a", "b"], "a", 1)).toBe("b");
    expect(chooseDisplay(["a", "b"], "a", 5)).toBe("a");
    expect(chooseDisplay(["a", "b"], "b", "primary")).toBe("b");
  });
});
```

`test/chips.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstLine, parseChips } from "../src/core/chips.js";
import { HUD_PROMPT } from "../src/core/prompt.js";

describe("parseChips", () => {
  it("numbers marked names and removes the markers", () => {
    expect(parseChips("Go to ⟦Hip 3922⟧, dock at ⟦Prospect Station⟧.")).toEqual({
      plain: "Go to Hip 3922, dock at Prospect Station.",
      chips: [
        { n: 1, text: "Hip 3922" },
        { n: 2, text: "Prospect Station" },
      ],
    });
  });

  it("gives a repeated name one chip", () => {
    expect(parseChips("⟦Sol⟧ then ⟦Sol⟧").chips).toEqual([{ n: 1, text: "Sol" }]);
  });

  it("numbers at most 9 chips", () => {
    const text = Array.from({ length: 11 }, (_, i) => `⟦S${i}⟧`).join(" ");
    const r = parseChips(text);
    expect(r.chips).toHaveLength(9);
    expect(r.plain).toContain("S10");
  });

  it("leaves an unclosed marker while a reply streams", () => {
    expect(parseChips("Go to ⟦Hip 39").plain).toBe("Go to ⟦Hip 39");
  });

  it("drops an empty marker", () => {
    expect(parseChips("a ⟦ ⟧ b")).toEqual({ plain: "a  b", chips: [] });
  });
});

describe("firstLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstLine("\n  Hip 3922, 41 ly \nmore")).toBe("Hip 3922, 41 ly");
    expect(firstLine("  \n")).toBeNull();
  });
});

describe("HUD_PROMPT", () => {
  it("is safe to pass through cmd.exe", () => {
    expect(HUD_PROMPT).not.toMatch(/["%^&|<>]/);
    expect(HUD_PROMPT).toContain("⟦");
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/anchor.test.ts test/chips.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/core/anchor.ts`**

```ts
import type { Anchor } from "./settings.js";

export type Direction = "up" | "down" | "left" | "right";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GRID: (Anchor | null)[][] = [
  ["top-left", "top", "top-right"],
  ["left", null, "right"],
  ["bottom-left", "bottom", "bottom-right"],
];

const DELTA: Record<Direction, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

function cell(a: Anchor): [number, number] {
  for (let r = 0; r < 3; r++) {
    const c = GRID[r]!.indexOf(a);
    if (c >= 0) return [r, c];
  }
  throw new Error(`unknown anchor ${a}`);
}

// The center cell is skipped: an overlay there would cover the reticle.
export function step(anchor: Anchor, dir: Direction): Anchor {
  let [r, c] = cell(anchor);
  const [dr, dc] = DELTA[dir];
  for (;;) {
    r += dr;
    c += dc;
    if (r < 0 || r > 2 || c < 0 || c > 2) return anchor;
    const next = GRID[r]![c];
    if (next) return next;
  }
}

export function place(
  anchor: Anchor,
  offsetX: number,
  offsetY: number,
  area: Rect,
  size: { width: number; height: number },
): { x: number; y: number } {
  const [r, c] = cell(anchor);
  const x =
    c === 0
      ? area.x + offsetX
      : c === 2
        ? area.x + area.width - size.width - offsetX
        : area.x + (area.width - size.width) / 2;
  const y =
    r === 0
      ? area.y + offsetY
      : r === 2
        ? area.y + area.height - size.height - offsetY
        : area.y + (area.height - size.height) / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

export function growsUp(anchor: Anchor): boolean {
  return anchor.startsWith("bottom");
}

export function chooseDisplay<T>(all: T[], primary: T, which: "primary" | number): T {
  return which === "primary" ? primary : (all[which] ?? primary);
}
```

- [ ] **Step 4: Write `src/core/chips.ts`**

```ts
export interface Chip {
  n: number;
  text: string;
}

const MARK = /⟦([^⟦⟧\n]+)⟧/g;
const MAX_CHIPS = 9;

export function parseChips(text: string): { plain: string; chips: Chip[] } {
  const chips: Chip[] = [];
  const plain = text.replace(MARK, (_m, inner: string) => {
    const name = inner.trim();
    if (name && chips.length < MAX_CHIPS && !chips.some((c) => c.text === name)) {
      chips.push({ n: chips.length + 1, text: name });
    }
    return name;
  });
  return { plain, chips };
}

export function firstLine(plain: string): string | null {
  return (
    plain
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? null
  );
}
```

- [ ] **Step 5: Write `src/core/prompt.ts`**

```ts
// No double quotes or cmd.exe metacharacters: the prompt may pass through cmd when claude is a .cmd shim.
export const HUD_PROMPT = [
  "You are answering inside a small overlay on top of Elite Dangerous while the player flies.",
  "Reply in 1 to 3 short lines. Put the answer first. Do not use tables, headings or code blocks.",
  "Put each star system or station name that the player may paste into the galaxy map inside ⟦ and ⟧, for example ⟦Shinrarta Dezhra⟧.",
  "Mark each name once.",
].join(" ");
```

- [ ] **Step 6: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/anchor.ts src/core/chips.ts src/core/prompt.ts test/anchor.test.ts test/chips.test.ts
git commit -m "Add the anchor grid, copy chips and the overlay prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Stream-json parser

**Files:**
- Create: `src/core/streamJson.ts`
- Test: `test/streamJson.test.ts`

**Interfaces:**
- Consumes: fixtures from Task 2.
- Produces:
  - `interface McpServerInfo { name: string; status: string }`
  - `type SessionEvent` =
    - `{ type: "ready"; sessionId: string | null; tools: string[]; mcpServers: McpServerInfo[]; permissionMode: string | null }`
    - `{ type: "text"; delta: string }`
    - `{ type: "toolStart"; id: string; name: string }`
    - `{ type: "toolEnd"; id: string; name: string; isError: boolean }`
    - `{ type: "result"; isError: boolean; durationMs: number | null; text: string | null; sessionId: string | null; denials: string[] }`
    - `{ type: "unknown"; raw: unknown }`
  - `class StreamParser { feed(chunk: string): SessionEvent[] }`

- [ ] **Step 1: Write the failing test**

`test/streamJson.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StreamParser, type SessionEvent } from "../src/core/streamJson.js";

const dir = path.join(import.meta.dirname, "fixtures", "stream");
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

describe("StreamParser", () => {
  it("maps the hand-written fixture", () => {
    const events = new StreamParser().feed(read("handwritten.jsonl"));
    expect(events).toEqual<SessionEvent[]>([
      {
        type: "ready",
        sessionId: "sess-1",
        tools: ["Bash", "mcp__ed-mcp__journal_status", "mcp__ed_overlay__approve"],
        mcpServers: [
          { name: "ed-mcp", status: "connected" },
          { name: "ed_overlay", status: "connected" },
        ],
        permissionMode: "auto",
      },
      { type: "text", delta: "Checking. " },
      { type: "toolStart", id: "toolu_1", name: "mcp__ed-mcp__journal_status" },
      { type: "toolEnd", id: "toolu_1", name: "mcp__ed-mcp__journal_status", isError: false },
      { type: "text", delta: "Docked at ⟦Jameson Memorial⟧." },
      {
        type: "result",
        isError: false,
        durationMs: 1200,
        text: "Checking. Docked at ⟦Jameson Memorial⟧.",
        sessionId: "sess-1",
        denials: ["Bash"],
      },
    ]);
  });

  it("joins lines split across chunks", () => {
    const p = new StreamParser();
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\n';
    expect(p.feed(line.slice(0, 20))).toEqual([]);
    expect(p.feed(line.slice(20))).toEqual([{ type: "text", delta: "hi" }]);
  });

  it("reports lines that are not JSON as unknown", () => {
    expect(new StreamParser().feed("oops\n")).toEqual([{ type: "unknown", raw: "oops" }]);
  });

  it("names a tool result whose start it never saw as unknown", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","is_error":true}]}}\n';
    expect(new StreamParser().feed(line)).toEqual([
      { type: "toolEnd", id: "x", name: "unknown", isError: true },
    ]);
  });

  const recorded = readdirSync(dir).filter((f) => f.startsWith("recorded-"));

  it("has recorded fixtures", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(3);
  });

  // Real output starts with hook events before init; those map to unknown.
  const known = (name: string) => new StreamParser().feed(read(name)).filter((e) => e.type !== "unknown");

  it.each(recorded)("maps %s from ready to result", (name) => {
    const events = known(name);
    expect(events[0]?.type).toBe("ready");
    expect(events.at(-1)?.type).toBe("result");
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("finds the tool call and the denial in the recordings", () => {
    const tool = known("recorded-tool.jsonl");
    expect(tool.some((e) => e.type === "toolStart" && e.name === "Bash")).toBe(true);
    expect(tool.some((e) => e.type === "toolEnd" && e.name === "Bash")).toBe(true);
    const denied = known("recorded-denied.jsonl").at(-1);
    expect(denied?.type === "result" && denied.denials).toContain("Bash");
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `npx vitest run test/streamJson.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/core/streamJson.ts`**

When Task 2 found different field names, use the real ones here.

```ts
export interface McpServerInfo {
  name: string;
  status: string;
}

export type SessionEvent =
  | {
      type: "ready";
      sessionId: string | null;
      tools: string[];
      mcpServers: McpServerInfo[];
      permissionMode: string | null;
    }
  | { type: "text"; delta: string }
  | { type: "toolStart"; id: string; name: string }
  | { type: "toolEnd"; id: string; name: string; isError: boolean }
  | {
      type: "result";
      isError: boolean;
      durationMs: number | null;
      text: string | null;
      sessionId: string | null;
      denials: string[];
    }
  | { type: "unknown"; raw: unknown };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// The only code that knows the CLI's output format.
export class StreamParser {
  private buf = "";
  private readonly toolNames = new Map<string, string>();

  feed(chunk: string): SessionEvent[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    const out: SessionEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        out.push({ type: "unknown", raw: line.trim() });
        continue;
      }
      out.push(...this.map(j));
    }
    return out;
  }

  private map(j: unknown): SessionEvent[] {
    const m = obj(j);
    if (!m) return [{ type: "unknown", raw: j }];
    switch (m.type) {
      case "system":
        if (m.subtype !== "init") break;
        return [
          {
            type: "ready",
            sessionId: str(m.session_id),
            tools: list(m.tools).filter((t): t is string => typeof t === "string"),
            mcpServers: list(m.mcp_servers).flatMap((s) => {
              const name = str(obj(s)?.name);
              return name ? [{ name, status: str(obj(s)?.status) ?? "unknown" }] : [];
            }),
            permissionMode: str(m.permissionMode),
          },
        ];
      case "stream_event": {
        const e = obj(m.event);
        const d = obj(e?.delta);
        if (e?.type === "content_block_delta" && d?.type === "text_delta") {
          const text = str(d.text);
          if (text) return [{ type: "text", delta: text }];
        }
        // Other stream events (message_start, block stops) carry nothing the overlay shows.
        return [];
      }
      case "assistant":
        return this.blocks(m).flatMap((b) => {
          const id = str(b.id);
          const name = str(b.name);
          if (b.type !== "tool_use" || !id || !name) return [];
          this.toolNames.set(id, name);
          return [{ type: "toolStart" as const, id, name }];
        });
      case "user":
        return this.blocks(m).flatMap((b) => {
          const id = str(b.tool_use_id);
          if (b.type !== "tool_result" || !id) return [];
          const name = this.toolNames.get(id) ?? "unknown";
          this.toolNames.delete(id);
          return [{ type: "toolEnd" as const, id, name, isError: b.is_error === true }];
        });
      case "result":
        return [
          {
            type: "result",
            isError: m.is_error === true,
            durationMs: typeof m.duration_ms === "number" ? m.duration_ms : null,
            text: str(m.result),
            sessionId: str(m.session_id),
            denials: list(m.permission_denials).flatMap((d) => {
              const n = str(obj(d)?.tool_name);
              return n ? [n] : [];
            }),
          },
        ];
    }
    return [{ type: "unknown", raw: m }];
  }

  private blocks(m: Obj): Obj[] {
    return list(obj(m.message)?.content).flatMap((b) => {
      const o = obj(b);
      return o ? [o] : [];
    });
  }
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass, including one per recorded fixture.

- [ ] **Step 5: Commit**

```bash
git add src/core/streamJson.ts test/streamJson.test.ts
git commit -m "Parse the claude CLI's stream-json output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Claude command, crash tracker and session

**Files:**
- Create: `src/core/crashTracker.ts`, `src/core/claudeCommand.ts`, `src/core/claudeSession.ts`, `test/fake-claude.mjs`
- Test: `test/claudeCommand.test.ts`, `test/claudeSession.test.ts`

**Interfaces:**
- Consumes: `StreamParser`, `SessionEvent` (Task 4); `HUD_PROMPT` (Task 3).
- Produces:
  - `class CrashTracker { constructor(o: { max: number; windowMs: number; now: () => number }); record(): boolean; reset(): void; readonly gaveUp: boolean }`
  - `interface ResolvedCommand { command: string; shell: boolean }`
  - `resolveClaude(configured: string | null, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, exists?: (p: string) => boolean): ResolvedCommand | null`
  - `quoteForCmd(arg: string): string`
  - `buildClaudeArgs(o: { permissionMode: "auto" | "default"; mcpConfigFile: string; extraArgs: string[] }): string[]`
  - `APPROVAL_TOOL = "mcp__ed_overlay__approve"`
  - `TESTED_CLI_VERSION: string`, `parseCliVersion(out: string): [number, number, number] | null`, `isOlder(a: [number, number, number], b: [number, number, number]): boolean`
  - `type EdMcpState = "ok" | "missing" | "failed"`, `edMcpState(servers: McpServerInfo[]): EdMcpState`
  - `type BackendEvent = SessionEvent | { type: "exit"; code: number | null; stderrTail: string[] } | { type: "gaveUp"; stderrTail: string[] } | { type: "spawnError"; message: string }`
  - `interface ClaudeBackend { start(): void; send(text: string): boolean; cancel(): void; newSession(): void; stop(): void; configure(c: { command: string; args: string[]; shell: boolean }): void; onEvent(l: (e: BackendEvent) => void): () => void; readonly busy: boolean; readonly sessionId: string | null }`
  - `class ClaudeSession implements ClaudeBackend { constructor(o: { command: string; args: string[]; shell?: boolean; cwd: string; env?: NodeJS.ProcessEnv; now?: () => number }) }`

- [ ] **Step 1: Write the fake CLI**

`test/fake-claude.mjs`:

```js
// Replays FAKE_FIXTURE: the first line at start, the rest after each stdin message.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = readFileSync(process.env.FAKE_FIXTURE, "utf8").split("\n").filter(Boolean);
if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
}
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "exit-now") {
  process.stderr.write("boom\n");
  process.exit(1);
}
process.stdout.write(lines[0] + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", () => {
  if (mode === "crash") {
    process.stderr.write("boom\n");
    process.exit(1);
  }
  if (mode === "hang") return;
  for (const l of lines.slice(1)) process.stdout.write(l + "\n");
});
rl.on("close", () => process.exit(0));
```

- [ ] **Step 2: Write the failing tests**

`test/claudeCommand.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CrashTracker } from "../src/core/crashTracker.js";
import {
  APPROVAL_TOOL,
  buildClaudeArgs,
  edMcpState,
  isOlder,
  parseCliVersion,
  quoteForCmd,
  resolveClaude,
} from "../src/core/claudeCommand.js";
import { HUD_PROMPT } from "../src/core/prompt.js";

describe("CrashTracker", () => {
  it("gives up after 3 exits in 60 seconds", () => {
    let t = 0;
    const c = new CrashTracker({ max: 3, windowMs: 60_000, now: () => t });
    expect(c.record()).toBe(false);
    t = 30_000;
    expect(c.record()).toBe(false);
    t = 59_000;
    expect(c.record()).toBe(true);
    expect(c.gaveUp).toBe(true);
    c.reset();
    expect(c.gaveUp).toBe(false);
  });

  it("forgets exits older than the window", () => {
    let t = 0;
    const c = new CrashTracker({ max: 3, windowMs: 60_000, now: () => t });
    c.record();
    t = 10_000;
    c.record();
    t = 70_001;
    expect(c.record()).toBe(false);
  });
});

describe("resolveClaude", () => {
  const has = (paths: string[]) => (p: string) => paths.includes(p);
  it("prefers claude.exe over claude.cmd on Windows", () => {
    const env = { PATH: "C:\\a;C:\\b" };
    expect(resolveClaude(null, env, "win32", has(["C:\\a\\claude.cmd", "C:\\b\\claude.exe"]))).toEqual(
      { command: "C:\\b\\claude.exe", shell: false },
    );
    expect(resolveClaude(null, env, "win32", has(["C:\\a\\claude.cmd"]))).toEqual({
      command: "C:\\a\\claude.cmd",
      shell: true,
    });
  });

  it("uses the configured path when it exists", () => {
    expect(resolveClaude("/opt/claude", {}, "linux", has(["/opt/claude"]))).toEqual({
      command: "/opt/claude",
      shell: false,
    });
    expect(resolveClaude("/opt/claude", {}, "linux", has([]))).toBeNull();
  });

  it("returns null when claude is not on PATH", () => {
    expect(resolveClaude(null, { PATH: "/usr/bin" }, "linux", has([]))).toBeNull();
  });
});

describe("quoteForCmd", () => {
  it("wraps in quotes and doubles inner quotes", () => {
    expect(quoteForCmd('a "b" c')).toBe('"a ""b"" c"');
  });
});

describe("buildClaudeArgs", () => {
  it("builds the stream-json command line", () => {
    expect(
      buildClaudeArgs({ permissionMode: "auto", mcpConfigFile: "C:\\x\\a.json", extraArgs: ["--model", "m"] }),
    ).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "auto",
      "--append-system-prompt",
      HUD_PROMPT,
      "--mcp-config",
      "C:\\x\\a.json",
      "--permission-prompt-tool",
      APPROVAL_TOOL,
      "--model",
      "m",
    ]);
  });
});

describe("versions", () => {
  it("parses and compares", () => {
    expect(parseCliVersion("2.1.302 (Claude Code)")).toEqual([2, 1, 302]);
    expect(parseCliVersion("nope")).toBeNull();
    expect(isOlder([2, 1, 9], [2, 1, 10])).toBe(true);
    expect(isOlder([2, 2, 0], [2, 1, 10])).toBe(false);
    expect(isOlder([2, 1, 10], [2, 1, 10])).toBe(false);
  });
});

describe("edMcpState", () => {
  it("finds ed-mcp added with claude mcp add or by the plugin", () => {
    expect(edMcpState([{ name: "ed-mcp", status: "pending" }])).toBe("ok");
    expect(edMcpState([{ name: "plugin:elite-dangerous-mcp:ed-mcp", status: "connected" }])).toBe("ok");
    expect(edMcpState([{ name: "ed-mcp", status: "failed" }])).toBe("failed");
    expect(edMcpState([{ name: "semble", status: "pending" }])).toBe("missing");
  });
});
```

`test/claudeSession.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSession, type BackendEvent } from "../src/core/claudeSession.js";

const fake = path.join(import.meta.dirname, "fake-claude.mjs");
const fixture = path.join(import.meta.dirname, "fixtures", "stream", "handwritten.jsonl");
const sessions: ClaudeSession[] = [];

async function setup(mode = "ok", command = process.execPath) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ed-overlay-"));
  const argsFile = path.join(dir, "args.jsonl");
  const s = new ClaudeSession({
    command,
    args: [fake, "--base"],
    cwd: dir,
    env: { ...process.env, FAKE_FIXTURE: fixture, FAKE_ARGS_FILE: argsFile, FAKE_MODE: mode },
  });
  sessions.push(s);
  const events: BackendEvent[] = [];
  s.onEvent((e) => events.push(e));
  const spawns = async () =>
    (await readFile(argsFile, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  return { s, events, spawns };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
});

describe("ClaudeSession", () => {
  it("starts and reports ready with the session ID", async () => {
    const { s, events } = await setup();
    s.start();
    await until(() => events.some((e) => e.type === "ready"));
    expect(s.sessionId).toBe("sess-1");
  });

  it("streams a reply and is busy until the result", async () => {
    const { s, events } = await setup();
    s.start();
    await until(() => s.sessionId !== null);
    expect(s.send("hi")).toBe(true);
    expect(s.busy).toBe(true);
    expect(s.send("again")).toBe(false);
    await until(() => events.some((e) => e.type === "result"));
    expect(s.busy).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "ready",
      "text",
      "toolStart",
      "toolEnd",
      "text",
      "result",
    ]);
  });

  it("cancel restarts with --resume and reports no exit", async () => {
    const { s, events, spawns } = await setup("hang");
    s.start();
    await until(() => s.sessionId !== null);
    s.send("hi");
    s.cancel();
    expect(s.busy).toBe(false);
    await until(async () => (await spawns()).length === 2);
    expect((await spawns())[1]).toEqual(["--base", "--resume", "sess-1"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === "exit")).toBe(false);
  });

  it("reports exits, restarts on the next send, and gives up after 3", async () => {
    const { s, events, spawns } = await setup("crash");
    s.start();
    await until(() => s.sessionId !== null);
    for (let i = 1; i <= 2; i++) {
      expect(s.send("hi")).toBe(true);
      await until(() => events.filter((e) => e.type === "exit").length === i);
    }
    expect(events.find((e) => e.type === "exit")).toMatchObject({ code: 1, stderrTail: ["boom"] });
    expect((await spawns())[1]).toContain("--resume");
    expect(s.send("hi")).toBe(true);
    await until(() => events.some((e) => e.type === "gaveUp"));
    expect(s.send("hi")).toBe(false);
  });

  it("newSession starts without --resume", async () => {
    const { s, spawns } = await setup();
    s.start();
    await until(() => s.sessionId !== null);
    s.newSession();
    expect(s.sessionId).toBeNull();
    await until(async () => (await spawns()).length === 2);
    expect((await spawns())[1]).toEqual(["--base"]);
  });

  it("reports a missing command", async () => {
    const { s, events } = await setup("ok", path.join(os.tmpdir(), "no-such-claude"));
    s.start();
    await until(() => events.some((e) => e.type === "spawnError"));
    expect(events.find((e) => e.type === "spawnError")).toMatchObject({
      message: expect.stringContaining("ENOENT"),
    });
  });
});
```

- [ ] **Step 3: Run the tests and check that they fail**

Run: `npx vitest run test/claudeCommand.test.ts test/claudeSession.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/core/crashTracker.ts`**

```ts
export class CrashTracker {
  private times: number[] = [];
  private _gaveUp = false;

  constructor(private readonly o: { max: number; windowMs: number; now: () => number }) {}

  get gaveUp(): boolean {
    return this._gaveUp;
  }

  /** Records an exit. Returns true when there have been too many. */
  record(): boolean {
    const t = this.o.now();
    this.times = [...this.times.filter((x) => t - x < this.o.windowMs), t];
    if (this.times.length >= this.o.max) this._gaveUp = true;
    return this._gaveUp;
  }

  reset(): void {
    this.times = [];
    this._gaveUp = false;
  }
}
```

- [ ] **Step 5: Write `src/core/claudeCommand.ts`**

Set `TESTED_CLI_VERSION` to the version number in `test/fixtures/stream/VERSION` from Task 2 (for example, `"2.1.310"` when the file says `2.1.310 (Claude Code)`).

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { HUD_PROMPT } from "./prompt.js";
import type { McpServerInfo } from "./streamJson.js";

export const APPROVAL_SERVER = "ed_overlay";
export const APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;

// The version the stream-json fixtures were recorded with.
export const TESTED_CLI_VERSION = "2.1.310";

export interface ResolvedCommand {
  command: string;
  shell: boolean;
}

const isCmdShim = (p: string) => /\.(cmd|bat)$/i.test(p);

export function resolveClaude(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ResolvedCommand | null {
  if (configured) return exists(configured) ? { command: configured, shell: isCmdShim(configured) } : null;
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  // The native installer gives claude.exe; an npm install gives a claude.cmd shim, which needs a shell.
  const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
  const join = win ? path.win32.join : path.posix.join;
  for (const name of names) {
    for (const d of dirs) {
      const p = join(d, name);
      if (exists(p)) return { command: p, shell: isCmdShim(p) };
    }
  }
  return null;
}

export function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export function buildClaudeArgs(o: {
  permissionMode: "auto" | "default";
  mcpConfigFile: string;
  extraArgs: string[];
}): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    o.permissionMode,
    "--append-system-prompt",
    HUD_PROMPT,
    "--mcp-config",
    o.mcpConfigFile,
    "--permission-prompt-tool",
    APPROVAL_TOOL,
    ...o.extraArgs,
  ];
}

export type Version = [number, number, number];

export function parseCliVersion(out: string): Version | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isOlder(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export type EdMcpState = "ok" | "missing" | "failed";

// Servers are still pending at init and their tools are not listed yet, so read the configured list.
// The Claude plugin names its server plugin:<plugin>:ed-mcp.
export function edMcpState(servers: McpServerInfo[]): EdMcpState {
  const s = servers.find((m) => m.name === "ed-mcp" || /^plugin:[^:]+:ed-mcp$/.test(m.name));
  if (!s) return "missing";
  return s.status === "failed" ? "failed" : "ok";
}
```

- [ ] **Step 6: Write `src/core/claudeSession.ts`**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { quoteForCmd } from "./claudeCommand.js";
import { CrashTracker } from "./crashTracker.js";
import { StreamParser, type SessionEvent } from "./streamJson.js";

export type BackendEvent =
  | SessionEvent
  | { type: "exit"; code: number | null; stderrTail: string[] }
  | { type: "gaveUp"; stderrTail: string[] }
  | { type: "spawnError"; message: string };

export interface ClaudeBackend {
  start(): void;
  send(text: string): boolean;
  cancel(): void;
  newSession(): void;
  stop(): void;
  configure(c: { command: string; args: string[]; shell: boolean }): void;
  onEvent(listener: (e: BackendEvent) => void): () => void;
  readonly busy: boolean;
  readonly sessionId: string | null;
}

export interface ClaudeSessionOptions {
  command: string;
  args: string[];
  shell?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class ClaudeSession implements ClaudeBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly expected = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly listeners = new Set<(e: BackendEvent) => void>();
  private readonly crashes: CrashTracker;
  private stderr: string[] = [];
  private _busy = false;
  private _sessionId: string | null = null;
  private cmd: { command: string; args: string[]; shell: boolean };

  constructor(private readonly opts: ClaudeSessionOptions) {
    this.cmd = { command: opts.command, args: opts.args, shell: opts.shell ?? false };
    this.crashes = new CrashTracker({ max: 3, windowMs: 60_000, now: opts.now ?? Date.now });
  }

  get busy(): boolean {
    return this._busy;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  onEvent(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Takes effect at the next spawn. */
  configure(c: { command: string; args: string[]; shell: boolean }): void {
    this.cmd = c;
  }

  start(): void {
    if (!this.child && !this.crashes.gaveUp) this.spawnChild();
  }

  send(text: string): boolean {
    if (this._busy || this.crashes.gaveUp) return false;
    if (!this.child) this.spawnChild();
    const message = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child!.stdin.write(JSON.stringify(message) + "\n");
    this._busy = true;
    return true;
  }

  cancel(): void {
    this._busy = false;
    if (!this.child) return;
    this.kill();
    this.spawnChild();
  }

  newSession(): void {
    this.kill();
    this._busy = false;
    this._sessionId = null;
    this.crashes.reset();
    this.spawnChild();
  }

  stop(): void {
    this.kill();
    this._busy = false;
  }

  private emit(e: BackendEvent): void {
    for (const l of this.listeners) l(e);
  }

  private kill(): void {
    const c = this.child;
    if (!c) return;
    this.expected.add(c);
    this.child = null;
    // With a .cmd shim, kill() would stop cmd.exe and leave claude running.
    if (process.platform === "win32" && c.pid) {
      spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
    } else {
      c.kill();
    }
  }

  private spawnChild(): void {
    const { command, shell } = this.cmd;
    const args = this._sessionId ? [...this.cmd.args, "--resume", this._sessionId] : this.cmd.args;
    const child = spawn(shell ? quoteForCmd(command) : command, shell ? args.map(quoteForCmd) : args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      shell,
      windowsHide: true,
    });
    this.child = child;
    const parser = new StreamParser();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      for (const e of parser.feed(chunk)) this.handle(e);
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderr = [...this.stderr, ...chunk.split(/\r?\n/).filter(Boolean)].slice(-20);
    });
    // EPIPE after the process has gone; the exit handler reports it.
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      this.expected.add(child);
      if (this.child === child) this.child = null;
      this._busy = false;
      this.emit({ type: "spawnError", message: err.message });
    });
    // close, not exit: exit can fire before the last stderr chunk arrives.
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      if (this.expected.has(child)) return;
      this._busy = false;
      const stderrTail = this.stderr.slice(-5);
      this.stderr = [];
      if (this.crashes.record()) this.emit({ type: "gaveUp", stderrTail });
      else this.emit({ type: "exit", code, stderrTail });
    });
  }

  private handle(e: SessionEvent): void {
    if (e.type === "ready" && e.sessionId) this._sessionId = e.sessionId;
    if (e.type === "result") {
      this._busy = false;
      if (e.sessionId) this._sessionId = e.sessionId;
    }
    this.emit(e);
  }
}
```

- [ ] **Step 7: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/crashTracker.ts src/core/claudeCommand.ts src/core/claudeSession.ts test/fake-claude.mjs test/claudeCommand.test.ts test/claudeSession.test.ts
git commit -m "Run the claude CLI as a long-lived stream-json session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Approval MCP server and the approval probe (phase 0, item 2)

**Files:**
- Create: `src/core/approvalServer.ts`, `scripts/probe-approval.ts`
- Modify: `docs/superpowers/specs/2026-10-23-overlay-chat-design.md` (Phase 0 results)
- Test: `test/approvalServer.test.ts`

**Interfaces:**
- Consumes: `APPROVAL_SERVER`, `buildClaudeArgs` (Task 5).
- Produces:
  - `interface ApprovalRequest { id: string; toolName: string; summary: string }`
  - `type ApprovalDecision = "allow" | "deny"`
  - `summarize(input: unknown, max?: number): string`
  - `class ApprovalServer { constructor(o: { timeoutMs: number; onRequest: (r: ApprovalRequest) => void; onSettled: (id: string) => void }); start(): Promise<number>; stop(): Promise<void>; answer(id: string, d: ApprovalDecision): boolean; setTimeoutMs(ms: number): void; mcpConfig(): { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> } }`

- [ ] **Step 1: Write the failing test**

`test/approvalServer.test.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, summarize, type ApprovalRequest } from "../src/core/approvalServer.js";

let server: ApprovalServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function setup(timeoutMs = 5_000) {
  const requests: ApprovalRequest[] = [];
  const settled: string[] = [];
  server = new ApprovalServer({
    timeoutMs,
    onRequest: (r) => requests.push(r),
    onSettled: (id) => settled.push(id),
  });
  await server.start();
  const cfg = server.mcpConfig().mcpServers.ed_overlay!;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }),
  );
  const call = () =>
    client.callTool({ name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } });
  const decision = async (p: ReturnType<typeof call>) => {
    const r = await p;
    const content = r.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  };
  const waitRequest = async () => {
    while (!requests.length) await new Promise((r) => setTimeout(r, 10));
    return requests[0]!;
  };
  return { requests, settled, client, call, decision, waitRequest, cfg };
}

describe("ApprovalServer", () => {
  it("allows with the original input", async () => {
    const t = await setup();
    const p = t.call();
    const req = await t.waitRequest();
    expect(req).toMatchObject({ toolName: "Bash", summary: '{"command":"ls"}' });
    expect(server!.answer(req.id, "allow")).toBe(true);
    expect(await t.decision(p)).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(t.settled).toEqual([req.id]);
    expect(server!.answer(req.id, "allow")).toBe(false);
  });

  it("denies", async () => {
    const t = await setup();
    const p = t.call();
    server!.answer((await t.waitRequest()).id, "deny");
    expect(await t.decision(p)).toEqual({ behavior: "deny", message: "Player denied" });
  });

  it("denies when nobody answers in time", async () => {
    const t = await setup(50);
    expect(await t.decision(t.call())).toEqual({
      behavior: "deny",
      message: "Player did not answer",
    });
    expect(t.settled).toHaveLength(1);
  });

  it("rejects a request without the token", async () => {
    const t = await setup();
    const res = await fetch(t.cfg.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("listens on 127.0.0.1", async () => {
    const t = await setup();
    expect(t.cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(t.cfg.type).toBe("http");
  });
});

describe("summarize", () => {
  it("cuts long input", () => {
    const s = summarize({ text: "x".repeat(200) });
    expect(s).toHaveLength(80);
    expect(s.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `npx vitest run test/approvalServer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/core/approvalServer.ts`**

```ts
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { APPROVAL_SERVER } from "./claudeCommand.js";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  summary: string;
}
export type ApprovalDecision = "allow" | "deny";

export interface ApprovalServerOptions {
  timeoutMs: number;
  onRequest: (r: ApprovalRequest) => void;
  onSettled: (id: string) => void;
}

export function summarize(input: unknown, max = 80): string {
  const s = JSON.stringify(input) ?? "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export class ApprovalServer {
  private server?: http.Server;
  private port = 0;
  private readonly token = randomBytes(24).toString("hex");
  private readonly pending = new Map<string, (d: ApprovalDecision | "timeout") => void>();
  private timeoutMs: number;

  constructor(private readonly opts: ApprovalServerOptions) {
    this.timeoutMs = opts.timeoutMs;
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Port 0: the system picks a free port.
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const settle of [...this.pending.values()]) settle("deny");
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  answer(id: string, d: ApprovalDecision): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(d);
    return true;
  }

  mcpConfig() {
    return {
      mcpServers: {
        [APPROVAL_SERVER]: {
          type: "http" as const,
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    // Stateless: one MCP server per request, so no session bookkeeping.
    const mcp = this.build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private build(): McpServer {
    const mcp = new McpServer({ name: APPROVAL_SERVER, version: "1.0.0" });
    mcp.registerTool(
      "approve",
      {
        description: "Ask the player to allow or deny a tool call.",
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
          tool_use_id: z.string().optional(),
        },
      },
      async ({ tool_name, input }) => {
        const d = await this.ask(tool_name, input ?? {});
        const payload =
          d === "allow"
            ? { behavior: "allow", updatedInput: input ?? {} }
            : { behavior: "deny", message: d === "timeout" ? "Player did not answer" : "Player denied" };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      },
    );
    return mcp;
  }

  private ask(toolName: string, input: unknown): Promise<ApprovalDecision | "timeout"> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (d: ApprovalDecision | "timeout") => {
        clearTimeout(timer);
        if (!this.pending.delete(id)) return;
        this.opts.onSettled(id);
        resolve(d);
      };
      // A turn must never wait forever for a player who is busy flying.
      const timer = setTimeout(() => settle("timeout"), this.timeoutMs);
      this.pending.set(id, settle);
      this.opts.onRequest({ id, toolName, summary: summarize(input) });
    });
  }
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass.

- [ ] **Step 5: Write the probe script**

`scripts/probe-approval.ts`:

```ts
// Manual probe: runs the real claude CLI against ApprovalServer and records the output.
// Usage: npx tsx scripts/probe-approval.ts <auto|default> "<prompt>" <out.jsonl>
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { ApprovalServer } from "../src/core/approvalServer.js";
import { buildClaudeArgs } from "../src/core/claudeCommand.js";

const [mode, prompt, out] = process.argv.slice(2);
if ((mode !== "auto" && mode !== "default") || !prompt || !out) {
  console.error('Usage: npx tsx scripts/probe-approval.ts <auto|default> "<prompt>" <out.jsonl>');
  process.exit(2);
}
const rl = createInterface({ input: process.stdin, output: process.stderr });
const server = new ApprovalServer({
  timeoutMs: 120_000,
  onRequest: async (r) => {
    const a = await rl.question(`\nApprove ${r.toolName} ${r.summary}? [y/N] `);
    server.answer(r.id, a.trim().toLowerCase() === "y" ? "allow" : "deny");
  },
  onSettled: () => {},
});
await server.start();
const dir = await mkdtemp(path.join(os.tmpdir(), "ed-overlay-probe-"));
const cfg = path.join(dir, "approval-mcp.json");
await writeFile(cfg, JSON.stringify(server.mcpConfig()));
const child = spawn("claude", buildClaudeArgs({ permissionMode: mode, mcpConfigFile: cfg, extraArgs: [] }), {
  cwd: dir,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.pipe(createWriteStream(out));
child.stdin.end(
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) +
    "\n",
);
child.on("exit", async (code) => {
  console.error(`claude exited ${code}; output in ${out}`);
  rl.close();
  await server.stop();
});
```

- [ ] **Step 6: Run the probe in default mode**

Run: `npx tsx scripts/probe-approval.ts default "Run the Bash command ls / and reply in one line." test/fixtures/stream/recorded-approval-default.jsonl`
Expected: the terminal asks `Approve Bash {"command":"ls /"…}? [y/N]`. Answer `y`. The output file ends with a `result` line, and its text describes the folder listing.

When no question appears, the CLI did not call the prompt tool. Write that down in the spec (Step 8), and stop to tell the owner before going on. The approval design depends on it.

- [ ] **Step 7: Run the probe in auto mode**

Run: `npx tsx scripts/probe-approval.ts auto "Delete the folder /tmp/ed-overlay-probe-target with rm -rf, then reply in one line." test/fixtures/stream/recorded-approval-auto.jsonl`
Then: `node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);console.log(JSON.stringify(l.at(-1).permission_denials));' test/fixtures/stream/recorded-approval-auto.jsonl`

Write down whether the terminal asked a question, what `permission_denials` contains, and whether `init` shows `permissionMode` `auto`. The command targets a folder that does not exist, so it is harmless if it runs.

- [ ] **Step 8: Record the results and run the checks**

Add to "Phase 0 results" in the spec:

```markdown
- Prompt tool in default mode: <called / not called>.
- Prompt tool in auto mode: <called for a classifier block / not called; the block appears as …>.
```

Run: `npm run check`
Expected: all tests pass. The recorded-fixture tests in `test/streamJson.test.ts` now also cover the two approval recordings.

- [ ] **Step 9: Commit**

```bash
git add src/core/approvalServer.ts scripts/probe-approval.ts test/approvalServer.test.ts test/fixtures docs
git commit -m "Add the approval MCP server and probe it against the CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Status flags, display mode and the status watcher

**Files:**
- Create: `src/core/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Produces:
  - `interface ShipFlags { docked: boolean; inDanger: boolean }`
  - `decodeStatus(text: string): ShipFlags | null`
  - `type FullscreenMode = "windowed" | "fullscreen" | "borderless"`
  - `fullscreenMode(xml: string): FullscreenMode | null`
  - `class StatusWatcher { constructor(file: string, onChange: (f: ShipFlags) => void, opts?: { intervalMs?: number; read?: (file: string) => Promise<string> }); poll(): Promise<void>; start(): void; stop(): void; readonly flags: ShipFlags | null }`

- [ ] **Step 1: Write the failing test**

`test/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StatusWatcher, decodeStatus, fullscreenMode, type ShipFlags } from "../src/core/status.js";

describe("decodeStatus", () => {
  it("reads docked and in danger", () => {
    expect(decodeStatus('{"Flags":1}')).toEqual({ docked: true, inDanger: false });
    expect(decodeStatus(`{"Flags":${1 << 22}}`)).toEqual({ docked: false, inDanger: true });
    expect(decodeStatus(`{"Flags":${1 << 23}}`)).toEqual({ docked: false, inDanger: true });
  });

  it("treats a missing Flags as neither", () => {
    expect(decodeStatus('{"event":"Status"}')).toEqual({ docked: false, inDanger: false });
  });

  it("returns null for a half-written file", () => {
    expect(decodeStatus("")).toBeNull();
    expect(decodeStatus('{"Flags":')).toBeNull();
    expect(decodeStatus('{"Flags":"x"}')).toBeNull();
  });
});

describe("fullscreenMode", () => {
  it.each([
    ["0", "windowed"],
    ["1", "fullscreen"],
    ["2", "borderless"],
  ] as const)("%s is %s", (v, mode) => {
    expect(fullscreenMode(`<DisplayConfig><FullScreen>${v}</FullScreen></DisplayConfig>`)).toBe(mode);
  });

  it("returns null when the value is missing or unknown", () => {
    expect(fullscreenMode("<DisplayConfig/>")).toBeNull();
    expect(fullscreenMode("<FullScreen>7</FullScreen>")).toBeNull();
  });
});

describe("StatusWatcher", () => {
  it("reports changes and keeps the last good flags", async () => {
    let text = '{"Flags":1}';
    let fail = false;
    const seen: ShipFlags[] = [];
    const w = new StatusWatcher("Status.json", (f) => seen.push(f), {
      read: async () => {
        if (fail) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return text;
      },
    });
    await w.poll();
    await w.poll();
    expect(seen).toEqual([{ docked: true, inDanger: false }]);
    text = "";
    await w.poll();
    fail = true;
    await w.poll();
    expect(w.flags).toEqual({ docked: true, inDanger: false });
    fail = false;
    text = '{"Flags":0}';
    await w.poll();
    expect(seen).toEqual([
      { docked: true, inDanger: false },
      { docked: false, inDanger: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `npx vitest run test/status.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/core/status.ts`**

```ts
import { readFile } from "node:fs/promises";

export interface ShipFlags {
  docked: boolean;
  inDanger: boolean;
}

const DOCKED = 1 << 0;
const IN_DANGER = 1 << 22;
const BEING_INTERDICTED = 1 << 23;

export function decodeStatus(text: string): ShipFlags | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j === null || typeof j !== "object") return null;
  const flags = (j as { Flags?: unknown }).Flags;
  // The game writes no Flags at the main menu.
  if (flags === undefined) return { docked: false, inDanger: false };
  if (typeof flags !== "number") return null;
  return {
    docked: (flags & DOCKED) !== 0,
    inDanger: (flags & (IN_DANGER | BEING_INTERDICTED)) !== 0,
  };
}

export type FullscreenMode = "windowed" | "fullscreen" | "borderless";

const MODES: Record<string, FullscreenMode> = { "0": "windowed", "1": "fullscreen", "2": "borderless" };

export function fullscreenMode(xml: string): FullscreenMode | null {
  const m = /<FullScreen>\s*(\d+)\s*<\/FullScreen>/.exec(xml);
  return m ? (MODES[m[1]!] ?? null) : null;
}

// The game rewrites Status.json several times a second, which fs.watch reports unreliably.
export class StatusWatcher {
  private timer?: NodeJS.Timeout;
  private last: ShipFlags | null = null;
  private lastText?: string;

  constructor(
    private readonly file: string,
    private readonly onChange: (f: ShipFlags) => void,
    private readonly opts: { intervalMs?: number; read?: (file: string) => Promise<string> } = {},
  ) {}

  get flags(): ShipFlags | null {
    return this.last;
  }

  async poll(): Promise<void> {
    let text: string;
    try {
      text = await (this.opts.read ?? ((f: string) => readFile(f, "utf8")))(this.file);
    } catch {
      return;
    }
    if (text === this.lastText) return;
    const f = decodeStatus(text);
    if (!f) return;
    this.lastText = text;
    if (this.last && this.last.docked === f.docked && this.last.inDanger === f.inDanger) return;
    this.last = f;
    this.onChange(f);
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 500);
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/status.ts test/status.test.ts
git commit -m "Read ship flags from Status.json and the game's display mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Overlay state and view model

**Files:**
- Create: `src/core/controller.ts`, `src/core/view.ts`
- Test: `test/controller.test.ts`, `test/view.test.ts`

**Interfaces:**
- Consumes: `BackendEvent` (Task 5), `ApprovalRequest` (Task 6), `ShipFlags` (Task 7), `parseChips`, `firstLine`, `Chip`, `growsUp` (Task 3), `Settings` (Task 1).
- Produces:
  - `interface Turn { role: "user" | "assistant"; text: string }`
  - `interface OverlayState { visible; chatOpen; historyOpen; cardOpen: boolean; session: "starting" | "idle" | "thinking" | "stopped"; tool: string | null; blocked: string | null; reply: string; chips: Chip[]; pinned: string | null; history: Turn[]; approval: ApprovalRequest | null; flags: ShipFlags | null; notices: Record<string, string> }`
  - `INITIAL_STATE: OverlayState`
  - `type Action` (listed in Step 3)
  - `reduce(s: OverlayState, a: Action): OverlayState`
  - `interface WindowProps { show: boolean; interactive: boolean }`, `windowProps(s): WindowProps`
  - `canOpenChat(s, blockWhenInDanger: boolean): boolean`
  - `currentChips(s): Chip[]`
  - `interface ViewModel` (Step 5), `buildView(s: OverlayState, settings: Settings): ViewModel`, `statusText(s): string`, `shortTool(name: string): string`

- [ ] **Step 1: Write the failing tests**

`test/controller.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  canOpenChat,
  currentChips,
  reduce,
  windowProps,
  type Action,
  type OverlayState,
} from "../src/core/controller.js";

const run = (actions: Action[], from: OverlayState = INITIAL_STATE) => actions.reduce(reduce, from);
const ready: Action = {
  type: "backend",
  event: { type: "ready", sessionId: "s", tools: [], mcpServers: [], permissionMode: "auto" },
};
const text = (delta: string): Action => ({ type: "backend", event: { type: "text", delta } });
const result = (over: Partial<{ isError: boolean; text: string | null; denials: string[] }> = {}): Action => ({
  type: "backend",
  event: { type: "result", isError: false, durationMs: 1, text: null, sessionId: "s", denials: [], ...over },
});

describe("reduce", () => {
  it("goes idle on ready", () => {
    expect(run([ready]).session).toBe("idle");
  });

  it("streams a reply into the card, then pins it with its chips", () => {
    let s = run([ready, { type: "openChat" }, { type: "sent", text: "where?" }]);
    expect(s).toMatchObject({ chatOpen: false, cardOpen: true, session: "thinking", reply: "" });
    expect(s.history).toEqual([{ role: "user", text: "where?" }]);
    s = run([text("Go to ⟦Hip 3922⟧\nthen dock")], s);
    expect(currentChips(s)).toEqual([{ n: 1, text: "Hip 3922" }]);
    s = run([result()], s);
    expect(s).toMatchObject({ session: "idle", pinned: "Go to Hip 3922", chips: [{ n: 1, text: "Hip 3922" }] });
    expect(s.history.at(-1)).toEqual({ role: "assistant", text: "Go to ⟦Hip 3922⟧\nthen dock" });
    expect(run([{ type: "cardTimeout" }], s).cardOpen).toBe(false);
  });

  it("keeps the old chips while the next reply streams", () => {
    const s = run([ready, { type: "sent", text: "a" }, text("⟦Sol⟧"), result(), { type: "sent", text: "b" }]);
    expect(s.chips).toEqual([{ n: 1, text: "Sol" }]);
    expect(currentChips(s)).toEqual([]);
  });

  it("does not close the card while thinking", () => {
    const s = run([ready, { type: "sent", text: "a" }, { type: "cardTimeout" }]);
    expect(s.cardOpen).toBe(true);
  });

  it("stays thinking when a restarted CLI reports ready", () => {
    expect(run([{ type: "sent", text: "a" }, ready]).session).toBe("thinking");
  });

  it("shows the running tool", () => {
    const start: Action = { type: "backend", event: { type: "toolStart", id: "1", name: "mcp__ed-mcp__spansh_route" } };
    const end: Action = { type: "backend", event: { type: "toolEnd", id: "1", name: "x", isError: false } };
    expect(run([ready, { type: "sent", text: "a" }, start]).tool).toBe("mcp__ed-mcp__spansh_route");
    expect(run([ready, { type: "sent", text: "a" }, start, end]).tool).toBeNull();
  });

  it("shows an error result's message in the card", () => {
    const s = run([ready, { type: "sent", text: "a" }, result({ isError: true, text: "Please run /login" })]);
    expect(s.reply).toBe("Please run /login");
    expect(s.cardOpen).toBe(true);
  });

  it("records the first denied tool", () => {
    expect(run([ready, { type: "sent", text: "a" }, result({ denials: ["Bash"] })]).blocked).toBe("Bash");
  });

  it("reports exits, give-ups and spawn errors as notices", () => {
    const exit: Action = { type: "backend", event: { type: "exit", code: 1, stderrTail: ["x", "boom"] } };
    expect(run([exit]).notices.claude).toBe("⚠ Claude stopped: boom");
    expect(run([exit]).session).toBe("stopped");
    const gave: Action = { type: "backend", event: { type: "gaveUp", stderrTail: [] } };
    expect(run([gave]).notices.claude).toBe("⚠ Claude keeps stopping");
    const missing: Action = { type: "backend", event: { type: "spawnError", message: "spawn claude ENOENT" } };
    expect(run([missing]).notices.claude).toBe("⚠ claude not found: install Claude Code or set claude.path");
    expect(run([missing, ready]).notices.claude).toBeUndefined();
  });

  it("sets and clears notices", () => {
    const s = run([{ type: "notice", key: "a", text: "⚠ x" }]);
    expect(s.notices).toEqual({ a: "⚠ x" });
    expect(run([{ type: "notice", key: "a", text: null }], s).notices).toEqual({});
  });

  it("tracks approvals by id", () => {
    const req = { id: "r1", toolName: "Bash", summary: "{}" };
    const s = run([{ type: "approval", request: req }]);
    expect(s.approval).toEqual(req);
    expect(run([{ type: "approvalSettled", id: "other" }], s).approval).toEqual(req);
    expect(run([{ type: "approvalSettled", id: "r1" }], s).approval).toBeNull();
  });

  it("clears the conversation on newSession", () => {
    const s = run([ready, { type: "sent", text: "a" }, text("⟦Sol⟧"), result(), { type: "newSession" }]);
    expect(s).toMatchObject({ reply: "", chips: [], pinned: null, history: [], session: "starting", cardOpen: false });
  });

  it("returns to starting on cancel", () => {
    expect(run([ready, { type: "sent", text: "a" }, { type: "cancelled" }]).session).toBe("starting");
  });
});

describe("windowProps", () => {
  it("is interactive only with the chat open", () => {
    expect(windowProps(INITIAL_STATE)).toEqual({ show: true, interactive: false });
    expect(windowProps(run([{ type: "openChat" }]))).toEqual({ show: true, interactive: true });
    expect(windowProps(run([{ type: "toggleHistory" }]))).toEqual({ show: true, interactive: false });
  });

  it("hides, but still shows a pending approval", () => {
    const hidden = run([{ type: "toggleVisible" }]);
    expect(windowProps(hidden).show).toBe(false);
    const req = { id: "r", toolName: "Bash", summary: "" };
    expect(windowProps(run([{ type: "approval", request: req }], hidden)).show).toBe(true);
  });
});

describe("canOpenChat", () => {
  it("blocks only when in danger and blocking is on", () => {
    const danger = run([{ type: "flags", flags: { docked: false, inDanger: true } }]);
    expect(canOpenChat(danger, true)).toBe(false);
    expect(canOpenChat(danger, false)).toBe(true);
    expect(canOpenChat(INITIAL_STATE, true)).toBe(true);
  });
});
```

`test/view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduce, type Action, type OverlayState } from "../src/core/controller.js";
import { DEFAULT_SETTINGS, SettingsSchema } from "../src/core/settings.js";
import { buildView, shortTool, statusText } from "../src/core/view.js";

const run = (actions: Action[]) => actions.reduce(reduce, INITIAL_STATE);
const ready: Action = {
  type: "backend",
  event: { type: "ready", sessionId: "s", tools: [], mcpServers: [], permissionMode: "auto" },
};

describe("shortTool", () => {
  it("drops the MCP prefix", () => {
    expect(shortTool("mcp__ed-mcp__spansh_route")).toBe("spansh_route");
    expect(shortTool("mcp__plugin_ed-mcp_ed-mcp__journal_status")).toBe("journal_status");
    expect(shortTool("Bash")).toBe("Bash");
  });
});

describe("statusText", () => {
  const s = (over: Partial<OverlayState>) => ({ ...INITIAL_STATE, ...over });
  it.each([
    [s({}), "● starting"],
    [s({ session: "idle" }), "● idle"],
    [s({ session: "thinking" }), "● thinking"],
    [s({ session: "thinking", tool: "mcp__ed-mcp__spansh_route" }), "🔧 spansh_route…"],
    [s({ session: "idle", blocked: "Bash" }), "🛡 blocked: Bash"],
    [s({ session: "stopped" }), "⚠ stopped"],
    [s({ session: "idle", flags: { docked: true, inDanger: false } }), "● idle   ⚓ docked"],
    [s({ session: "idle", flags: { docked: false, inDanger: true } }), "● idle   ⛔ in danger"],
  ])("%#", (state, expected) => {
    expect(statusText(state)).toBe(expected);
  });
});

describe("buildView", () => {
  it("shows the strip with the pinned line and chips at rest", () => {
    const st = run([
      ready,
      { type: "sent", text: "q" },
      { type: "backend", event: { type: "text", delta: "Go to ⟦Sol⟧" } },
      { type: "backend", event: { type: "result", isError: false, durationMs: 1, text: null, sessionId: "s", denials: [] } },
      { type: "cardTimeout" },
    ]);
    const v = buildView(st, DEFAULT_SETTINGS);
    expect(v).toMatchObject({
      show: true,
      mode: "strip",
      status: "● idle",
      pinned: "Go to Sol",
      chips: [{ n: 1, text: "Sol" }],
      card: null,
      chat: null,
      approval: null,
    });
    expect(v.ui).toEqual({
      fontSize: 14,
      width: 420,
      maxLines: 4,
      chatLines: 14,
      growsUp: false,
      copyChipKey: "Ctrl+Shift+n",
    });
  });

  it("hides the pinned line and chips when settings say so", () => {
    const settings = SettingsSchema.parse({ strip: { lines: 1, keepChips: false } });
    const st = run([ready, { type: "sent", text: "q" }, { type: "backend", event: { type: "text", delta: "⟦Sol⟧" } }]);
    const v = buildView(reduce(st, { type: "backend", event: { type: "result", isError: false, durationMs: 1, text: null, sessionId: "s", denials: [] } }), settings);
    expect(v.pinned).toBeNull();
    expect(v.chips).toEqual([]);
  });

  it("shows the streaming card", () => {
    const st = run([ready, { type: "sent", text: "q" }, { type: "backend", event: { type: "text", delta: "Go ⟦Sol⟧" } }]);
    expect(buildView(st, DEFAULT_SETTINGS).card).toEqual({ text: "Go Sol", chips: [{ n: 1, text: "Sol" }] });
  });

  it("shows the chat with history and the moving warning", () => {
    const st = run([ready, { type: "flags", flags: { docked: false, inDanger: false } }, { type: "openChat" }]);
    expect(buildView(st, DEFAULT_SETTINGS).chat).toEqual({ history: [], streaming: null, input: true, moving: true });
    const hist = run([ready, { type: "toggleHistory" }]);
    expect(buildView(hist, DEFAULT_SETTINGS).chat?.input).toBe(false);
  });

  it("shows the latest notice and the approval with its keys", () => {
    const st = run([
      { type: "notice", key: "a", text: "⚠ one" },
      { type: "notice", key: "b", text: "⚠ two" },
      { type: "approval", request: { id: "r", toolName: "mcp__x__y", summary: "{}" } },
    ]);
    const v = buildView(st, DEFAULT_SETTINGS);
    expect(v.notice).toBe("⚠ two");
    expect(v.approval).toEqual({ toolName: "y", summary: "{}", approveKey: "Ctrl+Shift+Y", denyKey: "Ctrl+Shift+N" });
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/controller.test.ts test/view.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/core/controller.ts`**

```ts
import type { ApprovalRequest } from "./approvalServer.js";
import { firstLine, parseChips, type Chip } from "./chips.js";
import type { BackendEvent } from "./claudeSession.js";
import type { ShipFlags } from "./status.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface OverlayState {
  visible: boolean;
  chatOpen: boolean;
  historyOpen: boolean;
  cardOpen: boolean;
  session: "starting" | "idle" | "thinking" | "stopped";
  tool: string | null;
  blocked: string | null;
  reply: string;
  chips: Chip[];
  pinned: string | null;
  history: Turn[];
  approval: ApprovalRequest | null;
  flags: ShipFlags | null;
  notices: Record<string, string>;
}

export const INITIAL_STATE: OverlayState = {
  visible: true,
  chatOpen: false,
  historyOpen: false,
  cardOpen: false,
  session: "starting",
  tool: null,
  blocked: null,
  reply: "",
  chips: [],
  pinned: null,
  history: [],
  approval: null,
  flags: null,
  notices: {},
};

export type Action =
  | { type: "toggleVisible" }
  | { type: "openChat" }
  | { type: "closeChat" }
  | { type: "toggleHistory" }
  | { type: "sent"; text: string }
  | { type: "backend"; event: BackendEvent }
  | { type: "cardTimeout" }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approvalSettled"; id: string }
  | { type: "flags"; flags: ShipFlags | null }
  | { type: "notice"; key: string; text: string | null }
  | { type: "newSession" }
  | { type: "cancelled" };

function withNotice(s: OverlayState, key: string, text: string | null): OverlayState {
  const { [key]: _old, ...rest } = s.notices;
  return { ...s, notices: text === null ? rest : { ...rest, [key]: text } };
}

const tail = (lines: string[]) => (lines.length ? `: ${lines.at(-1)}` : "");

function onBackend(s: OverlayState, e: BackendEvent): OverlayState {
  switch (e.type) {
    case "ready":
      return withNotice({ ...s, session: s.session === "thinking" ? "thinking" : "idle" }, "claude", null);
    case "text":
      return { ...s, reply: s.reply + e.delta, session: "thinking" };
    case "toolStart":
      return { ...s, tool: e.name };
    case "toolEnd":
      return { ...s, tool: null };
    case "result": {
      // An error result carries the CLI's own message, which is shown unchanged.
      const reply = e.isError ? (e.text ?? "Claude returned an error.") : s.reply || (e.text ?? "");
      const { plain, chips } = parseChips(reply);
      return {
        ...s,
        session: "idle",
        tool: null,
        reply,
        chips,
        pinned: firstLine(plain),
        blocked: e.denials[0] ?? null,
        cardOpen: true,
        history: [...s.history, { role: "assistant", text: reply }],
      };
    }
    case "exit":
      return withNotice({ ...s, session: "stopped", tool: null }, "claude", `⚠ Claude stopped${tail(e.stderrTail)}`);
    case "gaveUp":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        `⚠ Claude keeps stopping${tail(e.stderrTail)}`,
      );
    case "spawnError":
      return withNotice(
        { ...s, session: "stopped", tool: null },
        "claude",
        e.message.includes("ENOENT")
          ? "⚠ claude not found: install Claude Code or set claude.path"
          : `⚠ Can't start claude: ${e.message}`,
      );
    case "unknown":
      return s;
  }
}

export function reduce(s: OverlayState, a: Action): OverlayState {
  switch (a.type) {
    case "toggleVisible":
      return { ...s, visible: !s.visible };
    case "openChat":
      return { ...s, chatOpen: true, visible: true };
    case "closeChat":
      return { ...s, chatOpen: false };
    case "toggleHistory":
      return { ...s, historyOpen: !s.historyOpen, visible: true };
    case "sent":
      return {
        ...s,
        chatOpen: false,
        cardOpen: true,
        session: "thinking",
        reply: "",
        blocked: null,
        history: [...s.history, { role: "user", text: a.text }],
      };
    case "backend":
      return onBackend(s, a.event);
    case "cardTimeout":
      return s.session === "thinking" ? s : { ...s, cardOpen: false };
    case "approval":
      return { ...s, approval: a.request };
    case "approvalSettled":
      return s.approval?.id === a.id ? { ...s, approval: null } : s;
    case "flags":
      return { ...s, flags: a.flags };
    case "notice":
      return withNotice(s, a.key, a.text);
    case "newSession":
      return withNotice(
        {
          ...s,
          reply: "",
          chips: [],
          pinned: null,
          history: [],
          session: "starting",
          tool: null,
          blocked: null,
          cardOpen: false,
        },
        "claude",
        null,
      );
    case "cancelled":
      return { ...s, session: "starting", tool: null };
  }
}

export interface WindowProps {
  show: boolean;
  interactive: boolean;
}

export function windowProps(s: OverlayState): WindowProps {
  return { show: s.visible || s.chatOpen || s.approval !== null, interactive: s.chatOpen };
}

export function canOpenChat(s: OverlayState, blockWhenInDanger: boolean): boolean {
  return !(blockWhenInDanger && s.flags?.inDanger);
}

/** The chips that copyChip numbers refer to: the streaming reply's, else the last reply's. */
export function currentChips(s: OverlayState): Chip[] {
  return s.session === "thinking" ? parseChips(s.reply).chips : s.chips;
}
```

- [ ] **Step 4: Run the controller test and check that it passes**

Run: `npx vitest run test/controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/core/view.ts`**

```ts
import { growsUp } from "./anchor.js";
import { parseChips, type Chip } from "./chips.js";
import type { OverlayState, Turn } from "./controller.js";
import type { Settings } from "./settings.js";

export interface ViewModel {
  show: boolean;
  mode: "strip" | "card" | "chat";
  status: string;
  notice: string | null;
  pinned: string | null;
  chips: Chip[];
  card: { text: string; chips: Chip[] } | null;
  chat: { history: Turn[]; streaming: string | null; input: boolean; moving: boolean } | null;
  approval: { toolName: string; summary: string; approveKey: string; denyKey: string } | null;
  ui: {
    fontSize: number;
    width: number;
    maxLines: number;
    chatLines: number;
    growsUp: boolean;
    copyChipKey: string;
  };
}

export function shortTool(name: string): string {
  return name.split("__").at(-1) ?? name;
}

export function statusText(s: OverlayState): string {
  const state =
    s.session === "starting"
      ? "● starting"
      : s.session === "stopped"
        ? "⚠ stopped"
        : s.tool
          ? `🔧 ${shortTool(s.tool)}…`
          : s.session === "thinking"
            ? "● thinking"
            : s.blocked
              ? `🛡 blocked: ${shortTool(s.blocked)}`
              : "● idle";
  const ship = s.flags?.inDanger ? "   ⛔ in danger" : s.flags?.docked ? "   ⚓ docked" : "";
  return state + ship;
}

export function buildView(s: OverlayState, settings: Settings): ViewModel {
  const open = s.chatOpen || s.historyOpen;
  const mode = open ? "chat" : s.cardOpen ? "card" : "strip";
  const reply = parseChips(s.reply);
  const scale = settings.style.fontSize / 14;
  return {
    show: s.visible || s.chatOpen || s.approval !== null,
    mode,
    status: statusText(s),
    notice: Object.values(s.notices).at(-1) ?? null,
    pinned: settings.strip.lines === 2 ? s.pinned : null,
    chips: settings.strip.keepChips ? s.chips : [],
    card: mode === "card" ? { text: reply.plain, chips: reply.chips } : null,
    chat: open
      ? {
          history: s.history,
          streaming: s.session === "thinking" ? reply.plain : null,
          input: s.chatOpen,
          moving: s.flags ? !s.flags.docked : false,
        }
      : null,
    approval: s.approval
      ? {
          toolName: shortTool(s.approval.toolName),
          summary: s.approval.summary,
          approveKey: settings.hotkeys.approve,
          denyKey: settings.hotkeys.deny,
        }
      : null,
    ui: {
      fontSize: settings.style.fontSize,
      width: Math.round(settings.card.width * scale),
      maxLines: settings.card.maxLines,
      chatLines: settings.chat.lines,
      growsUp: growsUp(settings.position.anchor),
      copyChipKey: settings.hotkeys.copyChip.replace("{n}", "n"),
    },
  };
}
```

Note: `ui.growsUp` uses `settings.position`. Main passes settings with the effective position (Task 11), so a position chosen by hotkey is used.

- [ ] **Step 6: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/controller.ts src/core/view.ts test/controller.test.ts test/view.test.ts
git commit -m "Add the overlay state machine and view model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Hotkeys, stores and the logger

**Files:**
- Create: `src/core/hotkeys.ts`, `src/core/stores.ts`, `src/core/logger.ts`
- Test: `test/hotkeys.test.ts`, `test/stores.test.ts`, `test/logger.test.ts`

**Interfaces:**
- Consumes: `Settings`, `Position`, `PositionSchema`, `parseSettings`, `defaultSettingsText`, `DEFAULT_SETTINGS` (Task 1); `Direction` (Task 3); `Turn` (Task 8).
- Produces:
  - `type HotkeyAction = { type: "openChat" } | { type: "toggleOverlay" } | { type: "showHistory" } | { type: "approve" } | { type: "deny" } | { type: "cancel" } | { type: "copyChip"; n: number } | { type: "move"; dir: Direction } | { type: "nextDisplay" }`
  - `interface Binding { name: string; accelerator: string; action: HotkeyAction }`
  - `bindings(h: Settings["hotkeys"]): Binding[]`
  - `interface Registrar { register(accelerator: string, cb: () => void): boolean; unregister(accelerator: string): void }`
  - `class HotkeyManager { constructor(reg: Registrar, run: (a: HotkeyAction) => void); setBindings(b: Binding[]): string[]; activate(): string[]; deactivate(): void; readonly active: boolean }`
  - `interface LoadResult { changed: boolean; error: string | null }`
  - `class SettingsStore { constructor(file: string); readonly settings: Settings; load(): Promise<LoadResult>; watch(cb: (r: LoadResult) => void, intervalMs?: number): void; unwatch(): void }`
  - `interface SavedState { position?: Position; positionBase?: string }`
  - `effectivePosition(settingsPos: Position, saved: SavedState): { position: Position; saved: SavedState }`
  - `savePosition(settingsPos: Position, saved: SavedState, position: Position): SavedState`
  - `class StateStore { constructor(file: string); read(): Promise<SavedState>; write(s: SavedState): Promise<void> }`
  - `class HistoryStore { constructor(dir: string, now?: () => Date); newSession(): void; append(t: Turn): Promise<void> }`
  - `class Logger { constructor(file: string, maxBytes?: number, keep?: number); log(level: "info" | "warn" | "debug", msg: string): void }`

- [ ] **Step 1: Write the failing tests**

`test/hotkeys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HotkeyManager, bindings, type HotkeyAction, type Registrar } from "../src/core/hotkeys.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

function fakeRegistrar(taken: string[] = []) {
  const live = new Map<string, () => void>();
  const reg: Registrar = {
    register(acc, cb) {
      if (acc === "Bad+Key") throw new Error("invalid accelerator");
      if (taken.includes(acc) || live.has(acc)) return false;
      live.set(acc, cb);
      return true;
    },
    unregister(acc) {
      live.delete(acc);
    },
  };
  return { reg, live };
}

describe("bindings", () => {
  it("expands copyChip to 9 bindings and lists the rest", () => {
    const b = bindings(DEFAULT_SETTINGS.hotkeys);
    expect(b).toHaveLength(11 + 9);
    expect(b.find((x) => x.accelerator === "Ctrl+Shift+3")?.action).toEqual({ type: "copyChip", n: 3 });
    expect(b.find((x) => x.name === "moveLeft")).toEqual({
      name: "moveLeft",
      accelerator: "Ctrl+Alt+Left",
      action: { type: "move", dir: "left" },
    });
    expect(b.some((x) => x.name === "scope")).toBe(false);
  });
});

describe("HotkeyManager", () => {
  it("registers on activate and runs actions", () => {
    const { reg, live } = fakeRegistrar();
    const ran: HotkeyAction[] = [];
    const m = new HotkeyManager(reg, (a) => ran.push(a));
    m.setBindings(bindings(DEFAULT_SETTINGS.hotkeys));
    expect(live.size).toBe(0);
    expect(m.activate()).toEqual([]);
    expect(live.size).toBe(20);
    live.get("Ctrl+Shift+Space")!();
    expect(ran).toEqual([{ type: "openChat" }]);
    m.deactivate();
    expect(live.size).toBe(0);
  });

  it("reports taken and invalid keys and keeps the others", () => {
    const { reg, live } = fakeRegistrar(["Ctrl+Shift+O"]);
    const m = new HotkeyManager(reg, () => {});
    m.setBindings([
      { name: "toggleOverlay", accelerator: "Ctrl+Shift+O", action: { type: "toggleOverlay" } },
      { name: "openChat", accelerator: "Bad+Key", action: { type: "openChat" } },
      { name: "deny", accelerator: "Ctrl+Shift+N", action: { type: "deny" } },
    ]);
    expect(m.activate()).toEqual(["toggleOverlay (Ctrl+Shift+O)", "openChat (Bad+Key)"]);
    expect([...live.keys()]).toEqual(["Ctrl+Shift+N"]);
  });

  it("re-registers new bindings when active", () => {
    const { reg, live } = fakeRegistrar();
    const m = new HotkeyManager(reg, () => {});
    m.setBindings([{ name: "deny", accelerator: "A", action: { type: "deny" } }]);
    m.activate();
    m.setBindings([{ name: "deny", accelerator: "B", action: { type: "deny" } }]);
    expect([...live.keys()]).toEqual(["B"]);
    expect(m.active).toBe(true);
  });
});
```

`test/stores.test.ts`:

```ts
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultSettingsText } from "../src/core/settings.js";
import {
  HistoryStore,
  SettingsStore,
  StateStore,
  effectivePosition,
  savePosition,
} from "../src/core/stores.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "ed-overlay-"));

describe("SettingsStore", () => {
  it("writes defaults on first run", async () => {
    const file = path.join(await tmp(), "sub", "settings.json");
    const s = new SettingsStore(file);
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(await readFile(file, "utf8")).toBe(defaultSettingsText());
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(await s.load()).toEqual({ changed: false, error: null });
  });

  it("keeps the last good settings on a bad edit", async () => {
    const file = path.join(await tmp(), "settings.json");
    await writeFile(file, '{"card":{"maxLines":6}}');
    const s = new SettingsStore(file);
    await s.load();
    await writeFile(file, '{"card":');
    const r = await s.load();
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/^⚠ settings\.json: not valid JSON/);
    expect(s.settings.card.maxLines).toBe(6);
    await writeFile(file, '{"card":{"maxLines":3}}');
    expect(await s.load()).toEqual({ changed: true, error: null });
    expect(s.settings.card.maxLines).toBe(3);
  });
});

describe("position precedence", () => {
  const base = DEFAULT_SETTINGS.position;
  const moved = { ...base, anchor: "bottom-left" as const };

  it("uses the saved position while settings are unchanged", () => {
    const saved = savePosition(base, {}, moved);
    expect(effectivePosition(base, saved).position).toEqual(moved);
  });

  it("uses settings once their position changes, and drops the saved one", () => {
    const saved = savePosition(base, {}, moved);
    const edited = { ...base, offsetX: 50 };
    expect(effectivePosition(edited, saved)).toEqual({ position: edited, saved: {} });
  });

  it("uses settings when nothing is saved", () => {
    expect(effectivePosition(base, {}).position).toEqual(base);
  });
});

describe("StateStore", () => {
  it("round-trips and ignores a broken file", async () => {
    const file = path.join(await tmp(), "state.json");
    const st = new StateStore(file);
    expect(await st.read()).toEqual({});
    const saved = savePosition(DEFAULT_SETTINGS.position, {}, DEFAULT_SETTINGS.position);
    await st.write(saved);
    expect(await st.read()).toEqual(saved);
    await writeFile(file, "{");
    expect(await st.read()).toEqual({});
  });
});

describe("HistoryStore", () => {
  it("writes one JSONL file per session", async () => {
    const dir = await tmp();
    let t = new Date("2026-10-23T10:00:00.000Z");
    const h = new HistoryStore(dir, () => t);
    h.newSession();
    await h.append({ role: "user", text: "a" });
    t = new Date("2026-10-23T11:00:00.000Z");
    h.newSession();
    await h.append({ role: "assistant", text: "b" });
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["2026-10-23T10-00-00-000Z.jsonl", "2026-10-23T11-00-00-000Z.jsonl"]);
    const line = JSON.parse((await readFile(path.join(dir, files[0]!), "utf8")).trim());
    expect(line).toEqual({ at: "2026-10-23T10:00:00.000Z", role: "user", text: "a" });
  });
});
```

`test/logger.test.ts`:

```ts
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Logger } from "../src/core/logger.js";

describe("Logger", () => {
  it("rotates and keeps 3 files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed-overlay-"));
    const file = path.join(dir, "logs", "overlay.log");
    const log = new Logger(file, 100, 3);
    for (let i = 0; i < 20; i++) log.log("info", `line ${i} ${"x".repeat(30)}`);
    expect((await readdir(path.dirname(file))).sort()).toEqual(["overlay.log", "overlay.log.1", "overlay.log.2"]);
    expect(await readFile(file, "utf8")).toContain("line 19");
    expect(await readFile(file, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT.* info line/);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/hotkeys.test.ts test/stores.test.ts test/logger.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/core/hotkeys.ts`**

```ts
import type { Direction } from "./anchor.js";
import type { Settings } from "./settings.js";

export type HotkeyAction =
  | { type: "openChat" }
  | { type: "toggleOverlay" }
  | { type: "showHistory" }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "cancel" }
  | { type: "copyChip"; n: number }
  | { type: "move"; dir: Direction }
  | { type: "nextDisplay" };

export interface Binding {
  name: string;
  accelerator: string;
  action: HotkeyAction;
}

export function bindings(h: Settings["hotkeys"]): Binding[] {
  const b = (name: string, accelerator: string, action: HotkeyAction): Binding => ({
    name,
    accelerator,
    action,
  });
  return [
    b("openChat", h.openChat, { type: "openChat" }),
    b("toggleOverlay", h.toggleOverlay, { type: "toggleOverlay" }),
    b("showHistory", h.showHistory, { type: "showHistory" }),
    b("approve", h.approve, { type: "approve" }),
    b("deny", h.deny, { type: "deny" }),
    b("cancel", h.cancel, { type: "cancel" }),
    b("moveUp", h.moveUp, { type: "move", dir: "up" }),
    b("moveDown", h.moveDown, { type: "move", dir: "down" }),
    b("moveLeft", h.moveLeft, { type: "move", dir: "left" }),
    b("moveRight", h.moveRight, { type: "move", dir: "right" }),
    b("nextDisplay", h.nextDisplay, { type: "nextDisplay" }),
    ...Array.from({ length: 9 }, (_, i) =>
      b(`copyChip${i + 1}`, h.copyChip.replace("{n}", String(i + 1)), { type: "copyChip", n: i + 1 }),
    ),
  ];
}

export interface Registrar {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}

export class HotkeyManager {
  private current: Binding[] = [];
  private registered: string[] = [];
  private _active = false;

  constructor(
    private readonly reg: Registrar,
    private readonly run: (a: HotkeyAction) => void,
  ) {}

  get active(): boolean {
    return this._active;
  }

  /** Returns the bindings that failed to register, when active. */
  setBindings(b: Binding[]): string[] {
    const wasActive = this._active;
    this.deactivate();
    this.current = b;
    return wasActive ? this.activate() : [];
  }

  activate(): string[] {
    if (this._active) return [];
    this._active = true;
    const failed: string[] = [];
    for (const b of this.current) {
      let ok = false;
      try {
        ok = this.reg.register(b.accelerator, () => this.run(b.action));
      } catch {
        // Electron throws on an accelerator it cannot parse.
      }
      if (ok) this.registered.push(b.accelerator);
      else failed.push(`${b.name} (${b.accelerator})`);
    }
    return failed;
  }

  deactivate(): void {
    for (const a of this.registered) this.reg.unregister(a);
    this.registered = [];
    this._active = false;
  }
}
```

- [ ] **Step 4: Write `src/core/stores.ts`**

```ts
import { unwatchFile, watchFile } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Turn } from "./controller.js";
import {
  DEFAULT_SETTINGS,
  PositionSchema,
  defaultSettingsText,
  parseSettings,
  type Position,
  type Settings,
} from "./settings.js";

export interface LoadResult {
  changed: boolean;
  error: string | null;
}

export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;
  private lastText: string | null = null;
  private lastError: string | null = null;
  private firstLoad = true;

  constructor(private readonly file: string) {}

  get settings(): Settings {
    return this.current;
  }

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { changed: false, error: `⚠ settings.json: ${code ?? String(err)}` };
      text = defaultSettingsText();
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, text);
    }
    if (text === this.lastText) return { changed: false, error: this.lastError };
    this.lastText = text;
    const r = parseSettings(text);
    if (!r.ok) {
      // Keep the last good settings: a half-saved file must not unbind every hotkey.
      this.lastError = `⚠ settings.json: ${r.error}`;
      return { changed: false, error: this.lastError };
    }
    this.lastError = null;
    const changed = this.firstLoad || JSON.stringify(r.settings) !== JSON.stringify(this.current);
    this.firstLoad = false;
    this.current = r.settings;
    return { changed, error: null };
  }

  // Polling, because editors often save by replacing the file, which fs.watch can lose.
  watch(cb: (r: LoadResult) => void, intervalMs = 1_000): void {
    watchFile(this.file, { interval: intervalMs }, () => {
      void this.load().then(cb);
    });
  }

  unwatch(): void {
    unwatchFile(this.file);
  }
}

export interface SavedState {
  position?: Position;
  positionBase?: string;
}

const SavedStateSchema = z.object({
  position: PositionSchema.optional(),
  positionBase: z.string().optional(),
});

// A hotkey-chosen position is kept until the player edits position in settings.json.
export function effectivePosition(
  settingsPos: Position,
  saved: SavedState,
): { position: Position; saved: SavedState } {
  if (saved.position && saved.positionBase === JSON.stringify(settingsPos)) {
    return { position: saved.position, saved };
  }
  const { position: _p, positionBase: _b, ...rest } = saved;
  return { position: settingsPos, saved: rest };
}

export function savePosition(settingsPos: Position, saved: SavedState, position: Position): SavedState {
  return { ...saved, position, positionBase: JSON.stringify(settingsPos) };
}

export class StateStore {
  constructor(private readonly file: string) {}

  async read(): Promise<SavedState> {
    try {
      const r = SavedStateSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  }

  async write(s: SavedState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
    await rename(tmp, this.file);
  }
}

export class HistoryStore {
  private file: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  newSession(): void {
    this.file = path.join(this.dir, `${this.now().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  }

  async append(t: Turn): Promise<void> {
    if (!this.file) this.newSession();
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file!, JSON.stringify({ at: this.now().toISOString(), ...t }) + "\n");
  }
}
```

- [ ] **Step 5: Write `src/core/logger.ts`**

```ts
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export class Logger {
  private ready = false;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly keep = 3,
  ) {}

  log(level: "info" | "warn" | "debug", msg: string): void {
    try {
      if (!this.ready) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        this.ready = true;
      }
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) this.rotate();
      appendFileSync(this.file, `${new Date().toISOString()} ${level} ${msg}\n`);
    } catch {
      // Logging must never break the overlay.
    }
  }

  private rotate(): void {
    rmSync(`${this.file}.${this.keep - 1}`, { force: true });
    for (let i = this.keep - 2; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }
}
```

- [ ] **Step 6: Run the tests and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/hotkeys.ts src/core/stores.ts src/core/logger.ts test/hotkeys.test.ts test/stores.test.ts test/logger.test.ts
git commit -m "Add hotkey bindings, settings and state stores, and the log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Focus manager and Win32 bindings

**Files:**
- Create: `src/core/focus.ts`, `src/main/win32.ts`
- Test: `test/focus.test.ts`

**Interfaces:**
- Produces:
  - `interface Win32 { foreground(): number; isWindow(h: number): boolean; setForeground(h: number): boolean; processName(h: number): string | null }`
  - `GAME_EXE = "EliteDangerous64.exe"`
  - `interface Foreground { hwnd: number; isGame: boolean; isOverlay: boolean }`
  - `class FocusManager { constructor(w: Win32, o: { overlayHwnd: () => number; onChange: (f: Foreground) => void; intervalMs?: number; sleep?: (ms: number) => Promise<void> }); poll(): void; start(): void; stop(): void; save(): void; restore(): Promise<boolean>; readonly current: Foreground }`
  - `loadWin32(): Win32` (in `src/main/win32.ts`)

- [ ] **Step 1: Write the failing test**

`test/focus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FocusManager, type Foreground, type Win32 } from "../src/core/focus.js";

function fakeWin32() {
  const w = {
    fg: 0,
    windows: new Set([10, 20, 99]),
    names: new Map([
      [10, "EliteDangerous64.exe"],
      [20, "notepad.exe"],
    ]),
    refuse: 0,
    calls: [] as number[],
  };
  const api: Win32 = {
    foreground: () => w.fg,
    isWindow: (h) => w.windows.has(h),
    setForeground: (h) => {
      w.calls.push(h);
      if (w.refuse > 0) {
        w.refuse--;
        return false;
      }
      w.fg = h;
      return true;
    },
    processName: (h) => w.names.get(h) ?? null,
  };
  return { w, api };
}

const setup = () => {
  const { w, api } = fakeWin32();
  const seen: Foreground[] = [];
  const f = new FocusManager(api, { overlayHwnd: () => 99, onChange: (x) => seen.push(x), sleep: async () => {} });
  return { w, f, seen };
};

describe("FocusManager", () => {
  it("reports foreground changes once each", () => {
    const { w, f, seen } = setup();
    w.fg = 10;
    f.poll();
    f.poll();
    w.fg = 99;
    f.poll();
    w.fg = 20;
    f.poll();
    expect(seen).toEqual([
      { hwnd: 10, isGame: true, isOverlay: false },
      { hwnd: 99, isGame: false, isOverlay: true },
      { hwnd: 20, isGame: false, isOverlay: false },
    ]);
  });

  it("restores the saved window", async () => {
    const { w, f } = setup();
    w.fg = 10;
    f.save();
    w.fg = 99;
    expect(await f.restore()).toBe(true);
    expect(w.fg).toBe(10);
  });

  it("does not save the overlay itself", async () => {
    const { w, f } = setup();
    w.fg = 99;
    f.save();
    expect(await f.restore()).toBe(true);
    expect(w.calls).toEqual([]);
  });

  it("retries once, then reports failure", async () => {
    const { w, f } = setup();
    w.fg = 10;
    f.save();
    w.refuse = 1;
    expect(await f.restore()).toBe(true);
    f.save();
    w.refuse = 2;
    expect(await f.restore()).toBe(false);
  });

  it("skips a window that has gone", async () => {
    const { w, f } = setup();
    w.fg = 20;
    f.save();
    w.windows.delete(20);
    expect(await f.restore()).toBe(true);
    expect(w.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `npx vitest run test/focus.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/core/focus.ts`**

```ts
export interface Win32 {
  foreground(): number;
  isWindow(h: number): boolean;
  setForeground(h: number): boolean;
  processName(h: number): string | null;
}

export const GAME_EXE = "EliteDangerous64.exe";

export interface Foreground {
  hwnd: number;
  isGame: boolean;
  isOverlay: boolean;
}

// Polling avoids passing a WinEvent callback through FFI; 250 ms is fast enough for hotkey scope and topmost.
export class FocusManager {
  private saved = 0;
  private lastHwnd = -1;
  private last: Foreground = { hwnd: 0, isGame: false, isOverlay: false };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly w: Win32,
    private readonly o: {
      overlayHwnd: () => number;
      onChange: (f: Foreground) => void;
      intervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  get current(): Foreground {
    return this.last;
  }

  poll(): void {
    const hwnd = this.w.foreground();
    if (hwnd === this.lastHwnd) return;
    this.lastHwnd = hwnd;
    const isOverlay = hwnd !== 0 && hwnd === this.o.overlayHwnd();
    const name = hwnd === 0 || isOverlay ? null : this.w.processName(hwnd);
    this.last = { hwnd, isOverlay, isGame: name?.toLowerCase() === GAME_EXE.toLowerCase() };
    this.o.onChange(this.last);
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.o.intervalMs ?? 250);
    this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  save(): void {
    const h = this.w.foreground();
    if (h !== this.o.overlayHwnd()) this.saved = h;
  }

  /** False only when Windows refused to give the saved window focus. */
  async restore(): Promise<boolean> {
    const h = this.saved;
    this.saved = 0;
    if (!h || !this.w.isWindow(h)) return true;
    if (this.w.setForeground(h)) return true;
    await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(100);
    return this.w.setForeground(h);
  }
}
```

- [ ] **Step 4: Write `src/main/win32.ts`**

```ts
import path from "node:path";
import koffi from "koffi";
import type { Win32 } from "../core/focus.js";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export function loadWin32(): Win32 {
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const GetForegroundWindow = user32.func("intptr_t __stdcall GetForegroundWindow()");
  const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(intptr_t hWnd)");
  const IsWindow = user32.func("int __stdcall IsWindow(intptr_t hWnd)");
  const GetWindowThreadProcessId = user32.func(
    "uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)",
  );
  const OpenProcess = kernel32.func(
    "intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  );
  const QueryFullProcessImageNameW = kernel32.func(
    "int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint8_t *name, _Inout_ uint32_t *size)",
  );
  const CloseHandle = kernel32.func("int __stdcall CloseHandle(intptr_t h)");

  return {
    foreground: () => Number(GetForegroundWindow()),
    isWindow: (h) => IsWindow(h) !== 0,
    setForeground: (h) => SetForegroundWindow(h) !== 0,
    processName(h) {
      const pid = [0];
      GetWindowThreadProcessId(h, pid);
      if (!pid[0]) return null;
      const proc = Number(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]));
      if (!proc) return null;
      try {
        const buf = Buffer.alloc(2048);
        const size = [1024];
        if (!QueryFullProcessImageNameW(proc, 0, buf, size)) return null;
        return path.win32.basename(buf.toString("utf16le", 0, size[0]! * 2));
      } finally {
        CloseHandle(proc);
      }
    },
  };
}
```

`src/main/win32.ts` has no unit test: it only runs on Windows. Task 13 checks it on the game PC.

- [ ] **Step 5: Run the checks and check that they pass**

Run: `npx prettier --write src test && npm run check`
Expected: typecheck clean (koffi ships its own types), all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/focus.ts src/main/win32.ts test/focus.test.ts
git commit -m "Track the foreground window and give focus back to the game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Electron window, preload, renderer and wiring

**Files:**
- Create: `electron.vite.config.ts`, `src/shared/ipc.ts`, `src/main/window.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/env.d.ts`, `src/renderer/style.css`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: a runnable app (`npm run dev`).
  - `IPC = { view: "overlay:view", send: "overlay:send", closeChat: "overlay:closeChat", copyChip: "overlay:copyChip", height: "overlay:height" }`
  - `interface OverlayApi { onView(cb: (v: ViewModel) => void): void; send(text: string): void; closeChat(): void; copyChip(n: number): void; reportHeight(h: number): void }`
  - `createOverlayWindow(preload: string, url: string | undefined, html: string): BrowserWindow`, `applyWindow(win: BrowserWindow, p: WindowProps, prev: WindowProps | null): void`

- [ ] **Step 1: Write `electron.vite.config.ts`**

```ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve("src/main/index.ts") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preload scripts must be CommonJS.
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
```

If the installed electron-vite no longer exports `externalizeDepsPlugin` (newer versions externalize dependencies by default), remove the import and both `plugins` entries.

- [ ] **Step 2: Write `src/shared/ipc.ts`**

```ts
import type { ViewModel } from "../core/view.js";

export const IPC = {
  view: "overlay:view",
  send: "overlay:send",
  closeChat: "overlay:closeChat",
  copyChip: "overlay:copyChip",
  height: "overlay:height",
} as const;

export interface OverlayApi {
  onView(cb: (v: ViewModel) => void): void;
  send(text: string): void;
  closeChat(): void;
  copyChip(n: number): void;
  reportHeight(h: number): void;
}
```

- [ ] **Step 3: Write `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { ViewModel } from "../core/view.js";
import { IPC, type OverlayApi } from "../shared/ipc.js";

const api: OverlayApi = {
  onView: (cb) => {
    ipcRenderer.on(IPC.view, (_e, v: ViewModel) => cb(v));
  },
  send: (text) => ipcRenderer.send(IPC.send, text),
  closeChat: () => ipcRenderer.send(IPC.closeChat),
  copyChip: (n) => ipcRenderer.send(IPC.copyChip, n),
  reportHeight: (h) => ipcRenderer.send(IPC.height, h),
};

contextBridge.exposeInMainWorld("overlay", api);
```

- [ ] **Step 4: Write `src/main/window.ts`**

```ts
import { BrowserWindow } from "electron";
import type { WindowProps } from "../core/controller.js";

export function createOverlayWindow(preload: string, url: string | undefined, html: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 48,
    show: false,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  if (url) void win.loadURL(url);
  else void win.loadFile(html);
  return win;
}

export function applyWindow(win: BrowserWindow, p: WindowProps, prev: WindowProps | null): void {
  if (prev && prev.show === p.show && prev.interactive === p.interactive) return;
  if (p.interactive) {
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    win.show();
    win.focus();
    return;
  }
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setFocusable(false);
  // showInactive: showing the card must never take focus from the game.
  if (p.show) win.showInactive();
  else win.hide();
}
```

- [ ] **Step 5: Write `src/main/index.ts`**

```ts
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { watchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, clipboard, globalShortcut, ipcMain, screen, type BrowserWindow } from "electron";
import { chooseDisplay, place, step } from "../core/anchor.js";
import { ApprovalServer } from "../core/approvalServer.js";
import {
  TESTED_CLI_VERSION,
  buildClaudeArgs,
  edMcpState,
  isOlder,
  parseCliVersion,
  quoteForCmd,
  resolveClaude,
} from "../core/claudeCommand.js";
import { ClaudeSession, type BackendEvent } from "../core/claudeSession.js";
import {
  INITIAL_STATE,
  canOpenChat,
  currentChips,
  reduce,
  windowProps,
  type Action,
  type OverlayState,
  type WindowProps,
} from "../core/controller.js";
import { FocusManager, type Foreground } from "../core/focus.js";
import { HotkeyManager, bindings, type HotkeyAction } from "../core/hotkeys.js";
import { Logger } from "../core/logger.js";
import type { Position, Settings } from "../core/settings.js";
import { StatusWatcher, fullscreenMode } from "../core/status.js";
import {
  HistoryStore,
  SettingsStore,
  StateStore,
  effectivePosition,
  savePosition,
  type SavedState,
} from "../core/stores.js";
import { buildView } from "../core/view.js";
import { IPC } from "../shared/ipc.js";
import { loadWin32 } from "./win32.js";
import { applyWindow, createOverlayWindow } from "./window.js";

const dataDir = path.join(app.getPath("appData"), "ed-overlay");
app.setPath("userData", dataDir);

const ED_MCP_MISSING = "⚠ ed-mcp not connected. Run: claude mcp add ed-mcp -s user -- npx -y ed-mcp";
const ED_MCP_FAILED = "⚠ ed-mcp failed to start; run claude mcp list";
const FULLSCREEN = "⚠ Elite is in fullscreen; switch to Borderless to see the overlay";
const NO_CLAUDE = "⚠ claude not found: install Claude Code or set claude.path";
const REFOCUS = "⚠ click the game to refocus";
const IN_DANGER = "⛔ in danger: chat blocked";
const NO_AUTO = "⚠ auto mode unavailable, using manual approvals";

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(main);

async function main(): Promise<void> {
  const log = new Logger(path.join(dataDir, "logs", "overlay.log"));
  const settingsStore = new SettingsStore(path.join(dataDir, "settings.json"));
  const stateStore = new StateStore(path.join(dataDir, "state.json"));
  const history = new HistoryStore(path.join(dataDir, "history"));
  history.newSession();

  let state: OverlayState = INITIAL_STATE;
  let prevProps: WindowProps | null = null;
  let contentHeight = 48;
  let fadeTimer: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  const first = await settingsStore.load();
  let settings: Settings = settingsStore.settings;
  let saved: SavedState = await stateStore.read();
  let position: Position;
  ({ position, saved } = effectivePosition(settings.position, saved));

  const win: BrowserWindow = createOverlayWindow(
    path.join(import.meta.dirname, "../preload/index.cjs"),
    process.env.ELECTRON_RENDERER_URL,
    path.join(import.meta.dirname, "../renderer/index.html"),
  );

  const viewSettings = (): Settings => ({ ...settings, position });

  function render(): void {
    const props = windowProps(state);
    applyWindow(win, props, prevProps);
    prevProps = props;
    win.webContents.send(IPC.view, buildView(state, viewSettings()));
  }

  function dispatch(a: Action): void {
    state = reduce(state, a);
    render();
  }

  function flash(key: string, text: string, ms = 4_000): void {
    clearTimeout(timers.get(key));
    dispatch({ type: "notice", key, text });
    timers.set(key, setTimeout(() => dispatch({ type: "notice", key, text: null }), ms));
  }

  function reposition(): void {
    const display = chooseDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay(), position.display);
    const width = Math.round(settings.card.width * (settings.style.fontSize / 14));
    const size = { width, height: Math.max(24, Math.ceil(contentHeight)) };
    const { x, y } = place(position.anchor, position.offsetX, position.offsetY, display.workArea, size);
    win.setBounds({ x, y, ...size });
  }

  async function movePosition(next: Position): Promise<void> {
    position = next;
    saved = savePosition(settings.position, saved, position);
    await stateStore.write(saved);
    reposition();
    render();
  }

  // Focus and topmost.
  const win32 = process.platform === "win32" ? loadWin32() : null;
  const overlayHwnd = () => {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE()) : b.readUInt32LE();
  };
  const hotkeys = new HotkeyManager(
    {
      register: (acc, cb) => globalShortcut.register(acc, cb),
      unregister: (acc) => globalShortcut.unregister(acc),
    },
    (a) => void runHotkey(a),
  );
  const reportHotkeys = (failed: string[]) =>
    dispatch({
      type: "notice",
      key: "hotkeys",
      text: failed.length ? `⚠ hotkeys not registered: ${failed.join(", ")}` : null,
    });

  function onForeground(f: Foreground): void {
    // Some games make their own borderless window topmost; the last activated topmost window wins.
    if (f.isGame) {
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
    }
    const want = settings.hotkeys.scope === "always" || f.isGame || f.isOverlay;
    if (want && !hotkeys.active) reportHotkeys(hotkeys.activate());
    if (!want && hotkeys.active) hotkeys.deactivate();
  }
  const focus = win32 ? new FocusManager(win32, { overlayHwnd, onChange: onForeground }) : null;

  async function giveFocusBack(): Promise<void> {
    if (focus && !(await focus.restore())) {
      log.log("warn", "focus restore refused");
      flash("focus", REFOCUS, 5_000);
    }
  }

  // Claude.
  const approval = new ApprovalServer({
    timeoutMs: settings.approval.timeoutSeconds * 1000,
    onRequest: (request) => dispatch({ type: "approval", request }),
    onSettled: (id) => dispatch({ type: "approvalSettled", id }),
  });
  await approval.start();
  const mcpConfigFile = path.join(dataDir, "approval-mcp.json");
  await writeFile(mcpConfigFile, JSON.stringify(approval.mcpConfig()));
  const workspace = path.join(dataDir, "workspace");
  await mkdir(workspace, { recursive: true });

  const claudeCommand = (s: Settings) => {
    const resolved = resolveClaude(s.claude.path);
    if (!resolved) return null;
    const args = buildClaudeArgs({
      permissionMode: s.claude.permissionMode,
      mcpConfigFile,
      extraArgs: s.claude.extraArgs,
    });
    return { ...resolved, args };
  };

  let session: ClaudeSession | null = null;
  const cmd = claudeCommand(settings);
  if (!cmd) dispatch({ type: "notice", key: "claude", text: NO_CLAUDE });
  else {
    session = new ClaudeSession({ command: cmd.command, args: cmd.args, shell: cmd.shell, cwd: workspace });
    session.onEvent(onBackend);
    session.start();
    checkVersion(cmd.command, cmd.shell);
  }

  function onBackend(e: BackendEvent): void {
    dispatch({ type: "backend", event: e });
    switch (e.type) {
      case "ready":
        {
          const ed = edMcpState(e.mcpServers);
          dispatch({
            type: "notice",
            key: "edmcp",
            text: ed === "missing" ? ED_MCP_MISSING : ed === "failed" ? ED_MCP_FAILED : null,
          });
        }
        dispatch({
          type: "notice",
          key: "mode",
          text:
            settings.claude.permissionMode === "auto" && e.permissionMode && e.permissionMode !== "auto"
              ? NO_AUTO
              : null,
        });
        break;
      case "result":
        void history.append({ role: "assistant", text: state.reply });
        clearTimeout(fadeTimer);
        fadeTimer = setTimeout(() => dispatch({ type: "cardTimeout" }), settings.card.fadeSeconds * 1000);
        break;
      case "exit":
      case "gaveUp":
        log.log("warn", `claude ${e.type}: ${e.stderrTail.join(" | ")}`);
        break;
      case "spawnError":
        log.log("warn", `claude spawn error: ${e.message}`);
        break;
      case "unknown":
        log.log("debug", `unknown stream-json: ${JSON.stringify(e.raw).slice(0, 200)}`);
        break;
    }
  }

  function checkVersion(command: string, shell: boolean): void {
    const file = shell ? quoteForCmd(command) : command;
    execFile(file, ["--version"], { shell, windowsHide: true }, (err, stdout) => {
      const v = err ? null : parseCliVersion(stdout);
      const tested = parseCliVersion(TESTED_CLI_VERSION)!;
      if (v && isOlder(v, tested)) {
        dispatch({
          type: "notice",
          key: "version",
          text: `⚠ claude ${v.join(".")} is older than ${TESTED_CLI_VERSION}; update Claude Code`,
        });
      }
    });
  }

  async function send(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    if (t === "/new") {
      session?.newSession();
      history.newSession();
      await giveFocusBack();
      dispatch({ type: "newSession" });
      dispatch({ type: "closeChat" });
      return;
    }
    if (!session) {
      dispatch({ type: "notice", key: "claude", text: NO_CLAUDE });
      return;
    }
    if (!session.send(t)) return;
    clearTimeout(fadeTimer);
    void history.append({ role: "user", text: t });
    // Give focus back before the window stops being focusable, while the overlay still holds the foreground.
    await giveFocusBack();
    dispatch({ type: "sent", text: t });
  }

  function copyChip(n: number): void {
    const chip = currentChips(state)[n - 1];
    if (!chip) return;
    clipboard.writeText(chip.text);
    flash("copy", `📋 copied ${chip.text}`, 2_000);
  }

  async function runHotkey(a: HotkeyAction): Promise<void> {
    switch (a.type) {
      case "openChat":
        if (!canOpenChat(state, settings.safety.blockWhenInDanger)) return flash("chat", IN_DANGER);
        focus?.save();
        return dispatch({ type: "openChat" });
      case "toggleOverlay":
        return dispatch({ type: "toggleVisible" });
      case "showHistory":
        return dispatch({ type: "toggleHistory" });
      case "approve":
      case "deny":
        if (state.approval) approval.answer(state.approval.id, a.type === "approve" ? "allow" : "deny");
        return;
      case "cancel":
        if (!session?.busy) return;
        session.cancel();
        return dispatch({ type: "cancelled" });
      case "copyChip":
        return copyChip(a.n);
      case "move":
        return movePosition({ ...position, anchor: step(position.anchor, a.dir) });
      case "nextDisplay": {
        const all = screen.getAllDisplays();
        const now = position.display === "primary" ? all.findIndex((d) => d.id === screen.getPrimaryDisplay().id) : position.display;
        return movePosition({ ...position, display: (Math.max(0, now) + 1) % all.length });
      }
    }
  }

  // Renderer IPC.
  ipcMain.on(IPC.send, (_e, text: string) => void send(text));
  ipcMain.on(IPC.closeChat, () => {
    void giveFocusBack().then(() => dispatch({ type: "closeChat" }));
  });
  ipcMain.on(IPC.copyChip, (_e, n: number) => copyChip(n));
  ipcMain.on(IPC.height, (_e, h: number) => {
    contentHeight = h;
    reposition();
  });
  win.webContents.on("did-finish-load", render);

  // Game files.
  const journalDir = (s: Settings) =>
    s.journalDir ?? path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous");
  let status = new StatusWatcher(path.join(journalDir(settings), "Status.json"), (flags) =>
    dispatch({ type: "flags", flags }),
  );
  status.start();

  const displayXml = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "Frontier Developments",
    "Elite Dangerous",
    "Options",
    "Graphics",
    "DisplaySettings.xml",
  );
  const checkFullscreen = async () => {
    const xml = await readFile(displayXml, "utf8").catch(() => "");
    dispatch({ type: "notice", key: "fullscreen", text: fullscreenMode(xml) === "fullscreen" ? FULLSCREEN : null });
  };
  void checkFullscreen();
  watchFile(displayXml, { interval: 5_000 }, () => void checkFullscreen());

  // Settings, live.
  function applySettings(): void {
    reportHotkeys(hotkeys.setBindings(bindings(settings.hotkeys)));
    if (settings.hotkeys.scope === "always" && !hotkeys.active) reportHotkeys(hotkeys.activate());
    approval.setTimeoutMs(settings.approval.timeoutSeconds * 1000);
    reposition();
    render();
  }
  if (first.error) dispatch({ type: "notice", key: "settings", text: first.error });
  applySettings();
  settingsStore.watch((r) => {
    dispatch({ type: "notice", key: "settings", text: r.error });
    if (!r.changed) return;
    const old = settings;
    settings = settingsStore.settings;
    ({ position, saved } = effectivePosition(settings.position, saved));
    void stateStore.write(saved);
    if (JSON.stringify(old.claude) !== JSON.stringify(settings.claude)) {
      const c = claudeCommand(settings);
      if (c && session) session.configure(c);
      flash("claudeSettings", "claude settings apply after /new", 6_000);
    }
    if (journalDir(old) !== journalDir(settings)) {
      status.stop();
      status = new StatusWatcher(path.join(journalDir(settings), "Status.json"), (flags) =>
        dispatch({ type: "flags", flags }),
      );
      status.start();
    }
    applySettings();
  });

  screen.on("display-removed", reposition);
  screen.on("display-metrics-changed", reposition);
  app.on("second-instance", () => {
    if (!state.visible) dispatch({ type: "toggleVisible" });
  });
  focus?.start();
  render();
  log.log("info", `started; claude ${cmd ? cmd.command : "not found"}`);

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    focus?.stop();
    status.stop();
    settingsStore.unwatch();
    session?.stop();
    void approval.stop();
  });
}
```

Notes for the implementer:
- On macOS and Linux, `win32` is `null`. Focus restore and the game check are skipped, so `hotkeys.scope` `game` never activates the hotkeys there. To try the app on a Mac during development, set `"scope": "always"` in `settings.json`.
- `currentChips` uses the streaming reply while Claude is thinking, so a chip can be copied before the reply ends.

- [ ] **Step 6: Write the renderer**

`src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/renderer/env.d.ts`:

```ts
import type { OverlayApi } from "../shared/ipc.js";

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}
```

`src/renderer/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<App />);
```

`src/renderer/App.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Chip } from "../core/chips.js";
import type { ViewModel } from "../core/view.js";

function Chips({ chips, keyLabel }: { chips: Chip[]; keyLabel: string }) {
  if (!chips.length) return null;
  return (
    <div className="chips" title={`${keyLabel} copies chip n`}>
      {chips.map((c) => (
        <button key={c.n} className="chip" onClick={() => window.overlay.copyChip(c.n)}>
          {c.n} 📋 {c.text}
        </button>
      ))}
    </div>
  );
}

function ChatInput({ moving }: { moving: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setText("");
      window.overlay.closeChat();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.overlay.send(text);
      setText("");
    }
  };
  return (
    <div className="input">
      {moving && <div className="warn">⚠ ship is moving</div>}
      <textarea ref={ref} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
    </div>
  );
}

export function App() {
  const [v, setV] = useState<ViewModel | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => window.overlay.onView(setV), []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => window.overlay.reportHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [v === null]);

  if (!v) return null;
  const style = {
    "--font": `${v.ui.fontSize}px`,
    "--max-lines": v.ui.maxLines,
    "--chat-lines": v.ui.chatLines,
    flexDirection: v.ui.growsUp ? "column-reverse" : "column",
  } as CSSProperties;

  return (
    <div ref={root} className="overlay" style={style}>
      <div className="strip">
        <div className="status">
          <span>{v.status}</span>
          {v.notice && <span className="notice">{v.notice}</span>}
        </div>
        {v.mode === "strip" && v.pinned && <div className="pinned">▸ {v.pinned}</div>}
        {v.mode === "strip" && <Chips chips={v.chips} keyLabel={v.ui.copyChipKey} />}
      </div>
      {v.approval && (
        <div className="approval">
          <div>
            Claude wants to run <b>{v.approval.toolName}</b>
          </div>
          <div className="summary">{v.approval.summary}</div>
          <div className="keys">
            {v.approval.approveKey} allow · {v.approval.denyKey} deny
          </div>
        </div>
      )}
      {v.card && (
        <div className="card">
          <div className="text">{v.card.text}</div>
          <Chips chips={v.card.chips} keyLabel={v.ui.copyChipKey} />
        </div>
      )}
      {v.chat && (
        <div className="chat">
          <div className="history">
            {v.chat.history.map((t, i) => (
              <div key={i} className={t.role}>
                {t.text}
              </div>
            ))}
            {v.chat.streaming !== null && <div className="assistant">{v.chat.streaming}</div>}
          </div>
          <Chips chips={v.chips} keyLabel={v.ui.copyChipKey} />
          {v.chat.input && <ChatInput moving={v.chat.moving} />}
        </div>
      )}
    </div>
  );
}
```

`src/renderer/style.css`:

```css
html,
body {
  margin: 0;
  background: transparent;
  overflow: hidden;
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: var(--font, 14px);
  color: #f2e6d0;
  user-select: none;
}
.overlay {
  display: flex;
  gap: 4px;
  font-size: var(--font, 14px);
  line-height: 1.43;
}
.strip,
.card,
.chat,
.approval {
  background: rgba(10, 12, 16, 0.78);
  border: 1px solid rgba(255, 140, 0, 0.45);
  border-radius: 4px;
  padding: 4px 8px;
}
.status {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  white-space: nowrap;
}
.notice {
  color: #ffb347;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pinned {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card .text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--max-lines, 4);
  overflow: hidden;
  white-space: pre-wrap;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.chip {
  font: inherit;
  color: inherit;
  background: rgba(255, 140, 0, 0.18);
  border: 1px solid rgba(255, 140, 0, 0.5);
  border-radius: 3px;
  padding: 0 6px;
  cursor: pointer;
}
.chat .history {
  max-height: calc(var(--chat-lines, 14) * 1.43em);
  overflow-y: auto;
  white-space: pre-wrap;
}
.chat .user {
  color: #9fd3ff;
}
.input textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  color: inherit;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 140, 0, 0.5);
  resize: none;
}
.warn,
.approval .keys {
  color: #ffb347;
}
.approval .summary {
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 7: Typecheck, test and build**

Run: `npx prettier --write . && npm run check && npm run build`
Expected: typecheck clean, all tests pass, and `out/main/index.js`, `out/preload/index.cjs` and `out/renderer/index.html` exist.

If the typecheck reports `import.meta.dirname` as unknown in `src/main/index.ts`, check that `@types/node` is 22 or later.

- [ ] **Step 8: Smoke test on the development machine**

Write `{"hotkeys":{"scope":"always"},"journalDir":"/Users/<you>/EliteDangerous"}` to the settings file (use the real home folder). It is in `~/Library/Application Support/ed-overlay/settings.json` on macOS, or `%APPDATA%\ed-overlay\settings.json` on Windows. Then run `npm run dev`.

Expected:
- A strip appears at the top right with `● starting`, and then `● idle`.
- Ctrl+Shift+Space opens the chat.
- `where is Shinrarta Dezhra? one line` and Enter shows a card that streams the reply, with at least one chip.
- Ctrl+Shift+1 copies the chip. Check with `pbpaste` or by pasting.
- Ctrl+Alt+Left moves the overlay to the top center.
- `/new` clears the reply.

Quit the app with Ctrl+C in the terminal.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Wire the overlay window, renderer and Claude session together

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Packaging, release and documentation

**Files:**
- Create: `electron-builder.yml`, `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`, `README.md`, `docs/manual-checklist.md`
- Modify: `.github/workflows/ci.yml` (add the packaged build)

**Interfaces:**
- Consumes: the built app from Task 11.
- Produces: `npm run dist` makes `dist/ED Overlay Setup <version>.exe`.

- [ ] **Step 1: Write `electron-builder.yml`**

```yaml
appId: com.pilotso11.ed-overlay
productName: ED Overlay
directories:
  output: dist
files:
  - out/**
  - package.json
asarUnpack:
  - node_modules/koffi/**
win:
  target: nsis
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
publish:
  provider: github
  owner: pilotso11
  repo: ed-overlay
```

- [ ] **Step 2: Add the packaged build to CI**

Append to the `check` job steps in `.github/workflows/ci.yml`:

```yaml
      - run: npm run dist
      - uses: actions/upload-artifact@v4
        with:
          name: ed-overlay-installer
          path: dist/*.exe
```

- [ ] **Step 3: Write the release workflow and release-please config**

`release-please-config.json`:

```json
{ "packages": { ".": { "release-type": "node" } } }
```

`.release-please-manifest.json`:

```json
{ ".": "0.0.0" }
```

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      created: ${{ steps.rp.outputs.release_created }}
      tag: ${{ steps.rp.outputs.tag_name }}
    steps:
      - id: rp
        uses: googleapis/release-please-action@v4

  installer:
    needs: release-please
    if: needs.release-please.outputs.created == 'true'
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx electron-builder --win --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Write `README.md`**

````markdown
# ED Overlay

A small Claude chat window on top of Elite Dangerous. Press a hotkey, ask a
question, press Enter, and keep flying. The reply shows in a corner of the
screen. Star system and station names in the reply become numbered chips;
Ctrl+Shift+1…9 copies one, ready to paste into the galaxy map search.

Windows 10 and 11 only.

## Requirements

- Elite Dangerous in **Borderless** or **Windowed** mode (Options → Graphics →
  Display). The overlay cannot show over exclusive fullscreen.
- [Claude Code](https://claude.com/claude-code), installed and logged in. The
  overlay starts your own `claude` command and uses your login and settings.
- Recommended: [ed-mcp](https://github.com/pilotso11/ed-mcp) for game tools.
  Add it for your user, not one project:

  ```
  claude mcp add ed-mcp -s user -- npx -y ed-mcp
  ```

## Install

Download `ED Overlay Setup <version>.exe` from Releases and run it. The
installer is not code signed yet, so Windows SmartScreen warns on first run.
Select **More info → Run anyway**.

## Use

| Key | Action |
| --- | --- |
| Ctrl+Shift+Space | Open the chat. Enter sends and returns to the game. Esc closes. |
| Ctrl+Shift+1…9 | Copy chip 1…9 |
| Ctrl+Shift+Y / N | Allow / deny a tool that Claude asks to run |
| Ctrl+Shift+X | Stop the current reply |
| Ctrl+Shift+H | Show or hide the history |
| Ctrl+Shift+O | Hide or show the overlay |
| Ctrl+Alt+Arrows | Move the overlay around the screen edge |
| Ctrl+Alt+M | Move the overlay to the next monitor |

Type `/new` in the chat to start a new conversation.

Hotkeys work only while the game or the overlay is in front, so they do not
take keys from other apps. While the ship is in danger, the chat does not open.

## Permissions

The overlay runs Claude in auto mode: a classifier approves low-risk actions
and blocks risky ones. When Claude asks, the overlay shows the request; answer
with Ctrl+Shift+Y or Ctrl+Shift+N. To never be asked about ed-mcp tools, add
`"mcp__ed-mcp__*"` to `permissions.allow` in `~/.claude/settings.json`.

## Settings

`%APPDATA%\ed-overlay\settings.json` is written with the defaults on first run.
Changes apply when you save the file. The file is plain JSON. Settings for
`claude` apply after `/new`.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkeys.*` | see above | Electron accelerator strings; `copyChip` must contain `{n}` |
| `hotkeys.scope` | `game` | `game`: only while the game or overlay is in front. `always`: everywhere |
| `strip.lines` | `2` | `1`: status only. `2`: also the first line of the last reply |
| `strip.keepChips` | `true` | Keep the last reply's chips under the status line |
| `card.maxLines` | `4` | Reply lines shown (2–8) |
| `card.fadeSeconds` | `20` | Seconds before the reply card closes |
| `card.width` | `420` | Width in pixels at font size 14 |
| `chat.lines` | `14` | History lines in the chat |
| `style.fontSize` | `14` | Font size; scales the window |
| `position.anchor` | `top-right` | `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `position.offsetX` / `offsetY` | `24` | Pixels from the screen edges |
| `position.display` | `primary` | `primary` or a monitor number (0, 1, …) |
| `safety.blockWhenInDanger` | `true` | Do not open the chat while in danger |
| `approval.timeoutSeconds` | `120` | Deny a request that gets no answer |
| `claude.path` | `null` | Path to `claude`; `null` searches `PATH` |
| `claude.permissionMode` | `auto` | `auto` or `default` (ask for everything not allowed) |
| `claude.extraArgs` | `[]` | More arguments for `claude` |
| `journalDir` | `null` | The game's journal folder; `null` uses Saved Games |

A position chosen with the hotkeys is saved in `state.json`, until you change
`position` in `settings.json`.

## Troubleshooting

The first line of the overlay shows problems. The log is
`%APPDATA%\ed-overlay\logs\overlay.log`. It never contains chat text.
````

- [ ] **Step 5: Write `docs/manual-checklist.md`**

```markdown
# Manual checklist

Run on a Windows PC with Elite Dangerous before each release. Write the result
next to each item.

## Phase 0, part B (first run only; copy results to the spec's "Phase 0 results")

1. Hotkeys: with the game in Borderless mode and in front, do Ctrl+Shift+Space,
   Ctrl+Shift+1 and Ctrl+Alt+Left reach the overlay?
2. Focus: after Enter, does the game have focus again (ship controls respond at
   once)?
3. `DisplaySettings.xml`: the `FullScreen` value for Windowed, Fullscreen and
   Borderless.
4. Topmost: does the overlay stay on top after Alt+Tab back into the game?
5. Frame time: run PresentMon for 60 s with the overlay shown and 60 s with it
   hidden (Ctrl+Shift+O). Write down the average and 99th percentile frame
   times.
6. Win32: the log shows no koffi errors, and the game is detected
   (`EliteDangerous64.exe`).

## Every release

- [ ] The overlay shows over the game in Borderless mode.
- [ ] The fullscreen warning shows in exclusive fullscreen.
- [ ] Hotkeys work while the game is in front, and not while another app is.
- [ ] Enter gives focus back to the game.
- [ ] A copied chip pastes into the galaxy map search with Ctrl+V.
- [ ] A tool request shows the approval card; Ctrl+Shift+Y and N work.
- [ ] The chat does not open while in danger.
- [ ] Position hotkeys work, including Ctrl+Alt+M with two monitors.
- [ ] A position chosen by hotkey survives a restart.
- [ ] `settings.json` edits apply without a restart; a broken edit shows a warning.
- [ ] The ed-mcp warning shows when ed-mcp is not added for the user.
```

- [ ] **Step 6: Build the installer**

Run: `npx prettier --write . && npm run check && npm run dist`
Expected: checks pass. On Windows, `dist/ED Overlay Setup 0.0.0.exe` exists. On macOS, electron-builder may need Wine for an NSIS build; if it fails there, rely on the CI artifact from Step 2.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Package the overlay as a Windows installer and document it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Verify on the game PC (phase 0, part B)

The owner does this task on the Windows PC with Elite Dangerous. For part B and fixes, clone the repository on the PC and run `npm ci && npm run dev` (Node 22 and git needed). For the release checklist, use the installer from Task 12's CI artifact.

**Files:**
- Modify: `docs/manual-checklist.md` (results), `docs/superpowers/specs/2026-10-23-overlay-chat-design.md` (Phase 0 results)
- Modify (only if a check fails): the file the failure points to, for example `src/core/status.ts` (`MODES`) or `src/main/win32.ts`

- [ ] **Step 1: Install and start the overlay with the game running in Borderless mode**

- [ ] **Step 2: Work through `docs/manual-checklist.md`**

Do "Phase 0, part B" first, then "Every release". Write each result in the file.

- [ ] **Step 3: Record phase 0 results in the spec**

Add each part B result to "Phase 0 results" in the spec.

- [ ] **Step 4: Fix what failed**

For each failed item, follow superpowers:systematic-debugging. Typical fixes:
- `FullScreen` values differ: change `MODES` in `src/core/status.ts` and the `fullscreenMode` test cases.
- The game takes a hotkey: change that default in `src/core/settings.ts` and in the README table.
- Focus restore fails: write down what the log shows before changing `FocusManager`.

Run `npm run check` after each fix.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Record game PC checks and fix what they found

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
