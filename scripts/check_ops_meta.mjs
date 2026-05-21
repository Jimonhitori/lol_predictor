#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || args.base || 'http://127.0.0.1:4174').replace(/\/+$/, '');

const [home, app, diagnostics] = await Promise.all([
  fetchText(`${baseUrl}/`),
  fetchText(`${baseUrl}/static/app.js`),
  fetchJson(`${baseUrl}/api/diagnostics`),
]);

const errors = [];
if (!home.ok) errors.push(`home page returned ${home.status}`);
if (home.ok && !home.text.includes('id="opsMeta"')) errors.push('home page is missing #opsMeta');
if (!app.ok) errors.push(`static app returned ${app.status}`);
if (app.ok && !app.text.includes('data.contract_ok')) errors.push('app.js does not read diagnostics contract_ok');
if (app.ok && !app.text.includes('contract ok')) errors.push('app.js does not render contract ok');
if (app.ok && !app.text.includes('contract pending')) errors.push('app.js does not render contract pending');
if (app.ok && !app.text.includes('prediction_schema_ok')) errors.push('app.js does not render prediction schema status');
if (app.ok && !app.text.includes('prediction_feed_freshness')) errors.push('app.js does not render prediction feed freshness');
if (app.ok && !app.text.includes('artifact_warnings')) errors.push('app.js does not render artifact warnings');
if (!diagnostics.ok) errors.push(`diagnostics returned ${diagnostics.status}`);
if (diagnostics.ok && typeof diagnostics.json?.contract_ok !== 'boolean') {
  errors.push('diagnostics contract_ok is not boolean');
}
if (diagnostics.ok && diagnostics.json?.prediction_schema_ok !== true) {
  errors.push('diagnostics prediction_schema_ok is not true');
}
if (diagnostics.ok && !String(diagnostics.json?.prediction_feed_freshness || '').trim()) {
  errors.push('diagnostics prediction_feed_freshness is missing');
}

const report = {
  ok: errors.length === 0,
  base_url: baseUrl,
  checked_at: new Date().toISOString(),
  ops_meta_present: home.text.includes('id="opsMeta"'),
  app_reads_contract_ok: app.text.includes('data.contract_ok'),
  app_reads_prediction_schema_ok: app.text.includes('prediction_schema_ok'),
  app_reads_prediction_feed_freshness: app.text.includes('prediction_feed_freshness'),
  app_reads_artifact_warnings: app.text.includes('artifact_warnings'),
  diagnostics_contract_ok: diagnostics.json?.contract_ok ?? null,
  diagnostics_prediction_schema_ok: diagnostics.json?.prediction_schema_ok ?? null,
  diagnostics_prediction_feed_freshness: diagnostics.json?.prediction_feed_freshness || '',
  diagnostics_artifact_warning_count: Array.isArray(diagnostics.json?.artifact_warnings) ? diagnostics.json.artifact_warnings.length : null,
  ops_text_preview: diagnostics.json ? renderOpsPreview(diagnostics.json) : '',
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function renderOpsPreview(data) {
  if (!data?.ok) return data?.warning ? `ops ${data.warning}` : '';
  const contract = data.contract_ok === false ? 'contract pending' : 'contract ok';
  const live = data.live_model_available
    ? `live ${data.live_model_name || 'model'}`
    : 'live model missing';
  const feed = data.prediction_feed_available
    ? `pre ${data.prediction_feed_rows ?? 0} rows`
    : 'pre remote fallback';
  const schema = data.prediction_schema_ok ? 'schema ok' : '';
  const freshness = data.prediction_feed_freshness && data.prediction_feed_freshness !== 'unknown'
    ? `pre ${data.prediction_feed_freshness}`
    : '';
  const analyzerLive = data.live_status_available
    ? `analyzer ${data.live_status_stage || (data.live_status_display_ready ? 'display ready' : 'not ready')}`
    : 'analyzer status missing';
  const worker = data.live_worker_checked
    ? `worker ${data.live_worker_ok ? 'ok' : 'check failed'}`
    : '';
  const artifactWarnings = Array.isArray(data.artifact_warnings) && data.artifact_warnings.length
    ? `artifact warnings ${data.artifact_warnings.length}`
    : '';
  return [contract, live, feed, schema, freshness, analyzerLive, worker, artifactWarnings].filter(Boolean).join(' | ');
}

async function fetchText(url) {
  try {
    const response = await fetch(url);
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchJson(url) {
  const result = await fetchText(url);
  try {
    return {
      ...result,
      json: result.text ? JSON.parse(result.text) : null,
    };
  } catch {
    return {
      ...result,
      json: null,
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
