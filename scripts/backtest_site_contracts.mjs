#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const docsDir = path.resolve(process.argv[2] || 'docs');
const appSource = await fs.readFile(path.join(docsDir, 'static', 'app.js'), 'utf8');

const report = {
  ok: true,
  checked_at: new Date().toISOString(),
  docs_dir: docsDir,
  live_snapshot_retention: checkLiveSnapshotRetention(appSource),
  completed_game_tabs: checkCompletedGameTabs(appSource),
  h2h_static_lookup: await checkH2hStaticLookup(docsDir, appSource),
  pre_match_prediction_backtest: await backtestPreMatchPredictions(docsDir),
  alias_resolution_backtest: await backtestAliasResolution(docsDir, appSource),
};

report.ok = Object.values(report)
  .filter(value => value && typeof value === 'object' && 'ok' in value)
  .every(value => value.ok);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function checkLiveSnapshotRetention(source) {
  const output = {
    ok: true,
    errors: [],
    sequence: 'valid live frame -> empty ended feed -> completed match',
    stored_snapshots: 0,
    restored_champion: '',
    restored_gold: null,
    retained_after_end: false,
  };
  try {
    const context = createAppContext();
    vm.runInContext(source, context, { timeout: 1000 });
    const result = vm.runInContext(`
      const liveDetails = {
        id: 'retention-match',
        status: 'inProgress',
        games: [{
          id: 'retention-game-1',
          number: 1,
          state: 'inProgress',
          blue: { team_code: 'BLU' },
          red: { team_code: 'RED' },
          live: {
            status: 'in_game',
            frame_timestamp: '2026-05-23T07:00:00Z',
            game_time: 1240,
            blue: [{ player: 'Blue Top', champion: 'Gnar', gold: 9123, kills: 4 }],
            red: [{ player: 'Red Top', champion: 'Renekton', gold: 8100, kills: 2 }],
            blue_stats: { gold: 42100, kills: 11 },
            red_stats: { gold: 39200, kills: 8 },
          },
        }],
      };
      rememberLiveSnapshot(liveDetails);
      const emptyCompleted = {
        id: 'retention-match',
        status: 'completed',
        games: [{
          id: 'retention-game-1',
          number: 1,
          state: 'completed',
          blue: { team_code: 'BLU' },
          red: { team_code: 'RED' },
          winner: 'BLU',
          live: { status: 'ended', blue: [], red: [], blue_stats: {}, red_stats: {} },
        }],
      };
      const restored = restoreEndedLiveSnapshot(emptyCompleted);
      ({
        stored: window.localStorage.length,
        champion: restored.games[0].live.blue[0]?.champion || '',
        gold: restored.games[0].live.blue[0]?.gold || null,
        retained: restored.games[0].live.retained_after_end === true,
      });
    `, context, { timeout: 1000 });
    output.stored_snapshots = result.stored;
    output.restored_champion = result.champion;
    output.restored_gold = result.gold;
    output.retained_after_end = result.retained;
    if (result.stored !== 1) output.errors.push('meaningful live snapshot was not stored');
    if (result.champion !== 'Gnar' || result.gold !== 9123 || result.retained !== true) {
      output.errors.push('completed empty feed did not restore the last real frame');
    }
  } catch (error) {
    output.errors.push(errorMessage(error));
  }
  output.ok = output.errors.length === 0;
  return output;
}

function checkCompletedGameTabs(source) {
  const output = {
    ok: true,
    errors: [],
    scenario: 'BO3/BO5 with Game 1/2 completed and Game 3 inProgress',
    restored_completed_games: [],
    active_game_retained: false,
  };
  try {
    const context = createAppContext();
    vm.runInContext(source, context, { timeout: 1000 });
    const result = vm.runInContext(`
      const liveSeries = {
        id: 'series-match',
        status: 'inProgress',
        games: [
          { id: 'game-1', number: 1, state: 'inProgress', blue: { team_code: 'CNV' }, red: { team_code: 'SN' }, live: { status: 'in_game', frame_timestamp: '2026-05-23T07:10:00Z', blue: [{ player: 'CNV Top', champion: 'Riven', gold: 7300 }], red: [{ player: 'SN Top', champion: 'Aatrox', gold: 7100 }], blue_stats: { gold: 30000 }, red_stats: { gold: 29500 } } },
          { id: 'game-2', number: 2, state: 'inProgress', blue: { team_code: 'CNV' }, red: { team_code: 'SN' }, live: { status: 'in_game', frame_timestamp: '2026-05-23T08:10:00Z', blue: [{ player: 'CNV Top', champion: 'Renekton', gold: 8300 }], red: [{ player: 'SN Top', champion: 'Kennen', gold: 7900 }], blue_stats: { gold: 33000 }, red_stats: { gold: 31000 } } },
          { id: 'game-3', number: 3, state: 'inProgress', blue: { team_code: 'CNV' }, red: { team_code: 'SN' }, live: { status: 'in_game', frame_timestamp: '2026-05-23T09:10:00Z', blue: [{ player: 'CNV Top', champion: 'Aurora', gold: 4200 }], red: [{ player: 'SN Top', champion: 'Sion', gold: 4100 }], blue_stats: { gold: 18000 }, red_stats: { gold: 18100 } } },
        ],
      };
      rememberLiveSnapshot(liveSeries);
      const mixedSeries = {
        id: 'series-match',
        status: 'inProgress',
        games: [
          { id: 'game-1', number: 1, state: 'completed', blue: { team_code: 'CNV' }, red: { team_code: 'SN' }, live: { status: 'ended', blue: [], red: [], blue_stats: {}, red_stats: {} } },
          { id: 'game-2', number: 2, state: 'completed', blue: { team_code: 'CNV' }, red: { team_code: 'SN' }, live: { status: 'ended', blue: [], red: [], blue_stats: {}, red_stats: {} } },
          { id: 'game-3', number: 3, state: 'inProgress', blue: { team_code: 'CNV' }, red: { team_code: 'SN' }, live: { status: 'in_game', frame_timestamp: '2026-05-23T09:15:00Z', blue: [{ player: 'CNV Top', champion: 'Aurora', gold: 4500 }], red: [{ player: 'SN Top', champion: 'Sion', gold: 4400 }], blue_stats: { gold: 19000 }, red_stats: { gold: 19050 } } },
        ],
      };
      const restored = restoreEndedLiveSnapshot(mixedSeries);
      ({
        restoredCompleted: restored.games
          .filter(game => String(game.state).toLowerCase() === 'completed')
          .map(game => ({ number: game.number, champion: game.live.blue[0]?.champion || '', retained: game.live.retained_after_end === true })),
        activeChampion: restored.games[2].live.blue[0]?.champion || '',
        activeGold: restored.games[2].live.blue[0]?.gold || null,
      });
    `, context, { timeout: 1000 });
    output.restored_completed_games = result.restoredCompleted;
    output.active_game_retained = result.activeChampion === 'Aurora' && result.activeGold === 4500;
    const restoredNumbers = result.restoredCompleted
      .filter(game => game.retained && ['Riven', 'Renekton'].includes(game.champion))
      .map(game => Number(game.number));
    if (!restoredNumbers.includes(1) || !restoredNumbers.includes(2)) {
      output.errors.push('completed game tabs did not restore retained frames during an active series');
    }
    if (!output.active_game_retained) {
      output.errors.push('active in-progress game was changed while restoring completed tabs');
    }
  } catch (error) {
    output.errors.push(errorMessage(error));
  }
  output.ok = output.errors.length === 0;
  return output;
}

async function checkH2hStaticLookup(baseDir, source) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    alias_lookup_match_count: null,
    html_fallback_lookup_match_count: null,
    lpl_prediction_alias_match_count: null,
    empty_artifact_skip_match_count: null,
    missing_lookup_returns_empty: null,
  };
  try {
    const context = createAppContext();
    context.fetch = async (url) => {
      const parsed = new URL(String(url));
      const relative = parsed.pathname.replace(/^\/static\//, 'static/').replace(/^\/+/, '');
      const filePath = path.join(baseDir, relative);
      try {
        const text = await fs.readFile(filePath, 'utf8');
        return { ok: true, json: async () => JSON.parse(text) };
      } catch {
        return { ok: false, json: async () => ({}) };
      }
    };
    context.document.querySelector = () => ({ src: 'http://example.test/static/app.js' });
    vm.runInContext(source, context, { timeout: 1000 });
    const found = await vm.runInContext(
      "staticHeadToHead(new URLSearchParams('league=LCP&team_a=MVK&team_b=Fukuoka%20SoftBank%20HAWKS%20gaming&team_a_code=MVK&team_b_code=SHG'))",
      context,
      { timeout: 1000 },
    );
    const htmlFallbackContext = createAppContext();
    htmlFallbackContext.fetch = async (url) => {
      const parsed = new URL(String(url));
      const relative = parsed.pathname.replace(/^\/static\//, 'static/').replace(/^\/+/, '');
      const filePath = path.join(baseDir, relative);
      try {
        const text = await fs.readFile(filePath, 'utf8');
        return { ok: true, json: async () => JSON.parse(text) };
      } catch {
        return { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
      }
    };
    htmlFallbackContext.document.querySelector = () => ({ src: 'http://example.test/static/app.js' });
    vm.runInContext(source, htmlFallbackContext, { timeout: 1000 });
    const htmlFallbackFound = await vm.runInContext(
      "staticHeadToHead(new URLSearchParams('league=LCP&team_a=MVK%20Esports&team_b=CTBC%20Flying%20Oyster&team_a_code=MVK&team_b_code=CFO'))",
      htmlFallbackContext,
      { timeout: 1000 },
    );
    const lplPredictionAliasFound = await vm.runInContext(
      "staticHeadToHead(new URLSearchParams('league=LPL&team_a=Invictus%20Gaming&team_b=THUNDER%20TALK%20GAMING&team_a_code=IG&team_b_code=TT'))",
      context,
      { timeout: 1000 },
    );
    const emptyArtifactContext = createAppContext();
    emptyArtifactContext.fetch = async (url) => {
      const parsed = new URL(String(url));
      const relative = parsed.pathname.replace(/^\/static\//, 'static/').replace(/^\/+/, '');
      if (relative.endsWith('data/h2h/lcp__mvk-esports__ctbc-flying-oyster.json')) {
        return { ok: true, json: async () => ({ team_a: 'MVK Esports', team_b: 'CTBC Flying Oyster', matches: [] }) };
      }
      if (relative.endsWith('data/h2h/lcp__ctbc-flying-oyster__mvk-esports.json')) {
        const text = await fs.readFile(path.join(baseDir, relative), 'utf8');
        return { ok: true, json: async () => JSON.parse(text) };
      }
      return { ok: false, json: async () => ({}) };
    };
    emptyArtifactContext.document.querySelector = () => ({ src: 'http://example.test/static/app.js' });
    vm.runInContext(source, emptyArtifactContext, { timeout: 1000 });
    const emptyArtifactSkipped = await vm.runInContext(
      "staticHeadToHead(new URLSearchParams('league=LCP&team_a=MVK%20Esports&team_b=CTBC%20Flying%20Oyster&team_a_code=MVK&team_b_code=CFO'))",
      emptyArtifactContext,
      { timeout: 1000 },
    );
    const missing = await vm.runInContext(
      "staticHeadToHead(new URLSearchParams('league=LCP&team_a=Imaginary%20Blue&team_b=Imaginary%20Red&team_a_code=IBL&team_b_code=IRD'))",
      context,
      { timeout: 1000 },
    );
    output.alias_lookup_match_count = Array.isArray(found.matches) ? found.matches.length : null;
    output.html_fallback_lookup_match_count = Array.isArray(htmlFallbackFound.matches) ? htmlFallbackFound.matches.length : null;
    output.lpl_prediction_alias_match_count = Array.isArray(lplPredictionAliasFound.matches) ? lplPredictionAliasFound.matches.length : null;
    output.empty_artifact_skip_match_count = Array.isArray(emptyArtifactSkipped.matches) ? emptyArtifactSkipped.matches.length : null;
    output.missing_lookup_returns_empty = Array.isArray(missing.matches) && missing.matches.length === 0
      && missing.warning === 'h2h_static_artifact_missing';
    if (!output.alias_lookup_match_count) {
      output.errors.push('H2H static lookup did not find an existing alias-backed artifact');
    }
    if (!output.html_fallback_lookup_match_count) {
      output.errors.push('H2H static lookup stopped before a valid reverse artifact after an HTML fallback response');
    }
    if (!output.lpl_prediction_alias_match_count) {
      output.errors.push('H2H static lookup did not resolve LPL prediction/live-event team aliases');
    }
    if (!output.empty_artifact_skip_match_count) {
      output.errors.push('H2H static lookup stopped on an empty artifact before a non-empty candidate');
    }
    if (!output.missing_lookup_returns_empty) {
      output.errors.push('H2H static lookup did not return an empty payload for missing artifacts');
    }
  } catch (error) {
    output.errors.push(errorMessage(error));
  }
  output.ok = output.errors.length === 0;
  return output;
}

async function backtestPreMatchPredictions(baseDir) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    rows: 0,
    resolved_rows: 0,
    accuracy: null,
    brier_score: null,
    log_loss: null,
    by_league: {},
    unmatched_prediction_ids: [],
  };
  try {
    const [feed, matchesPayload] = await Promise.all([
      readJson(path.join(baseDir, 'pre_match_predictions.json')),
      readJson(path.join(baseDir, 'static', 'data', 'matches-all__all.json')),
    ]);
    const predictions = Array.isArray(feed.predictions) ? feed.predictions : [];
    const matches = Array.isArray(matchesPayload.matches) ? matchesPayload.matches : [];
    const matchesById = new Map(matches.map(match => [String(match.id || match.event_id || ''), match]));
    output.rows = predictions.length;
    const resolved = [];
    for (const prediction of predictions) {
      const match = matchesById.get(String(prediction.event_id || '')) || matchesById.get(String(prediction.game_id || ''));
      if (!match) {
        output.unmatched_prediction_ids.push(String(prediction.event_id || prediction.game_id || ''));
        continue;
      }
      if (!isCompletedMatchWithWinner(match)) continue;
      const y = Number(match.blue_score) > Number(match.red_score) ? 1 : 0;
      const p = clampProbability(Number(prediction.blue_win_probability));
      const predictedBlue = p >= 0.5;
      resolved.push({
        league: prediction.league || match.league || 'unknown',
        p,
        y,
        correct: predictedBlue === Boolean(y),
      });
    }
    output.resolved_rows = resolved.length;
    if (!resolved.length) {
      output.warnings.push('no completed prediction rows were resolvable yet');
      return output;
    }
    const metrics = metricSummary(resolved);
    output.accuracy = metrics.accuracy;
    output.brier_score = metrics.brier_score;
    output.log_loss = metrics.log_loss;
    for (const league of [...new Set(resolved.map(row => row.league))].sort()) {
      output.by_league[league] = metricSummary(resolved.filter(row => row.league === league));
    }
  } catch (error) {
    output.errors.push(errorMessage(error));
  }
  output.ok = output.errors.length === 0;
  return output;
}

async function backtestAliasResolution(baseDir, source) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    alias_groups: [],
    focused_matches: [],
  };
  try {
    const context = createAppContext();
    vm.runInContext(source, context, { timeout: 1000 });
    const groups = [
      { name: 'Team WE', expected: 'xianteamwe', aliases: ['WE', 'Team WE', 'Xi An Team WE'], roster: 'xi-an-team-we.json', record: 'lpl__xi-an-team-we.json' },
      { name: 'LNG Esports', expected: 'suzhoulngesports', aliases: ['LNG', 'LNG Esports', 'Suzhou LNG Esports'], roster: 'suzhou-lng-esports.json', record: 'lpl__suzhou-lng-esports.json' },
      { name: 'Conviction', expected: 'conviction', aliases: ['CNV', 'Conviction'], roster: 'conviction.json', record: 'nacl__conviction.json' },
      { name: 'Supernova', expected: 'supernova', aliases: ['SN', 'Supernova'], roster: 'supernova.json', record: 'nacl__supernova.json' },
      { name: 'SU Esports', expected: 'suesports', aliases: ['SU', 'SU Esports'], roster: 'su-esports.json', record: 'tcl__su-esports.json' },
      { name: 'PCIFIC Esports', expected: 'pcificesports', aliases: ['PCF', 'PCIFIC Esports'], roster: 'pcific-esports.json', record: 'tcl__pcific-esports.json' },
      { name: 'Karmine Corp', expected: 'karminecorp', aliases: ['KC', 'Karmine Corp'], roster: null, record: 'lec__karmine-corp.json' },
      { name: 'G2 Esports', expected: 'g2esports', aliases: ['G2', 'G2 Esports'], roster: null, record: 'lec__g2-esports.json' },
    ];
    for (const group of groups) {
      const keys = vm.runInContext(`(${JSON.stringify(group.aliases)}).map(value => teamKey(value))`, context, { timeout: 1000 });
      const uniqueKeys = [...new Set(keys)];
      const rosterExists = group.roster ? await fileExists(path.join(baseDir, 'static', 'data', 'rosters', group.roster)) : true;
      const recordExists = await fileExists(path.join(baseDir, 'static', 'data', 'team-records', group.record));
      const ok = uniqueKeys.length === 1 && uniqueKeys[0] === group.expected;
      output.alias_groups.push({
        name: group.name,
        aliases: group.aliases,
        keys,
        expected_key: group.expected,
        alias_ok: ok,
        roster_exists: rosterExists,
        team_record_exists: recordExists,
      });
      if (!ok) output.errors.push(`${group.name} aliases resolve to ${uniqueKeys.join(', ')}, expected ${group.expected}`);
      if (group.roster && !rosterExists) output.warnings.push(`${group.name} roster artifact missing: ${group.roster}`);
      if (!recordExists) output.warnings.push(`${group.name} team-record artifact missing: ${group.record}`);
    }
    const [feed, matchesPayload] = await Promise.all([
      readJson(path.join(baseDir, 'pre_match_predictions.json')),
      readJson(path.join(baseDir, 'static', 'data', 'matches-all__all.json')),
    ]);
    const predictions = Array.isArray(feed.predictions) ? feed.predictions : [];
    const matches = Array.isArray(matchesPayload.matches) ? matchesPayload.matches : [];
    const focusedPairs = [
      { label: 'WE/LNG', keys: ['xianteamwe', 'suzhoulngesports'] },
      { label: 'CNV/SN', keys: ['conviction', 'supernova'] },
    ];
    for (const pair of focusedPairs) {
      output.focused_matches.push(findFocusedMatch(pair, matches, predictions, context));
    }
  } catch (error) {
    output.errors.push(errorMessage(error));
  }
  output.ok = output.errors.length === 0;
  return output;
}

function findFocusedMatch(pair, matches, predictions, context) {
  const keySet = new Set(pair.keys);
  const match = matches.find(candidate => {
    const keys = vm.runInContext(
      `[teamKey(${JSON.stringify(candidate.blue_team || candidate.blue_code || '')}), teamKey(${JSON.stringify(candidate.red_team || candidate.red_code || '')})]`,
      context,
      { timeout: 1000 },
    );
    return keys.every(key => keySet.has(key));
  });
  const prediction = predictions.find(candidate => {
    const keys = vm.runInContext(
      `[teamKey(${JSON.stringify(candidate.blue_team || '')}), teamKey(${JSON.stringify(candidate.red_team || '')})]`,
      context,
      { timeout: 1000 },
    );
    return keys.every(key => keySet.has(key));
  });
  return {
    label: pair.label,
    schedule_match_id: match?.id || null,
    schedule_status: match?.status || null,
    schedule_teams: match ? [match.blue_team || match.blue_code || '', match.red_team || match.red_code || ''] : [],
    prediction_event_id: prediction?.event_id || null,
    prediction_teams: prediction ? [prediction.blue_team || '', prediction.red_team || ''] : [],
    prediction_probability: prediction ? {
      blue: Number(prediction.blue_win_probability),
      red: Number(prediction.red_win_probability),
    } : null,
  };
}

function createAppContext() {
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    get length() { return storage.size; },
  };
  const context = {
    window: { STATIC_SITE: true, localStorage },
    location: { href: 'http://example.test/match/?id=test', origin: 'http://example.test', search: '?id=test' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  context.window.document = context.document;
  vm.createContext(context);
  return context;
}

function isCompletedMatchWithWinner(match) {
  const status = String(match.status || '').toLowerCase();
  const blue = Number(match.blue_score);
  const red = Number(match.red_score);
  return ['completed', 'complete'].includes(status)
    && Number.isFinite(blue)
    && Number.isFinite(red)
    && blue !== red;
}

function metricSummary(rows) {
  const n = rows.length || 1;
  return {
    rows: rows.length,
    accuracy: rows.reduce((sum, row) => sum + (row.correct ? 1 : 0), 0) / n,
    brier_score: rows.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / n,
    log_loss: rows.reduce((sum, row) => sum - (row.y * Math.log(row.p) + (1 - row.y) * Math.log(1 - row.p)), 0) / n,
  };
}

function clampProbability(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1 - 1e-15, Math.max(1e-15, value));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
