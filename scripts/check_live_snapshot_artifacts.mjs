#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || 'https://lol-predictor.pages.dev').replace(/\/+$/, '');
const minFinalGames = Number(args.minFinalGames || 0);
const requireEventId = String(args.eventId || '').trim();

const finalByGameUrl = `${baseUrl}/static/data/live-event-snapshots/final_by_game.json`;
const latestByEventUrl = `${baseUrl}/static/data/live-event-snapshots/latest_by_event.json`;

const [finalByGame, latestByEvent] = await Promise.all([
  fetchJson(finalByGameUrl),
  fetchJson(latestByEventUrl),
]);

const finalEntries = Object.entries(finalByGame.json || {});
const latestEntries = Object.entries(latestByEvent.json || {});
const checkedTimes = finalEntries
  .map(([, record]) => Date.parse(String(record?.checked_at || '')))
  .filter(Number.isFinite)
  .sort((a, b) => b - a);
const latestFinalCheckedAt = checkedTimes.length ? new Date(checkedTimes[0]).toISOString() : '';
const eventIds = new Set(finalEntries.map(([, record]) => String(record?.event_id || '')).filter(Boolean));
const finalGamesForEvent = requireEventId
  ? finalEntries.filter(([, record]) => String(record?.event_id || '') === requireEventId).length
  : null;

const errors = [];
if (!finalByGame.ok) errors.push(`final_by_game fetch failed: ${finalByGame.status}`);
if (!latestByEvent.ok) errors.push(`latest_by_event fetch failed: ${latestByEvent.status}`);
if (finalEntries.length < minFinalGames) {
  errors.push(`final_by_game has ${finalEntries.length} games, expected at least ${minFinalGames}`);
}
if (requireEventId && !finalGamesForEvent) {
  errors.push(`final_by_game has no records for event ${requireEventId}`);
}

const report = {
  ok: errors.length === 0,
  checked_at: new Date().toISOString(),
  base_url: baseUrl,
  final_by_game_url: finalByGameUrl,
  latest_by_event_url: latestByEventUrl,
  final_game_count: finalEntries.length,
  final_event_count: eventIds.size,
  latest_event_count: latestEntries.length,
  latest_final_checked_at: latestFinalCheckedAt,
  event_id: requireEventId || null,
  final_games_for_event: finalGamesForEvent,
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function fetchJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return { ok: false, status: response.status, json: null };
    return { ok: true, status: response.status, json: await response.json() };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error), json: null };
  }
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
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
