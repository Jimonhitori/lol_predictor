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

const h2hFiles = await listJsonFiles(h2hDir);
const h2hFileSet = new Set(h2hFiles.map(file => path.basename(file, '.json')));
const h2hNonEmptyFileSet = await nonEmptyH2hFileSet(h2hFiles);
const h2hValidation = await validateH2hFiles(h2hFiles);
const targets = await collectTargets(docsDir);
const oracleGames = await loadOracleGames(oracleDir);
const targetAudit = auditTargets(targets, h2hNonEmptyFileSet, oracleGames);

const report = {
  ok: h2hValidation.invalid_files.length === 0 && targetAudit.missing_with_oracle_history.length === 0,
  docs_dir: docsDir,
  oracle_dir: oracleDir,
  checked_at: new Date().toISOString(),
  h2h_files: h2hFiles.length,
  h2h_non_empty_files: h2hNonEmptyFileSet.size,
  h2h_validation: h2hValidation,
  targets: {
    total: targets.length,
    by_source: countBy(targets, row => row.source),
    by_league: countBy(targets, row => row.league || 'unknown'),
  },
  coverage: {
    covered: targetAudit.covered.length,
    missing: targetAudit.missing.length,
    missing_with_oracle_history: targetAudit.missing_with_oracle_history.length,
    missing_without_oracle_history: targetAudit.missing_without_oracle_history.length,
  },
  missing_with_oracle_history: targetAudit.missing_with_oracle_history.slice(0, 50),
  missing_without_oracle_history: targetAudit.missing_without_oracle_history.slice(0, 50),
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function collectTargets(baseDir) {
  const targets = [];
  const seen = new Set();
  await addMatchTargets(baseDir, targets, seen);
  await addPredictionTargets(baseDir, targets, seen);
  return targets;
}

async function addMatchTargets(baseDir, targets, seen) {
  const payload = await readJsonIfExists(path.join(baseDir, 'static', 'data', 'matches-all__all.json'));
  for (const match of payload?.matches || []) {
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
      start_time: String(match.start_time || ''),
      status: String(match.status || ''),
    });
  }
}

async function addPredictionTargets(baseDir, targets, seen) {
  const payload = await readJsonIfExists(path.join(baseDir, 'pre_match_predictions.json'));
  const matchesPayload = await readJsonIfExists(path.join(baseDir, 'static', 'data', 'matches-all__all.json'));
  const matchesById = new Map((matchesPayload?.matches || []).map(match => [String(match.id || ''), match]));
  for (const prediction of payload?.predictions || []) {
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
      start_time: String(prediction.start_time || ''),
      status: '',
    });
  }
}

function addTarget(targets, seen, target) {
  const key = [
    staticKey(target.league),
    canonicalTeamKey(target.left, target.left_code),
    canonicalTeamKey(target.right, target.right_code),
  ].sort().join('|');
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

function auditTargets(targets, h2hFileSet, oracleGames) {
  const covered = [];
  const missing = [];
  const missingWithOracle = [];
  const missingWithoutOracle = [];
  for (const target of targets) {
    const candidates = h2hCandidates(target);
    const found = candidates.find(candidate => h2hFileSet.has(candidate));
    if (found) {
      covered.push({ ...target, artifact: found });
      continue;
    }
    const directGames = findOracleDirectGames(target, oracleGames);
    const row = {
      ...target,
      candidates: candidates.slice(0, 8),
      oracle_direct_games: directGames.length,
      latest_oracle_games: directGames.slice(0, 5).map(game => ({
        date: game.date,
        league: game.league,
        left_team: game.left_team,
        right_team: game.right_team,
        left_score: game.left_score,
        right_score: game.right_score,
      })),
    };
    missing.push(row);
    if (directGames.length) missingWithOracle.push(row);
    else missingWithoutOracle.push(row);
  }
  return {
    covered,
    missing,
    missing_with_oracle_history: missingWithOracle,
    missing_without_oracle_history: missingWithoutOracle,
  };
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

async function nonEmptyH2hFileSet(files) {
  const fileSet = new Set();
  for (const file of files) {
    try {
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(payload.matches) && payload.matches.length) {
        fileSet.add(path.basename(file, '.json'));
      }
    } catch {
    }
  }
  return fileSet;
}

async function validateH2hFiles(files) {
  const invalid = [];
  const empty = [];
  const sourceCounts = {};
  for (const file of files) {
    try {
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      const matches = Array.isArray(payload.matches) ? payload.matches : null;
      if (!payload.team_a || !payload.team_b || !matches) {
        invalid.push({ file: path.relative(docsDir, file), error: 'missing team_a/team_b/matches' });
        continue;
      }
      if (!matches.length) empty.push(path.relative(docsDir, file));
      const leagueFromFile = path.basename(file, '.json').split('__')[0] || '';
      for (const match of matches) {
        const source = String(match.source || 'unknown');
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        for (const field of ['date', 'left_team', 'right_team']) {
          if (!match[field]) invalid.push({ file: path.relative(docsDir, file), error: `match missing ${field}` });
        }
        if (!match.league && !leagueFromFile) {
          invalid.push({ file: path.relative(docsDir, file), error: 'match missing league' });
        }
        if (!Number.isFinite(Number(match.left_score)) || !Number.isFinite(Number(match.right_score))) {
          invalid.push({ file: path.relative(docsDir, file), error: 'match has non-numeric score' });
        }
      }
    } catch (error) {
      invalid.push({ file: path.relative(docsDir, file), error: errorMessage(error) });
    }
  }
  return {
    invalid_files: invalid,
    empty_files: empty,
    match_sources: sourceCounts,
  };
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
  return games.filter(game => {
    if (game.league_key !== targetLeague) return false;
    return (intersects(leftKeys, game.left_keys) && intersects(rightKeys, game.right_keys))
      || (intersects(leftKeys, game.right_keys) && intersects(rightKeys, game.left_keys));
  });
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
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
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(dir, entry.name))
    .sort();
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

function countBy(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = fn(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
