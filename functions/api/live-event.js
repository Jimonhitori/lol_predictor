const EVENT_DETAILS_URL = 'https://esports-api.lolesports.com/persisted/gw/getEventDetails';
const LIVE_WINDOW_URL = 'https://feed.lolesports.com/livestats/v1/window/';
const LIVE_DETAILS_URL = 'https://feed.lolesports.com/livestats/v1/details/';
const DEFAULT_LOLESPORTS_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const EVENT_CACHE_SECONDS = 45;
const LIVE_CACHE_SECONDS = 4;
const PRE_MATCH_CACHE_SECONDS = 60;
const LIVE_FEED_DELAY_SECONDS = 130;
const LIVE_SNAPSHOT_CACHE_SECONDS = 60 * 60 * 24;
const LIVE_MODEL_PATH = '/static/data/live_model.json';
const LIVE_LOGISTIC_MODEL_PATH = '/live_logistic.json';
const LIVE_BOOTSTRAP_MODEL_PATH = '/live_logistic_oe_bootstrap.json';
const LIVE_EVENT_FINAL_BY_GAME_PATH = '/static/data/live-event-snapshots/final_by_game.json';
const LIVE_EVENT_FINAL_BY_EVENT_PATH = '/static/data/live-event-snapshots/final_by_event.json';
const LIVE_EVENT_LATEST_BY_EVENT_PATH = '/static/data/live-event-snapshots/latest_by_event.json';
const PRE_MATCH_PREDICTIONS_PATH = '/pre_match_predictions.json';
let liveModelPromise = null;
let preMatchPredictionsCache = { expiresAt: 0, promise: null };
let finalGameSnapshotsCache = { expiresAt: 0, promise: null };
let finalEventSnapshotsCache = { expiresAt: 0, promise: null };
let latestEventSnapshotsCache = { expiresAt: 0, promise: null };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const eventId = String(requestUrl.searchParams.get('id') || '').trim();
  if (!eventId) {
    return jsonResponse(unavailable('', 'missing_event_id'), LIVE_CACHE_SECONDS);
  }

  const cache = caches.default;
  const cached = await cache.match(context.request);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers });
  }

  let details = unavailable(eventId, '');
  let cacheTtl = EVENT_CACHE_SECONDS;
  try {
    const event = await fetchEventDetails(eventId, context.env);
    details = normalizeEventDetails(event);
    details = await enrichDetailsFromPreMatchFeed(details, context);
    details.warning = details.warning || '';
    await attachTargetLive(details, context);
    await restoreCompletedLiveSnapshots(details, context);
    cacheTtl = responseCacheSeconds(details);
  } catch (error) {
    const snapshot = await readStaticEventSnapshot(context, eventId);
    if (snapshot?.payload) {
      details = await enrichDetailsFromPreMatchFeed({
        ...snapshot.payload,
        source: `${snapshot.source}_fallback`,
        warning: 'event_details_fetch_failed_static_snapshot_fallback',
      }, context);
      await restoreCompletedLiveSnapshots(details, context);
      cacheTtl = responseCacheSeconds(details);
    } else {
      details = unavailable(eventId, 'event_details_fetch_failed');
    }
  }

  const response = jsonResponse(details, cacheTtl);
  context.waitUntil(cache.put(context.request, response.clone()));
  return response;
}

async function fetchEventDetails(eventId, env) {
  const url = new URL(EVENT_DETAILS_URL);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('id', eventId);
  const headers = {
    'x-api-key': (env && env.LOL_ESPORTS_API_KEY) || DEFAULT_LOLESPORTS_API_KEY,
    accept: 'application/json',
    'user-agent': 'lol-predictor-live-event/1.0',
  };
  let response = await fetch(url.toString(), {
    headers,
    cf: { cacheEverything: true, cacheTtl: EVENT_CACHE_SECONDS },
  });
  if (!response.ok) {
    response = await fetch(url.toString(), {
      headers,
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  }
  if (!response.ok) throw new Error(`event details ${response.status}`);
  const payload = await response.json();
  const event = payload?.data?.event;
  if (!event || typeof event !== 'object') throw new Error('event details empty');
  return event;
}

function normalizeEventDetails(event) {
  const match = event.match || {};
  const teams = Array.isArray(match.teams) ? match.teams : [];
  const games = Array.isArray(match.games) ? match.games : [];
  const teamById = Object.fromEntries(teams.map(team => [String(team.id || ''), team]));
  const bestOf = String(match.strategy?.count || '');
  const normalizedTeams = teams.map(normalizeTeam);
  const normalizedGames = games.map(game => normalizeGame(game, teamById)).sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
  return {
    id: String(event.id || match.id || ''),
    league: String(event.league?.name || 'Unknown'),
    league_group: '',
    region: '',
    best_of: bestOf,
    status: seriesStateFromGames(normalizedGames, normalizedTeams, bestOf, String(event.state || '')),
    start_time: String(event.startTime || ''),
    teams: normalizedTeams,
    games: normalizedGames,
    source: 'cloudflare_live_event',
  };
}

function normalizeTeam(team) {
  const result = team.result || {};
  return {
    id: String(team.id || ''),
    name: String(team.name || ''),
    code: String(team.code || ''),
    image: String(team.image || ''),
    game_wins: String(result.gameWins ?? '0'),
  };
}

function normalizeGame(game, teamById) {
  const sides = {};
  let winner = game.winner || game.winner_team || game.winnerTeam || game.winningTeam || game.winningTeamId || '';
  for (const team of Array.isArray(game.teams) ? game.teams : []) {
    const sourceTeam = teamById[String(team.id || '')] || {};
    const result = team.result || {};
    if (team.winner === true || result.winner === true || String(result.outcome || '').toLowerCase() === 'win') {
      winner = sourceTeam.code || sourceTeam.name || team.id || winner;
    }
    sides[String(team.side || '').toLowerCase()] = {
      team_id: String(team.id || ''),
      team_name: String(sourceTeam.name || ''),
      team_code: String(sourceTeam.code || ''),
    };
  }
  const state = String(game.state || '');
  return {
    id: String(game.id || ''),
    number: Number(game.number || 0),
    state,
    blue: sides.blue || {},
    red: sides.red || {},
    winner: typeof winner === 'object' ? String(winner.code || winner.name || winner.id || '') : String(winner || ''),
    live: baseLiveForState(state),
  };
}

function seriesStateFromGames(games, teams, bestOf, eventState) {
  const states = games.map(game => String(game.state || '').toLowerCase());
  if (states.some(state => state === 'inprogress')) return 'inProgress';
  const needed = Number(bestOf || 0) ? Math.floor(Number(bestOf) / 2) + 1 : 0;
  const wins = teams.map(team => Number(team.game_wins || 0));
  if (needed && wins.some(win => win >= needed)) return 'completed';
  if (states.some(state => state === 'completed')) return 'inProgress';
  if (states.length && states.every(state => ['unstarted', 'unneeded'].includes(state))) return 'unstarted';
  return String(eventState || 'unstarted');
}

async function attachTargetLive(details, context) {
  const game = currentGame(details);
  if (!game?.id) {
    details.warning = 'target_game_missing';
    return;
  }
  const status = statusForGame(details, game);
  if (status === 'unstarted' || status === 'ended') {
    const snapshot = status === 'ended' ? await readStoredLiveSnapshot(context, details.id, game.id) : null;
    if (snapshot?.live && hasMeaningfulLiveData(snapshot.live)) {
      game.live = {
        ...snapshot.live,
        status: 'ended',
        game_state: snapshot.live.game_state || game.state || 'ended',
        retained_after_end: true,
        retained_from_artifact: snapshot.source === 'static_final_by_game' || undefined,
      };
      game.live.win_probability = await liveWinProbability(game.live, game, details, context);
      return;
    }
    game.live = { ...game.live, status, game_state: game.state || status };
    game.live.win_probability = await liveWinProbability(game.live, game, details, context);
    return;
  }
  try {
    const live = await fetchLive(game.id);
    const meaningful = hasMeaningfulLiveData(live);
    if (meaningful) {
      game.live = { ...live, status: liveStatus(live, game) };
      game.live.win_probability = await liveWinProbability(game.live, game, details, context);
      await waitUntil(context, writeLiveSnapshot(context, details.id, game));
      if (['unstarted', ''].includes(String(game.state || '').toLowerCase())) {
        game.state = 'inProgress';
        details.status = 'inProgress';
      }
      return;
    }
    const snapshot = await readStoredLiveSnapshot(context, details.id, game.id);
    if (snapshot?.live && hasMeaningfulLiveData(snapshot.live)) {
      game.live = {
        ...snapshot.live,
        status: liveStatus(snapshot.live, game),
        retained_after_empty_feed: true,
        retained_from_artifact: snapshot.source === 'static_final_by_game' || undefined,
        warning: live.warning || snapshot.live.warning || 'retained_last_live_snapshot_after_empty_feed',
      };
      game.live.win_probability = await liveWinProbability(game.live, game, details, context);
      return;
    }
    game.live = {
      ...baseLiveForState(game.state),
      status: 'soon',
      game_state: live.game_state || game.state || 'soon',
      game_time: live.game_time || 0,
      warning: live.warning || 'live_stats_empty',
    };
    game.live.win_probability = await liveWinProbability(game.live, game, details, context);
  } catch (error) {
    const snapshot = await readStoredLiveSnapshot(context, details.id, game.id);
    if (snapshot?.live && hasMeaningfulLiveData(snapshot.live)) {
      game.live = {
        ...snapshot.live,
        status: liveStatus(snapshot.live, game),
        retained_after_fetch_error: true,
        retained_from_artifact: snapshot.source === 'static_final_by_game' || undefined,
        warning: error?.message || snapshot.live.warning || 'retained_last_live_snapshot_after_fetch_error',
      };
      game.live.win_probability = await liveWinProbability(game.live, game, details, context);
      return;
    }
    game.live = {
      ...baseLiveForState(game.state),
      status: 'unavailable',
      game_state: game.state || 'unavailable',
      warning: error?.message || 'live_stats_fetch_failed',
    };
    game.live.win_probability = await liveWinProbability(game.live, game, details, context);
  }
}

async function restoreCompletedLiveSnapshots(details, context) {
  if (!details?.id || !Array.isArray(details.games)) return;
  await Promise.all(details.games.map(async game => {
    const state = String(game?.state || '').toLowerCase();
    if (!['completed', 'complete'].includes(state)) return;
    if (hasMeaningfulLiveData(game.live)) return;
    const snapshot = await readStoredLiveSnapshot(context, details.id, game.id);
    if (!snapshot?.live || !hasMeaningfulLiveData(snapshot.live)) return;
    game.live = {
      ...snapshot.live,
      status: 'ended',
      game_state: snapshot.live.game_state || game.state || 'ended',
      retained_after_end: true,
      retained_from_artifact: snapshot.source === 'static_final_by_game' || undefined,
    };
    game.live.win_probability = await liveWinProbability(game.live, game, details, context);
  }));
}

function waitUntil(context, promise) {
  if (typeof context?.waitUntil === 'function') {
    context.waitUntil(promise);
    return;
  }
  return promise;
}

async function readLiveSnapshot(context, eventId, gameId) {
  if (!context?.request?.url || !eventId || !gameId) return null;
  try {
    const response = await caches.default.match(liveSnapshotRequest(context, eventId, gameId));
    if (!response?.ok) return null;
    const payload = await response.json();
    return { ...payload, source: 'cloudflare_cache' };
  } catch (error) {
    return null;
  }
}

async function readStoredLiveSnapshot(context, eventId, gameId) {
  const cached = await readLiveSnapshot(context, eventId, gameId);
  if (cached?.live && hasMeaningfulLiveData(cached.live)) return cached;
  return (await readStaticFinalGameSnapshot(context, eventId, gameId))
    || readStaticEventGameSnapshot(context, eventId, gameId);
}

async function readStaticFinalGameSnapshot(context, eventId, gameId) {
  if (!eventId || !gameId) return null;
  const payload = await loadFinalGameSnapshots(context);
  const key = `${String(eventId)}:${String(gameId)}`;
  const record = payload?.[key] || payload?.[String(gameId)];
  const live = record?.game?.live;
  if (!live || !hasMeaningfulLiveData(live)) return null;
  return {
    event_id: String(record.event_id || eventId),
    game_id: String(record.game_id || gameId),
    saved_at: String(record.checked_at || ''),
    source: 'static_final_by_game',
    game: record.game || {},
    live,
  };
}

async function readStaticEventGameSnapshot(context, eventId, gameId) {
  const eventSnapshot = await readStaticEventSnapshot(context, eventId);
  const game = eventSnapshot?.payload?.games?.find(candidate => String(candidate?.id || '') === String(gameId));
  const live = game?.live;
  if (!live || !hasMeaningfulLiveData(live)) return null;
  return {
    event_id: String(eventSnapshot.payload.id || eventId),
    game_id: String(game.id || gameId),
    saved_at: String(eventSnapshot.checked_at || ''),
    source: eventSnapshot.source,
    game,
    live,
  };
}

async function readStaticEventSnapshot(context, eventId) {
  if (!eventId) return null;
  const key = String(eventId);
  const finalPayload = await loadFinalEventSnapshots(context);
  const finalRecord = finalPayload?.[key];
  if (finalRecord?.payload && eventSnapshotHasMeaningfulLiveData(finalRecord.payload)) {
    return {
      checked_at: String(finalRecord.checked_at || ''),
      source: 'static_final_by_event',
      payload: finalRecord.payload,
    };
  }
  const latestPayload = await loadLatestEventSnapshots(context);
  const latestRecord = latestPayload?.[key];
  if (latestRecord?.payload && eventSnapshotHasMeaningfulLiveData(latestRecord.payload)) {
    return {
      checked_at: String(latestRecord.checked_at || ''),
      source: 'static_latest_by_event',
      payload: latestRecord.payload,
    };
  }
  return null;
}

async function loadFinalGameSnapshots(context) {
  if (finalGameSnapshotsCache.promise && Date.now() < finalGameSnapshotsCache.expiresAt) {
    return finalGameSnapshotsCache.promise;
  }
  finalGameSnapshotsCache = {
    expiresAt: Date.now() + PRE_MATCH_CACHE_SECONDS * 1000,
    promise: readStaticJsonAsset(context, LIVE_EVENT_FINAL_BY_GAME_PATH),
  };
  return finalGameSnapshotsCache.promise;
}

async function loadFinalEventSnapshots(context) {
  if (finalEventSnapshotsCache.promise && Date.now() < finalEventSnapshotsCache.expiresAt) {
    return finalEventSnapshotsCache.promise;
  }
  finalEventSnapshotsCache = {
    expiresAt: Date.now() + PRE_MATCH_CACHE_SECONDS * 1000,
    promise: readStaticJsonAsset(context, LIVE_EVENT_FINAL_BY_EVENT_PATH),
  };
  return finalEventSnapshotsCache.promise;
}

async function loadLatestEventSnapshots(context) {
  if (latestEventSnapshotsCache.promise && Date.now() < latestEventSnapshotsCache.expiresAt) {
    return latestEventSnapshotsCache.promise;
  }
  latestEventSnapshotsCache = {
    expiresAt: Date.now() + PRE_MATCH_CACHE_SECONDS * 1000,
    promise: readStaticJsonAsset(context, LIVE_EVENT_LATEST_BY_EVENT_PATH),
  };
  return latestEventSnapshotsCache.promise;
}

async function readStaticJsonAsset(context, path) {
  try {
    let response = null;
    if (context?.env?.ASSETS) {
      const requestUrl = new URL(context.request.url);
      response = await context.env.ASSETS.fetch(new Request(new URL(path, requestUrl.origin).toString()));
    } else if (context?.request?.url) {
      response = await fetch(new URL(path, context.request.url).toString(), {
        cf: { cacheEverything: true, cacheTtl: EVENT_CACHE_SECONDS },
      });
    }
    if (!response || !response.ok) return null;
    return response.json();
  } catch (error) {
    return null;
  }
}

async function writeLiveSnapshot(context, eventId, game) {
  if (!context?.request?.url || !eventId || !game?.id || !hasMeaningfulLiveData(game.live)) return;
  try {
    const payload = {
      event_id: String(eventId || ''),
      game_id: String(game.id || ''),
      saved_at: new Date().toISOString(),
      game: {
        id: String(game.id || ''),
        number: Number(game.number || 0),
        state: String(game.state || ''),
        blue: game.blue || {},
        red: game.red || {},
        winner: game.winner || '',
      },
      live: game.live,
    };
    const response = jsonResponse(payload, LIVE_SNAPSHOT_CACHE_SECONDS);
    await caches.default.put(liveSnapshotRequest(context, eventId, game.id), response);
  } catch (error) {
  }
}

function liveSnapshotRequest(context, eventId, gameId) {
  const url = new URL(context.request.url);
  url.pathname = `/api/live-event-snapshot/${encodeURIComponent(String(eventId || ''))}/${encodeURIComponent(String(gameId || ''))}`;
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

function currentGame(details) {
  const games = details.games || [];
  const inProgress = games.find(game => String(game.state || '').toLowerCase() === 'inprogress');
  if (inProgress) return inProgress;
  const playable = games.find(game => !['completed', 'unneeded'].includes(String(game.state || '').toLowerCase()));
  if (playable) return playable;
  return games.filter(game => String(game.state || '').toLowerCase() === 'completed').pop() || games[0] || null;
}

function statusForGame(details, game) {
  const state = String(game.state || '').toLowerCase();
  if (['completed', 'complete'].includes(state) || ['completed', 'complete'].includes(String(details.status || '').toLowerCase())) return 'ended';
  const start = new Date(details.start_time || '');
  if (state === 'unstarted' && !Number.isNaN(start.getTime()) && Date.now() < start.getTime()) return 'unstarted';
  if (state === 'unstarted' && Number.isNaN(start.getTime())) return 'unstarted';
  if (state === 'unneeded') return 'unavailable';
  return 'soon';
}

async function enrichDetailsFromPreMatchFeed(details, context) {
  if (!details?.id || details.start_time) return details;
  const prediction = await preMatchPredictionForEvent(details.id, context);
  if (!prediction) return details;
  return {
    ...details,
    league: details.league || String(prediction.league || ''),
    start_time: predictionStartTimeIso(prediction) || details.start_time || '',
  };
}

async function preMatchPredictionForEvent(eventId, context) {
  const feed = await loadPreMatchPredictions(context);
  const rows = Array.isArray(feed?.predictions) ? feed.predictions : [];
  const id = String(eventId || '');
  return rows.find(row => String(row?.event_id || row?.game_id || '') === id) || null;
}

async function loadPreMatchPredictions(context) {
  if (preMatchPredictionsCache.promise && Date.now() < preMatchPredictionsCache.expiresAt) {
    return preMatchPredictionsCache.promise;
  }
  preMatchPredictionsCache = {
    expiresAt: Date.now() + PRE_MATCH_CACHE_SECONDS * 1000,
    promise: (async () => {
    try {
      let response = null;
      if (context?.env?.ASSETS) {
        const requestUrl = new URL(context.request.url);
        response = await context.env.ASSETS.fetch(new Request(new URL(PRE_MATCH_PREDICTIONS_PATH, requestUrl.origin).toString()));
      } else if (context?.request?.url) {
        response = await fetch(new URL(PRE_MATCH_PREDICTIONS_PATH, context.request.url).toString(), {
          cf: { cacheEverything: true, cacheTtl: EVENT_CACHE_SECONDS },
        });
      }
      if (!response || !response.ok) return null;
      return response.json();
    } catch (error) {
      return null;
    }
  })(),
  };
  return preMatchPredictionsCache.promise;
}

function predictionStartTimeIso(prediction) {
  const date = parseScheduleDate(prediction?.start_time || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function parseScheduleDate(value) {
  const text = String(value || '').trim();
  if (!text) return new Date(NaN);
  const utcLike = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (utcLike) return new Date(`${utcLike[1]}T${utcLike[2]}:${utcLike[3] || '00'}Z`);
  return new Date(text);
}

async function fetchLive(gameId) {
  const startingTime = liveFeedStartingTime();
  const [windowPayload, detailsPayload] = await Promise.all([
    fetchLiveJson(`${LIVE_WINDOW_URL}${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(startingTime)}`),
    fetchLiveJson(`${LIVE_DETAILS_URL}${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(startingTime)}`),
  ]);
  if (windowPayload.__error) throw new Error(windowPayload.warning || 'live_stats_fetch_failed');
  const live = normalizeLiveWindow(windowPayload);
  if (detailsPayload.__error && !live.warning) live.warning = detailsPayload.warning;
  mergeLiveDetails(live, detailsPayload);
  return live;
}

async function fetchLiveJson(url) {
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: LIVE_CACHE_SECONDS } });
  if (response.status === 204) return {};
  if (!response.ok) {
    let message = `live_stats_http_${response.status}`;
    try {
      const payload = await response.json();
      message = payload?.message || payload?.errorCode || message;
    } catch (error) {
    }
    return { __error: true, warning: message };
  }
  return response.json();
}

function liveFeedStartingTime() {
  const timestamp = Math.floor((Date.now() - LIVE_FEED_DELAY_SECONDS * 1000) / 1000);
  const rounded = timestamp - (timestamp % 10);
  return new Date(rounded * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function normalizeLiveWindow(payload) {
  if (!payload || typeof payload !== 'object') return { ...emptyLive(), warning: 'live_stats_empty' };
  const metadata = payload.gameMetadata || {};
  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  const frame = frames.length ? frames[frames.length - 1] || {} : {};
  const blueFrame = frame.blueTeam || {};
  const redFrame = frame.redTeam || {};
  const live = {
    game_state: String(frame.gameState || payload.gameState || ''),
    game_time: Number(frame.gameTime || payload.gameTime || 0),
    frame_timestamp: String(frame.rfc460Timestamp || ''),
    patch_version: String(metadata.patchVersion || ''),
    blue: liveParticipants(metadata.blueTeamMetadata || {}, blueFrame),
    red: liveParticipants(metadata.redTeamMetadata || {}, redFrame),
    blue_stats: liveTeamStats(blueFrame),
    red_stats: liveTeamStats(redFrame),
    status: 'soon',
    warning: frames.length ? '' : 'live_stats_empty',
    source: 'lolesports_livestats',
  };
  applyEstimatedGameTime(live);
  return live;
}

function applyEstimatedGameTime(live) {
  if (number(live.game_time) > 0) return;
  const estimated = estimateGameTime(live);
  if (estimated <= 0) return;
  live.game_time = estimated;
  live.estimated_game_time = true;
  live.warning = live.warning || 'game_time_estimated';
}

function estimateGameTime(live) {
  const blueGold = number(live?.blue_stats?.gold) || playerTotals(live?.blue || []).gold;
  const redGold = number(live?.red_stats?.gold) || playerTotals(live?.red || []).gold;
  const blueCs = playerTotals(live?.blue || []).creepScore;
  const redCs = playerTotals(live?.red || []).creepScore;
  const estimates = [];
  const avgGold = (blueGold + redGold) / 2;
  if (avgGold > 2500) estimates.push(((avgGold - 2500) / 1350) * 60);
  const avgCs = (blueCs + redCs) / 2;
  if (avgCs > 0) estimates.push((avgCs / 32) * 60);
  if (!estimates.length) return 0;
  estimates.sort((a, b) => a - b);
  return Math.round(clamp(estimates[Math.floor(estimates.length / 2)], 0, 3600));
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

function hasMeaningfulLiveData(live) {
  if (!live || typeof live !== 'object') return false;
  if ((live.blue || []).length || (live.red || []).length) return true;
  if (Number(live.game_time || 0) > 0) return true;
  return ['in_game', 'inprogress', 'in_progress', 'paused'].includes(String(live.game_state || '').toLowerCase());
}

function eventSnapshotHasMeaningfulLiveData(payload) {
  const games = Array.isArray(payload?.games) ? payload.games : [];
  return games.some(game => hasMeaningfulLiveData(game?.live));
}

function liveStatus(live, game) {
  const gameState = String(live.game_state || game.state || '').toLowerCase();
  if (['completed', 'complete'].includes(gameState)) return 'ended';
  if (hasMeaningfulLiveData(live)) return 'in_game';
  return 'soon';
}

async function liveWinProbability(live, game = {}, details = {}, context = null) {
  if (!hasMeaningfulLiveData(live)) {
    return {
      blue: 0.5,
      red: 0.5,
      model: 'heuristic_live_v0',
      status: 'waiting_for_live_stats',
      warning: live?.warning || '',
    };
  }
  const modelPrediction = await liveModelWinProbability(live, game, details, context);
  if (modelPrediction) return modelPrediction;
  const blueStats = live.blue_stats || {};
  const redStats = live.red_stats || {};
  const bluePlayers = playerTotals(live.blue || []);
  const redPlayers = playerTotals(live.red || []);
  const goldDiff = number(blueStats.gold) - number(redStats.gold);
  const killDiff = number(blueStats.kills || bluePlayers.kills) - number(redStats.kills || redPlayers.kills);
  const towerDiff = number(blueStats.towers) - number(redStats.towers);
  const inhibitorDiff = number(blueStats.inhibitors) - number(redStats.inhibitors);
  const dragonDiff = number(blueStats.dragons) - number(redStats.dragons);
  const baronDiff = number(blueStats.barons) - number(redStats.barons);
  const levelDiff = bluePlayers.avgLevel - redPlayers.avgLevel;
  const timeMinutes = Math.max(1, number(live.game_time) / 60);
  const timeScale = Math.min(1.4, Math.max(0.75, timeMinutes / 18));
  const logit = (
    0.00018 * goldDiff
    + 0.16 * killDiff
    + 0.32 * towerDiff
    + 0.5 * inhibitorDiff
    + 0.22 * dragonDiff
    + 0.45 * baronDiff
    + 0.09 * levelDiff
  ) * timeScale;
  const blue = clamp(1 / (1 + Math.exp(-logit)), 0.03, 0.97);
  return {
    blue,
    red: 1 - blue,
    model: 'heuristic_live_v0',
    status: 'estimated',
    features: {
      gold_diff: goldDiff,
      kill_diff: killDiff,
      tower_diff: towerDiff,
      inhibitor_diff: inhibitorDiff,
      dragon_diff: dragonDiff,
      baron_diff: baronDiff,
      avg_level_diff: levelDiff,
      game_time: number(live.game_time),
    },
  };
}

async function liveModelWinProbability(live, game, details, context) {
  const model = await loadLiveModel(context);
  if (!model) return null;
  if (isWorkersLiveLogisticModel(model)) return workersLiveLogisticWinProbability(model, live, game, details);
  if (model.schema !== 'live_logistic_regression_v1') return null;
  const row = liveFeatureRow(live, game, details);
  let coefficientIndex = 0;
  let logit = Number(model.intercept || 0);
  for (const feature of model.categorical || []) {
    const value = stringValue(row[feature.name] ?? feature.fill_value ?? 'unknown');
    for (const category of feature.categories || []) {
      if (value === stringValue(category)) logit += Number(model.coefficients?.[coefficientIndex] || 0);
      coefficientIndex += 1;
    }
  }
  for (const feature of model.numeric || []) {
    const raw = number(row[feature.name]);
    const imputed = Number.isFinite(raw) ? raw : Number(feature.impute || 0);
    const scaled = (imputed - Number(feature.mean || 0)) / (Number(feature.scale || 1) || 1);
    logit += scaled * Number(model.coefficients?.[coefficientIndex] || 0);
    coefficientIndex += 1;
  }
  const blue = clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.99);
  return {
    blue,
    red: 1 - blue,
    model: model.name || 'live_logreg_v1',
    status: 'estimated',
    feature_schema: model.feature_schema || 'live_frame_v1',
    training_rows: model.training_rows || 0,
    test_rows: model.test_rows || 0,
    metrics: model.metrics || {},
    validation: liveValidationBucket(model, row.game_time),
    features: {
      gold_diff: row.gold_diff,
      kill_diff: row.kill_diff,
      tower_diff: row.tower_diff,
      inhibitor_diff: row.inhibitor_diff,
      dragon_diff: row.dragon_diff,
      baron_diff: row.baron_diff,
      avg_level_diff: row.avg_level_diff,
      game_time: row.game_time,
    },
  };
}

function workersLiveLogisticWinProbability(model, live, game, details) {
  const row = workersLiveFeatureRow(live, game, details);
  const columns = Array.isArray(model.feature_columns) ? model.feature_columns.map(String) : [];
  if (!columns.length) return null;
  const scaler = model.scaler || {};
  const means = scaler.means || {};
  const stds = scaler.stds || {};
  const coefficients = model.coefficients || {};
  let logit = Number(model.intercept || 0);
  for (const column of columns) {
    const raw = number(row[column]);
    const mean = Number(means[column] ?? 0);
    const std = Number(stds[column] ?? 1) || 1;
    const scaled = (raw - mean) / std;
    logit += scaled * Number(coefficients[column] ?? 0);
  }
  let blue = clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.99);
  const calibration = model.calibration || {};
  if (calibration.method === 'logit_platt') {
    const clipped = clamp(blue, 1e-15, 1 - 1e-15);
    const calibratedLogit = Number(calibration.intercept || 0) + Number(calibration.slope || 1) * Math.log(clipped / (1 - clipped));
    blue = clamp(1 / (1 + Math.exp(-calibratedLogit)), 0.01, 0.99);
  }
  return {
    blue,
    red: 1 - blue,
    model: model.model_version || 'live_logistic',
    status: 'estimated',
    feature_schema: 'live_frame_v1',
    bootstrap_only: Boolean(model.bootstrap_only),
    cadence_note: model.cadence_note || '',
    training_rows: model.training_rows || model.calibration?.num_rows || 0,
    test_rows: model.evaluation?.num_predictions || 0,
    metrics: model.evaluation || {},
    validation: workersLiveValidation(model, row.elapsed_seconds),
    features: {
      gold_diff: row.gold_diff,
      kill_diff: row.kill_diff,
      tower_diff: row.tower_diff,
      inhibitor_diff: row.inhibitor_diff,
      dragon_diff: row.dragon_diff,
      baron_diff: row.baron_diff,
      avg_level_diff: row.level_diff,
      game_time: row.elapsed_seconds,
    },
  };
}

function isWorkersLiveLogisticModel(model) {
  return model?.workers_compatible === true && model?.model_type === 'numpy_logistic_regression';
}

function workersLiveValidation(model, elapsedSeconds) {
  const evaluation = model.evaluation || {};
  const earliest = String(evaluation.earliest_reliable_bucket || '');
  const bucketName = workersLiveElapsedBucket(elapsedSeconds);
  const bucketMetrics = Array.isArray(evaluation.bucket_metrics) ? evaluation.bucket_metrics : [];
  const bucket = bucketMetrics.find(item => String(item?.elapsed_bucket || '') === bucketName) || null;
  const display = bucket?.is_display_candidate === true
    ? 'show_live_probability'
    : 'hide_live_probability';
  return {
    display,
    source: model.bootstrap_source || model.model_version || '',
    earliest_reliable_bucket: earliest,
    elapsed_seconds: number(elapsedSeconds),
    elapsed_bucket: bucketName,
    bucket_num_predictions: bucket ? number(bucket.num_predictions) : null,
    bucket_is_display_candidate: bucket ? bucket.is_display_candidate === true : null,
    bootstrap_only: Boolean(model.bootstrap_only),
  };
}

function workersLiveElapsedBucket(elapsedSeconds) {
  const seconds = Math.max(0, number(elapsedSeconds));
  if (seconds < 10 * 60) return '00-10';
  if (seconds < 20 * 60) return '10-20';
  if (seconds < 30 * 60) return '20-30';
  if (seconds < 40 * 60) return '30-40';
  return '40+';
}

function liveValidationBucket(model, gameTime) {
  const guidance = model.serving_guidance || {};
  const buckets = Array.isArray(guidance.time_buckets) ? guidance.time_buckets : [];
  const seconds = number(gameTime);
  const bucket = buckets.find(item => seconds >= number(item.start_seconds) && seconds < number(item.end_seconds));
  if (!bucket) {
    return {
      display: guidance.default_display || 'show_live_probability',
      source: guidance.source || '',
    };
  }
  return {
    display: bucket.display || guidance.default_display || 'show_live_probability',
    source: guidance.source || '',
    start_seconds: number(bucket.start_seconds),
    end_seconds: number(bucket.end_seconds),
    games: number(bucket.games),
    rows: number(bucket.rows),
    roc_auc: bucket.roc_auc ?? null,
    brier: bucket.brier ?? null,
  };
}

async function loadLiveModel(context) {
  if (liveModelPromise) return liveModelPromise;
  liveModelPromise = (async () => {
    for (const path of [LIVE_LOGISTIC_MODEL_PATH, LIVE_BOOTSTRAP_MODEL_PATH, LIVE_MODEL_PATH]) {
      const model = await readLiveModelAsset(context, path);
      if (model) return model;
    }
    return null;
  })();
  return liveModelPromise;
}

async function readLiveModelAsset(context, path) {
  try {
    let response = null;
    if (context?.env?.ASSETS) {
      const requestUrl = new URL(context.request.url);
      response = await context.env.ASSETS.fetch(new Request(new URL(path, requestUrl.origin).toString()));
    } else if (context?.request?.url) {
      response = await fetch(new URL(path, context.request.url).toString(), {
        cf: { cacheEverything: true, cacheTtl: EVENT_CACHE_SECONDS },
      });
    }
    if (!response || !response.ok) return null;
    return response.json();
  } catch (error) {
    return null;
  }
}

function workersLiveFeatureRow(live, game, details) {
  const row = liveFeatureRow(live, game, details);
  const blueStats = live.blue_stats || {};
  const redStats = live.red_stats || {};
  const bluePlayers = playerFeatureTotals(live.blue || []);
  const redPlayers = playerFeatureTotals(live.red || []);
  const elapsedSeconds = number(row.game_time);
  const elapsedMinutes = elapsedSeconds / 60;
  const goldDiff = number(row.gold_diff);
  return {
    ...row,
    elapsed_seconds: elapsedSeconds,
    elapsed_minutes: elapsedMinutes,
    gold_diff_per_minute: goldDiff / Math.max(1, elapsedMinutes),
    level_diff: row.avg_level_diff,
    blue_gold: number(blueStats.gold),
    red_gold: number(redStats.gold),
    blue_kills: number(blueStats.kills || bluePlayers.kills),
    red_kills: number(redStats.kills || redPlayers.kills),
    blue_towers: number(blueStats.towers),
    red_towers: number(redStats.towers),
    blue_dragons: number(blueStats.dragons),
    red_dragons: number(redStats.dragons),
    blue_barons: number(blueStats.barons),
    red_barons: number(redStats.barons),
    blue_inhibitors: number(blueStats.inhibitors),
    red_inhibitors: number(redStats.inhibitors),
    blue_levels: bluePlayers.avgLevel,
    red_levels: redPlayers.avgLevel,
    blue_cs: bluePlayers.creepScore,
    red_cs: redPlayers.creepScore,
    pre_match_blue_win_prob: 0.5,
    post_draft_blue_win_prob: 0.5,
  };
}

function liveFeatureRow(live, game, details) {
  const blueStats = live.blue_stats || {};
  const redStats = live.red_stats || {};
  const bluePlayers = playerFeatureTotals(live.blue || []);
  const redPlayers = playerFeatureTotals(live.red || []);
  const blueTeam = game.blue || {};
  const redTeam = game.red || {};
  const blueGold = number(blueStats.gold);
  const redGold = number(redStats.gold);
  const blueKills = number(blueStats.kills || bluePlayers.kills);
  const redKills = number(redStats.kills || redPlayers.kills);
  const gameTime = number(live.game_time);
  const minutes = Math.max(gameTime / 60, 1);
  const goldDiff = blueGold - redGold;
  const killDiff = blueKills - redKills;
  const towerDiff = number(blueStats.towers) - number(redStats.towers);
  const dragonDiff = number(blueStats.dragons) - number(redStats.dragons);
  const baronDiff = number(blueStats.barons) - number(redStats.barons);
  const inhibitorDiff = number(blueStats.inhibitors) - number(redStats.inhibitors);
  const csDiff = bluePlayers.creepScore - redPlayers.creepScore;
  const playerGoldDiff = bluePlayers.gold - redPlayers.gold;
  const avgLevelDiff = bluePlayers.avgLevel - redPlayers.avgLevel;
  const totalGold = blueGold + redGold;
  return {
    league: stringValue(details.league || ''),
    patch_version: stringValue(live.patch_version || ''),
    best_of: stringValue(details.best_of || ''),
    game_number: stringValue(game.number || ''),
    blue_team: stringValue(blueTeam.team_name || blueTeam.team_code || ''),
    red_team: stringValue(redTeam.team_name || redTeam.team_code || ''),
    game_time: gameTime,
    blue_gold: blueGold,
    red_gold: redGold,
    gold_diff: goldDiff,
    blue_kills: blueKills,
    red_kills: redKills,
    kill_diff: killDiff,
    blue_towers: number(blueStats.towers),
    red_towers: number(redStats.towers),
    tower_diff: towerDiff,
    blue_inhibitors: number(blueStats.inhibitors),
    red_inhibitors: number(redStats.inhibitors),
    inhibitor_diff: inhibitorDiff,
    blue_barons: number(blueStats.barons),
    red_barons: number(redStats.barons),
    baron_diff: baronDiff,
    blue_dragons: number(blueStats.dragons),
    red_dragons: number(redStats.dragons),
    dragon_diff: dragonDiff,
    blue_avg_level: bluePlayers.avgLevel,
    red_avg_level: redPlayers.avgLevel,
    avg_level_diff: avgLevelDiff,
    blue_cs: bluePlayers.creepScore,
    red_cs: redPlayers.creepScore,
    cs_diff: csDiff,
    blue_player_gold: bluePlayers.gold,
    red_player_gold: redPlayers.gold,
    player_gold_diff: playerGoldDiff,
    blue_deaths: bluePlayers.deaths,
    red_deaths: redPlayers.deaths,
    death_diff: bluePlayers.deaths - redPlayers.deaths,
    gold_diff_per_min: goldDiff / minutes,
    kill_diff_per_min: killDiff / minutes,
    tower_diff_per_min: towerDiff / minutes,
    dragon_diff_per_min: dragonDiff / minutes,
    cs_diff_per_min: csDiff / minutes,
    player_gold_diff_per_min: playerGoldDiff / minutes,
    blue_gold_share: totalGold > 0 ? blueGold / totalGold : 0.5,
    live_advantage_score: liveAdvantageScore({
      goldDiff,
      killDiff,
      towerDiff,
      dragonDiff,
      baronDiff,
      inhibitorDiff,
      csDiff,
      avgLevelDiff,
    }),
  };
}

function liveAdvantageScore({ goldDiff, killDiff, towerDiff, dragonDiff, baronDiff, inhibitorDiff, csDiff, avgLevelDiff }) {
  return (
    goldDiff / 1000
    + killDiff * 0.6
    + towerDiff * 1.2
    + dragonDiff * 0.8
    + baronDiff * 1.5
    + inhibitorDiff * 2
    + csDiff / 50
    + avgLevelDiff * 1.2
  );
}

function playerFeatureTotals(players) {
  const valid = Array.isArray(players) ? players.filter(player => player && typeof player === 'object') : [];
  const levels = valid.map(player => number(player.level)).filter(level => level > 0);
  return {
    kills: valid.reduce((total, player) => total + number(player.kills), 0),
    deaths: valid.reduce((total, player) => total + number(player.deaths), 0),
    creepScore: valid.reduce((total, player) => total + number(player.creep_score), 0),
    gold: valid.reduce((total, player) => total + number(player.gold), 0),
    avgLevel: levels.length ? levels.reduce((total, level) => total + level, 0) / levels.length : 0,
  };
}

function playerTotals(players) {
  const valid = Array.isArray(players) ? players.filter(player => player && typeof player === 'object') : [];
  const levels = valid.map(player => number(player.level)).filter(level => level > 0);
  return {
    kills: valid.reduce((total, player) => total + number(player.kills), 0),
    gold: valid.reduce((total, player) => total + number(player.gold), 0),
    creepScore: valid.reduce((total, player) => total + number(player.creep_score), 0),
    avgLevel: levels.length ? levels.reduce((total, level) => total + level, 0) / levels.length : 0,
  };
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function baseLiveForState(state) {
  const status = String(state || '').toLowerCase() === 'completed' ? 'ended' : 'unstarted';
  return {
    game_state: String(state || ''),
    game_time: 0,
    blue: [],
    red: [],
    blue_stats: {},
    red_stats: {},
    status,
    warning: '',
    win_probability: {
      blue: 0.5,
      red: 0.5,
      model: 'heuristic_live_v0',
      status: 'waiting_for_live_stats',
      warning: '',
    },
  };
}

function emptyLive() {
  return {
    game_state: '',
    game_time: 0,
    blue: [],
    red: [],
    blue_stats: {},
    red_stats: {},
    status: 'unavailable',
    warning: '',
  };
}

function responseCacheSeconds(details) {
  const game = currentGame(details);
  const status = String(game?.live?.status || '').toLowerCase();
  return ['in_game', 'soon'].includes(status) ? LIVE_CACHE_SECONDS : EVENT_CACHE_SECONDS;
}

function unavailable(eventId, warning) {
  return {
    id: eventId,
    league: '',
    league_group: '',
    region: '',
    best_of: '',
    status: 'unavailable',
    start_time: '',
    teams: [],
    games: [],
    source: 'cloudflare_live_event',
    warning,
  };
}

function jsonResponse(payload, maxAge) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
      'X-Cache': 'MISS',
    },
  });
}
