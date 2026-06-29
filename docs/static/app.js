
const state = { options: null, summary: null, championSummary: null, detailMatchId: null, detailTimer: null, matchesTimer: null, liveClockTimer: null, rosterKey: '', teamHistoryKey: '', selectedLiveGameId: '', rosters: {}, currentDetails: null, allMatches: [], selectedMatchDate: '', matchSource: '', liveFrames: {}, teamStanding: 'league:LCK', preMatchPredictions: { byEventId: {}, byGameId: {}, byMatchKey: {}, meta: {}, status: 'not_loaded' }, preMatchPredictionPromise: null, teamRegistry: { byKey: {}, status: 'not_loaded' }, teamRegistryPromise: null, diagnostics: null, diagnosticsPromise: null, matchesRequestId: 0, userSelectedMatchDate: false };
const $ = (id) => document.getElementById(id);
const STATIC_SITE = Boolean(window.STATIC_SITE);
const STATIC_DATA_VERSION = '20260523-h2h-current-schedule';
const APP_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
const MATCHES_REFRESH_INTERVAL_MS = 60000;
const LIVE_PRESTART_PROBE_MS = 20 * 60 * 1000;
const DETAIL_REFRESH_IN_PROGRESS_MS = 5000;
const DETAIL_REFRESH_FINALIZING_MS = 60000;
const DETAIL_REFRESH_NEAR_START_MS = 15000;
const DETAIL_REFRESH_PRESTART_MS = 60000;
const DETAIL_REFRESH_FUTURE_MS = 5 * 60 * 1000;
const DETAIL_REFRESH_NEAR_START_WINDOW_MS = 5 * 60 * 1000;
const DETAIL_REFRESH_PRESTART_WINDOW_MS = 20 * 60 * 1000;
const LIVE_SNAPSHOT_STORAGE_PREFIX = 'lol_predictor_live_snapshot_v1:';
const LIVE_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MATCH_DETAIL_PAGE = Boolean($('matchTitle'));
const DEFAULT_LEAGUE_GROUP = 'major';

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
  const overlap = Number.isFinite(Number(data.prediction_match_overlap_rows))
    ? `overlap ${data.prediction_match_overlap_rows}/${data.prediction_feed_rows ?? 0}`
    : '';
  const siteData = data.site_data_status && data.site_data_status !== 'ok'
    ? `site ${data.site_data_status}`
    : '';
  const generated = data.prediction_feed_generated_at ? `pre ${shortDateTime(data.prediction_feed_generated_at)}` : '';
  const schema = data.prediction_schema_ok ? 'schema ok' : '';
  const freshness = data.prediction_feed_freshness && data.prediction_feed_freshness !== 'unknown'
    ? `pre ${data.prediction_feed_freshness}`
    : '';
  const analyzerLive = data.live_status_available
    ? `analyzer ${liveStatusSummary(data)}`
    : 'analyzer status missing';
  const worker = data.live_worker_checked
    ? `worker ${data.live_worker_ok ? 'ok' : 'check failed'}`
    : '';
  const artifactWarnings = Array.isArray(data.artifact_warnings) && data.artifact_warnings.length
    ? `artifact warnings ${data.artifact_warnings.length}`
    : '';
  target.textContent = [contract, live, feed, overlap, siteData, generated, schema, freshness, analyzerLive, worker, artifactWarnings].filter(Boolean).join(' | ');
}

function liveStatusSummary(data) {
  const stage = data.live_status_stage || (data.live_status_display_ready ? 'display ready' : 'not ready');
  const blockers = Number(data.live_status_blocker_count || 0);
  const warnings = Number(data.live_status_warning_count || 0);
  const readiness = data.live_status_display_ready === false
    ? 'display blocked'
    : (data.live_status_production_ready === false ? 'production pending' : '');
  return [stage, readiness, blockers ? `${blockers} blockers` : '', warnings ? `${warnings} warnings` : ''].filter(Boolean).join(' ');
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
    return staticMatchDetail(params);
  } else if (url.pathname === '/api/roster') {
    return staticRoster(params);
  } else if (url.pathname === '/api/team-record') {
    target = `data/team-records/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/team-history') {
    return staticTeamHistory(params);
  } else if (url.pathname === '/api/head-to-head') {
    return staticHeadToHead(params);
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

async function staticMatchDetail(params) {
  const id = String(params.get('id') || '');
  const candidates = uniqueValues([
    `data/matches/${encodeURIComponent(id)}.json`,
    `data/matches/${safeMatchFileId(id)}.json`,
  ]);
  for (const candidate of candidates) {
    const response = await fetch(staticDataUrl(candidate), { cache: 'no-store' });
    if (!response.ok) continue;
    try {
      return await response.json();
    } catch (error) {
    }
  }
  const predictions = await loadPreMatchPredictions();
  const prediction = predictions.byEventId?.[id] || predictions.byGameId?.[id] || null;
  if (prediction) return matchDetailFromPrediction(prediction);
  return { id: '', warning: 'match_detail_static_artifact_missing' };
}

async function staticRoster(params) {
  const team = params.get('team') || '';
  const teamCode = params.get('team_code') || '';
  const teamKeys = teamStaticKeys(team, teamCode);
  await loadTeamRegistry();
  for (const key of teamKeys) {
    if (!key) continue;
    const response = await fetch(staticDataUrl(`data/rosters/${key}.json`), { cache: 'no-store' });
    if (!response.ok) continue;
    try {
      const data = await response.json();
      if (Array.isArray(data.players) && data.players.length > 0) return data;
    } catch (error) {
      continue;
    }
  }
  return {
    team: team || teamCode,
    matched_team: '',
    source: 'static_missing',
    players: [],
    warning: 'roster_static_artifact_missing',
  };
}

function safeMatchFileId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]+/g, '_');
}

async function staticTeamHistory(params) {
  const team = params.get('team') || '';
  const teamCode = params.get('team_code') || '';
  const leagueKeys = uniqueValues([staticKey(params.get('league') || 'all'), 'all']);
  const teamKeys = teamStaticKeys(team, teamCode);
  await loadTeamRegistry();
  for (const league of leagueKeys) {
    for (const key of teamKeys) {
      if (!key) continue;
      const response = await fetch(staticDataUrl(`data/team-history/${league}__${key}.json`), { cache: 'no-store' });
      if (!response.ok) continue;
      try {
        const data = await response.json();
        if (Array.isArray(data.matches) && data.matches.length > 0) return enrichTeamHistoryPayload(data);
      } catch (error) {
        continue;
      }
    }
  }
  return {
    team: team || teamCode,
    matches: [],
    warning: 'team_history_static_artifact_missing',
  };
}

function enrichTeamHistoryPayload(payload) {
  if (!Array.isArray(payload?.matches)) return payload;
  return {
    ...payload,
    matches: payload.matches.map(match => {
      const teamMeta = resolveTeamMeta(match.team || payload.team || '', match.team || payload.team || '');
      const opponentMeta = resolveTeamMeta(match.opponent || '', match.opponent || '');
      return {
        ...match,
        team_image: normalizeTeamImage(match.team_image || teamMeta.logo || ''),
        opponent_image: normalizeTeamImage(match.opponent_image || opponentMeta.logo || ''),
      };
    }),
  };
}

async function staticHeadToHead(params) {
  const teamA = params.get('team_a') || '';
  const teamB = params.get('team_b') || '';
  const teamACode = params.get('team_a_code') || '';
  const teamBCode = params.get('team_b_code') || '';
  const leagueKeys = uniqueValues([staticKey(params.get('league') || 'all'), 'all']);
  const teamAKeys = teamStaticKeys(teamA, teamACode);
  const teamBKeys = teamStaticKeys(teamB, teamBCode);
  const candidates = [];
  for (const league of leagueKeys) {
    for (const a of teamAKeys) {
      for (const b of teamBKeys) {
        if (!a || !b || a === b) continue;
        candidates.push(`data/h2h/${league}__${a}__${b}.json`);
        candidates.push(`data/h2h/${league}__${b}__${a}.json`);
      }
    }
  }
  let firstEmptyPayload = null;
  for (const candidate of uniqueValues(candidates)) {
    const response = await fetch(staticDataUrl(candidate), { cache: 'no-store' });
    if (!response.ok) continue;
    try {
      const data = await response.json();
      if (Array.isArray(data.matches) && data.matches.length > 0) return data;
      if (!firstEmptyPayload && Array.isArray(data.matches)) firstEmptyPayload = data;
    } catch (error) {
      continue;
    }
  }
  if (firstEmptyPayload) return firstEmptyPayload;
  return {
    team_a: teamA || teamACode,
    team_b: teamB || teamBCode,
    matches: [],
    warning: 'h2h_static_artifact_missing',
  };
}

function staticDataUrl(path) {
  const script = document.querySelector('script[src*="app.js"]');
  const url = new URL(path, script?.src || new URL('static/app.js', location.href));
  url.searchParams.set('v', STATIC_DATA_VERSION);
  return url.toString();
}

function staticKey(value) {
  return String(value || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
}

function teamStaticKeys(...values) {
  const aliases = {
    bfx: 'bnk-fearx',
    fearx: 'bnk-fearx',
    geng: ['gen-g-esports', 'gen-g'],
    gen: ['gen-g-esports', 'gen-g'],
    'gen-g': 'gen-g-esports',
    'gen-g-esports': 'gen-g',
    drx: 'kiwoom-drx',
    krx: 'kiwoom-drx',
    dk: 'dplus-kia',
    dkc: 'dk-challengers',
    'dk-challengers': 'dplus-kia-challengers',
    'dplus-kia-challengers': 'dk-challengers',
    t1a: 't1-esports-academy',
    t1ea: 't1-esports-academy',
    hle: 'hanwha-life-esports',
    'hle-challengers': 'hanwha-life-esports-challengers',
    'hanwha-life-esports-challengers': 'hle-challengers',
    bro: 'hanjin-brion',
    'bro-challengers': 'hanjin-brion-challengers',
    'hanjin-brion-challengers': 'bro-challengers',
    dns: 'dn-soopers',
    'dns-challengers': 'dn-soopers-challengers',
    'dn-soopers-challengers': 'dns-challengers',
    'krx-challengers': 'kiwoom-drx-challengers',
    'kiwoom-drx-challengers': 'krx-challengers',
    'kt-challengers': 'kt-rolster-challengers',
    'kt-rolster-challengers': 'kt-challengers',
    ns: ['nongshim-red-force', 'nongshim-redforce'],
    'ns-challengers': 'nongshim-esports-academy',
    'nongshim-esports-academy': 'ns-challengers',
    'nongshim-red-force': 'nongshim-redforce',
    'nongshim-redforce': 'nongshim-red-force',
    jdg: 'beijing-jdg-esports',
    tes: 'top-esports',
    blg: 'bilibili-gaming',
    ig: 'invictus-gaming',
    edg: 'edward-gaming',
    omg: 'oh-my-god',
    lng: 'suzhou-lng-esports',
    'lng-esports': 'suzhou-lng-esports',
    we: 'xi-an-team-we',
    'team-we': 'xi-an-team-we',
    wbg: 'weibogaming',
    up: 'ultra-prime',
    nip: ['shenzhen-ninjas-in-pyjamas', 'ninjas-in-pyjamas'],
    'shenzhen-ninjas-in-pyjamas': 'ninjas-in-pyjamas',
    'ninjas-in-pyjamas': 'shenzhen-ninjas-in-pyjamas',
    tt: 'thunder-talk-gaming',
    'thundertalk-gaming': 'thunder-talk-gaming',
    'thunder-talk-gaming': 'thundertalk-gaming',
    c9: ['cloud9-kia', 'cloud9'],
    'cloud9-kia': 'cloud9',
    cloud9: 'cloud9-kia',
    tl: ['team-liquid-alienware', 'team-liquid'],
    tlaw: ['team-liquid-alienware', 'team-liquid'],
    'team-liquid-alienware': 'team-liquid',
    'team-liquid': 'team-liquid-alienware',
    red: ['red-canids-kalunga', 'red-canids'],
    'red-canids-kalunga': 'red-canids',
    'red-canids': 'red-canids-kalunga',
    los: 'l-s',
    'l-s': 'los',
    vks: 'vivo-keyd-stars',
    dcg: ['relove-deep-cross-gaming', 'deep-cross-gaming'],
    'relove-deep-cross-gaming': 'deep-cross-gaming',
    'deep-cross-gaming': 'relove-deep-cross-gaming',
    cnv: 'conviction',
    sn: 'supernova',
    su: 'su-esports',
    pcf: 'pcific-esports',
    cfo: 'ctbc-flying-oyster',
    mvk: 'mvk-esports',
    g2: 'g2-esports',
    kc: 'karmine-corp',
  };
  const keys = [];
  for (const value of values) {
    const key = staticKey(value);
    if (!key) continue;
    keys.push(key);
    for (const alias of Array.isArray(aliases[key]) ? aliases[key] : [aliases[key]]) {
      if (alias) keys.push(alias);
    }
  }
  return uniqueValues(keys);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function liveSourceMatchId(matchOrId, fallbackId = '') {
  if (matchOrId && typeof matchOrId === 'object') {
    return String(
      matchOrId.source_match_id ||
      matchOrId.live_event_id ||
      matchOrId.lolesports_event_id ||
      matchOrId.event_id ||
      matchOrId.id ||
      fallbackId ||
      ''
    ).trim();
  }
  return String(matchOrId || fallbackId || '').trim();
}

function hasExplicitLiveSourceId(details) {
  return Boolean(String(
    details?.source_match_id ||
    details?.live_event_id ||
    details?.lolesports_event_id ||
    details?.event_id ||
    ''
  ).trim());
}

function needsLiveSourceIdDiagnostic(details) {
  if (!STATIC_SITE || !details?.id || hasExplicitLiveSourceId(details)) return false;
  const status = String(details.status || '').toLowerCase();
  if (['completed', 'complete', 'inprogress', 'updating'].includes(status)) return true;
  return shouldProbeLiveStats(details);
}

function annotateLiveDiagnostic(details, diagnostic) {
  if (!diagnostic || !details?.id) return details;
  return { ...details, live_diagnostic: diagnostic };
}

async function fetchLolesportsEventDetails(matchOrId) {
  const eventId = liveSourceMatchId(matchOrId);
  if (!STATIC_SITE || !eventId) return {};
  const requestedId = matchOrId && typeof matchOrId === 'object'
    ? String(matchOrId.id || eventId)
    : String(eventId);
  try {
    const details = await api('/api/live-event?id=' + encodeURIComponent(eventId));
    return {
      ...details,
      __requested_match_id: requestedId,
      __live_event_id: eventId,
    };
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
  $(id).innerHTML = header + (rows || []).map(r => `
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
  const summaryFreshness = summaryFreshnessLabel(data);
  const parts = [`${label}`, patchLabel(data.patch), `${data.games} games`, summaryFreshness].filter(Boolean);
  if ($('championMetaSub')) $('championMetaSub').textContent = parts.join(' · ');
  renderChampionTable('champions', rows, data.patch);
}

function summaryFreshnessLabel(data) {
  const through = shortMonthDay(data?.data_through);
  if (through) return `through ${through}`;
  const generated = shortMonthDay(data?.generated_at);
  return generated ? `generated ${generated}` : '';
}

function shortMonthDay(value) {
  if (!value) return '';
  const text = String(value).trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnly
    ? dateFromLocalKey(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`)
    : new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return formatInAppTimeZone(date, { month: 'numeric', day: 'numeric' });
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
  setValue('leagueGroup', DEFAULT_LEAGUE_GROUP);
  setValue('championMetaGroup', $('leagueGroup')?.value || DEFAULT_LEAGUE_GROUP);
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
  await loadChampionSummary();
  await loadTeamStandings();
}

async function loadChampionSummary() {
  const leagueGroup = $('championMetaGroup')?.value || 'all';
  const params = new URLSearchParams({ league_group: leagueGroup, region: $('region')?.value || 'all' });
  const data = await api('/api/summary?' + params.toString());
  state.championSummary = data;
  renderChampionMeta(data);
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
  const requestId = ++state.matchesRequestId;
  const filters = currentMatchFilters();
  await loadTeamRegistry();
  const predictionsReady = loadPreMatchPredictions();
  const data = await api('/api/matches/today?' + qs());
  if (requestId !== state.matchesRequestId || !sameMatchFilters(filters, currentMatchFilters())) return;
  state.allMatches = dedupeCanonicalMatches(hydrateMatchesTeamMeta(filterMatchesBySelection(data.matches || [], filters)));
  state.matchSource = data.source || 'none';
  syncDefaultMatchDate(state.allMatches);
  await refreshStaticMatchStatuses();
  renderDateTabs(state.allMatches);
  renderMatches();
  predictionsReady.then(async () => {
    if (requestId !== state.matchesRequestId || !sameMatchFilters(filters, currentMatchFilters())) return;
    state.allMatches = dedupeCanonicalMatches(hydrateMatchesTeamMeta(applyPreMatchPredictionOverlay(state.allMatches)));
    await refreshStaticMatchStatuses();
    renderDateTabs(state.allMatches);
    renderMatches();
  }).catch(() => {});
}

function currentMatchFilters() {
  return {
    league_group: $('leagueGroup')?.value || 'all',
    region: $('region')?.value || 'all',
  };
}

function sameMatchFilters(left, right) {
  return String(left?.league_group || 'all') === String(right?.league_group || 'all')
    && String(left?.region || 'all') === String(right?.region || 'all');
}

function filterMatchesBySelection(matches, filters = currentMatchFilters()) {
  const leagueGroup = String(filters.league_group || 'all');
  const region = String(filters.region || 'all');
  return (matches || []).filter(match => {
    const matchGroup = String(match?.league_group || 'all');
    const matchRegion = String(match?.region || 'all');
    return (leagueGroup === 'all' || matchGroup === leagueGroup)
      && (region === 'all' || matchRegion === region);
  });
}

function hydrateMatchesTeamMeta(matches) {
  return (matches || []).map(hydrateMatchTeamMeta);
}

function hydrateMatchTeamMeta(match) {
  if (!match) return match;
  const blueMeta = resolveTeamMeta(match.blue_team || match.blue_code || '', match.blue_team || '', {});
  const redMeta = resolveTeamMeta(match.red_team || match.red_code || '', match.red_team || '', {});
  return {
    ...match,
    blue_team: !isPlaceholderTeam(match.blue_team) ? match.blue_team : (blueMeta.name || match.blue_team),
    red_team: !isPlaceholderTeam(match.red_team) ? match.red_team : (redMeta.name || match.red_team),
    blue_code: blueMeta.code || match.blue_code,
    red_code: redMeta.code || match.red_code,
    blue_image: normalizeTeamImage(match.blue_image || blueMeta.logo || ''),
    red_image: normalizeTeamImage(match.red_image || redMeta.logo || ''),
  };
}

async function loadPreMatchPredictions() {
  await loadTeamRegistry();
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

async function loadTeamRegistry() {
  if (state.teamRegistryPromise) return state.teamRegistryPromise;
  state.teamRegistryPromise = (async () => {
    try {
      const response = await fetch(teamRegistryUrl(), { cache: 'no-store' });
      if (!response.ok) throw new Error(`team registry ${response.status}`);
      const payload = await response.json();
      state.teamRegistry = normalizeTeamRegistry(payload);
    } catch (error) {
      state.teamRegistry = { byKey: {}, status: 'unavailable' };
    }
    return state.teamRegistry;
  })();
  return state.teamRegistryPromise;
}

function teamRegistryUrl() {
  const script = document.querySelector('script[src*="app.js"]');
  return new URL('data/team_registry.json', script?.src || new URL('static/app.js', location.href)).toString();
}

function normalizeTeamRegistry(payload) {
  const byKey = {};
  for (const row of Array.isArray(payload?.teams) ? payload.teams : []) {
    const entry = {
      code: String(row.code || '').trim(),
      name: String(row.name || '').trim(),
      logo: normalizeTeamImage(row.logo || ''),
      source: String(row.source || 'team_registry'),
    };
    const keys = [row.key, row.code, row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])]
      .map(teamKey)
      .filter(Boolean);
    for (const key of keys) byKey[key] = { ...entry, key };
  }
  return { byKey, status: 'loaded', updated_at: payload?.updated_at || '' };
}

function preMatchPredictionLocalUrl() {
  const script = document.querySelector('script[src*="app.js"]');
  return new URL('../pre_match_predictions.json', script?.src || new URL('static/app.js', location.href)).toString();
}

function preMatchPredictionRemoteUrl() {
  const config = window.LOL_PREDICTOR_CONFIG || {};
  return String(window.PRE_MATCH_PREDICTIONS_URL || config.preMatchPredictionsUrl || preMatchPredictionLocalUrl());
}

function normalizePreMatchPredictionFeed(payload, candidate) {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.predictions) ? payload.predictions : []);
  const result = {
    rows: [],
    byEventId: {},
    byGameId: {},
    byMatchKey: {},
    byLooseMatchKey: {},
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
    result.rows.push(prediction);
    if (prediction.event_id) result.byEventId[prediction.event_id] = prediction;
    if (prediction.game_id) result.byGameId[prediction.game_id] = prediction;
    const key = preMatchPredictionKey(prediction);
    if (key) result.byMatchKey[key] = prediction;
    const looseKey = loosePreMatchPredictionKey(prediction);
    if (looseKey) result.byLooseMatchKey[looseKey] = prediction;
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
    blue_team_name: String(row.blue_team_name || row.blueTeamName || row.blue_name || ''),
    red_team_name: String(row.red_team_name || row.redTeamName || row.red_name || ''),
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

function loosePreMatchPredictionKey(value) {
  const league = predictionLeagueKey(value?.league || '');
  const date = localDateKey(value?.start_time || '');
  const teams = [
    teamKey(value?.blue_team || value?.blue_code || value?.blue || ''),
    teamKey(value?.red_team || value?.red_code || value?.red || ''),
  ].filter(Boolean).sort();
  return league && date && teams.length === 2 ? `${league}|${date}|${teams[0]}|${teams[1]}` : '';
}

function normalizedPredictionTime(value) {
  const date = parseScheduleDate(value || '');
  if (Number.isNaN(date.getTime())) return String(value || '').trim();
  return date.toISOString();
}

function applyPreMatchPredictionOverlay(matches) {
  const predictions = state.preMatchPredictions || {};
  if (predictions.status !== 'loaded') return matches;
  const seenIds = new Set();
  const seenPredictionKeys = new Set((matches || []).map(match => standalonePredictionKey({
    start_time: match?.start_time || '',
    blue_team: match?.blue_team || match?.blue_code || '',
    red_team: match?.red_team || match?.red_code || '',
  })).filter(Boolean));
  const seenLoosePredictionKeys = new Set((matches || []).map(match => loosePreMatchPredictionKey(match)).filter(Boolean));
  const overlaid = (matches || []).map(match => {
    const eventId = String(match?.id || match?.event_id || '');
    const looseKey = loosePreMatchPredictionKey(match);
    const prediction = (eventId ? predictions.byEventId?.[eventId] : null) || (looseKey ? predictions.byLooseMatchKey?.[looseKey] : null);
    const canOverlay = prediction && (predictionMatchesSchedule(match, prediction) || predictionMatchesScheduleLoosely(match, prediction));
    if (eventId && (!prediction || canOverlay)) seenIds.add(eventId);
    const output = canOverlay ? overlayMatchFromPrediction(match, prediction) : match;
    const outputKey = standalonePredictionKey(output);
    if (outputKey) seenPredictionKeys.add(outputKey);
    const outputLooseKey = loosePreMatchPredictionKey(output);
    if (outputLooseKey) seenLoosePredictionKeys.add(outputLooseKey);
    return output;
  });
  for (const prediction of predictions.rows || []) {
    const eventId = String(prediction.event_id || prediction.game_id || '');
    if (!eventId || seenIds.has(eventId)) continue;
    const predictionKey = standalonePredictionKey(prediction);
    if (predictionKey && seenPredictionKeys.has(predictionKey)) continue;
    const looseKey = loosePreMatchPredictionKey(prediction);
    if (looseKey && seenLoosePredictionKeys.has(looseKey)) continue;
    if (predictionKey) seenPredictionKeys.add(predictionKey);
    if (looseKey) seenLoosePredictionKeys.add(looseKey);
    seenIds.add(eventId);
    overlaid.push(overlayMatchFromPrediction(standalonePredictionMatch(prediction, matches), prediction));
  }
  return sortMatchesByStart(dedupeCanonicalMatches(suppressPlaceholderMatchesWithStandalonePredictions(overlaid)));
}

function standalonePredictionKey(value) {
  const start = normalizedPredictionTime(value?.start_time || '');
  const teams = [teamKey(value?.blue_team || ''), teamKey(value?.red_team || '')].filter(Boolean).sort();
  return start && teams.length === 2 ? `${start}|${teams[0]}|${teams[1]}` : '';
}

function predictionMatchesScheduleLoosely(match, prediction) {
  const matchKey = loosePreMatchPredictionKey(match);
  const predictionKey = loosePreMatchPredictionKey(prediction);
  return Boolean(matchKey && predictionKey && matchKey === predictionKey);
}

function standalonePredictionMatch(prediction, matches) {
  const eventId = String(prediction.event_id || prediction.game_id || '');
  const meta = predictionLeagueMetadata(prediction, matches);
  const blueMeta = resolveTeamMeta(prediction.blue_team, prediction.blue_team_name, { matches });
  const redMeta = resolveTeamMeta(prediction.red_team, prediction.red_team_name, { matches });
  return {
    id: eventId,
    event_id: eventId,
    game_id: String(prediction.game_id || ''),
    status: 'unstarted',
    source: 'pre_match_prediction_feed',
    league: shortPredictionLeague(prediction.league) || prediction.league || '',
    league_group: meta.league_group || '',
    region: meta.region || '',
    best_of: meta.best_of || '',
    blue_team: blueMeta.name || displayTeamName(prediction.blue_team_name || prediction.blue_team, ''),
    red_team: redMeta.name || displayTeamName(prediction.red_team_name || prediction.red_team, ''),
    blue_code: blueMeta.code || displayTeamCode(prediction.blue_team, ''),
    red_code: redMeta.code || displayTeamCode(prediction.red_team, ''),
    blue_image: blueMeta.logo || '',
    red_image: redMeta.logo || '',
  };
}

function predictionTeamImage(team, displayName, matches) {
  return resolveTeamMeta(team, displayName, { matches }).logo || '';
}

function resolveTeamMeta(team, displayName = '', options = {}) {
  const registry = state.teamRegistry?.byKey || {};
  const targetKey = teamKey(team || displayName || '');
  for (const value of [team, displayName]) {
    const key = teamKey(value || '');
    if (key && registry[key]) return registry[key];
  }
  for (const match of options.matches || []) {
    const blueKey = teamKey(match?.blue_team || match?.blue_code || '');
    if (blueKey === targetKey) return {
      code: String(match.blue_code || '').trim(),
      name: String(match.blue_team || '').trim(),
      logo: normalizeTeamImage(match.blue_image || ''),
      source: 'match_index',
    };
    const redKey = teamKey(match?.red_team || match?.red_code || '');
    if (redKey === targetKey) return {
      code: String(match.red_code || '').trim(),
      name: String(match.red_team || '').trim(),
      logo: normalizeTeamImage(match.red_image || ''),
      source: 'match_index',
    };
  }
  return {
    code: '',
    name: displayTeamName(displayName || team, ''),
    logo: '',
    source: 'fallback',
  };
}

function suppressPlaceholderMatchesWithStandalonePredictions(matches) {
  const predictionRows = (matches || []).filter(match => String(match?.source || '') === 'pre_match_prediction_feed');
  const predictionSlotTeams = new Map(predictionRows
    .map(match => [scheduleSlotKey(match), teamPairKey(match)])
    .filter(([slot, teams]) => slot && teams));
  const predictionEventSlots = new Map(predictionRows
    .map(match => [String(match?.id || match?.event_id || ''), scheduleSlotKey(match)])
    .filter(([eventId, slot]) => eventId && slot));
  if (!predictionSlotTeams.size) return matches;
  return (matches || []).filter(match => {
    if (String(match?.source || '') === 'pre_match_prediction_feed') return true;
    const slot = scheduleSlotKey(match);
    const eventSlot = predictionEventSlots.get(String(match?.id || match?.event_id || ''));
    if (eventSlot && eventSlot !== slot) return false;
    const predictionTeams = predictionSlotTeams.get(slot);
    if (!predictionTeams) return true;
    return teamPairKey(match) === predictionTeams;
  });
}

function dedupeCanonicalMatches(matches) {
  const orderedKeys = [];
  const bestByKey = new Map();
  const passthrough = [];
  for (const match of matches || []) {
    const key = canonicalMatchDuplicateKey(match);
    if (!key) {
      passthrough.push(match);
      continue;
    }
    const existing = bestByKey.get(key);
    if (!existing) orderedKeys.push(key);
    bestByKey.set(key, mergeDuplicateMatch(existing, match));
  }
  return [
    ...orderedKeys.map(key => bestByKey.get(key)).filter(Boolean),
    ...passthrough,
  ];
}

function canonicalMatchDuplicateKey(match) {
  const league = matchDuplicateLeagueKey(match?.league || '');
  const start = normalizedPredictionTime(match?.start_time || '');
  const teams = teamPairKey(match);
  return league && start && teams ? `${league}|${start}|${teams}` : '';
}

function matchDuplicateLeagueKey(value) {
  const text = shortPredictionLeague(value).toLowerCase().trim();
  if (!text) return '';
  if (text.startsWith('esports world cup')) return 'ewc';
  if (text.startsWith('2026 asian games') || text.startsWith('asian games')) return 'asian-games';
  return predictionLeagueKey(value);
}

function mergeDuplicateMatch(existing, incoming) {
  if (!existing) return incoming;
  const existingScore = matchQualityScore(existing);
  const incomingScore = matchQualityScore(incoming);
  const primary = incomingScore > existingScore ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;
  const merged = { ...secondary, ...primary };
  for (const field of ['id', 'event_id', 'game_id', 'source_match_id', 'league_group', 'region', 'best_of']) {
    if (!merged[field] && secondary?.[field]) merged[field] = secondary[field];
  }
  for (const field of ['blue_team', 'red_team', 'blue_code', 'red_code']) {
    if (isPlaceholderTeam(merged[field]) && !isPlaceholderTeam(secondary?.[field])) merged[field] = secondary[field];
  }
  for (const field of ['blue_image', 'red_image']) {
    if (isPlaceholderImage(merged[field]) && !isPlaceholderImage(secondary?.[field])) merged[field] = normalizeTeamImage(secondary[field]);
  }
  for (const field of ['blue_score', 'red_score']) {
    if ((merged[field] === undefined || merged[field] === null || merged[field] === '') && secondary?.[field] !== undefined) {
      merged[field] = secondary[field];
    }
  }
  return merged;
}

function matchQualityScore(match) {
  let score = 0;
  const source = String(match?.source || '').toLowerCase();
  if (source.includes('lolesports')) score += 40;
  if (source.includes('pandascore')) score += 25;
  if (source === 'pre_match_prediction_feed') score -= 25;
  if (match?.source_match_id) score += 20;
  if (!hasPlaceholderTeamInfo(match)) score += 15;
  if (!isPlaceholderImage(match?.blue_image) && !isPlaceholderImage(match?.red_image)) score += 8;
  if (matchHasScore(match)) score += 12;
  if (preMatchPredictionForMatch(match)) score += 6;
  score += matchStatusQualityScore(match?.status);
  return score;
}

function matchStatusQualityScore(status) {
  const normalized = String(status || '').toLowerCase();
  if (['completed', 'complete'].includes(normalized)) return 10;
  if (normalized === 'inprogress') return 8;
  if (normalized === 'unstarted') return 4;
  if (normalized === 'updating') return 2;
  if (normalized === 'unavailable') return -4;
  return 0;
}

function scheduleSlotKey(match) {
  const league = predictionLeagueKey(match?.league || '');
  const start = normalizedPredictionTime(match?.start_time || '');
  return league && start ? `${league}|${start}` : '';
}

function teamPairKey(match) {
  const teams = [
    teamKey(match?.blue_team || match?.blue_code || match?.blue || ''),
    teamKey(match?.red_team || match?.red_code || match?.red || ''),
  ].filter(Boolean).sort();
  return teams.length === 2 ? `${teams[0]}|${teams[1]}` : '';
}

function predictionLeagueMetadata(prediction, matches) {
  const league = shortPredictionLeague(prediction?.league || '').toLowerCase();
  if (!league) return {};
  return (matches || []).find(match => String(match?.league || '').toLowerCase() === league) || {};
}

function shortPredictionLeague(value) {
  return String(value || '').split(' - ')[0].trim();
}

function predictionLeagueKey(value) {
  const text = shortPredictionLeague(value).toLowerCase().trim();
  if (!text) return '';
  if (text.startsWith('esports world cup')) return 'ewc';
  if (text.startsWith('2026 asian games') || text.startsWith('asian games')) return 'asian-games';
  const known = ['lpl', 'lck', 'lcs', 'lec', 'lcp', 'vcs', 'ljl', 'cblol', 'nacl', 'emea masters'];
  const match = known.find(league => text === league || text.startsWith(`${league} `));
  if (match) return match;
  return text.replace(/\s+20\d{2}.*$/, '').trim();
}

function overlayMatchFromPrediction(match, prediction) {
  const startTime = predictionStartTimeIso(prediction);
  const overlayTeams = hasPlaceholderTeamInfo(match);
  return {
    ...match,
    id: String(match.id || prediction.event_id || prediction.game_id || ''),
    league: match.league || prediction.league || '',
    start_time: match.start_time || startTime || '',
    blue_team: overlayTeams ? displayTeamName(prediction.blue_team_name || prediction.blue_team, match.blue_team) : match.blue_team,
    red_team: overlayTeams ? displayTeamName(prediction.red_team_name || prediction.red_team, match.red_team) : match.red_team,
    blue_code: overlayTeams ? displayTeamCode(prediction.blue_team, match.blue_code) : match.blue_code,
    red_code: overlayTeams ? displayTeamCode(prediction.red_team, match.red_code) : match.red_code,
    blue_image: normalizeTeamImage(!isPlaceholderImage(match.blue_image) ? match.blue_image : predictionTeamImage(prediction.blue_team, prediction.blue_team_name, [])),
    red_image: normalizeTeamImage(!isPlaceholderImage(match.red_image) ? match.red_image : predictionTeamImage(prediction.red_team, prediction.red_team_name, [])),
    status: match.status || 'unstarted',
  };
}

function predictionStartTimeIso(prediction) {
  const date = parseScheduleDate(prediction?.start_time || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function predictionMatchesSchedule(match, prediction) {
  const matchStart = normalizedPredictionTime(match?.start_time || '');
  const predictionStart = normalizedPredictionTime(prediction?.start_time || '');
  if (!matchStart || !predictionStart) return true;
  return matchStart === predictionStart;
}

function matchDetailFromPrediction(prediction) {
  const id = String(prediction.event_id || prediction.game_id || '');
  const blueName = prediction.blue_team_name || displayTeamName(prediction.blue_team, '');
  const redName = prediction.red_team_name || displayTeamName(prediction.red_team, '');
  const blueCode = displayTeamCode(prediction.blue_team_name || prediction.blue_team, '');
  const redCode = displayTeamCode(prediction.red_team_name || prediction.red_team, '');
  return {
    id,
    league: prediction.league || '',
    league_group: '',
    region: '',
    start_time: predictionStartTimeIso(prediction) || prediction.start_time || '',
    status: 'unstarted',
    best_of: '',
    source: 'pre_match_prediction_feed',
    teams: [
      { side: 'blue', name: blueName, code: blueCode, image: '', game_wins: '0' },
      { side: 'red', name: redName, code: redCode, image: '', game_wins: '0' },
    ],
    games: [],
    warning: 'match_detail_from_pre_match_prediction',
  };
}

function matchScheduleLooksStale(match, prediction) {
  const matchStart = normalizedPredictionTime(match?.start_time || '');
  const predictionStart = normalizedPredictionTime(prediction?.start_time || '');
  if (!matchStart || !predictionStart) return false;
  return matchStart !== predictionStart;
}

function displayTeamName(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback || '';
  return text.split('_').filter(Boolean).map(word => word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(' ');
}

function displayTeamCode(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback || '';
  const words = text.toLowerCase().split('_').filter(Boolean);
  if (!words.length) return fallback || '';
  const aliases = {
    bilibili_gaming: 'BLG',
    edward_gaming: 'EDG',
    thundertalk_gaming: 'TT',
    thunder_talk_gaming: 'TT',
    anyone_s_legend: 'AL',
    top_esports: 'TES',
    team_we: 'WE',
    weibo_gaming: 'WBG',
    lgd_gaming: 'LGD',
    jd_gaming: 'JDG',
    gam_esports: 'GAM',
    mvk_esports: 'MVK',
    misa_esports: 'MISA',
    pcific_esports: 'PCF',
  };
  const alias = aliases[words.join('_')];
  if (alias) return alias;
  const knownCodes = ['lng', 'we', 'edg', 'jdg', 'blg', 'tes', 'wbg', 'ig', 'tt', 'lgd', 'nip', 'up', 'al', 'rng', 'omg', 'fpx', 'ra'];
  const known = knownCodes.find(code => words.includes(code));
  if (known) return known.toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map(word => word[0] || '').join('').slice(0, 4).toUpperCase();
}

function sortMatchesByStart(matches) {
  return [...(matches || [])].sort((left, right) => {
    const leftTime = parseScheduleDate(left.start_time || '').getTime();
    const rightTime = parseScheduleDate(right.start_time || '').getTime();
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return leftTime - rightTime;
  });
}

async function refreshStaticMatchStatuses() {
  if (!STATIC_SITE || !state.allMatches.length) return;
  const targets = state.allMatches
    .filter(shouldRefreshMatchStatus)
    .sort((a, b) => refreshMatchPriority(b) - refreshMatchPriority(a))
    .slice(0, 40);
  if (!targets.length) return;
  const freshDetails = await Promise.all(targets.map(match => fetchLolesportsEventDetails(match)));
  const freshById = Object.fromEntries(freshDetails
    .filter(details => details?.id || details?.__requested_match_id)
    .map(details => [String(details.__requested_match_id || details.id), details]));
  state.allMatches = state.allMatches.map(match => {
    const fresh = freshById[String(match.id || '')];
    if (!fresh) return match;
    return mergeFreshMatchDetails(match, fresh);
  });
}

function mergeFreshMatchDetails(match, fresh) {
  const teams = fresh.teams || [];
  const { left, right } = freshTeamsForMatch(match, teams);
  const replaceTeams = hasPlaceholderTeamInfo(match) && teams.length >= 2;
  const merged = {
      ...match,
      status: fresh.status || match.status,
      start_time: match.start_time || fresh.start_time,
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

function freshTeamsForMatch(match, teams) {
  const blueMatched = freshTeamForMatchSide(match, teams, 'blue');
  const redMatched = freshTeamForMatchSide(match, teams, 'red');
  let left = blueMatched;
  let right = redMatched;
  if (!left && right) left = otherFreshTeam(teams, right);
  if (!right && left) right = otherFreshTeam(teams, left);
  if (left && right && sameTeamIdentity(left, right)) {
    if (redMatched && !blueMatched) left = otherFreshTeam(teams, right);
    if (blueMatched && !redMatched) right = otherFreshTeam(teams, left);
  }
  return {
    left: left || teams[0] || {},
    right: right || teams[1] || {},
  };
}

function otherFreshTeam(teams, selected) {
  return (teams || []).find(team => !sameTeamIdentity(team, selected)) || null;
}

function freshTeamForMatchSide(match, teams, side) {
  const name = side === 'blue' ? match.blue_team : match.red_team;
  const code = side === 'blue' ? match.blue_code : match.red_code;
  return (teams || []).find(item =>
    sameTeam(item.name, name)
    || sameTeam(item.code, code)
    || sameTeam(item.name, code)
    || sameTeam(item.code, name)
  ) || null;
}

function bestTeamImageForMatch(match, teams, side) {
  const current = side === 'blue' ? match.blue_image : match.red_image;
  if (!isPlaceholderImage(current)) return current;
  const team = freshTeamForMatchSide(match, teams, side);
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
  const today = todayDateKey();
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
  const today = todayDateKey();
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
    <a class="match" href="${detailHref(match.id)}" data-id="${escapeHtml(match.id)}" data-blue="${escapeHtml(match.blue_team)}" data-red="${escapeHtml(match.red_team)}" data-blue-code="${escapeHtml(match.blue_code || match.blue_team)}" data-red-code="${escapeHtml(match.red_code || match.red_team)}" data-blue-image="${escapeHtml(match.blue_image || '')}" data-red-image="${escapeHtml(match.red_image || '')}" data-blue-score="${escapeHtml(match.blue_score ?? '')}" data-red-score="${escapeHtml(match.red_score ?? '')}" data-league="${escapeHtml(match.league)}" data-bestof="${escapeHtml(match.best_of)}" data-status="${escapeHtml(match.status)}" data-start="${escapeHtml(match.start_time)}">
      <div class="matchMeta"><span>${escapeHtml(match.league)} · BO${escapeHtml(match.best_of || '-')}</span><span>${escapeHtml(matchStatusLabel(match))}</span></div>
      <div class="matchMeta"><span>${escapeHtml(matchStartLabel(match.start_time))}</span><span>${escapeHtml(matchDateLabel(match.start_time))}</span></div>
      <div class="versus">${matchCardTeam(match.blue_code || match.blue_team, match.blue_image)}<b>vs</b>${matchCardTeam(match.red_code || match.red_team, match.red_image)}</div>
      ${matchPredictionBadge(match)}
      <div class="matchFooter"><span class="backLink">Details</span>${matchResultText(match)}</div>
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

function matchResultText(match) {
  const normalized = String(match.status || '').toLowerCase();
  if (!matchHasScore(match) || !['completed', 'complete', 'inprogress'].includes(normalized)) return '';
  const leader = matchWinnerLabel(match);
  const blueScore = scoreNumber(match.blue_score);
  const redScore = scoreNumber(match.red_score);
  const score = leader && blueScore !== redScore
    ? `${Math.max(blueScore, redScore)}-${Math.min(blueScore, redScore)}`
    : `${match.blue_score}-${match.red_score}`;
  const label = leader
    ? `${leader} ${['completed', 'complete'].includes(normalized) ? 'wins' : 'leads'} ${score}`
    : score;
  return `<span class="matchResult">${escapeHtml(label)}</span>`;
}

function preMatchPredictionForMatch(match) {
  const predictions = state.preMatchPredictions || {};
  const eventId = String(match?.id || match?.event_id || '');
  if (eventId && predictions.byEventId?.[eventId]) return orientPredictionForMatch(match, predictions.byEventId[eventId]);
  const gameId = String(match?.game_id || match?.gameId || '');
  if (gameId && predictions.byGameId?.[gameId]) return orientPredictionForMatch(match, predictions.byGameId[gameId]);
  const key = preMatchPredictionKey({
    league: match?.league || '',
    start_time: match?.start_time || match?.start || '',
    blue_team: match?.blue_team || match?.blue || '',
    red_team: match?.red_team || match?.red || '',
  });
  if (key && predictions.byMatchKey?.[key]) return orientPredictionForMatch(match, predictions.byMatchKey[key]);
  const looseKey = loosePreMatchPredictionKey(match);
  return looseKey && predictions.byLooseMatchKey?.[looseKey]
    ? orientPredictionForMatch(match, predictions.byLooseMatchKey[looseKey])
    : null;
}

function orientPredictionForMatch(match, prediction) {
  if (!prediction) return null;
  const matchBlue = teamKey(match?.blue_team || match?.blue_code || match?.blue || '');
  const matchRed = teamKey(match?.red_team || match?.red_code || match?.red || '');
  const predictionBlue = teamKey(prediction.blue_team_name || prediction.blue_team || '');
  const predictionRed = teamKey(prediction.red_team_name || prediction.red_team || '');
  if (!matchBlue || !matchRed || !predictionBlue || !predictionRed) return prediction;
  if (matchBlue === predictionBlue && matchRed === predictionRed) return prediction;
  if (matchBlue === predictionRed && matchRed === predictionBlue) {
    return {
      ...prediction,
      blue_team: prediction.red_team,
      red_team: prediction.blue_team,
      blue_team_name: prediction.red_team_name,
      red_team_name: prediction.blue_team_name,
      blue_win_probability: prediction.red_win_probability,
      red_win_probability: prediction.blue_win_probability,
    };
  }
  return prediction;
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
      title: formatInAppTimeZone(date, { weekday: 'short' }),
      sub: formatInAppTimeZone(date, { month: 'numeric', day: 'numeric' }),
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
      state.userSelectedMatchDate = true;
      refreshStaticMatchStatuses().finally(() => {
        renderDateTabs(state.allMatches);
        renderMatches();
      });
    });
  }
}

function visibleDateOptions(options) {
  const today = todayDateKey();
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
    : options.findIndex(option => option.key === todayDateKey());
  const center = selected >= 0 ? selected : 0;
  const start = Math.max(0, Math.min(center - 1, options.length - 3));
  return options.slice(start, start + 3);
}

function filteredMatches() {
  const selected = filterMatchesBySelection(state.allMatches);
  if (state.selectedMatchDate === 'live') return liveMatches(selected);
  return sortMatchesByStart(selected.filter(match => localDateKey(match.start_time) === state.selectedMatchDate));
}

function liveMatches(matches) {
  return matches.filter(match => String(match.status || '').toLowerCase() === 'inprogress');
}

function defaultMatchDate(matches) {
  return todayDateKey();
}

function syncDefaultMatchDate(matches) {
  if (state.selectedMatchDate === 'live') return;
  const today = defaultMatchDate(matches);
  if (!state.selectedMatchDate) {
    state.selectedMatchDate = today;
    state.userSelectedMatchDate = false;
    return;
  }
  if (!state.userSelectedMatchDate && state.selectedMatchDate < today) {
    state.selectedMatchDate = today;
  }
}

function matchDateOptions(matches) {
  const keys = [...new Set(matches.map(match => localDateKey(match.start_time)).filter(Boolean))].sort();
  return keys.map(key => {
    const date = dateFromLocalKey(key);
    const weekday = formatInAppTimeZone(date, { weekday: 'short' });
    const md = formatInAppTimeZone(date, { month: 'numeric', day: 'numeric' });
    const isToday = key === todayDateKey();
    return { key, title: isToday ? '今日' : weekday, sub: md };
  });
}

function todayDateKey() {
  return zonedDateKey(new Date());
}

function localDateKey(value) {
  if (!value) return '';
  const date = parseScheduleDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return zonedDateKey(date);
}

function zonedDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dateFromLocalKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function formatInAppTimeZone(date, options) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: APP_TIME_ZONE, ...options }).format(date);
}

function matchDateLabel(value) {
  const date = parseScheduleDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatInAppTimeZone(date, { month: 'numeric', day: 'numeric', weekday: 'short' });
}

function matchStartLabel(value) {
  const date = parseScheduleDate(value);
  if (Number.isNaN(date.getTime())) return 'start TBD';
  return formatInAppTimeZone(date, { hour: '2-digit', minute: '2-digit' });
}

function parseScheduleDate(value) {
  const text = String(value || '').trim();
  if (!text) return new Date(NaN);
  const naiveDateTime = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (naiveDateTime) {
    const [, year, month, day, hour, minute, second = '00'] = naiveDateTime;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  return new Date(text);
}

async function selectMatch(match) {
  setValue('league', match.league || $('league')?.value || '');
  if ($('team')) $('team').value = match.blue || '';
  if ($('opponent')) $('opponent').value = match.red || '';
  if ($('side')) $('side').value = 'Blue';
  const cardDetails = matchDetailsFromCardDataset(match);
  renderSelectedMatch(cardDetails);
  if (!STATIC_SITE && $('prediction')) await predict();
  if (match.id) {
    try {
      const details = await api('/api/match?id=' + encodeURIComponent(match.id));
      if (details.id) renderSelectedMatch(mergeCardTeamImages(cardDetails, details));
    } catch (error) {
      $('selectedMatchMeta').textContent = `${match.league || ''} · details unavailable`;
    }
  }
}

function matchDetailsFromCardDataset(match) {
  return {
    id: match.id || '',
    teams: [
      {
        name: match.blue || match.blueCode || '',
        code: match.blueCode || match.blue || '',
        image: normalizeTeamImage(match.blueImage || ''),
        game_wins: match.blueScore ?? '',
      },
      {
        name: match.red || match.redCode || '',
        code: match.redCode || match.red || '',
        image: normalizeTeamImage(match.redImage || ''),
        game_wins: match.redScore ?? '',
      },
    ],
    games: [],
    best_of: match.bestof,
    league: match.league,
    status: match.status,
    start_time: match.start || '',
  };
}

function mergeCardTeamImages(cardDetails, details) {
  const teams = Array.isArray(details.teams) ? details.teams : [];
  const cardTeams = Array.isArray(cardDetails.teams) ? cardDetails.teams : [];
  const orderedTeams = cardTeams.length >= 2
    ? cardTeams.map((cardTeam, index) => {
      const detailTeam = teams.find(team => sameTeamIdentity(team, cardTeam)) || teams[index] || {};
      return {
        ...detailTeam,
        name: cardTeam.name || detailTeam.name || '',
        code: cardTeam.code || detailTeam.code || '',
        image: normalizeTeamImage(detailTeam.image || cardTeam.image || ''),
        game_wins: detailTeam.game_wins ?? cardTeam.game_wins ?? '',
      };
    })
    : teams;
  return {
    ...details,
    teams: orderedTeams,
  };
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
  renderPredictionPanel('selectedPredictionPanel', details);
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

function renderPredictionPanel(id, details) {
  const target = $(id);
  if (!target) return;
  const prediction = preMatchPredictionForDetails(details);
  if (!prediction) {
    target.classList.add('hidden');
    target.innerHTML = '';
    return;
  }
  target.classList.remove('hidden');
  target.innerHTML = predictionPanelHtml(details, prediction);
}

function predictionPanelHtml(details, prediction) {
  const teams = details?.teams || [];
  const blueName = teams[0]?.code || teams[0]?.name || prediction.blue_team || 'Blue';
  const redName = teams[1]?.code || teams[1]?.name || prediction.red_team || 'Red';
  const blue = prediction.blue_win_probability;
  const red = prediction.red_win_probability;
  const favorite = blue >= red
    ? { label: blueName, probability: blue }
    : { label: redName, probability: red };
  const confidence = prediction.confidence ? prediction.confidence.toUpperCase() : 'UNRATED';
  const meta = state.preMatchPredictions?.meta || {};
  const generated = meta.generated_at ? `generated ${shortDateTime(meta.generated_at)}` : '';
  const source = meta.source ? `feed ${meta.source}` : '';
  const model = prediction.model || meta.models?.pre_match?.name || '';
  const warnings = prediction.warnings?.length ? `warnings ${prediction.warnings.length}` : '';
  const foot = [model, generated, source, warnings].filter(Boolean).join(' | ');
  return `
    <div class="predictionPanelTop">
      <span class="predictionPanelTitle">Pre-match prediction <strong>${escapeHtml(shortTeamName(favorite.label))} ${formatProbability(favorite.probability)}</strong></span>
      <span class="predictionConfidence">${escapeHtml(confidence)}</span>
    </div>
    ${predictionUnifiedHtml(blueName, redName, blue, red)}
    <div class="predictionSplit">
      ${predictionSideHtml('blue', blueName, blue)}
      ${predictionSideHtml('red', redName, red)}
    </div>
    ${foot ? `<div class="predictionPanelFoot">${escapeHtml(foot)}</div>` : ''}
  `;
}

function predictionUnifiedHtml(blueName, redName, blue, red) {
  const blueWidth = Math.round(clampProbability(blue) * 1000) / 10;
  const redWidth = Math.round(clampProbability(red) * 1000) / 10;
  return `
    <div class="predictionUnified" aria-label="Pre-match win probability split">
      <div class="predictionUnifiedHead">
        <span><b>${escapeHtml(blueName)}</b> ${formatProbability(blue)}</span>
        <span>${formatProbability(red)} <b>${escapeHtml(redName)}</b></span>
      </div>
      <div class="predictionUnifiedBar">
        <span class="predictionUnifiedBlue" style="width:${blueWidth}%"></span>
        <i class="predictionUnifiedSplit" style="left:${blueWidth}%"></i>
        <span class="predictionUnifiedRed" style="width:${redWidth}%"></span>
      </div>
    </div>
  `;
}

function predictionSideHtml(side, name, probability) {
  const width = Math.round(clampProbability(probability) * 1000) / 10;
  return `
    <div class="predictionSide ${side}">
      <div class="predictionSideHead">
        <span>${escapeHtml(name)}</span>
        <strong>${formatProbability(probability)}</strong>
      </div>
      <div class="predictionBar" aria-label="${escapeHtml(name)} win probability">
        <span style="width:${width}%"></span>
      </div>
    </div>
  `;
}

function formatProbability(value) {
  return `${(clampProbability(value) * 100).toFixed(1)}%`;
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
}

function showDetailLoading() {
  $('matchTitle').textContent = 'Loading match...';
  $('matchMeta').textContent = 'Fetching schedule and live data';
  $('detailTeams').innerHTML = '<div class="loadingState">Loading match center...</div>';
  renderPredictionPanel('detailPredictionPanel', {});
  $('detailGames').innerHTML = '';
  const livePanel = document.querySelector('.livePanel');
  if (livePanel) livePanel.classList.remove('hidden');
  if ($('liveDraft')) $('liveDraft').innerHTML = '<div class="loadingState">Checking live feed...</div>';
}

async function refreshMatchDetail(initial) {
  const id = state.detailMatchId;
  let details = {};
  try {
    details = await fetchMatchDetail(id);
  } catch (error) {
    details = { id: '', warning: 'match_detail_fetch_failed' };
  }
  details = restoreEndedLiveSnapshot(details);
  markLiveFrameChanges(details);
  state.currentDetails = details;
  rememberLiveSnapshot(details);
  if (!details.id) {
    $('matchTitle').textContent = 'Match not found';
    $('matchMeta').textContent = details.warning || 'match detail unavailable';
    $('detailTeams').innerHTML = '<div class="loadingState">Match detail artifact is unavailable.</div>';
    return;
  }
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('matchTitle').textContent = `${left.name || left.code || '-'} vs ${right.name || right.code || '-'}`;
  $('matchMeta').textContent = matchDetailMeta(details);
  const seriesWinner = completedSeriesWinner(details);
  $('detailTeams').innerHTML = `${teamBlock(left, 'blueTeamRecord', seriesWinner)}${matchInfoBlock(details)}${teamBlock(right, 'redTeamRecord', seriesWinner)}`;
  renderPredictionPanel('detailPredictionPanel', details);
  loadTeamRecords(left, right, details.league);
  updateStartedVisibility(details);
  loadHeadToHead(left, right, details.league);
  loadTeamHistories(left, right, details.league);
  $('detailGames').innerHTML = gameListHtml(details);
  setDetailInputs(details);
  renderLiveDraft(details);
  if (initial) await predictDetail(left, right, details.league);
  updateLiveRefreshMeta(details);
  scheduleNextMatchDetailRefresh(details);
}

async function fetchMatchDetail(id) {
  if (!STATIC_SITE) return api('/api/match?id=' + encodeURIComponent(id));
  const fallback = () => api('/api/match?id=' + encodeURIComponent(id));
  const staticDetails = await fallback().catch(() => ({}));
  const liveId = liveSourceMatchId(staticDetails, id);
  const missingLiveSourceId = needsLiveSourceIdDiagnostic(staticDetails);
  try {
    const liveDetails = await api('/api/live-event?id=' + encodeURIComponent(liveId));
    if (liveDetails?.id && String(liveDetails.status || '').toLowerCase() !== 'unavailable') {
      return mergeFreshDetails(staticDetails, liveDetails);
    }
  } catch (error) {
  }
  if (staticDetails?.id) {
    return annotateLiveDiagnostic(staticDetails, missingLiveSourceId ? 'live_id_missing' : '');
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

function rememberLiveSnapshot(details) {
  if (!STATIC_SITE || !details?.id || !Array.isArray(details.games)) return;
  const games = details.games
    .filter(game => hasRetainableLiveData(game?.live))
    .map(game => ({
      id: String(game.id || ''),
      number: Number(game.number || 0),
      state: String(game.state || ''),
      blue: game.blue || {},
      red: game.red || {},
      winner: game.winner || '',
      live: game.live || {},
    }));
  if (!games.length) return;
  writeLiveSnapshot(details.id, {
    id: String(details.id || ''),
    status: String(details.status || ''),
    saved_at: new Date().toISOString(),
    games,
  });
}

function restoreEndedLiveSnapshot(details) {
  if (!STATIC_SITE || !details?.id || !Array.isArray(details.games)) return details;
  const snapshot = readLiveSnapshot(details.id);
  if (!snapshot?.games?.length) return details;
  const snapshotById = new Map(snapshot.games.map(game => [String(game.id || ''), game]));
  const snapshotByNumber = new Map(snapshot.games.map(game => [String(game.number || ''), game]));
  const endedSeries = isEndedMatchDetails(details);
  let restored = false;
  const games = details.games.map(game => {
    if (hasRetainableLiveData(game?.live)) return game;
    const previous = snapshotById.get(String(game.id || '')) || snapshotByNumber.get(String(game.number || ''));
    if (!previous?.live || !hasRetainableLiveData(previous.live)) return game;
    if (!shouldRestoreLiveSnapshotForGame(details, game, previous, endedSeries)) return game;
    restored = true;
    return {
      ...game,
      blue: hasTeamSideInfo(game.blue) ? game.blue : previous.blue || game.blue,
      red: hasTeamSideInfo(game.red) ? game.red : previous.red || game.red,
      winner: game.winner || previous.winner || '',
      live: {
        ...previous.live,
        status: 'ended',
        retained_after_end: true,
      },
    };
  });
  if (!restored) return details;
  return {
    ...details,
    games,
    warning: details.warning || 'retained_last_live_snapshot_after_end',
  };
}

function shouldRestoreLiveSnapshotForGame(details, game, previous, endedSeries) {
  const state = String(game?.state || '').toLowerCase();
  const liveStatus = String(game?.live?.status || '').toLowerCase();
  const previousStatus = String(previous?.live?.status || '').toLowerCase();
  return endedSeries
    || ['completed', 'complete'].includes(state)
    || ['ended', 'complete', 'completed'].includes(liveStatus)
    || ['ended', 'complete', 'completed'].includes(previousStatus);
}

function isEndedMatchDetails(details) {
  const status = String(details?.status || '').toLowerCase();
  if (['completed', 'complete'].includes(status)) return true;
  const games = details?.games || [];
  return games.length > 0 && games.every(game => ['completed', 'complete', 'unneeded'].includes(String(game.state || '').toLowerCase()));
}

function hasTeamSideInfo(side) {
  return Boolean(side?.team_id || side?.team_name || side?.team_code);
}

function hasRetainableLiveData(live) {
  if (!live || typeof live !== 'object') return false;
  if (hasMeaningfulLiveData(live)) return true;
  if (live.frame_timestamp) return true;
  return [...(live.blue || []), ...(live.red || [])].some(player =>
    player?.champion || player?.champion_id || (player?.player && player.player !== 'TBD')
  );
}

function readLiveSnapshot(matchId) {
  try {
    const raw = window.localStorage?.getItem(liveSnapshotStorageKey(matchId));
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    const savedAt = new Date(snapshot?.saved_at || '').getTime();
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > LIVE_SNAPSHOT_MAX_AGE_MS) {
      window.localStorage?.removeItem(liveSnapshotStorageKey(matchId));
      return null;
    }
    return snapshot;
  } catch (error) {
    return null;
  }
}

function writeLiveSnapshot(matchId, snapshot) {
  try {
    window.localStorage?.setItem(liveSnapshotStorageKey(matchId), JSON.stringify(snapshot));
  } catch (error) {
  }
}

function liveSnapshotStorageKey(matchId) {
  return `${LIVE_SNAPSHOT_STORAGE_PREFIX}${String(matchId || '')}`;
}

function matchDetailMeta(details) {
  return [
    details.league || '',
    `BO${details.best_of || '-'}`,
    details.source || '',
    matchDetailStartLabel(details.start_time),
    details.live_diagnostic || '',
    `auto-refresh ${matchDetailRefreshLabel(details)}`,
  ].filter(Boolean).join(' · ');
}

function scheduleNextMatchDetailRefresh(details) {
  if (state.detailTimer) window.clearTimeout(state.detailTimer);
  state.detailTimer = null;
  const policy = matchDetailRefreshPolicy(details);
  if (!policy.interval_ms) return;
  state.detailTimer = window.setTimeout(() => refreshMatchDetail(false), policy.interval_ms);
}

function matchDetailRefreshPolicy(details) {
  const status = String(details?.status || '').toLowerCase();
  if (['completed', 'complete'].includes(status)) {
    return { interval_ms: 0, label: 'off', reason: 'completed' };
  }
  if (status === 'inprogress') {
    return { interval_ms: DETAIL_REFRESH_IN_PROGRESS_MS, label: '5s', reason: 'live' };
  }
  if (status === 'updating') {
    return { interval_ms: DETAIL_REFRESH_NEAR_START_MS, label: '15s', reason: 'updating' };
  }
  const start = new Date(details?.start_time || '');
  if (Number.isNaN(start.getTime())) {
    return { interval_ms: DETAIL_REFRESH_PRESTART_MS, label: '60s', reason: 'unknown_start' };
  }
  const untilStart = start.getTime() - Date.now();
  if (untilStart <= 0) {
    return { interval_ms: DETAIL_REFRESH_FINALIZING_MS, label: '60s', reason: 'past_start' };
  }
  if (untilStart <= DETAIL_REFRESH_NEAR_START_WINDOW_MS) {
    return { interval_ms: DETAIL_REFRESH_NEAR_START_MS, label: '15s', reason: 'near_start' };
  }
  if (untilStart <= DETAIL_REFRESH_PRESTART_WINDOW_MS) {
    return { interval_ms: DETAIL_REFRESH_PRESTART_MS, label: '60s', reason: 'prestart' };
  }
  return { interval_ms: DETAIL_REFRESH_FUTURE_MS, label: '5m', reason: 'future' };
}

function matchDetailRefreshLabel(details) {
  const policy = matchDetailRefreshPolicy(details);
  return policy.reason ? `${policy.label} ${policy.reason}` : policy.label;
}

function matchDetailStartLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatInAppTimeZone(date, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  if (normalized === 'unstarted' && hasStartTimePassed(match.start_time)) return 'updating';
  return status;
}

function matchHasScore(match) {
  return match.blue_score !== undefined && match.red_score !== undefined
    && String(match.blue_score) !== '' && String(match.red_score) !== ''
    && (Number(match.blue_score || 0) + Number(match.red_score || 0)) > 0;
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
  return samePresentTeam(left?.id, right?.id)
    || samePresentTeam(left?.name, right?.name)
    || samePresentTeam(left?.code, right?.code)
    || samePresentTeam(left?.name, right?.code)
    || samePresentTeam(left?.code, right?.name);
}

function samePresentTeam(left, right) {
  return Boolean(left && right) && sameTeam(left, right);
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
  const showLiveTable = meaningfulLive;
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
          ${winProbText ? `<span class="liveProbability">${escapeHtml(winProbText)}</span>` : ''}
        </div>
        ${liveTeamHeader(redTeam)}
      </div>
      ${showLiveTable ? `
        <div class="liveStatsLine">
          ${liveStatsSide(blueStats, 'blue')}
          ${liveStatsSide(redStats, 'red')}
        </div>
        <div class="livePlayers">
          ${liveTeamRows(blueTeam, bluePlayers, redPlayers)}
          ${liveTeamRows(redTeam, redPlayers, bluePlayers)}
        </div>
      ` : `<div class="liveUnavailable">Live data unavailable</div>`}
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
  return `${blueName} ${(blue * 100).toFixed(1)}% / ${redName} ${((1 - blue) * 100).toFixed(1)}%`;
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
  const next = ` | next ${matchDetailRefreshLabel(details)}`;
  $('liveRefreshMeta').textContent = `Last checked ${updatedAt}${next}${liveSource}${frameTime}${frameState}${model}${validation}${warningText}`;
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatInAppTimeZone(date, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatInAppTimeZone(date, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
    loadRosterForTeam(blueTeam),
    loadRosterForTeam(redTeam),
  ]);
  const bluePlayers = rosterWithLiveFallback(blue.players || [], blueTeam);
  const redPlayers = rosterWithLiveFallback(red.players || [], redTeam);
  rememberRoster(blueName, blueTeam.code || '', bluePlayers);
  rememberRoster(redName, redTeam.code || '', redPlayers);
  $('blueRoster').innerHTML = rosterCards(bluePlayers);
  $('redRoster').innerHTML = rosterCards(redPlayers);
  if (state.currentDetails) renderLiveDraft(state.currentDetails);
}

async function loadRosterForTeam(team) {
  const name = team.name || team.code || '';
  const code = team.code || '';
  const query = new URLSearchParams({ team: name, team_code: code });
  try {
    return await api('/api/roster?' + query.toString());
  } catch (error) {
    return { team: name || code, players: [], warning: 'roster_request_failed' };
  }
}

function rememberRoster(name, code, players) {
  const keys = [name, code].map(teamKey).filter(Boolean);
  for (const key of keys) state.rosters[key] = players;
}

function rosterWithLiveFallback(players, team) {
  if (players.length) return players;
  return liveRosterPlayersForTeam(team);
}

function liveRosterPlayersForTeam(team) {
  const games = state.currentDetails?.games || [];
  const selected = selectedLiveGame(games);
  const candidates = [selected, ...games].filter(Boolean);
  for (const game of candidates) {
    const side = sideForTeam(game, team);
    const livePlayers = side ? game.live?.[side] || [] : [];
    if (hasRealLivePlayers(livePlayers)) return livePlayers.map(liveRosterPlayer);
  }
  return [];
}

function liveRosterPlayer(player) {
  const champion = championLabel(player);
  return {
    player: player.player || '-',
    role: player.role || '',
    games: 0,
    winrate: 0,
    kda: 0,
    top_champions: champion && champion !== 'TBD' ? [champion] : [],
    roster_source: 'live_frame',
  };
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
  try {
    const data = await api('/api/head-to-head?team_a=' + encodeURIComponent(leftName) + '&team_b=' + encodeURIComponent(rightName) + '&team_a_code=' + encodeURIComponent(leftTeam.code || '') + '&team_b_code=' + encodeURIComponent(rightTeam.code || '') + '&league=' + encodeURIComponent(league || ''));
    renderHeadToHead(data.matches || [], leftTeam, rightTeam);
  } catch (error) {
    renderHeadToHead([], leftTeam, rightTeam);
  }
}

async function loadTeamHistories(leftTeam, rightTeam, league) {
  const el = $('teamHistory');
  if (!el) return;
  const leftName = leftTeam.name || leftTeam.code || '';
  const rightName = rightTeam.name || rightTeam.code || '';
  const historyKey = `${league || ''}|${leftName}|${leftTeam.code || ''}|${rightName}|${rightTeam.code || ''}`;
  if (state.teamHistoryKey === historyKey && el.dataset.loaded === 'true') return;
  state.teamHistoryKey = historyKey;
  el.innerHTML = '<p class="h2hEmpty">Loading recent team history...</p>';
  try {
    const [left, right] = await Promise.all([
      api('/api/team-history?team=' + encodeURIComponent(leftName) + '&team_code=' + encodeURIComponent(leftTeam.code || '') + '&league=' + encodeURIComponent(league || '')),
      api('/api/team-history?team=' + encodeURIComponent(rightName) + '&team_code=' + encodeURIComponent(rightTeam.code || '') + '&league=' + encodeURIComponent(league || '')),
    ]);
    renderTeamHistories(left, right, leftTeam, rightTeam);
  } catch (error) {
    renderTeamHistories({ matches: [] }, { matches: [] }, leftTeam, rightTeam);
  }
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
    const label = winner?.code || winner?.name || '';
    return label ? `${label} WON` : '';
  }
  if (state === 'unneeded') return '-';
  const official = Number(live?.game_time || 0);
  if (official > 0 && !live?.estimated_game_time) return formatGameTime(official);
  return meaningfulLive ? 'LIVE' : '';
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

function renderTeamHistories(leftHistory, rightHistory, leftTeam = {}, rightTeam = {}) {
  const el = $('teamHistory');
  if (!el) return;
  el.dataset.loaded = 'true';
  el.innerHTML = `
    ${teamHistoryColumn(leftHistory, leftTeam)}
    ${teamHistoryColumn(rightHistory, rightTeam)}
  `;
}

function teamHistoryColumn(history, team = {}) {
  const matches = Array.isArray(history?.matches) ? history.matches.slice(0, 5) : [];
  const title = team.code || team.name || history?.team || '-';
  const logo = team.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  const titleMarkup = `
    <div class="teamHistoryTitle">
      ${logo}
      <h3>${escapeHtml(title)}</h3>
    </div>
  `;
  if (!matches.length) {
    return `
      <div class="teamHistoryColumn">
        ${titleMarkup}
        <p class="h2hEmpty">No recent team history in local data.</p>
      </div>
    `;
  }
  return `
    <div class="teamHistoryColumn">
      ${titleMarkup}
      <div class="teamHistoryRows">
        ${matches.map(match => teamHistoryRow(match)).join('')}
      </div>
    </div>
  `;
}

function teamHistoryRow(match) {
  const result = String(match.result || '').toUpperCase();
  const resultClass = result === 'W' ? 'win' : result === 'L' ? 'loss' : 'draw';
  const score = `${match.team_score ?? '-'}-${match.opponent_score ?? '-'}`;
  return `
    <div class="teamHistoryRow">
      <span class="teamHistoryDate">${escapeHtml(relativeDateJa(match.date))}</span>
      <span class="teamHistoryScore">${escapeHtml(score)}</span>
      <span class="teamHistoryOpponent">
        ${historyTeamLogo(match.opponent, match.opponent_image)}
        <strong>${escapeHtml(shortTeamName(match.opponent || '-'))}</strong>
      </span>
      <span class="teamHistoryResult ${resultClass}">${escapeHtml(result || '-')}</span>
    </div>
  `;
}

function historyTeamLogo(teamName, image) {
  if (image) return `<img src="${escapeHtml(image)}" alt="">`;
  return `<span class="teamHistoryLogoFallback">${escapeHtml(shortTeamName(teamName || '-').slice(0, 3))}</span>`;
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
    lngesports: 'suzhoulngesports',
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
    cnv: 'conviction',
    conviction: 'conviction',
    sn: 'supernova',
    supernova: 'supernova',
    su: 'suesports',
    suesports: 'suesports',
    pcf: 'pcificesports',
    pcificesports: 'pcificesports',
    g2: 'g2esports',
    g2esports: 'g2esports',
    kc: 'karminecorp',
    karminecorp: 'karminecorp',
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
      ${rosterMetaText(player) ? `<div class="playerMeta">${escapeHtml(rosterMetaText(player))}</div>` : ''}
      <div class="playerMeta">Top champs: ${escapeHtml(player.top_champions.join(', ') || '-')}</div>
    </div>
  `).join('');
}

function rosterMetaText(player) {
  if (player.roster_source === 'leaguepedia') return 'Leaguepedia current roster';
  if (player.roster_source === 'live_frame') return '';
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

function syncChampionMetaGroup() {
  const leagueGroup = $('leagueGroup')?.value || DEFAULT_LEAGUE_GROUP;
  const championMetaGroup = $('championMetaGroup');
  if (!championMetaGroup) return;
  setValue('championMetaGroup', leagueGroup === 'event' ? DEFAULT_LEAGUE_GROUP : leagueGroup);
}

if ($('matches')) {
  if ($('leagueGroup')) $('leagueGroup').addEventListener('change', () => { syncChampionMetaGroup(); loadSummary(); loadMatches(); });
  if ($('region')) $('region').addEventListener('change', () => { loadSummary(); loadMatches(); });
  if ($('teamLeague')) $('teamLeague').addEventListener('change', loadTeamStandings);
  if ($('championMetaGroup')) $('championMetaGroup').addEventListener('change', () => loadChampionSummary());
  if ($('championRole')) $('championRole').addEventListener('change', () => state.championSummary && renderChampionMeta(state.championSummary));
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
