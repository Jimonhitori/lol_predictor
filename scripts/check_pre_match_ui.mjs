#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl || args.base
  ? String(args.baseUrl || args.base).replace(/\/+$/, '')
  : '';
const docsDir = path.resolve(String(args.docsDir || 'docs'));
const minRows = Number(args.minRows || 1);
const minOverlap = Number(args.minOverlap || 1);
const requestedMatchId = args.matchId ? String(args.matchId) : '';

const [feed, matchesPayload, appSource] = await Promise.all([
  loadJson('pre_match_predictions.json'),
  loadJson('static/data/matches-all__all.json'),
  loadText('static/app.js'),
]);

const errors = [];
const warnings = [];

const predictions = Array.isArray(feed.data?.predictions) ? feed.data.predictions : [];
const matches = Array.isArray(matchesPayload.data?.matches) ? matchesPayload.data.matches : [];
const matchesById = new Map(matches.map((match) => [String(match.id || match.event_id || ''), match]));

if (!feed.ok) errors.push(`prediction feed failed: ${feed.error || feed.status}`);
if (feed.ok && feed.data?.schema !== 'lol_predictions_public_v1') {
  errors.push(`prediction feed schema is ${JSON.stringify(feed.data?.schema)}`);
}
if (predictions.length < minRows) {
  errors.push(`prediction feed has ${predictions.length} rows, expected at least ${minRows}`);
}

if (!matchesPayload.ok) errors.push(`matches index failed: ${matchesPayload.error || matchesPayload.status}`);
if (matchesPayload.ok && !Array.isArray(matchesPayload.data?.matches)) {
  errors.push('matches index is missing matches[]');
}

const overlap = [];
for (const prediction of predictions) {
  const eventId = String(prediction.event_id || '');
  const gameId = String(prediction.game_id || '');
  const match = matchesById.get(eventId) || matchesById.get(gameId);
  if (match) overlap.push({ prediction, match });
}
if (overlap.length < minOverlap) {
  errors.push(`prediction/match overlap is ${overlap.length}, expected at least ${minOverlap}`);
}

const target = selectTarget(overlap, requestedMatchId);
let detail = null;
if (target) {
  detail = await loadJson(`static/data/matches/${target.match.id}.json`);
  if (!detail.ok) {
    errors.push(`match detail ${target.match.id} failed: ${detail.error || detail.status}`);
  } else {
    const detailId = String(detail.data?.id || detail.data?.event_id || '');
    if (detailId !== String(target.match.id)) {
      errors.push(`match detail id ${detailId || '(missing)'} does not match ${target.match.id}`);
    }
    if (!Array.isArray(detail.data?.teams) || detail.data.teams.length < 2) {
      errors.push(`match detail ${target.match.id} is missing two teams`);
    }
  }
} else if (requestedMatchId) {
  errors.push(`requested match ${requestedMatchId} was not found in feed/match overlap`);
}

if (!appSource.ok) errors.push(`app source failed: ${appSource.error || appSource.status}`);
if (appSource.ok) {
  const requiredSnippets = [
    'function matchPredictionBadge(match)',
    'function preMatchPredictionForMatch(match)',
    'function preMatchPredictionForDetails(details)',
    'function preMatchSplitText(details, prediction)',
    'matchInfoPrediction',
    'byEventId',
    'byGameId',
  ];
  for (const snippet of requiredSnippets) {
    if (!appSource.text.includes(snippet)) {
      errors.push(`app.js is missing pre-match UI hook: ${snippet}`);
    }
  }
  if (!appSource.text.includes('PRE ')) {
    warnings.push('app.js does not include the PRE label used by prediction badges');
  }
}

const example = target ? summarizeExample(target, detail?.data) : null;
const report = {
  ok: errors.length === 0,
  mode: baseUrl ? 'remote' : 'local',
  base_url: baseUrl || null,
  docs_dir: baseUrl ? null : docsDir,
  checked_at: new Date().toISOString(),
  feed_schema: feed.data?.schema || null,
  prediction_rows: predictions.length,
  match_rows: matches.length,
  overlap_rows: overlap.length,
  example,
  warnings,
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function selectTarget(overlapRows, matchId) {
  if (!overlapRows.length) return null;
  if (!matchId) return overlapRows[0];
  return overlapRows.find(({ match, prediction }) => {
    const ids = [match.id, match.event_id, prediction.event_id, prediction.game_id].map((value) => String(value || ''));
    return ids.includes(matchId);
  }) || null;
}

function summarizeExample({ prediction, match }, detailData) {
  const detailTeams = Array.isArray(detailData?.teams) ? detailData.teams : [];
  const blue = match.blue_code || match.blue_team || detailTeams[0]?.code || prediction.blue_team || 'Blue';
  const red = match.red_code || match.red_team || detailTeams[1]?.code || prediction.red_team || 'Red';
  return {
    match_id: String(match.id || ''),
    league: match.league || prediction.league || '',
    list_label: `PRE ${favoriteLabel(blue, red, prediction)} ${formatPercent(Math.max(
      Number(prediction.blue_win_probability || 0),
      Number(prediction.red_win_probability || 0),
    ))}`,
    detail_label: `PRE ${blue} ${formatPercent(prediction.blue_win_probability)} / ${red} ${formatPercent(prediction.red_win_probability)}`,
  };
}

function favoriteLabel(blue, red, prediction) {
  return Number(prediction.blue_win_probability || 0) >= Number(prediction.red_win_probability || 0) ? blue : red;
}

function formatPercent(value) {
  const number = Number(value || 0);
  return `${(number * 100).toFixed(1)}%`;
}

async function loadJson(relativePath) {
  const text = await loadText(relativePath);
  if (!text.ok) return { ...text, data: null };
  try {
    return { ...text, data: JSON.parse(text.text) };
  } catch (error) {
    return {
      ...text,
      ok: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadText(relativePath) {
  if (baseUrl) {
    const url = `${baseUrl}/${relativePath.replaceAll('\\', '/')}`;
    try {
      const response = await fetch(url);
      return {
        ok: response.ok,
        status: response.status,
        source: url,
        text: await response.text(),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        source: url,
        text: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const filePath = path.join(docsDir, relativePath);
  try {
    return {
      ok: true,
      status: 200,
      source: filePath,
      text: await fs.readFile(filePath, 'utf8'),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      source: filePath,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = values[index + 1];
    output[key] = next && !next.startsWith('--') ? next : true;
    if (output[key] === next) index += 1;
  }
  return output;
}
