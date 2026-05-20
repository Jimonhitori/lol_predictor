const EVENT_DETAILS_URL = 'https://esports-api.lolesports.com/persisted/gw/getEventDetails';
const LIVE_WINDOW_URL = 'https://feed.lolesports.com/livestats/v1/window/';
const LIVE_DETAILS_URL = 'https://feed.lolesports.com/livestats/v1/details/';
const DEFAULT_LOLESPORTS_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const EVENT_CACHE_SECONDS = 45;
const LIVE_CACHE_SECONDS = 4;
const LIVE_MODEL_PATH = '/static/data/live_model.json';
let liveModelPromise = null;

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
    details.warning = details.warning || '';
    await attachTargetLive(details, context);
    cacheTtl = responseCacheSeconds(details);
  } catch (error) {
    details = unavailable(eventId, 'event_details_fetch_failed');
  }

  const response = jsonResponse(details, cacheTtl);
  context.waitUntil(cache.put(context.request, response.clone()));
  return response;
}

async function fetchEventDetails(eventId, env) {
  const url = new URL(EVENT_DETAILS_URL);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('id', eventId);
  const response = await fetch(url.toString(), {
    headers: {
      'x-api-key': (env && env.LOL_ESPORTS_API_KEY) || DEFAULT_LOLESPORTS_API_KEY,
      accept: 'application/json',
    },
    cf: { cacheEverything: true, cacheTtl: EVENT_CACHE_SECONDS },
  });
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
      if (['unstarted', ''].includes(String(game.state || '').toLowerCase())) {
        game.state = 'inProgress';
        details.status = 'inProgress';
      }
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
    game.live = {
      ...baseLiveForState(game.state),
      status: 'unavailable',
      game_state: game.state || 'unavailable',
      warning: error?.message || 'live_stats_fetch_failed',
    };
    game.live.win_probability = await liveWinProbability(game.live, game, details, context);
  }
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
  if (state === 'unneeded') return 'unavailable';
  return 'soon';
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
  const timestamp = Math.floor((Date.now() - 60000) / 1000);
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
  if (!model || model.schema !== 'live_logistic_regression_v1') return null;
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
    try {
      let response = null;
      if (context?.env?.ASSETS) {
        const requestUrl = new URL(context.request.url);
        response = await context.env.ASSETS.fetch(new Request(new URL(LIVE_MODEL_PATH, requestUrl.origin).toString()));
      } else if (context?.request?.url) {
        response = await fetch(new URL(LIVE_MODEL_PATH, context.request.url).toString(), {
          cf: { cacheEverything: true, cacheTtl: EVENT_CACHE_SECONDS },
        });
      }
      if (!response || !response.ok) return null;
      return response.json();
    } catch (error) {
      return null;
    }
  })();
  return liveModelPromise;
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
