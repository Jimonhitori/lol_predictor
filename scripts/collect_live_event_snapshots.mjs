#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const LOLESPORTS_GET_LIVE_URL = 'https://esports-api.lolesports.com/persisted/gw/getLive';
const LOLESPORTS_GET_SCHEDULE_URL = 'https://esports-api.lolesports.com/persisted/gw/getSchedule';
const LOLESPORTS_PUBLIC_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const DEFAULT_SITE_BASE_URL = 'https://lol-predictor.pages.dev';
const SNAPSHOT_SCHEMA = 'lol_live_event_snapshot_v1';
const FINAL_GAME_SCHEMA = 'lol_live_game_final_snapshot_v1';
const DEFAULT_SCHEDULE_LOOKBACK_MINUTES = 12 * 60;
const DEFAULT_SCHEDULE_LOOKAHEAD_MINUTES = 12 * 60;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

const args = parseArgs(process.argv.slice(2));
const siteBaseUrl = String(args.siteBaseUrl || process.env.SITE_BASE_URL || DEFAULT_SITE_BASE_URL).replace(/\/+$/, '');
const outputDir = path.resolve(String(args.outputDir || 'docs/static/data/live-event-snapshots'));
const statePath = path.resolve(String(args.statePath || '.github/live-event-snapshot-state.json'));
const explicitEventIds = arrayArg(args.eventId || args.eventIds);
const completedGracePolls = numberArg(args.completedGracePolls, 3);
const scheduleLookbackMinutes = numberArg(args.scheduleLookbackMinutes, DEFAULT_SCHEDULE_LOOKBACK_MINUTES);
const scheduleLookaheadMinutes = numberArg(args.scheduleLookaheadMinutes, DEFAULT_SCHEDULE_LOOKAHEAD_MINUTES);
const fetchTimeoutMs = numberArg(args.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
const hl = String(args.hl || 'en-US');

await fs.mkdir(outputDir, { recursive: true });
await ensureJsonObject(path.join(outputDir, 'latest_by_event.json'));
await ensureJsonObject(path.join(outputDir, 'final_by_event.json'));
await ensureJsonObject(path.join(outputDir, 'final_by_game.json'));

const state = await readJsonObject(statePath, { tracked_events: {} });
const errors = [];
let discoveredEventIds = [];
try {
  discoveredEventIds = await discoverLiveEventIds({
    hl,
    scheduleLookbackMinutes,
    scheduleLookaheadMinutes,
  });
} catch (error) {
  errors.push({ stage: 'discover', message: errorMessage(error) });
}

const eventIds = normalizeIds([
  ...explicitEventIds,
  ...discoveredEventIds,
  ...trackedEventIds(state, completedGracePolls),
]);
const checkedAt = new Date().toISOString();
const latest = await readJsonObject(path.join(outputDir, 'latest_by_event.json'), {});
const finalByEvent = await readJsonObject(path.join(outputDir, 'final_by_event.json'), {});
const finalByGame = await readJsonObject(path.join(outputDir, 'final_by_game.json'), {});
const activeEventIds = [];
let snapshotsWritten = 0;
let finalizedEvents = 0;
let finalGamesWritten = 0;

for (const eventId of eventIds) {
  let payload = null;
  try {
    payload = await fetchJson(`${siteBaseUrl}/api/live-event?id=${encodeURIComponent(eventId)}`);
  } catch (error) {
    errors.push({ stage: 'fetch_event', event_id: eventId, message: errorMessage(error) });
    continue;
  }

  const snapshot = buildSnapshotRecord({ eventId, checkedAt, payload });
  latest[eventId] = snapshot;
  snapshotsWritten += 1;

  const finalGameCount = updateFinalGameSnapshots(finalByGame, { eventId, snapshot });
  finalGamesWritten += finalGameCount;
  if (finalGameCount > 0 || eventHasFinalizableLive(payload)) {
    finalizedEvents += updateFinalEventSnapshot(finalByEvent, { eventId, snapshot });
  }

  const status = eventStatus(payload);
  if (status === 'inprogress' || status === 'updating' || hasInProgressGame(payload)) {
    activeEventIds.push(eventId);
    state.tracked_events[eventId] = { completed_polls: 0, last_status: status };
  } else if (eventHasFinalizableLive(payload) || status === 'completed') {
    const tracked = state.tracked_events[eventId] || {};
    state.tracked_events[eventId] = {
      completed_polls: Number(tracked.completed_polls || 0) + 1,
      last_status: status,
    };
  } else {
    state.tracked_events[eventId] = {
      ...(state.tracked_events[eventId] || {}),
      last_status: status,
    };
  }
}

pruneCompletedTracking(state, completedGracePolls);
await writeJson(path.join(outputDir, 'latest_by_event.json'), latest);
await writeJson(path.join(outputDir, 'final_by_event.json'), finalByEvent);
await writeJson(path.join(outputDir, 'final_by_game.json'), finalByGame);
await writeJson(statePath, state);

const summary = {
  ok: errors.length === 0,
  checked_at: checkedAt,
  site_base_url: siteBaseUrl,
  discovered_events: discoveredEventIds.length,
  schedule_lookback_minutes: scheduleLookbackMinutes,
  schedule_lookahead_minutes: scheduleLookaheadMinutes,
  fetch_timeout_ms: fetchTimeoutMs,
  events_checked: eventIds.length,
  snapshots_written: snapshotsWritten,
  finalized_events: finalizedEvents,
  final_games_written: finalGamesWritten,
  active_event_ids: activeEventIds,
  output_dir: outputDir,
  state_path: statePath,
  errors,
};
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok && snapshotsWritten === 0) process.exitCode = 1;

async function discoverLiveEventIds({ hl, scheduleLookbackMinutes, scheduleLookaheadMinutes }) {
  const [liveIds, scheduleIds] = await Promise.all([
    discoverGetLiveEventIds({ hl }),
    discoverScheduleEventIds({
      hl,
      lookbackMinutes: scheduleLookbackMinutes,
      lookaheadMinutes: scheduleLookaheadMinutes,
    }),
  ]);
  return normalizeIds([...liveIds, ...scheduleIds]);
}

async function discoverGetLiveEventIds({ hl }) {
  const url = new URL(LOLESPORTS_GET_LIVE_URL);
  url.searchParams.set('hl', hl);
  const payload = await fetchJson(url.toString(), {
    headers: {
      'x-api-key': LOLESPORTS_PUBLIC_API_KEY,
      accept: 'application/json',
    },
  });
  const events = payload?.data?.schedule?.events;
  if (!Array.isArray(events)) return [];
  const ids = [];
  for (const event of events) {
    if (!event || event.type !== 'match') continue;
    const match = event.match || {};
    const games = Array.isArray(match.games) ? match.games : [];
    if (!games.some(game => ['inProgress', 'completed'].includes(String(game?.state || '')))) continue;
    ids.push(String(match.id || event.id || ''));
  }
  return normalizeIds(ids);
}

async function discoverScheduleEventIds({ hl, lookbackMinutes, lookaheadMinutes }) {
  const payloads = await fetchSchedulePages({ hl });
  const now = Date.now();
  const lookbackMs = Math.max(0, Number(lookbackMinutes || 0)) * 60 * 1000;
  const lookaheadMs = Math.max(0, Number(lookaheadMinutes || 0)) * 60 * 1000;
  const ids = [];
  for (const payload of payloads) {
    const events = payload?.data?.schedule?.events;
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (!event || event.type !== 'match') continue;
      if (!eventWithinCollectionWindow(event, { now, lookbackMs, lookaheadMs })) continue;
      ids.push(String(event.match?.id || event.id || ''));
    }
  }
  return normalizeIds(ids);
}

async function fetchSchedulePages({ hl }) {
  const first = await fetchSchedulePage({ hl });
  const pages = [first];
  const pageInfo = first?.data?.schedule?.pages || {};
  for (const direction of ['older', 'newer']) {
    const token = pageInfo?.[direction];
    if (!token) continue;
    try {
      pages.push(await fetchSchedulePage({ hl, pageToken: token }));
    } catch (error) {
      errors.push({ stage: `discover_schedule_${direction}`, message: errorMessage(error) });
    }
  }
  return pages;
}

async function fetchSchedulePage({ hl, pageToken = '' }) {
  const url = new URL(LOLESPORTS_GET_SCHEDULE_URL);
  url.searchParams.set('hl', hl);
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return fetchJson(url.toString(), {
    headers: {
      'x-api-key': LOLESPORTS_PUBLIC_API_KEY,
      accept: 'application/json',
    },
  });
}

function eventWithinCollectionWindow(event, { now, lookbackMs, lookaheadMs }) {
  const state = String(event?.state || '').toLowerCase();
  if (state === 'inprogress') return true;
  const startMs = Date.parse(String(event?.startTime || ''));
  if (!Number.isFinite(startMs)) return false;
  return startMs >= now - lookbackMs && startMs <= now + lookaheadMs;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${url} timed out after ${fetchTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSnapshotRecord({ eventId, checkedAt, payload }) {
  return {
    schema: SNAPSHOT_SCHEMA,
    checked_at: checkedAt,
    event_id: eventId,
    status: String(payload?.status || ''),
    source: String(payload?.source || ''),
    has_meaningful_live: eventHasMeaningfulLive(payload),
    is_finalizable: eventHasFinalizableLive(payload),
    payload,
  };
}

function updateFinalEventSnapshot(finalByEvent, { eventId, snapshot }) {
  if (eventStatus(snapshot.payload) !== 'completed') return 0;
  const previous = finalByEvent[eventId];
  finalByEvent[eventId] = snapshot;
  return JSON.stringify(previous) === JSON.stringify(snapshot) ? 0 : 1;
}

function updateFinalGameSnapshots(finalByGame, { eventId, snapshot }) {
  const payload = snapshot.payload || {};
  const games = Array.isArray(payload.games) ? payload.games : [];
  let count = 0;
  for (const game of games) {
    const state = String(game?.state || '').toLowerCase();
    const gameId = String(game?.id || '');
    const live = game?.live && typeof game.live === 'object' ? game.live : {};
    if (!gameId || !['completed', 'complete'].includes(state) || !hasMeaningfulLive(live)) continue;
    const key = `${eventId}:${gameId}`;
    const record = {
      schema: FINAL_GAME_SCHEMA,
      checked_at: snapshot.checked_at,
      event_id: eventId,
      game_id: gameId,
      game_number: game.number ?? null,
      event_status: payload.status || '',
      teams: Array.isArray(payload.teams) ? payload.teams : [],
      game,
    };
    if (JSON.stringify(finalByGame[key]) !== JSON.stringify(record)) {
      finalByGame[key] = record;
      count += 1;
    }
  }
  return count;
}

function eventStatus(payload) {
  return String(payload?.status || '').toLowerCase();
}

function hasInProgressGame(payload) {
  return (payload?.games || []).some(game => String(game?.state || '').toLowerCase() === 'inprogress');
}

function eventHasMeaningfulLive(payload) {
  return (payload?.games || []).some(game => hasMeaningfulLive(game?.live || {}));
}

function eventHasFinalizableLive(payload) {
  const status = eventStatus(payload);
  const games = Array.isArray(payload?.games) ? payload.games : [];
  const completed = ['completed', 'complete'].includes(status) || games.some(game => {
    return ['completed', 'complete'].includes(String(game?.state || '').toLowerCase());
  });
  return completed && eventHasMeaningfulLive(payload);
}

function hasMeaningfulLive(live) {
  if (!live || typeof live !== 'object') return false;
  if (live.frame_timestamp) return true;
  const teamStats = [live.blue_stats || {}, live.red_stats || {}];
  const teamKeys = ['gold', 'kills', 'towers', 'inhibitors', 'barons', 'dragons'];
  if (teamStats.some(stats => teamKeys.some(key => Number(stats[key] || 0) > 0))) return true;
  const players = [...(live.blue || []), ...(live.red || [])];
  const playerKeys = ['champion', 'champion_id', 'gold', 'creep_score', 'kills', 'deaths', 'assists'];
  return players.some(player => player && typeof player === 'object' && playerKeys.some(key => player[key]));
}

function trackedEventIds(state, completedGracePolls) {
  return Object.entries(state?.tracked_events || {})
    .filter(([, item]) => Number(item?.completed_polls || 0) < completedGracePolls)
    .map(([eventId]) => eventId);
}

function pruneCompletedTracking(state, completedGracePolls) {
  state.tracked_events = state.tracked_events || {};
  for (const [eventId, item] of Object.entries(state.tracked_events)) {
    if (Number(item?.completed_polls || 0) >= completedGracePolls) {
      delete state.tracked_events[eventId];
    }
  }
}

async function ensureJsonObject(filePath) {
  try {
    JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    await writeJson(filePath, {});
  }
}

async function readJsonObject(filePath, fallback) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else if (parsed[key] !== undefined) {
      parsed[key] = Array.isArray(parsed[key]) ? [...parsed[key], next] : [parsed[key], next];
      index += 1;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function arrayArg(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean);
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIds(values) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
