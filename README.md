# ed-mcp

ed-mcp connects Claude to Elite Dangerous. Claude can then read your commander data and plan with you.

With ed-mcp, Claude can:

- plan a ship build: the modules to buy, the engineering, the materials and the engineers to visit,
- work out which materials you are short of and the trades that cover them,
- find the best station for a module, ship or service, ranked by travel time and price,
- plan trade runs and find where to sell or buy a commodity,
- put the stops for your accepted missions in the best order,
- read your game journal for your location, ship, cargo, materials, missions and engineer progress.

### Why use it

Inara, EDSM, Spansh, EDSY and the community wikis already have this data, and you can do all of this on their sites. ed-mcp does not replace them. It lets Claude use them together, with your game journal, in one conversation. Some commanders find it easier to ask a question in their own words than to use several sites.

ed-mcp runs on your computer. It keeps your plans and settings on your computer. It reads from Inara, EDSM, Frontier and Spansh, and it downloads game data from GitHub.

ed-mcp is not affiliated with Frontier Developments, Inara, EDSM or Spansh.

## What you can ask

- "Here is my build from EDSY. Make a plan for the modules I need to buy or engineer. Tell me the materials I am short of and where to trade for them."
- "Where is the nearest Guardian technology broker?"
- "What do I need for grade 5 dirty drives?"
- "Find me a trade route from here. I have 400 t of cargo."
- "Where can I sell 200 t of gold near Atlas?"
- "Plan the best order for my passenger missions."
- "From now on, ignore stations more than 2,000 ls from the star."

## Install

### Claude Desktop

1. Download `ed-mcp-<version>.mcpb` from the [Releases](https://github.com/pilotso11/ed-mcp/releases) page.
2. Open the file. Claude Desktop shows the ed-mcp settings form.
3. Fill in the fields for the services that you use (see [Connect your accounts](#connect-your-accounts)). All fields are optional.

To make sure that the file came from this project, run the GitHub CLI command below. It shows that the ed-mcp release workflow built the file from this repository. This command works for version 0.1.1 and later.

```bash
gh attestation verify ed-mcp-<version>.mcpb --repo pilotso11/ed-mcp
```

### Claude Code

Run this command. Put your own values in place of `<...>`:

```bash
claude mcp add ed-mcp -s user \
  -e INARA_API_KEY=<key> -e INARA_CMDR=<commander name> \
  -e EDSM_API_KEY=<key> -e EDSM_CMDR=<commander name> \
  -- npx -y ed-mcp
```

- Keep `ed-mcp` directly after `add`. The `-e` options take every word after them until the `--`.
- Leave out the `-e` options for a service that you do not use.
- On a Mac, also add `-e ED_JOURNAL_DIR=<folder>` (see [Your game journal](#your-game-journal)).

Then start a new Claude Code session. To make sure that the server works, ask Claude "What is my journal status?".

## Connect your accounts

Every account is optional. Without one, the tools for that service tell Claude which setting is missing. The game data, station search, route and plan tools work with no account.

| Service  | What it gives Claude                                     | What you need                                                        |
| -------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Journal  | Location, ship, cargo, materials, missions, engineers    | The game journal folder (see below)                                  |
| Inara    | Ranks, squadron, main ship, community goals              | Your API key (inara.cz, Settings, Inara API) and commander name      |
| EDSM     | Last known location, materials and cargo                 | Your API key (edsm.net, Settings, API Key) and commander name        |
| Frontier | Current ship with engineering, location and fleet        | A Frontier login in your browser. No key is necessary.               |

To log in to Frontier, ask Claude "Log me in to Frontier". Claude gives you a link. Open the link and sign in. Then tell Claude that you are done. The login lasts 25 days. If you log in to ed-mcp on another computer, the old login ends.

The game journal is the best source for most questions. It is on your computer and it is current while you play. Inara and EDSM show data from your last sync to them.

### All settings

| Setting          | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `INARA_API_KEY`  | Your Inara API key                                                                                        |
| `INARA_CMDR`     | Your in-game commander name                                                                               |
| `EDSM_API_KEY`   | Your EDSM API key                                                                                         |
| `EDSM_CMDR`      | Your commander name on EDSM                                                                               |
| `ED_JOURNAL_DIR` | The game journal folder. On Windows, the default is the game's folder. Use a full path or one that starts with `~`. |
| `ED_MCP_PLANS`   | A different file for your plans. Use a full path or one that starts with `~`. The default is `plans.json` in the settings folder (see [Your data](#your-data)). |

Inara needs both of its settings. EDSM needs both of its settings.

## Your game journal

Elite Dangerous writes a journal while you play. ed-mcp reads it and never changes it.

**If Claude runs on your gaming PC**, ed-mcp finds the journal by itself. The folder is `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`. If Windows moved your Saved Games folder (for example, into OneDrive), set `ED_JOURNAL_DIR` to the real folder.

**If Claude runs on a Mac**, copy the journal to the Mac with Syncthing:

1. Install Syncthing on the PC and on the Mac (syncthing.net).
2. On the PC, add the folder `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`. Set the folder type to **Send Only**.
3. Pair the two devices. Share the folder with the Mac.
4. On the Mac, accept the folder into a local folder, for example `~/EliteDangerous`. Set the folder type to **Receive Only**.
5. Set `ED_JOURNAL_DIR` to that folder. In Claude Desktop, use the Journal folder field.
6. Ask Claude "What is my journal status?". While you play, the newest journal is a few minutes old.

Do not share `%LOCALAPPDATA%\Frontier Developments\Elite Dangerous`. That folder has the same name, but it holds only the game's settings. If you share it by mistake, the journal status tells you.

The journal tools warn you when the newest entry is more than 30 minutes old. Then the game is not running, or Syncthing has stopped.

## Plans

Claude can save plans for you, for example a ship build with its modules, engineering and materials. Ask Claude to add items, mark them done, or export the plan as a Markdown file. The plans stay on your computer, in `plans.json` in the settings folder (see [Your data](#your-data)). To keep them in another place, for example a folder that you back up, set `ED_MCP_PLANS`.

## Preferences

ed-mcp ranks stations by travel time and price. Your preferences control which stations it uses. To change a preference, tell Claude, for example "Avoid surface stations" or "My time is worth 50M credits an hour". The change stays for future sessions. For one question only, say so: "Just this once, include fleet carriers."

| Preference                       | Default                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| Distance from the star           | Up to 1,000 ls. A station further out is used only when no other matches. |
| Surface stations                 | Avoided. They are used only when no orbital station matches.               |
| Fleet carriers                   | Excluded                                                                   |
| Megaships                        | Allowed                                                                    |
| Landing pad size                 | Taken from your current ship                                               |
| Jump range                       | Taken from your current ship (85% of its best range)                      |
| Value of your time               | 20M credits an hour                                                        |

The value of your time decides between a cheap station far away and a dearer one nearby. At 20M credits an hour, one extra minute of travel is worth about 333,000 credits.

The travel times come from about 1,300 timed trips in a commander's journals, flown with supercruise assist. If you fly faster, tell Claude "I fly about 40% faster in supercruise". For all the details, see the [tool reference](docs/tools.md#travel-model).

## Limits

- Station, market and trade data come from Spansh. Market prices can be some hours or days old. The results show the age of each price. Spansh gets prices from EDDN, so a market that you open while you run a tool such as EDMC reaches Spansh within minutes.
- Trade routes and first-time mission routes can take a minute or more. If Spansh is still working, Claude asks again.
- Trade routes go one way. They do not plan a loop back to the start.
- ed-mcp cannot see the mission board. It plans routes only for missions that you accepted.
- Material plans ignore the storage limit for each material grade.

## Your data

ed-mcp keeps these files on your computer:

| Data                         | File                                         |
| ---------------------------- | -------------------------------------------- |
| Plans                        | `plans.json`, or the file in `ED_MCP_PLANS`  |
| Preferences                  | `preferences.json`                           |
| Frontier login               | `capi-token.json`, readable only by you      |
| Game data and cached results | The cache folder                             |

The files are in these folders:

| System  | Settings folder                | Cache folder                       |
| ------- | ------------------------------ | ---------------------------------- |
| macOS   | `~/Library/Preferences/ed-mcp` | `~/Library/Caches/ed-mcp`          |
| Windows | `%APPDATA%\ed-mcp\Config`      | `%LOCALAPPDATA%\ed-mcp\Cache`      |
| Linux   | `~/.config/ed-mcp`             | `~/.cache/ed-mcp`                  |

ed-mcp sends your API keys only to the service that they belong to. On first use, it downloads game data (modules, blueprints and materials) from the coriolis-data and FDevIDs projects on GitHub. Then it looks for new versions once a week. To get new data at once, ask Claude to refresh the game data.

## More information

- [Tool reference](docs/tools.md): what each tool does, its inputs and its results.
- [Contributing](CONTRIBUTING.md): development, releases and service registrations.

## Licence

MIT. See `NOTICE` for third-party data.
