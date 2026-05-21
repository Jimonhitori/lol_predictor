# LoL Predictor Integration Plan

## Current Architecture

- `lol_predictor` serves the user-facing dashboard from `docs/` on Cloudflare Pages.
- `functions/api/live-event.js` is the Cloudflare Pages Function boundary for LoL Esports event details and livestats. The browser should not call LoL Esports APIs directly.
- Static fallback JSON under `docs/static/data/` remains the baseline for schedules, match details, H2H, rosters, standings, and meta tables.
- `docs/static/data/live_model.json` is the dependency-free live win probability model consumed by the Pages Function.
- `lol-pros-analyzer` owns ingestion, training, prediction generation, validation reports, and optional Worker/API publication.

## Repository Responsibilities

### `Jimonhitori/lol_predictor`

- Render match list, match detail, live data, H2H, rosters, meta, standings, and prediction UI.
- Fetch fresh live/event state only through Cloudflare Pages Functions or Workers.
- Consume prediction JSON snapshots or API responses generated elsewhere.
- Keep static JSON fallbacks working when live APIs, prediction feeds, or models are unavailable.
- Avoid model training, CSV aggregation, or heavy inference in browser code.

### `Jimonhitori/lol-pros-analyzer`

- Ingest Oracle's Elixir, Riot, LoL Esports, Leaguepedia, and other source data.
- Normalize teams, schedules, rosters, games, patch data, and live frames.
- Train/evaluate pre-match, post-draft, and live model artifacts.
- Generate `pre_match_predictions.json` or equivalent public JSON contracts.
- Publish validated model/data artifacts through GitHub Pages, Cloudflare, or a Worker/API.

## Do Not Break

- `/index.html` and `/match.html?id={eventId}` static routing.
- `window.STATIC_SITE = true` with static JSON fallback.
- `/api/live-event?id={eventId}` returning normalized `teams`, `games`, `live`, `warning`, and `source`.
- Existing JSON paths under `docs/static/data/`, especially `matches-*`, `matches/{id}.json`, `h2h/`, `rosters/`, `team-records/`, `summaries/`, and `options.json`.
- Match links using `match.html?id=...`, so GitHub Pages and Cloudflare Pages both work.
- Five-second live detail refresh and one-minute match list refresh.
- Side colors limited to blue/red side differentiation inside the live panel.

## Priority Queue

1. Stabilize the live probability contract in `lol_predictor`: ship `live_model.json`, return `win_probability` from `/api/live-event`, and display it without disrupting live stats.
2. Add a pre-match prediction feed consumer with local/static fallback and a configurable remote URL.
3. Define a compact public prediction JSON schema shared by both repos.
4. Add Cloudflare diagnostics for live/prediction freshness, model version, and fallback reason.
5. Tighten the dashboard layout around real-time analysis density after the data contracts are stable.

## Implementation Roadmap

### 1. Live Probability Contract

Status: implemented in `lol_predictor`; Cloudflare production smoke check shows `/api/live-event` is deployed.

Scope:

- Keep `/api/live-event?id={eventId}` as the only browser-facing live event endpoint.
- Return event details, current game state, livestats frame data, and `live.win_probability` in one normalized response.
- Serve `docs/static/data/live_model.json` as the model artifact used by the Pages Function.
- Keep heuristic or neutral fallback when the model, livestats frame, or game timer is unavailable.

Current contract:

- `games[].live.status`
- `games[].live.game_time`
- `games[].live.estimated_game_time`
- `games[].live.warning`
- `games[].live.win_probability.blue`
- `games[].live.win_probability.red`
- `games[].live.win_probability.model`
- `games[].live.win_probability.validation.display`

Next checks:

- Deploy the current branch to Cloudflare Pages and verify the Function can read `live_model.json` through `context.env.ASSETS`.
- Test one live event, one unstarted event, one completed event, and one event with missing livestats.
- Confirm cache TTL remains short only for active or soon-live games.

Production evidence:

- `node scripts/check_cloudflare_pages.mjs --base-url https://lol-predictor.pages.dev --event-id test` returns JSON from `/api/live-event`.
- The smoke event `test` currently returns `source: cloudflare_live_event`, `games: []`, and `warning: event_details_fetch_failed`, which proves the Function route is active but does not prove live win probability for a real event.

Acceptance criteria:

- Live match detail continues rendering if LoL Esports livestats is empty or unavailable.
- Live probability appears only when the response status is `estimated`.
- The response always includes a clear fallback reason through `warning` or probability `status`.
- CI verifies the sample live probability payload, live model guidance, Pages Function hooks, and the actual `liveWinProbabilityText()` render contract for estimated, non-estimated, and caution states.

### 2. Pre-Match Prediction Feed

Status: implemented in `lol_predictor` with local fallback, remote URL support, and compact prediction panels.

Scope:

- Add a lightweight fetcher in `docs/static/app.js` for pre-match predictions.
- Prefer local static fallback first if `docs/pre_match_predictions.json` exists.
- Support remote fetch from a configured analyzer public site, while defaulting to the Cloudflare-hosted local bootstrap:
  `/pre_match_predictions.json`
- Match predictions to dashboard matches by stable keys, in this order:
  `event_id`, `game_id`, normalized `league + start_time + blue_team + red_team`.
- Display pre-match probability on match cards and match detail without replacing live probability.

Implemented UI placement:

- Match card: compact `PRE 57.2%` style indicator near status/time.
- Match center: blue/red pre-match split beside series score.
- Match center and match detail: compact prediction panel showing favorite, blue/red probability split, confidence, model/feed metadata, and warning count.
- Match detail: pre-match prediction remains separate from in-game live probability.

Fallback behavior:

- If the feed is missing, malformed, stale, or has no matching row, show no prediction badge.
- Do not block match rendering on prediction fetch.
- Keep static schedule and match detail fallback unchanged.

Acceptance criteria:

- The page loads normally with no prediction feed.
- A matching prediction row appears on both list and detail views.
- Feed freshness/model metadata is available for diagnostics.
- The prediction panel is optional and hides itself when no matching row exists.
- CI verifies both a populated local feed and an empty analyzer preview feed, including the actual `renderPredictionPanel()` contract in a Node VM for populated, empty, and unavailable feed states.

### 3. Shared Prediction JSON Schema

Status: defined and mirrored into `lol-pros-analyzer` docs/scripts/CI.

Goal:

- One compact public JSON contract that `lol_predictor` can consume without knowing internal CSV or model details.
- Stable enough for Cloudflare/GitHub Pages static hosting.

Proposed top-level shape:

```json
{
  "schema": "lol_predictions_public_v1",
  "generated_at": "2026-05-20T00:00:00Z",
  "source": "lol-pros-analyzer",
  "models": {
    "pre_match": {
      "name": "logistic_regression_actions",
      "version": "production",
      "metrics": {}
    }
  },
  "predictions": []
}
```

Proposed prediction row:

```json
{
  "event_id": "116056873411008590",
  "game_id": "",
  "league": "LCK",
  "start_time": "2026-05-20T10:00:00Z",
  "blue_team": "T1",
  "red_team": "Gen.G",
  "blue_win_probability": 0.572,
  "red_win_probability": 0.428,
  "predicted_winner": "T1",
  "confidence": "medium",
  "model": "logistic_regression_actions",
  "warnings": []
}
```

Schema rules:

- Probabilities are always blue/red side probabilities, not favorite/underdog only.
- Team names should preserve display names and also support optional normalized slugs later.
- Unknown IDs are allowed, but `league`, `start_time`, `blue_team`, and `red_team` should be present.
- Add fields, but do not rename or remove v1 fields without a schema version bump.

`lol-pros-analyzer` work:

- Public JSON writer for schedule predictions is implemented as `scripts/export_public_predictions.py`.
- Empty payload writer is implemented as `scripts/write_empty_public_predictions.py` so the URL remains stable when no schedule rows exist.
- Validator for required fields and probability bounds is implemented as `scripts/validate_public_predictions.py`.
- The training workflow exports, validates, summarizes, and publishes `public/pre_match_predictions.json` to GitHub Pages.
- `scripts/check_live_ops.py` now checks the public pre-match exporter, validator, empty writer, schema doc, workflow publication, and job summary wiring.

`lol_predictor` work:

- Parser/normalizer accepts this schema and ignores unknown fields.
- Matching helpers and UI render helpers are implemented.
- `scripts/check_pre_match_ui.mjs` verifies the feed, shared schema, match overlap, detail data, UI hooks, prediction panel DOM anchors, required panel CSS, and the actual prediction panel render/hide behavior.

### 4. Cloudflare Diagnostics

Status: `/api/diagnostics` endpoint implemented in `lol_predictor`; local Cloudflare-compatible preview checks pass. Re-run production smoke checks after each Cloudflare Pages deployment.

Scope:

- Add a small diagnostics endpoint or response metadata so operational state is visible without opening Actions logs.
- Start minimal, then expand.

Phase 1 diagnostics:

- Extend `/api/live-event` response with model/fallback metadata already present in `win_probability`. Implemented.
- Surface `source`, `warning`, `frame_timestamp`, model name, and validation display in the UI footer/meta. Implemented in the live refresh meta line.

Phase 2 diagnostics:

- Add `/api/diagnostics` Pages Function returning:
  - `live_model_available`
  - `live_model_name`
  - `live_model_exported_at`
  - `prediction_feed_url`
  - `prediction_feed_last_fetch_status`
  - `prediction_feed_generated_at`
  - `cloudflare_timestamp`
- Surface the compact diagnostics summary in `#opsMeta` when the endpoint is available. Implemented.
- If the local prediction feed is missing, diagnostics checks the configured remote feed and reports its status. Implemented.

Phase 3 diagnostics:

- Fetch `live_status.json` and `live_model_manifest.json` from `lol-pros-analyzer`. Implemented.
- Expose analyzer live readiness, production/display readiness, Worker check state, blocker/warning counts, and manifest availability from `/api/diagnostics`. Implemented.
- Expose `contract_ok` and concrete warning codes so the UI and smoke checker can distinguish endpoint reachability from a complete operational contract. Implemented.
- Expose the active prediction feed and a separate configured remote analyzer feed/schema probe so local bootstrap fallback does not hide a broken external analyzer Pages URL. Implemented.
- Show compact diagnostics in the low-noise `#opsMeta` line. Implemented.

Acceptance criteria:

- Debugging a stale or missing prediction does not require guessing whether the issue is UI, Cloudflare, model artifact, feed freshness, or upstream data.
- Diagnostics never break the main dashboard if unavailable.

Verification evidence:

- `node scripts/check_cloudflare_pages.mjs --base-url http://127.0.0.1:{port} --event-id test` passes against `scripts/serve_cloudflare_preview.mjs`.
- `node scripts/check_ops_meta.mjs --base-url http://127.0.0.1:{port}` passes against the same local preview and confirms compact ops text.
- `node scripts/check_pre_match_ui.mjs --docs-dir docs --match-id 115548128962971911` passes with 16 prediction rows and 16 match overlaps.
- Production should be verified with `node scripts/check_cloudflare_pages.mjs --base-url https://lol-predictor.pages.dev --event-id test` after the branch is deployed.
- The smoke check also checks `/site-contract.json`; if that route returns HTML or an older `contract_version`, the static Pages deployment itself is stale.
- The same smoke check defaults to Cloudflare-hosted bootstrap artifacts for `pre_match_predictions.json`, `live_status.json`, and `live_model_manifest.json`; external analyzer Pages URLs can be configured later without changing the UI contract.
- `/api/diagnostics` reports configured remote analyzer feed probe fields such as `remote_prediction_feed_available`, `remote_prediction_feed_last_fetch_status`, and `remote_prediction_schema_ok`; remote failures are surfaced through `artifact_warnings` without breaking local fallback.
- A manual `Smoke production contracts` GitHub Actions workflow is available in `lol_predictor` for post-deploy verification. It checks both endpoint/artifact JSON contracts and the pre-match UI render contract against the configured prediction feed URL. Use `require_live_win_probability=true` when probing a currently live event, and raise `prediction_ui_min_rows` / `prediction_ui_min_overlap` when a real analyzer feed should match the site schedule.

## Near-Term Execution Order

1. Commit and deploy the current `lol_predictor` branch with the compact prediction panel changes.
2. Run `node scripts/check_cloudflare_pages.mjs --base-url https://lol-predictor.pages.dev --event-id test` after deployment.
3. Run `node scripts/check_cloudflare_pages.mjs --base-url https://lol-predictor.pages.dev --event-id {realLiveEventId} --require-live-win-probability true` during a real live match.
4. Keep the Cloudflare-hosted bootstrap artifacts live, then replace or override them with analyzer-generated artifacts once GitHub Pages, Cloudflare, or Worker hosting is configured.
5. Re-run pre-match feed display against a real published analyzer feed using `scripts/check_pre_match_ui.mjs --prediction-feed-url {analyzerFeedUrl} --min-rows 1 --min-overlap 1`.
6. Tighten the dashboard layout around live/pre-match/ops signals once production contracts and analyzer publication are both green.

Deployment unblocker:

- `lol-pros-analyzer` now has a `Publish public artifacts` workflow that can publish schema-valid empty `pre_match_predictions.json`, `live_status.json`, and `live_model_manifest.json` before the full training workflow is green.
- Until the analyzer workflow can be dispatched, `lol_predictor` hosts schema-valid bootstrap artifacts itself. Live model readiness can still correctly report `bootstrap_empty` until training publishes a real model.
- `lol_predictor` now has a `Verify site contracts` workflow that runs JavaScript syntax checks, starts a local Cloudflare-compatible preview, and runs `scripts/check_cloudflare_pages.mjs` against the preview before deployment.
