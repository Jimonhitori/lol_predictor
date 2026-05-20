
const state = { options: null, summary: null, detailMatchId: null, detailTimer: null, matchesTimer: null, liveClockTimer: null, rosterKey: '', selectedLiveGameId: '', rosters: {}, currentDetails: null, allMatches: [], selectedMatchDate: '', matchSource: '', liveFrames: {}, teamStanding: 'league:LCK', preMatchPredictions: { byEventId: {}, byGameId: {}, byMatchKey: {}, meta: {}, status: 'not_loaded' }, preMatchPredictionPromise: null, diagnostics: null, diagnosticsPromise: null };
const $ = (id) => document.getElementById(id);
const STATIC_SITE = Boolean(window.STATIC_SITE);
const REFRESH_INTERVAL_MS = 5000;
const REFRESH_INTERVAL_LABEL = '5s';
const MATCHES_REFRESH_INTERVAL_MS = 60000;
const LIVE_PRESTART_PROBE_MS = 20 * 60 * 1000;
const MATCH_DETAIL_PAGE = Boolean($('matchTitle'));
const DEFAULT_PRE_MATCH_PREDICTIONS_URL = 'https://jimonhitori.github.io/lol-pros-analyzer/pre_match_predictions.json';

async function api(path) {
  if (STATIC_SITE && isCloudflareApiPath(path)) return fetchApiJson(path);
  if (STATIC_SITE) return staticApi(path);
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function isCloudflareApiPath(path) {
  const url = new URL(path, location.origin);
  return url.pathname === '/api/live-event';
}

async function fetchApiJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function loadDiagnostics() {
  if (!$('opsMeta')) return null;
  if (state.diagnosticsPromise) return state.diagnosticsPromise;
  state.diagnosticsPromise = (async () => {
    try {
      const response = await fetch('/api/diagnostics', { cache: 'no-store' });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        renderDiagnostics({ ok: false, warning: `diagnostics_http_${response.status}` });
        return null;
      }
      if (!contentType.includes('application/json')) {
        renderDiagnostics({ ok: false, warning: 'diagnostics_function_not_deployed' });
        return null;
      }
      const data = await response.json();
      state.diagnostics = data;
      renderDiagnostics(data);
      return data;
    } catch (error) {
      renderDiagnostics(null);
      return null;
    }
  })();
  return state.diagnosticsPromise;
}

function renderDiagnostics(data) {
  const target = $('opsMeta');
  if (!target) return;
  if (!data?.ok) {
    target.textContent = data?.warning ? `ops ${data.warning}` : '';
    return;
  }
  const contract = data.contract_ok === false ? 'contract pending' : 'contract ok';
  const live = data.live_model_available
    ? `live ${data.live_model_name || 'model'}`
    : 'live model missing';
  const feed = data.prediction_feed_available
    ? `pre ${data.prediction_feed_rows ?? 0} rows`
    : 'pre remote fallback';
  const generated = data.prediction_feed_generated_at ? `pre ${shortDateTime(data.prediction_feed_generated_at)}` : '';
  const analyzerLive = data.live_status_available
    ? `analyzer ${data.live_status_stage || (data.live_status_display_ready ? 'display ready' : 'not ready')}`
    : 'analyzer status missing';
  const worker = data.live_worker_checked
    ? `worker ${data.live_worker_ok ? 'ok' : 'check failed'}`
    : '';
  target.textContent = [contract, live, feed, generated, analyzerLive, worker].filter(Boolean).join(' | ');
}

async function staticApi(path) {
  const url = new URL(path, location.origin);
  const params = url.searchParams;
  let target = '';
  if (url.pathname === '/api/options') {
    target = 'data/options.json';
  } else if (url.pathname === '/api/summary') {
    target = params.get('league')
      ? `data/summaries/league__${staticKey(params.get('league'))}.json`
      : `data/summaries/${staticKey(params.get('league_group') || $('leagueGroup')?.value || 'all')}__${staticKey(params.get('region') || $('region')?.value || 'all')}.json`;
  } else if (url.pathname === '/api/matches/today') {
    target = `data/matches-${staticKey($('leagueGroup')?.value || params.get('league_group') || 'all')}__${staticKey($('region')?.value || params.get('region') || 'all')}.json`;
  } else if (url.pathname === '/api/match') {
    target = `data/matches/${encodeURIComponent(params.get('id') || '')}.json`;
  } else if (url.pathname === '/api/roster') {
    target = `data/rosters/${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/team-record') {
    target = `data/team-records/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/head-to-head') {
    target = `data/h2h/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team_a') || '')}__${staticKey(params.get('team_b') || '')}.json`;
  }
  if (!target) throw new Error(`Static data route is not available: ${path}`);
  target = staticDataUrl(target);
  let response = await fetch(target, { cache: 'no-store' });
  if (!response.ok && url.pathname === '/api/head-to-head') {
    const reverseTarget = staticDataUrl(`data/h2h/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team_b') || '')}__${staticKey(params.get('team_a') || '')}.json`);
    if (reverseTarget !== target) {
      response = await fetch(reverseTarget, { cache: 'no-store' });
      if (response.ok) target = reverseTarget;
    }
  }
  if (!response.ok) throw new Error(`Static data missing: ${target}`);
  const data = await response.json();
  return data;
}

function staticDataUrl(path) {
  const script = document.querySelector('script[src*="app.js"]');
  return new URL(path, script?.src || new URL('static/app.js', location.href)).toString();
}

function staticKey(value) {
  return String(value || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
}

async function fetchLolesportsEventDetails(matchId) {
  if (!STATIC_SITE || !matchId) return {};
  try {
    return await api('/api/live-event?id=' + encodeURIComponent(matchId));
  } catch (error) {
    return {};
  }
}

function normalizeLolesportsEventDetail(event) {
  const match = event.match || {};
  const teams = Array.isArray(match.teams) ? match.teams : [];
  const games = Array.isArray(match.games) ? match.games : [];
  const league = event.league || {};
  const teamById = Object.fromEntries(teams.map(team => [String(team.id || ''), team]));
  const bestOf = String(match.strategy?.count || '');
  const normalizedTeams = teams.map(normalizeLolesportsTeam);
  const normalizedGames = games.map(game => normalizeLolesportsGame(game, teamById));
  return {
    id: String(event.id || match.id || ''),
    league: String(league.name || 'Unknown'),
    best_of: bestOf,
    status: seriesStateFromGames(normalizedGames, normalizedTeams, bestOf, String(event.state || '')),
    start_time: String(event.startTime || ''),
    teams: normalizedTeams,
    games: normalizedGames,
    source: 'lolesports_api',
  };
}

function normalizeLolesportsTeam(team) {
  const result = team.result || {};
  return {
    id: String(team.id || ''),
    name: String(team.name || ''),
    code: String(team.code || ''),
    image: String(team.image || ''),
    game_wins: String(result.gameWins ?? '0'),
  };
}

function normalizeLolesportsGame(game, teamById) {
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
  return {
    id: String(game.id || ''),
    number: Number(game.number || 0),
    state: String(game.state || ''),
    blue: sides.blue || {},
    red: sides.red || {},
    winner: typeof winner === 'object' ? String(winner.code || winner.name || winner.id || '') : String(winner || ''),
    live: {},
  };
}

function seriesStateFromGames(games, teams, bestOf, eventState) {
  const event = String(eventState || '').toLowerCase();
  const needed = Number(bestOf || 0) ? Math.floor(Number(bestOf) / 2) + 1 : 0;
  const wins = teams.map(team => scoreNumber(team.game_wins));
  if (needed && Math.max(...wins, 0) >= needed) return 'completed';
  if (['completed', 'complete'].includes(event)) return 'completed';
  if (games.some(game => String(game.state || '').toLowerCase() === 'inprogress')) return 'inProgress';
  if (games.some(game => String(game.state || '').toLowerCase() === 'completed')) return 'inProgress';
  return event || 'unstarted';
}

function mergeFreshDetails(base, fresh) {
  if (!fresh?.id) return base;
  return {
    ...base,
    ...fresh,
    league_group: base.league_group || fresh.league_group || '',
    region: base.region || fresh.region || '',
    start_time: fresh.start_time || base.start_time || '',
  };
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
  const header = '<div class="row header"><span>#</span><span>Team</span><span>Series</span><span>Games</span><span>Winrate</span></div>';
  $('teams').innerHTML = header + rows.map((r, index) => `
    <div class="row">
      <span class="rankCell">${index + 1}</span>
      <span>${escapeHtml(r.name)}</span>
      <span>${escapeHtml(teamRecordText(r))}</span>
      <span>${escapeHtml(r.game_record || '')}</span>
      <span>${r.winrate}</span>
    </div>
  `).join('');
}

function teamRecordText(row) {
  const games = Number(row.games ?? row.picks ?? 0);
  const wins = Number(row.wins ?? 0);
  const losses = row.losses !== undefined ? Number(row.losses || 0) : Math.max(0, games - wins);
  return `${wins}-${losses}`;
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
  const header = `<div class="row header championMetaRow"><span>Champion</span><span>Picks</span><span>Wins</span><span>WR</span><span>P/B</span></div>`;
  $(id).innerHTML = header + rows.map(r => `
    <div class="row championMetaRow">
      <span class="championMetaCell">
        ${championImage(r.name, version)}
        <span>${escapeHtml(championDisplayName(r.name))}</span>
      </span>
      <span>${r.games ?? r.picks}</span>
      <span>${r.wins}</span>
      <span>${r.winrate}</span>
      <span>${r.presence || '-'}</span>
    </div>
  `).join('');
}

function renderChampionMeta(data) {
  const role = $('championRole')?.value || 'all';
  const rows = role === 'all' ? (data.champions || []) : ((data.champions_by_role || {})[role] || []);
  const label = roleLabel(role === 'all' ? 'All roles' : role);
  if ($('championMetaSub')) $('championMetaSub').textContent = `${label} · ${patchLabel(data.patch)} · ${data.games} games`;
  renderChampionTable('champions', rows, data.patch);
}

function patchLabel(patch) {
  const patchText = String(patch || '').trim();
  const riot = riotPatchLabel(patchText);
  return riot && riot !== patchText ? `Patch ${patchText} / Riot ${riot}` : `Patch ${patchText || '-'}`;
}

function riotPatchLabel(patch) {
  const match = String(patch || '').match(/^(\d+)\.(\d+)$/);
  if (!match) return '';
  const major = Number(match[1]);
  const minor = match[2].padStart(2, '0');
  if (major === 16) return `26.${minor}`;
  return `${major}.${minor}`;
}

async function loadOptions() {
  state.options = await api('/api/options');
  fillSelect('league', state.options.leagues);
  for (const id of ['top_champion','jng_champion','mid_champion','bot_champion','sup_champion']) fillSelect(id, state.options.champions);
  $('leagueGroup').value = 'all';
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
  state.summary = data;
  $('meta').textContent = `${patchLabel(data.patch)} | ${data.games} games | ${data.leagues.join(', ')}`;
  renderChampionMeta(data);
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
  const basis = data.standings_split || patchLabel(data.patch);
  $('teamStandingsMeta').textContent = `${label} · ${basis} · ${data.standings_series ?? data.games} series`;
}

async function loadMatches() {
  const predictionsReady = loadPreMatchPredictions();
  const data = await api('/api/matches/today?' + qs());
  state.allMatches = data.matches || [];
  state.matchSource = data.source || 'none';
  if (!state.selectedMatchDate) {
    state.selectedMatchDate = defaultMatchDate(state.allMatches);
  }
  await refreshStaticMatchStatuses();
  renderDateTabs(state.allMatches);
  renderMatches();
  predictionsReady.then(() => renderMatches()).catch(() => {});
}

async function loadPreMatchPredictions() {
  if (state.preMatchPredictionPromise) return state.preMatchPredictionPromise;
  state.preMatchPredictionPromise = (async () => {
    const candidates = [
      { source: 'local', url: preMatchPredictionLocalUrl() },
      { source: 'remote', url: preMatchPredictionRemoteUrl() },
    ];
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.url, { cache: 'no-store' });
        if (!response.ok) continue;
        const payload = await response.json();
        const normalized = normalizePreMatchPredictionFeed(payload, candidate);
        if (normalized.status === 'loaded' || normalized.status === 'empty') {
          state.preMatchPredictions = normalized;
          return normalized;
        }
      } catch (error) {
      }
    }
    state.preMatchPredictions = { byEventId: {}, byGameId: {}, byMatchKey: {}, meta: {}, status: 'unavailable' };
    return state.preMatchPredictions;
  })();
  return state.preMatchPredictionPromise;
}

function preMatchPredictionLocalUrl() {
  const script = document.querySelector('script[src*="app.js"]');
  return new URL('../pre_match_predictions.json', script?.src || new URL('static/app.js', location.href)).toString();
}

function preMatchPredictionRemoteUrl() {
  const config = window.LOL_PREDICTOR_CONFIG || {};
  return String(window.PRE_MATCH_PREDICTIONS_URL || config.preMatchPredictionsUrl || DEFAULT_PRE_MATCH_PREDICTIONS_URL);
}

function normalizePreMatchPredictionFeed(payload, candidate) {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.predictions) ? payload.predictions : []);
  const result = {
    byEventId: {},
    byGameId: {},
    byMatchKey: {},
    meta: {
      schema: payload?.schema || (Array.isArray(payload) ? 'array' : ''),
      generated_at: payload?.generated_at || '',
      source: candidate.source,
      url: candidate.url,
      models: payload?.models || {},
      row_count: 0,
    },
    status: 'loaded',
  };
  for (const row of rows) {
    const prediction = normalizePreMatchPrediction(row);
    if (!prediction) continue;
    result.meta.row_count += 1;
    if (prediction.event_id) result.byEventId[prediction.event_id] = prediction;
    if (prediction.game_id) result.byGameId[prediction.game_id] = prediction;
    const key = preMatchPredictionKey(prediction);
    if (key) result.byMatchKey[key] = prediction;
  }
  if (!result.meta.row_count) result.status = 'empty';
  return result;
}

function normalizePreMatchPrediction(row) {
  if (!row || typeof row !== 'object') return null;
  const blue = probabilityValue(row.blue_win_probability ?? row.blue_probability ?? row.win_probability_blue ?? row.blue);
  const red = probabilityValue(row.red_win_probability ?? row.red_probability ?? row.win_probability_red ?? row.red);
  const blueProbability = Number.isFinite(blue) ? blue : (Number.isFinite(red) ? 1 - red : NaN);
  const redProbability = Number.isFinite(red) ? red : (Number.isFinite(blueProbability) ? 1 - blueProbability : NaN);
  if (!Number.isFinite(blueProbability) || !Number.isFinite(redProbability)) return null;
  return {
    event_id: String(row.event_id || row.eventId || row.match_id || row.matchId || row.id || ''),
    game_id: String(row.game_id || row.gameId || ''),
    league: String(row.league || ''),
    start_time: String(row.start_time || row.startTime || row.date || ''),
    blue_team: String(row.blue_team || row.blueTeam || row.blue || ''),
    red_team: String(row.red_team || row.redTeam || row.red || ''),
    blue_win_probability: clampProbability(blueProbability),
    red_win_probability: clampProbability(redProbability),
    predicted_winner: String(row.predicted_winner || row.predictedWinner || ''),
    confidence: String(row.confidence || ''),
    model: String(row.model || row.model_version || row.modelVersion || ''),
    warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
  };
}

function probabilityValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return NaN;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function clampProbability(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function preMatchPredictionKey(value) {
  const league = String(value.league || '').toLowerCase().trim();
  const start = normalizedPredictionTime(value.start_time);
  const blue = teamKey(value.blue_team || value.blue || '');
  const red = teamKey(value.red_team || value.red || '');
  return [league, start, blue, red].every(Boolean) ? `${league}|${start}|${blue}|${red}` : '';
}

function normalizedPredictionTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return String(value || '').trim();
  return date.toISOString();
}

async function refreshStaticMatchStatuses() {
  if (!STATIC_SITE || !state.allMatches.length) return;
  const targets = state.allMatches
    .filter(shouldRefreshMatchStatus)
    .sort((a, b) => refreshMatchPriority(b) - refreshMatchPriority(a))
    .slice(0, 40);
  if (!targets.length) return;
  const freshDetails = await Promise.all(targets.map(match => fetchLolesportsEventDetails(match.id)));
  const freshById = Object.fromEntries(freshDetails.filter(details => details?.id).map(details => [String(details.id), details]));
  state.allMatches = state.allMatches.map(match => {
    const fresh = freshById[String(match.id || '')];
    if (!fresh) return match;
    return mergeFreshMatchDetails(match, fresh);
  });
}

function mergeFreshMatchDetails(match, fresh) {
  const teams = fresh.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  const replaceTeams = hasPlaceholderTeamInfo(match) && teams.length >= 2;
  const merged = {
      ...match,
      status: fresh.status || match.status,
      start_time: fresh.start_time || match.start_time,
      best_of: fresh.best_of || match.best_of,
      blue_score: left.game_wins ?? match.blue_score,
      red_score: right.game_wins ?? match.red_score,
  };
  if (replaceTeams) {
    merged.blue_team = left.name || left.code || match.blue_team;
    merged.red_team = right.name || right.code || match.red_team;
    merged.blue_code = left.code || match.blue_code;
    merged.red_code = right.code || match.red_code;
    merged.blue_image = normalizeTeamImage(left.image || match.blue_image);
    merged.red_image = normalizeTeamImage(right.image || match.red_image);
    return merged;
  }
  merged.blue_image = normalizeTeamImage(bestTeamImageForMatch(match, teams, 'blue'));
  merged.red_image = normalizeTeamImage(bestTeamImageForMatch(match, teams, 'red'));
  return merged;
}

function bestTeamImageForMatch(match, teams, side) {
  const current = side === 'blue' ? match.blue_image : match.red_image;
  if (!isPlaceholderImage(current)) return current;
  const name = side === 'blue' ? match.blue_team : match.red_team;
  const code = side === 'blue' ? match.blue_code : match.red_code;
  const team = teams.find(item => sameTeam(item.name, name) || sameTeam(item.code, code) || sameTeam(item.name, code) || sameTeam(item.code, name));
  return team?.image || current;
}

function hasPlaceholderTeamInfo(match) {
  return isPlaceholderTeam(match.blue_team)
    || isPlaceholderTeam(match.red_team)
    || isPlaceholderTeam(match.blue_code)
    || isPlaceholderTeam(match.red_code)
    || isPlaceholderImage(match.blue_image)
    || isPlaceholderImage(match.red_image);
}

function isPlaceholderTeam(value) {
  const text = String(value || '').trim().toLowerCase();
  return !text || text === 'tbd' || text === 'unknown';
}

function isPlaceholderImage(value) {
  const text = String(value || '').trim().toLowerCase();
  return !text || text.includes('team-tbd.png');
}

function normalizeTeamImage(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(new RegExp('^http://static[.]lolesports[.]com/', 'i'), 'https://static.lolesports.com/');
}

function refreshMatchPriority(match) {
  if (hasPlaceholderTeamInfo(match)) return 6;
  const matchDate = localDateKey(match.start_time);
  const today = localDateKey(new Date().toISOString());
  if (state.selectedMatchDate === 'live' && String(match.status || '').toLowerCase() === 'inprogress') return 5;
  if (matchDate === state.selectedMatchDate) return 4;
  if (matchDate === today) return 3;
  if (matchDate && matchDate < today) return 2;
  return 1;
}

function shouldRefreshMatchStatus(match) {
  if (!match?.id) return false;
  const status = String(match.status || '').toLowerCase();
  if (['completed', 'complete'].includes(status)) return false;
  const matchDate = localDateKey(match.start_time);
  const today = localDateKey(new Date().toISOString());
  if (hasPlaceholderTeamInfo(match) && (matchDate === state.selectedMatchDate || matchDate === today)) return true;
  return state.selectedMatchDate === 'live'
    || matchDate === state.selectedMatchDate
    || matchDate === today
    || (matchDate && matchDate < today);
}

function renderMatches() {
  const matches = filteredMatches();
  $('matchSource').textContent = `${matches.length} / ${state.allMatches.length} matches | ${state.matchSource || 'none'}${predictionFeedSourceLabel()}`;
  if (!matches.length) {
    $('matches').innerHTML = '<p>No matches for the selected filters.</p>';
    return;
  }
  $('matches').innerHTML = matches.map(match => `
    <a class="match" href="${detailHref(match.id)}" data-id="${escapeHtml(match.id)}" data-blue="${escapeHtml(match.blue_team)}" data-red="${escapeHtml(match.red_team)}" data-league="${escapeHtml(match.league)}" data-bestof="${escapeHtml(match.best_of)}" data-status="${escapeHtml(match.status)}" data-start="${escapeHtml(match.start_time)}">
      <div class="matchMeta"><span>${escapeHtml(match.league)} · BO${escapeHtml(match.best_of || '-')}</span><span>${escapeHtml(matchStatusLabel(match))}</span></div>
      <div class="matchMeta"><span>${escapeHtml(matchStartLabel(match.start_time))}</span><span>${escapeHtml(matchDateLabel(match.start_time))}</span></div>
      <div class="versus">${matchCardTeam(match.blue_code || match.blue_team, match.blue_image)}<b>vs</b>${matchCardTeam(match.red_code || match.red_team, match.red_image)}</div>
      ${matchPredictionBadge(match)}
      <span class="backLink">Details</span>
    </a>
  `).join('');
  for (const el of document.querySelectorAll('.match')) {
    el.addEventListener('mouseenter', () => selectMatch(el.dataset));
    el.addEventListener('focus', () => selectMatch(el.dataset));
  }
  selectMatch(document.querySelector('.match').dataset);
}

function predictionFeedSourceLabel() {
  const predictions = state.preMatchPredictions || {};
  if (predictions.status !== 'loaded') return '';
  const meta = predictions.meta || {};
  const source = meta.source ? ` | pre ${meta.source}` : ' | pre loaded';
  return `${source}${meta.row_count !== undefined ? ` ${meta.row_count}` : ''}`;
}

function matchPredictionBadge(match) {
  const prediction = preMatchPredictionForMatch(match);
  if (!prediction) return '';
  const blueName = match.blue_code || match.blue_team || prediction.blue_team || 'Blue';
  const redName = match.red_code || match.red_team || prediction.red_team || 'Red';
  const favorite = prediction.blue_win_probability >= prediction.red_win_probability
    ? { name: blueName, probability: prediction.blue_win_probability }
    : { name: redName, probability: prediction.red_win_probability };
  return `
    <div class="preMatchBadge">
      <span>PRE</span>
      <strong>${escapeHtml(shortTeamName(favorite.name))} ${(favorite.probability * 100).toFixed(1)}%</strong>
    </div>
  `;
}

function preMatchPredictionForMatch(match) {
  const predictions = state.preMatchPredictions || {};
  const eventId = String(match?.id || match?.event_id || '');
  if (eventId && predictions.byEventId?.[eventId]) return predictions.byEventId[eventId];
  const gameId = String(match?.game_id || match?.gameId || '');
  if (gameId && predictions.byGameId?.[gameId]) return predictions.byGameId[gameId];
  const key = preMatchPredictionKey({
    league: match?.league || '',
    start_time: match?.start_time || match?.start || '',
    blue_team: match?.blue_team || match?.blue || '',
    red_team: match?.red_team || match?.red || '',
  });
  return key ? predictions.byMatchKey?.[key] || null : null;
}

function detailHref(id) {
  return `${STATIC_SITE ? 'match/' : '/match'}?id=${encodeURIComponent(id || '')}`;
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
      refreshStaticMatchStatuses().finally(() => {
        renderDateTabs(state.allMatches);
        renderMatches();
      });
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
  return localDateKey(new Date().toISOString());
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
  renderSelectedMatch({ id: match.id || '', teams: [{ name: match.blue, code: match.blue }, { name: match.red, code: match.red }], games: [], best_of: match.bestof, league: match.league, status: match.status, start_time: match.start || '' });
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
  $('selectedMatch').className = 'selectedMatch';
  const seriesWinner = completedSeriesWinner(details);
  $('selectedMatch').innerHTML = `
    ${teamBlock(left, 'centerLeftRecord', seriesWinner)}
    ${STATIC_SITE ? matchCenterPill(details) : `<div class="winPill"><span>Blue-side model</span><strong id="inlinePrediction">${$('prediction')?.textContent || '-'}</strong></div>`}
    ${teamBlock(right, 'centerRightRecord', seriesWinner)}
  `;
  $('gameList').innerHTML = gameListHtml(details);
  loadInlineTeamRecords(left, right, details.league);
}

function teamBlock(team, recordId, winnerTeam, showSeriesWins = false) {
  const image = team.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  const record = recordId
    ? `<span id="${recordId}" class="teamRecord">Loading league record...</span>`
    : `<span class="teamSeriesRecord">${escapeHtml(team.game_wins || '0')} wins</span>`;
  const winner = winnerTeam && sameTeamIdentity(team, winnerTeam) ? '<span class="winnerBadge">Winner</span>' : '';
  return `<div class="teamBlock">${image}<strong>${escapeHtml(team.name || team.code || '-')}</strong><span class="teamRecords">${record}</span><span class="winnerSlot">${winner}</span></div>`;
}

function matchScorePill(details) {
  const score = seriesScore(details.teams || []).replace(/\s/g, '');
  return `<div class="matchScorePill"><span>Series</span><strong>${escapeHtml(score)}</strong></div>`;
}

function matchCenterPill(details) {
  const prediction = preMatchPredictionForDetails(details);
  const predictionHtml = prediction ? `<small>${escapeHtml(preMatchSplitText(details, prediction))}</small>` : '';
  const score = seriesScore(details.teams || []).replace(/\s/g, '');
  return `<div class="matchScorePill"><span>Series</span><strong>${escapeHtml(score)}</strong>${predictionHtml}</div>`;
}

function preMatchPredictionForDetails(details) {
  const teams = details?.teams || [];
  return preMatchPredictionForMatch({
    id: details?.id || '',
    league: details?.league || '',
    start_time: details?.start_time || '',
    blue_team: teams[0]?.name || teams[0]?.code || '',
    red_team: teams[1]?.name || teams[1]?.code || '',
  });
}

function preMatchSplitText(details, prediction) {
  const teams = details?.teams || [];
  const blue = teams[0]?.code || teams[0]?.name || prediction.blue_team || 'Blue';
  const red = teams[1]?.code || teams[1]?.name || prediction.red_team || 'Red';
  return `PRE ${blue} ${(prediction.blue_win_probability * 100).toFixed(1)}% / ${red} ${(prediction.red_win_probability * 100).toFixed(1)}%`;
}

function matchCardTeam(name, image) {
  const logo = image ? `<img src="${escapeHtml(image)}" alt="">` : '';
  return `<span class="cardTeam"><span class="cardLogo">${logo}</span><span class="cardTeamName">${escapeHtml(name || '-')}</span></span>`;
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
  showDetailLoading();
  const predictionsReady = loadPreMatchPredictions();
  await refreshMatchDetail(true);
  predictionsReady.then(() => {
    if (state.currentDetails?.id) refreshMatchDetail(false);
  }).catch(() => {});
  state.detailTimer = window.setInterval(() => refreshMatchDetail(false), REFRESH_INTERVAL_MS);
}

function showDetailLoading() {
  $('matchTitle').textContent = 'Loading match...';
  $('matchMeta').textContent = 'Fetching schedule and live data';
  $('detailTeams').innerHTML = '<div class="loadingState">Loading match center...</div>';
  $('detailGames').innerHTML = '';
  const livePanel = document.querySelector('.livePanel');
  if (livePanel) livePanel.classList.remove('hidden');
  if ($('liveDraft')) $('liveDraft').innerHTML = '<div class="loadingState">Checking live feed...</div>';
}

async function refreshMatchDetail(initial) {
  const id = state.detailMatchId;
  const details = await fetchMatchDetail(id);
  markLiveFrameChanges(details);
  state.currentDetails = details;
  if (!details.id) {
    $('matchTitle').textContent = 'Match not found';
    return;
  }
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('matchTitle').textContent = `${left.name || left.code || '-'} vs ${right.name || right.code || '-'}`;
  $('matchMeta').textContent = matchDetailMeta(details);
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

async function fetchMatchDetail(id) {
  if (!STATIC_SITE) return api('/api/match?id=' + encodeURIComponent(id));
  const fallback = () => api('/api/match?id=' + encodeURIComponent(id));
  try {
    const liveDetails = await api('/api/live-event?id=' + encodeURIComponent(id));
    if (liveDetails?.id && String(liveDetails.status || '').toLowerCase() !== 'unavailable') {
      const staticDetails = await fallback().catch(() => ({}));
      return mergeFreshDetails(staticDetails, liveDetails);
    }
  } catch (error) {
  }
  return fallback();
}

function markLiveFrameChanges(details) {
  for (const game of details?.games || []) {
    const live = game?.live || {};
    const currentFrame = String(live.frame_timestamp || '');
    if (!currentFrame) continue;
    const gameId = String(game.id || '');
    const previousFrame = state.liveFrames[gameId] || '';
    live.frame_changed = Boolean(previousFrame && currentFrame !== previousFrame);
    state.liveFrames[gameId] = currentFrame;
  }
}

function matchDetailMeta(details) {
  return [
    details.league || '',
    `BO${details.best_of || '-'}`,
    details.source || '',
    matchDetailStartLabel(details.start_time),
    `auto-refresh ${REFRESH_INTERVAL_LABEL}`,
  ].filter(Boolean).join(' · ');
}

function matchDetailStartLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

async function enrichStaticLiveData(details) {
  if (!STATIC_SITE || !details?.games?.length) return;
  const targets = details.games.filter(game => {
    const status = String(game.state || '').toLowerCase();
    return game.id && status !== 'unneeded' && (!['unstarted', ''].includes(status) || shouldProbeLiveStats(details));
  });
  await Promise.all(targets.map(async game => {
    const live = await fetchLolesportsLive(game.id);
    if (live && ((live.blue || []).length || (live.red || []).length || live.source)) {
      const previousFrame = state.liveFrames[String(game.id || '')] || '';
      const currentFrame = String(live.frame_timestamp || '');
      live.frame_changed = Boolean(currentFrame && currentFrame !== previousFrame);
      if (currentFrame) state.liveFrames[String(game.id || '')] = currentFrame;
      game.live = live;
      if (hasMeaningfulLiveData(live) && ['unstarted', ''].includes(String(game.state || '').toLowerCase())) {
        game.state = 'inProgress';
        details.status = 'inProgress';
      }
    }
  }));
}

function shouldProbeLiveStats(details) {
  const start = new Date(details?.start_time || '');
  if (Number.isNaN(start.getTime())) return false;
  return Date.now() >= start.getTime() - LIVE_PRESTART_PROBE_MS;
}

async function fetchLolesportsLive(gameId) {
  return {};
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
  return new Date(rounded * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
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
  const prediction = preMatchPredictionForDetails(details);
  const predictionHtml = prediction ? `<span class="matchInfoPrediction">${escapeHtml(preMatchSplitText(details, prediction))}</span>` : '';
  return `
    <div class="matchInfo">
      <span class="matchInfoLeague">${escapeHtml(details.league || '-')}</span>
      <span class="matchInfoBo">BEST OF ${escapeHtml(bestOf)}</span>
      <span class="matchInfoScore">${escapeHtml(score)}</span>
      ${predictionHtml}
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
  if (normalized === 'unstarted' && hasStartTimePassed(match.start_time)) return 'updating';
  const hasScore = match.blue_score !== undefined && match.red_score !== undefined
    && String(match.blue_score) !== '' && String(match.red_score) !== ''
    && (Number(match.blue_score || 0) + Number(match.red_score || 0)) > 0;
  if (hasScore && ['completed', 'complete', 'inprogress'].includes(normalized)) {
    const winner = ['completed', 'complete'].includes(normalized) ? matchWinnerLabel(match) : '';
    return `${status} · ${match.blue_score}-${match.red_score}${winner ? ` · ${winner} wins` : ''}`;
  }
  return status;
}

function hasStartTimePassed(value) {
  const start = new Date(value || '');
  if (Number.isNaN(start.getTime())) return false;
  return Date.now() >= start.getTime() + 30 * 60 * 1000;
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
    return teams.find(team => sameWinnerValue(explicitWinner, team)) || null;
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

function sameWinnerValue(value, team) {
  if (!value || !team) return false;
  if (typeof value === 'object') {
    return sameTeam(value.id, team.id)
      || sameTeam(value.name, team.name)
      || sameTeam(value.code, team.code)
      || sameTeam(value.name, team.code)
      || sameTeam(value.code, team.name);
  }
  return sameTeam(value, team.id)
    || sameTeam(value, team.name)
    || sameTeam(value, team.code);
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
  const blueStats = displayTeamStats(live.blue_stats || {}, bluePlayers);
  const redStats = displayTeamStats(live.red_stats || {}, redPlayers);
  const hasLive = Boolean((live.blue || []).length || (live.red || []).length);
  const meaningfulLive = hasMeaningfulLiveData(live);
  const badgeText = liveBadgeText(details, game, hasLive, meaningfulLive);
  const timerText = liveTimerText(details, game, live, meaningfulLive);
  const winProbText = liveWinProbabilityText(game, live);
  const board = $('liveBoard');
  if (!board) return;
  board.innerHTML = `
    <div class="liveTabs">${(details.games || []).map(item => liveGameTab(item, game)).join('')}</div>
    <div class="liveContent">
      <div class="liveTop">
        ${liveTeamHeader(blueTeam)}
        <div class="liveCenter">
          <span class="liveBadge">${escapeHtml(badgeText)}</span>
          ${timerText ? `<span class="liveTimer">${escapeHtml(timerText)}</span>` : ''}
          ${winProbText ? `<span class="liveTimer">${escapeHtml(winProbText)}</span>` : ''}
        </div>
        ${liveTeamHeader(redTeam)}
      </div>
      <div class="liveStatsLine">
        ${liveStatsSide(blueStats, 'blue')}
        ${liveStatsSide(redStats, 'red')}
      </div>
      <div class="livePlayers">
        ${liveTeamRows(blueTeam, bluePlayers, redPlayers)}
        ${liveTeamRows(redTeam, redPlayers, bluePlayers)}
      </div>
    </div>
  `;
  attachLiveTabHandlers(details);
}

function liveWinProbabilityText(game, live) {
  const probability = live?.win_probability;
  if (!probability || probability.status !== 'estimated') return '';
  const blue = Number(probability.blue);
  if (!Number.isFinite(blue)) return '';
  const blueName = game?.blue?.team_code || game?.blue?.team_name || 'Blue';
  const redName = game?.red?.team_code || game?.red?.team_name || 'Red';
  const validation = probability.validation || {};
  const caution = validation.display && validation.display !== 'show_live_probability' ? ' · caution' : '';
  return `${blueName} ${(blue * 100).toFixed(1)}% / ${redName} ${((1 - blue) * 100).toFixed(1)}%${caution}`;
}

function displayTeamStats(teamStats, players) {
  if (!hasRealLivePlayers(players)) return teamStats;
  return {
    ...teamStats,
    kills: sumPlayerStat(players, 'kills'),
    deaths: sumPlayerStat(players, 'deaths'),
    assists: sumPlayerStat(players, 'assists'),
    gold: sumPlayerStat(players, 'gold') || Number(teamStats.gold || 0),
  };
}

function sumPlayerStat(players, key) {
  return players.reduce((total, player) => total + Number(player?.[key] || 0), 0);
}

function activeGame(games) {
  const inProgress = games
    .filter(game => String(game.state || '').toLowerCase() === 'inprogress')
    .sort((a, b) => Number(b.number || 0) - Number(a.number || 0))[0];
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
    previous_game_pick: true,
    pending_pick: true,
  };
}

function rosterPlayersForTeam(team) {
  const roster = state.rosters[teamKey(team?.name)] || state.rosters[teamKey(team?.code)] || [];
  return roster.filter(player => isStartingRole(player.role)).map(player => ({
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

function isStartingRole(role) {
  return ['top', 'jng', 'jug', 'jungle', 'mid', 'bot', 'adc', 'sup', 'support'].includes(String(role || '').toLowerCase());
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
  if (champion.match(/^\d+$/)) return championDisplayName(championImageId(champion)) || `Champion #${champion}`;
  return championDisplayName(champion);
}

function updateLiveRefreshMeta(details) {
  const updatedAt = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const liveGame = selectedLiveGame(details.games || []);
  const live = liveGame?.live || {};
  const liveSource = live.source ? ` · ${live.source}` : '';
  const frameTime = live.frame_timestamp ? ` · feed ${shortTime(live.frame_timestamp)}` : '';
  const frameState = live.frame_timestamp ? ` · ${live.frame_changed ? 'new frame' : 'same frame'}` : '';
  const model = live.win_probability?.model ? ` | model ${live.win_probability.model}` : '';
  const validation = live.win_probability?.validation?.display ? ` | ${live.win_probability.validation.display}` : '';
  const warning = live.warning || live.win_probability?.warning || details.warning || '';
  const warningText = warning ? ` | ${warning}` : '';
  $('liveRefreshMeta').textContent = `Last checked ${updatedAt}${liveSource}${frameTime}${frameState}${model}${validation}${warningText}`;
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function shortDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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

async function loadInlineTeamRecords(leftTeam, rightTeam, league) {
  const leftName = leftTeam.name || leftTeam.code || '';
  const rightName = rightTeam.name || rightTeam.code || '';
  if (!leftName && !rightName) return;
  try {
    const [left, right] = await Promise.all([
      api('/api/team-record?team=' + encodeURIComponent(leftName) + '&league=' + encodeURIComponent(league || '')),
      api('/api/team-record?team=' + encodeURIComponent(rightName) + '&league=' + encodeURIComponent(league || '')),
    ]);
    setTeamRecord('centerLeftRecord', left);
    setTeamRecord('centerRightRecord', right);
  } catch (error) {
    setFallbackTeamRecord('centerLeftRecord', leftTeam);
    setFallbackTeamRecord('centerRightRecord', rightTeam);
  }
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
        ${championIcon(player.champion || player.champion_id)}
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

function liveBadgeText(details, game, hasLive, meaningfulLive) {
  const seriesState = String(details?.status || '').toLowerCase();
  const state = String(game?.state || '').toLowerCase();
  if (['completed', 'complete'].includes(seriesState) || state === 'completed') {
    return 'Ended';
  }
  if (state === 'unneeded') return 'Unneeded';
  if (state === 'unstarted') return 'Unstarted';
  if (!hasLive) return 'Starting Soon';
  if (!meaningfulLive) return 'Starting Soon';
  return 'IN GAME';
}

function liveTimerText(details, game, live, meaningfulLive) {
  const seriesState = String(details?.status || '').toLowerCase();
  const state = String(game?.state || '').toLowerCase();
  if (['completed', 'complete'].includes(seriesState) || state === 'completed') {
    const winner = gameWinnerTeam(details, game) || completedSeriesWinner(details);
    const label = winner?.code || winner?.name || 'Winner';
    return `${label} WON`;
  }
  if (state === 'unneeded') return '-';
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

const TRINKET_ITEM_IDS = new Set(['3330', '3340', '3341', '3342', '3361', '3362', '3363', '3364']);

function itemSlots(items) {
  const slots = orderedItemSlots(items).map(id => {
    if (!id) return '<span class="itemSlot"></span>';
    return `<span class="itemSlot"><img src="https://ddragon.leagueoflegends.com/cdn/16.9.1/img/item/${escapeHtml(id)}.png" alt=""></span>`;
  });
  return `<div class="itemSlots">${slots.join('')}</div>`;
}

function orderedItemSlots(items) {
  const ids = (items || []).map(item => String(item || '').replace(/[^0-9]/g, '')).filter(Boolean);
  const trinkets = ids.filter(id => TRINKET_ITEM_IDS.has(id));
  const regularItems = ids.filter(id => !TRINKET_ITEM_IDS.has(id));
  const slots = Array(7).fill('');
  const trinketCount = Math.min(trinkets.length, 7);
  regularItems.slice(0, 7 - trinketCount).forEach((id, index) => {
    slots[index] = id;
  });
  trinkets.slice(-trinketCount).forEach((id, index) => {
    slots[7 - trinketCount + index] = id;
  });
  return slots;
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
  return `<img src="https://ddragon.leagueoflegends.com/cdn/${escapeHtml(version)}/img/champion/${escapeHtml(id)}.png" alt="" data-champion="${escapeHtml(value)}" onerror="this.replaceWith(championImageFallback(this.dataset.champion))">`;
}

function ddragonVersion(patch) {
  const match = String(patch || '').match(/^(\d+)\.(\d+)$/);
  if (!match) return '16.9.1';
  return `${Number(match[1])}.${Number(match[2])}.1`;
}

function roleLabel(value) {
  const text = String(value || '').toLowerCase();
  const labels = { top: 'Top', jungle: 'Jungle', jng: 'Jungle', mid: 'Mid', middle: 'Mid', bot: 'Bot', bottom: 'Bot', adc: 'Bot', support: 'Support', sup: 'Support' };
  return labels[text] || value || '';
}

function compactRoleLabel(value) {
  const text = String(value || '').toLowerCase();
  const labels = { top: 'TOP', jungle: 'JUG', jng: 'JUG', jug: 'JUG', mid: 'MID', middle: 'MID', bot: 'BOT', bottom: 'BOT', adc: 'BOT', support: 'SUP', sup: 'SUP' };
  return labels[text] || String(value || '-').toUpperCase();
}

function championImageId(value) {
  const text = String(value || '').replace(/[^A-Za-z0-9]/g, '');
  const aliases = {
    1: 'Annie',
    14: 'Sion',
    22: 'Ashe',
    51: 'Caitlyn',
    61: 'Orianna',
    64: 'LeeSin',
    147: 'Seraphine',
    254: 'Vi',
    432: 'Bard',
    799: 'Ambessa',
    aurelionsol: 'AurelionSol',
    belveth: 'Belveth',
    chogath: 'Chogath',
    drmundo: 'DrMundo',
    fiddlesticks: 'Fiddlesticks',
    jarvaniv: 'JarvanIV',
    kaisa: 'Kaisa',
    khazix: 'Khazix',
    kogmaw: 'KogMaw',
    ksante: 'KSante',
    leblanc: 'Leblanc',
    leesin: 'LeeSin',
    masteryi: 'MasterYi',
    missfortune: 'MissFortune',
    monkeyking: 'MonkeyKing',
    nunuwillump: 'Nunu',
    reksai: 'RekSai',
    renataglasc: 'Renata',
    tahmkench: 'TahmKench',
    twistedfate: 'TwistedFate',
    velkoz: 'Velkoz',
    wukong: 'MonkeyKing',
    xinzhao: 'XinZhao',
  };
  return aliases[text.toLowerCase()] || text;
}

function championImageFallback(value) {
  const span = document.createElement('span');
  span.className = 'liveChampionPlaceholder championImageMissing';
  span.title = `Missing champion icon: ${value || '-'}`;
  span.textContent = '?';
  return span;
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

function setFallbackTeamRecord(id, team) {
  const el = $(id);
  if (!el) return;
  el.textContent = 'League record unavailable';
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
      <span class="h2hTeam ${leftWon ? 'isWinner' : 'isLoser'}">${escapeHtml(leftCurrent?.code || leftCurrent?.name || match.left_team)}</span>
      <span class="h2hMiniLogo">${teamLogoMarkup(match.left_team, context)}</span>
      <span class="h2hScore">${escapeHtml(match.left_score)} - ${escapeHtml(match.right_score)}</span>
      <span class="h2hMiniLogo">${teamLogoMarkup(match.right_team, context)}</span>
      <span class="h2hTeam isRight ${rightWon ? 'isWinner' : 'isLoser'}">${escapeHtml(rightCurrent?.code || rightCurrent?.name || match.right_team)}</span>
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
    dkc: 'dpluskiachallengers',
    dkchallengers: 'dpluskiachallengers',
    dpluskiachallengers: 'dpluskiachallengers',
    t1a: 't1esportsacademy',
    t1ea: 't1esportsacademy',
    t1esportsacademy: 't1esportsacademy',
    t1challengers: 't1esportsacademy',
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
    c9: 'cloud9',
    cloud9: 'cloud9',
    cloud9kia: 'cloud9',
    tl: 'teamliquid',
    tlaw: 'teamliquid',
    teamliquid: 'teamliquid',
    teamliquidalienware: 'teamliquid',
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
      <div class="playerCardTop"><strong>${escapeHtml(compactRoleLabel(player.role))}</strong><strong>${escapeHtml(player.player)}</strong></div>
      <div class="playerMeta">${escapeHtml(rosterMetaText(player))}</div>
      <div class="playerMeta">Top champs: ${escapeHtml(player.top_champions.join(', ') || '-')}</div>
    </div>
  `).join('');
}

function rosterMetaText(player) {
  if (player.roster_source === 'leaguepedia') return 'Leaguepedia current roster';
  return `${player.games} games · ${(player.winrate * 100).toFixed(1)}% WR · KDA ${Number(player.kda).toFixed(2)}`;
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
  if ($('championRole')) $('championRole').addEventListener('change', () => state.summary && renderChampionMeta(state.summary));
  $('scheduleDate').addEventListener('change', () => {
    state.selectedMatchDate = $('scheduleDate').value || defaultMatchDate(state.allMatches);
    refreshStaticMatchStatuses().finally(() => {
      renderDateTabs(state.allMatches);
      renderMatches();
    });
  });
  if ($('predictForm')) $('predictForm').addEventListener('submit', predict);
  loadOptions().then(() => {
    loadDiagnostics();
    loadSummary();
    loadMatches();
    state.matchesTimer = window.setInterval(loadMatches, MATCHES_REFRESH_INTERVAL_MS);
  });
} else {
  loadDiagnostics();
  loadMatchDetailPage();
}
