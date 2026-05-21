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
    'function renderPredictionPanel(id, details)',
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
  example,
  render_contract: renderContract,
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
