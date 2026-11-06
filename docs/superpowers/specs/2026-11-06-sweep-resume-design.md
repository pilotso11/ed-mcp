# Partial sweeps: cache what was fetched, resume the rest

Date: 2026-11-06
Status: approved in conversation

## Purpose

`SpanshClient.populatedSystems` stops paging at a 20 s deadline and does not cache a partial result (see `2026-11-06-faction-systems-design.md`, "The sweep"). In a dense area, or when Spansh is slow, every call then pays the full 20 s again and gets the same partial answer. This change keeps the work: a partial sweep is cached, and the same search later carries on from where it stopped.

## Covered radius

Spansh returns the pages sorted by distance from the reference system. So a sweep that stops early is complete out to the distance of the last system that it fetched. `covered_ly` is that distance minus 0.01 ly, in case systems at the same distance are split between two pages. A complete sweep covers its whole radius.

## Cache

`SweepCache` keeps both complete and partial sweeps, with the same 1 hour lifetime and the same `cache_refresh` source, `spansh-sweeps`.

- `find(centre, radius)` returns a hit when a cached sweep covers the sphere: `distance(cached centre, new centre) + radius ≤ covered_ly`. For a complete sweep, `covered_ly` is its radius, as now.
- A partial sweep also keeps what is needed to resume: the search key (reference system in lower case, and radius), Spansh's count, and the systems fetched so far.

## Resume

`populatedSystems(near, radius)`:

1. When a cached sweep covers the sphere, return it.
2. When a partial sweep exists for the same key, continue by distance: request `distance.min = covered_ly` and `max = radius`, paging from page 0, with the stored systems and the same duplicate check. The overlap, systems just beyond the old `covered_ly` that were already fetched, is dropped by id. Each call fetches at least one page. The sweep resumes by distance, not by page, because page positions can shift when Spansh's list changes between calls that are up to an hour apart. A request that fails keeps the last saved partial sweep, so the next call resumes from there.
3. Otherwise start at page 0.

When the last page arrives, the partial sweep is replaced by a complete one. When the deadline stops paging again, the partial sweep is updated with the new systems and `covered_ly` (never below the previous one). A sweep completed by resuming keeps the fetch time of its first page, so it expires one hour after that.

The result gets `coveredLy`: the radius when the result is complete, and `covered_ly` when it is partial.

## Tools

When the sweep is partial, both tools add `covered_ly` (rounded down to 0.1 ly, so a search for the shown radius hits the cache) to the result and this note: "Spansh returned systems out to X ly within the time limit. Call again to continue the search."

- `systems_by_state` searches only within `covered_ly`.
- `massacre_targets` lists only targets within `covered_ly − 20` ly. A target farther out can have sources or pirate factions that were not fetched yet, so it could look primary when it is not. When `covered_ly − 20` is below 0, it lists no targets.

## Tests

- A partial sweep, then the same call: the second call requests `distance.min = covered_ly` from page 0, and the result is complete with all the systems.
- The resumed query returns systems that were already fetched: each `id64` appears once.
- After a partial sweep, a smaller search inside `covered_ly` makes no request.
- `covered_ly` is the distance of the last fetched system minus 0.01.
- `massacre_targets` with a partial sweep lists only targets within `covered_ly − 20`.
- Both tools show `covered_ly` and the note when the sweep is partial.
