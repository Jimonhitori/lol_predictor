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
    </section>

    <section class="panel detailHero">
      <div id="detailTeams" class="selectedMatch"></div>
      <div id="detailGames" class="gameList"></div>
    </section>

    <section class="grid detailGrid">
      <section class="panel">
        <h2>Model Sandbox</h2>
        <div class="modelSandboxValue"><span>Blue-side test output</span><strong id="detailPrediction">-</strong></div>
        <div id="detailInputs" class="table"></div>
      </section>
      <section class="panel">
        <h2>Player Rosters</h2>
        <div class="draftGrid">
          <div>
            <h2 id="blueRosterTitle">Blue</h2>
            <div id="blueRoster" class="rosterList"></div>
          </div>
          <div>
            <h2 id="redRosterTitle">Red</h2>
            <div id="redRoster" class="rosterList"></div>
          </div>
        </div>
      </section>
    </section>

    <section class="panel detailHero">
      <div class="sectionHead">
        <div>
          <h2>Draft Preview</h2>
          <p id="liveRefreshMeta">Auto refresh is starting...</p>
        </div>
        <span id="liveState" class="liveState">WAITING</span>
      </div>
      <div class="draftGrid">
        <div id="blueDraft"></div>
        <div id="redDraft"></div>
      </div>
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
.detailGrid { margin-bottom: 24px; }
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
.teamRecord { color: var(--muted); font-size: 13px; font-weight: 800; text-align: center; }
.winPill { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--muted); text-align: center; }
.matchInfo { min-width: 190px; color: var(--text); text-align: center; display: grid; gap: 5px; }
.matchInfoLeague { font-size: 16px; font-weight: 900; }
.matchInfoBo { color: var(--muted); font-size: 13px; font-weight: 800; letter-spacing: 0; }
.matchInfoScore { font-size: 13px; color: var(--muted); }
.matchInfoVs { font-size: 28px; line-height: 1; font-weight: 900; color: var(--text); }
.matchInfoStart { color: var(--muted); font-size: 13px; font-weight: 800; }
#centerPrediction, #detailPrediction { color: var(--accent); font-size: 22px; }
.modelSandboxValue { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 12px; background: #10161d; color: var(--muted); font-size: 12px; }
.detailHero { margin-bottom: 24px; }
.detailHero .sectionHead { margin-bottom: 18px; }
.draftGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.draftSlot { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 10px 0; font-size: 13px; }
.draftSlot.live b { color: var(--accent); }
.liveState { border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; color: var(--muted); font-size: 12px; font-weight: 800; }
.liveState.active { border-color: var(--accent); color: var(--accent); }
.rosterList { display: grid; gap: 8px; }
.playerCard { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #10161d; }
.playerCardTop { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
.playerCard strong { color: var(--text); }
.playerMeta { color: var(--muted); font-size: 12px; margin-top: 6px; }
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
const state = { options: null, detailMatchId: null, detailTimer: null, rosterKey: '' };
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

function teamBlock(team, recordId) {
  const image = team.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  const record = recordId
    ? `<span id="${recordId}" class="teamRecord">Loading 2026 record...</span>`
    : `<span>${escapeHtml(team.game_wins || '0')} wins</span>`;
  return `<div class="teamBlock">${image}<strong>${escapeHtml(team.name || team.code || '-')}</strong>${record}</div>`;
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
  state.detailMatchId = id;
  await refreshMatchDetail(true);
  state.detailTimer = window.setInterval(() => refreshMatchDetail(false), 20000);
}

async function refreshMatchDetail(initial) {
  const id = state.detailMatchId;
  const details = await api('/api/match?id=' + encodeURIComponent(id));
  if (!details.id) {
    $('matchTitle').textContent = 'Match not found';
    return;
  }
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('matchTitle').textContent = `${left.name || left.code || '-'} vs ${right.name || right.code || '-'}`;
  $('matchMeta').textContent = `${details.league || ''} · BO${details.best_of || '-'} · ${details.source || ''} · auto-refresh 20s`;
  $('detailTeams').innerHTML = `${teamBlock(left, 'blueTeamRecord')}${matchInfoBlock(details)}${teamBlock(right, 'redTeamRecord')}`;
  loadTeamRecords(left, right, details.league);
  $('detailGames').innerHTML = (details.games || []).map(game => `
    <div class="gameItem">
      <b>Game ${game.number} · ${escapeHtml(game.state)}</b>
      <span>Blue: ${escapeHtml(game.blue?.team_code || game.blue?.team_name || '-')}</span><br>
      <span>Red: ${escapeHtml(game.red?.team_code || game.red?.team_name || '-')}</span>
    </div>
  `).join('');
  setDetailInputs(details);
  renderLiveDraft(details);
  if (initial) await predictDetail(left, right, details.league);
  updateLiveRefreshMeta(details);
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
  const rosterKey = `${left.name || left.code || ''}|${right.name || right.code || ''}`;
  if (rosterKey !== state.rosterKey) {
    state.rosterKey = rosterKey;
    loadRosters(left, right);
  }
}

function draftSlots(side) {
  return ['Top','Jungle','Mid','Bot','Support'].map(role => `<div class="draftSlot"><span>${side} ${role}</span><b>TBD</b></div>`).join('');
}

function matchInfoBlock(details) {
  const bestOf = details.best_of || '-';
  const score = seriesScore(details.teams || []);
  return `
    <div class="matchInfo">
      <span class="matchInfoLeague">${escapeHtml(details.league || '-')}</span>
      <span class="matchInfoBo">BEST OF ${escapeHtml(bestOf)}</span>
      <span class="matchInfoScore">${escapeHtml(score)}</span>
      <strong class="matchInfoVs">VS</strong>
      <span class="matchInfoStart">${escapeHtml(startLine(details))}</span>
    </div>
  `;
}

function seriesScore(teams) {
  const left = teams[0]?.game_wins ?? '0';
  const right = teams[1]?.game_wins ?? '0';
  return `${left} - ${right}`;
}

function startLine(details) {
  const game = activeGame(details.games || []);
  const gameNumber = game?.number || 1;
  const bestOf = details.best_of || (details.games || []).length || '-';
  const time = localStartTime(details.start_time);
  if (!time) return `Game ${gameNumber} out of ${bestOf} start time TBD`;
  return `Game ${gameNumber} out of ${bestOf} will start at ${time}`;
}

function localStartTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function renderLiveDraft(details) {
  const game = activeGame(details.games || []);
  const live = game?.live || {};
  $('blueDraft').innerHTML = draftSideSlots('Blue', live.blue || []);
  $('redDraft').innerHTML = draftSideSlots('Red', live.red || []);
  const hasLiveDraft = Boolean((live.blue || []).length || (live.red || []).length);
  $('liveState').textContent = hasLiveDraft ? 'LIVE DATA' : (game?.state || 'WAITING').toUpperCase();
  $('liveState').classList.toggle('active', hasLiveDraft);
}

function activeGame(games) {
  return games.find(game => (game.live?.blue || []).length || (game.live?.red || []).length)
    || games.find(game => String(game.state || '').toLowerCase() !== 'unstarted')
    || games[0]
    || {};
}

function draftSideSlots(side, picks) {
  if (!picks.length) return draftSlots(side);
  return picks.map((pick, index) => `
    <div class="draftSlot live">
      <span>${side} ${['Top','Jungle','Mid','Bot','Support'][index] || `P${index + 1}`} ${escapeHtml(pick.player || '')}</span>
      <b>${escapeHtml(championLabel(pick))}</b>
    </div>
  `).join('');
}

function championLabel(pick) {
  if (!pick?.champion) return 'TBD';
  return String(pick.champion).match(/^\\d+$/) ? `Champion #${pick.champion}` : pick.champion;
}

function updateLiveRefreshMeta(details) {
  const updatedAt = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const liveGame = activeGame(details.games || []);
  const liveSource = liveGame?.live?.source ? ` · ${liveGame.live.source}` : '';
  $('liveRefreshMeta').textContent = `Last checked ${updatedAt}${liveSource}`;
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
}

async function loadRosters(blueTeam, redTeam) {
  const blueName = blueTeam.name || blueTeam.code || '';
  const redName = redTeam.name || redTeam.code || '';
  $('blueRosterTitle').textContent = blueName || 'Blue';
  $('redRosterTitle').textContent = redName || 'Red';
  const [blue, red] = await Promise.all([
    api('/api/roster?team=' + encodeURIComponent(blueName)),
    api('/api/roster?team=' + encodeURIComponent(redName)),
  ]);
  $('blueRoster').innerHTML = rosterCards(blue.players || []);
  $('redRoster').innerHTML = rosterCards(red.players || []);
}

async function loadTeamRecords(blueTeam, redTeam, league) {
  const blueName = blueTeam.name || blueTeam.code || '';
  const redName = redTeam.name || redTeam.code || '';
  const [blue, red] = await Promise.all([
    api('/api/team-record?team=' + encodeURIComponent(blueName) + '&league=' + encodeURIComponent(league || '')),
    api('/api/team-record?team=' + encodeURIComponent(redName) + '&league=' + encodeURIComponent(league || '')),
  ]);
  setTeamRecord('blueTeamRecord', blue);
  setTeamRecord('redTeamRecord', red);
}

function setTeamRecord(id, record) {
  const el = $(id);
  if (!el) return;
  el.textContent = record.record ? `${record.record} · ${record.label}` : '2026 record unavailable';
}

function rosterCards(players) {
  if (!players.length) return '<p>No local roster match yet.</p>';
  return players.map(player => `
    <div class="playerCard">
      <div class="playerCardTop"><strong>${escapeHtml(player.role)}</strong><strong>${escapeHtml(player.player)}</strong></div>
      <div class="playerMeta">${escapeHtml(player.games)} games · ${(player.winrate * 100).toFixed(1)}% WR · KDA ${Number(player.kda).toFixed(2)}</div>
      <div class="playerMeta">Top champs: ${escapeHtml(player.top_champions.join(', ') || '-')}</div>
    </div>
  `).join('');
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
                return self.send_json(match_detail_payload(context, match_id) if match_id else {})
            if parsed.path == "/api/roster":
                team = first_query(parse_qs(parsed.query), "team", "")
                return self.send_json(roster_payload(context.rows, team))
            if parsed.path == "/api/team-record":
                query = parse_qs(parsed.query)
                team = first_query(query, "team", "")
                league = first_query(query, "league", "")
                return self.send_json(team_record_payload(context.rows, team, league))
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


def match_detail_payload(context: AppContext, match_id: str) -> dict[str, object]:
    details = lolesports_event_details(match_id)
    if not details:
        return {}
    schedule_match = next((match for match in today_matches(context.rows, context.today_cache) if str(match.get("id")) == str(match_id)), {})
    if schedule_match:
        details["start_time"] = details.get("start_time") or schedule_match.get("start_time", "")
        details["status"] = details.get("status") or schedule_match.get("status", "")
    return details


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


def roster_payload(rows: pd.DataFrame, team: str) -> dict[str, object]:
    player_rows = rows[~rows["position"].eq("team")].copy()
    if player_rows.empty or not team:
        return {"team": team, "source": "oracles_elixir_local", "players": []}
    player_rows["_team_key"] = player_rows["teamname"].astype(str).map(_team_key)
    target_key = _team_key(team)
    team_rows = player_rows[player_rows["_team_key"].eq(target_key)].copy()
    if team_rows.empty:
        team_rows = _best_team_match(player_rows, target_key)
    if team_rows.empty:
        return {"team": team, "source": "oracles_elixir_local", "players": []}

    role_order = {"top": 1, "jng": 2, "mid": 3, "bot": 4, "sup": 5}
    players = []
    for role in ["top", "jng", "mid", "bot", "sup"]:
        role_rows = team_rows[team_rows["position"].eq(role)].copy()
        if role_rows.empty:
            continue
        latest = role_rows.sort_values("date").iloc[-1]
        player = str(latest["playername"])
        player_games = team_rows[team_rows["playername"].astype(str).eq(player)]
        kills = pd.to_numeric(player_games.get("kills"), errors="coerce").fillna(0)
        deaths = pd.to_numeric(player_games.get("deaths"), errors="coerce").fillna(0)
        assists = pd.to_numeric(player_games.get("assists"), errors="coerce").fillna(0)
        result = pd.to_numeric(player_games.get("result"), errors="coerce").fillna(0)
        top_champions = (
            player_games["champion"].dropna().astype(str).value_counts().head(3).index.tolist()
            if "champion" in player_games.columns
            else []
        )
        players.append(
            {
                "role": role.upper(),
                "role_order": role_order[role],
                "player": player,
                "team": str(latest["teamname"]),
                "games": int(len(player_games)),
                "winrate": float(result.mean()) if len(player_games) else 0.0,
                "kda": float((kills.sum() + assists.sum()) / max(1, deaths.sum())),
                "top_champions": top_champions,
                "last_seen": str(latest["date"]),
            }
        )
    players = sorted(players, key=lambda player: player["role_order"])
    for player in players:
        player.pop("role_order", None)
    return {"team": team, "matched_team": players[0]["team"] if players else "", "source": "oracles_elixir_local", "players": players}


def team_record_payload(rows: pd.DataFrame, team: str, league: str = "") -> dict[str, object]:
    team_rows = rows[rows["position"].eq("team")].copy()
    if team_rows.empty or not team:
        return {"team": team, "source": "oracles_elixir_local", "record": ""}
    if league:
        league_rows = team_rows[team_rows["league"].astype(str).eq(league)].copy()
        if not league_rows.empty:
            team_rows = league_rows
    team_rows["_team_key"] = team_rows["teamname"].astype(str).map(_team_key)
    target_key = _team_key(team)
    matched_rows = team_rows[team_rows["_team_key"].eq(target_key)].copy()
    if matched_rows.empty:
        matched_rows = _best_team_match(team_rows, target_key)
    if matched_rows.empty:
        return {"team": team, "source": "oracles_elixir_local", "record": ""}

    result = pd.to_numeric(matched_rows.get("result"), errors="coerce").fillna(0)
    games = int(len(matched_rows))
    wins = int(result.sum())
    losses = games - wins
    winrate = float(wins / games) if games else 0.0
    matched_league = str(matched_rows["league"].dropna().iloc[-1]) if "league" in matched_rows and not matched_rows.empty else league
    return {
        "team": team,
        "matched_team": str(matched_rows["teamname"].dropna().iloc[-1]),
        "league": matched_league,
        "games": games,
        "wins": wins,
        "losses": losses,
        "winrate": winrate,
        "record": f"{wins}-{losses} ({winrate:.1%})",
        "label": f"2026 {matched_league}" if matched_league else "2026",
        "source": "oracles_elixir_local",
    }


def _best_team_match(player_rows: pd.DataFrame, target_key: str) -> pd.DataFrame:
    keys = player_rows[["_team_key", "teamname"]].drop_duplicates()
    candidates = [
        key
        for key in keys["_team_key"].dropna().astype(str).unique()
        if key and (key in target_key or target_key in key)
    ]
    if not candidates:
        return player_rows.iloc[0:0].copy()
    return player_rows[player_rows["_team_key"].eq(candidates[0])].copy()


def _team_key(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


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
