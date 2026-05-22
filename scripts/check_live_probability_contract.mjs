#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const args = parseArgs(process.argv.slice(2));
const docsDir = path.resolve(String(args.docsDir || 'docs'));
const samplePath = path.resolve(String(args.sample || path.join(docsDir, 'static/data/examples/live_event_contract.sample.json')));
const modelPath = path.resolve(String(args.model || path.join(docsDir, 'static/data/live_model.json')));
const appPath = path.resolve(String(args.app || path.join(docsDir, 'static/app.js')));
const functionPath = path.resolve(String(args.functionSource || 'functions/api/live-event.js'));
const baseUrl = args.baseUrl || args.base ? String(args.baseUrl || args.base).replace(/\/+$/, '') : '';
const eventId = args.eventId || args.id ? String(args.eventId || args.id) : '';
const requireRemoteLiveWinProbability = booleanArg(args.requireLiveWinProbability);

const [sample, model, appSource, functionSource, remote] = await Promise.all([
  readJson(samplePath),
  readJson(modelPath),
  readText(appPath),
  readText(functionPath),
  baseUrl && eventId ? fetchJson(`${baseUrl}/api/live-event?id=${encodeURIComponent(eventId)}`) : Promise.resolve(null),
]);

const errors = [];
const warnings = [];

const sampleSummary = validatePayload(sample.data, {
  label: 'sample',
  requireWinProbability: true,
  requireEstimated: true,
  errors,
  warnings,
});
const modelSummary = validateModel(model.data, errors);
const appSummary = validateSourceHooks('app.js', appSource, [
  'function liveWinProbabilityText(game, live)',
  'live.win_probability?.validation?.display',
  'liveRefreshMeta',
], errors);
appSummary.render_contract = checkLiveProbabilityRendering(appSource, sample.data, errors);
const functionSummary = validateSourceHooks('live-event.js', functionSource, [
  'function liveValidationBucket(model, gameTime)',
  'validation: liveValidationBucket(model, row.game_time)',
  'function applyEstimatedGameTime(live)',
  'estimated_game_time',
  'game_time_estimated',
], errors);

let remoteSummary = null;
if (remote) {
  remoteSummary = validatePayload(remote.data, {
    label: 'remote',
    requireWinProbability: requireRemoteLiveWinProbability,
    requireEstimated: requireRemoteLiveWinProbability,
    errors,
    warnings,
  });
  remoteSummary.url = remote.source;
  remoteSummary.status = remote.status;
  remoteSummary.ok_response = remote.ok;
  if (!remote.ok) errors.push(`remote live-event failed: ${remote.status}`);
} else if (baseUrl || eventId) {
  warnings.push('remote live-event check skipped because both --base-url and --event-id are required');
}

const report = {
  ok: errors.length === 0,
  checked_at: new Date().toISOString(),
  sample: sampleSummary,
  model: modelSummary,
  app: appSummary,
  function: functionSummary,
  remote: remoteSummary,
  warnings,
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function validatePayload(payload, options) {
  const { label, requireWinProbability, requireEstimated, errors: outputErrors, warnings: outputWarnings } = options;
  const games = Array.isArray(payload?.games) ? payload.games : [];
  const liveRecords = games
    .map((game) => ({ game, live: game?.live || {}, winProbability: game?.live?.win_probability }))
    .filter((record) => record.winProbability);

  const summary = {
    is_json_object: Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)),
    source: payload?.source || '',
    status: payload?.status || '',
    warning: payload?.warning || '',
    game_count: games.length,
    win_probability_count: liveRecords.length,
    win_probability_models: [...new Set(liveRecords.map((record) => String(record.winProbability?.model || '')).filter(Boolean))],
    validation_displays: [...new Set(liveRecords.map((record) => String(record.winProbability?.validation?.display || '')).filter(Boolean))],
    estimated_game_time_seen: liveRecords.some((record) => Object.prototype.hasOwnProperty.call(record.live, 'estimated_game_time')),
  };

  if (!summary.is_json_object) outputErrors.push(`${label} live-event payload is not a JSON object`);
  if (payload?.source && payload.source !== 'cloudflare_live_event') {
    outputWarnings.push(`${label} live-event source is ${payload.source}`);
  }
  if (!Array.isArray(payload?.games)) outputErrors.push(`${label} live-event payload is missing games[]`);
  if (requireWinProbability && !liveRecords.length) {
    outputErrors.push(`${label} live-event payload has no live.win_probability`);
  }
  for (const [index, record] of liveRecords.entries()) {
    const prefix = `${label} live.win_probability[${index}]`;
    validateWinProbability(record.winProbability, prefix, outputErrors);
    if (requireEstimated && record.winProbability.status !== 'estimated') {
      outputErrors.push(`${prefix} status is not estimated`);
    }
    if (record.live.estimated_game_time !== undefined && typeof record.live.estimated_game_time !== 'boolean') {
      outputErrors.push(`${label} live.estimated_game_time must be boolean when present`);
    }
    if (record.live.warning !== undefined && typeof record.live.warning !== 'string') {
      outputErrors.push(`${label} live.warning must be a string when present`);
    }
  }
  return summary;
}

function validateWinProbability(value, prefix, outputErrors) {
  const blue = Number(value?.blue);
  const red = Number(value?.red);
  if (!Number.isFinite(blue) || blue < 0 || blue > 1) outputErrors.push(`${prefix}.blue must be 0..1`);
  if (!Number.isFinite(red) || red < 0 || red > 1) outputErrors.push(`${prefix}.red must be 0..1`);
  if (Number.isFinite(blue) && Number.isFinite(red) && Math.abs((blue + red) - 1) > 0.01) {
    outputErrors.push(`${prefix} blue+red must be close to 1`);
  }
  if (!String(value?.model || '').trim()) outputErrors.push(`${prefix}.model is required`);
  if (!String(value?.status || '').trim()) outputErrors.push(`${prefix}.status is required`);
  if (value?.status === 'estimated') {
    if (!String(value?.feature_schema || '').trim()) outputErrors.push(`${prefix}.feature_schema is required for estimated output`);
    if (!String(value?.validation?.display || '').trim()) outputErrors.push(`${prefix}.validation.display is required for estimated output`);
    if (!['show_live_probability', 'use_with_caution', 'hide_live_probability'].includes(String(value?.validation?.display || ''))) {
      outputErrors.push(`${prefix}.validation.display has an unknown value`);
    }
  }
}

function validateModel(modelData, outputErrors) {
  const guidance = modelData?.serving_guidance || {};
  const buckets = Array.isArray(guidance.time_buckets) ? guidance.time_buckets : [];
  const displays = [...new Set(buckets.map((bucket) => String(bucket.display || '')).filter(Boolean))];
  const summary = {
    schema: modelData?.schema || '',
    name: modelData?.name || '',
    feature_schema: modelData?.feature_schema || '',
    training_rows: modelData?.training_rows ?? null,
    test_rows: modelData?.test_rows ?? null,
    default_display: guidance.default_display || '',
    time_bucket_count: buckets.length,
    displays,
  };
  if (modelData?.schema !== 'live_logistic_regression_v1') outputErrors.push('live model schema is not live_logistic_regression_v1');
  if (modelData?.name !== 'live_lck_logreg_deep20_regularized_v1') outputErrors.push('live model name changed unexpectedly');
  if (modelData?.feature_schema !== 'live_frame_v1') outputErrors.push('live model feature_schema is not live_frame_v1');
  if (!buckets.length) outputErrors.push('live model serving_guidance.time_buckets is empty');
  if (!guidance.default_display) outputErrors.push('live model serving_guidance.default_display is missing');
  for (const [index, bucket] of buckets.entries()) {
    if (!String(bucket.display || '').trim()) outputErrors.push(`live model time_buckets[${index}].display is missing`);
    if (!Number.isFinite(Number(bucket.start_seconds)) || !Number.isFinite(Number(bucket.end_seconds))) {
      outputErrors.push(`live model time_buckets[${index}] has invalid time bounds`);
    }
  }
  return summary;
}

function validateSourceHooks(label, source, snippets, outputErrors) {
  const summary = {
    loaded: source.ok,
    missing: [],
  };
  if (!source.ok) {
    outputErrors.push(`${label} failed to load: ${source.error || source.status}`);
    return summary;
  }
  for (const snippet of snippets) {
    if (!source.text.includes(snippet)) summary.missing.push(snippet);
  }
  for (const snippet of summary.missing) {
    outputErrors.push(`${label} is missing contract hook: ${snippet}`);
  }
  return summary;
}

function checkLiveProbabilityRendering(source, sampleData, outputErrors) {
  const summary = {
    checked: false,
    estimated_visible: null,
    non_estimated_hidden: null,
    caution_hidden: null,
  };
  if (!source.ok) return summary;
  const game = (sampleData?.games || [])[0] || {};
  const live = game.live || {};
  const context = {
    window: { STATIC_SITE: true },
    location: { href: 'http://example.test/', origin: 'http://example.test', search: '' },
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
    vm.runInContext(source.text, context, { timeout: 1000 });
    summary.checked = true;
    const estimatedText = vm.runInContext(
      `liveWinProbabilityText(${JSON.stringify(game)}, ${JSON.stringify(live)})`,
      context,
      { timeout: 1000 },
    );
    summary.estimated_visible = typeof estimatedText === 'string'
      && estimatedText.includes('%')
      && estimatedText.includes(game?.blue?.team_code || game?.blue?.team_name || 'Blue')
      && estimatedText.includes(game?.red?.team_code || game?.red?.team_name || 'Red');
    if (!summary.estimated_visible) {
      outputErrors.push('app.js live probability render contract did not show estimated probability text');
    }

    const nonEstimatedLive = {
      ...live,
      win_probability: { ...(live.win_probability || {}), status: 'unavailable' },
    };
    const nonEstimatedText = vm.runInContext(
      `liveWinProbabilityText(${JSON.stringify(game)}, ${JSON.stringify(nonEstimatedLive)})`,
      context,
      { timeout: 1000 },
    );
    summary.non_estimated_hidden = nonEstimatedText === '';
    if (!summary.non_estimated_hidden) {
      outputErrors.push('app.js live probability render contract did not hide non-estimated probability');
    }

    const cautionLive = {
      ...live,
      win_probability: {
        ...(live.win_probability || {}),
        status: 'estimated',
        validation: { ...(live.win_probability?.validation || {}), display: 'use_with_caution' },
      },
    };
    const cautionText = vm.runInContext(
      `liveWinProbabilityText(${JSON.stringify(game)}, ${JSON.stringify(cautionLive)})`,
      context,
      { timeout: 1000 },
    );
    summary.caution_hidden = typeof cautionText === 'string' && !cautionText.includes('caution');
    if (!summary.caution_hidden) {
      outputErrors.push('app.js live probability render contract should not show caution marker in probability text');
    }
  } catch (error) {
    outputErrors.push(`app.js live probability render contract failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return summary;
}

async function readJson(filePath) {
  const text = await readText(filePath);
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

async function readText(filePath) {
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

async function fetchJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      source: url,
      text,
      data: JSON.parse(text),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      source: url,
      text: '',
      data: null,
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

function booleanArg(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
