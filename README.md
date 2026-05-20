# LoL Esports Win Predictor

League of Legends pro match prediction starter kit.

This project trains a match win-probability model from historical pro-game CSV
data such as Oracle's Elixir match data. It focuses on two practical prediction
moments:

- **Pre-draft**: team strength, side, region, patch, and recent form.
- **Post-draft**: pre-draft features plus champion picks by role.

The important rule is temporal safety: features for a game are built only from
games that happened before it.

## Data Sources

Good starting points:

- Oracle's Elixir match data downloads: https://lol.timsevenhuysen.com/matchdata/
- Riot Developer Portal for official LoL APIs: https://developer.riotgames.com/docs/lol
- Riot official esports data for live/pro feeds: https://riotesportsdata.com/en-us/league-of-legends

Oracle's Elixir match data is the default source for this starter kit. Its files
contain player rows, team rows, champion picks, role information, and match
results, so the project derives player/team/champion features from those files.
Player match stats such as kills, deaths, assists, gold@15, XP@15, CS@15,
damage to champions, and vision score are used only as rolling historical
averages, never as current-game inputs.

Download discovered Oracle's Elixir files:

```powershell
python -m lol_predictor.download_oracles_elixir --output-dir data/raw
```

List files without downloading:

```powershell
python -m lol_predictor.download_oracles_elixir --list
```

Download specific years or a direct CSV/XLSX URL:

```powershell
python -m lol_predictor.download_oracles_elixir --year 2020 --output-dir data/raw
python -m lol_predictor.download_oracles_elixir --url "https://example.com/file.csv"
```

The current Oracle's Elixir web app also exposes recent 2026 game details via
its public API. Use this when you want the newest patch data instead of older
download files:

```powershell
python -m lol_predictor.download_oe_api_recent --output data/raw/2026_oracles_elixir_api_recent_games.csv
```

Backfill 2026 data for major pro leagues through the Oracle's Elixir API:

```powershell
python -m lol_predictor.download_oe_api_2026 --output data/raw/2026_oracles_elixir_api_games.csv
```

The default 2026 API crawl includes current major regions such as LCK, LPL,
LEC, LCS, LCP, CBLOL, and selected secondary ecosystems. You can explicitly
backfill Korea and China like this:

```powershell
python -m lol_predictor.download_oe_api_2026 --league "LoL Champions Korea" --league "Tencent LoL Pro League" --output data/raw/2026_oracles_elixir_api_games_lck_lpl.csv
```

Use `--all-leagues` to crawl every 2026 tournament exposed by the API.

Filter summaries or training by league tier:

```powershell
python -m lol_predictor.patch_summary --data-dir data/raw --patch latest --league-group major
python -m lol_predictor.patch_summary --data-dir data/raw --patch latest --league-group secondary
python -m lol_predictor.patch_summary --data-dir data/raw --patch latest --region korea
python -m lol_predictor.patch_summary --data-dir data/raw --patch latest --region emea
python -m lol_predictor.train --data-dir data/raw --league-group major --model-path models/major.joblib
python -m lol_predictor.train --data-dir data/raw --league LCK --league LPL --model-path models/east.joblib
```

Download Riot patch notes from 2024 through the current 2026 patch cycle:

```powershell
python -m lol_predictor.download_riot_patch_notes
```

Patch notes are saved under `data/patch_notes/`. The training pipeline uses
them by default when present, mapping Riot patch `26.09` to Oracle's Elixir API
patch `16.09`. Champion reference data also records each champion's latest
detected change in the 2024-2026 patch-note window.

Build champion reference stats with patch-aware fallback:

```powershell
python -m lol_predictor.champion_reference --data-dir data/raw
```

This uses current-patch stats for champions mentioned in the current patch
notes, and historical stats for champions not changed in that patch. If no
historical rows are available, it falls back to current-patch rows and marks the
source as `current_patch_fallback`.

When `data/features/champion_reference.csv` exists, training automatically joins
these champion reference features into each drafted role.

Draft features also include common synergy and matchup signals:

- `bot_sup_pair`
- `jng_mid_pair`
- `top_jng_pair`
- role matchups such as `top_matchup` and `mid_matchup`

You can also manually place downloaded CSV files under `data/raw/`.

```text
data/
  raw/
    2024_LoL_esports_match_data_from_OraclesElixir.csv
    2025_LoL_esports_match_data_from_OraclesElixir.csv
```

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Train

```powershell
python -m lol_predictor.train --data-dir data/raw --model-path models/post_draft.joblib
```

## Live Win Probability

Collect normalized live frames from the Cloudflare live-event API into JSONL.
Use an interval of 30 seconds or less when building the dedicated live model:

```powershell
python -m lol_predictor.live_collect --event-id 115548128962971911 --output data/live_snapshots/t1_krx.jsonl --interval-seconds 20 --duration-minutes 120 --max-snapshots 0 --only-new-frame
```

Or let the collector discover current LCK matches from the static schedule
window:

```powershell
python -m lol_predictor.live_collect --auto-current --league LCK --region korea --interval-seconds 20 --duration-minutes 120 --max-snapshots 0 --only-new-frame
```

Train the dedicated live win-probability model once enough completed-game
frames have been collected:

```powershell
python -m lol_predictor.live_train data/live_snapshots/*.jsonl --model-path models/live_win_probability.joblib
```

Training expands shell globs on Windows and evaluates with a game-level split,
so frames from the same game do not appear in both train and test sets. Team
identity features are off by default to reduce small-sample overfitting; pass
`--include-team-features` when you explicitly want team-name priors inside the
live model.

Export the trained model to the static JSON format used by the Cloudflare live
API:

```powershell
python -m lol_predictor.live_export_model --model-path models/live_win_probability.joblib --output docs/static/data/live_model.json
```

The exported JSON includes the game-level test metrics saved by `live_train`.

Verify that the exported JSON model matches the source joblib bundle on a live
snapshot:

```powershell
python -m lol_predictor.live_verify_model --model-path models/live_win_probability.joblib --exported-model docs/static/data/live_model.json --input data/live_snapshots/example.jsonl
```

Run the full refresh pipeline in order:

```powershell
python -m lol_predictor.live_pipeline --league LCK --data-dir data/raw --labels data/live_labels.csv --backfill-dir data/live_snapshots/backfill_lck --model-path models/live_win_probability.joblib --exported-model docs/static/data/live_model.json --overwrite-backfill
```

Check whether the collected frames have enough labeled completed-game data:

```powershell
python -m lol_predictor.live_report data/live_snapshots
```

Backfill completed games from LoL Esports livestats. If the event API does not
include per-game winners, provide a label CSV with `game_id,winner` or
`game_id,blue_win`:

```powershell
python -m lol_predictor.live_backfill --event-id 115548128962971895 --labels data/live_labels.csv --interval-seconds 30
```

Generate that label CSV from Oracle's Elixir team result rows when the event
has already landed in your local OE data:

```powershell
python -m lol_predictor.live_labels --event-id 115548128962971895 --data-dir data/raw --output data/live_labels.csv
```

You can also discover completed LoL Esports events from schedule history and
backfill all labeled events:

```powershell
python -m lol_predictor.live_labels --discover-schedule --league LCK --data-dir data/raw --output data/live_labels.csv
python -m lol_predictor.live_backfill --event-ids-from-labels --labels data/live_labels.csv --interval-seconds 30
```

When the label CSV includes `source_date`, backfill uses it as the livestats
`startingTime` anchor so completed games can return a denser frame history.

Run realtime inference from the latest public live-event snapshot:

```powershell
python -m lol_predictor.live_predict --model-path models/live_win_probability.joblib --event-id 115548128962971911
```

The live model input schema is `live_frame_v1`, using game time, gold, kills,
towers, inhibitors, barons, dragons, level, CS, deaths, league, patch, side
teams, game number, and best-of context.

Focus training on the latest patch found in the data, or on the latest few
patches:

```powershell
python -m lol_predictor.train --data-dir data/raw --patch latest --model-path models/latest_patch.joblib
python -m lol_predictor.train --data-dir data/raw --recent-patches 3 --model-path models/recent_patches.joblib
```

Summarize the latest patch meta:

```powershell
python -m lol_predictor.patch_summary --data-dir data/raw --patch latest
```

## Predict

Create a JSON file like this:

```json
{
  "date": "2026-05-12",
  "league": "LCK",
  "patch": "16.9",
  "side": "Blue",
  "team": "T1",
  "opponent": "Gen.G",
  "top_champion": "Aatrox",
  "jng_champion": "Lee Sin",
  "mid_champion": "Azir",
  "bot_champion": "Kai'Sa",
  "sup_champion": "Rakan"
}
```

Then run:

```powershell
python -m lol_predictor.predict --model-path models/post_draft.joblib --input examples/prediction_input.json
```

## Local Web UI

```powershell
python -m lol_predictor.web_app --port 8765
```

Open http://127.0.0.1:8765 to inspect latest-patch meta by league tier/region
and run a draft-based win probability prediction.

The intended product flow is match-day first:

1. Load today's scheduled matches.
2. Click a match card to prefill league, blue side, and red side.
3. Add or update champion picks as draft information becomes available.
4. Show win probability from team, side, patch, champion, and historical form features.

If `CITO_API_KEY` is set, the web UI tries Cito's LoL live-match endpoint.
You can override the source with `CITO_LOL_MATCHES_URL` if you use a schedule
endpoint or a small proxy. Without an API key, it falls back to
`data/raw/today_matches.json` or the latest local Oracle's Elixir games so the
UI remains usable offline.

```powershell
$env:CITO_API_KEY = "your-api-key"
$env:CITO_LOL_MATCHES_URL = "https://your-schedule-source.example/lol/today"
python -m lol_predictor.web_app --port 8765
```

## Modeling Notes

The baseline intentionally starts simple:

- Logistic regression with one-hot categorical features.
- Rolling team/player/champion aggregates computed from past games only.
- Time-based split for validation.
- Brier score and log loss, because calibrated probabilities matter more than
  just accuracy.

Next useful upgrades:

- Add Elo/Glicko team ratings.
- Add player-level rolling stats by role.
- Add champion synergy and matchup features.
- Train separate pre-draft and post-draft models.
- Add calibration with isotonic regression or Platt scaling.
