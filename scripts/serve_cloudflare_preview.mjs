#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as diagnosticsFunction from '../functions/api/diagnostics.js';
import * as liveEventFunction from '../functions/api/live-event.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repoRoot, 'docs');
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || 4174);
const host = String(args.host || '127.0.0.1');

installCacheShim();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  try {
    if (url.pathname === '/api/diagnostics') {
      await serveFunction(response, diagnosticsFunction.onRequestGet, url);
      return;
    }
    if (url.pathname === '/api/live-event') {
      await serveFunction(response, liveEventFunction.onRequestGet, url);
      return;
    }
    if (url.pathname === '/analyzer/pre_match_predictions.json') {
      await serveJson(response, emptyPreMatchPredictions());
      return;
    }
    if (url.pathname === '/analyzer/live_status.json') {
      await serveJsonFile(response, path.join(repoRoot, 'lol-pros-analyzer', 'public', 'live_status.json'), emptyLiveStatus());
      return;
    }
    if (url.pathname === '/analyzer/live_model_manifest.json') {
      await serveJsonFile(
        response,
        path.join(repoRoot, 'lol-pros-analyzer', 'public', 'live_model_manifest.json'),
        emptyLiveManifest(),
      );
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    } else if (!response.writableEnded) {
      response.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`Cloudflare preview listening on http://${host}:${port}`);
  console.log(`Smoke check: node scripts/check_cloudflare_pages.mjs --base-url http://${host}:${port} --prediction-feed-url http://${host}:${port}/analyzer/pre_match_predictions.json --live-status-url http://${host}:${port}/analyzer/live_status.json --live-manifest-url http://${host}:${port}/analyzer/live_model_manifest.json`);
});

async function serveFunction(response, handler, url) {
  const request = new Request(url.toString());
  const result = await handler({
    request,
    env: {
      ASSETS: {
        fetch: async (assetRequest) => {
          const assetUrl = new URL(assetRequest.url);
          return assetResponse(assetUrl.pathname);
        },
      },
      PRE_MATCH_PREDICTIONS_URL: `http://${host}:${port}/analyzer/pre_match_predictions.json`,
      LIVE_STATUS_URL: `http://${host}:${port}/analyzer/live_status.json`,
      LIVE_MODEL_MANIFEST_URL: `http://${host}:${port}/analyzer/live_model_manifest.json`,
    },
    waitUntil: () => {},
  });
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
}

async function serveStatic(response, pathname) {
  const result = await assetResponse(pathname);
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
}

async function assetResponse(pathname) {
  let cleanPath = decodeURIComponent(pathname);
  if (cleanPath === '/' || cleanPath === '') cleanPath = '/index.html';
  if (cleanPath === '/match') cleanPath = '/match/index.html';
  const filePath = path.resolve(docsRoot, cleanPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(docsRoot)) return new Response('forbidden', { status: 403 });
  try {
    const stat = await fs.stat(filePath);
    const finalPath = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    return new Response(await fs.readFile(finalPath), {
      status: 200,
      headers: {
        'content-type': contentType(finalPath),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function serveJsonFile(response, filePath, fallbackPayload = null) {
  try {
    const payload = await fs.readFile(filePath);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(payload);
  } catch {
    if (fallbackPayload) {
      await serveJson(response, fallbackPayload);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: false, error: 'missing_preview_artifact' }));
  }
}

async function serveJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload, null, 2));
}

function emptyPreMatchPredictions() {
  return {
    schema: 'lol_predictions_public_v1',
    generated_at: new Date().toISOString(),
    source: 'local_cloudflare_preview',
    models: {
      pre_match: {
        name: 'none',
        version: 'preview_empty',
        metrics: {},
      },
    },
    predictions: [],
  };
}

function emptyLiveManifest() {
  return {
    schema_version: 1,
    live_model_available: false,
    live_model_url: null,
    live_evaluation_available: false,
    live_evaluation: null,
    live_readiness_audit_url: null,
    training_readiness: null,
    min_feature_rows: 50,
    min_games: 5,
    min_intervals: 25,
    min_pct_intervals_lte_30s: 0.8,
    live_replay_available: false,
    live_replay_summary: null,
  };
}

function emptyLiveStatus() {
  return {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    source: 'local_cloudflare_preview',
    display_ready: false,
    production_ready: false,
    live_model_available: false,
    live_model_url: null,
    live_manifest_url: 'live_model_manifest.json',
    live_readiness_audit_url: null,
    live_replay_available: false,
    stage: 'bootstrap_empty',
    blocker_count: 1,
    warning_count: 0,
    blockers: ['Public live artifacts are bootstrapped but no live model has been trained.'],
    warnings: [],
    next_actions: ['Run the training workflow to publish trained live artifacts.'],
    requirements: [
      {
        id: 'live_training',
        label: 'Train and publish live model artifacts',
        status: 'blocked',
        evidence: { reason: 'bootstrap_empty' },
      },
    ],
    training: { available: false, pipeline: { available: false } },
    replay: { available: false },
    collection: {
      config: { available: false },
      readiness: { available: false },
      d1_sync: { available: false },
      archive: { available: false },
    },
    bootstrap: { available: false },
    oe_live_bootstrap: { available: false },
    worker: { checked: false },
  };
}

function installCacheShim() {
  if (globalThis.caches?.default) return;
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (request) => store.get(request.url) || null,
      put: async (request, response) => {
        store.set(request.url, response);
      },
    },
  };
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
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
