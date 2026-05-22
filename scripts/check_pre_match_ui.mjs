#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl || args.base
  ? String(args.baseUrl || args.base).replace(/\/+$/, '')
  : '';
const docsDir = path.resolve(String(args.docsDir || 'docs'));
const minRows = Number(args.minRows || 1);
const minOverlap = Number(args.minOverlap || 1);
const requestedMatchId = args.matchId ? String(args.matchId) : '';
const predictionFeedPath = String(args.predictionFeedPath || 'pre_match_predictions.json').replace(/^\/+/, '');
const predictionFeedUrl = args.predictionFeedUrl ? String(args.predictionFeedUrl) : '';

const [feed, matchesPayload, appSource] = await Promise.all([
  loadJson(predictionFeedUrl || predictionFeedPath),
  loadJson('static/data/matches-all__all.json'),
  loadText('static/app.js'),
]);
const schema = await loadJson('static/data/schemas/pre_match_predictions.v1.schema.json');
const styles = await loadText('static/styles.css');

const errors = [];
const warnings = [];
let renderContract = null;
let scheduleOverlay = null;
let detailRefresh = null;
let matchCenterLogos = null;
let liveSnapshotRetention = null;

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
if (!schema.ok) errors.push(`shared prediction schema failed: ${schema.error || schema.status}`);
if (schema.ok && schema.data?.properties?.schema?.const !== 'lol_predictions_public_v1') {
  errors.push('shared prediction schema does not define lol_predictions_public_v1');
}
if (schema.ok && !Array.isArray(schema.data?.properties?.predictions?.items?.required)) {
  errors.push('shared prediction schema is missing predictions item required fields');
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
    detail = {
      ok: true,
      synthesized: true,
      data: synthesizeMatchDetail(target.match),
    };
    warnings.push(
      `match detail ${target.match.id} is not in static data; synthesized detail from match index for render contract`,
    );
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
    'function renderPredictionPanel(id, details)',
    'function applyPreMatchPredictionOverlay(matches)',
    'function parseScheduleDate(value)',
    'function matchDetailRefreshPolicy(details)',
    'function scheduleNextMatchDetailRefresh(details)',
    'function rememberLiveSnapshot(details)',
    'function restoreEndedLiveSnapshot(details)',
    'function matchDetailsFromCardDataset(match)',
    'function mergeCardTeamImages(cardDetails, details)',
    'function predictionPanelHtml(details, prediction)',
    'function predictionSideHtml(side, name, probability)',
    'function formatProbability(value)',
    'matchInfoPrediction',
    'predictionPanel',
    'predictionConfidence',
    'predictionPanelFoot',
    'byEventId',
    'byGameId',
    'confidence',
    'warnings',
  ];
  for (const snippet of requiredSnippets) {
    if (!appSource.text.includes(snippet)) {
      errors.push(`app.js is missing pre-match UI hook: ${snippet}`);
    }
  }
  if (!appSource.text.includes('PRE ')) {
    warnings.push('app.js does not include the PRE label used by prediction badges');
  }
  const renderCheck = checkPredictionPanelRendering(appSource.text, target?.prediction, target?.match, detail?.data);
  renderContract = renderCheck.summary;
  if (!renderCheck.ok) errors.push(...renderCheck.errors);
  warnings.push(...renderCheck.warnings);
  const overlayCheck = checkPredictionScheduleOverlay(appSource.text, predictions, matches, requestedMatchId);
  scheduleOverlay = overlayCheck.summary;
  if (!overlayCheck.ok) errors.push(...overlayCheck.errors);
  warnings.push(...overlayCheck.warnings);
  const refreshCheck = checkDetailRefreshPolicy(appSource.text);
  detailRefresh = refreshCheck.summary;
  if (!refreshCheck.ok) errors.push(...refreshCheck.errors);
  warnings.push(...refreshCheck.warnings);
  const logoCheck = checkMatchCenterLogos(appSource.text);
  matchCenterLogos = logoCheck.summary;
  if (!logoCheck.ok) errors.push(...logoCheck.errors);
  warnings.push(...logoCheck.warnings);
  const snapshotCheck = checkLiveSnapshotRetention(appSource.text);
  liveSnapshotRetention = snapshotCheck.summary;
  if (!snapshotCheck.ok) errors.push(...snapshotCheck.errors);
  warnings.push(...snapshotCheck.warnings);
}
if (!styles.ok) {
  errors.push(`styles source failed: ${styles.error || styles.status}`);
} else {
  for (const snippet of ['.predictionPanel', '.predictionSplit', '.predictionBar']) {
    if (!styles.text.includes(snippet)) {
      errors.push(`styles.css is missing prediction panel style: ${snippet}`);
    }
  }
}

const detailPage = await loadText('match/index.html');
if (!detailPage.ok) {
  errors.push(`match detail page failed: ${detailPage.error || detailPage.status}`);
} else if (!detailPage.text.includes('id="detailPredictionPanel"')) {
  errors.push('match detail page is missing #detailPredictionPanel');
}

const indexPage = await loadText('index.html');
if (!indexPage.ok) {
  errors.push(`index page failed: ${indexPage.error || indexPage.status}`);
} else if (!indexPage.text.includes('id="selectedPredictionPanel"')) {
  errors.push('index page is missing #selectedPredictionPanel');
}

const example = target ? summarizeExample(target, detail?.data) : null;
const report = {
  ok: errors.length === 0,
  mode: baseUrl ? 'remote' : 'local',
  base_url: baseUrl || null,
  docs_dir: baseUrl ? null : docsDir,
  checked_at: new Date().toISOString(),
  prediction_feed_path: predictionFeedPath,
  prediction_feed_url: predictionFeedUrl || null,
  prediction_feed_source: feed.source || '',
  feed_schema: feed.data?.schema || null,
  shared_schema_id: schema.data?.$id || null,
  prediction_rows: predictions.length,
  match_rows: matches.length,
  overlap_rows: overlap.length,
  detail_source: detail?.synthesized ? 'synthesized_from_match_index' : (detail ? 'static_detail' : null),
  example,
  render_contract: renderContract,
  schedule_overlay: scheduleOverlay,
  detail_refresh: detailRefresh,
  match_center_logos: matchCenterLogos,
  live_snapshot_retention: liveSnapshotRetention,
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
  const blue = nonPlaceholder(match.blue_code) || nonPlaceholder(match.blue_team) || nonPlaceholder(detailTeams[0]?.code) || prediction.blue_team || 'Blue';
  const red = nonPlaceholder(match.red_code) || nonPlaceholder(match.red_team) || nonPlaceholder(detailTeams[1]?.code) || prediction.red_team || 'Red';
  const blueProbability = Number(prediction.blue_win_probability || 0);
  const redProbability = Number(prediction.red_win_probability || 0);
  const favorite = favoriteLabel(blue, red, prediction);
  return {
    match_id: String(match.id || ''),
    league: match.league || prediction.league || '',
    list_label: `PRE ${favorite} ${formatPercent(Math.max(blueProbability, redProbability))}`,
    detail_label: `PRE ${blue} ${formatPercent(blueProbability)} / ${red} ${formatPercent(redProbability)}`,
    panel_summary: `${favorite} ${formatPercent(Math.max(blueProbability, redProbability))} | ${blue} ${formatPercent(blueProbability)} / ${red} ${formatPercent(redProbability)} | ${(prediction.confidence || 'unrated').toUpperCase()}`,
    model: prediction.model || '',
    warnings: Array.isArray(prediction.warnings) ? prediction.warnings.length : 0,
  };
}

function synthesizeMatchDetail(match) {
  return {
    id: String(match.id || match.event_id || ''),
    league: match.league || '',
    best_of: match.best_of || '',
    status: match.status || '',
    start_time: match.start_time || '',
    source: match.source || 'match_index',
    teams: [
      {
        name: match.blue_team || match.blue_code || 'Blue',
        code: match.blue_code || match.blue_team || 'Blue',
        image: match.blue_image || '',
        game_wins: match.blue_score || '',
      },
      {
        name: match.red_team || match.red_code || 'Red',
        code: match.red_code || match.red_team || 'Red',
        image: match.red_image || '',
        game_wins: match.red_score || '',
      },
    ],
    games: [],
  };
}

function favoriteLabel(blue, red, prediction) {
  return Number(prediction.blue_win_probability || 0) >= Number(prediction.red_win_probability || 0) ? blue : red;
}

function formatPercent(value) {
  const number = Number(value || 0);
  return `${(number * 100).toFixed(1)}%`;
}

function checkPredictionPanelRendering(appSourceText, prediction, match, detailData) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    summary: {
      checked: false,
      matching_prediction_visible: null,
      empty_feed_hidden: null,
      unavailable_feed_hidden: null,
    },
  };
  const elements = new Map();
  const context = {
    window: { STATIC_SITE: true },
    location: { href: 'http://example.test/', origin: 'http://example.test' },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  context.window.document = context.document;
  try {
    vm.createContext(context);
    vm.runInContext(appSourceText, context, { timeout: 1000 });
    output.summary.checked = true;
    const targetElement = fakeElement();
    elements.set('predictionPanelProbe', targetElement);
    vm.runInContext(`
      state.preMatchPredictions = normalizePreMatchPredictionFeed(${JSON.stringify({
        schema: 'lol_predictions_public_v1',
        generated_at: '2026-05-20T00:00:00Z',
        source: 'render_contract_probe',
        models: { pre_match: { name: 'render_contract_model', version: 'test', metrics: {} } },
        predictions: prediction ? [prediction] : [],
      })}, { source: 'probe', url: 'probe://predictions' });
      renderPredictionPanel('predictionPanelProbe', ${JSON.stringify(panelDetails(match, detailData))});
    `, context, { timeout: 1000 });
    if (prediction) {
      const text = targetElement.innerHTML.replace(/\s+/g, ' ');
      output.summary.matching_prediction_visible = !targetElement.classList.contains('hidden');
      if (targetElement.classList.contains('hidden')) output.errors.push('prediction panel render contract hid a matching prediction');
      for (const snippet of ['predictionPanelTop', 'predictionSplit', 'predictionBar', 'predictionConfidence']) {
        if (!text.includes(snippet)) output.errors.push(`prediction panel render contract missing ${snippet}`);
      }
      if (!text.includes(formatPercent(Math.max(Number(prediction.blue_win_probability || 0), Number(prediction.red_win_probability || 0))))) {
        output.errors.push('prediction panel render contract missing favorite probability');
      }
      if (prediction.confidence && !text.includes(String(prediction.confidence).toUpperCase())) {
        output.errors.push('prediction panel render contract missing confidence');
      }
    }
    vm.runInContext(`
      state.preMatchPredictions = normalizePreMatchPredictionFeed({
        schema: 'lol_predictions_public_v1',
        generated_at: '2026-05-20T00:00:00Z',
        source: 'empty_probe',
        predictions: []
      }, { source: 'probe', url: 'probe://empty' });
      renderPredictionPanel('predictionPanelProbe', ${JSON.stringify(panelDetails(match, detailData))});
    `, context, { timeout: 1000 });
    if (!targetElement.classList.contains('hidden') || targetElement.innerHTML) {
      output.errors.push('prediction panel render contract did not hide for an empty feed');
    }
    output.summary.empty_feed_hidden = targetElement.classList.contains('hidden') && !targetElement.innerHTML;
    vm.runInContext(`
      state.preMatchPredictions = { byEventId: {}, byGameId: {}, byMatchKey: {}, meta: {}, status: 'unavailable' };
      renderPredictionPanel('predictionPanelProbe', ${JSON.stringify(panelDetails(match, detailData))});
    `, context, { timeout: 1000 });
    if (!targetElement.classList.contains('hidden') || targetElement.innerHTML) {
      output.errors.push('prediction panel render contract did not hide for an unavailable feed');
    }
    output.summary.unavailable_feed_hidden = targetElement.classList.contains('hidden') && !targetElement.innerHTML;
  } catch (error) {
    output.errors.push(`prediction panel render contract failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  output.ok = output.errors.length === 0;
  return output;
}

function nonPlaceholder(value) {
  return isPlaceholderTeam(value) ? '' : String(value || '');
}

function checkPredictionScheduleOverlay(appSourceText, predictions, matches, matchId) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    summary: {
      checked: false,
      target_match_id: matchId || '',
      stale_static_match_corrected: null,
      prediction_start_time: '',
      overlaid_start_time: '',
      overlaid_blue_team: '',
      overlaid_red_team: '',
    },
  };
  const targetPrediction = matchId
    ? predictions.find((prediction) => [prediction.event_id, prediction.game_id].map(String).includes(matchId))
    : predictions.find((prediction) => matches.some((match) => String(match.id || match.event_id || '') === String(prediction.event_id || prediction.game_id || '')));
  if (!targetPrediction) {
    output.warnings.push('schedule overlay probe skipped because no target prediction was found');
    return output;
  }
  const targetId = String(targetPrediction.event_id || targetPrediction.game_id || '');
  output.summary.target_match_id = targetId;
  const elements = new Map();
  const context = {
    window: { STATIC_SITE: true },
    location: { href: 'http://example.test/', origin: 'http://example.test' },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  context.window.document = context.document;
  try {
    vm.createContext(context);
    vm.runInContext(appSourceText, context, { timeout: 1000 });
    output.summary.checked = true;
    const result = vm.runInContext(`
      state.preMatchPredictions = normalizePreMatchPredictionFeed({
        schema: 'lol_predictions_public_v1',
        generated_at: '2026-05-20T00:00:00Z',
        predictions: ${JSON.stringify(predictions)}
      }, { source: 'probe', url: 'probe://predictions' });
      applyPreMatchPredictionOverlay(${JSON.stringify(matches)}).find(match => String(match.id || match.event_id || '') === ${JSON.stringify(targetId)});
    `, context, { timeout: 1000 });
    const predictionStart = vm.runInContext(`normalizedPredictionTime(${JSON.stringify(targetPrediction.start_time || '')})`, context, { timeout: 1000 });
    output.summary.prediction_start_time = predictionStart;
    output.summary.overlaid_start_time = String(result?.start_time || '');
    output.summary.overlaid_blue_team = String(result?.blue_team || '');
    output.summary.overlaid_red_team = String(result?.red_team || '');
    if (!result) {
      output.errors.push(`schedule overlay did not return target match ${targetId}`);
    } else {
      output.summary.stale_static_match_corrected = String(result.start_time || '') === String(predictionStart || '')
        && !isPlaceholderTeam(result.blue_team)
        && !isPlaceholderTeam(result.red_team);
      if (String(result.start_time || '') !== String(predictionStart || '')) {
        output.errors.push(`schedule overlay start time ${result.start_time || '(missing)'} did not match prediction ${predictionStart || '(missing)'}`);
      }
      if (isPlaceholderTeam(result.blue_team) || isPlaceholderTeam(result.red_team)) {
        output.errors.push('schedule overlay left placeholder team names on a prediction-backed match');
      }
    }
  } catch (error) {
    output.errors.push(`schedule overlay probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  output.ok = output.errors.length === 0;
  return output;
}

function checkDetailRefreshPolicy(appSourceText) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    summary: {
      checked: false,
      completed_interval_ms: null,
      live_interval_ms: null,
      near_start_interval_ms: null,
      prestart_interval_ms: null,
      future_interval_ms: null,
      uses_timeout: appSourceText.includes('window.setTimeout(() => refreshMatchDetail(false)'),
      uses_fixed_interval: appSourceText.includes('window.setInterval(() => refreshMatchDetail(false)'),
    },
  };
  const context = {
    window: { STATIC_SITE: true },
    location: { href: 'http://example.test/', origin: 'http://example.test' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  context.window.document = context.document;
  const realNow = Date.now;
  try {
    vm.createContext(context);
    vm.runInContext(appSourceText, context, { timeout: 1000 });
    vm.runInContext('Date.now = () => 1769200000000', context, { timeout: 1000 });
    output.summary.checked = true;
    const policies = vm.runInContext(`
      ({
        completed: matchDetailRefreshPolicy({ status: 'completed', start_time: '2026-01-24T00:00:00Z' }),
        live: matchDetailRefreshPolicy({ status: 'inProgress', start_time: '2026-01-24T00:00:00Z' }),
        nearStart: matchDetailRefreshPolicy({ status: 'unstarted', start_time: new Date(Date.now() + 4 * 60 * 1000).toISOString() }),
        prestart: matchDetailRefreshPolicy({ status: 'unstarted', start_time: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
        future: matchDetailRefreshPolicy({ status: 'unstarted', start_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() })
      })
    `, context, { timeout: 1000 });
    output.summary.completed_interval_ms = policies.completed.interval_ms;
    output.summary.live_interval_ms = policies.live.interval_ms;
    output.summary.near_start_interval_ms = policies.nearStart.interval_ms;
    output.summary.prestart_interval_ms = policies.prestart.interval_ms;
    output.summary.future_interval_ms = policies.future.interval_ms;
    if (policies.completed.interval_ms !== 0) output.errors.push('completed match detail refresh should be off');
    if (policies.live.interval_ms !== 5000) output.errors.push('live match detail refresh should be 5s');
    if (policies.nearStart.interval_ms !== 15000) output.errors.push('near-start match detail refresh should be 15s');
    if (policies.prestart.interval_ms !== 60000) output.errors.push('prestart match detail refresh should be 60s');
    if (policies.future.interval_ms !== 300000) output.errors.push('future match detail refresh should be 5m');
    if (!output.summary.uses_timeout) output.errors.push('detail refresh should schedule with setTimeout');
    if (output.summary.uses_fixed_interval) output.errors.push('detail refresh still uses fixed setInterval');
  } catch (error) {
    output.errors.push(`detail refresh policy probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    Date.now = realNow;
  }
  output.ok = output.errors.length === 0;
  return output;
}

function checkMatchCenterLogos(appSourceText) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    summary: {
      checked: false,
      dataset_images_preserved: null,
      detail_merge_preserves_card_image: null,
      card_has_blue_image_data_attr: appSourceText.includes('data-blue-image='),
      card_has_red_image_data_attr: appSourceText.includes('data-red-image='),
    },
  };
  const context = {
    window: { STATIC_SITE: true },
    location: { href: 'http://example.test/', origin: 'http://example.test' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  context.window.document = context.document;
  try {
    vm.createContext(context);
    vm.runInContext(appSourceText, context, { timeout: 1000 });
    output.summary.checked = true;
    const result = vm.runInContext(`
      const cardDetails = matchDetailsFromCardDataset({
        id: 'match-1',
        blue: 'Team Blue',
        red: 'Team Red',
        blueCode: 'BLU',
        redCode: 'RED',
        blueImage: 'http://static.lolesports.com/blue.png',
        redImage: 'https://static.lolesports.com/red.png',
        league: 'LPL',
        bestof: '3',
        status: 'unstarted',
        start: '2026-05-23T06:00:00Z'
      });
      const merged = mergeCardTeamImages(cardDetails, {
        id: 'match-1',
        teams: [{ name: 'Team Blue', code: 'BLU' }, { name: 'Team Red', code: 'RED' }]
      });
      ({
        cardBlueImage: cardDetails.teams[0].image,
        cardRedImage: cardDetails.teams[1].image,
        mergedBlueImage: merged.teams[0].image,
        mergedRedImage: merged.teams[1].image
      })
    `, context, { timeout: 1000 });
    output.summary.dataset_images_preserved = result.cardBlueImage === 'https://static.lolesports.com/blue.png'
      && result.cardRedImage === 'https://static.lolesports.com/red.png';
    output.summary.detail_merge_preserves_card_image = result.mergedBlueImage === 'https://static.lolesports.com/blue.png'
      && result.mergedRedImage === 'https://static.lolesports.com/red.png';
    if (!output.summary.card_has_blue_image_data_attr || !output.summary.card_has_red_image_data_attr) {
      output.errors.push('match cards must expose team image data attributes for Match Center');
    }
    if (!output.summary.dataset_images_preserved) {
      output.errors.push('Match Center dataset details did not preserve normalized team image URLs');
    }
    if (!output.summary.detail_merge_preserves_card_image) {
      output.errors.push('Match Center detail merge did not preserve card team image URLs');
    }
  } catch (error) {
    output.errors.push(`match center logo probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  output.ok = output.errors.length === 0;
  return output;
}

function checkLiveSnapshotRetention(appSourceText) {
  const output = {
    ok: true,
    errors: [],
    warnings: [],
    summary: {
      checked: false,
      stores_meaningful_live_snapshot: null,
      restores_after_completed_empty_live: null,
      restored_champion: '',
      restored_status: '',
    },
  };
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    get length() { return storage.size; },
  };
  const context = {
    window: { STATIC_SITE: true, localStorage },
    location: { href: 'http://example.test/match/?id=match-1', origin: 'http://example.test' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    Intl,
    Date,
    URL,
    URLSearchParams,
  };
  context.window.document = context.document;
  try {
    vm.createContext(context);
    vm.runInContext(appSourceText, context, { timeout: 1000 });
    output.summary.checked = true;
    const result = vm.runInContext(`
      const liveDetails = {
        id: 'match-1',
        status: 'inProgress',
        games: [{
          id: 'game-1',
          number: 1,
          state: 'inProgress',
          blue: { team_code: 'BLU' },
          red: { team_code: 'RED' },
          live: {
            status: 'in_game',
            frame_timestamp: '2026-05-23T06:30:00Z',
            game_time: 1234,
            blue: [{ player: 'Blue Top', champion: 'Gnar', kills: 2, deaths: 1, assists: 3, gold: 7200, items: ['3078'] }],
            red: [{ player: 'Red Top', champion: 'Renekton', kills: 1, deaths: 2, assists: 2, gold: 6800, items: ['6631'] }],
            blue_stats: { gold: 30000, kills: 8 },
            red_stats: { gold: 28000, kills: 6 },
          },
        }],
      };
      rememberLiveSnapshot(liveDetails);
      const completedDetails = {
        id: 'match-1',
        status: 'completed',
        games: [{
          id: 'game-1',
          number: 1,
          state: 'completed',
          blue: { team_code: 'BLU' },
          red: { team_code: 'RED' },
          live: { status: 'ended', blue: [], red: [], blue_stats: {}, red_stats: {} },
        }],
      };
      const restored = restoreEndedLiveSnapshot(completedDetails);
      ({
        storedKeys: window.localStorage?.length || 0,
        restoredChampion: restored.games[0].live.blue[0]?.champion || '',
        restoredStatus: restored.games[0].live.status || '',
        retainedAfterEnd: restored.games[0].live.retained_after_end === true,
      })
    `, context, { timeout: 1000 });
    output.summary.stores_meaningful_live_snapshot = result.storedKeys === 1;
    output.summary.restores_after_completed_empty_live = result.restoredChampion === 'Gnar'
      && result.restoredStatus === 'ended'
      && result.retainedAfterEnd === true;
    output.summary.restored_champion = result.restoredChampion;
    output.summary.restored_status = result.restoredStatus;
    if (!output.summary.stores_meaningful_live_snapshot) {
      output.errors.push('live snapshot retention did not store meaningful live data');
    }
    if (!output.summary.restores_after_completed_empty_live) {
      output.errors.push('completed match with empty live data did not restore the last retained live snapshot');
    }
  } catch (error) {
    output.errors.push(`live snapshot retention probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  output.ok = output.errors.length === 0;
  return output;
}

function isPlaceholderTeam(value) {
  const text = String(value || '').trim().toLowerCase();
  return !text || text === 'tbd' || text === 'unknown';
}

function fakeElement() {
  const classes = new Set();
  return {
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: { setProperty: () => {} },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force === true) classes.add(name);
        else if (force === false) classes.delete(name);
        else if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      },
    },
    addEventListener: () => {},
  };
}

function panelDetails(match, detailData) {
  if (detailData?.id) return detailData;
  return {
    id: String(match?.id || ''),
    league: match?.league || '',
    start_time: match?.start_time || '',
    teams: [
      { name: match?.blue_team || '', code: match?.blue_code || match?.blue_team || '' },
      { name: match?.red_team || '', code: match?.red_code || match?.red_team || '' },
    ],
  };
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
  if (/^https?:\/\//i.test(relativePath)) {
    try {
      const response = await fetch(relativePath);
      return {
        ok: response.ok,
        status: response.status,
        source: relativePath,
        text: await response.text(),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        source: relativePath,
        text: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
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
