#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROLE_ROUTES = Object.freeze({ top: 'top', jng: 'jungle', mid: 'mid', bot: 'adc', sup: 'support' });
const SLUG_ALIASES = Object.freeze({ wukong: 'monkeyking', nunuwillump: 'nunu', renataglasc: 'renata' });
const DEFAULT_SUMMARY = 'docs/static/data/summaries/all__all.json';
const DEFAULT_OUTPUT = 'docs/static/data/ranked-matchups.json';
const SOURCE_NAME = 'OP.GG';
const SOURCE_TIER = 'Master+';
const SOURCE_REGION = 'Global';
const REQUEST_USER_AGENT = 'Mozilla/5.0 (compatible; lol-predictor/1.0; +https://lol-predictor.pages.dev/)';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slug(value) {
  const key = normalize(value);
  return SLUG_ALIASES[key] || key;
}

function argsFrom(argv) {
  const options = { summary: DEFAULT_SUMMARY, output: DEFAULT_OUTPUT, delayMs: 1500, limit: 0, force: false, only: [], existingOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--existing-only') options.existingOnly = true;
    else if (arg === '--summary') options.summary = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++index]);
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--only') options.only = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new Error('--delay-ms must be non-negative');
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error('--limit must be non-negative');
  return options;
}

function rscPayloads(html) {
  const payloads = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const push = match[1].match(/^self\.__next_f\.push\((.*)\)$/s);
    if (!push) continue;
    try {
      const parsed = JSON.parse(push[1]);
      if (typeof parsed?.[1] === 'string') payloads.push(parsed[1]);
    } catch {
      // Ignore unrelated inline scripts and malformed fragments.
    }
  }
  return payloads;
}

export function parseOpggCounterPage(html) {
  const payload = rscPayloads(html).find(value => value.includes('"data":[{"play"'));
  if (!payload) throw new Error('OP.GG counter payload was not found');
  const componentStart = payload.indexOf('[', payload.indexOf(':') + 1);
  if (componentStart < 0) throw new Error('OP.GG counter component was not found');
  const component = JSON.parse(payload.slice(componentStart));
  const rows = Array.isArray(component?.[3]?.data) ? component[3].data : [];
  if (!rows.length) throw new Error('OP.GG counter payload was empty');
  const patch = html.match(/Patch\s+(\d+\.\d+)/i)?.[1]
    || rows[0]?.champion?.image_url?.match(/\/lol\/(\d+\.\d+)\.\d+\//)?.[1]
    || '';
  return {
    patch,
    matchups: Object.fromEntries(rows.map(row => {
      const opponent = row.champion?.name || row.champion?.key || '';
      const games = Number(row.play || 0);
      const wins = Number(row.win || 0);
      return [normalize(opponent), {
        games,
        winrate: Number(row.win_rate || (games ? (wins / games) * 100 : 0)),
      }];
    }).filter(([key, row]) => key && row.games > 0)),
  };
}

function targetRows(summary) {
  const buckets = [summary, ...Object.values(summary.patch_summaries || {})];
  const targets = [];
  for (const bucket of buckets) {
    for (const [role, route] of Object.entries(ROLE_ROUTES)) {
      for (const row of bucket.champions_by_role?.[role] || []) {
        targets.push({ role, route, champion: row.name, champion_key: normalize(row.name), slug: slug(row.name) });
      }
    }
  }
  return targets.filter((target, index, rows) => rows.findIndex(row => row.role === target.role && row.champion_key === target.champion_key) === index);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function sameUtcDate(left, right) {
  return String(left || '').slice(0, 10) === String(right || '').slice(0, 10);
}

function sourceUrl(target) {
  return `https://op.gg/lol/champions/${encodeURIComponent(target.slug)}/counters/${target.route}?tier=master_plus`;
}

async function fetchCounter(target) {
  const url = sourceUrl(target);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': REQUEST_USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseOpggCounterPage(await response.text());
      return { ...target, ...parsed, source_url: url, fetched_at: new Date().toISOString() };
    } catch (error) {
      lastError = error;
      if (/payload was not found|payload was empty/i.test(error.message)) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  throw new Error(`${target.champion} ${target.role}: ${lastError?.message || lastError}`);
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function main() {
  const options = argsFrom(process.argv.slice(2));
  const summary = await readJson(options.summary);
  if (!summary) throw new Error(`Summary not found: ${options.summary}`);
  const now = new Date().toISOString();
  const previous = await readJson(options.output, {});
  if (!options.force && !options.only.length && !options.existingOnly && sameUtcDate(previous.generated_at, now) && previous.source === SOURCE_NAME && previous.tier === SOURCE_TIER) {
    console.log(`Ranked matchups already refreshed today: ${previous.generated_at}`);
    return;
  }

  const discoveredTargets = targetRows(summary);
  const primaryKeys = new Set(targetRows({ ...summary, patch_summaries: {} }).map(target => `${target.role}|${target.champion_key}`));
  const previousKeys = new Set(Object.keys(previous.entries || {}));
  const requestedKeys = new Set(options.only);
  const refreshTargets = options.only.length
    ? discoveredTargets.filter(target => requestedKeys.has(`${target.role}|${target.champion_key}`))
    : options.existingOnly
      ? discoveredTargets.filter(target => previousKeys.has(`${target.role}|${target.champion_key}`))
    : options.force
      ? discoveredTargets
      : discoveredTargets.filter(target => primaryKeys.has(`${target.role}|${target.champion_key}`) || previousKeys.has(`${target.role}|${target.champion_key}`));
  const allTargets = refreshTargets;
  const targets = options.limit ? allTargets.slice(0, options.limit) : allTargets;
  const entries = previous.tier === SOURCE_TIER ? { ...(previous.entries || {}) } : {};
  const failures = [];
  let sourcePatch = previous.patch || '';

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const key = `${target.role}|${target.champion_key}`;
    try {
      const result = await fetchCounter(target);
      sourcePatch = result.patch || sourcePatch;
      entries[key] = result;
      console.log(`[${index + 1}/${targets.length}] ${target.role} ${target.champion}: ${Object.keys(result.matchups).length} matchups`);
    } catch (error) {
      failures.push(error.message);
      console.warn(`[${index + 1}/${targets.length}] ${error.message}`);
    }
    if (index + 1 < targets.length && options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
  }

  const payload = {
    schema: 'ranked_matchups_v1',
    source: SOURCE_NAME,
    source_policy_url: 'https://help.op.gg/hc/en-us/articles/31091405109401-Can-I-use-OP-GG-data',
    patch: sourcePatch,
    tier: SOURCE_TIER,
    region: SOURCE_REGION,
    queue: 'Ranked Solo/Duo',
    generated_at: now,
    target_count: discoveredTargets.length,
    refresh_target_count: allTargets.length,
    refreshed_count: targets.length - failures.length,
    failures,
    entries,
  };
  await writeJson(options.output, payload);
  console.log(`Wrote ${options.output}: ${Object.keys(entries).length} champion-role entries, ${failures.length} failures`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
