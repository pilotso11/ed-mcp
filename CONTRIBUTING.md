# Contributing to ed-mcp

This page is for people who change ed-mcp. To install and use it, see the [README](README.md).

## Development

```bash
npm ci
npm run check
npm run pack:mcpb
```

`npm run check` runs the type check, the format check and the tests. The tests use no network. `npm run pack:mcpb` builds `dist/` and creates `ed-mcp-<version>.mcpb`.

To run your build in Claude Code, run `npm run build`. Then register `node <repo>/dist/index.js` with `claude mcp add`, as the README shows for `npx`.

Design notes and plans are in `docs/superpowers/`. Research on the data sources is in `docs/research/`.

## Pull requests

`main` accepts changes only through pull requests. A pull request can merge when:

- the `ci-ok` check passes (Ubuntu, macOS and Windows on Node 22 and 24, plus the `.mcpb` build),
- it has one approving review,
- every review thread is resolved,
- the branch is up to date with `main`.

A push dismisses earlier approvals. Reply to every review comment. If you fix it, give the commit. If you do not, say why.

## Data and licences

- Do not commit coriolis-data or FDevIDs files. The server downloads them at run time.
- Do not copy code or data from EDSY. Its licence (CC BY-NC) does not allow it.
- The engineer table comes from EliteDangerousCore (Apache-2.0). Keep `NOTICE` up to date.
- ed-mcp only reads from Inara. Do not add Inara write events.

## Service registrations

These steps are already done for ed-mcp. Repeat them only for a fork that uses its own name.

### Inara app name

Inara accepts requests only from whitelisted app names. ed-mcp is whitelisted under the name `ed-mcp`. For a different name, email Inara with the app name, what the app does and its homepage. Until Inara approves the name, it rejects requests. Then set `INARA_APP_NAME`.

`INARA_DEV_MODE=true` sends `isBeingDeveloped` to Inara. Use it while you test against Inara. It defaults to `false`.

### Frontier client

ed-mcp ships with its own Frontier client ID, so players log in without a developer account. Frontier login uses PKCE, so the client ID is public. There is no shared secret in the code.

To use your own client:

1. Request developer access on the Frontier developer portal (user.frontierstore.net/developer). Frontier approves access by hand.
2. After approval, choose "Create Client".
3. Leave the Redirect URL field empty. Login works without it (tested October 2026).
4. Copy the Client ID. Do not copy the Shared Key. ed-mcp does not use it.
5. Set `CAPI_CLIENT_ID` to your Client ID.

At run time, the server uses `http://localhost:<random port>/auth` as the redirect, as EDMC does. It sends the User-Agent `EDCD-EdMcp-<version>` with CAPI requests. See `docs/research/capi.md`.

## Releasing

1. Set the new version in `package.json`, `manifest.json` and `src/version.ts`.
2. Merge the change to `main`.
3. Tag the commit `vX.Y.Z` and push the tag.

The release workflow makes sure that the tag matches the package version. Then it runs the checks and builds the `.mcpb` file. It creates a GitHub Release with the file attached. It publishes to npm only if the repository has an `NPM_TOKEN` secret. Without the secret, it skips npm and still creates the release.
