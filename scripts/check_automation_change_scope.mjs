#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const branch = String(args.branch || '');
const base = String(args.base || '');
const head = String(args.head || 'HEAD');

if (!branch.startsWith('analyzer-')) {
  console.log(JSON.stringify({ ok: true, skipped: true, branch }, null, 2));
  process.exit(0);
}
if (!base) fail('Missing --base for analyzer automation scope check');

const allowedFiles = new Set([
  'docs/pre_match_predictions.json',
  'docs/live_status.json',
  'docs/live_model_manifest.json',
  'docs/live_model_readiness_audit.json',
  'docs/live_logistic.json',
  'docs/live_logistic_oe_bootstrap.json',
]);
const allowedPrefixes = ['docs/static/data/'];
const changed = capture('git', ['diff', '--name-only', `${base}...${head}`])
  .split(/\r?\n/)
  .map(value => value.trim())
  .filter(Boolean);
const rejected = changed.filter(file => !allowedFiles.has(file) && !allowedPrefixes.some(prefix => file.startsWith(prefix)));

console.log(JSON.stringify({ ok: rejected.length === 0, branch, base, head, changed, rejected }, null, 2));
if (rejected.length) process.exit(1);

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) fail(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    parsed[value.slice(2)] = values[index + 1] || '';
    index += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(`ERROR: ${String(message).trim()}`);
  process.exit(1);
}
