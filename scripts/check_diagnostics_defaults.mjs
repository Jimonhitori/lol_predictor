#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestGet } from '../functions/api/diagnostics.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repoRoot, 'docs');
const baseUrl = 'https://lol-predictor.pages.dev';

const response = await onRequestGet({
  request: new Request(`${baseUrl}/api/diagnostics`),
  env: {
    ASSETS: {
      fetch: async (request) => {
        const url = new URL(request.url);
        return assetResponse(url.pathname);
      },
    },
  },
  waitUntil: () => {},
});
const data = await response.json();
const report = {
  ok: true,
  checked_at: new Date().toISOString(),
  contract_ok: data.contract_ok,
  configured_prediction_feed_url: data.configured_prediction_feed_url,
  remote_prediction_feed_checked: data.remote_prediction_feed_checked,
  configured_prediction_schema_url: data.configured_prediction_schema_url,
  remote_prediction_schema_checked: data.remote_prediction_schema_checked,
  live_status_available: data.live_status_available,
  analyzer_live_manifest_available: data.analyzer_live_manifest_available,
  prediction_schema_has_top_level_warnings: data.prediction_schema_has_top_level_warnings,
  prediction_feed_warning_count: data.prediction_feed_warning_count,
  remote_prediction_feed_warning_count: data.remote_prediction_feed_warning_count,
  artifact_warnings: data.artifact_warnings,
  warnings: data.warnings,
  errors: [],
};

if (data.contract_ok !== true) report.errors.push('diagnostics default contract_ok is not true');
if (data.configured_prediction_feed_url !== `${baseUrl}/pre_match_predictions.json`) {
  report.errors.push('default prediction feed URL is not the Cloudflare-hosted artifact');
}
if (data.configured_prediction_schema_url !== `${baseUrl}/static/data/schemas/pre_match_predictions.v1.schema.json`) {
  report.errors.push('default prediction schema URL is not the Cloudflare-hosted artifact');
}
if (data.remote_prediction_feed_checked !== false) {
  report.errors.push('remote prediction feed should not be checked without an override URL');
}
if (data.remote_prediction_schema_checked !== false) {
  report.errors.push('remote prediction schema should not be checked without an override URL');
}
if (data.live_status_available !== true) report.errors.push('default live_status artifact is unavailable');
if (data.analyzer_live_manifest_available !== true) {
  report.errors.push('default live_model_manifest artifact is unavailable');
}
if (data.prediction_schema_has_top_level_warnings !== true) {
  report.errors.push('default prediction schema is missing top-level warnings');
}
if (!Number.isInteger(data.prediction_feed_warning_count) || data.prediction_feed_warning_count < 0) {
  report.errors.push(`default prediction feed warning count is invalid: ${data.prediction_feed_warning_count}`);
}
if (data.remote_prediction_feed_warning_count !== null) {
  report.errors.push('remote prediction feed warning count should be null without an override URL');
}
if (data.prediction_feed_warning_count === 0 && Array.isArray(data.artifact_warnings) && data.artifact_warnings.includes('prediction_feed_has_warnings')) {
  report.errors.push('prediction_feed_has_warnings is set without feed warnings');
}
if (data.prediction_feed_warning_count > 0 && !data.artifact_warnings?.includes('prediction_feed_has_warnings')) {
  report.errors.push('prediction_feed_has_warnings is missing despite feed warnings');
}
const unexpectedArtifactWarnings = Array.isArray(data.artifact_warnings)
  ? data.artifact_warnings.filter(warning => warning !== 'prediction_feed_has_warnings')
  : [];
if (unexpectedArtifactWarnings.length) {
  report.errors.push(`unexpected default artifact warnings: ${unexpectedArtifactWarnings.join(',')}`);
}

report.ok = report.errors.length === 0;
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function assetResponse(pathname) {
  let cleanPath = decodeURIComponent(pathname);
  if (cleanPath === '/' || cleanPath === '') cleanPath = '/index.html';
  const filePath = path.resolve(docsRoot, cleanPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(docsRoot)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    return new Response(await fs.readFile(filePath), {
      status: 200,
      headers: { 'content-type': contentType(filePath) },
    });
  } catch {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
}

function contentType(filePath) {
  return filePath.endsWith('.json') ? 'application/json' : 'text/plain';
}
