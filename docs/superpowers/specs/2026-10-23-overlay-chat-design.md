# Chat overlay

Date: 2026-10-23
Status: approved in conversation

Sub-project 3 of `docs/superpowers/specs/2026-10-23-overlay-roadmap-design.md`.
The code goes in a new repository (working name `pilotso11/ed-overlay`). This
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
  prompts with an approval card and hotkeys.
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
| HotkeyManager | Registers the hotkeys from settings with `globalShortcut`. Registers them only while the game or the overlay is in front, unless `hotkeys.scope` is `always`. |
| FocusManager | Polls the foreground window every 250 ms. Saves the game window before chat opens and restores it after. Puts the overlay back on top when the game comes to the front. Uses `koffi` for Win32 calls. |
| ClaudeSession | Owns the CLI child process. Turns stream-json into internal events. The only code that knows the CLI's output format. |
| ApprovalServer | The overlay's own MCP server with one tool, `approve`. The CLI calls it for permission prompts. |
| StatusWatcher | Reads `Status.json` in the journal folder for the docked and in-danger flags. |
| SettingsStore | Reads, checks and reloads `settings.json`. |
| StateStore | Keeps state that the app writes, such as the position chosen by hotkey. |
| HistoryStore | Keeps chat transcripts for the history view. |

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
| `card` | yes | no | The strip plus the latest reply, up to `card.maxLines` lines, with "⤢ more" when cut |
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

The app does not write `settings.json`. A position chosen by hotkey is saved in
`state.json`. Order of precedence: a changed `position` in `settings.json`,
then `state.json`, then the defaults. When `settings.json` changes `position`,
the saved position in `state.json` is removed.

## Settings

File: `%APPDATA%\ed-overlay\settings.json`. Written with the defaults on first
run. Reloaded when it changes. The file is plain JSON; the comments below only
explain the keys. Hotkeys use Electron accelerator syntax.

```jsonc
{
  "hotkeys": {
    "scope": "game",              // "game": only while the game or overlay is in front; "always"
    "openChat": "Ctrl+Shift+Space",
    "toggleOverlay": "Ctrl+Shift+O",
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
  "strip": { "lines": 2, "keepChips": true },
  "card": { "maxLines": 4, "fadeSeconds": 20, "width": 420 },
  "chat": { "lines": 14 },
  "style": { "fontSize": 14 },
  "position": { "anchor": "top-right", "offsetX": 24, "offsetY": 24, "display": "primary" },
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
       --permission-prompt-tool mcp__ed_overlay__approve
       [--resume <session_id>] <claude.extraArgs>
```

- Working folder: `%APPDATA%\ed-overlay\workspace`. The player's user-level
  configuration (`~/.claude`, user-scope MCP servers, plugins) applies. No
  project's `.claude/` folder applies.
- The CLI starts when the app starts, so the first message is fast and the
  MCP server list is known early.
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

The `init` event lists the configured MCP servers. They are still starting
(`pending`) at that point and their tools are not listed yet, so the check
uses server names: `ed-mcp`, or `plugin:<plugin>:ed-mcp` for the Claude
plugin. A server with status `failed` shows "⚠ ed-mcp failed to start; run
claude mcp list". When there is no such server, the status line shows: "⚠ ed-mcp not connected. Run:
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
files. Logs contain CLI stderr, unknown events and focus failures. Chat text is
not logged.

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
release-please manages versions, as in ed-mcp. The first version is not code
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
