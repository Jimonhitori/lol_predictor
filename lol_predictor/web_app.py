from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import joblib
import pandas as pd

from .data import load_match_rows, load_patch_notes
from .inference import build_prediction_row
from .league_groups import filter_leagues
from .patches import filter_patch, latest_patch
from .schedule import lolesports_event_details, today_matches


APP_HTML = """<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LoL Esports Predictor</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div>
        <h1>LoL Esports Predictor</h1>
        <p id="meta">loading...</p>
      </div>
      <div class="filters">
        <select id="leagueGroup">
          <option value="all">All tiers</option>
          <option value="major">Major</option>
          <option value="secondary">Secondary</option>
        </select>
        <select id="region">
          <option value="all">All regions</option>
          <option value="korea">Korea</option>
          <option value="china">China</option>
          <option value="emea">EMEA</option>
          <option value="americas">Americas</option>
          <option value="pacific">Pacific</option>
          <option value="international">International</option>
        </select>
      </div>
    </section>

    <section class="matchStrip panel">
      <div class="sectionHead">
        <div>
          <h2>Today's Matches</h2>
          <p id="matchSource">loading...</p>
        </div>
      </div>
      <div id="matches" class="matches"></div>
    </section>

    <section id="matchCenter" class="matchCenter panel">
      <div class="sectionHead">
        <div>
          <h2>Match Center</h2>
          <p id="selectedMatchMeta">Select a match to preview prediction context.</p>
        </div>
        <strong id="centerPrediction">-</strong>
      </div>
      <div id="selectedMatch" class="selectedMatch"></div>
      <div id="gameList" class="gameList"></div>
    </section>

    <section class="grid">
      <form id="predictForm" class="panel">
        <h2>Predict</h2>
        <div class="formGrid">
          <label>League <select id="league"></select></label>
          <label>Side <select id="side"><option>Blue</option><option>Red</option></select></label>
          <label>Team <input id="team" placeholder="T1"></label>
          <label>Opponent <input id="opponent" placeholder="Gen.G"></label>
          <label>Top <select id="top_champion"></select></label>
          <label>Jungle <select id="jng_champion"></select></label>
          <label>Mid <select id="mid_champion"></select></label>
          <label>Bot <select id="bot_champion"></select></label>
          <label>Support <select id="sup_champion"></select></label>
        </div>
        <button type="submit">Predict win probability</button>
        <output id="prediction">-</output>
      </form>

      <section class="panel">
        <h2>Latest Patch Meta</h2>
        <div id="champions" class="table"></div>
      </section>

      <section class="panel">
        <h2>Teams</h2>
        <div id="teams" class="table"></div>
      </section>
    </section>
  </main>
  <script src="/static/app.js"></script>
</body>
</html>
"""


MATCH_HTML = """<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Match Detail - LoL Esports Predictor</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div>
        <a class="backLink" href="/">Matches</a>
        <h1 id="matchTitle">Match Detail</h1>
        <p id="matchMeta">loading...</p>
      </div>
      <strong id="detailPrediction">-</strong>
    </section>

    <section class="panel detailHero">
      <div id="detailTeams" class="selectedMatch"></div>
      <div id="detailGames" class="gameList"></div>
    </section>

    <section class="grid">
      <section class="panel">
        <h2>Prediction Inputs</h2>
        <div id="detailInputs" class="table"></div>
      </section>
      <section class="panel">
        <h2>Draft Preview</h2>
        <div class="draftGrid">
          <div id="blueDraft"></div>
          <div id="redDraft"></div>
        </div>
      </section>
    </section>
  </main>
  <script src="/static/app.js"></script>
</body>
</html>
"""


APP_CSS = """
:root { color-scheme: dark; --bg:#101418; --panel:#171d23; --line:#2a333d; --text:#edf2f7; --muted:#9ba8b5; --accent:#27c7a7; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, Segoe UI, Arial, sans-serif; background: var(--bg); color: var(--text); }
.shell { max-width: 1280px; margin: 0 auto; padding: 24px; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 18px; }
h1, h2, p { margin: 0; }
h1 { font-size: 28px; }
h2 { font-size: 16px; margin-bottom: 14px; }
p, label { color: var(--muted); font-size: 13px; }
.filters { display: flex; gap: 8px; }
.grid { display: grid; grid-template-columns: 420px 1fr; gap: 16px; align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.backLink { display: inline-block; color: var(--accent); font-size: 13px; margin-bottom: 8px; text-decoration: none; }
.matchStrip { margin-bottom: 16px; }
.sectionHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.matches { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.match { display: block; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #111820; color: var(--text); cursor: pointer; font: inherit; text-align: inherit; text-decoration: none; }
.match:hover { border-color: var(--accent); }
.match .backLink { color: var(--accent); margin: 10px 0 0; }
.matchMeta { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.versus { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; font-weight: 800; }
.versus span:last-child { text-align: right; }
.cardTeam { display: grid; justify-items: center; gap: 6px; min-width: 0; text-align: center; }
.cardTeam img { width: 44px; height: 44px; object-fit: contain; }
.cardTeam span { color: var(--text); overflow-wrap: anywhere; }
.matchCenter { margin-bottom: 16px; }
.selectedMatch { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 18px; margin-bottom: 12px; }
.teamBlock { display: grid; justify-items: center; gap: 8px; min-width: 0; }
.teamBlock img { width: 64px; height: 64px; object-fit: contain; }
.teamBlock strong { text-align: center; overflow-wrap: anywhere; }
.winPill { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--muted); text-align: center; }
#centerPrediction, #detailPrediction { color: var(--accent); font-size: 22px; }
.detailHero { margin-bottom: 16px; }
.draftGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.draftSlot { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); padding: 8px 0; font-size: 13px; }
.gameList { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
.gameItem { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #10161d; font-size: 13px; }
.gameItem b { display: block; margin-bottom: 6px; }
.formGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
label { display: grid; gap: 6px; }
input, select, button { width: 100%; border-radius: 6px; border: 1px solid var(--line); background: #0f1419; color: var(--text); padding: 10px; }
button { margin-top: 14px; background: var(--accent); color: #08110f; font-weight: 700; cursor: pointer; }
output { display: block; margin-top: 12px; font-size: 28px; font-weight: 800; }
.table { display: grid; gap: 6px; }
.row { display: grid; grid-template-columns: minmax(120px, 1fr) 70px 70px 80px; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.row.header { color: var(--muted); font-size: 12px; }
@media (max-width: 900px) { .topbar, .filters { align-items: stretch; flex-direction: column; } .grid { grid-template-columns: 1fr; } .formGrid, .draftGrid { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .selectedMatch { grid-template-columns: 1fr; } }
"""


APP_JS = """
const state = { options: null };
const $ = (id) => document.getElementById(id);

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function qs() {
  return new URLSearchParams({ league_group: $('leagueGroup').value, region: $('region').value }).toString();
}

function fillSelect(id, values) {
  const el = $(id);
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function renderTable(id, rows, firstLabel) {
  const header = `<div class="row header"><span>${firstLabel}</span><span>Picks</span><span>Wins</span><span>Winrate</span></div>`;
  $(id).innerHTML = header + rows.map(r => `<div class="row"><span>${escapeHtml(r.name)}</span><span>${r.games ?? r.picks}</span><span>${r.wins}</span><span>${r.winrate}</span></div>`).join('');
}

async function loadOptions() {
  state.options = await api('/api/options');
  fillSelect('league', state.options.leagues);
  for (const id of ['top_champion','jng_champion','mid_champion','bot_champion','sup_champion']) fillSelect(id, state.options.champions);
  $('leagueGroup').value = 'major';
  setValue('league', 'LCK');
  $('team').value = 'T1';
  $('opponent').value = 'Gen.G';
  setValue('top_champion', 'Gnar');
  setValue('jng_champion', 'Xin Zhao');
  setValue('mid_champion', 'Ahri');
  setValue('bot_champion', 'Ashe');
  setValue('sup_champion', 'Rakan');
}

async function loadSummary() {
  const data = await api('/api/summary?' + qs());
  $('meta').textContent = `Patch ${data.patch} | ${data.games} games | ${data.leagues.join(', ')}`;
  renderTable('champions', data.champions, 'Champion');
  renderTable('teams', data.teams, 'Team');
}

async function loadMatches() {
  const data = await api('/api/matches/today?' + qs());
  $('matchSource').textContent = `${data.matches.length} matches | ${data.source}`;
  if (!data.matches.length) {
    $('matches').innerHTML = '<p>No matches for the selected filters.</p>';
    return;
  }
  $('matches').innerHTML = data.matches.map(match => `
    <a class="match" href="/match?id=${encodeURIComponent(match.id)}" data-id="${escapeHtml(match.id)}" data-blue="${escapeHtml(match.blue_team)}" data-red="${escapeHtml(match.red_team)}" data-league="${escapeHtml(match.league)}" data-bestof="${escapeHtml(match.best_of)}" data-status="${escapeHtml(match.status)}">
      <div class="matchMeta"><span>${escapeHtml(match.league)} · BO${escapeHtml(match.best_of || '-')}</span><span>${escapeHtml(match.status)}</span></div>
      <div class="versus">${matchCardTeam(match.blue_code || match.blue_team, match.blue_image)}<b>vs</b>${matchCardTeam(match.red_code || match.red_team, match.red_image)}</div>
      <span class="backLink">Details</span>
    </a>
  `).join('');
  for (const el of document.querySelectorAll('.match')) {
    el.addEventListener('mouseenter', () => selectMatch(el.dataset));
    el.addEventListener('focus', () => selectMatch(el.dataset));
  }
  selectMatch(document.querySelector('.match').dataset);
}

async function selectMatch(match) {
  setValue('league', match.league || $('league').value);
  $('team').value = match.blue || '';
  $('opponent').value = match.red || '';
  $('side').value = 'Blue';
  renderSelectedMatch({ teams: [{ name: match.blue, code: match.blue }, { name: match.red, code: match.red }], games: [], best_of: match.bestof, league: match.league, status: match.status });
  await predict();
  if (match.id) {
    try {
      const details = await api('/api/match?id=' + encodeURIComponent(match.id));
      if (details.id) renderSelectedMatch(details);
    } catch (error) {
      $('selectedMatchMeta').textContent = `${match.league || ''} · details unavailable`;
    }
  }
}

function renderSelectedMatch(details) {
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('selectedMatchMeta').textContent = `${details.league || $('league').value} · BO${details.best_of || '-'} · ${details.source || details.status || ''}`;
  $('selectedMatch').innerHTML = `
    ${teamBlock(left)}
    <div class="winPill"><span>Blue-side model</span><strong id="inlinePrediction">${$('prediction').textContent}</strong></div>
    ${teamBlock(right)}
  `;
  $('gameList').innerHTML = (details.games || []).map(game => `
    <div class="gameItem">
      <b>Game ${game.number} · ${escapeHtml(game.state)}</b>
      <span>Blue: ${escapeHtml(game.blue?.team_code || game.blue?.team_name || '-')}</span><br>
      <span>Red: ${escapeHtml(game.red?.team_code || game.red?.team_name || '-')}</span>
    </div>
  `).join('');
}

function teamBlock(team) {
  const image = team.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  return `<div class="teamBlock">${image}<strong>${escapeHtml(team.name || team.code || '-')}</strong><span>${escapeHtml(team.game_wins || '0')} wins</span></div>`;
}

function matchCardTeam(name, image) {
  const logo = image ? `<img src="${escapeHtml(image)}" alt="">` : '<span></span>';
  return `<span class="cardTeam">${logo}<span>${escapeHtml(name || '-')}</span></span>`;
}

async function predict(event) {
  if (event) event.preventDefault();
  const payload = {
    league: $('league').value, side: $('side').value, team: $('team').value, opponent: $('opponent').value,
    top_champion: $('top_champion').value, jng_champion: $('jng_champion').value, mid_champion: $('mid_champion').value,
    bot_champion: $('bot_champion').value, sup_champion: $('sup_champion').value
  };
  const response = await fetch('/api/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const data = await response.json();
  $('prediction').textContent = response.ok ? `${(data.win_probability * 100).toFixed(1)}%` : data.error;
  $('centerPrediction').textContent = $('prediction').textContent;
  const inline = $('inlinePrediction');
  if (inline) inline.textContent = $('prediction').textContent;
}

async function loadMatchDetailPage() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id || !$('matchTitle')) return;
  const details = await api('/api/match?id=' + encodeURIComponent(id));
  if (!details.id) {
    $('matchTitle').textContent = 'Match not found';
    return;
  }
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('matchTitle').textContent = `${left.name || left.code || '-'} vs ${right.name || right.code || '-'}`;
  $('matchMeta').textContent = `${details.league || ''} · BO${details.best_of || '-'} · ${details.source || ''}`;
  $('detailTeams').innerHTML = `${teamBlock(left)}<div class="winPill"><span>Blue-side model</span><strong id="inlinePrediction">-</strong></div>${teamBlock(right)}`;
  $('detailGames').innerHTML = (details.games || []).map(game => `
    <div class="gameItem">
      <b>Game ${game.number} · ${escapeHtml(game.state)}</b>
      <span>Blue: ${escapeHtml(game.blue?.team_code || game.blue?.team_name || '-')}</span><br>
      <span>Red: ${escapeHtml(game.red?.team_code || game.red?.team_name || '-')}</span>
    </div>
  `).join('');
  setDetailInputs(details);
  await predictDetail(left, right, details.league);
}

function setDetailInputs(details) {
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('detailInputs').innerHTML = `
    <div class="row"><span>League</span><span></span><span></span><span>${escapeHtml(details.league || '-')}</span></div>
    <div class="row"><span>Blue</span><span></span><span></span><span>${escapeHtml(left.name || '-')}</span></div>
    <div class="row"><span>Red</span><span></span><span></span><span>${escapeHtml(right.name || '-')}</span></div>
  `;
  $('blueDraft').innerHTML = draftSlots('Blue');
  $('redDraft').innerHTML = draftSlots('Red');
}

function draftSlots(side) {
  return ['Top','Jungle','Mid','Bot','Support'].map(role => `<div class="draftSlot"><span>${side} ${role}</span><b>TBD</b></div>`).join('');
}

async function predictDetail(left, right, league) {
  const payload = {
    league: league || 'LCK', side: 'Blue', team: left.name || left.code || '', opponent: right.name || right.code || '',
    top_champion: 'Gnar', jng_champion: 'Xin Zhao', mid_champion: 'Ahri', bot_champion: 'Ashe', sup_champion: 'Rakan'
  };
  const response = await fetch('/api/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const data = await response.json();
  const text = response.ok ? `${(data.win_probability * 100).toFixed(1)}%` : data.error;
  $('detailPrediction').textContent = text;
  const inline = $('inlinePrediction');
  if (inline) inline.textContent = text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function setValue(id, value) {
  const el = $(id);
  if ([...el.options].some(option => option.value === value)) el.value = value;
}

if ($('predictForm')) {
  for (const id of ['leagueGroup','region']) $(id).addEventListener('change', () => { loadSummary(); loadMatches(); });
  $('predictForm').addEventListener('submit', predict);
  loadOptions().then(() => { loadSummary(); loadMatches(); });
} else {
  loadMatchDetailPage();
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a local LoL esports predictor UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--model-path", type=Path, default=Path("models/2026_all_patches_lck_lpl_regions_synergy.joblib"))
    parser.add_argument("--patch-notes", type=Path, default=Path("data/patch_notes/riot_2024_2026_patch_notes.json"))
    parser.add_argument("--champion-reference", type=Path, default=Path("data/features/champion_reference.csv"))
    parser.add_argument("--today-cache", type=Path, default=Path("data/raw/today_matches.json"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    context = AppContext(args)
    handler = make_handler(context)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving http://{args.host}:{args.port}")
    server.serve_forever()


class AppContext:
    def __init__(self, args: argparse.Namespace) -> None:
        self.rows = load_match_rows(args.data_dir)
        self.patch = latest_patch(self.rows)
        self.patch_notes = load_patch_notes(args.patch_notes)
        self.champion_reference = load_patch_notes(args.champion_reference)
        self.model_bundle = joblib.load(args.model_path) if args.model_path.exists() else None
        self.today_cache = args.today_cache


def make_handler(context: AppContext) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                return self.send_text(APP_HTML, "text/html")
            if parsed.path == "/match":
                return self.send_text(MATCH_HTML, "text/html")
            if parsed.path == "/static/styles.css":
                return self.send_text(APP_CSS, "text/css")
            if parsed.path == "/static/app.js":
                return self.send_text(APP_JS, "application/javascript")
            if parsed.path == "/api/options":
                return self.send_json(options_payload(context.rows))
            if parsed.path == "/api/summary":
                return self.send_json(summary_payload(context.rows, parse_qs(parsed.query)))
            if parsed.path == "/api/matches/today":
                return self.send_json(matches_payload(context, parse_qs(parsed.query)))
            if parsed.path == "/api/match":
                match_id = first_query(parse_qs(parsed.query), "id", "")
                return self.send_json(lolesports_event_details(match_id) if match_id else {})
            self.send_error(HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:
            if self.path != "/api/predict":
                return self.send_error(HTTPStatus.NOT_FOUND)
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            try:
                result = predict_payload(context, payload)
            except Exception as error:  # noqa: BLE001
                return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return self.send_json(result)

        def send_text(self, body: str, content_type: str) -> None:
            encoded = body.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", f"{content_type}; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def send_json(self, body: object, status: HTTPStatus = HTTPStatus.OK) -> None:
            encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: object) -> None:
            return

    return Handler


def options_payload(rows: pd.DataFrame) -> dict[str, list[str]]:
    player_rows = rows[~rows["position"].eq("team")]
    return {
        "leagues": sorted(rows["league"].dropna().astype(str).unique().tolist()),
        "champions": sorted(player_rows["champion"].dropna().astype(str).unique().tolist()),
    }


def summary_payload(rows: pd.DataFrame, query: dict[str, list[str]]) -> dict[str, object]:
    league_group = first_query(query, "league_group", "all")
    region = first_query(query, "region", "all")
    filtered = filter_leagues(rows, league_group=league_group, region=region)
    patch = latest_patch(filtered)
    patch_rows = filter_patch(filtered, patch=str(patch))
    player_rows = patch_rows[~patch_rows["position"].eq("team")]
    team_rows = patch_rows[patch_rows["position"].eq("team")]
    return {
        "patch": str(patch),
        "games": int(patch_rows["gameid"].nunique()),
        "leagues": sorted(patch_rows["league"].dropna().astype(str).unique().tolist()),
        "champions": champion_rows(player_rows),
        "teams": team_rows_payload(team_rows),
    }


def matches_payload(context: AppContext, query: dict[str, list[str]]) -> dict[str, object]:
    league_group = first_query(query, "league_group", "all")
    region = first_query(query, "region", "all")
    matches = today_matches(context.rows, context.today_cache)
    filtered = [
        match
        for match in matches
        if (league_group == "all" or match.get("league_group") == league_group)
        and (region == "all" or match.get("region") == region)
    ]
    source = filtered[0].get("source", "none") if filtered else "none"
    return {"source": source, "matches": filtered}


def champion_rows(rows: pd.DataFrame) -> list[dict[str, object]]:
    data = (
        rows.groupby("champion")
        .agg(picks=("champion", "size"), wins=("result", "sum"))
        .assign(winrate=lambda frame: frame["wins"] / frame["picks"])
        .sort_values(["picks", "winrate"], ascending=[False, False])
        .head(20)
        .reset_index()
    )
    return [
        {"name": row.champion, "picks": int(row.picks), "wins": int(row.wins), "winrate": f"{row.winrate:.1%}"}
        for row in data.itertuples()
    ]


def team_rows_payload(rows: pd.DataFrame) -> list[dict[str, object]]:
    data = (
        rows.groupby("teamname")
        .agg(games=("teamname", "size"), wins=("result", "sum"))
        .assign(winrate=lambda frame: frame["wins"] / frame["games"])
        .sort_values(["games", "winrate"], ascending=[False, False])
        .head(20)
        .reset_index()
    )
    return [
        {"name": row.teamname, "games": int(row.games), "wins": int(row.wins), "winrate": f"{row.winrate:.1%}"}
        for row in data.itertuples()
    ]


def predict_payload(context: AppContext, payload: dict[str, object]) -> dict[str, float]:
    if context.model_bundle is None:
        raise ValueError("Model file not found. Train a model first.")
    row = build_prediction_row(
        payload,
        rows=context.rows,
        patch_notes=context.patch_notes,
        champion_reference=context.champion_reference,
        patch=str(context.patch),
    )
    feature_columns = context.model_bundle["feature_columns"]
    for column in feature_columns:
        if column not in row.columns:
            row[column] = None
    probability = float(context.model_bundle["pipeline"].predict_proba(row[feature_columns])[:, 1][0])
    return {"win_probability": probability}


def first_query(query: dict[str, list[str]], key: str, default: str) -> str:
    values = query.get(key)
    return values[0] if values else default


if __name__ == "__main__":
    main()
