# In-game overlay roadmap

Date: 2026-10-23
Status: approved in conversation

## Purpose

Players fly with Elite Dangerous full screen. To ask Claude a question or to
use a route that Claude planned, they must leave the game. An overlay on top of
the game gives them a small chat window, short replies, and system names that
they can paste into the galaxy map search with Ctrl+V.

## Roadmap

The work ships as separate sub-projects, each with its own spec, plan and PR.

| # | Sub-project | Where | Depends on |
|---|---|---|---|
| 1 | Live journal in ed-mcp: a watcher that tails the journal from an offset; reads `Status.json`, `NavRoute.json`, `ModulesInfo.json`, `ShipLocker.json`, `Backpack.json`, `FCMaterials.json`; new tools `journal_events`, `journal_changes_since` (cursor), `journal_navroute`, live status | ed-mcp | nothing |
| 2 | Route HUD: the overlay shows the active plan's stops, copies the next stop to the clipboard on arrival, and has previous/next/copy hotkeys. No Claude calls | overlay | 1 (shared watcher), 3 (app shell) |
| 3 | Chat overlay: hotkey chat, reply card, copy chips, approvals, Claude through the player's `claude` CLI. Spec: `2026-10-23-overlay-chat-design.md` | overlay | nothing |
| 4 | Proactive triggers: chosen journal events are sent into the Claude session, with debounce, cooldown and a toggle per trigger | overlay | 1, 3 |

Sub-project 3 is built first, at the owner's request.

## Decisions made while scoping

- Windows only. The overlay is a topmost transparent window. It needs the game
  in Borderless or Windowed mode. Exclusive fullscreen would need DLL
  injection into the game, which was rejected.
- The overlay is published for other players, not only for the owner.
- Electron and TypeScript, in a new repository (working name
  `pilotso11/ed-overlay`). Electron keeps the code in the same language as
  ed-mcp, so the route HUD can reuse its journal and plan code.
- Claude runs as the player's own installed and logged-in `claude` CLI. The
  overlay does not use the Agent SDK and does not ask for an API key.
- The overlay uses the player's full Claude Code configuration, not only
  ed-mcp.
- Keyboard hotkeys only in the first version. Voice and HOTAS buttons are
  later work.
- Clipboard writes need no focus. The common case ("Claude found a station,
  paste it into the galaxy map") never takes focus from the game.
- Route stepping (sub-project 2) is deterministic and does not call Claude.
  Claude creates and changes routes. The ed-mcp plan store is the shared state.

## Open risk

Anthropic's Agent SDK documentation says: "Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or
rate limits for their products, including agents built on the Claude Agent
SDK." The overlay does not use the SDK. It starts the CLI that the player
installed and logged in to. It is not known whether a published app that does
this is permitted. Public release waits until Anthropic confirms. The Claude
backend sits behind an interface, so an API-key backend can replace it.
