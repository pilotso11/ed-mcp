# Inara API research

Read from https://inara.cz/elite/inara-api-devguide/ and
https://inara.cz/elite/inara-api-docs/ in a browser on 2026-10-11. Plain HTTP
clients get a 503 bot challenge on these pages; the API endpoint itself is not
challenged.

## Request

`POST https://inara.cz/inapi/v1/`, JSON body:

```json
{
  "header": {
    "appName": "ed-mcp", "appVersion": "0.1.0", "isBeingDeveloped": true,
    "APIkey": "<personal key>", "commanderName": "<in-game name>", "commanderFrontierID": "<optional>"
  },
  "events": [
    { "eventCustomID": 1, "eventName": "getCommanderProfile", "eventTimestamp": "2026-10-11T00:00:00Z",
      "eventData": { "searchName": "<name>" } }
  ]
}
```

- `appVersion` should be `x.y.z`.
- `isBeingDeveloped: true` while testing. Newly accepted apps default to it server side.
- `commanderName` is recommended whenever a personal key is used.
- `eventCustomID` is echoed back so responses can be matched to requests.

## Status codes (header and each event)

| eventStatus | Meaning |
|---|---|
| 200 | OK |
| 202 | Warning: OK, but e.g. multiple results for the input |
| 204 | Soft error: no results |
| 400 | Error: missing properties etc. On failed authorization the whole batch is cancelled |

`eventStatusText` is present on errors and warnings only. The exact text for a
bad key is not documented; fixture `auth-failed.json` uses a placeholder text.

## Read events

- `getCommanderProfile` `{ searchName? }`. Exact in-game name match first, then
  Inara user-name search (first result). With a personal key and no
  `searchName`, returns the key owner. Returns `userID`, `userName`,
  `commanderName` (only on exact match), `commanderRanksPilot[]`
  (`rankName`, `rankValue`, `rankProgress`), `preferredAllegianceName`,
  `preferredPowerName`, `commanderMainShip` (`shipType`, `shipName`,
  `shipIdent`, `shipRole`), `commanderSquadron` (`SquadronID`, `SquadronName`,
  `SquadronMembersCount`, `SquadronMemberRank`, `inaraURL`),
  `preferredGameRole`, `avatarImageURL`, `inaraURL`, `dataImportActive`,
  `otherNamesFound[]` (up to 20).
- `getCommunityGoalsRecent` `eventData: []`. Returns an array of goals with
  `communitygoalName`, `starsystemName`, `stationName`, `goalExpiry`,
  `tierReached`, `tierMax`, `contributorsNum`, `contributionsTotal`,
  `isCompleted`, `lastUpdate`, `goalObjectiveText`, `goalRewardText`,
  `goalDescriptionText`.

Fixtures in `test/fixtures/inara/` are copied from the documentation examples
(profile, community goals) or built from the status table (not found, auth
failed). None are live responses.

## Rules (dev guide)

- App name must be whitelisted by Inara before use.
- Batch events; cache on the client; do not repeat identical requests.
- Excessive requests may invalidate the key.
- Do not retry rapidly when Inara is down.

## Verified 2026-10-12

After Inara whitelisted the app name `ed-mcp`, `getCommanderProfile` and
`getCommunityGoalsRecent` worked with a real personal key. Before the
whitelist, the header returned status 400 with "This application has no
access allowed." Live responses differ from the documentation in one way:
`commanderRanksPilot[].rankValue` is a string (for example `"8"`), not a
number. The list also includes the Odyssey ranks `soldier` and
`exobiologist`. Fixture `profile-live-string-ranks.json` follows the live
shape.
