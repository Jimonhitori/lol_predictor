const LIVE_MODEL_PATH = '/static/data/live_model.json';
const LIVE_LOGISTIC_MODEL_PATH = '/live_logistic.json';
const LIVE_BOOTSTRAP_MODEL_PATH = '/live_logistic_oe_bootstrap.json';
const PRE_MATCH_PREDICTIONS_PATH = '/pre_match_predictions.json';
const PRE_MATCH_SCHEMA_PATH = '/static/data/schemas/pre_match_predictions.v1.schema.json';
const MATCHES_INDEX_PATH = '/static/data/matches-all__all.json';
const LIVE_STATUS_PATH = '/live_status.json';
const LIVE_MODEL_MANIFEST_PATH = '/live_model_manifest.json';
const SITE_CONTRACT_PATH = '/site-contract.json';
const EXPECTED_SITE_CONTRACT_VERSION = '2026-05-20-live-pre-match-diagnostics-v1';
const STALE_SECONDS = 48 * 60 * 60;
const WARNING_SECONDS = 24 * 60 * 60;
const LIVE_MODEL_STALE_SECONDS = 14 * 24 * 60 * 60;
const LIVE_MODEL_WARNING_SECONDS = 7 * 24 * 60 * 60;
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
  const localPredictionUrl = new URL(PRE_MATCH_PREDICTIONS_PATH, requestUrl.origin).toString();
  const localSchemaUrl = new URL(PRE_MATCH_SCHEMA_PATH, requestUrl.origin).toString();
  const localLiveStatusUrl = new URL(LIVE_STATUS_PATH, requestUrl.origin).toString();
  const localLiveManifestUrl = new URL(LIVE_MODEL_MANIFEST_PATH, requestUrl.origin).toString();
  const remotePredictionUrl = configuredUrl(context, 'PRE_MATCH_PREDICTIONS_URL', localPredictionUrl);
  const remoteSchemaUrl = configuredUrl(context, 'PRE_MATCH_SCHEMA_URL', localSchemaUrl);
  const liveStatusUrl = configuredUrl(context, 'LIVE_STATUS_URL', localLiveStatusUrl);
  const liveManifestUrl = configuredUrl(context, 'LIVE_MODEL_MANIFEST_URL', localLiveManifestUrl);
  const shouldCheckRemotePredictions = remotePredictionUrl !== localPredictionUrl;
  const shouldCheckRemoteSchema = remoteSchemaUrl !== localSchemaUrl;
  const liveStatusReader = liveStatusUrl === localLiveStatusUrl ? readJsonAsset(context, LIVE_STATUS_PATH) : readJsonUrl(liveStatusUrl);
  const liveManifestReader = liveManifestUrl === localLiveManifestUrl
    ? readJsonAsset(context, LIVE_MODEL_MANIFEST_PATH)
    : readJsonUrl(liveManifestUrl);
  const [
    siteContract,
    liveModel,
    liveLogisticModel,
    liveBootstrapModel,
    localPredictions,
    localSchema,
    matchIndex,
    liveStatus,
    liveManifest,
    remotePredictionProbe,
    remoteSchemaProbe,
  ] = await Promise.all([
    readJsonAsset(context, SITE_CONTRACT_PATH),
    readJsonAsset(context, LIVE_MODEL_PATH),
    readJsonAsset(context, LIVE_LOGISTIC_MODEL_PATH),
    readJsonAsset(context, LIVE_BOOTSTRAP_MODEL_PATH),
    readJsonAsset(context, PRE_MATCH_PREDICTIONS_PATH),
    readJsonAsset(context, PRE_MATCH_SCHEMA_PATH),
    readJsonAsset(context, MATCHES_INDEX_PATH),
    liveStatusReader,
    liveManifestReader,
    shouldCheckRemotePredictions ? readJsonUrl(remotePredictionUrl) : Promise.resolve(null),
    shouldCheckRemoteSchema ? readJsonUrl(remoteSchemaUrl) : Promise.resolve(null),
  ]);
  const remotePredictions = localPredictions.ok ? null : remotePredictionProbe || await readJsonUrl(remotePredictionUrl);
  const predictionFeed = localPredictions.ok ? localPredictions : remotePredictions;
  const remoteSchema = localSchema.ok ? null : remoteSchemaProbe || await readJsonUrl(remoteSchemaUrl);
  const predictionSchema = localSchema.ok ? localSchema : remoteSchema;
  const predictionFeedUrl = localPredictions.ok
    ? localPredictionUrl
    : remotePredictionUrl;
  const predictionSchemaUrl = localSchema.ok
    ? localSchemaUrl
    : remoteSchemaUrl;
  const siteFeatures = Array.isArray(siteContract.json?.features) ? siteContract.json.features : [];
  const missingSiteFeatures = REQUIRED_SITE_FEATURES.filter(feature => !siteFeatures.includes(feature));
  const predictionFeedFreshness = artifactFreshness(predictionFeed?.json?.generated_at);
  const remotePredictionFreshness = artifactFreshness(remotePredictionProbe?.json?.generated_at);
  const liveStatusFreshness = artifactFreshness(liveStatus.json?.generated_at);
  const activeLiveModel = selectActiveLiveModel(liveLogisticModel, liveBootstrapModel, liveModel);
  const liveModelFreshness = artifactFreshness(
    activeLiveModel.exportedAt,
    { staleSeconds: LIVE_MODEL_STALE_SECONDS, warningSeconds: LIVE_MODEL_WARNING_SECONDS },
  );
  const predictionSchemaOk = predictionSchema?.json?.properties?.schema?.const === 'lol_predictions_public_v1';
  const remotePredictionSchemaOk = remotePredictionProbe?.json?.schema === 'lol_predictions_public_v1';
  const remoteSchemaOk = remoteSchemaProbe?.json?.properties?.schema?.const === 'lol_predictions_public_v1';
  const predictionSchemaHasTopLevelWarnings = predictionSchema?.json?.properties?.warnings?.type === 'array';
  const remoteSchemaHasTopLevelWarnings = remoteSchemaProbe?.json?.properties?.warnings?.type === 'array';
  const predictionFeedWarnings = predictionArtifactWarnings(predictionFeed?.json);
  const remotePredictionFeedWarnings = predictionArtifactWarnings(remotePredictionProbe?.json);
  const blockingPredictionFeedWarnings = predictionFeedWarnings.filter(isBlockingPredictionArtifactWarning);
  const blockingRemotePredictionFeedWarnings = remotePredictionFeedWarnings.filter(isBlockingPredictionArtifactWarning);
  const predictionRows = Array.isArray(predictionFeed?.json?.predictions) ? predictionFeed.json.predictions : [];
  const matchRows = extractMatchRows(matchIndex?.json);
  const predictionMatchOverlap = predictionRows.length && matchRows.length
    ? predictionMatchOverlapStats(predictionRows, matchRows)
    : { overlap: 0, missing: predictionRows.length };
  const artifactWarnings = [
    ...(predictionFeedFreshness.status === 'stale' ? ['prediction_feed_stale'] : []),
    ...(blockingPredictionFeedWarnings.length ? ['prediction_feed_has_warnings'] : []),
    ...(matchIndex.ok && predictionRows.length > 0 && predictionMatchOverlap.overlap === 0 ? ['prediction_match_overlap_zero'] : []),
    ...(remotePredictionProbe && !remotePredictionProbe.ok ? [`remote_prediction_feed_${remotePredictionProbe.status || 'missing'}`] : []),
    ...(remotePredictionProbe?.ok && !remotePredictionSchemaOk ? ['remote_prediction_feed_schema_mismatch'] : []),
    ...(blockingRemotePredictionFeedWarnings.length ? ['remote_prediction_feed_has_warnings'] : []),
    ...(remotePredictionFreshness.status === 'stale' ? ['remote_prediction_feed_stale'] : []),
    ...(remoteSchemaProbe && !remoteSchemaProbe.ok ? [`remote_prediction_schema_${remoteSchemaProbe.status || 'missing'}`] : []),
    ...(remoteSchemaProbe?.ok && !remoteSchemaOk ? ['remote_prediction_schema_mismatch'] : []),
    ...(remoteSchemaProbe?.ok && !remoteSchemaHasTopLevelWarnings ? ['remote_prediction_schema_missing_top_level_warnings'] : []),
    ...(liveStatusFreshness.status === 'stale' ? ['live_status_stale'] : []),
    ...(liveStatus.ok && liveStatus.json?.display_ready === false ? ['live_status_display_not_ready'] : []),
    ...(liveStatus.ok && liveStatus.json?.production_ready === false ? ['live_status_production_not_ready'] : []),
    ...(Number(liveStatus.json?.blocker_count || 0) > 0 ? [`live_status_blockers:${Number(liveStatus.json.blocker_count)}`] : []),
    ...(liveManifest.ok && liveManifest.json?.live_model_available === false
      ? [liveManifest.json?.oe_live_bootstrap?.available === true ? 'analyzer_live_model_bootstrap_only' : 'analyzer_live_model_missing']
      : []),
  ];
  const contractWarnings = [
    ...(siteContract.json?.contract_version === EXPECTED_SITE_CONTRACT_VERSION ? [] : ['site_contract_version_mismatch']),
    ...(missingSiteFeatures.length ? [`site_contract_missing_features:${missingSiteFeatures.join(',')}`] : []),
    ...(activeLiveModel.available ? [] : [`live_model_${activeLiveModel.status || 'missing'}`]),
    ...(siteContract.ok ? [] : [`site_contract_${siteContract.status || 'missing'}`]),
    ...(predictionFeed?.ok ? [] : [`prediction_feed_${predictionFeed?.status || 'missing'}`]),
    ...(predictionSchema?.ok ? [] : [`prediction_schema_${predictionSchema?.status || 'missing'}`]),
    ...(liveStatus.ok ? [] : [`live_status_${liveStatus.status || 'missing'}`]),
    ...(liveManifest.ok ? [] : [`live_manifest_${liveManifest.status || 'missing'}`]),
    ...(predictionFeed?.json?.schema === 'lol_predictions_public_v1' ? [] : ['prediction_feed_schema_mismatch']),
    ...(predictionSchemaOk ? [] : ['prediction_schema_mismatch']),
    ...(predictionSchemaHasTopLevelWarnings ? [] : ['prediction_schema_missing_top_level_warnings']),
    ...(liveStatus.json?.schema_version === '1.0' ? [] : ['live_status_schema_mismatch']),
    ...(liveManifest.json?.schema_version === 1 ? [] : ['live_manifest_schema_mismatch']),
  ];
  const siteDataStatus = contractWarnings.length
    ? 'blocking'
    : (artifactWarnings.includes('prediction_match_overlap_zero') ? 'stale_index' : (artifactWarnings.length ? 'degraded' : 'ok'));
  const payload = {
    ok: true,
    contract_ok: contractWarnings.length === 0,
    expected_site_contract_version: EXPECTED_SITE_CONTRACT_VERSION,
    cloudflare_timestamp: new Date().toISOString(),
    deployment_branch: stringEnv(context, 'CF_PAGES_BRANCH'),
    deployment_commit_sha: stringEnv(context, 'CF_PAGES_COMMIT_SHA'),
    deployment_url: stringEnv(context, 'CF_PAGES_URL') || requestUrl.origin,
    site_contract_available: siteContract.ok,
    site_contract_version: siteContract.json?.contract_version || '',
    site_contract_schema: siteContract.json?.schema || '',
    site_contract_features: siteFeatures,
    site_contract_missing_features: missingSiteFeatures,
    live_model_available: activeLiveModel.available,
    live_model_source: activeLiveModel.source,
    live_model_name: activeLiveModel.name,
    live_model_schema: activeLiveModel.schema,
    live_model_exported_at: activeLiveModel.exportedAt,
    live_model_age_seconds: liveModelFreshness.age_seconds,
    live_model_freshness: liveModelFreshness.status,
    live_model_training_rows: activeLiveModel.trainingRows,
    live_model_test_rows: activeLiveModel.testRows,
    legacy_live_model_available: Boolean(liveModel.ok),
    legacy_live_model_exported_at: liveModel.json?.exported_at || '',
    live_logistic_model_available: Boolean(liveLogisticModel.ok),
    live_bootstrap_model_available: Boolean(liveBootstrapModel.ok),
    prediction_feed_url: predictionFeedUrl,
    configured_prediction_feed_url: remotePredictionUrl,
    prediction_feed_available: Boolean(predictionFeed?.ok),
    prediction_feed_source: localPredictions.ok ? 'local_asset' : 'remote',
    prediction_feed_last_fetch_status: predictionFeed?.status ?? 0,
    prediction_feed_generated_at: predictionFeed?.json?.generated_at || '',
    prediction_feed_age_seconds: predictionFeedFreshness.age_seconds,
    prediction_feed_freshness: predictionFeedFreshness.status,
    prediction_feed_schema: predictionFeed?.json?.schema || '',
    prediction_feed_rows: predictionRows.length,
    prediction_feed_warning_count: predictionFeedWarnings.length,
    prediction_feed_warnings: predictionFeedWarnings,
    match_index_available: Boolean(matchIndex.ok),
    match_index_last_fetch_status: matchIndex.status,
    match_index_source: matchIndex.json?.source || (Array.isArray(matchIndex.json) ? 'array' : ''),
    match_index_rows: matchRows.length,
    prediction_match_overlap_rows: predictionMatchOverlap.overlap,
    prediction_match_missing_rows: predictionMatchOverlap.missing,
    remote_prediction_feed_checked: Boolean(remotePredictionProbe),
    remote_prediction_feed_url: remotePredictionUrl,
    remote_prediction_feed_available: remotePredictionProbe ? Boolean(remotePredictionProbe.ok) : null,
    remote_prediction_feed_last_fetch_status: remotePredictionProbe?.status ?? null,
    remote_prediction_feed_generated_at: remotePredictionProbe?.json?.generated_at || '',
    remote_prediction_feed_age_seconds: remotePredictionFreshness.age_seconds,
    remote_prediction_feed_freshness: remotePredictionFreshness.status,
    remote_prediction_feed_schema: remotePredictionProbe?.json?.schema || '',
    remote_prediction_feed_rows: Array.isArray(remotePredictionProbe?.json?.predictions) ? remotePredictionProbe.json.predictions.length : null,
    remote_prediction_feed_warning_count: remotePredictionProbe ? remotePredictionFeedWarnings.length : null,
    remote_prediction_feed_warnings: remotePredictionProbe ? remotePredictionFeedWarnings : null,
    prediction_schema_url: predictionSchemaUrl,
    configured_prediction_schema_url: remoteSchemaUrl,
    prediction_schema_available: Boolean(predictionSchema?.ok),
    prediction_schema_source: localSchema.ok ? 'local_asset' : 'remote',
    prediction_schema_last_fetch_status: predictionSchema?.status ?? 0,
    prediction_schema_id: predictionSchema?.json?.$id || '',
    prediction_schema_ok: predictionSchemaOk,
    prediction_schema_has_top_level_warnings: predictionSchemaHasTopLevelWarnings,
    remote_prediction_schema_checked: Boolean(remoteSchemaProbe),
    remote_prediction_schema_url: remoteSchemaUrl,
    remote_prediction_schema_available: remoteSchemaProbe ? Boolean(remoteSchemaProbe.ok) : null,
    remote_prediction_schema_last_fetch_status: remoteSchemaProbe?.status ?? null,
    remote_prediction_schema_id: remoteSchemaProbe?.json?.$id || '',
    remote_prediction_schema_ok: remoteSchemaProbe ? remoteSchemaOk : null,
    remote_prediction_schema_has_top_level_warnings: remoteSchemaProbe ? remoteSchemaHasTopLevelWarnings : null,
    live_status_url: liveStatusUrl,
    live_status_available: Boolean(liveStatus.ok),
    live_status_last_fetch_status: liveStatus.status,
    live_status_generated_at: liveStatus.json?.generated_at || '',
    live_status_age_seconds: liveStatusFreshness.age_seconds,
    live_status_freshness: liveStatusFreshness.status,
    live_status_display_ready: liveStatus.json?.display_ready ?? null,
    live_status_production_ready: liveStatus.json?.production_ready ?? null,
    live_status_stage: liveStatus.json?.stage || '',
    live_status_blocker_count: liveStatus.json?.blocker_count ?? null,
    live_status_blockers: Array.isArray(liveStatus.json?.blockers) ? liveStatus.json.blockers : [],
    live_status_warning_count: liveStatus.json?.warning_count ?? null,
    live_status_warnings: Array.isArray(liveStatus.json?.warnings) ? liveStatus.json.warnings : [],
    live_worker_ok: liveStatus.json?.worker?.ok ?? null,
    live_worker_checked: liveStatus.json?.worker?.checked ?? null,
    analyzer_live_manifest_url: liveManifestUrl,
    analyzer_live_manifest_available: Boolean(liveManifest.ok),
    analyzer_live_manifest_last_fetch_status: liveManifest.status,
    analyzer_live_model_available: liveManifest.json?.live_model_available ?? null,
    analyzer_oe_bootstrap_available: liveManifest.json?.oe_live_bootstrap?.available ?? null,
    site_data_status: siteDataStatus,
    artifact_warnings: artifactWarnings,
    warnings: contractWarnings,
  };
  return jsonResponse(payload);
}

function configuredUrl(context, key, fallback) {
  const value = context?.env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stringEnv(context, key) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value : '';
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(warningParts).filter(Boolean);
}

function isBlockingPredictionArtifactWarning(warning) {
  const value = String(warning || '');
  const nonBlockingPrefixes = [
    'blue_red_side_sanity_delta',
    'blue_team_fallback_slug',
    'red_team_fallback_slug',
    'blue_team_no_history',
    'red_team_no_history',
  ];
  return !nonBlockingPrefixes.some(prefix => value === prefix || value.startsWith(`${prefix}:`) || value.startsWith(`${prefix}=`));
}

function predictionArtifactWarnings(payload) {
  if (!payload) return [];
  const warnings = arrayOfStrings(payload.warnings);
  const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
  for (const prediction of predictions) {
    warnings.push(...arrayOfStrings(prediction?.warnings));
  }
  return warnings;
}

function selectActiveLiveModel(liveLogisticModel, liveBootstrapModel, legacyLiveModel) {
  if (liveLogisticModel.ok) {
    return liveModelInfo(liveLogisticModel, 'live_logistic');
  }
  if (liveBootstrapModel.ok) {
    return liveModelInfo(liveBootstrapModel, 'oe_bootstrap');
  }
  return liveModelInfo(legacyLiveModel, 'legacy_static');
}

function liveModelInfo(probe, source) {
  const model = probe?.json || {};
  const evaluation = model.evaluation || model.metrics || {};
  const exportedAt = model.exported_at || model.generated_at || model.trained_at || '';
  return {
    available: Boolean(probe?.ok),
    status: probe?.status || 0,
    source,
    name: model.name || model.model_version || '',
    schema: model.schema || model.model_type || '',
    exportedAt,
    trainingRows: model.training_rows ?? model.calibration?.num_rows ?? null,
    testRows: model.test_rows ?? evaluation.num_predictions ?? evaluation.rows ?? null,
  };
}

function extractMatchRows(payload) {
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload)) return payload;
  return [];
}

function predictionMatchOverlapStats(predictions, matches) {
  const matchIds = new Set(matches.flatMap(matchIdentityValues));
  let overlap = 0;
  let missing = 0;
  for (const prediction of predictions) {
    const ids = matchIdentityValues(prediction);
    if (ids.some(id => matchIds.has(id))) overlap += 1;
    else missing += 1;
  }
  return { overlap, missing };
}

function matchIdentityValues(value) {
  const candidates = [
    value?.event_id,
    value?.eventId,
    value?.match_id,
    value?.matchId,
    value?.id,
    value?.game_id,
    value?.gameId,
  ];
  return candidates
    .map(id => String(id || '').trim())
    .filter(Boolean);
}

function warningParts(value) {
  return String(value || '')
    .split(/[|;]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function artifactFreshness(value, options = {}) {
  const staleSeconds = Number(options.staleSeconds || STALE_SECONDS);
  const warningSeconds = Number(options.warningSeconds || WARNING_SECONDS);
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return { status: 'unknown', age_seconds: null };
  const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (ageSeconds > staleSeconds) return { status: 'stale', age_seconds: ageSeconds };
  if (ageSeconds > warningSeconds) return { status: 'aging', age_seconds: ageSeconds };
  return { status: 'fresh', age_seconds: ageSeconds };
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
