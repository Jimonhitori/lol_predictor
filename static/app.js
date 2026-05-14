
const state = { options: null, detailMatchId: null, detailTimer: null, liveClockTimer: null, rosterKey: '', selectedLiveGameId: '', rosters: {}, currentDetails: null, allMatches: [], selectedMatchDate: '', matchSource: '' };
const $ = (id) => document.getElementById(id);
const STATIC_SITE = Boolean(window.STATIC_SITE);

async function api(path) {
  if (STATIC_SITE) return staticApi(path);
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function staticApi(path) {
  const url = new URL(path, location.origin);
  const params = url.searchParams;
  let target = '';
  if (url.pathname === '/api/options') {
    target = 'static/data/options.json';
  } else if (url.pathname === '/api/summary') {
    target = `static/data/summaries/${staticKey($('leagueGroup')?.value || params.get('league_group') || 'all')}__${staticKey($('region')?.value || params.get('region') || 'all')}.json`;
  } else if (url.pathname === '/api/matches/today') {
    target = `static/data/matches-${staticKey($('leagueGroup')?.value || params.get('league_group') || 'all')}__${staticKey($('region')?.value || params.get('region') || 'all')}.json`;
  } else if (url.pathname === '/api/match') {
    target = `static/data/matches/${encodeURIComponent(params.get('id') || '')}.json`;
  } else if (url.pathname === '/api/roster') {
    target = `static/data/rosters/${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/team-record') {
    target = `static/data/team-records/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team') || '')}.json`;
  } else if (url.pathname === '/api/head-to-head') {
    target = `static/data/h2h/${staticKey(params.get('league') || 'all')}__${staticKey(params.get('team_a') || '')}__${staticKey(params.get('team_b') || '')}.json`;
  }
  if (!target) throw new Error(`Static data route is not available: ${path}`);
  const response = await fetch(target);
  if (!response.ok) throw new Error(`Static data missing: ${target}`);
  return response.json();
}

function staticKey(value) {
  return String(value || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
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

function renderChampionTable(id, rows, patch) {
  const version = ddragonVersion(patch);
  const header = `<div class="row header championMetaRow"><span>Champion</span><span>Picks</span><span>Wins</span><span>Winrate</span></div>`;
  $(id).innerHTML = header + rows.map(r => `
    <div class="row championMetaRow">
      <span class="championMetaCell">
        ${championImage(r.name, version)}
        <span>${escapeHtml(championDisplayName(r.name))}</span>
      </span>
      <span>${r.games ?? r.picks}</span>
      <span>${r.wins}</span>
      <span>${r.winrate}</span>
    </div>
  `).join('');
}

async function loadOptions() {
  state.options = await api('/api/options');
  fillSelect('league', state.options.leagues);
  for (const id of ['top_champion','jng_champion','mid_champion','bot_champion','sup_champion']) fillSelect(id, state.options.champions);
  $('leagueGroup').value = 'major';
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
  $('meta').textContent = `Patch ${data.patch} | ${data.games} games | ${data.leagues.join(', ')}`;
  renderChampionTable('champions', data.champions, data.patch);
  renderTable('teams', data.teams, 'Team');
}

async function loadMatches() {
  const data = await api('/api/matches/today?' + qs());
  state.allMatches = data.matches || [];
  state.matchSource = data.source || 'none';
  if (!state.selectedMatchDate) {
    state.selectedMatchDate = defaultMatchDate(state.allMatches);
  }
  renderDateTabs(state.allMatches);
  renderMatches();
}

function renderMatches() {
  const matches = filteredMatches();
  $('matchSource').textContent = `${matches.length} / ${state.allMatches.length} matches | ${state.matchSource || 'none'}`;
  if (!matches.length) {
    $('matches').innerHTML = '<p>No matches for the selected filters.</p>';
    return;
  }
  $('matches').innerHTML = matches.map(match => `
    <a class="match" href="${detailHref(match.id)}" data-id="${escapeHtml(match.id)}" data-blue="${escapeHtml(match.blue_team)}" data-red="${escapeHtml(match.red_team)}" data-league="${escapeHtml(match.league)}" data-bestof="${escapeHtml(match.best_of)}" data-status="${escapeHtml(match.status)}">
      <div class="matchMeta"><span>${escapeHtml(match.league)} · BO${escapeHtml(match.best_of || '-')}</span><span>${escapeHtml(matchStatusLabel(match))}</span></div>
      <div class="matchMeta"><span>${escapeHtml(matchStartLabel(match.start_time))}</span><span>${escapeHtml(matchDateLabel(match.start_time))}</span></div>
      <div class="versus">${matchCardTeam(match.blue_code || match.blue_team, match.blue_image)}<b>vs</b>${matchCardTeam(match.red_code || match.red_team, match.red_image)}</div>
      <span class="backLink">Details</span>
    </a>
  `).join('');
  for (const el of document.querySelectorAll('.match')) {
    el.addEventListener('mouseenter', () => selectMatch(el.dataset));
    el.addEventListener('focus', () => selectMatch(el.dataset));
  }
  selectMatch(document.querySelector('.match').dataset);
}

function detailHref(id) {
  return `${STATIC_SITE ? 'match.html' : '/match'}?id=${encodeURIComponent(id || '')}`;
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
      renderDateTabs(state.allMatches);
      renderMatches();
    });
  }
}

function visibleDateOptions(options) {
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
  const today = localDateKey(new Date().toISOString());
  if (matches.some(match => localDateKey(match.start_time) === today)) return today;
  if (liveMatches(matches).length) return 'live';
  return matchDateOptions(matches)[0]?.key || 'live';
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
  renderSelectedMatch({ teams: [{ name: match.blue, code: match.blue }, { name: match.red, code: match.red }], games: [], best_of: match.bestof, league: match.league, status: match.status });
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
  $('selectedMatch').innerHTML = `
    ${teamBlock(left)}
    ${STATIC_SITE ? '' : `<div class="winPill"><span>Blue-side model</span><strong id="inlinePrediction">${$('prediction')?.textContent || '-'}</strong></div>`}
    ${teamBlock(right)}
  `;
  $('gameList').innerHTML = (details.games || []).map(game => `
    <div class="gameItem">
      <b>Game ${game.number} · ${escapeHtml(game.state)}</b>
      <span>Blue: ${escapeHtml(game.blue?.team_code || game.blue?.team_name || '-')}</span><br>
      <span>Red: ${escapeHtml(game.red?.team_code || game.red?.team_name || '-')}</span>
    </div>
  `).join('');
}

function teamBlock(team, recordId) {
  const image = team.image ? `<img src="${escapeHtml(team.image)}" alt="">` : '';
  const record = recordId
    ? `<span id="${recordId}" class="teamRecord">Loading 2026 record...</span>`
    : `<span>${escapeHtml(team.game_wins || '0')} wins</span>`;
  return `<div class="teamBlock">${image}<strong>${escapeHtml(team.name || team.code || '-')}</strong>${record}</div>`;
}

function matchCardTeam(name, image) {
  const logo = image ? `<img src="${escapeHtml(image)}" alt="">` : '<span></span>';
  return `<span class="cardTeam">${logo}<span>${escapeHtml(name || '-')}</span></span>`;
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
  await refreshMatchDetail(true);
  state.detailTimer = window.setInterval(() => refreshMatchDetail(false), 10000);
}

async function refreshMatchDetail(initial) {
  const id = state.detailMatchId;
  const details = await api('/api/match?id=' + encodeURIComponent(id));
  state.currentDetails = details;
  if (!details.id) {
    $('matchTitle').textContent = 'Match not found';
    return;
  }
  const teams = details.teams || [];
  const left = teams[0] || {};
  const right = teams[1] || {};
  $('matchTitle').textContent = `${left.name || left.code || '-'} vs ${right.name || right.code || '-'}`;
  $('matchMeta').textContent = `${details.league || ''} · BO${details.best_of || '-'} · ${details.source || ''} · auto-refresh 10s`;
  $('detailTeams').innerHTML = `${teamBlock(left, 'blueTeamRecord')}${matchInfoBlock(details)}${teamBlock(right, 'redTeamRecord')}`;
  loadTeamRecords(left, right, details.league);
  updateStartedVisibility(details);
  loadHeadToHead(left, right, details.league);
  $('detailGames').innerHTML = (details.games || []).map(game => `
    <div class="gameItem">
      <b>Game ${game.number} · ${escapeHtml(game.state)}</b>
      <span>Blue: ${escapeHtml(game.blue?.team_code || game.blue?.team_name || '-')}</span><br>
      <span>Red: ${escapeHtml(game.red?.team_code || game.red?.team_name || '-')}</span>
    </div>
  `).join('');
  setDetailInputs(details);
  renderLiveDraft(details);
  if (initial) await predictDetail(left, right, details.league);
  updateLiveRefreshMeta(details);
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
  const hasScore = match.blue_score !== undefined && match.red_score !== undefined
    && String(match.blue_score) !== '' && String(match.red_score) !== ''
    && (Number(match.blue_score || 0) + Number(match.red_score || 0)) > 0;
  if (hasScore && ['completed', 'complete', 'inprogress'].includes(normalized)) {
    return `${status} · ${match.blue_score}-${match.red_score}`;
  }
  return status;
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
  const hasLive = Boolean((live.blue || []).length || (live.red || []).length);
  const meaningfulLive = hasMeaningfulLiveData(live);
  const board = $('liveBoard');
  if (!board) return;
  board.innerHTML = `
    <div class="liveTabs">${(details.games || []).map(item => liveGameTab(item, game)).join('')}</div>
    <div class="liveContent">
      <div class="liveTop">
        ${liveTeamHeader(blueTeam)}
        <div class="liveCenter">
          <span class="liveBadge ${hasLive && !meaningfulLive ? 'warning' : ''}">${escapeHtml(liveBadgeText(hasLive, meaningfulLive))}</span>
          <span class="liveTimer">${escapeHtml(liveTimerText(live, meaningfulLive))}</span>
        </div>
        ${liveTeamHeader(redTeam)}
      </div>
      <div class="liveStatsLine">
        ${liveStatsSide(live.blue_stats || {}, 'blue')}
        ${liveStatsSide(live.red_stats || {}, 'red')}
      </div>
      <div class="livePlayers">
        ${liveTeamRows(blueTeam, bluePlayers, redPlayers)}
        ${liveTeamRows(redTeam, redPlayers, bluePlayers)}
      </div>
    </div>
  `;
  attachLiveTabHandlers(details);
}

function activeGame(games) {
  const inProgress = games.find(game => String(game.state || '').toLowerCase() === 'inprogress');
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
    champion: player.champion || '',
    champion_id: player.champion_id || '',
    level: player.level || 1,
    kills: 0,
    deaths: 0,
    assists: 0,
    creep_score: 0,
    gold: 0,
    current_health: 0,
    max_health: 0,
    items: [],
    previous_game_pick: true,
  };
}

function rosterPlayersForTeam(team) {
  const roster = state.rosters[teamKey(team?.name)] || state.rosters[teamKey(team?.code)] || [];
  return roster.map(player => ({
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
  if (champion.match(/^\d+$/)) return `Champion #${champion}`;
  return championDisplayName(champion);
}

function updateLiveRefreshMeta(details) {
  const updatedAt = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const liveGame = activeGame(details.games || []);
  const liveSource = liveGame?.live?.source ? ` · ${liveGame.live.source}` : '';
  $('liveRefreshMeta').textContent = `Last checked ${updatedAt}${liveSource}`;
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
        ${championIcon(player.champion_id || player.champion)}
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

function liveBadgeText(hasLive, meaningfulLive) {
  if (!hasLive) return 'STATS TEMPORARILY DISABLED';
  if (!meaningfulLive) return 'LIVE FEED RETURNING ZERO STATS';
  return 'IN GAME';
}

function liveTimerText(live, meaningfulLive) {
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

function itemSlots(items) {
  const slots = Array.from({ length: 7 }, (_, index) => items[index]).map(item => {
    const id = String(item || '').replace(/[^0-9]/g, '');
    if (!id) return '<span class="itemSlot"></span>';
    return `<span class="itemSlot"><img src="https://ddragon.leagueoflegends.com/cdn/16.9.1/img/item/${escapeHtml(id)}.png" alt=""></span>`;
  });
  return `<div class="itemSlots">${slots.join('')}</div>`;
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
  return `<img src="https://ddragon.leagueoflegends.com/cdn/${escapeHtml(version)}/img/champion/${escapeHtml(id)}.png" alt="">`;
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

function championImageId(value) {
  const text = String(value || '').replace(/[^A-Za-z0-9]/g, '');
  const aliases = { MonkeyKing: 'Wukong' };
  return aliases[text] || text;
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
      <span class="h2hTeam ${leftWon ? 'isWinner' : ''}">${escapeHtml(leftCurrent?.code || leftCurrent?.name || match.left_team)}</span>
      <span class="h2hMiniLogo">${teamLogoMarkup(match.left_team, context)}</span>
      <span class="h2hScore">${escapeHtml(match.left_score)} - ${escapeHtml(match.right_score)}</span>
      <span class="h2hMiniLogo">${teamLogoMarkup(match.right_team, context)}</span>
      <span class="h2hTeam isRight ${rightWon ? 'isWinner' : ''}">${escapeHtml(rightCurrent?.code || rightCurrent?.name || match.right_team)}</span>
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
      <div class="playerCardTop"><strong>${escapeHtml(player.role)}</strong><strong>${escapeHtml(player.player)}</strong></div>
      <div class="playerMeta">${escapeHtml(player.games)} games · ${(player.winrate * 100).toFixed(1)}% WR · KDA ${Number(player.kda).toFixed(2)}</div>
      <div class="playerMeta">Top champs: ${escapeHtml(player.top_champions.join(', ') || '-')}</div>
    </div>
  `).join('');
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
  $('scheduleDate').addEventListener('change', () => {
    state.selectedMatchDate = $('scheduleDate').value || defaultMatchDate(state.allMatches);
    renderDateTabs(state.allMatches);
    renderMatches();
  });
  if ($('predictForm')) $('predictForm').addEventListener('submit', predict);
  loadOptions().then(() => { loadSummary(); loadMatches(); });
} else {
  loadMatchDetailPage();
}
