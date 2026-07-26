#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const docsDir = path.resolve(process.argv[2] || 'docs');
const dataDir = path.join(docsDir, 'static', 'data');
const sourceDir = path.join(dataDir, 'composition-synergy');
const entries = await fs.readdir(sourceDir, { withFileTypes: true });
const sourceFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));

for (const entry of sourceFiles) {
  const sourcePath = path.join(sourceDir, entry.name);
  const artifact = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  const scopeDir = path.join(sourceDir, entry.name.slice(0, -5));
  await fs.mkdir(scopeDir, { recursive: true });
  await writeJson(path.join(scopeDir, 'manifest.json'), {
    schema: 'lol_composition_synergy_sharded_v3',
    generated_at: artifact.generated_at,
    league_group: artifact.league_group,
    region: artifact.region,
    patch: artifact.patch,
    complete_team_games: artifact.complete_team_games,
    combo_types: artifact.combo_types,
    shard_count: 8,
  });
  await writeSections(scopeDir, 'metrics', artifact.metrics || {});
  await writeSections(scopeDir, 'lane-matchups', artifact.lane_matchups || {});
  await writeSections(scopeDir, 'duo-matchups', artifact.duo_matchups || {});
  await fs.unlink(sourcePath);
}

await fs.rm(path.join(dataDir, 'composition_synergy.json'), { force: true });
console.log(JSON.stringify({ ok: true, scopes: sourceFiles.length, shard_count: 8 }));

async function writeSections(scopeDir, section, groups) {
  for (const [item, records] of Object.entries(groups)) {
    const shards = Array.from({ length: 8 }, () => ({}));
    for (const [key, record] of Object.entries(records || {})) {
      shards[shardBucket(key)][key] = record;
    }
    await Promise.all(shards.map((shard, bucket) =>
      writeJson(path.join(scopeDir, section, item, `${bucket}.json`), shard)));
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload), 'utf8');
}

function shardBucket(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 8;
}
