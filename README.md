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

Download all currently published 2026 Riot patch notes:

```powershell
python -m lol_predictor.download_riot_patch_notes
```

Patch notes are saved under `data/patch_notes/`. The training pipeline uses
them by default when present, mapping Riot patch `26.09` to Oracle's Elixir API
patch `16.09`.

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
