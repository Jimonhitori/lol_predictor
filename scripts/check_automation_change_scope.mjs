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
const guardedSummaries = [
  'docs/static/data/summaries/all__all.json',
  'docs/static/data/summaries/major__all.json',
  'docs/static/data/summaries/event__all.json',
  'docs/static/data/summaries/secondary__all.json',
];
const summaryRegressions = guardedSummaries
  .filter(file => changed.includes(file))
  .flatMap(file => compareSummary(file, readJsonAt(base, file), readJsonAt(head, file)));

console.log(JSON.stringify({
  ok: rejected.length === 0 && summaryRegressions.length === 0,
  branch,
  base,
  head,
  rejected,
  summary_regressions: summaryRegressions,
  changed,
}, null, 2));
if (rejected.length || summaryRegressions.length) process.exit(1);

function compareSummary(file, before, after) {
  const regressions = [];
  const beforeThrough = summaryDataThrough(before);
  const afterThrough = summaryDataThrough(after);
  if (beforeThrough && afterThrough && Date.parse(afterThrough) < Date.parse(beforeThrough)) {
    regressions.push({ file, field: 'data_through', before: beforeThrough, after: afterThrough });
  }
  const beforePatches = Array.isArray(before?.patch_options) ? before.patch_options.length : 0;
  const afterPatches = Array.isArray(after?.patch_options) ? after.patch_options.length : 0;
  if (beforePatches && afterPatches < beforePatches) {
    regressions.push({ file, field: 'patch_options', before: beforePatches, after: afterPatches });
  }
  return regressions;
}

function summaryDataThrough(summary) {
  return String(summary?.all_data_through || summary?.data_through || '').trim();
}

function readJsonAt(ref, file) {
  try {
    return JSON.parse(capture('git', ['show', `${ref}:${file}`]));
  } catch (error) {
    fail(`Could not read summary ${file} at ${ref}: ${error.message}`);
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
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
