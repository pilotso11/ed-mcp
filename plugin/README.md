# ed-mcp: Elite Dangerous Companion

ed-mcp connects Claude to Elite Dangerous. Claude can then read your commander data and plan with you:

- plan a ship build: the modules to buy, the engineering, the materials and the engineers to visit, and the route to all of them,
- work out which materials you are short of and the trades that cover them,
- find the best station for a module, ship or service, ranked by travel time and price,
- plan trade runs and loops, and find where to sell or buy a commodity,
- put the stops for your accepted missions in the best order,
- read your game journal for your location, ship, cargo, materials, missions and engineer progress.

ed-mcp is not affiliated with Frontier Developments, Inara, EDSM or Spansh.

## What this plugin runs

The plugin starts one local MCP server on your computer: `npx -y ed-mcp@<version>`, the ed-mcp package from npm, pinned to the plugin's version. The package has no dependencies; all its code is in one file. Each release is built by GitHub Actions with signed provenance. The source is at <https://github.com/pilotso11/ed-mcp>.

The server works in Claude Code, and in Cowork when the session runs on your computer. It needs Node.js 22 or later. It does not run in claude.ai chat, because chat cannot start local programs. For Claude Desktop chat, install the `.mcpb` file from the [Releases](https://github.com/pilotso11/ed-mcp/releases) page instead.

## Settings

All settings are optional:

- **Journal folder**: the Elite Dangerous journal folder. On the gaming PC, leave it empty.
- **Sync folder**: a folder that a sync app keeps in step, so your plans and preferences follow you between computers.
- **Sync password**: encrypts your API keys and Frontier login, at least 12 characters.

To add Inara or EDSM API keys, ask Claude to "open ed-mcp settings". You enter the keys on a page in your browser, never in the chat.

## What it reads and sends

ed-mcp reads your game journal and its own files on your computer. It contacts only Inara, EDSM, Frontier, Spansh and GitHub, and only when a tool needs them. Each API key goes only to its own service. There is no analytics and no telemetry. [PRIVACY.md](https://github.com/pilotso11/ed-mcp/blob/main/PRIVACY.md) lists exactly what goes where.

## More information

- [Full README](https://github.com/pilotso11/ed-mcp#readme): setup, the game journal on a Mac, and preferences.
- [Tool reference](https://github.com/pilotso11/ed-mcp/blob/main/docs/tools.md): every tool, its inputs and its results.
- License: MIT.
