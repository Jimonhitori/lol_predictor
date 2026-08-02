
const state = { options: null, summary: null, championSummary: null, detailMatchId: null, detailTimer: null, matchesTimer: null, liveClockTimer: null, rosterKey: '', teamHistoryKey: '', selectedLiveGameId: '', rosters: {}, currentDetails: null, allMatches: [], selectedMatchDate: '', matchSource: '', liveFrames: {}, teamStanding: 'league:LCK', preMatchPredictions: { byEventId: {}, byGameId: {}, byMatchKey: {}, meta: {}, status: 'not_loaded' }, preMatchPredictionPromise: null, teamRegistry: { byKey: {}, status: 'not_loaded' }, teamRegistryPromise: null, diagnostics: null, diagnosticsPromise: null, scheduleCache: null, scheduleCacheExpiresAt: 0, schedulePromise: null, matchesRequestId: 0, userSelectedMatchDate: false };
const $ = (id) => document.getElementById(id);
const STATIC_SITE = Boolean(window.STATIC_SITE);
const STATIC_DATA_VERSION = '20260802-cloudflare-schedule';
const SCHEDULE_API_URL = String(window.LOL_PREDICTOR_SCHEDULE_API_URL || 'https://lol-predictor-data.next1gg1.workers.dev/schedule').trim();
const SCHEDULE_API_CACHE_MS = 5 * 60 * 1000;
const APP_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
const NAIVE_SCHEDULE_UTC_OFFSET_HOURS = 9;
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
const VISIBLE_DATE_TAB_COUNT = 3;
const INTERNATIONAL_EVENT_KEYS = new Set(['msi', 'worlds', 'ewc', 'esports-world-cup']);
const TEAM_ARTIFACT_LEAGUES = ['lck', 'lpl', 'lec', 'lcs', 'lcp', 'cblol', 'vcs', 'tcl', 'lfl', 'nacl', 'lck-challengers'];

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
    return staticMatchesPayload(params);
  } else if (url.pathname === '/api/match') {
    return staticMatchDetail(params);
  } else if (url.pathname === '/api/roster') {
    return staticRoster(params);
  } else if (url.pathname === '/api/team-record') {
    return staticTeamRecord(params);
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

async function staticMatchesPayload(params) {
  const group = staticKey($('leagueGroup')?.value || params.get('league_group') || 'all');
  const region = staticKey($('region')?.value || params.get('region') || 'all');
  const payload = await fetchStaticJson(`data/matches-${group}__${region}.json`);
  const eventPayload = group === 'major'
    ? await fetchStaticJson(`data/matches-event__${region}.json`).catch(() => ({ matches: [] }))
    : { matches: [] };
  const schedulePayload = await fetchCloudflareSchedulePayload().catch(() => null);
  const scheduleMatches = filterMatchesBySelection(schedulePayload?.matches || [], {
    league_group: group,
    region,
  });
  const matches = dedupeCanonicalMatches([
    ...(payload.matches || []),
    ...(eventPayload.matches || []),
    ...scheduleMatches,
  ]);
  return {
    ...payload,
    source: schedulePayload?.ok ? 'cloudflare_lolesports_schedule+static_fallback' : payload.source,
    schedule_generated_at: schedulePayload?.generated_at || '',
    matches,
  };
}

async function fetchCloudflareSchedulePayload() {
  if (!STATIC_SITE || !SCHEDULE_API_URL) return null;
  if (state.scheduleCache && Date.now() < state.scheduleCacheExpiresAt) return state.scheduleCache;
  if (state.schedulePromise) return state.schedulePromise;
  state.schedulePromise = (async () => {
    const response = await fetch(SCHEDULE_API_URL);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) {
      throw new Error(`Cloudflare schedule unavailable: ${response.status}`);
    }
    const payload = await response.json();
    if (!payload?.ok || !Array.isArray(payload.matches)) {
      throw new Error('Cloudflare schedule response is invalid');
    }
    state.scheduleCache = payload;
    state.scheduleCacheExpiresAt = Date.now() + SCHEDULE_API_CACHE_MS;
    return payload;
  })();
  try {
    return await state.schedulePromise;
  } finally {
    state.schedulePromise = null;
  }
}

async function fetchStaticJson(path) {
  const target = staticDataUrl(path);
  const response = await fetch(target, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Static data missing: ${target}`);
  return response.json();
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
  const scheduledDetail = await staticMatchIndexDetail(id).catch(() => ({}));
  const predictions = await loadPreMatchPredictions();
  const prediction = predictions.byEventId?.[id] || predictions.byGameId?.[id] || null;
  const predictedDetail = prediction ? matchDetailFromPrediction(prediction) : {};
  if (scheduledDetail?.id || predictedDetail?.id) {
    return mergeMatchDetailSources(scheduledDetail, predictedDetail);
  }
  return { id: '', warning: 'match_detail_static_artifact_missing' };
}

async function staticMatchIndexDetail(id) {
  for (const path of ['data/matches-all__all.json', 'data/matches-event__all.json']) {
    const payload = await fetchStaticJson(path).catch(() => ({}));
    const match = (payload.matches || []).find(row =>
      String(row?.id || '') === id || String(row?.source_match_id || '') === id
    );
    if (match) return matchDetailFromIndexMatch(match);
  }
  return {};
}

function matchDetailFromIndexMatch(match) {
  return {
    ...match,
    id: String(match?.id || match?.source_match_id || ''),
    teams: [
      {
        side: 'blue',
        name: match?.blue_team || match?.blue_code || '',
        code: match?.blue_code || match?.blue_team || '',
        image: normalizeTeamImage(match?.blue_image || ''),
        game_wins: match?.blue_score ?? '',
      },
      {
        side: 'red',
        name: match?.red_team || match?.red_code || '',
        code: match?.red_code || match?.red_team || '',
        image: normalizeTeamImage(match?.red_image || ''),
        game_wins: match?.red_score ?? '',
      },
    ],
    games: Array.isArray(match?.games) ? match.games : [],
    source: match?.source || 'static_match_index',
  };
}

function mergeMatchDetailSources(base, overlay) {
  if (!base?.id) return overlay || {};
  if (!overlay?.id) return base;
  return {
    ...base,
    ...overlay,
    id: overlay.id || base.id,
    league: overlay.league || base.league || '',
    best_of: overlay.best_of || base.best_of || '',
    start_time: base.start_time || overlay.start_time || '',
    status: overlay.status || base.status || '',
    teams: Array.isArray(overlay.teams) && overlay.teams.length >= 2 ? overlay.teams : base.teams,
    games: Array.isArray(overlay.games) && overlay.games.length ? overlay.games : (base.games || []),
  };
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

async function staticTeamRecord(params) {
  const team = params.get('team') || '';
  const teamCode = params.get('team_code') || '';
  const leagueKeys = teamArtifactLeagueKeys(params.get('league'));
  const teamKeys = teamStaticKeys(team, teamCode);
  for (const league of leagueKeys) {
    for (const key of teamKeys) {
      const response = await fetch(staticDataUrl(`data/team-records/${league}__${key}.json`), { cache: 'no-store' });
      if (!response.ok) continue;
      try {
        return await response.json();
      } catch (error) {
        continue;
      }
    }
  }
  return {
    team: team || teamCode,
    matched_team: '',
    league_record: '',
    games: 0,
    warning: 'team_record_static_artifact_missing',
  };
}

function safeMatchFileId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]+/g, '_');
}

async function staticTeamHistory(params) {
  const team = params.get('team') || '';
  const teamCode = params.get('team_code') || '';
  const leagueKeys = teamArtifactLeagueKeys(params.get('league'));
  const teamKeys = teamStaticKeys(team, teamCode);
  await loadTeamRegistry();
  for (const league of leagueKeys) {
    for (const key of teamKeys) {
      if (!key) continue;
      const response = await fetch(statãN9ÚÚ$z{-®éÜj×B‡fÇVR“°Ð¢–b‚–B’&WGW&ârs°Ð¢&WGW&âÆ–Ör7&3Ò&‡GG3¢òöFG&vöâæÆVwVVöfÆVvVæG2æ6öÒö6FâòG¶W66T‡FÖÂ‡fW'6–öâ—Òö–Örö6†×–öâòG¶W66T‡FÖÂ†–B—Òçær"ÇCÒ""FFÖ6†×–öãÒ"G¶W66T‡FÖÂ‡fÇVR—Ò"öæW'&÷#Ò'F†—2ç&WÆ6Uv—F‚†6†×–öä–ÖvTfÆÆ&6²‡F†—2æFF6WBæ6†×–öâ’’#æ°Ð§ÐÐ Ð¦gVæ7F–öâFG&vöåfW'6–öâ‡F6‚’°Ð¢6öç7BÖF6‚Ò7G&–ær‡F6‚ÇÂrr’æÖF6‚‚õâ…ÆB²•Ââ…ÆB²’Bò“°Ð¢–b‚ÖF6‚’&WGW&âsbã’ãs°Ð¢&WGW&âG´çVÖ&W"†ÖF6…³Ò—ÒâG´çVÖ&W"†ÖF6…³%Ò—Òã°Ð§ÐÐ Ð¦gVæ7F–öâ&öÆTÆ&VÂ‡fÇVR’°Ð¢6öç7BFW‡BÒ7G&–ær‡fÇVRÇÂrr’çFôÆ÷vW$66R‚“°Ð¢6öç7BÆ&VÇ2Ò²F÷¢uF÷rÂ§VævÆS¢t§VævÆRrÂ¦æs¢t§VævÆRrÂÖ–C¢tÖ–BrÂÖ–FFÆS¢tÖ–BrÂ&÷C¢t&÷BrÂ&÷GFöÓ¢t&÷BrÂF3¢t&÷BrÂ7W÷'C¢u7W÷'BrÂ7W¢u7W÷'BrÓ°Ð¢&WGW&âÆ&VÇ5·FW‡EÒÇÂfÇVRÇÂrs°Ð§ÐÐ Ð¦gVæ7F–öâ6ö×7E&öÆTÆ&VÂ‡fÇVR’°Ð¢6öç7BFW‡BÒ7G&–ær‡fÇVRÇÂrr’çFôÆ÷vW$66R‚“°Ð¢6öç7BÆ&VÇ2Ò²F÷¢uDõrÂ§VævÆS¢t¥TrrÂ¦æs¢t¥TrrÂ§Vs¢t¥TrrÂÖ–C¢tÔ”BrÂÖ–FFÆS¢tÔ”BrÂ&÷C¢t$õBrÂ&÷GFöÓ¢t$õBrÂF3¢t$õBrÂ7W÷'C¢u5UrÂ7W¢u5UrÓ°Ð¢&WGW&âÆ&VÇ5·FW‡EÒÇÂ7G&–ær‡fÇVRÇÂrÒr’çFõWW$66R‚“°Ð§ÐÐ Ð¦gVæ7F–öâ6†×–öä–ÖvT–B‡fÇVR’°Ð¢6öç7BFW‡BÒ7G&–ær‡fÇVRÇÂrr’ç&WÆ6R‚õµäÕ¦×£Ó•ÒörÂrr“°Ð¢6öç7BÆ–6W2Ò°Ð¢¢tææ–RrÀÐ¢C¢u6–öârÀÐ¢##¢t6†RrÀÐ¢S¢t6—FÇ–ârÀÐ¢c¢t÷&–æærÀÐ¢cC¢tÆVU6–ârÀÐ¢Cs¢u6W&†–æRrÀÐ¢#SC¢uf’rÀÐ¢C3#¢t&&BrÀÐ¢s““¢tÖ&W76rÀÐ¢W&VÆ–öç6öÃ¢tW&VÆ–öå6öÂrÀÐ¢&VÇfWFƒ¢t&VÇfWF‚rÀÐ¢6†övFƒ¢t6†övF‚rÀÐ¢G&×VæFó¢tG$×VæFòrÀÐ¢f–FFÆW7F–6·3¢tf–FFÆW7F–6·2rÀÐ¢¦'fæ—c¢t¦'fä•brÀÐ¢¶—6¢t¶—6rÀÐ¢¶†¦—ƒ¢t¶†¦—‚rÀÐ¢¶övÖs¢t¶ötÖrrÀÐ¢·6çFS¢tµ6çFRrÀÐ¢ÆV&Ææ3¢tÆV&Ææ2rÀÐ¢ÆVW6–ã¢tÆVU6–ârÀÐ¢Ö7FW'–“¢tÖ7FW%–’rÀÐ¢Ö—76f÷'GVæS¢tÖ—74f÷'GVæRrÀÐ¢Ööæ¶W–¶–æs¢tÖöæ¶W”¶–ærrÀÐ¢çVçWv–ÆÇV×¢tçVçRrÀÐ¢&V·6“¢u&Vµ6’rÀÐ¢&VæFvÆ63¢u&VæFrÀÐ¢F†Ö¶Væ6ƒ¢uF†Ô¶Væ6‚rÀÐ¢Gv—7FVFfFS¢uGv—7FVDfFRrÀÐ¢fVÆ¶÷£¢ufVÆ¶÷¢rÀÐ¢wV¶öæs¢tÖöæ¶W”¶–ærrÀÐ¢†–ç¦†ó¢u†–å¦†òrÀÐ¢Ó°Ð¢&WGW&âÆ–6W5·FW‡BçFôÆ÷vW$66R‚•ÒÇÂFW‡C°Ð§ÐÐ Ð¦gVæ7F–öâ6†×–öä–ÖvTfÆÆ&6²‡fÇVR’°Ð¢6öç7B7âÒFö7VÖVçBæ7&VFTVÆVÖVçB‚w7âr“°Ð¢7âæ6Æ74æÖRÒvÆ—fT6†×–öåÆ6V†öÆFW"6†×–öä–ÖvTÖ—76–ærs°Ð¢7âçF—FÆRÒÖ—76–ær6†×–öâ–6öã¢G·fÇVRÇÂrÒwÖ°Ð¢7âçFW‡D6öçFVçBÒsòs°Ð¢&WGW&â7ã°Ð§ÐÐ Ð¦gVæ7F–öâ6†×–öäF—7Æ”æÖR‡fÇVR’°Ð¢6öç7BÆ–6W2Ò²Ööæ¶W”¶–æs¢uwV¶öærrÂ†–å¦†ó¢u†–â¦†òrÂGv—7FVDfFS¢uGv—7FVBfFRrÂ¦'fä•c¢t¦'fâ•brÂµ6çFS¢$²u6çFR"Ó°Ð¢&WGW&âÆ–6W5µ7G&–ær‡fÇVRÇÂrr•ÒÇÂfÇVS°Ð§ÐÐ Ð¦gVæ7F–öâf÷&ÖDvÖUF–ÖR‡6V6öæG2’°Ð¢6öç7BF÷FÂÒÖF‚æÖ‚ƒÂçVÖ&W"‡6V6öæG2ÇÂ’“°Ð¢6öç7BÖ–çWFW2ÒÖF‚æfÆö÷"‡F÷FÂòc“°Ð¢6öç7B6V72Ò7G&–ær„ÖF‚æfÆö÷"‡F÷FÂRc’’çE7F'Bƒ"Âsr“°Ð¢&WGW&âG¶Ö–çWFW7Ó¢G·6V77Ö°Ð§ÐÐ Ð¦gVæ7F–öâf÷&ÖDvöÆB‡fÇVR’°Ð¢6öç7BvöÆBÒçVÖ&W"‡fÇVRÇÂ“°Ð¢&WGW&âæWr–çFÂäçVÖ&W$f÷&ÖB‡VæFVf–æVBÂ²Ö†–×VÔg&7F–öäF–v—G3¢Ò’æf÷&ÖB†vöÆB“°Ð§ÐÐ Ð¦gVæ7F–öâf÷&ÖE6–væVB‡fÇVR’°Ð¢6öç7BçVÖ&W"ÒçVÖ&W"‡fÇVRÇÂ“°Ð¢–b†çVÖ&W"â’&WGW&â²G¶f÷&ÖDvöÆB†çVÖ&W"—Ö°Ð¢–b†çVÖ&W"Â’&WGW&âÒG¶f÷&ÖDvöÆB„ÖF‚æ'2†çVÖ&W"’—Ö°Ð¢&WGW&âss°Ð§ÐÐ Ð¦gVæ7F–öâ6WEFVÕ&V6÷&B†–BÂ&V6÷&B’°Ð¢6öç7BVÂÒB†–B“°Ð¢–b‚VÂ’&WGW&ã°Ð¢VÂçFW‡D6öçFVçBÒ&V6÷&BæÆVwVU÷&V6÷&BÇÂtÆVwVR&V6÷&BVæf–Æ&ÆRs°Ð§ÐÐ Ð¦gVæ7F–öâ6WDfÆÆ&6µFVÕ&V6÷&B†–BÂFVÒ’°Ð¢6öç7BVÂÒB†–B“°Ð¢–b‚VÂ’&WGW&ã°Ð¢VÂçFW‡D6öçFVçBÒtÆVwVR&V6÷&BVæf–Æ&ÆRs°Ð§ÐÐ Ð¦gVæ7F–öâ&VæFW%6V6öå&V6÷&G2†&ÇVRÂ&VB’°Ð¢6öç7BVÂÒB‚w6V6öå&V6÷&G2r“°Ð¢–b‚VÂ’&WGW&ã°Ð¢VÂæ–ææW$…DÔÂÒ Ð¢ÆF—b6Æ73Ò'&÷r†VFW"#ãÇ7ãåFVÓÂ÷7ããÇ7ãävÖW3Â÷7ããÇ7ãå&V6÷&CÂ÷7ããÇ7ãåu#Â÷7ããÂöF—càÐ¢G·6V6öå&V6÷&E&÷r†&ÇVR—ÐÐ¢G·6V6öå&V6÷&E&÷r‡&VB—ÐÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâ6V6öå&V6÷&E&÷r‡&V6÷&B’°Ð¢6öç7BæÖRÒ&V6÷&BæÖF6†VE÷FVÒÇÂ&V6÷&BçFVÒÇÂrÒs°Ð¢6öç7BvÖU&V6÷&BÒ&V6÷&Bç&V6÷&BÇÂrÒs°Ð¢6öç7BvÖW2Ò&V6÷&BævÖW2óòrÒs°Ð¢6öç7Bv–ç&FRÒG—Vöb&V6÷&Bçv–ç&FRÓÓÒvçVÖ&W"ròG²‡&V6÷&Bçv–ç&FR¢’çFôf—†VBƒ—ÒV¢rÒs°Ð¢&WGW&âÆF—b6Æ73Ò'&÷r#ãÇ7ãâG¶W66T‡FÖÂ†æÖR—ÓÂ÷7ããÇ7ãâG¶W66T‡FÖÂ†vÖW2—ÓÂ÷7ããÇ7ãâG¶W66T‡FÖÂ†vÖU&V6÷&B—ÓÂ÷7ããÇ7ãâG¶W66T‡FÖÂ‡v–ç&FR—ÓÂ÷7ããÂöF—cæ°Ð§ÐÐ Ð¦gVæ7F–öâ&VæFW$†VEFô†VB†ÖF6†W2ÂÆVgEFVÒÒ·ÒÂ&–v‡EFVÒÒ·Ò’°Ð¢6öç7BVÂÒB‚v†VEFô†VBr“°Ð¢–b‚VÂ’&WGW&ã°Ð¢–b‚ÖF6†W2æÆVæwF‚’°Ð¢VÂæ–ææW$…DÔÂÒsÇ6Æ73Ò&ƒ&„V×G’#äæò&V6VçBF—&V7BÖF6†W2–âÆö6ÂFFãÂ÷âs°Ð¢&WGW&ã°Ð¢ÐÐ¢6öç7B6öçFW‡BÒ²ÆVgEFVÒÂ&–v‡EFVÒÓ°Ð¢6öç7B7G&—ÖF6†W2ÒÖF6†W2ç6Æ–6RƒÂR“°Ð¢VÂæ–ææW$…DÔÂÒ Ð¢ÆF—b6Æ73Ò&ƒ&„Æövõ7G&—#àÐ¢G·7G&—ÖF6†W2æÖ†ÖF6‚ÓâÆF—b6Æ73Ò&ƒ&„Æövô6VÆÂ#âG·FVÔÆövôÖ&·W‡v–ææ–æuFVÔæÖR†ÖF6‚’Â6öçFW‡B—ÓÂöF—cæ’æ¦ö–â‚rr—ÐÐ¢ÂöF—càÐ¢G¶ÖF6†W2æÖ†ÖF6‚Óâƒ&…&÷r†ÖF6‚Â6öçFW‡B’’æ¦ö–â‚rr—ÐÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâ&VæFW%FVÔ†—7F÷&–W2†ÆVgD†—7F÷'’Â&–v‡D†—7F÷'’ÂÆVgEFVÒÒ·ÒÂ&–v‡EFVÒÒ·Ò’°Ð¢6öç7BVÂÒB‚wFVÔ†—7F÷'’r“°Ð¢–b‚VÂ’&WGW&ã°Ð¢VÂæFF6WBæÆöFVBÒwG'VRs°Ð¢VÂæ–ææW$…DÔÂÒ Ð¢G·FVÔ†—7F÷'”6öÇVÖâ†ÆVgD†—7F÷'’ÂÆVgEFVÒ—ÐÐ¢G·FVÔ†—7F÷'”6öÇVÖâ‡&–v‡D†—7F÷'’Â&–v‡EFVÒ—ÐÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâFVÔ†—7F÷'”6öÇVÖâ††—7F÷'’ÂFVÒÒ·Ò’°Ð¢6öç7BÖF6†W2Ò'&’æ—4'&’††—7F÷'“òæÖF6†W2’ò†—7F÷'’æÖF6†W2ç6Æ–6RƒÂR’¢µÓ°Ð¢6öç7BF—FÆRÒFVÒæ6öFRÇÂFVÒææÖRÇÂ†—7F÷'“òçFVÒÇÂrÒs°Ð¢6öç7BÆövòÒFVÒæ–ÖvRòÆ–Ör7&3Ò"G¶W66T‡FÖÂ‡FVÒæ–ÖvR—Ò"ÇCÒ"#æ¢rs°Ð¢6öç7BF—FÆTÖ&·WÒ Ð¢ÆF—b6Æ73Ò'FVÔ†—7F÷'•F—FÆR#àÐ¢G¶Æöv÷ÐÐ¢Æƒ3âG¶W66T‡FÖÂ‡F—FÆR—ÓÂöƒ3àÐ¢ÂöF—càÐ¢°Ð¢–b‚ÖF6†W2æÆVæwF‚’°Ð¢&WGW&â Ð¢ÆF—b6Æ73Ò'FVÔ†—7F÷'”6öÇVÖâ#àÐ¢G·F—FÆTÖ&·WÐÐ¢Ç6Æ73Ò&ƒ&„V×G’#äæò&V6VçBFVÒ†—7F÷'’–âÆö6ÂFFãÂ÷àÐ¢ÂöF—càÐ¢°Ð¢ÐÐ¢&WGW&â Ð¢ÆF—b6Æ73Ò'FVÔ†—7F÷'”6öÇVÖâ#àÐ¢G·F—FÆTÖ&·WÐÐ¢ÆF—b6Æ73Ò'FVÔ†—7F÷'•&÷w2#àÐ¢G¶ÖF6†W2æÖ†ÖF6‚ÓâFVÔ†—7F÷'•&÷r†ÖF6‚’’æ¦ö–â‚rr—ÐÐ¢ÂöF—càÐ¢ÂöF—càÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâFVÔ†—7F÷'•&÷r†ÖF6‚’°Ð¢6öç7B&W7VÇBÒ7G&–ær†ÖF6‚ç&W7VÇBÇÂrr’çFõWW$66R‚“°Ð¢6öç7B&W7VÇD6Æ72Ò&W7VÇBÓÓÒurròwv–âr¢&W7VÇBÓÓÒtÂròvÆ÷72r¢vG&rs°Ð¢6öç7B66÷&RÒG¶ÖF6‚çFVÕ÷66÷&RóòrÒwÒÒG¶ÖF6‚æ÷öæVçE÷66÷&RóòrÒwÖ°Ð¢&WGW&â Ð¢ÆF—b6Æ73Ò'FVÔ†—7F÷'•&÷r#àÐ¢Ç7â6Æ73Ò'FVÔ†—7F÷'”FFR#âG¶W66T‡FÖÂ‡&VÆF—fTFFT¦†ÖF6‚æFFR’—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò'FVÔ†—7F÷'•66÷&R#âG¶W66T‡FÖÂ‡66÷&R—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò'FVÔ†—7F÷'”÷öæVçB#àÐ¢G¶†—7F÷'•FVÔÆövò†ÖF6‚æ÷öæVçBÂÖF6‚æ÷öæVçEö–ÖvR—ÐÐ¢Ç7G&öæsâG¶W66T‡FÖÂ‡6†÷'EFVÔæÖR†ÖF6‚æ÷öæVçBÇÂrÒr’—ÓÂ÷7G&öæsàÐ¢Â÷7ãàÐ¢Ç7â6Æ73Ò'FVÔ†—7F÷'•&W7VÇBG·&W7VÇD6Æ77Ò#âG¶W66T‡FÖÂ‡&W7VÇBÇÂrÒr—ÓÂ÷7ãàÐ¢ÂöF—càÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâ†—7F÷'•FVÔÆövò‡FVÔæÖRÂ–ÖvR’°Ð¢–b†–ÖvR’&WGW&âÆ–Ör7&3Ò"G¶W66T‡FÖÂ†–ÖvR—Ò"ÇCÒ"#æ°Ð¢&WGW&âÇ7â6Æ73Ò'FVÔ†—7F÷'”ÆövôfÆÆ&6²#âG¶W66T‡FÖÂ‡6†÷'EFVÔæÖR‡FVÔæÖRÇÂrÒr’ç6Æ–6RƒÂ2’—ÓÂ÷7ãæ°Ð§ÐÐ Ð¦gVæ7F–öâƒ&…&÷r†ÖF6‚Â6öçFW‡B’°Ð¢6öç7BÆVgEvöâÒçVÖ&W"†ÖF6‚æÆVgE÷66÷&R’âçVÖ&W"†ÖF6‚ç&–v‡E÷66÷&R“°Ð¢6öç7B&–v‡EvöâÒçVÖ&W"†ÖF6‚ç&–v‡E÷66÷&R’âçVÖ&W"†ÖF6‚æÆVgE÷66÷&R“°Ð¢6öç7BÆVgD7W'&VçBÒ7W'&VçEFVÔf÷$†—7F÷&–6Â†ÖF6‚æÆVgE÷FVÒÂ6öçFW‡B“°Ð¢6öç7B&–v‡D7W'&VçBÒ7W'&VçEFVÔf÷$†—7F÷&–6Â†ÖF6‚ç&–v‡E÷FVÒÂ6öçFW‡B“°Ð¢&WGW&â Ð¢ÆF—b6Æ73Ò&ƒ&…&÷r"F—FÆSÒ"G¶W66T‡FÖÂ†ÖF6‚ç7Æ—BÇÂrr—Ò#àÐ¢Ç7â6Æ73Ò&ƒ&„FFR#âG¶W66T‡FÖÂ‡&VÆF—fTFFT¦†ÖF6‚æFFR’—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò&ƒ&…FVÒG¶ÆVgEvöâòv—5v–ææW"r¢v—4Æ÷6W"wÒ#âG¶W66T‡FÖÂ†ÆVgD7W'&VçCòæ6öFRÇÂÆVgD7W'&VçCòææÖRÇÂÖF6‚æÆVgE÷FVÒ—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò&ƒ&„Ö–æ”Æövò#âG·FVÔÆövôÖ&·W†ÖF6‚æÆVgE÷FVÒÂ6öçFW‡B—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò&ƒ&…66÷&R#âG¶W66T‡FÖÂ†ÖF6‚æÆVgE÷66÷&R—ÒÒG¶W66T‡FÖÂ†ÖF6‚ç&–v‡E÷66÷&R—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò&ƒ&„Ö–æ”Æövò#âG·FVÔÆövôÖ&·W†ÖF6‚ç&–v‡E÷FVÒÂ6öçFW‡B—ÓÂ÷7ãàÐ¢Ç7â6Æ73Ò&ƒ&…FVÒ—5&–v‡BG·&–v‡Evöâòv—5v–ææW"r¢v—4Æ÷6W"wÒ#âG¶W66T‡FÖÂ‡&–v‡D7W'&VçCòæ6öFRÇÂ&–v‡D7W'&VçCòææÖRÇÂÖF6‚ç&–v‡E÷FVÒ—ÓÂ÷7ãàÐ¢ÂöF—càÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâv–ææ–æuFVÔæÖR†ÖF6‚’°Ð¢&WGW&âçVÖ&W"†ÖF6‚æÆVgE÷66÷&R’âçVÖ&W"†ÖF6‚ç&–v‡E÷66÷&R’òÖF6‚æÆVgE÷FVÒ¢ÖF6‚ç&–v‡E÷FVÓ°Ð§ÐÐ Ð¦gVæ7F–öâFVÔÆövôÖ&·W‡FVÔæÖRÂ6öçFW‡B’°Ð¢6öç7BÖF6‚Ò7W'&VçEFVÔf÷$†—7F÷&–6Â‡FVÔæÖRÂ6öçFW‡B“°Ð¢–b†ÖF6ƒòæ–ÖvR’&WGW&âÆ–Ör7&3Ò"G¶W66T‡FÖÂ†ÖF6‚æ–ÖvR—Ò"ÇCÒ"#æ°Ð¢&WGW&âÇ7â6Æ73Ò&ƒ&„ÆövôfÆÆ&6²#âG¶W66T‡FÖÂ‡6†÷'EFVÔæÖR‡FVÔæÖR’—ÓÂ÷7ãæ°Ð§ÐÐ Ð¦gVæ7F–öâ7W'&VçEFVÔf÷$†—7F÷&–6Â‡FVÔæÖRÂ6öçFW‡B’°Ð¢6öç7BFV×2Ò¶6öçFW‡BæÆVgEFVÒÂ6öçFW‡Bç&–v‡EFVÕÒæf–ÇFW"„&ööÆVâ“°Ð¢&WGW&âFV×2æf–æB‡FVÒÓâ6ÖUFVÒ‡FVÔæÖRÂFVÓòææÖR’ÇÂ6ÖUFVÒ‡FVÔæÖRÂFVÓòæ6öFR’ÇÂ6ÖUFVÒ‡FVÔæÖRÂFVÓòç6ÇVr’“°Ð§ÐÐ Ð¦gVæ7F–öâ6ÖUFVÒ†Â"’°Ð¢&WGW&âFVÔ¶W’†’ÓÓÒFVÔ¶W’†"“°Ð§ÐÐ Ð¦gVæ7F–öâFVÔ¶W’‡fÇVR’°Ð¢6öç7B¶W’Ò7G&–ær‡fÇVRÇÂrr’çFôÆ÷vW$66R‚’ç&WÆ6R‚õµæ×£Ó•ÒörÂrr“°Ð¢6öç7BÆ–6W2Ò°Ð¢vVæs¢vvVærrÀÐ¢vVævW7÷'G3¢vvVærrÀÐ¢vVã¢vvVærrÀÐ¢G'ƒ¢v¶—vööÖG'‚rÀÐ¢·'ƒ¢v¶—vööÖG'‚rÀÐ¢¶—vööÖG'ƒ¢v¶—vööÖG'‚rÀÐ¢·C¢v·G&öÇ7FW"rÀÐ¢·G&öÇ7FW#¢v·G&öÇ7FW"rÀÐ¢F³¢vGÇW6¶–rÀÐ¢GÇW6¶–¢vGÇW6¶–rÀÐ¢F¶3¢vGÇW6¶–6†ÆÆVævW'2rÀÐ¢F¶6†ÆÆVævW'3¢vGÇW6¶–6†ÆÆVævW'2rÀÐ¢GÇW6¶–6†ÆÆVævW'3¢vGÇW6¶–6†ÆÆVævW'2rÀÐ¢C¢wCW7÷'G66FV×’rÀÐ¢CV¢wCW7÷'G66FV×’rÀÐ¢CW7÷'G66FV×“¢wCW7÷'G66FV×’rÀÐ¢C6†ÆÆVævW'3¢wCW7÷'G66FV×’rÀÐ¢&æ¶fV'ƒ¢v&æ¶fV'‚rÀÐ¢&gƒ¢v&æ¶fV'‚rÀÐ¢fV'ƒ¢v&æ¶fV'‚rÀÐ¢æöæw6†–×&VFf÷&6S¢væöæw6†–×&VFf÷&6RrÀÐ¢æöæw6†–×&VFf÷&6V6†ÆÆVævW'3¢væöæw6†–×&VFf÷&6V6†ÆÆVævW'2rÀÐ¢ç3¢væöæw6†–×&VFf÷&6RrÀÐ¢C¢wCrÀÐ¢†ÆS¢v†çv†Æ–fVW7÷'G2rÀÐ¢†çv†Æ–fVW7÷'G3¢v†çv†Æ–fVW7÷'G2rÀÐ¢'&ó¢v'&–öârÀÐ¢†æ¦–æ'&–öã¢v'&–öârÀÐ¢'&–öã¢v'&–öârÀÐ¢Fç3¢vFç6ö÷W'2rÀÐ¢Fç6ö÷W'3¢vFç6ö÷W'2rÀÐ¢¦Fs¢v¦FvÖ–ærrÀÐ¢¦C¢v¦FvÖ–ærrÀÐ¢¦FvÖ–æs¢v¦FvÖ–ærrÀÐ¢&V–¦–æv¦FvW7÷'G3¢v¦FvÖ–ærrÀÐ¢FW3¢wF÷W7÷'G2rÀÐ¢F÷W7÷'G3¢wF÷W7÷'G2rÀÐ¢&Æs¢v&–Æ–&–Æ–vÖ–ærrÀÐ¢&–Æ–&–Æ–vÖ–æs¢v&–Æ–&–Æ–vÖ–ærrÀÐ¢–s¢v–çf–7GW6vÖ–ærrÀÐ¢–çf–7GW6vÖ–æs¢v–çf–7GW6vÖ–ærrÀÐ¢VFs¢vVGv&FvÖ–ærrÀÐ¢VGv&FvÖ–æs¢vVGv&FvÖ–ærrÀÐ¢öÖs¢vö†×–vöBrÀÐ¢ö†×–vöC¢vö†×–vöBrÀÐ¢Ææs¢w7W¦†÷VÆævW7÷'G2rÀÐ¢ÆævW7÷'G3¢w7W¦†÷VÆævW7÷'G2rÀÐ¢7W¦†÷VÆævW7÷'G3¢w7W¦†÷VÆævW7÷'G2rÀÐ¢ÆvC¢vÆvFvÖ–ærrÀÐ¢ÆvFvÖ–æs¢vÆvFvÖ–ærrÀÐ¢Ã¢vç–öæW6ÆVvVæBrÀÐ¢ç–öæW6ÆVvVæC¢vç–öæW6ÆVvVæBrÀÐ¢vS¢w†–çFV×vRrÀÐ¢FV×vS¢w†–çFV×vRrÀÐ¢†–çFV×vS¢w†–çFV×vRrÀÐ¢vV–&övÖ–æs¢wvV–&övÖ–ærrÀÐ¢v&s¢wvV–&övÖ–ærrÀÐ¢W¢wVÇG&&–ÖRrÀÐ¢VÇG&&–ÖS¢wVÇG&&–ÖRrÀÐ¢æ—¢w6†Vç¦†Vææ–æ¦6–ç–¦Ö2rÀÐ¢6†Vç¦†Vææ–æ¦6–ç–¦Ö3¢w6†Vç¦†Vææ–æ¦6–ç–¦Ö2rÀÐ¢3“¢v6Æ÷VC’rÀÐ¢6Æ÷VC“¢v6Æ÷VC’rÀÐ¢6Æ÷VC–¶–¢v6Æ÷VC’rÀÐ¢FÃ¢wFVÖÆ—V–BrÀÐ¢FÆs¢wFVÖÆ—V–BrÀÐ¢FVÖÆ—V–C¢wFVÖÆ—V–BrÀÐ¢FVÖÆ—V–FÆ–Vçv&S¢wFVÖÆ—V–BrÀÐ¢6çc¢v6öçf–7F–öârÀÐ¢6öçf–7F–öã¢v6öçf–7F–öârÀÐ¢6ã¢w7WW&æ÷frÀÐ¢7WW&æ÷f¢w7WW&æ÷frÀÐ¢7S¢w7VW7÷'G2rÀÐ¢7VW7÷'G3¢w7VW7÷'G2rÀÐ¢6c¢w6–f–6W7÷'G2rÀÐ¢6–f–6W7÷'G3¢w6–f–6W7÷'G2rÀÐ¢s#¢vs&W7÷'G2rÀÐ¢s&W7÷'G3¢vs&W7÷'G2rÀÐ¢¶3¢v¶&Ö–æV6÷'rÀÐ¢¶&Ö–æV6÷'¢v¶&Ö–æV6÷'rÀÐ¢Ó°Ð¢&WGW&âÆ–6W5¶¶W•ÒÇÂ¶W“°Ð§ÐÐ Ð¦gVæ7F–öâ6†÷'EFVÔæÖR‡fÇVR’°Ð¢6öç7BFW‡BÒ7G&–ær‡fÇVRÇÂrÒr’çG&–Ò‚“°Ð¢&WGW&âFW‡BæÆVæwF‚ÃÒ2òFW‡B¢FW‡Bç6Æ–6RƒÂ2’çFõWW$66R‚“°Ð§ÐÐ Ð¦gVæ7F–öâ&VÆF—fTFFT¦‡fÇVR’°Ð¢6öç7BFFRÒæWrFFR‡fÇVR“°Ð¢–b„çVÖ&W"æ—4æâ†FFRævWEF–ÖR‚’’’&WGW&ârÒs°Ð¢6öç7BF—2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB‚„FFRææ÷r‚’ÒFFRævWEF–ÖR‚’’òƒcC’“°Ð¢–b†F—2ÓÓÒ’&WGW&âuFöF’s°Ð¢–b†F—2Â3’&WGW&âG¶F—7ÖBvö°Ð¢&WGW&âG´ÖF‚ç&÷VæB†F—2ò3—ÖÖòvö°Ð§ÐÐ Ð¦gVæ7F–öâ&VÆF—fTFFR‡fÇVR’°Ð¢6öç7BFFRÒæWrFFR‡fÇVR“°Ð¢–b„çVÖ&W"æ—4æâ†FFRævWEF–ÖR‚’’’&WGW&ârÒs°Ð¢6öç7BF—2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB‚„FFRææ÷r‚’ÒFFRævWEF–ÖR‚’’òƒcC’“°Ð¢–b†F—2ÓÓÒ’&WGW&âuFöF’s°Ð¢–b†F—2ÓÓÒ’&WGW&âsBvòs°Ð¢–b†F—2Â3’&WGW&âG¶F—7ÖBvö°Ð¢6öç7BÖöçF‡2ÒÖF‚ç&÷VæB†F—2ò3“°Ð¢&WGW&âG¶ÖöçF‡7ÖÖòvö°Ð§ÐÐ Ð¦gVæ7F–öâ&÷7FW$6&G2‡Æ–W'2’°Ð¢–b‚Æ–W'2æÆVæwF‚’&WGW&âsÇäæòÆö6Â&÷7FW"ÖF6‚–WBãÂ÷âs°Ð¢&WGW&âÆ–W'2æÖ‡Æ–W"Óâ Ð¢ÆF—b6Æ73Ò'Æ–W$6&B#àÐ¢ÆF—b6Æ73Ò'Æ–W$6&EF÷#ãÇ7G&öæsâG¶W66T‡FÖÂ†6ö×7E&öÆTÆ&VÂ‡Æ–W"ç&öÆR’—ÓÂ÷7G&öæsãÇ7G&öæsâG¶W66T‡FÖÂ‡Æ–W"çÆ–W"—ÓÂ÷7G&öæsãÂöF—càÐ¢G·&÷7FW$ÖWFFW‡B‡Æ–W"’òÆF—b6Æ73Ò'Æ–W$ÖWF#âG¶W66T‡FÖÂ‡&÷7FW$ÖWFFW‡B‡Æ–W"’—ÓÂöF—cæ¢rwÐÐ¢ÆF—b6Æ73Ò'Æ–W$ÖWF#åF÷6†×3¢G¶W66T‡FÖÂ‡&÷7FW$6†×–öå7FG5FW‡B‡Æ–W"’—ÓÂöF—càÐ¢ÂöF—càÐ¢’æ¦ö–â‚rr“°Ð§ÐÐ Ð¦gVæ7F–öâ&÷7FW$6†×–öå7FG5FW‡B‡Æ–W"’°Ð¢6öç7B7FG2Ò'&’æ—4'&’‡Æ–W"æ6†×–öå÷7FG2’òÆ–W"æ6†×–öå÷7FG2¢µÓ°Ð¢–b‡7FG2æÆVæwF‚’°Ð¢&WGW&â7FG2ç6Æ–6RƒÂ2’æÖ‡&÷rÓâ°Ð¢6öç7BvÖW2ÒçVÖ&W"‡&÷rævÖW2ÇÂ“°Ð¢6öç7Bv–ç&FRÒçVÖ&W"‡&÷rçv–ç&FRÇÂ“°Ð¢&WGW&âG·&÷ræ6†×–öâÇÂrÒwÒG¶vÖW7ÔrG²‡v–ç&FR¢’çFôf—†VBƒ—ÒV°Ð¢Ò’æ¦ö–â‚rÂr“°Ð¢ÐÐ¢&WGW&â‡Æ–W"çF÷ö6†×–öç2ÇÂµÒ’æ¦ö–â‚rÂr’ÇÂrÒs°Ð§ÐÐ Ð¦gVæ7F–öâ&÷7FW$ÖWFFW‡B‡Æ–W"’°Ð¢–b‡Æ–W"ç&÷7FW%÷6÷W&6RÓÓÒvÆVwVWVF–r’&WGW&âtÆVwVWVF–7W'&VçB&÷7FW"s°Ð¢–b‡Æ–W"ç&÷7FW%÷6÷W&6RÓÓÒvÆ—fUög&ÖRr’&WGW&ârs°Ð¢&WGW&âG·Æ–W"ævÖW7ÒvÖW2+rG²‡Æ–W"çv–ç&FR¢’çFôf—†VBƒ—ÒRu"+r´DG´çVÖ&W"‡Æ–W"æ¶F’çFôf—†VBƒ"—Ö°Ð§ÐÐ Ð¦gVæ7F–öâW66T‡FÖÂ‡fÇVR’°Ð¢&WGW&â7G&–ær‡fÇVR’ç&WÆ6R‚õ²cÃâ"uÒörÂ2Óâ‡²rbs¢rf×²rÂsÂs¢rfÇC²rÂsâs¢rfwC²rÂr"s¢rgV÷C²rÂ"r#¢rb33“²wÕ¶5Ò’“°Ð§ÐÐ Ð¦gVæ7F–öâ6WEfÇVR†–BÂfÇVR’°Ð¢6öç7BVÂÒB†–B“°Ð¢–b‚VÂ’&WGW&ã°Ð¢–b…²ââæVÂæ÷F–öç5Òç6öÖR†÷F–öâÓâ÷F–öâçfÇVRÓÓÒfÇVR’’VÂçfÇVRÒfÇVS°Ð§ÐÐ Ð¦–b‚B‚vÖF6†W2r’’°Ð¢–b‚B‚vÆVwVTw&÷Wr’’B‚vÆVwVTw&÷Wr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ²ÆöE7VÖÖ'’‚“²ÆöDÖF6†W2‚“²Ò“°Ð¢–b‚B‚w&Vv–öâr’’B‚w&Vv–öâr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ²ÆöE7VÖÖ'’‚“²ÆöDÖF6†W2‚“²Ò“°Ð¢–b‚B‚wFVÔÆVwVRr’’B‚wFVÔÆVwVRr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂÆöEFVÕ7FæF–æw2“°Ð¢–b‚B‚v6†×–öäÖWFw&÷Wr’’B‚v6†×–öäÖWFw&÷Wr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’ÓâÆöD6†×–öå7VÖÖ'’‚’“°Ð¢–b‚B‚v6†×–öå&öÆRr’’B‚v6†×–öå&öÆRr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ7FFRæ6†×–öå7VÖÖ'’bb&VæFW$6†×–öäÖWF‡7FFRæ6†×–öå7VÖÖ'’’“°Ð¢B‚w66†VGVÆTFFRr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ°Ð¢7FFRç6VÆV7FVDÖF6„FFRÒB‚w66†VGVÆTFFRr’çfÇVRÇÂFVfVÇDÖF6„FFR‡7FFRæÆÄÖF6†W2“°Ð¢7FFRçW6W%6VÆV7FVDÖF6„FFRÒG'VS°Ð¢&Vg&W6…7FF–4ÖF6…7FGW6W2‚’æf–æÆÇ’‚‚’Óâ°Ð¢&VæFW$FFUF'2‡7FFRæÆÄÖF6†W2“°Ð¢&VæFW$ÖF6†W2‚“°Ð¢Ò“°Ð¢Ò“°Ð¢–b‚B‚w&VF–7Df÷&Òr’’B‚w&VF–7Df÷&Òr’æFDWfVçDÆ—7FVæW"‚w7V&Ö—BrÂ&VF–7B“°Ð¢ÆöD÷F–öç2‚’çF†Vâ‚‚’Óâ°Ð¢ÆöDF–væ÷7F–72‚“°Ð¢ÆöE7VÖÖ'’‚“°Ð¢ÆöDÖF6†W2‚“°Ð¢7FFRæÖF6†W5F–ÖW"Òv–æF÷rç6WD–çFW'fÂ†ÆöDÖF6†W2ÂÔD4„U5õ$Te$U4…ô”åDU%dÅôÕ2“°Ð¢Ò“°Ð§ÒVÇ6R°Ð¢ÆöDF–væ÷7F–72‚“°Ð¢ÆöDÖF6„FWF–ÅvR‚“°Ð§ÐÐ