# Live Snapshot Production Flow

This memo records the current production path for retaining LoL live game state
without adding VPS services, Cloudflare storage, or heavier frontend polling.

## Purpose

The site needs completed game pages to keep the last meaningful live frame even
after LoL Esports livestats starts returning empty or reset data. The retained
data is stored as small static JSON artifacts and used by `/api/live-event` as a
fallback.

## Production Components

- Cloudflare Pages deploy branch: `codex/github-pages-static`
- Public site: `https://lol-predictor.pages.dev`
- Live Function: `functions/api/live-event.js`
- Snapshot collector: `scripts/collect_live_event_snapshots.mjs`
- Scheduled workflow: `.github/workflows/collect-live-event-snapshots.yml`
- Snapshot state: `.github/live-event-snapshot-state.json`
- Static artifacts:
  - `docs/static/data/live-event-snapshots/latest_by_event.json`
  - `docs/static/data/live-event-snapshots/final_by_event.json`
  - `docs/static/data/live-event-snapshots/final_by_game.json`

## Runtime Data Path

1. GitHub Actions runs `Collect live event snapshots`.
2. The workflow checks out `codex/github-pages-static`, not the default branch.
3. The workflow runs `node scripts/collect_live_event_snapshots.mjs`.
4. The collector calls the LoL Esports public `getLive` endpoint.
5. The collector extracts match IDs with at least one `inProgress` or
   `completed` game.
6. The collector also keeps recently tracked completed events for a short grace
   period from `.github/live-event-snapshot-state.json`.
7. For each event ID, the collector calls:
   `https://lol-predictor.pages.dev/api/live-event?id={eventId}`.
8. `/api/live-event` normalizes LoL Esports event details and livestats into the
   same payload the match page already uses.
9. The collector writes the normalized payload into snapshot artifacts.
10. If any artifact changed, GitHub Actions commits the JSON changes back to
    `codex/github-pages-static`.
11. Cloudflare Pages deploys the new static JSON files.
12. Future `/api/live-event` requests can read `final_by_game.json` when the live
    feed/cache no longer has useful data.

## Collector Details

The collector is dependency-free Node.js. It does not import analyzer code or
install packages in CI.

Discovery:
- Endpoint: `https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US`
- Header: public LoL Esports API key
- It only tracks match events.
- It includes games with state `inProgress` or `completed`.

Forced collection:
- Manual workflow input `event_id` can force a specific event.
- Local equivalent:
  `node scripts/collect_live_event_snapshots.mjs --event-id 115548668059589358`

State retention:
- `.github/live-event-snapshot-state.json` stores tracked event IDs.
- `completed_polls` keeps completed matches around for a few extra collection
  cycles.
- Default grace: `3` polls.
- Once `completed_polls >= 3`, the event is removed from tracking.

Exit behavior:
- If discovery fails and no snapshots are written, the script exits non-zero.
- If some snapshots are written but there are partial errors, the summary records
  errors but preserves useful artifacts.

## Artifact Semantics

`latest_by_event.json`:
- Key: event ID.
- Value: the latest normalized `/api/live-event` response snapshot.
- Used for diagnostics and future expansion.

`final_by_event.json`:
- Key: event ID.
- Value: a final event snapshot when the series status is completed and contains
  meaningful live data.

`final_by_game.json`:
- Key: `{eventId}:{gameId}`.
- Value: one completed game record.
- This is the active site fallback used by `/api/live-event`.
- It is game-level so BO3/BO5 completed tabs can retain Game 1/2 while Game 3 is
  still in progress.

The current `final_by_game` record shape:

```json
{
  "schema": "lol_live_game_final_snapshot_v1",
  "checked_at": "2026-05-24T02:12:46.709Z",
  "event_id": "115548668059589358",
  "game_id": "115548668059589359",
  "game_number": 1,
  "event_status": "completed",
  "teams": [],
  "game": {
    "id": "115548668059589359",
    "state": "completed",
    "live": {}
  }
}
```

## `/api/live-event` Fallback Logic

Primary path:
- Fetch event details from LoL Esports API.
- Pick the current target game.
- Fetch livestats window/details.
- Compute live win probability.
- Store a short-lived Cloudflare cache snapshot when meaningful live data exists.

Fallback path:
- For ended/completed games, first try the short-lived Cloudflare cache snapshot.
- If cache is missing or not meaningful, read:
  `/static/data/live-event-snapshots/final_by_game.json`.
- Lookup key: `{eventId}:{gameId}`.
- If the artifact live payload is meaningful, restore it into `game.live`.
- Mark restored artifact data with `retained_from_artifact: true`.
- Recompute `game.live.win_probability` using the restored live state.

Important: static artifact fallback does not replace live data while a fresh
meaningful livestats payload is available.

## Frontend Impact

The frontend does not perform extra background collection.

The match page still calls:
- `/api/live-event?id={eventId}`

The retention behavior is hidden behind that API response. This keeps the UI
light:
- no browser-side scraping
- no larger polling fan-out
- no client-side model inference
- no extra external API calls from the browser

## Schedule and Load

GitHub Actions schedule:
- Cron: every 5 minutes.
- Job only commits when JSON changed.

Expected artifact size:
- Empty: a few bytes per file.
- A completed BO series: usually tens of KB.
- This is acceptable for Cloudflare static delivery and much lighter than
  storing full raw livestats frame history in the site repo.

## Current Production Checks

Known good checks:

```powershell
Invoke-WebRequest https://lol-predictor.pages.dev/api/diagnostics -UseBasicParsing
Invoke-WebRequest https://lol-predictor.pages.dev/static/data/live-event-snapshots/final_by_game.json -UseBasicParsing
node scripts/check_live_probability_contract.mjs
node --check scripts/collect_live_event_snapshots.mjs
```

Current deployed snapshot artifact check:
- `final_by_game.json` returns `200 application/json`.
- It contains at least the seeded G2 vs KC completed game snapshot.

## Operational Notes

- GitHub Actions schedules only run from the repository default branch.
- The workflow file is therefore also present on default branch
  `codex/lol-predictor-web`.
- The workflow itself checks out and pushes `codex/github-pages-static`, because
  Cloudflare Pages deploys from that branch.
- No VPS HTTP service is required.
- No Cloudflare D1/KV/R2 storage is required for this path.
- If no live matches are active, artifacts remain unchanged and no deploy is
  created.

## Known Limitations

- GitHub scheduled workflows can be delayed by GitHub load. The nominal interval
  is 5 minutes, not a hard real-time SLA.
- If LoL Esports `getLive` omits a match, it will only be collected if manually
  forced with `event_id` or already tracked from a previous poll.
- The artifact records normalized site payloads, not every raw livestats frame.
  This is intentional to keep the site artifact small.
- If the site `/api/live-event` itself fails for an event, that event cannot be
  snapshotted by this workflow in that cycle.

## Recovery Steps

If completed game data disappears:

1. Check `final_by_game.json` in production.
2. Confirm the event/game key exists.
3. Check `/api/live-event?id={eventId}` for `retained_from_artifact: true`.
4. Manually run the workflow with the event ID if the key is missing.
5. If manual workflow succeeds, wait for Cloudflare Pages deploy.

Manual local force-collect:

```powershell
node scripts/collect_live_event_snapshots.mjs --event-id 115548668059589358
```

Manual production verification:

```powershell
Invoke-WebRequest "https://lol-predictor.pages.dev/api/live-event?id=115548668059589358" -UseBasicParsing
```
