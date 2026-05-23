#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const docsDir = path.resolve(process.argv[2] || 'docs');
const oracleDir = path.resolve(process.argv[3] || path.join('..', 'lol-pros-analyzer', 'data', 'raw'));
const h2hDir = path.join(docsDir, 'static', 'data', 'h2h');
const appSource = await fs.readFile(path.join(docsDir, 'static', 'app.js'), 'utf8');
const appContext = createAppContext();
vm.runInContext(appSource, appContext, { timeout: 1000 });

const targets = await collectTargets(docsDir);
const oracleGames = await loadOracleGames(oracleDir);
const existingNonEmpty = await nonEmptyH2hFileSet(await listJsonFiles(h2hDir));
const writes = [];

for (const target of targets) {
  if (h2hCandidates(target).some(candidate => existingNonEmpty.has(candidate))) continue;
  const games = findOracleDirectGames(target, oracleGames);
  if (!games.length) continue;
  const league = staticKey(target.league);
  const leftKey = canonicalTeamKey(target.left, target.left_code);
  const rightKey = canonicalTeamKey(target.right, target.right_code);
  const [teamAKey, teamBKey] = [leftKey, rightKey].sort();
  const fileName = `${league}__${teamAKey}__${teamBKey}.json`;
  const file = path.join(h2hDir, fileName);
  const latestGames = games.slice(0, 5).map(game => ({
    date: game.date,
    league: game.league,
    split: game.split,
    left_team: game.left_team,
    right_team: game.right_team,
    left_score: game.left_score,
    right_score: game.right_score,
    source: 'oracles_elixir',
  }));
  const payload = {
    team_a: teamAKey === leftKey ? target.left : target.right,
    team_b: teamBKey === rightKey ? target.right : target.left,
    matches: latestGames,
  };
  await fs.mkdir(h2hDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  existingNonEmpty.add(path.basename(file, '.json'));
  writes.push({
    file: path.relative(docsDir, file).replaceAll(path.sep, '/'),
    id: target.id,
    source: target.source,
    league: target.league,
    left: target.left,
    right: target.right,
    oracle_direct_games: games.length,
  });
}

console.log(JSON.stringify({
  ok: true,
  docs_dir: docsDir,
  oracle_dir: oracleDir,
  written: writes.length,
  files: writes,
}, null, 2));

async function collectTargets(baseDir) {
  const targets = [];
  const seen = new Set();
  const matchesPayload = await readJsonIfExists(path.join(baseDir, 'static', 'data', 'matches-all__all.json'));
  const scheduleMatches = matchesPayload?.matches || [];
  const matchesById = new Map(scheduleMatches.map(match => [String(match.id || ''), match]));
  for (const match of scheduleMatches) {
    const left = match.blue_team || match.blue_code || '';
    const right = match.red_team || match.red_code || '';
    if (!validTeam(left) || !validTeam(right)) continue;
    addTarget(targets, seen, {
      id: String(match.id || ''),
      source: 'site_schedule',
      league: String(match.league || ''),
      left,
      right,
      left_code: String(match.blue_code || ''),
      right_code: String(match.red_code || ''),
    });
  }
  const predictionPayload = await readJsonIfExists(path.join(baseDir, 'pre_match_predictions.json'));
  for (const prediction of predictionPayload?.predictions || []) {
    const match = matchesById.get(String(prediction.event_id || prediction.game_id || ''));
    const left = match?.blue_team || prediction.blue_team || '';
    const right = match?.red_team || prediction.red_team || '';
    if (!validTeam(left) || !validTeam(right)) continue;
    addTarget(targets, seen, {
      id: String(prediction.event_id || prediction.game_id || ''),
      source: 'pre_match_prediction',
      league: String(prediction.league || ''),
      left,
      right,
      left_code: String(match?.blue_code || ''),
      right_code: String(match?.red_code || ''),
    });
  }
  return targets;
}

function addTarget(targets, seen, target) {
  const left = canonicalTeamKey(target.left, target.left_code);
  const right = canonicalTeamKey(target.right, target.right_code);
  const key = [staticKey(target.league), ...[left, right].sort()].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

function h2hCandidates(target) {
  const leagueKeys = uniqueValues([staticKey(target.league), 'all']);
  const leftKeys = teamStaticKeys(target.left, target.left_code);
  const rightKeys = teamStaticKeys(target.right, target.right_code);
  const candidates = [];
  for (const league of leagueKeys) {
    for (const left of leftKeys) {
      for (const right of rightKeys) {
        if (!left || !right || left === right) continue;
        candidates.push(`${league}__${left}__${right}`);
        candidates.push(`${league}__${right}__${left}`);
      }
    }
  }
  return uniqueValues(candidates);
}

async function loadOracleGames(rawDir) {
  const gamesById = new Map();
  for (const year of ['2024', '2025', '2026']) {
    const file = path.join(rawDir, `${year}_LoL_esports_match_data_from_OraclesElixir.csv`);
    const rows = parseCsv(await readTextIfExists(file));
    for (const row of rows) {
      if (String(row.position || '') !== 'team' || !row.teamname || !row.gameid) continue;
      if (!gamesById.has(row.gameid)) gamesById.set(row.gameid, []);
      gamesById.get(row.gameid).push(row);
    }
  }
  const games = [];
  for (const rows of gamesById.values()) {
    if (rows.length !== 2) continue;
    const [left, right] = rows;
    games.push({
      date: left.date || '',
      league: left.league || '',
      split: left.split || '',
      left_team: left.teamname,
      right_team: right.teamname,
      left_score: Number(left.result || 0),
      right_score: Number(right.result || 0),
      left_keys: new Set(teamStaticKeys(left.teamname)),
      right_keys: new Set(teamStaticKeys(right.teamname)),
      league_key: staticKey(left.league || ''),
    });
  }
  return games.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function findOracleDirectGames(target, games) {
  const targetLeague = staticKey(target.league);
  const leftKeys = new Set(teamStaticKeys(target.left, target.left_code));
  const rightKeys = new Set(teamStaticKeys(target.right, target.right_code));
  return games.filter(game => game.league_key === targetLeague
    && ((intersects(leftKeys, game.left_keys) && intersects(rightKeys, game.right_keys))
      || (intersects(leftKeys, game.right_keys) && intersects(rightKeys, game.left_keys))));
}

async function nonEmptyH2hFileSet(files) {
  const fileSet = new Set();
  for (const file of files) {
    try {
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(payload.matches) && payload.matches.length) fileSet.add(path.basename(file, '.json'));
    } catch {
    }
  }
  return fileSet;
}

function parseCsv(text) {
  if (!text) return [];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [headers = [], ...data] = rows;
  return data
    .filter(values => values.length && values.some(Boolean))
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

async function listJsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => path.join(dir, entry.name));
}

async function readJsonIfExists(file) {
  const text = await readTextIfExists(file);
  return text ? JSON.parse(text) : null;
}

async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function staticKey(value) {
  return vm.runInContext(`staticKey(${JSON.stringify(value)})`, appContext, { timeout: 1000 });
}

function teamStaticKeys(...values) {
  return vm.runInContext(`teamStaticKeys(${values.map(value => JSON.stringify(value)).join(',')})`, appContext, { timeout: 1000 });
}

function canonicalTeamKey(...values) {
  const keys = teamStaticKeys(...values);
  if (keys.includes('los')) return 'los';
  return keys[0] || 'unknown';
}

function validTeam(value) {
  const text = String(value || '').trim().toLowerCase();
  return Boolean(text) && text !== 'tbd' && text !== 'bye';
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function createAppContext() {
  const context = {
    window: { STATIC_SITE: true, localStorage: {} },
    location: { href: 'http://example.test/', origin: 'http://example.test', search: '' },
    document: {
      getElementById: () => null,
      querySelector: () => ({ src: 'http://example.test/static/app.js' }),
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  vm.createContext(context);
  return context;
}
