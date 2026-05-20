#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://lol-predictor.pages.dev';
const DEFAULT_EVENT_ID = 'test';
const DEFAULT_PRE_MATCH_PREDICTIONS_URL = 'https://jimonhitori.github.io/lol-pros-analyzer/pre_match_predictions.json';
const DEFAULT_LIVE_STATUS_URL = 'https://jimonhitori.github.io/lol-pros-analyzer/live_status.json';
const DEFAULT_LIVE_MODEL_MANIFEST_URL = 'https://jimonhitori.github.io/lol-pros-analyzer/live_model_manifest.json';

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || args.base || DEFAULT_BASE_URL).replace(/\/+$/, '');
const eventId = String(args.eventId || args.id || DEFAULT_EVENT_ID);
const predictionFeedUrl = String(args.predictionFeedUrl || DEFAULT_PRE_MATCH_PREDICTIONS_URL);
const liveStatusUrl = String(args.liveStatusUrl || DEFAULT_LIVE_STATUS_URL);
const liveManifestUrl = String(args.liveManifestUrl || DEFAULT_LIVE_MODEL_MANIFEST_URL);
const requireLiveWinProbability = booleanArg(args.requireLiveWinProbability);
const expectedContractVersion = args.expectedContractVersion
  ? String(args.expectedContractVersion)
  : '2026-05-20-live-pre-match-diagnostics-v1';

const siteContract = await fetchEndpoint(`${baseUrl}/site-contract.json`);
const diagnostics = await fetchEndpoint(`${baseUrl}/api/diagnostics`);
const liveEvent = await fetchEndpoint(`${baseUrl}/api/live-event?id=${encodeURIComponent(eventId)}`);
const predictionFeed = await fetchEndpoint(predictionFeedUrl);
const liveStatus = await fetchEndpoint(liveStatusUrl);
const liveManifest = await fetchEndpoint(liveManifestUrl);

const report = {
  ok: true,
  base_url: baseUrl,
  checked_at: new Date().toISOString(),
  expected_contract_version: expectedContractVersion,
  site_contract: summarizeSiteContract(siteContract),
  diagnostics: summarizeDiagnostics(diagnostics),
  live_event: summarizeLiveEvent(liveEvent),
  analyzer_artifacts: {
    prediction_feed: summarizePublicJson(predictionFeed),
    live_status: summarizePublicJson(liveStatus),
    live_manifest: summarizePublicJson(liveManifest),
  },
  errors: [],
  warnings: [],
};

const requiredSiteFeatures = [
  'cloudflare_live_event_function',
  'cloudflare_diagnostics_function',
  'live_probability_contract',
  'pre_match_prediction_feed',
  'analyzer_public_artifact_diagnostics',
];

if (!report.site_contract.is_json) {
  report.ok = false;
  report.errors.push('site-contract.json did not return JSON; deployed static site may be old');
}
if (report.site_contract.is_json && report.site_contract.contract_version !== expectedContractVersion) {
  report.ok = false;
  report.errors.push(`site contract version mismatch: expected ${expectedContractVersion}`);
}
if (report.site_contract.is_json) {
  for (const feature of requiredSiteFeatures) {
    if (!report.site_contract.features.includes(feature)) {
      report.ok = false;
      report.errors.push(`site contract is missing feature: ${feature}`);
    }
  }
}
if (!report.diagnostics.is_json) {
  report.ok = false;
  report.errors.push('diagnostics endpoint did not return JSON; Pages Function may not be deployed');
}
if (report.diagnostics.is_json && report.diagnostics.ok !== true) {
  report.ok = false;
  report.errors.push('diagnostics JSON did not report ok=true');
}
if (report.diagnostics.is_json && report.diagnostics.contract_ok !== true) {
  report.ok = false;
  report.errors.push('diagnostics JSON did not report contract_ok=true');
}
if (report.diagnostics.is_json && report.diagnostics.live_model_available !== true) {
  report.ok = false;
  report.errors.push('diagnostics did not report live_model_available=true');
}
if (report.diagnostics.is_json && report.diagnostics.prediction_feed_available !== true) {
  report.ok = false;
  report.errors.push('diagnostics did not report prediction_feed_available=true');
}
if (report.diagnostics.is_json && report.diagnostics.live_status_available !== true) {
  report.ok = false;
  report.errors.push('diagnostics did not report live_status_available=true');
}
if (report.diagnostics.is_json && report.diagnostics.analyzer_live_manifest_available !== true) {
  report.ok = false;
  report.errors.push('diagnostics did not report analyzer_live_manifest_available=true');
}
if (
  report.diagnostics.is_json
  && report.diagnostics.site_contract_version
  && report.diagnostics.site_contract_version !== expectedContractVersion
) {
  report.ok = false;
  report.errors.push(`diagnostics site contract version mismatch: expected ${expectedContractVersion}`);
}
if (!report.live_event.is_json) {
  report.ok = false;
  report.errors.push('live-event endpoint did not return JSON');
}
if (report.live_event.is_json && !report.live_event.has_games_key) {
  report.ok = false;
  report.errors.push('live-event JSON is missing games');
}
if (report.live_event.is_json && requireLiveWinProbability && !report.live_event.has_win_probability_contract) {
  report.ok = false;
  report.errors.push('live-event did not include live.win_probability for the probed event');
}
if (report.live_event.is_json && report.live_event.has_win_probability_contract && !report.live_event.win_probability_valid) {
  report.ok = false;
  report.errors.push('live-event live.win_probability contract is invalid');
}
if (report.live_event.is_json && report.live_event.source !== 'cloudflare_live_event') {
  report.warnings.push('live-event source is not cloudflare_live_event');
}
if (!report.analyzer_artifacts.prediction_feed.is_json) {
  report.ok = false;
  report.errors.push('analyzer pre-match prediction feed did not return JSON');
}
if (
  report.analyzer_artifacts.prediction_feed.is_json
  && report.analyzer_artifacts.prediction_feed.schema !== 'lol_predictions_public_v1'
) {
  report.ok = false;
  report.errors.push('analyzer pre-match prediction feed schema is not lol_predictions_public_v1');
}
if (!report.analyzer_artifacts.live_status.is_json) {
  report.ok = false;
  report.errors.push('analyzer live_status artifact did not return JSON');
}
if (report.analyzer_artifacts.live_status.is_json && report.analyzer_artifacts.live_status.schema !== '1.0') {
  report.ok = false;
  report.errors.push('analyzer live_status schema is not 1.0');
}
if (!report.analyzer_artifacts.live_manifest.is_json) {
  report.ok = false;
  report.errors.push('analyzer live_model_manifest artifact did not return JSON');
}
if (report.analyzer_artifacts.live_manifest.is_json && report.analyzer_artifacts.live_manifest.schema !== 1) {
  report.ok = false;
  report.errors.push('analyzer live_model_manifest schema_version is not 1');
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function fetchEndpoint(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    return {
      url,
      ok: response.ok,
      status: response.status,
      content_type: contentType,
      text,
      json: parseJson(text, contentType),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      content_type: '',
      text: '',
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeDiagnostics(result) {
  return {
    url: result.url,
    status: result.status,
    content_type: result.content_type,
    is_json: Boolean(result.json),
    ok: result.json?.ok ?? false,
    contract_ok: result.json?.contract_ok ?? null,
    site_contract_available: result.json?.site_contract_available ?? null,
    site_contract_version: result.json?.site_contract_version || '',
    live_model_available: result.json?.live_model_available ?? null,
    live_model_name: result.json?.live_model_name || '',
    prediction_feed_url: result.json?.prediction_feed_url || '',
    prediction_feed_available: result.json?.prediction_feed_available ?? null,
    prediction_feed_schema: result.json?.prediction_feed_schema || '',
    prediction_feed_rows: result.json?.prediction_feed_rows ?? null,
    live_status_url: result.json?.live_status_url || '',
    live_status_available: result.json?.live_status_available ?? null,
    live_status_stage: result.json?.live_status_stage || '',
    analyzer_live_manifest_url: result.json?.analyzer_live_manifest_url || '',
    analyzer_live_manifest_available: result.json?.analyzer_live_manifest_available ?? null,
    warnings: Array.isArray(result.json?.warnings) ? result.json.warnings : [],
    error: result.error || '',
    body_preview: result.json ? '' : result.text.slice(0, 120),
  };
}

function summarizeSiteContract(result) {
  return {
    url: result.url,
    status: result.status,
    content_type: result.content_type,
    is_json: Boolean(result.json),
    schema: result.json?.schema || '',
    contract_version: result.json?.contract_version || '',
    features: Array.isArray(result.json?.features) ? result.json.features : [],
    error: result.error || '',
    body_preview: result.json ? '' : result.text.slice(0, 120),
  };
}

function summarizeLiveEvent(result) {
  const liveRecord = firstLiveRecordWithWinProbability(result.json);
  const winProbability = liveRecord?.winProbability;
  return {
    url: result.url,
    status: result.status,
    content_type: result.content_type,
    is_json: Boolean(result.json),
    source: result.json?.source || '',
    warning: result.json?.warning || '',
    has_games_key: Boolean(result.json && Object.prototype.hasOwnProperty.call(result.json, 'games')),
    game_count: Array.isArray(result.json?.games) ? result.json.games.length : 0,
    has_win_probability_contract: Boolean(winProbability),
    win_probability_valid: winProbability ? validWinProbability(winProbability) : null,
    win_probability_blue: numericOrNull(winProbability?.blue),
    win_probability_red: numericOrNull(winProbability?.red),
    win_probability_status: winProbability?.status || '',
    win_probability_model: winProbability?.model || '',
    win_probability_validation_display: winProbability?.validation?.display || '',
    estimated_game_time: liveRecord?.live?.estimated_game_time ?? false,
    live_warning: liveRecord?.live?.warning || '',
    error: result.error || '',
    body_preview: result.json ? '' : result.text.slice(0, 120),
  };
}

function summarizePublicJson(result) {
  return {
    url: result.url,
    status: result.status,
    content_type: result.content_type,
    is_json: Boolean(result.json),
    schema: result.json?.schema || result.json?.schema_version || '',
    generated_at: result.json?.generated_at || '',
    row_count: Array.isArray(result.json?.predictions) ? result.json.predictions.length : null,
    ok: result.ok,
    error: result.error || '',
    body_preview: result.json ? '' : result.text.slice(0, 120),
  };
}

function firstLiveRecordWithWinProbability(payload) {
  const games = Array.isArray(payload?.games) ? payload.games : [];
  for (const game of games) {
    if (game?.live?.win_probability) {
      return {
        live: game.live,
        winProbability: game.live.win_probability,
      };
    }
  }
  return null;
}

function validWinProbability(value) {
  const blue = Number(value?.blue);
  const red = Number(value?.red);
  if (!Number.isFinite(blue) || !Number.isFinite(red)) return false;
  if (blue < 0 || blue > 1 || red < 0 || red > 1) return false;
  if (Math.abs((blue + red) - 1) > 0.01) return false;
  if (!String(value?.model || '').trim()) return false;
  if (!String(value?.status || '').trim()) return false;
  return true;
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(text, contentType) {
  if (!contentType.includes('application/json')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
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
