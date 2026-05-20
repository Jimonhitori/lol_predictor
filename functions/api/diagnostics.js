const LIVE_MODEL_PATH = '/static/data/live_model.json';
const PRE_MATCH_PREDICTIONS_PATH = '/pre_match_predictions.json';
const LIVE_STATUS_PATH = '/live_status.json';
const LIVE_MODEL_MANIFEST_PATH = '/live_model_manifest.json';
const SITE_CONTRACT_PATH = '/site-contract.json';
const DEFAULT_PRE_MATCH_PREDICTIONS_URL = 'https://jimonhitori.github.io/lol-pros-analyzer/pre_match_predictions.json';
const EXPECTED_SITE_CONTRACT_VERSION = '2026-05-20-live-pre-match-diagnostics-v1';
const REQUIRED_SITE_FEATURES = [
  'cloudflare_live_event_function',
  'cloudflare_diagnostics_function',
  'live_probability_contract',
  'pre_match_prediction_feed',
  'analyzer_public_artifact_diagnostics',
];

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
  const remotePredictionUrl = configuredUrl(context, 'PRE_MATCH_PREDICTIONS_URL', DEFAULT_PRE_MATCH_PREDICTIONS_URL);
  const liveStatusUrl = configuredUrl(context, 'LIVE_STATUS_URL', new URL(LIVE_STATUS_PATH, requestUrl.origin).toString());
  const liveManifestUrl = configuredUrl(context, 'LIVE_MODEL_MANIFEST_URL', new URL(LIVE_MODEL_MANIFEST_PATH, requestUrl.origin).toString());
  const [siteContract, liveModel, localPredictions, liveStatus, liveManifest] = await Promise.all([
    readJsonAsset(context, SITE_CONTRACT_PATH),
    readJsonAsset(context, LIVE_MODEL_PATH),
    readJsonAsset(context, PRE_MATCH_PREDICTIONS_PATH),
    readJsonUrl(liveStatusUrl),
    readJsonUrl(liveManifestUrl),
  ]);
  const remotePredictions = localPredictions.ok ? null : await readJsonUrl(remotePredictionUrl);
  const predictionFeed = localPredictions.ok ? localPredictions : remotePredictions;
  const predictionFeedUrl = localPredictions.ok
    ? new URL(PRE_MATCH_PREDICTIONS_PATH, requestUrl.origin).toString()
    : remotePredictionUrl;
  const siteFeatures = Array.isArray(siteContract.json?.features) ? siteContract.json.features : [];
  const missingSiteFeatures = REQUIRED_SITE_FEATURES.filter(feature => !siteFeatures.includes(feature));
  const contractWarnings = [
    ...(siteContract.json?.contract_version === EXPECTED_SITE_CONTRACT_VERSION ? [] : ['site_contract_version_mismatch']),
    ...(missingSiteFeatures.length ? [`site_contract_missing_features:${missingSiteFeatures.join(',')}`] : []),
    ...(liveModel.ok ? [] : [`live_model_${liveModel.status || 'missing'}`]),
    ...(siteContract.ok ? [] : [`site_contract_${siteContract.status || 'missing'}`]),
    ...(predictionFeed?.ok ? [] : [`prediction_feed_${predictionFeed?.status || 'missing'}`]),
    ...(liveStatus.ok ? [] : [`live_status_${liveStatus.status || 'missing'}`]),
    ...(liveManifest.ok ? [] : [`live_manifest_${liveManifest.status || 'missing'}`]),
    ...(predictionFeed?.json?.schema === 'lol_predictions_public_v1' ? [] : ['prediction_feed_schema_mismatch']),
    ...(liveStatus.json?.schema_version === '1.0' ? [] : ['live_status_schema_mismatch']),
    ...(liveManifest.json?.schema_version === 1 ? [] : ['live_manifest_schema_mismatch']),
  ];
  const payload = {
    ok: true,
    contract_ok: contractWarnings.length === 0,
    expected_site_contract_version: EXPECTED_SITE_CONTRACT_VERSION,
    cloudflare_timestamp: new Date().toISOString(),
    site_contract_available: siteContract.ok,
    site_contract_version: siteContract.json?.contract_version || '',
    site_contract_schema: siteContract.json?.schema || '',
    site_contract_features: siteFeatures,
    site_contract_missing_features: missingSiteFeatures,
    live_model_available: liveModel.ok,
    live_model_name: liveModel.json?.name || '',
    live_model_schema: liveModel.json?.schema || '',
    live_model_exported_at: liveModel.json?.exported_at || '',
    live_model_training_rows: liveModel.json?.training_rows ?? null,
    live_model_test_rows: liveModel.json?.test_rows ?? null,
    prediction_feed_url: predictionFeedUrl,
    prediction_feed_available: Boolean(predictionFeed?.ok),
    prediction_feed_source: localPredictions.ok ? 'local_asset' : 'remote',
    prediction_feed_last_fetch_status: predictionFeed?.status ?? 0,
    prediction_feed_generated_at: predictionFeed?.json?.generated_at || '',
    prediction_feed_schema: predictionFeed?.json?.schema || '',
    prediction_feed_rows: Array.isArray(predictionFeed?.json?.predictions) ? predictionFeed.json.predictions.length : 0,
    live_status_url: liveStatusUrl,
    live_status_available: Boolean(liveStatus.ok),
    live_status_last_fetch_status: liveStatus.status,
    live_status_generated_at: liveStatus.json?.generated_at || '',
    live_status_display_ready: liveStatus.json?.display_ready ?? null,
    live_status_production_ready: liveStatus.json?.production_ready ?? null,
    live_status_stage: liveStatus.json?.stage || '',
    live_status_blocker_count: liveStatus.json?.blocker_count ?? null,
    live_status_warning_count: liveStatus.json?.warning_count ?? null,
    live_worker_ok: liveStatus.json?.worker?.ok ?? null,
    live_worker_checked: liveStatus.json?.worker?.checked ?? null,
    analyzer_live_manifest_url: liveManifestUrl,
    analyzer_live_manifest_available: Boolean(liveManifest.ok),
    analyzer_live_manifest_last_fetch_status: liveManifest.status,
    analyzer_live_model_available: liveManifest.json?.live_model_available ?? null,
    analyzer_oe_bootstrap_available: liveManifest.json?.oe_live_bootstrap?.available ?? null,
    warnings: contractWarnings,
  };
  return jsonResponse(payload);
}

function configuredUrl(context, key, fallback) {
  const value = context?.env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function readJsonAsset(context, path) {
  try {
    let response = null;
    if (context?.env?.ASSETS) {
      const requestUrl = new URL(context.request.url);
      response = await context.env.ASSETS.fetch(new Request(new URL(path, requestUrl.origin).toString()));
    } else if (context?.request?.url) {
      response = await fetch(new URL(path, context.request.url).toString());
    }
    if (!response || !response.ok) return { ok: false, status: response?.status || 0, json: null };
    return { ok: true, status: response.status, json: await response.json() };
  } catch (error) {
    return { ok: false, status: 'error', json: null };
  }
}

async function readJsonUrl(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: 60 },
    });
    if (!response.ok) return { ok: false, status: response.status, json: null };
    return { ok: true, status: response.status, json: await response.json() };
  } catch (error) {
    return { ok: false, status: 'error', json: null };
  }
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
