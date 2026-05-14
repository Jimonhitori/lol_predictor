from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

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
          <h2>Matches</h2>
          <p id="matchSource">loading...</p>
        </div>
        <div class="matchScheduleTools">
          <input id="scheduleDate" class="scheduleDate" type="date" aria-label="Schedule date">
        </div>
      </div>
      <div id="dateTabs" class="dateTabs"></div>
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

      <section class="panel standingsPanel">
        <div class="panelTitleRow">
          <div>
            <h2>Regional Team Standings</h2>
            <p id="teamStandingsMeta" class="subtleText">Latest patch team-game results</p>
          </div>
          <select id="teamLeague" class="compactSelect" aria-label="Team standings league">
            <option value="league:LCK">LCK</option>
          </select>
        </div>
        <div id="teams" class="table standingsTable"></div>
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

    <section class="panel livePanel">
      <div id="liveBoard" class="liveBoard"></div>
      <p id="liveRefreshMeta" class="liveRefreshMeta">Auto refresh is starting...</p>
    </section>

    <section class="grid detailGrid">
      <div class="panelStack">
        <section class="panel h2hPanel">
          <h2>対戦履歴</h2>
          <div id="headToHead" class="h2hList"></div>
        </section>
        <section class="panel">
          <h2>Model Sandbox</h2>
          <div class="modelSandboxValue"><span>Blue-side test output</span><strong id="detailPrediction">-</strong></div>
          <div id="detailInputs" class="table"></div>
          <h2 class="subsectionTitle">2026 Game Record</h2>
          <div id="seasonRecords" class="table compactTable"></div>
        </section>
      </div>
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
  </main>
  <script src="/static/app.js"></script>
</body>
</html>
"""


APP_CSS = """
:root { color-scheme: dark; --bg:#101418; --panel:#171d23; --line:#2a333d; --text:#edf2f7; --muted:#9ba8b5; --accent:#27c7a7; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, Segoe UI, Arial, sans-serif; background: var(--bg); color: var(--text); }
.shell { max-width: 1280px; margin: 0 auto; padding: 28px 24px 40px; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 18px; }
h1, h2, p { margin: 0; }
h1 { font-size: 28px; }
h2 { font-size: 16px; margin-bottom: 14px; }
p, label { color: var(--muted); font-size: 13px; }
.filters { display: flex; gap: 8px; }
.grid { display: grid; grid-template-columns: 420px 1fr; gap: 18px; align-items: start; }
.detailGrid { margin-top: 18px; margin-bottom: 0; }
.panelStack { display: grid; gap: 18px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.hidden { display: none !important; }
.backLink { display: inline-block; color: var(--accent); font-size: 13px; margin-bottom: 8px; text-decoration: none; }
.matchStrip { margin-bottom: 16px; }
.panelTitleRow { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.panelTitleRow h2 { margin-bottom: 4px; }
.subtleText { color: var(--muted); font-size: 12px; margin: 0; }
.compactSelect { width: auto; min-width: 170px; padding: 7px 9px; font-size: 12px; }
.sectionHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.matchScheduleTools { display: flex; justify-content: flex-end; align-items: center; }
.scheduleDate { width: 42px; height: 38px; min-width: 42px; padding: 0; color: transparent; color-scheme: dark; background: #202832; border-color: #2b3541; cursor: pointer; }
.scheduleDate::-webkit-calendar-picker-indicator { width: 22px; height: 22px; margin: 0 auto; cursor: pointer; filter: invert(74%) sepia(69%) saturate(533%) hue-rotate(7deg) brightness(98%) contrast(89%); }
.scheduleDate::-webkit-datetime-edit { display: none; }
.dateTabs { display: grid; grid-template-columns: repeat(var(--date-tab-count, 4), minmax(0, 1fr)); width: 100%; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #111820; margin: 0 0 12px; overflow: hidden; }
.dateTabs .dateTab { width: 100%; min-width: 0; margin: 0; border: 0; border-right: 1px solid #202a34; border-radius: 0; padding: 7px 8px; background: transparent; color: var(--muted); text-align: center; cursor: pointer; font-size: 11px; line-height: 1.15; font-weight: 700; }
.dateTabs .dateTab:last-child { border-right: 0; }
.dateTabs .dateTab strong { display: block; color: #dbe5f4; font-size: 12px; font-weight: 900; }
.dateTabs .dateTab.live strong { color: #ff5b66; }
.dateTabs .dateTab.active { box-shadow: inset 0 0 0 1px #d6c56b; background: #2b3038; color: #dfe8f7; }
.dateTabs .dateTab.active strong { color: #ffffff; }
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
.selectedMatch { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; margin-bottom: 10px; }
.selectedMatch.twoTeams { grid-template-columns: minmax(0, 280px) minmax(0, 280px); justify-content: center; }
.teamBlock { display: grid; grid-template-rows: auto minmax(38px, auto) 20px 22px; align-items: center; justify-items: center; gap: 6px; min-width: 0; }
.teamBlock img { width: 64px; height: 64px; object-fit: contain; }
.teamBlock strong { text-align: center; overflow-wrap: anywhere; }
.teamRecord { color: var(--muted); font-size: 13px; font-weight: 800; text-align: center; }
.winnerSlot { min-height: 22px; display: grid; place-items: center; }
.winnerBadge { border-radius: 999px; background: rgba(56, 215, 123, .16); border: 1px solid rgba(56, 215, 123, .45); color: #38d77b; padding: 2px 8px; font-size: 11px; font-weight: 900; text-transform: uppercase; }
.winPill { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--muted); text-align: center; }
.matchInfo { min-width: 200px; color: var(--text); text-align: center; display: grid; gap: 5px; }
.matchInfoLeague { font-size: 16px; font-weight: 900; }
.matchInfoBo { color: var(--muted); font-size: 13px; font-weight: 800; letter-spacing: 0; }
.matchInfoScore { font-size: 13px; color: var(--muted); }
.matchInfoVs { font-size: 24px; line-height: 1; font-weight: 900; color: var(--text); margin: 0; }
.matchInfoStart { color: var(--muted); font-size: 13px; font-weight: 800; margin-top: 2px; }
#centerPrediction, #detailPrediction { color: var(--accent); font-size: 22px; }
.modelSandboxValue { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 12px; background: #10161d; color: var(--muted); font-size: 12px; }
.detailHero { margin-bottom: 18px; padding: 14px 16px; }
.detailHero .sectionHead { margin-bottom: 18px; }
.draftGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.draftSlot { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 10px 0; font-size: 13px; }
.draftSlot.live b { color: var(--accent); }
.liveState { border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; color: var(--muted); font-size: 12px; font-weight: 800; }
.liveState.active { border-color: var(--accent); color: var(--accent); }
.livePanel { background: #10191d; padding: 0 24px 20px; overflow: hidden; margin: 0 0 22px; width: 100%; border-radius: 4px; }
.liveBoard { color: #c8dbff; }
.liveContent { max-width: 1080px; margin: 0 auto; }
.liveTabs { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0 -24px 24px; }
.liveTab { width: 100%; margin: 0; border: 0; border-right: 2px solid #11161b; border-radius: 0; background: #2b3038; box-shadow: inset 0 -2px 5px rgba(0,0,0,.45); padding: 9px 10px; text-align: center; font-size: 16px; font-weight: 500; color: #c7d8fb; cursor: pointer; }
.liveTab:hover, .liveTab:focus-visible { background: #343b46; outline: 1px solid #52627a; outline-offset: -1px; }
.liveTab.active { background: #11181d; }
.liveTop { display: grid; grid-template-columns: 1fr 190px 1fr; align-items: end; gap: 18px; margin-bottom: 22px; }
.liveTeamHead { display: grid; justify-items: center; gap: 10px; min-width: 0; }
.liveTeamHead img { width: 64px; height: 64px; object-fit: contain; border-radius: 4px; background: #2a2f37; padding: 6px; }
.liveTeamHead strong { color: #d7e5ff; text-align: center; overflow-wrap: anywhere; }
.liveCenter { display: grid; justify-items: center; gap: 5px; align-self: center; }
.liveBadge { background: #2f8a35; border-radius: 999px; padding: 5px 12px; color: #f5fff5; font-size: 16px; font-weight: 900; text-align: center; }
.liveBadge.warning { background: #6b5a2e; color: #ffe9a8; }
.liveTimer { font-size: 18px; font-weight: 900; color: #cdddff; }
.liveStatsLine { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-bottom: 18px; position: relative; }
.liveStatsLine::after { content: ""; position: absolute; left: 0; right: 0; bottom: -6px; height: 2px; background: linear-gradient(90deg, #36a9e8 0 50%, #ff456a 50% 100%); opacity: .95; }
.liveStatsSide { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.liveStat { display: grid; justify-items: center; gap: 4px; color: #c9d9f6; font-size: 18px; font-weight: 500; }
.liveStat b { color: #43b9f6; font-size: 12px; }
.liveStatsSide.red .liveStat b { color: #ff4770; }
.livePlayers { display: grid; gap: 4px; padding-top: 8px; }
.liveTeamRows { display: grid; grid-template-columns: 190px 240px 186px 70px 30px 30px 30px 116px 120px; gap: 0; column-gap: 3px; align-items: center; width: 100%; }
.liveTeamRows + .liveTeamRows { margin-top: 4px; }
.liveRowsHeader { color: #cdddff; font-weight: 900; }
.liveRowsTitle { font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.livePlayer { color: #d7e5ff; }
.liveChampion { display: grid; grid-template-columns: 36px 1fr; gap: 8px; align-items: center; min-width: 0; }
.liveChampion img { width: 32px; height: 32px; border-radius: 50%; background: #262c35; }
.liveChampionPlaceholder { width: 24px; height: 24px; border-radius: 50%; background: #202833; border: 1px solid #3a4554; display: grid; place-items: center; color: #8290a3; font-size: 9px; font-weight: 900; }
.liveChampion strong, .liveChampion span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.liveChampion strong { font-size: 16px; line-height: 1.05; }
.liveChampion small { display: block; color: #b7c6df; font-size: 9px; margin-top: 1px; }
.liveChampion.pending strong { color: #aab7c9; font-size: 12px; text-transform: uppercase; }
.healthBar { height: 28px; border-radius: 4px; background: #2a3138; overflow: hidden; position: relative; }
.healthFill { height: 100%; background: #3f9638; min-width: 0; }
.healthText { position: absolute; inset: 0; display: grid; place-items: center; color: #d9e6ff; font-size: 12px; }
.liveCell { background: #2c313a; border-radius: 4px; min-height: 28px; display: grid; place-items: center; color: #d8e5ff; font-size: 12px; }
.liveCell.delta { font-weight: 900; }
.liveCell.delta.positive { color: #38d77b; }
.liveCell.delta.negative { color: #ff4c72; }
.liveCell.delta.neutral { color: #d8e5ff; }
.liveItems { min-height: 20px; }
.itemSlots { display: grid; grid-template-columns: repeat(7, 24px); gap: 3px; align-items: center; justify-content: start; }
.itemSlot { width: 24px; height: 24px; border-radius: 3px; background: #242a33; border: 1px solid #343d49; }
.itemSlot img { width: 100%; height: 100%; object-fit: cover; border-radius: 2px; display: block; }
.liveRefreshMeta { margin-top: 8px; font-size: 12px; }
.rosterList { display: grid; gap: 8px; }
.playerCard { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #10161d; }
.playerCardTop { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
.playerCard strong { color: var(--text); }
.playerMeta { color: var(--muted); font-size: 12px; margin-top: 6px; }
.gameList { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
.gameItem { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: #10161d; font-size: 12px; }
.gameItem b { display: block; margin-bottom: 4px; }
.gameWinner { display: inline-block; margin-top: 5px; color: #38d77b; font-weight: 900; }
.formGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
label { display: grid; gap: 6px; }
input, select, button { width: 100%; border-radius: 6px; border: 1px solid var(--line); background: #0f1419; color: var(--text); padding: 10px; }
button { margin-top: 14px; background: var(--accent); color: #08110f; font-weight: 700; cursor: pointer; }
output { display: block; margin-top: 12px; font-size: 28px; font-weight: 800; }
.table { display: grid; gap: 6px; }
.row { display: grid; grid-template-columns: minmax(120px, 1fr) 70px 70px 80px; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.row.header { color: var(--muted); font-size: 12px; }
.standingsTable .row { grid-template-columns: 42px minmax(160px, 1fr) 70px 70px 80px; align-items: center; }
.rankCell { color: var(--muted); font-weight: 900; }
.championMetaRow { grid-template-columns: minmax(160px, 1fr) 70px 70px 80px; align-items: center; }
.championMetaCell { display: flex; align-items: center; gap: 9px; min-width: 0; font-weight: 800; }
.championMetaCell img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; background: #222b35; border: 1px solid #344150; }
.championMetaCell span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compactTable .row { grid-template-columns: minmax(80px, 1fr) 80px 80px 80px; padding: 6px 0; }
.subsectionTitle { margin-top: 14px; }
.h2hPanel { background: #2d343d; border-color: #343d49; padding: 10px 16px 12px; }
.h2hPanel h2 { color: #d5dbe4; font-size: 15px; margin-bottom: 10px; }
.h2hList { display: grid; gap: 0; }
.h2hLogoStrip { display: grid; grid-template-columns: repeat(5, 1fr); border-radius: 3px; overflow: hidden; margin-bottom: 10px; background: #4f4566; }
.h2hLogoCell { min-height: 38px; display: grid; place-items: center; border-right: 1px solid #323945; }
.h2hLogoCell:last-child { border-right: 0; }
.h2hLogoCell img { width: 22px; height: 22px; object-fit: contain; }
.h2hLogoFallback { color: #ff3d4e; font-size: 11px; font-weight: 900; }
.h2hRow { display: grid; grid-template-columns: 64px minmax(86px, 1fr) 22px 54px 22px minmax(80px, 1fr); gap: 8px; align-items: center; border-top: 1px solid #3b444f; padding: 10px 0; font-size: 13px; min-width: 0; }
.h2hDate { color: #b2bdc9; white-space: nowrap; }
.h2hTeam { color: #b7c0cc; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.h2hTeam.isWinner { color: #f1f5f9; }
.h2hTeam.isRight { text-align: left; }
.h2hMiniLogo { width: 20px; height: 20px; display: grid; place-items: center; }
.h2hMiniLogo img { width: 20px; height: 20px; object-fit: contain; }
.h2hScore { justify-self: center; border-radius: 5px; padding: 4px 10px; background: #252b34; color: #f3f6fb; font-weight: 900; line-height: 1; white-space: nowrap; }
.h2hEmpty { color: var(--muted); font-size: 12px; }
@media (max-width: 1100px) { .liveTeamRows { grid-template-columns: 160px minmax(120px, 1fr) 70px 30px 30px 30px 92px; } .liveItems, .liveRowsHeader.items, .liveCell.delta, .liveRowsHeader.delta { display: none; } }
@media (max-width: 900px) { .topbar, .filters { align-items: stretch; flex-direction: column; } .grid { grid-template-columns: 1fr; } .formGrid, .draftGrid { grid-template-columns: 1fr; } .liveTop { grid-template-columns: 1fr; } .liveStatsLine { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .h2hRow { grid-template-columns: 58px minmax(64px, 1fr) 18px 48px 18px minmax(64px, 1fr); gap: 5px; font-size: 12px; } }
@media (max-width: 640px) { .selectedMatch { grid-template-columns: 1fr; } }
"""


APP_JS = """
const state = { options: null, detailMatchId: null, detailTimer: null, liveClockTimer: null, rosterKey: '', selectedLiveGameId: '', rosters: {}, currentDetails: null, allMatches: [], selectedMatchDate: '', matchSource: '', liveFrames: {}, teamStanding: 'league:LCK' };
const $ = (id) => document.getElementById(id);
const STATIC_SITE = Boolean(window.STATIC_SITE);

async function api(path) {
  if (STATIC_SITE) return staticApi(path);
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function staticApi(path) {
  const url = new URL(path, location.origin);
  const params = url.searchParams;
  let target = '';
  if (url.pathname === '/api/options') {
    target = 'static/data/options.json';
  } else if (url.pathname === '/api/summary') {
    target = params.get('league')
      ? `static/data/summaries/league__${staticKey(params.get('league'))}.json`
      : `static/data/summaries/${staticKey(params.get('league_group') || $('leagueGroup')?.value || 'all')}__${staticKey(params.get('region') || $('region')?.value || 'all')}.json`;
  } else if (url.pathname === '/api/matches/today') {
    target = `static/data/matches-${staticKey($('leagueGroup')?.value || params.get('league_group') || 'all')}__${staticKey($('region')?.value || params.get('region') || 'all')}.json`;
  } else if (url.pathname === '/api/match') {
    target = `static/data/matches/${encodeURIComponent(params.get('id') || '')}.json`;
  } else if (url.pathname === '/api/roster') {
    target = `static/data/rosters/${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/team-record') {
    target = `static/data/team-records/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/head-to-head') {
    target = `static/data/h2h/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team_a') || '')}__${staticKey(params.get('team_b') || '')}.json`;
  }
  if (!target) throw new Error(`Static data route is not available: ${path}`);
  const response = await fetch(target);
  if (!response.ok) throw new Error(`Static data missing: ${target}`);
  return response.json();
}

function staticKey(value) {
  return String(value || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
}

async function postPredict(payload) {
  if (STATIC_SITE) return { ok: false, skipped: true, data: { error: '' } };
  const response = await fetch('/api/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  return { ok: response.ok, data: await response.json() };
}

function qs() {
  return new URLSearchParams({ league_group: $('leagueGroup').value, region: $('region').value }).toString();
}

function fillSelect(id, values) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function renderTable(id, rows, firstLabel) {
  const header = `<div class="row header"><span>${firstLabel}</span><span>Picks</span><span>Wins</span><span>Winrate</span></div>`;
  $(id).innerHTML = header + rows.map(r => `<div class="row"><span>${escapeHtml(r.name)}</span><span>${r.games ?? r.picks}</span><span>${r.wins}</span><span>${r.winrate}</span></div>`).join('');
}

const STANDINGS_LEAGUES = ['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'VCS', 'TCL', 'LFL', 'LCKC'];

function renderTeamStandings(rows) {
  const header = '<div class="row header"><span>#</span><span>Team</span><span>Games</span><span>Wins</span><span>Winrate</span></div>';
  $('teams').innerHTML = header + rows.map((r, index) => `
    <div class="row">
      <span class="rankCell">${index + 1}</span>
      <span>${escapeHtml(r.name)}</span>
      <span>${r.games ?? r.picks}</span>
      <span>${r.wins}</span>
      <span>${r.winrate}</span>
    </div>
  `).join('');
}

function fillTeamStandingSelect() {
  const select = $('teamLeague');
  if (!select || !state.options) return;
  const optionLeagues = new Set((state.options.leagues || []).map(league => String(league)));
  const leagues = (state.options.standings_leagues || []).length
    ? (state.options.standings_leagues || []).map(league => String(league)).filter(Boolean)
    : STANDINGS_LEAGUES.filter(league => optionLeagues.has(league));
  const options = leagues.map(league => [`league:${league}`, league]);
  select.innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  select.value = options.some(([value]) => value === state.teamStanding) ? state.teamStanding : (options[0]?.[0] || 'league:LCK');
  state.teamStanding = select.value;
}

function renderChampionTable(id, rows, patch) {
  const version = ddragonVersion(patch);
  const header = `<div class="row header championMetaRow"><span>Champion</span><span>Picks</span><span>Wins</span><span>Winrate</span></div>`;
  $(id).innerHTML = header + rows.map(r => `
    <div class="row championMetaRow">
      <span class="championMetaCell">
        ${championImage(r.name, version)}
        <span>${escapeHtml(championDisplayName(r.name))}</span>
      </span>
      <span>${r.games ?? r.picks}</span>
      <span>${r.wins}</span>
      <span>${r.winrate}</span>
    </div>
  `).join('');
}

async function loadOptions() {
  state.options = await api('/api/options');
  fillSelect('league', state.options.leagues);
  for (const id of ['top_champion','jng_champion','mid_champion','bot_champion','sup_champion']) fillSelect(id, state.options.champions);
  $('leagueGroup').value = 'major';
  fillTeamStandingSelect();
  setValue('league', 'LCK');
  if ($('team')) $('team').value = 'T1';
  if ($('opponent')) $('opponent').value = 'Gen.G';
  setValue('top_champion', 'Gnar');
  setValue('jng_champion', 'Xin Zhao');
  setValue('mid_champion', 'Ahri');
  setValue('bot_champion', 'Ashe');
  setValue('sup_champion', 'Rakan');
}

async function loadSummary() {
  const data = await api('/api/summary?' + qs());
  $('meta').textContent = `Patch ${data.patch} | ${data.games} games | ${data.leagues.join(', ')}`;
  renderChampionTable('champions', data.champions, data.patch);
  await loadTeamStandings();
}

async function loadTeamStandings() {
  if (!$('teams')) return;
  const selection = $('teamLeague')?.value || state.teamStanding || 'group:major';
  state.teamStanding = selection;
  const [kind, value] = selection.split(':');
  const params = new URLSearchParams({ league: kind === 'league' ? (value || 'LCK') : 'LCK' });
  const data = await api('/api/summary?' + params.toString());
  renderTeamStandings(data.teams || []);
  const label = $('teamLeague')?.selectedOptions?.[0]?.textContent || 'LCK';
  $('teamStandingsMeta').textContent = `${label} · Patch ${data.patch} · ${data.games} games`;
}

async function loadMatches() {
  const data = await api('/api/matches/today?' + qs());
  state.allMatches = data.matches || [];
  state.matchSource = data.source || 'none';
  if (!state.selectedMatchDate) {
    state.selectedMatchDate = defaultMatchDate(state.allMatches);
  }
  renderDateTabs(state.allMatches);
  renderMatches();
}

function renderMatches() {
  const matches = filteredMatches();
  $('matchSource').textContent = `${matches.length} / ${state.allMatches.length} matches | ${state.matchSource || 'none'}`;
  if (!matches.length) {
    $('matches').innerHTML = '<p>No matches for the selected filters.</p>';
    return;
  }
  $('matches').innerHTML = matches.map(match => `
    <a class="match" href="${detailHref(match.id)}" data-id="${escapeHtml(match.id)}" data-blue="${escapeHtml(match.blue_team)}" data-red="${escapeHtml(match.red_team)}" data-league="${escapeHtml(match.league)}" data-bestof="${escapeHtml(match.best_of)}" data-status="${escapeHtml(match.status)}">
      <div class="matchMeta"><span>${escapeHtml(match.league)} · BO${escapeHtml(match.best_of || '-')}</span><span>${escapeHtml(matchStatusLabel(match))}</span></div>
      <div class="matchMeta"><span>${escapeHtml(matchStartLabel(match.start_time))}</span><span>${escapeHtml(matchDateLabel(match.start_time))}</span></div>
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

function detailHref(id) {
  return `${STATIC_SITE ? 'match.html' : '/match'}?id=${encodeURIComponent(id || '')}`;
}

function renderDateTabs(matches) {
  let dateOptions = matchDateOptions(matches);
  if (state.selectedMatchDate && state.selectedMatchDate !== 'live' && !dateOptions.some(option => option.key === state.selectedMatchDate)) {
    const date = dateFromLocalKey(state.selectedMatchDate);
    dateOptions.push({
      key: state.selectedMatchDate,
      title: new Intl.DateTimeFormat('ja-JP', { weekday: 'short' }).format(date),
      sub: new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date),
    });
    dateOptions.sort((a, b) => a.key.localeCompare(b.key));
  }
  dateOptions = visibleDateOptions(dateOptions);
  const tabs = [
    { key: 'live', title: 'LIVE', sub: `${liveMatches(matches).length}` },
    ...dateOptions,
  ];
  const picker = $('scheduleDate');
  if (picker && state.selectedMatchDate !== 'live') picker.value = state.selectedMatchDate || '';
  const dateTabs = $('dateTabs');
  dateTabs.style.setProperty('--date-tab-count', String(tabs.length || 1));
  dateTabs.innerHTML = tabs.map(tab => `
    <button type="button" class="dateTab ${tab.key === 'live' ? 'live' : ''} ${tab.key === state.selectedMatchDate ? 'active' : ''}" data-date-key="${escapeHtml(tab.key)}">
      <strong>${escapeHtml(tab.title)}</strong>
      <span>${escapeHtml(tab.sub)}</span>
    </button>
  `).join('');
  for (const tab of document.querySelectorAll('.dateTab')) {
    tab.addEventListener('click', () => {
      state.selectedMatchDate = tab.dataset.dateKey || '';
      renderDateTabs(state.allMatches);
      renderMatches();
    });
  }
}

function visibleDateOptions(options) {
  const today = localDateKey(new Date().toISOString());
  const futureOrToday = options.filter(option => option.key >= today);
  if (!state.selectedMatchDate || state.selectedMatchDate === 'live') {
    return futureOrToday.slice(0, 3);
  }
  if (state.selectedMatchDate === today) {
    return futureOrToday.slice(0, 3);
  }
  if (options.length <= 3) return options;
  const selected = state.selectedMatchDate && state.selectedMatchDate !== 'live'
    ? options.findIndex(option => option.key === state.selectedMatchDate)
    : options.findIndex(option => option.key === localDateKey(new Date().toISOString()));
  const center = selected >= 0 ? selected : 0;
  const start = Math.max(0, Math.min(center - 1, options.length - 3));
  return options.slice(start, start + 3);
}

function filteredMatches() {
  if (state.selectedMatchDate === 'live') return liveMatches(state.allMatches);
  return state.allMatches.filter(match => localDateKey(match.start_time) === state.selectedMatchDate);
}

function liveMatches(matches) {
  return matches.filter(match => String(match.status || '').toLowerCase() === 'inprogress');
}

function defaultMatchDate(matches) {
  const today = localDateKey(new Date().toISOString());
  if (matches.some(match => localDateKey(match.start_time) === today)) return today;
  if (liveMatches(matches).length) return 'live';
  return matchDateOptions(matches)[0]?.key || 'live';
}

function matchDateOptions(matches) {
  const keys = [...new Set(matches.map(match => localDateKey(match.start_time)).filter(Boolean))].sort();
  return keys.map(key => {
    const date = dateFromLocalKey(key);
    const weekday = new Intl.DateTimeFormat('ja-JP', { weekday: 'short' }).format(date);
    const md = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date);
    const isToday = key === localDateKey(new Date().toISOString());
    return { key, title: isToday ? '今日' : weekday, sub: md };
  });
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromLocalKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function matchDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(date);
}

function matchStartLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'start TBD';
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(date);
}

async function selectMatch(match) {
  setValue('league', match.league || $('league')?.value || '');
  if ($('team')) $('team').value = match.blue || '';
  if ($('opponent')) $('opponent').value = match.red || '';
  if ($('side')) $('side').value = 'Blue';
  renderSelectedMatch({ teams: [{ name: match.blue, code: match.blue }, { name: match.red, code: match.red }], games: [], best_of: match.bestof, league: match.league, status: match.status });
  if (!STATIC_SITE && $('prediction')) await predict();
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
  $('selectedMatchMeta').textContent = `${details.league || $('league')?.value || ''} · BO${details.best_of || '-'} · ${details.source || details.status || ''}`;
  $('selectedMatch').className = `selectedMatch ${STATIC_SITE ? 'twoTeams' : ''}`;
  const seriesWinner = completedSeriesWinner(details);
  $('selectedMatch').innerHTML = `
    ${teamBlock(left, '', seriesWinner)}
    ${STATIC_SITE ? '' : `<div class="winPill"><span>Blue-side model</span><strong id="inlinePrediction">${$('prediction')?.textContent || '-'}</strong></div>`}
    ${teamBlock(right, '', seriesWinner)}
  `;
  $('gameList').innerHTML = gameListHtml(details);
}

function teamBlock(team, recordId, winnerTeam) {
  const image = team.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  const record = recordId
    ? `<span id="${recordId}" class="teamRecord">Loading 2026 record...</span>`
    : `<span>${escapeHtml(team.game_wins || '0')} wins</span>`;
  const winner = winnerTeam && sameTeamIdentity(team, winnerTeam) ? '<span class="winnerBadge">Winner</span>' : '';
  return `<div class="teamBlock">${image}<strong>${escapeHtml(team.name || team.code || '-')}</strong>${record}<span class="winnerSlot">${winner}</span></div>`;
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
  const result = await postPredict(payload);
  if (result.skipped) {
    $('prediction').textContent = '-';
    if ($('centerPrediction')) $('centerPrediction').textContent = '';
    const inline = $('inlinePrediction');
    if (inline) inline.textContent = '';
    return;
  }
  const data = result.data;
  $('prediction').textContent = result.ok ? `${(data.win_probability * 100).toFixed(1)}%` : data.error;
  if ($('centerPrediction')) $('centerPrediction').textContent = $('prediction').textContent;
  const inline = $('inlinePrediction');
  if (inline) inline.textContent = $('prediction').textContent;
}

async function loadMatchDetailPage() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id || !$('matchTitle')) return;
  state.detailMatchId = id;
  state.selectedLiveGameId = '';
  await refreshMatchDetail(true);
  state.detailTimer = window.setInterval(() => refreshMatchDetail(false), 10000);
}

async function refreshMatchDetail(initial) {
  const id = state.detailMatchId;
  const details = await api('/api/match?id=' + encodeURIComponent(id));
  await enrichStaticLiveData(details);
  state.currentDetails = details;
  if (!details.id) {
    $('matchTitle').textContent = 'Match not found';
    return;
  }
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('matchTitle').textContent = `${left.name || left.code || '-'} vs ${right.name || right.code || '-'}`;
  $('matchMeta').textContent = `${details.league || ''} · BO${details.best_of || '-'} · ${details.source || ''} · auto-refresh 10s`;
  const seriesWinner = completedSeriesWinner(details);
  $('detailTeams').innerHTML = `${teamBlock(left, 'blueTeamRecord', seriesWinner)}${matchInfoBlock(details)}${teamBlock(right, 'redTeamRecord', seriesWinner)}`;
  loadTeamRecords(left, right, details.league);
  updateStartedVisibility(details);
  loadHeadToHead(left, right, details.league);
  $('detailGames').innerHTML = gameListHtml(details);
  setDetailInputs(details);
  renderLiveDraft(details);
  if (initial) await predictDetail(left, right, details.league);
  updateLiveRefreshMeta(details);
}

async function enrichStaticLiveData(details) {
  if (!STATIC_SITE || !details?.games?.length) return;
  const targets = details.games.filter(game => {
    const status = String(game.state || '').toLowerCase();
    return game.id && !['unstarted', 'unneeded', ''].includes(status);
  });
  await Promise.all(targets.map(async game => {
    const live = await fetchLolesportsLive(game.id);
    if (live && ((live.blue || []).length || (live.red || []).length || live.source)) {
      const previousFrame = state.liveFrames[String(game.id || '')] || '';
      const currentFrame = String(live.frame_timestamp || '');
      live.frame_changed = Boolean(currentFrame && currentFrame !== previousFrame);
      if (currentFrame) state.liveFrames[String(game.id || '')] = currentFrame;
      game.live = live;
    }
  }));
}

async function fetchLolesportsLive(gameId) {
  const startingTime = liveFeedStartingTime();
  const [windowPayload, detailsPayload] = await Promise.all([
    fetchLiveJson(`https://feed.lolesports.com/livestats/v1/window/${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(startingTime)}`),
    fetchLiveJson(`https://feed.lolesports.com/livestats/v1/details/${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(startingTime)}`),
  ]);
  const live = normalizeLiveWindow(windowPayload);
  mergeLiveDetails(live, detailsPayload);
  return live;
}

async function fetchLiveJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok || response.status === 204) return {};
    return await response.json();
  } catch (error) {
    return {};
  }
}

function liveFeedStartingTime() {
  const timestamp = Math.floor((Date.now() - 60000) / 1000);
  const rounded = timestamp - (timestamp % 10);
  return new Date(rounded * 1000).toISOString().replace(/\\.\\d{3}Z$/, '.000Z');
}

function normalizeLiveWindow(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const metadata = payload.gameMetadata || {};
  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  const frame = frames.length ? frames[frames.length - 1] || {} : {};
  const blueFrame = frame.blueTeam || {};
  const redFrame = frame.redTeam || {};
  return {
    game_state: String(frame.gameState || payload.gameState || ''),
    game_time: Number(frame.gameTime || payload.gameTime || 0),
    frame_timestamp: String(frame.rfc460Timestamp || ''),
    patch_version: String(metadata.patchVersion || ''),
    blue: liveParticipants(metadata.blueTeamMetadata || {}, blueFrame),
    red: liveParticipants(metadata.redTeamMetadata || {}, redFrame),
    blue_stats: liveTeamStats(blueFrame),
    red_stats: liveTeamStats(redFrame),
    source: 'lolesports_livestats',
  };
}

function liveParticipants(teamMetadata, teamFrame) {
  const participants = Array.isArray(teamMetadata.participantMetadata) ? teamMetadata.participantMetadata : [];
  const frameParticipants = Array.isArray(teamFrame.participants) ? teamFrame.participants : [];
  const statsById = Object.fromEntries(frameParticipants.map(participant => [String(participant.participantId || ''), participant]));
  return participants.map(participant => {
    const stats = statsById[String(participant.participantId || '')] || {};
    return {
      player: String(participant.summonerName || participant.name || ''),
      participant_id: String(participant.participantId || ''),
      champion: String(participant.championName || participant.championId || ''),
      champion_id: String(participant.championId || ''),
      role: String(participant.role || ''),
      level: Number(stats.level || 0),
      kills: Number(stats.kills || 0),
      deaths: Number(stats.deaths || 0),
      assists: Number(stats.assists || 0),
      creep_score: Number(stats.creepScore || 0),
      gold: Number(stats.totalGold || 0),
      current_health: Number(stats.currentHealth || 0),
      max_health: Number(stats.maxHealth || 0),
      items: liveItems(stats.items || []),
    };
  });
}

function mergeLiveDetails(live, payload) {
  const frames = Array.isArray(payload?.frames) ? payload.frames : [];
  if (!live || !frames.length) return;
  const frame = frames[frames.length - 1] || {};
  const participants = Array.isArray(frame.participants) ? frame.participants : [];
  const detailsById = Object.fromEntries(participants.map(participant => [String(participant.participantId || ''), participant]));
  for (const player of [...(live.blue || []), ...(live.red || [])]) {
    const details = detailsById[String(player.participant_id || '')];
    if (!details) continue;
    player.level = Number(details.level || player.level || 0);
    player.kills = Number(details.kills || player.kills || 0);
    player.deaths = Number(details.deaths || player.deaths || 0);
    player.assists = Number(details.assists || player.assists || 0);
    player.creep_score = Number(details.creepScore || player.creep_score || 0);
    player.gold = Number(details.totalGoldEarned || player.gold || 0);
    player.items = liveItems(details.items || player.items || []);
  }
}

function liveItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (item && typeof item === 'object') return String(item.itemID || item.itemId || item.id || '');
    return String(item || '');
  }).filter(Boolean).slice(0, 7);
}

function liveTeamStats(teamFrame) {
  return {
    gold: Number(teamFrame.totalGold || 0),
    kills: Number(teamFrame.totalKills || 0),
    towers: Number(teamFrame.towers || 0),
    inhibitors: Number(teamFrame.inhibitors || 0),
    barons: Number(teamFrame.barons || 0),
    dragons: Array.isArray(teamFrame.dragons) ? teamFrame.dragons.length : 0,
  };
}

function updateStartedVisibility(details) {
  const started = hasMatchStarted(details);
  const livePanel = document.querySelector('.livePanel');
  if (livePanel) livePanel.classList.toggle('hidden', !started);
}

function hasMatchStarted(details) {
  const status = String(details.status || '').toLowerCase();
  if (['inprogress', 'completed', 'complete'].includes(status)) return true;
  const teams = details.teams || [];
  if (teams.some(team => Number(team.game_wins || 0) > 0)) return true;
  return (details.games || []).some(game => {
    const state = String(game.state || '').toLowerCase();
    return !['unstarted', 'unneeded', ''].includes(state);
  });
}

function setDetailInputs(details) {
  if (!$('detailInputs')) {
    const teams = details.teams || [];
    const left = teams[0] || {};
    const right = teams[1] || {};
    const rosterKey = `${left.name || left.code || ''}|${right.name || right.code || ''}`;
    if (rosterKey !== state.rosterKey) {
      state.rosterKey = rosterKey;
      loadRosters(left, right);
    }
    return;
  }
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
  const matchStatus = String(details.status || '').toLowerCase();
  if (matchStatus === 'completed' || matchStatus === 'complete') return `Series completed · ${seriesScore(details.teams || [])}`;
  const state = String(game?.state || '').toLowerCase();
  if (state === 'inprogress') return `Game ${gameNumber} out of ${bestOf} is live now`;
  if (state === 'completed') return `Game ${gameNumber} out of ${bestOf} is completed`;
  const time = localStartTime(details.start_time);
  if (!time) return `Game ${gameNumber} out of ${bestOf} start time TBD`;
  return `Game ${gameNumber} out of ${bestOf} will start at ${time}`;
}

function matchStatusLabel(match) {
  const status = String(match.status || '');
  const normalized = status.toLowerCase();
  const hasScore = match.blue_score !== undefined && match.red_score !== undefined
    && String(match.blue_score) !== '' && String(match.red_score) !== ''
    && (Number(match.blue_score || 0) + Number(match.red_score || 0)) > 0;
  if (hasScore && ['completed', 'complete', 'inprogress'].includes(normalized)) {
    const winner = ['completed', 'complete'].includes(normalized) ? matchWinnerLabel(match) : '';
    return `${status} · ${match.blue_score}-${match.red_score}${winner ? ` · ${winner} wins` : ''}`;
  }
  return status;
}

function gameListHtml(details) {
  return (details.games || []).map(game => {
    const winner = gameWinnerTeam(details, game);
    const winnerLabel = winner ? `<span class="gameWinner">Winner: ${escapeHtml(winner.code || winner.name || '-')}</span>` : '';
    return `
      <div class="gameItem">
        <b>Game ${game.number} · ${escapeHtml(game.state)}</b>
        <span>Blue: ${escapeHtml(game.blue?.team_code || game.blue?.team_name || '-')}</span><br>
        <span>Red: ${escapeHtml(game.red?.team_code || game.red?.team_name || '-')}</span><br>
        ${winnerLabel}
      </div>
    `;
  }).join('');
}

function completedSeriesWinner(details) {
  const status = String(details?.status || '').toLowerCase();
  if (!['completed', 'complete'].includes(status)) return null;
  return scoreWinnerTeam(details?.teams || []);
}

function scoreWinnerTeam(teams) {
  const left = teams[0] || {};
  const right = teams[1] || {};
  const leftScore = scoreNumber(left.game_wins);
  const rightScore = scoreNumber(right.game_wins);
  if (leftScore === rightScore) return null;
  return leftScore > rightScore ? left : right;
}

function gameWinnerTeam(details, game) {
  const state = String(game?.state || '').toLowerCase();
  if (state !== 'completed') return null;
  const teams = details?.teams || [];
  const explicitWinner = game?.winner || game?.winner_team || game?.winnerTeam;
  if (explicitWinner) {
    return teams.find(team => sameTeam(explicitWinner, team.name) || sameTeam(explicitWinner, team.code)) || null;
  }
  const completedGames = (details?.games || []).filter(item => String(item.state || '').toLowerCase() === 'completed').length;
  const leftScore = scoreNumber(teams[0]?.game_wins);
  const rightScore = scoreNumber(teams[1]?.game_wins);
  const totalWins = leftScore + rightScore;
  if (!totalWins || completedGames !== totalWins) return null;
  if (completedGames === 1 || Math.min(leftScore, rightScore) === 0) return scoreWinnerTeam(teams);
  return null;
}

function matchWinnerLabel(match) {
  const blueScore = scoreNumber(match.blue_score);
  const redScore = scoreNumber(match.red_score);
  if (blueScore === redScore) return '';
  return blueScore > redScore
    ? (match.blue_code || match.blue_team || '')
    : (match.red_code || match.red_team || '');
}

function scoreNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function sameTeamIdentity(left, right) {
  return sameTeam(left?.id, right?.id)
    || sameTeam(left?.name, right?.name)
    || sameTeam(left?.code, right?.code)
    || sameTeam(left?.name, right?.code)
    || sameTeam(left?.code, right?.name);
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
  const game = selectedLiveGame(details.games || []);
  const live = game?.live || {};
  const teams = details.teams || [];
  const blueTeam = teamForSide(game.blue, teams);
  const redTeam = teamForSide(game.red, teams);
  const bluePlayers = livePlayersForSide(details, game, 'blue', blueTeam);
  const redPlayers = livePlayersForSide(details, game, 'red', redTeam);
  const hasLive = Boolean((live.blue || []).length || (live.red || []).length);
  const meaningfulLive = hasMeaningfulLiveData(live);
  const board = $('liveBoard');
  if (!board) return;
  board.innerHTML = `
    <div class="liveTabs">${(details.games || []).map(item => liveGameTab(item, game)).join('')}</div>
    <div class="liveContent">
      <div class="liveTop">
        ${liveTeamHeader(blueTeam)}
        <div class="liveCenter">
          <span class="liveBadge">${escapeHtml(liveBadgeText(hasLive, meaningfulLive))}</span>
          <span class="liveTimer">${escapeHtml(liveTimerText(live, meaningfulLive))}</span>
        </div>
        ${liveTeamHeader(redTeam)}
      </div>
      <div class="liveStatsLine">
        ${liveStatsSide(live.blue_stats || {}, 'blue')}
        ${liveStatsSide(live.red_stats || {}, 'red')}
      </div>
      <div class="livePlayers">
        ${liveTeamRows(blueTeam, bluePlayers, redPlayers)}
        ${liveTeamRows(redTeam, redPlayers, bluePlayers)}
      </div>
    </div>
  `;
  attachLiveTabHandlers(details);
}

function activeGame(games) {
  const inProgress = games.find(game => String(game.state || '').toLowerCase() === 'inprogress');
  if (inProgress) return inProgress;
  const completed = games.filter(game => String(game.state || '').toLowerCase() === 'completed');
  if (completed.length) return completed[completed.length - 1];
  const withLive = games.filter(game => (game.live?.blue || []).length || (game.live?.red || []).length);
  if (withLive.length) return withLive[withLive.length - 1];
  return games.find(game => !['unstarted', 'unneeded'].includes(String(game.state || '').toLowerCase()))
    || games[0]
    || {};
}

function selectedLiveGame(games) {
  const selected = games.find(game => String(game.id || '') === String(state.selectedLiveGameId || ''));
  if (selected) return selected;
  const fallback = activeGame(games);
  state.selectedLiveGameId = String(fallback?.id || '');
  return fallback;
}

function attachLiveTabHandlers(details) {
  for (const tab of document.querySelectorAll('.liveTab')) {
    tab.addEventListener('click', () => {
      state.selectedLiveGameId = tab.dataset.gameId || '';
      renderLiveDraft(details);
    });
  }
}

function livePlayersForSide(details, game, side, team) {
  const livePlayers = game?.live?.[side] || [];
  if (hasRealLivePlayers(livePlayers)) return livePlayers;
  const fallback = previousGamePlayers(details.games || [], game, team);
  if (fallback.length) return fallback;
  const rosterFallback = rosterPlayersForTeam(team);
  return rosterFallback.length ? rosterFallback : emptyLivePlayers();
}

function hasRealLivePlayers(players) {
  return players.some(player => player?.player && player.player !== 'TBD');
}

function previousGamePlayers(games, currentGame, team) {
  const currentNumber = Number(currentGame?.number || 0);
  const candidates = games
    .filter(game => Number(game.number || 0) < currentNumber)
    .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
  for (const candidate of candidates) {
    const side = sideForTeam(candidate, team);
    const players = side ? candidate.live?.[side] || [] : [];
    if (hasRealLivePlayers(players)) return players.map(player => previousGamePlayer(player));
  }
  return [];
}

function sideForTeam(game, team) {
  if (sameTeam(game?.blue?.team_name, team?.name) || sameTeam(game?.blue?.team_code, team?.code) || sameTeam(game?.blue?.team_code, team?.name)) return 'blue';
  if (sameTeam(game?.red?.team_name, team?.name) || sameTeam(game?.red?.team_code, team?.code) || sameTeam(game?.red?.team_code, team?.name)) return 'red';
  return '';
}

function previousGamePlayer(player) {
  return {
    player: player.player || '-',
    role: player.role || '',
    champion: player.champion || '',
    champion_id: player.champion_id || '',
    level: player.level || 1,
    kills: 0,
    deaths: 0,
    assists: 0,
    creep_score: 0,
    gold: 0,
    current_health: 0,
    max_health: 0,
    items: [],
    previous_game_pick: true,
  };
}

function rosterPlayersForTeam(team) {
  const roster = state.rosters[teamKey(team?.name)] || state.rosters[teamKey(team?.code)] || [];
  return roster.map(player => ({
    player: player.player || '-',
    role: player.role || '',
    champion: '',
    champion_id: '',
    level: 1,
    kills: 0,
    deaths: 0,
    assists: 0,
    creep_score: 0,
    gold: 0,
    current_health: 0,
    max_health: 0,
    items: [],
    pending_pick: true,
  }));
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
  if (pick?.pending_pick) return 'Pick pending';
  if (!pick?.champion) return 'TBD';
  const champion = String(pick.champion);
  if (champion.match(/^\\d+$/)) return `Champion #${champion}`;
  return championDisplayName(champion);
}

function updateLiveRefreshMeta(details) {
  const updatedAt = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const liveGame = selectedLiveGame(details.games || []);
  const live = liveGame?.live || {};
  const liveSource = live.source ? ` · ${live.source}` : '';
  const frameTime = live.frame_timestamp ? ` · feed ${shortTime(live.frame_timestamp)}` : '';
  const frameState = live.frame_timestamp ? ` · ${live.frame_changed ? 'new frame' : 'same frame'}` : '';
  $('liveRefreshMeta').textContent = `Last checked ${updatedAt}${liveSource}${frameTime}${frameState}`;
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

async function predictDetail(left, right, league) {
  if (!$('detailPrediction')) return;
  const payload = {
    league: league || 'LCK', side: 'Blue', team: left.name || left.code || '', opponent: right.name || right.code || '',
    top_champion: 'Gnar', jng_champion: 'Xin Zhao', mid_champion: 'Ahri', bot_champion: 'Ashe', sup_champion: 'Rakan'
  };
  const result = await postPredict(payload);
  if (result.skipped) {
    $('detailPrediction').textContent = '-';
    return;
  }
  const data = result.data;
  const text = result.ok ? `${(data.win_probability * 100).toFixed(1)}%` : data.error;
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
  rememberRoster(blueName, blueTeam.code || '', blue.players || []);
  rememberRoster(redName, redTeam.code || '', red.players || []);
  $('blueRoster').innerHTML = rosterCards(blue.players || []);
  $('redRoster').innerHTML = rosterCards(red.players || []);
  if (state.currentDetails) renderLiveDraft(state.currentDetails);
}

function rememberRoster(name, code, players) {
  const keys = [name, code].map(teamKey).filter(Boolean);
  for (const key of keys) state.rosters[key] = players;
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
  renderSeasonRecords(blue, red);
}

async function loadHeadToHead(leftTeam, rightTeam, league) {
  const leftName = leftTeam.name || leftTeam.code || '';
  const rightName = rightTeam.name || rightTeam.code || '';
  const data = await api('/api/head-to-head?team_a=' + encodeURIComponent(leftName) + '&team_b=' + encodeURIComponent(rightName) + '&team_a_code=' + encodeURIComponent(leftTeam.code || '') + '&team_b_code=' + encodeURIComponent(rightTeam.code || '') + '&league=' + encodeURIComponent(league || ''));
  renderHeadToHead(data.matches || [], leftTeam, rightTeam);
}

function liveGameTab(item, active) {
  const isActive = String(item.id || '') === String(active.id || '');
  return `<button type="button" class="liveTab ${isActive ? 'active' : ''}" data-game-id="${escapeHtml(item.id || '')}">Game ${escapeHtml(item.number || '-')} - ${escapeHtml(gameStateLabel(item.state))}</button>`;
}

function gameStateLabel(value) {
  const state = String(value || 'waiting');
  if (state.toLowerCase() === 'inprogress') return 'In Progress';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function teamForSide(side, teams) {
  const sideId = String(side?.team_id || '');
  const sideName = side?.team_name || side?.team_code || '';
  return teams.find(team => String(team.id || '') === sideId)
    || teams.find(team => sameTeam(sideName, team.name) || sameTeam(sideName, team.code))
    || { name: sideName || '-', code: side?.team_code || '', image: '' };
}

function liveTeamHeader(team) {
  const image = team?.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  return `<div class="liveTeamHead">${image}<strong>${escapeHtml(team?.name || team?.code || '-')}</strong></div>`;
}

function liveStatsSide(stats, side) {
  const items = [
    ['KILL', stats.kills],
    ['TWR', stats.towers],
    ['INH', stats.inhibitors],
    ['BAR', stats.barons],
    ['DRG', stats.dragons],
  ];
  return `<div class="liveStatsSide ${side}">${items.map(([label, value]) => `
    <div class="liveStat"><b>${label}</b><span>${escapeHtml(value ?? 0)}</span></div>
  `).join('')}</div>`;
}

function liveTeamRows(team, players, opponentPlayers) {
  return `
    <div class="liveTeamRows liveRowsHeader">
      <span class="liveRowsTitle">${escapeHtml(team?.name || team?.code || '-')}</span>
      <span>Health</span>
      <span class="items">Items</span>
      <span>CS</span><span>K</span><span>D</span><span>A</span><span>Gold</span><span class="delta">+/-</span>
    </div>
    ${(players.length ? players : emptyLivePlayers()).map((player, index) => livePlayerRow(player, laneGoldDelta(player, opponentPlayers[index]))).join('')}
  `;
}

function laneGoldDelta(player, opponent) {
  return Number(player?.gold || 0) - Number(opponent?.gold || 0);
}

function livePlayerRow(player, goldDelta) {
  const current = Number(player.current_health || 0);
  const max = Number(player.max_health || 0);
  const healthPct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 100;
  const meta = player.pending_pick
    ? `${player.player || '-'} · ${roleLabel(player.role)}`
    : `${player.player || '-'} · ${player.previous_game_pick ? 'prev game' : `Lv ${player.level || 1}`}`;
  return `
    <div class="livePlayer liveTeamRows">
      <div class="liveChampion ${player.pending_pick ? 'pending' : ''}">
        ${championIcon(player.champion_id || player.champion)}
        <span><strong>${escapeHtml(championLabel(player))}</strong><small>${escapeHtml(meta)}</small></span>
      </div>
      <div class="healthBar"><div class="healthFill" style="width:${healthPct}%"></div><span class="healthText">${escapeHtml(current)} / ${escapeHtml(max)}</span></div>
      <div class="liveItems">${itemSlots(player.items || [])}</div>
      <div class="liveCell">${escapeHtml(player.creep_score || 0)}</div>
      <div class="liveCell">${escapeHtml(player.kills || 0)}</div>
      <div class="liveCell">${escapeHtml(player.deaths || 0)}</div>
      <div class="liveCell">${escapeHtml(player.assists || 0)}</div>
      <div class="liveCell">${escapeHtml(formatGold(player.gold || 0))}</div>
      <div class="liveCell delta ${escapeHtml(deltaClass(goldDelta))}">${escapeHtml(formatSigned(goldDelta))}</div>
    </div>
  `;
}

function deltaClass(value) {
  const number = Number(value || 0);
  if (number > 0) return 'positive';
  if (number < 0) return 'negative';
  return 'neutral';
}

function liveBadgeText(hasLive, meaningfulLive) {
  if (!hasLive) return 'STATS TEMPORARILY DISABLED';
  if (!meaningfulLive) return 'Unstarted';
  return 'IN GAME';
}

function liveTimerText(live, meaningfulLive) {
  const official = Number(live?.game_time || 0);
  if (official > 0) return formatGameTime(official);
  return meaningfulLive ? 'LIVE' : '--:--';
}

function hasMeaningfulLiveData(live) {
  const teamValues = ['kills','towers','inhibitors','barons','dragons','gold'];
  const playerValues = ['kills','deaths','assists','creep_score','gold','current_health','max_health'];
  const teams = [live?.blue_stats || {}, live?.red_stats || {}];
  if (teams.some(stats => teamValues.some(key => Number(stats[key] || 0) > 0))) return true;
  const players = [...(live?.blue || []), ...(live?.red || [])];
  return players.some(player =>
    playerValues.some(key => Number(player[key] || 0) > 0)
    || (player.items || []).length > 0
  );
}

function itemSlots(items) {
  const slots = Array.from({ length: 7 }, (_, index) => items[index]).map(item => {
    const id = String(item || '').replace(/[^0-9]/g, '');
    if (!id) return '<span class="itemSlot"></span>';
    return `<span class="itemSlot"><img src="https://ddragon.leagueoflegends.com/cdn/16.9.1/img/item/${escapeHtml(id)}.png" alt=""></span>`;
  });
  return `<div class="itemSlots">${slots.join('')}</div>`;
}

function emptyLivePlayers() {
  return ['Top','Jungle','Mid','Bot','Support'].map(role => ({ champion: '', player: role, role, pending_pick: true }));
}

function championIcon(value) {
  const image = championImage(value);
  if (image) return image;
  return '<span class="liveChampionPlaceholder">P</span>';
}

function championImage(value, version = '16.9.1') {
  const id = championImageId(value);
  if (!id) return '';
  return `<img src="https://ddragon.leagueoflegends.com/cdn/${escapeHtml(version)}/img/champion/${escapeHtml(id)}.png" alt="">`;
}

function ddragonVersion(patch) {
  const match = String(patch || '').match(/^(\\d+)\\.(\\d+)$/);
  if (!match) return '16.9.1';
  return `${Number(match[1])}.${Number(match[2])}.1`;
}

function roleLabel(value) {
  const text = String(value || '').toLowerCase();
  const labels = { top: 'Top', jungle: 'Jungle', jng: 'Jungle', mid: 'Mid', middle: 'Mid', bot: 'Bot', bottom: 'Bot', adc: 'Bot', support: 'Support', sup: 'Support' };
  return labels[text] || value || '';
}

function championImageId(value) {
  const text = String(value || '').replace(/[^A-Za-z0-9]/g, '');
  const aliases = { Wukong: 'MonkeyKing' };
  return aliases[text] || text;
}

function championDisplayName(value) {
  const aliases = { MonkeyKing: 'Wukong', XinZhao: 'Xin Zhao', TwistedFate: 'Twisted Fate', JarvanIV: 'Jarvan IV', KSante: "K'Sante" };
  return aliases[String(value || '')] || value;
}

function formatGameTime(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = String(Math.floor(total % 60)).padStart(2, '0');
  return `${minutes}:${secs}`;
}

function formatGold(value) {
  const gold = Number(value || 0);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(gold);
}

function formatSigned(value) {
  const number = Number(value || 0);
  if (number > 0) return `+${formatGold(number)}`;
  if (number < 0) return `-${formatGold(Math.abs(number))}`;
  return '0';
}

function setTeamRecord(id, record) {
  const el = $(id);
  if (!el) return;
  el.textContent = record.league_record || 'League record unavailable';
}

function renderSeasonRecords(blue, red) {
  const el = $('seasonRecords');
  if (!el) return;
  el.innerHTML = `
    <div class="row header"><span>Team</span><span>Games</span><span>Record</span><span>WR</span></div>
    ${seasonRecordRow(blue)}
    ${seasonRecordRow(red)}
  `;
}

function seasonRecordRow(record) {
  const name = record.matched_team || record.team || '-';
  const gameRecord = record.record || '-';
  const games = record.games ?? '-';
  const winrate = typeof record.winrate === 'number' ? `${(record.winrate * 100).toFixed(1)}%` : '-';
  return `<div class="row"><span>${escapeHtml(name)}</span><span>${escapeHtml(games)}</span><span>${escapeHtml(gameRecord)}</span><span>${escapeHtml(winrate)}</span></div>`;
}

function renderHeadToHead(matches, leftTeam = {}, rightTeam = {}) {
  const el = $('headToHead');
  if (!el) return;
  if (!matches.length) {
    el.innerHTML = '<p class="h2hEmpty">No recent direct matches in local data.</p>';
    return;
  }
  const context = { leftTeam, rightTeam };
  const stripMatches = matches.slice(0, 5);
  el.innerHTML = `
    <div class="h2hLogoStrip">
      ${stripMatches.map(match => `<div class="h2hLogoCell">${teamLogoMarkup(winningTeamName(match), context)}</div>`).join('')}
    </div>
    ${matches.map(match => h2hRow(match, context)).join('')}
  `;
}

function h2hRow(match, context) {
  const leftWon = Number(match.left_score) > Number(match.right_score);
  const rightWon = Number(match.right_score) > Number(match.left_score);
  const leftCurrent = currentTeamForHistorical(match.left_team, context);
  const rightCurrent = currentTeamForHistorical(match.right_team, context);
  return `
    <div class="h2hRow" title="${escapeHtml(match.split || '')}">
      <span class="h2hDate">${escapeHtml(relativeDateJa(match.date))}</span>
      <span class="h2hTeam ${leftWon ? 'isWinner' : ''}">${escapeHtml(leftCurrent?.code || leftCurrent?.name || match.left_team)}</span>
      <span class="h2hMiniLogo">${teamLogoMarkup(match.left_team, context)}</span>
      <span class="h2hScore">${escapeHtml(match.left_score)} - ${escapeHtml(match.right_score)}</span>
      <span class="h2hMiniLogo">${teamLogoMarkup(match.right_team, context)}</span>
      <span class="h2hTeam isRight ${rightWon ? 'isWinner' : ''}">${escapeHtml(rightCurrent?.code || rightCurrent?.name || match.right_team)}</span>
    </div>
  `;
}

function winningTeamName(match) {
  return Number(match.left_score) > Number(match.right_score) ? match.left_team : match.right_team;
}

function teamLogoMarkup(teamName, context) {
  const match = currentTeamForHistorical(teamName, context);
  if (match?.image) return `<img src="${escapeHtml(match.image)}" alt="">`;
  return `<span class="h2hLogoFallback">${escapeHtml(shortTeamName(teamName))}</span>`;
}

function currentTeamForHistorical(teamName, context) {
  const teams = [context.leftTeam, context.rightTeam].filter(Boolean);
  return teams.find(team => sameTeam(teamName, team?.name) || sameTeam(teamName, team?.code) || sameTeam(teamName, team?.slug));
}

function sameTeam(a, b) {
  return teamKey(a) === teamKey(b);
}

function teamKey(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    geng: 'geng',
    gengesports: 'geng',
    gen: 'geng',
    drx: 'kiwoomdrx',
    krx: 'kiwoomdrx',
    kiwoomdrx: 'kiwoomdrx',
    kt: 'ktrolster',
    ktrolster: 'ktrolster',
    dk: 'dpluskia',
    dpluskia: 'dpluskia',
    bnkfearx: 'bnkfearx',
    bfx: 'bnkfearx',
    fearx: 'bnkfearx',
    nongshimredforce: 'nongshimredforce',
    nongshimredforcechallengers: 'nongshimredforcechallengers',
    ns: 'nongshimredforce',
    t1: 't1',
    hle: 'hanwhalifeesports',
    hanwhalifeesports: 'hanwhalifeesports',
    bro: 'brion',
    hanjinbrion: 'brion',
    brion: 'brion',
    dns: 'dnsoopers',
    dnsoopers: 'dnsoopers',
    jdg: 'jdgaming',
    jd: 'jdgaming',
    jdgaming: 'jdgaming',
    beijingjdgesports: 'jdgaming',
    tes: 'topesports',
    topesports: 'topesports',
    blg: 'bilibiligaming',
    bilibiligaming: 'bilibiligaming',
    ig: 'invictusgaming',
    invictusgaming: 'invictusgaming',
    edg: 'edwardgaming',
    edwardgaming: 'edwardgaming',
    omg: 'ohmygod',
    ohmygod: 'ohmygod',
    lng: 'suzhoulngesports',
    suzhoulngesports: 'suzhoulngesports',
    lgd: 'lgdgaming',
    lgdgaming: 'lgdgaming',
    al: 'anyoneslegend',
    anyoneslegend: 'anyoneslegend',
    we: 'xianteamwe',
    teamwe: 'xianteamwe',
    xianteamwe: 'xianteamwe',
    weibogaming: 'weibogaming',
    wbg: 'weibogaming',
    up: 'ultraprime',
    ultraprime: 'ultraprime',
    nip: 'shenzhenninjasinpyjamas',
    shenzhenninjasinpyjamas: 'shenzhenninjasinpyjamas',
  };
  return aliases[key] || key;
}

function shortTeamName(value) {
  const text = String(value || '-').trim();
  return text.length <= 3 ? text : text.slice(0, 3).toUpperCase();
}

function relativeDateJa(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const days = Math.max(0, Math.round((Date.now() - date.getTime()) / 86400000));
  if (days === 0) return 'Today';
  if (days < 31) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function relativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const days = Math.max(0, Math.round((Date.now() - date.getTime()) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return '1d ago';
  if (days < 31) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
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
  if (!el) return;
  if ([...el.options].some(option => option.value === value)) el.value = value;
}

if ($('matches')) {
  for (const id of ['leagueGroup','region']) $(id).addEventListener('change', () => { loadSummary(); loadMatches(); });
  if ($('teamLeague')) $('teamLeague').addEventListener('change', loadTeamStandings);
  $('scheduleDate').addEventListener('change', () => {
    state.selectedMatchDate = $('scheduleDate').value || defaultMatchDate(state.allMatches);
    renderDateTabs(state.allMatches);
    renderMatches();
  });
  if ($('predictForm')) $('predictForm').addEventListener('submit', predict);
  loadOptions().then(() => { loadSummary(); loadMatches(); });
} else {
  loadMatchDetailPage();
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a local LoL esports predictor UI.")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
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
                return self.send_json(team_record_payload(context, team, league))
            if parsed.path == "/api/head-to-head":
                query = parse_qs(parsed.query)
                team_a = first_query(query, "team_a", "")
                team_b = first_query(query, "team_b", "")
                team_a_code = first_query(query, "team_a_code", "")
                team_b_code = first_query(query, "team_b_code", "")
                league = first_query(query, "league", "")
                return self.send_json(head_to_head_payload(context.rows, team_a, team_b, league, team_a_code, team_b_code))
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


STANDINGS_LEAGUES = ["LCK", "LPL", "LEC", "LCS", "LCP", "CBLOL", "VCS", "TCL", "LFL", "LCKC"]


def options_payload(rows: pd.DataFrame) -> dict[str, list[str]]:
    player_rows = rows[~rows["position"].eq("team")]
    leagues = sorted(rows["league"].dropna().astype(str).unique().tolist())
    return {
        "leagues": leagues,
        "standings_leagues": [league for league in STANDINGS_LEAGUES if league in set(leagues)],
        "champions": sorted(player_rows["champion"].dropna().astype(str).unique().tolist()),
    }


def summary_payload(rows: pd.DataFrame, query: dict[str, list[str]]) -> dict[str, object]:
    league_group = first_query(query, "league_group", "all")
    region = first_query(query, "region", "all")
    league = first_query(query, "league", "")
    filtered = filter_leagues(rows, league_group=league_group, region=region)
    if league:
        filtered = filtered[filtered["league"].astype(str).eq(league)]
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
    filtered = [_enrich_ambiguous_match_status(match) for match in filtered]
    source = filtered[0].get("source", "none") if filtered else "none"
    return {"source": source, "matches": filtered}


def _enrich_ambiguous_match_status(match: dict[str, object]) -> dict[str, object]:
    if not _needs_detail_status_check(match):
        return match
    details = lolesports_event_details(str(match.get("id") or ""))
    if not details:
        return match
    enriched = dict(match)
    enriched["status"] = details.get("status") or match.get("status", "")
    teams = details.get("teams") or []
    if len(teams) >= 2:
        enriched["blue_score"] = str(teams[0].get("game_wins", match.get("blue_score", "")))
        enriched["red_score"] = str(teams[1].get("game_wins", match.get("red_score", "")))
    return enriched


def _needs_detail_status_check(match: dict[str, object]) -> bool:
    if str(match.get("status") or "").lower() not in {"completed", "complete"}:
        return False
    best_of = str(match.get("best_of") or "")
    if not best_of.isdigit():
        return False
    needed = int(best_of) // 2 + 1
    blue_score = _score_number(match.get("blue_score"))
    red_score = _score_number(match.get("red_score"))
    return max(blue_score, red_score) < needed


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


def team_record_payload(context: AppContext, team: str, league: str = "") -> dict[str, object]:
    rows = context.rows
    team_rows = rows[rows["position"].eq("team")].copy()
    if team_rows.empty or not team:
        return {"team": team, "source": "oracles_elixir_local", "record": "", "league_record": ""}
    if league:
        league_rows = team_rows[team_rows["league"].astype(str).eq(league)].copy()
        if not league_rows.empty:
            team_rows = league_rows
    current_split = _current_split(team_rows)
    current_split_rows = team_rows[team_rows["split"].astype(str).eq(current_split)].copy() if current_split else team_rows
    team_rows["_team_key"] = team_rows["teamname"].astype(str).map(_team_key)
    current_split_rows["_team_key"] = current_split_rows["teamname"].astype(str).map(_team_key)
    target_key = _team_key(team)
    matched_rows = team_rows[team_rows["_team_key"].eq(target_key)].copy()
    league_rows = current_split_rows[current_split_rows["_team_key"].eq(target_key)].copy()
    if matched_rows.empty:
        matched_rows = _best_team_match(team_rows, target_key)
    if league_rows.empty:
        league_rows = _best_team_match(current_split_rows, target_key)
    if matched_rows.empty:
        return {"team": team, "source": "oracles_elixir_local", "record": "", "league_record": ""}

    result = pd.to_numeric(matched_rows.get("result"), errors="coerce").fillna(0)
    games = int(len(matched_rows))
    wins = int(result.sum())
    losses = games - wins
    winrate = float(wins / games) if games else 0.0
    matched_league = str(matched_rows["league"].dropna().iloc[-1]) if "league" in matched_rows and not matched_rows.empty else league
    series_wins, series_losses = _series_record(league_rows)
    adjustment = _live_series_record_adjustment(context, league_rows, team, league or matched_league)
    series_wins += adjustment["wins"]
    series_losses += adjustment["losses"]
    return {
        "team": team,
        "matched_team": str(matched_rows["teamname"].dropna().iloc[-1]),
        "league": matched_league,
        "split": current_split,
        "league_wins": series_wins,
        "league_losses": series_losses,
        "league_record": f"{series_wins}-{series_losses}" if series_wins + series_losses else "",
        "live_adjustment": adjustment,
        "games": games,
        "wins": wins,
        "losses": losses,
        "winrate": winrate,
        "record": f"{wins}-{losses} ({winrate:.1%})",
        "label": f"2026 {matched_league}" if matched_league else "2026",
        "source": "oracles_elixir_local",
    }


def head_to_head_payload(
    rows: pd.DataFrame, team_a: str, team_b: str, league: str = "", team_a_code: str = "", team_b_code: str = ""
) -> dict[str, object]:
    team_rows = rows[rows["position"].eq("team")].copy()
    if team_rows.empty or not team_a or not team_b:
        return {"team_a": team_a, "team_b": team_b, "matches": []}
    if league:
        league_rows = team_rows[team_rows["league"].astype(str).eq(league)].copy()
        if not league_rows.empty:
            team_rows = league_rows
    left_candidates = _team_name_candidates(team_a, team_a_code)
    right_candidates = _team_name_candidates(team_b, team_b_code)
    matches = _head_to_head_matches(team_rows, left_candidates, right_candidates)
    if len(matches) < 5:
        matches = _merge_h2h_matches(matches, leaguepedia_head_to_head(left_candidates, right_candidates))
    return {"team_a": team_a, "team_b": team_b, "matches": list(reversed(matches[-5:]))}


def _head_to_head_matches(
    team_rows: pd.DataFrame, team_a_candidates: list[str], team_b_candidates: list[str]
) -> list[dict[str, object]]:
    team_rows = team_rows.copy()
    team_rows["_team_key"] = team_rows["teamname"].astype(str).map(_team_key)
    left_keys = {_team_key(candidate) for candidate in team_a_candidates if candidate}
    right_keys = {_team_key(candidate) for candidate in team_b_candidates if candidate}
    matches = []
    for _, group in team_rows.groupby(team_rows["date"].dt.date, sort=True):
        teams = group[["_team_key", "teamname"]].drop_duplicates()
        keys = set(teams["_team_key"].astype(str))
        if not (left_keys & keys) or not (right_keys & keys):
            continue
        left_rows = group[group["_team_key"].isin(left_keys)]
        right_rows = group[group["_team_key"].isin(right_keys)]
        left_score = int(pd.to_numeric(left_rows["result"], errors="coerce").fillna(0).sum())
        right_score = int(pd.to_numeric(right_rows["result"], errors="coerce").fillna(0).sum())
        if left_score == right_score:
            continue
        date_value = group["date"].max()
        matches.append(
            {
                "date": date_value.isoformat(),
                "league": str(group["league"].dropna().iloc[-1]) if "league" in group else league,
                "split": str(group["split"].dropna().iloc[-1]) if "split" in group else "",
                "left_team": str(left_rows["teamname"].dropna().iloc[-1]),
                "right_team": str(right_rows["teamname"].dropna().iloc[-1]),
                "left_score": left_score,
                "right_score": right_score,
            }
        )
    return matches


def _merge_h2h_matches(
    primary: list[dict[str, object]], fallback: list[dict[str, object]]
) -> list[dict[str, object]]:
    merged: dict[tuple[str, str, str], dict[str, object]] = {}
    for match in [*fallback, *primary]:
        date_key = str(match.get("date", ""))[:10]
        teams_key = "|".join(
            sorted(
                [
                    _team_key(str(match.get("left_team", ""))),
                    _team_key(str(match.get("right_team", ""))),
                ]
            )
        )
        key = (
            date_key,
            teams_key,
            str(match.get("split", "")),
        )
        merged[key] = match
    return sorted(merged.values(), key=_h2h_sort_date)


def _h2h_sort_date(match: dict[str, object]) -> float:
    value = str(match.get("date", ""))
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return 0.0
    return parsed.timestamp()


def leaguepedia_head_to_head(team_a_candidates: list[str], team_b_candidates: list[str]) -> list[dict[str, object]]:
    left_names = [_leaguepedia_team_name(candidate) for candidate in team_a_candidates if candidate]
    right_names = [_leaguepedia_team_name(candidate) for candidate in team_b_candidates if candidate]
    left_names = list(dict.fromkeys(name for name in left_names if name))
    right_names = list(dict.fromkeys(name for name in right_names if name))
    if not left_names or not right_names:
        return []
    pairs = [
        f'(Team1="{_cargo_escape(left)}" AND Team2="{_cargo_escape(right)}") OR '
        f'(Team1="{_cargo_escape(right)}" AND Team2="{_cargo_escape(left)}")'
        for left in left_names
        for right in right_names
        if left != right
    ]
    if not pairs:
        return []
    where = (
        "(" + " OR ".join(f"({pair})" for pair in pairs) + ") "
        "AND Winner IS NOT NULL AND Team1Score IS NOT NULL AND Team2Score IS NOT NULL"
    )
    query = urlencode(
        {
            "tables": "MatchSchedule",
            "fields": "DateTime_UTC,Team1,Team2,Team1Score,Team2Score,Winner,ShownName",
            "where": where,
            "order_by": "DateTime_UTC DESC",
            "limit": "50",
            "format": "json",
        }
    )
    request = Request(
        f"https://lol.fandom.com/wiki/Special:CargoExport?{query}",
        headers={"User-Agent": "lol-esports-win-predictor/0.1"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, list):
        return []
    matches = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        matches.append(
            {
                "date": str(item.get("DateTime UTC") or item.get("DateTime_UTC") or ""),
                "league": "",
                "split": str(item.get("ShownName") or ""),
                "left_team": str(item.get("Team1") or ""),
                "right_team": str(item.get("Team2") or ""),
                "left_score": int(item.get("Team1Score") or 0),
                "right_score": int(item.get("Team2Score") or 0),
                "source": "leaguepedia",
            }
        )
    return list(reversed(matches))


def _team_name_candidates(name: str, code: str = "") -> list[str]:
    raw = [name, code]
    aliases = TEAM_ALIASES_BY_KEY
    for value in list(raw):
        key = _plain_team_key(value)
        raw.extend(aliases.get(key, []))
    return list(dict.fromkeys(str(value).strip() for value in raw if str(value or "").strip()))


def _cargo_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _leaguepedia_team_name(value: str) -> str:
    key = _plain_team_key(value)
    aliases = TEAM_ALIASES_BY_KEY.get(key)
    return aliases[0] if aliases else value


def _live_series_record_adjustment(
    context: AppContext, local_team_rows: pd.DataFrame, team: str, league: str = ""
) -> dict[str, object]:
    if not team:
        return {"wins": 0, "losses": 0, "matches": []}
    latest_local_date = _latest_local_record_date(local_team_rows)
    target_key = _team_key(team)
    wins = 0
    losses = 0
    matches = []
    for match in today_matches(context.rows, context.today_cache):
        if league and str(match.get("league") or "") != league:
            continue
        if str(match.get("status") or "").lower() not in {"completed", "complete"}:
            continue
        start_date = _parse_record_date(str(match.get("start_time") or ""))
        if latest_local_date and start_date and start_date <= latest_local_date:
            continue
        blue_score = _score_number(match.get("blue_score"))
        red_score = _score_number(match.get("red_score"))
        if blue_score + red_score <= 0:
            continue
        blue_keys = {_team_key(match.get("blue_team")), _team_key(match.get("blue_code"))}
        red_keys = {_team_key(match.get("red_team")), _team_key(match.get("red_code"))}
        if target_key in blue_keys:
            did_win = blue_score > red_score
        elif target_key in red_keys:
            did_win = red_score > blue_score
        else:
            continue
        wins += 1 if did_win else 0
        losses += 0 if did_win else 1
        matches.append(
            {
                "id": match.get("id", ""),
                "date": str(match.get("start_time") or ""),
                "score": f"{blue_score}-{red_score}",
                "source": match.get("source", ""),
            }
        )
    return {"wins": wins, "losses": losses, "matches": matches}


def _latest_local_record_date(rows: pd.DataFrame) -> date | None:
    if rows.empty or "date" not in rows:
        return None
    dates = pd.to_datetime(rows["date"], errors="coerce", utc=True).dropna()
    if dates.empty:
        return None
    return dates.max().date()


def _parse_record_date(value: str) -> date | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _score_number(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _current_split(rows: pd.DataFrame) -> str:
    if rows.empty or "split" not in rows:
        return ""
    latest_idx = rows["date"].idxmax()
    return str(rows.loc[latest_idx, "split"])


def _series_record(rows: pd.DataFrame) -> tuple[int, int]:
    if rows.empty:
        return 0, 0
    data = rows.copy()
    data["match_date"] = data["date"].dt.date
    series = data.groupby("match_date", sort=True)["result"].agg(["sum", "count"])
    wins = int((series["sum"] > (series["count"] - series["sum"])).sum())
    losses = int((series["sum"] < (series["count"] - series["sum"])).sum())
    return wins, losses


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


TEAM_ALIASES_BY_KEY = {
    # LCK
    "t1": ["T1"],
    "geng": ["Gen.G", "Gen.G Esports", "GEN"],
    "gengesports": ["Gen.G", "GEN"],
    "hle": ["Hanwha Life Esports", "HLE"],
    "hanwhalifeesports": ["Hanwha Life Esports", "HLE"],
    "dk": ["Dplus KIA", "Dplus Kia", "DK"],
    "dpluskia": ["Dplus KIA", "Dplus Kia", "DK"],
    "ns": ["Nongshim RedForce", "NONGSHIM RED FORCE", "NS"],
    "nongshimredforce": ["Nongshim RedForce", "NONGSHIM RED FORCE", "NS"],
    "bfx": ["BNK FEARX", "BNK FearX", "FearX", "BFX"],
    "bnkfearx": ["BNK FEARX", "BNK FearX", "FearX", "BFX"],
    "krx": ["KIWOOM DRX", "Kiwoom DRX", "DRX", "KRX"],
    "kiwoomdrx": ["KIWOOM DRX", "Kiwoom DRX", "DRX", "KRX"],
    "kt": ["kt Rolster", "KT Rolster", "KT"],
    "ktrolster": ["kt Rolster", "KT Rolster", "KT"],
    "bro": ["HANJIN BRION", "BRION", "BRO"],
    "hanjinbrion": ["HANJIN BRION", "BRION", "BRO"],
    "dns": ["DN SOOPers", "DNS"],
    "dnsoopers": ["DN SOOPers", "DNS"],
    # LPL
    "jdg": ["JD Gaming", "Beijing JDG Esports", "JDG"],
    "beijingjdgesports": ["JD Gaming", "Beijing JDG Esports", "JDG"],
    "jdgaming": ["JD Gaming", "Beijing JDG Esports", "JDG"],
    "tes": ["Top Esports", "TOP ESPORTS", "TES"],
    "topesports": ["Top Esports", "TOP ESPORTS", "TES"],
    "blg": ["Bilibili Gaming", "BILIBILI GAMING", "BLG"],
    "bilibiligaming": ["Bilibili Gaming", "BILIBILI GAMING", "BLG"],
    "ig": ["Invictus Gaming", "IG"],
    "invictusgaming": ["Invictus Gaming", "IG"],
    "al": ["Anyone's Legend", "AL"],
    "anyoneslegend": ["Anyone's Legend", "AL"],
    "we": ["Team WE", "Xi'an Team WE", "WE"],
    "xianteamwe": ["Team WE", "Xi'an Team WE", "WE"],
    "teamwe": ["Team WE", "Xi'an Team WE", "WE"],
    "edg": ["EDward Gaming", "EDWARD GAMING", "EDG"],
    "edwardgaming": ["EDward Gaming", "EDWARD GAMING", "EDG"],
    "omg": ["Oh My God", "OMG"],
    "ohmygod": ["Oh My God", "OMG"],
    "lng": ["LNG Esports", "Suzhou LNG Esports", "LNG"],
    "suzhoulngesports": ["LNG Esports", "Suzhou LNG Esports", "LNG"],
    "lgd": ["LGD Gaming", "LGD GAMING", "LGD"],
    "lgdgaming": ["LGD Gaming", "LGD GAMING", "LGD"],
    "wbg": ["Weibo Gaming", "WeiboGaming", "WBG"],
    "weibogaming": ["Weibo Gaming", "WeiboGaming", "WBG"],
    "up": ["Ultra Prime", "UP"],
    "ultraprime": ["Ultra Prime", "UP"],
    "nip": ["Ninjas in Pyjamas", "Shenzhen NINJAS IN PYJAMAS", "NIP"],
    "shenzhenninjasinpyjamas": ["Ninjas in Pyjamas", "Shenzhen NINJAS IN PYJAMAS", "NIP"],
}


def _plain_team_key(value: object) -> str:
    return "".join(character for character in str(value or "").lower() if character.isalnum())


def _team_key(value: str) -> str:
    key = _plain_team_key(value)
    aliases = {
        alias_key: _plain_team_key(values[0])
        for alias_key, values in TEAM_ALIASES_BY_KEY.items()
        if values
    }
    return aliases.get(key, key)


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
