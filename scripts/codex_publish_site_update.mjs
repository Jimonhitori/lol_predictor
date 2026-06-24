#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_BRANCH = 'codex/github-pages-static';
const DEFAULT_BASE_URL = 'https://lol-predictor.pages.dev';
const DEFAULT_FILES = [
  'docs/index.html',
  'docs/match.html',
  'docs/match/index.html',
  'docs/pre_match_predictions.json',
  'docs/static/app.js',
  'lol_predictor/web_app.py',
];

const args = parseArgs(process.argv.slice(2));
const message = String(args.message || args.m || '').trim();
const branch = String(args.branch || DEFAULT_BRANCH).trim();
const baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).trim();
const files = listArg(args.file).length ? listArg(args.file) : defaultFiles();
const dryRun = Boolean(args.dryRun);
const skipPreview = Boolean(args.skipPreview);
const skipPush = Boolean(args.skipPush);
const skipProductionSmoke = Boolean(args.skipProductionSmoke);

if (!message && !dryRun) {
  fail('Missing --message. Example: --message "Fix stale live match tabs"');
}

run('git', ['rev-parse', '--show-toplevel']);
const currentBranch = capture('git', ['branch', '--show-current']).trim();
if (currentBranch !== branch) {
  fail(`Current branch is ${currentBranch || '(detached)'}, expected ${branch}.`);
}

checkCleanEnough(files);
preflight();

if (dryRun) {
  console.log('[dry-run] Would stage:');
  for (const file of files) console.log(`  ${file}`);
  console.log(`[dry-run] Would commit: ${message || '(message required for non-dry-run)'}`);
  if (!skipPush) console.log(`[dry-run] Would push branch: ${branch}`);
  if (!skipProductionSmoke) console.log(`[dry-run] Would smoke production: ${baseUrl}`);
  process.exit(0);
}

run('git', ['add', '--', ...files]);
const staged = capture('git', ['diff', '--cached', '--name-only']).trim();
if (!staged) fail('No staged changes after git add.');

run('git', ['commit', '-m', message]);
if (!skipPush) run('git', ['push', 'origin', branch]);
if (!skipProductionSmoke) {
  run('node', ['scripts/check_cloudflare_pages.mjs', '--base-url', baseUrl, '--event-id', 'test']);
}

console.log('Site update command completed.');

function preflight() {
  run('node', ['--check', 'docs/static/app.js']);
  run('node', ['--check', 'functions/api/diagnostics.js']);
  run('node', ['--check', 'functions/api/live-event.js']);
  run('node', ['--check', 'scripts/check_cloudflare_pages.mjs']);
  run('node', ['--check', 'scripts/check_ops_meta.mjs']);
  run('node', ['--check', 'scripts/serve_cloudflare_preview.mjs']);
  if (!skipPreview) runPreviewSmoke();
}

function runPreviewSmoke() {
  const child = spawn('node', ['scripts/serve_cloudflare_preview.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    waitForPreview();
    run('node', [
      'scripts/check_cloudflare_pages.mjs',
      '--base-url', 'http://127.0.0.1:4174',
      '--prediction-feed-url', 'http://127.0.0.1:4174/analyzer/pre_match_predictions.json',
      '--live-status-url', 'http://127.0.0.1:4174/analyzer/live_status.json',
      '--live-manifest-url', 'http://127.0.0.1:4174/analyzer/live_model_manifest.json',
      '--event-id', 'test',
    ]);
    run('node', ['scripts/check_ops_meta.mjs', '--base-url', 'http://127.0.0.1:4174']);
  } finally {
    child.kill();
    if (child.exitCode && child.exitCode !== 0) process.stderr.write(output);
  }
}

function waitForPreview() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('node', [
      '-e',
      "fetch('http://127.0.0.1:4174/site-contract.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ], { stdio: 'ignore', windowsHide: true });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  fail('Local preview did not start on http://127.0.0.1:4174.');
}

function checkCleanEnough(paths) {
  const status = capture('git', ['status', '--porcelain', '--', ...paths]).trim();
  if (!status) fail(`No changes found in publish paths: ${paths.join(', ')}`);
}

function run(command, commandArgs) {
  console.log(`> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '');
    process.exit(result.status || 1);
  }
  return result.stdout;
}

function fail(messageText) {
  console.error(`ERROR: ${messageText}`);
  process.exit(1);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = values[index + 1];
    if (next && !next.startsWith('--')) {
      if (parsed[key] === undefined) parsed[key] = next;
      else parsed[key] = [...listArg(parsed[key]), next];
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function listArg(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function defaultFiles() {
  return [
    ...DEFAULT_FILES,
    ...readdirSync('docs/static/data')
      .filter((name) => /^matches-.*[.]json$/.test(name))
      .sort()
      .map((name) => `docs/static/data/${name}`),
  ];
}
