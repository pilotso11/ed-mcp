# Privacy

ed-mcp is a local program. It runs on your computer, inside Claude Desktop or Claude Code. The author runs no server, and ed-mcp sends nothing to the author.

## What ed-mcp reads

- The Elite Dangerous journal and the `Market.json`, `Outfitting.json` and `Shipyard.json` files that the game writes. ed-mcp only reads them. It never changes them.
- Its own files: plans, preferences, API keys and the Frontier login. See [Your data](README.md#your-data) for where they are.

## What ed-mcp sends, and to whom

ed-mcp talks only to these services, and only when a tool needs them:

| Service | What ed-mcp sends | Why |
| --- | --- | --- |
| Inara (inara.cz) | Your Inara API key and commander name | To read your Inara profile and community goals |
| EDSM (edsm.net) | Your EDSM API key and commander name | To read your location, materials and cargo |
| Frontier (auth.frontierstore.net, companion.orerve.net) | Your Frontier login | To read your commander, ship and fleet |
| Spansh (spansh.co.uk) | System and station names, and search settings such as cargo space | To search stations, markets and routes |
| GitHub (github.com, api.github.com, codeload.github.com, raw.githubusercontent.com) | Ordinary download requests | To download game data, and to check for a newer ed-mcp release |

Each API key goes only to the service that it belongs to. ed-mcp does not send your journal to any service. It uses journal values, such as your location or cargo space, as search settings.

ed-mcp has no analytics and no telemetry.

## Where your data is kept

- On your computer, in the ed-mcp settings and cache folders.
- If you set a sync folder, plans and preferences are also in that folder, and your sync service (for example Google Drive) stores them under its own privacy terms. API keys and the Frontier login go to the sync folder only when you also set a sync password. ed-mcp then encrypts them with that password.

To remove everything, delete the ed-mcp settings and cache folders (and the files in your sync folder, if you set one), and log out of Frontier with `capi_logout`.

## Contact

Report a privacy problem at <https://github.com/pilotso11/ed-mcp/issues>.
