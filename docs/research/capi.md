# Frontier CAPI and OAuth research

Researched 2026-10-11. Sources, most authoritative first:

- Frontier's own OAuth2 page: https://hosting.zaonce.net/docs/oauth2/instructions.html
  ("Updated: 2019-01-22", © Frontier Developments). Public, no login.
- EDMC source, `main` at commit date 2026-09-02:
  https://github.com/EDCD/EDMarketConnector (`companion.py`, `protocol.py`,
  `constants.py`, `config/__init__.py`, `ChangeLog.md`) and its wiki
  (`Troubleshooting.md`).
- EDCD docs: https://github.com/EDCD/FDevIDs/tree/master/Frontier%20API
  (updated 2026-09-05). These are a copy of
  https://github.com/Athanasius/fd-api/tree/main/docs (last commit 2024-04-10),
  with small wording changes.
- EDDI `CompanionAppService.cs` and `ShipMonitor/FrontierApi.cs` (branch `develop`).
- klightspeed's C# CAPI client gist and its comments:
  https://gist.github.com/klightspeed/357cddf4e9e0669305d713e02eac1496
- djdarcy/EDAPITool `docs/frontier-oauth-setup.md` and `APITool/auth.py`
  (commit date 2026-10-09).
- KeilerHirsch/wolpertinger `fixtures/capi/profile-r0-sanitized.json`: a
  recent, redacted real `/profile` response. Used only for its key structure.

`https://user.frontierstore.net/developer` and `/developer/docs` need a
Frontier login. I could not read them. Statements about the developer portal
come from the community sources above.

## Summary for our design

- Auth server `https://auth.frontierstore.net`. Endpoints `/auth`, `/token`,
  `/decode`, `/me`.
- Use `scope=auth capi`. A token with only `capi` is rejected by CAPI.
- PKCE (S256) with no client secret works. EDMC does this.
- Access token: 4 hours. The refresh token **rotates on every refresh**. All
  refreshes stop working **25 days after the user approved**. Then the user
  must log in again in the browser.
- One active refresh token per account and client ID. A new login on a
  second machine kills the first machine's refresh token.
- Redirect: use `http://localhost:<random port>/<path>`. EDMC has done this
  on Linux (and, from source, on macOS) since 2019 with one client ID, and
  the port changes every run. See "Redirect URI rules" for what is and is not
  verified.
- Base URL `https://companion.orerve.net` (live galaxy).
- `/profile` has no engineering materials, no on-foot materials, and (in the
  recent dump) no ship cargo contents.
- Rate: at most one set of queries per 60 s. `/fleetcarrier` at most once per
  15 min. Send a `User-Agent` that matches `EDCD-[A-Za-z]+-[.0-9]+`.

## 1. URLs and parameters

### Endpoints

| Purpose | URL | Source |
|---|---|---|
| Authorise | `https://auth.frontierstore.net/auth` | Frontier page, EDMC |
| Token (code and refresh) | `https://auth.frontierstore.net/token` | Frontier page, EDMC |
| Decode token (full JWT claims) | `https://auth.frontierstore.net/decode` | Frontier page, EDMC |
| User info (no expiry claims) | `https://auth.frontierstore.net/me` | Frontier page |

### Authorise request (browser GET)

EDMC `companion.py` builds it like this (verbatim order):

```
https://auth.frontierstore.net/auth?response_type=code
  &audience=frontier,steam,epic
  &scope=auth%20capi
  &client_id=<client id>
  &code_challenge=<challenge>
  &code_challenge_method=S256
  &state=<state>
  &redirect_uri=<redirect uri>
```

| Param | Value | Notes |
|---|---|---|
| `response_type` | `code` | Only the authorisation code grant is supported (Frontier page). |
| `client_id` | UUID from the developer portal | EDMC's is public in its source. |
| `scope` | `auth capi` (space, URL-encoded as `%20`) | Scopes add up. `auth` is the default and gives name and email. `capi` gives CAPI access. fd-api README: with `scope=capi` only, CAPI answers 401 `"Authentication token incomplete","missing":["email","firstname","lastname"]`. Always send `auth capi`. |
| `audience` | comma list of `frontier`, `steam`, `epic`, `xbox`, `psn`, or `all` | Frontier page lists `xbox`, `psn`, `steam`, `frontier`, `all` (default `all`). EDMC sends `frontier,steam,epic` (ChangeLog: added Steam and Epic so those logins work). EDDI sends `all`. For a PC tool, `frontier,steam,epic` matches EDMC. |
| `state` | 32 random bytes, base64url, no `=` padding | Check it on the callback. |
| `code_challenge` | base64url(SHA-256(verifier)), **no `=` padding** | Hash the raw verifier bytes. Use a binary digest, not hex. |
| `code_challenge_method` | `S256` | |
| `redirect_uri` | see section 2 | Must be URL-encoded. |

Verifier: fd-api says 32 random bytes, base64url, and "the '=' on the end
needs to remain in place". EDMC's `_generate_verifier` does the same. RFC 7636
does not allow `=` in a verifier, but Frontier accepts it, and the verifier is
only compared with the challenge on Frontier's side. Either way, send the
**same string** that you hashed. The challenge must have no padding, or the
token request fails with `{"message":"An error occured.","logref":"..."}`.

### Token request (code exchange)

`POST https://auth.frontierstore.net/token`,
`Content-Type: application/x-www-form-urlencoded`:

```
grant_type=authorization_code
client_id=<client id>
code_verifier=<verifier>
code=<code from callback>
redirect_uri=<same redirect uri as the authorise request>
```

No `client_secret` (EDMC sends none). Response JSON: `access_token`,
`refresh_token`, `token_type` (`Bearer`), `expires_in` (seconds). A wrong or
slow exchange returns 401.

### Refresh request

`POST https://auth.frontierstore.net/token`, form-encoded:

```
grant_type=refresh_token
client_id=<client id>
refresh_token=<stored refresh token>
```

No `client_secret` for PKCE clients (fd-api: "You only need the client_secret
if using non-PKCE Authorization"; EDMC sends none). No `redirect_uri`.
Response: a new `access_token`, `expires_in` (14400), and a **new
`refresh_token`**. Store the new one at once. EDMC writes it to config right
after each refresh.

### Decode and me

`GET /decode` or `GET /me` with `Authorization: Bearer <access token>`.

`/decode` returns the JWT claims, for example (Frontier page):

```json
{
  "iss": "https://auth.frontierstore.net",
  "usr": { "customer_id": "123456890", "firstname": "Dave", "lastname": "Lister",
           "email": "dave@example.com", "platform": "frontier" },
  "iat": 1547463135,
  "exp": 1547477535,
  "scope": "auth capi"
}
```

`/me` returns the `usr` object only (`customer_id`, `firstname`, `lastname`,
`email`, `platform`, `thirdPartyUserId`, `parent_id`). EDMC calls `/decode`
after login and checks `"F" + usr.customer_id` against the journal's `FID`.
It does this so that the user cannot log in with the wrong account. We can do
the same check if we read the journal. Otherwise we can show the name from
`/profile`.

Tokens are encrypted JWTs (JWE). Clients cannot read `exp` locally. Use
`expires_in`, or call `/decode`.

## 2. Redirect URI rules

This is the part that matters most for our design. Here is what is verified
and what is not.

### What is verified

1. **EDMC uses `http://localhost:<OS-chosen port>/auth` with one fixed client
   ID.** `protocol.py`, class `LinuxProtocolHandler`:

   ```python
   self.httpd = HTTPServer(("localhost", 0), HTTPRequestHandler)
   self.redirect = f"http://localhost:{self.httpd.server_port}/auth"
   ```

   Port `0` means the OS picks a new port on every start. The same
   `CLIENT_ID = 'fb88d428-9110-475f-a3d2-dc151c2b9c7a'` is used as on Windows.
   This handler runs whenever EDMC is not the frozen Windows build: Linux,
   macOS from source, Wine, and Windows with `--force-localserver-for-auth`.
   ChangeLog 4.2.3 describes the Windows option as "a webserver on a random
   port on localhost ... the same way it already works on non-Windows
   platforms". EDMC has shipped this for years and many people use it. So
   **Frontier accepts `http://localhost` with any port for EDMC's client.**

2. **EDMC on Windows (frozen build) uses a custom protocol:
   `edmc://auth`** (`constants.py`: `protocolhandler_redirect = 'edmc://auth'`).
   The installer registers the `edmc` URL scheme. The browser opens it, and the
   running EDMC gets the URL through Windows DDE (`WindowsProtocolHandler` in
   `protocol.py`). The callback is not an HTTP listener. EDDI also uses a custom
   scheme (`eddi://auth/`).

3. **klightspeed's C# client** uses `http://localhost:{port}/` with a random
   port in 49152–65534, with its own client ID (gist `OAuth2.cs`).

4. **EDMC no longer supports macOS** (`docs/Unsupported Operating Systems.md`).
   Today, macOS EDMC users run from source, which uses the localhost listener.

5. Before login, `/auth` does not check `redirect_uri`. I loaded the
   authorise page with EDMC's public client ID and these redirect values:
   `edmc://auth`, `http://localhost:54321/auth`, `http://127.0.0.1:54321/auth`,
   `http://[::1]:54321/auth`, `http://localhost:54321/other` and
   `https://evil.example.com/cb`. All six returned HTTP 200 and the same
   login page. Any check happens after login, so this test does not settle
   the question.

### What the developer portal accepts at registration (community report, not verified)

EDAPITool's setup guide says the "Create Client" form has a **Redirect URI**
field, and that the form rejects plain HTTP:

```
http://localhost:8085/callback     REJECTED - "Error adding endpoint"
http://127.0.0.1:8085/callback     REJECTED
http://localhost/callback          REJECTED
https://localhost/callback         ACCEPTED
https://localhost:8443/callback    ACCEPTED
```

EDAPITool registers `https://localhost/callback`. At runtime its automatic mode
sends `redirect_uri=http://localhost:8085/callback` (`auth.py`). That
URI is not the registered one. The guide's explanation of why this works is
not convincing. But if it does work, it agrees with EDMC: the runtime does
not require the registered URI when the host is `localhost`.

klightspeed (2021, gist comment) guessed: "It's possible that the Frontier auth
server is special-casing localhost as a redirect URL, and checks the redirect
URL against that configured in the developer zone in user.frontierstore.net
when it's not localhost." In the same thread, a user had a non-localhost
redirect go wrong. The cause was a missing trailing `/` compared with the
registered value. That suggests an exact string match for non-localhost
URIs.

### Answer

- **Use `http://localhost:<random port>/auth`.** This is the form proven by
  EDMC under one client ID and many ports. A fixed port is **not** required
  for `localhost`, based on EDMC's behaviour.
- **Do not use `127.0.0.1` or `[::1]` in the redirect URI.** No client that I
  found does this. Frontier may treat only the literal hostname `localhost` as
  special. This is unverified either way. The design spec currently says
  `127.0.0.1`. Change it to `localhost` in the URI.
- Exact-match rules for the registered URI: for non-localhost URIs the
  evidence points to exact match, including a trailing slash. For
  `localhost`, the port and path are not matched against the registration.
  EDMC proves the port. The path is probably not matched either, but no
  client proves that.
- At registration, the portal may refuse `http://` URIs. If so, register
  something it accepts (for example `https://localhost/auth`) and still send
  `http://localhost:<port>/auth` at runtime, as EDAPITool and EDMC do.
- **Verify with our own client ID before relying on this.** Do one real login
  with `http://localhost:<random>/auth`, then a second login with a different
  port.
- Fallback if Frontier rejects random ports for new clients: register one
  fixed port, for example `http://localhost:47231/auth`. Bind that port, and
  fail with a clear message if it is busy. A custom URL scheme (EDMC
  Windows, EDDI) is the other fallback. It needs per-OS registration and an
  IPC path back into the MCP server, which is much more work for a Node
  process that an MCP host starts.

### Listener notes for Node 20

- The redirect host is `localhost`, so the browser may connect on IPv4 or
  IPv6. Node 17+ keeps the OS resolver order, and `listen(0, 'localhost')`
  can bind only `::1` on some systems. Bind `127.0.0.1` on port 0, then try to
  bind `::1` on the same port as well (ignore EADDRNOTAVAIL). Or listen
  without a host and reject non-loopback peers.
- Chrome may warn "The information you're about to submit is not secure" for
  the `edmc://` callback (EDMC wiki). Chrome treats `http://localhost` as a
  secure context, so this warning is not expected for loopback. This is not
  verified.
- Reply to the callback with a small HTML page that says "You can close this
  tab". EDMC does the same.

## 3. Public client with PKCE

Yes. Frontier's page says: "We also support PKCE ... Which allows logins from
client side applications." EDMC sends no `client_secret` in the code
exchange or in the refresh. Frontier's page also says not to send the client
secret from client-side code.

The portal gives each client a "Shared Key" (a secret). Do not ship it or use
it. Frontier's FAQ says the API key "SHOULD NOT be included in your open
source code" and that others who run the project "will need to obtain their
own API key". EDMC ships its client ID in source anyway (it can be
overridden with the `CLIENT_ID` env var), and EDDI keeps its client ID out of
version control. Our spec already makes `CAPI_CLIENT_ID` user-supplied. That
matches Frontier's FAQ.

## 4. Token lifetimes

| Item | Value | Source |
|---|---|---|
| Access token | 14400 s = 4 h (`expires_in`) | fd-api; Frontier example `exp - iat = 14400`; EDAPITool saw `expires_in: 14376` |
| Refresh token rotates | Yes, a new one on every refresh | Frontier page: "The refresh token will be updated each time a new access token is requested." EDMC stores the new one each time. |
| Refresh window | 25 days from the user's approval, not from the last refresh | fd-api: "you will only be able to use *any* Refresh token for an account for at most 25 days after the initial Authorization." EDMC wiki: "25 days after you approved this application the Frontier authorisation server will force us to get you to authorise us again." |
| After 25 days | Refresh fails. The user must do the browser flow again. | fd-api says the user "should only need to login ... rather than also asking them to Approve your Application again". |
| Revoked by user | Refresh returns 401. Unexpired access tokens keep working until `exp`. | fd-api |
| Expired access token on CAPI | HTTP 401, body `{"status":401,"message":"JWT has incorrect/unexpected fields"}` (since 2019-09). Before that it was 422. | fd-api |
| One login per account and client | A new login elsewhere makes the old refresh token invalid | EDMC wiki, issue #1632 |

Design effects:

- Rotation means two processes that share one stored refresh token will
  race. Do the refresh under a lock, and write the new token to the keychain
  before you use the new access token.
- Because of the 25-day limit, the MCP server will need `capi_login` about
  once a month. On refresh failure, return a clear "run capi_login again"
  error. Do not loop.
- We cannot read the 25-day deadline from the token. Store the login time
  ourselves if we want to warn the user early.

## 5. CAPI hosts and `/profile`

| Host | Use |
|---|---|
| `https://companion.orerve.net` | Live galaxy (Odyssey/Horizons 4.x). Default. |
| `https://legacy-companion.orerve.net` | Legacy galaxy (3.8 clients) since Odyssey Update 14. EDMC uses it when the journal says the game is not live. |
| `https://pts-companion.orerve.net` | Beta. It existed before the galaxy split. It may not exist now. |

Without a token, `GET https://companion.orerve.net/` returns 401
`{"status":401,"message":"OAuth Authentication Required","tag":"..."}`
(checked today). With a token, `/` lists the endpoints: `/profile`, `/market`,
`/shipyard`, `/communitygoals`, `/journal`, `/fleetcarrier`, `/visitedstars`.
`/profile`, `/market` and `/fleetcarrier` take `?language=en|fr|de|ru|es|pt`
for `locName` fields.

Headers: `Authorization: Bearer <access_token>`, plus the `User-Agent` in
section 6. Other status codes: 418 means the service is down for maintenance.

### `/profile` layout

Top-level keys in a recent response (wolpertinger fixture): `commander`,
`ship`, `suit`, `lastSystem`, `lastStarport`, `squadron`, `ships`,
`loadouts`, `loadout`, `suits`. `suit`, `suits`, `loadout` and `loadouts` are
Odyssey on-foot data. `squadron` appears only if the commander is in one.

| Need | Where |
|---|---|
| Commander name, credits, ranks | `commander.name`, `commander.credits`, `commander.rank.*` (numbers; map them with FDevIDs rank CSVs) |
| Docked or not | `commander.docked` (bool), `commander.onfoot` |
| Current system | `lastSystem.name`. `lastSystem.id` is sometimes the id64 and sometimes another id (fd-api). For the id64, use `ship.starsystem.systemaddress`. |
| Docked station | `lastStarport.name`, `.id` (market ID), `.faction`, `.minorfaction`, `.services`. This is the *last* starport. It is current only when `commander.docked` is true. |
| Current ship | `ship`. `commander.currentShipId` equals `ship.id`. `ship.name` is the FDev symbol (`Krait_MkII`). `ship.shipName` and `ship.shipID` are the user's name and ident. |
| Current ship location | `ship.starsystem.{id,name,systemaddress}`, `ship.station.{id,name}` |
| Modules | `ship.modules`, an object keyed by slot (`FrameShiftDrive`, `Slot01_Size6`, `LargeHardpoint1`, `PaintJob`, `Decal1`, `VesselVoice` ...). Each value has `module.{id,name,locName,locDescription,value,free,health,on,priority}`. Cosmetic slots (`PaintJob*`, `Decal*`, `*Colour`, `VesselVoice`, `ShipKit*`, `Bobble*`) are modules too. Filter them out. |
| Engineering | Same slot object: `engineer.{engineerName,engineerId,recipeName,recipeLocName,recipeLocDescription,recipeLevel}`; `WorkInProgress_modifications.<OutfittingFieldType_X>.{value,LessIsGood,locName,displayValue,dir}`, where `value` is a **multiplier** on the base stat (EDMC and EDDI multiply base mass and FSD optimal mass by it); `specialModifications` is `{"special_x": "special_x"}` if there is an experimental effect, and `[]` if there is none (a PHP empty-array quirk). |
| Fighters and SRVs | `ship.launchBays.<slot>.<SubSlotN>.{name,locName,rebuilds,loadout,loadoutName}` |
| Ship list | `ships`. **An array if ship IDs are 0..n with no gaps. Otherwise an object keyed by the ID as a string.** Handle both. Each entry has `id`, `name`, `shipName`, `shipID`, `value`, `free`, `station`, `starsystem`. Some entries lack `shipName`. The list includes the current ship. |

**Materials are not in `/profile`.** No source documents any raw, manufactured
or encoded material field. The real recent dump does not have one either.
Engineering materials come only from the journal (`Materials` event), or from
Inara or EDSM. On-foot microresources appear only in `/fleetcarrier`
(`carrierLocker`) for carrier stock. Cargo contents are not listed in
`/profile`: EDDI's older fixture had `ship.cargo` with `capacity`, `qty` and
`items`, but the recent dump has no `ship.cargo` key at all.

The trimmed example is in `test/fixtures/capi/profile.json`. Its provenance is
described in "Fixture provenance" below.

```json
{
  "commander": { "id": 1234567, "name": "Testy McTestface", "credits": 1234567890,
                 "debt": 0, "currentShipId": 7, "alive": true, "docked": true,
                 "onfoot": false, "rank": { "combat": 5, "trade": 6, "explore": 8, "...": 0 } },
  "lastSystem":   { "id": 3932277478106, "name": "Shinrarta Dezhra", "faction": "Independent" },
  "lastStarport": { "id": 128666762, "name": "Jameson Memorial", "faction": "Independent",
                    "minorfaction": "The Pilots Federation", "services": { "shipyard": "ok" } },
  "ship": {
    "id": 7, "name": "Krait_MkII", "shipName": "Long Haul", "shipID": "KR-07",
    "station":    { "id": 128666762, "name": "Jameson Memorial" },
    "starsystem": { "id": 3932277478106, "name": "Shinrarta Dezhra", "systemaddress": 3932277478106 },
    "modules": {
      "FrameShiftDrive": {
        "module":   { "id": 128064122, "name": "Int_Hyperdrive_Size5_Class5", "locName": "Frame Shift Drive",
                      "value": 5103950, "health": 1000000, "on": true, "priority": 0 },
        "engineer": { "engineerName": "Felicity Farseer", "engineerId": 300100,
                      "recipeName": "FSD_LongRange", "recipeLevel": 5 },
        "WorkInProgress_modifications": {
          "OutfittingFieldType_FSDOptimalMass": { "value": 1.55, "LessIsGood": false, "locName": "Optimal Mass" }
        },
        "specialModifications": { "special_fsd_heavy": "special_fsd_heavy" }
      }
    }
  },
  "ships": { "2": { "id": 2, "name": "Python", "...": "..." }, "7": { "id": 7, "name": "Krait_MkII", "...": "..." } }
}
```

### Fixture provenance

`test/fixtures/capi/profile.json` was written by hand. Nothing was copied
from a licensed file.

- Key names and nesting come from the wolpertinger redacted live dump
  (EUPL-1.2; only the key structure was used, and that structure is factual).
  Three keys were redacted in that dump: `lastSystem.faction`,
  `lastStarport.faction` and `ship.health.integrity`. I took them from
  fd-api, EDDI's fixture and EDMC's tests.
- Module, ship and engineer IDs and symbols come from EDCD FDevIDs
  (`outfitting.csv`, `shipyard.csv`, `engineers.csv`).
- `OutfittingFieldType_FSDOptimalMass` and `OutfittingFieldType_Mass` come from
  EDDI `FrontierApi.cs` and EDMC `edshipyard.py`. `special_fsd_heavy`
  follows the experimental-effect naming that EDDI and EDMC parse.
- Names, credits, values, system and station IDs, `displayValue` and `dir`
  are illustrative. The format of `dir` is not documented, and the live dump
  redacts it.
- EDDI's `Tests/Properties/capi-profile.json` is a real but old dump with
  merged market data. It has no engineering. I used it only to check older
  fields.

## 6. Rate limits and etiquette

- No published hard limit. fd-api: "try not to issue more than one query a
  minute". Frontier "have in the past stated that rate limiting might kick in
  if you perform more than 2 queries per second".
- EDMC: `capi_query_cooldown = 60` s between sets of queries (`/profile`,
  `/market` and `/shipyard` together when docked).
  `capi_fleetcarrier_query_cooldown = 900` s. Request timeout 10 s.
- CAPI data can lag the game. `/journal` is not real time. Query it after a
  session.
- **User-Agent:** Frontier asked that all CAPI and auth requests use a
  User-Agent that matches `EDCD-[A-Za-z]+-[.0-9]+`, for example
  `EDCD-miggy-0.0.1`. The middle part should be the application name. EDMC sends
  `EDCD-EDMarketConnector-<version>`. Our spec says `inara-mcp/<version>`.
  For Frontier hosts use something like `EDCD-InaraMCP-0.1.0` instead. Note
  that the regex allows letters only in the name, so no hyphen.
- The spec's 60 s CAPI cache fits this guidance. Do not retry 401 in a loop.
  Refresh once, then ask for a new login.

## 7. Registering a client

From the EDCD notes, allauth docs and EDAPITool guide. I did not do this
myself.

1. Log in at https://user.frontierstore.net/ with the Frontier account.
2. Apply for developer access. Approval is manual and "will _not_ be
   instant" (EDCD). No source gives a typical wait or the criteria.
3. After approval, open **Developer Zone** (`/developer`). Click **Create
   Client**. EDAPITool lists these form fields: Application Name (users see it
   on the consent page), Description, Homepage URL, Redirect URI. See
   section 2 for what the Redirect URI field reportedly accepts.
4. The client shows the scopes it is allowed, normally `AUTH` and `CAPI`.
   **View** shows the **Client ID** (UUID) and **Shared Key** (secret).
   **Regenerate key** replaces the key.
5. You accept Frontier's terms as the key holder. Frontier's FAQ says each
   person who runs an instance should get their own key, and you must tell
   players what data you use and why.

For inara-mcp, every user registers their own client and sets
`CAPI_CLIENT_ID`. The README needs the steps above, the redirect URI to
enter, and a warning that approval is not instant.

## Not verified

- Whether `127.0.0.1` or `[::1]` works as a redirect host. No client uses
  them.
- Whether the path of a `localhost` redirect must match the registered path.
- Whether a newly created client today, registered with `https://localhost/...`,
  accepts `http://localhost:<random>/...` at runtime. EDMC's client is old.
  Frontier could treat older clients differently.
- The exact registration form and its validation. This comes from one
  community guide.
- Approval time and criteria.
- `/me` and `/decode` response shapes beyond Frontier's 2019 examples.
- Whether `pts-companion.orerve.net` still exists.
- Any hard rate limit number.

## Verified 2026-10-12

A client registered on 2026-10-12 (scopes AUTH and CAPI, shown as INACTIVE in
the developer portal at the time) completed a real login with
`redirect_uri=http://localhost:<random port>/auth`. The code exchange,
token storage and `GET /profile` all worked. The profile returned the
commander, current system and station, the current ship with every module and
its engineering, and the full fleet.
