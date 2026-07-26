#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const docsDir = path.resolve(process.argv[2] || 'docs');
const errors = [];
const checks = {};

const index = await readText('index.html');
const match = await readText('match.html');
const matchIndex = await readText('match/index.html');
const app = await readText('static/app.js');
const draftLab = await readText('rtprob/index.html');
const draftLens = await readText('player-features/index.html');
const liveSnapshotWorkflow = await readText('../.github/workflows/collect-live-event-snapshots.yml');
const champions = await readJson('static/data/champions.json');

requireChecks('navigation', {
  draft_lab: index.includes('href="/rtprob/"') && index.includes('Draft Lab'),
  draft_lens: index.includes('href="/player-features/"') && index.includes('Draft Lens'),
});

const appAssetVersions = [index, match, matchIndex]
  .map(source => source.match(/static\/app[.]js[?]v=([^"']+)/)?.[1] || '');
requireChecks('asset_versions', {
  present_on_all_pages: appAssetVersions.every(Boolean),
  consistent: new Set(appAssetVersions).size === 1,
  current: appAssetVersions[0] === 'naive-time-jst-20260714',
  data_cache_current: app.includes("const STATIC_DATA_VERSION = '20260714-naive-time-jst'")
    || app.includes('const STATIC_DATA_VERSION = "20260714-naive-time-jst"'),
});

requireChecks('schedule', {
  live_plus_three_dates: /const VISIBLE_DATE_TAB_COUNT\s*=\s*3/.test(app),
  centered_selected_date: app.includes('function centeredDateAnchorKey('),
  major_includes_events: app.includes("leagueGroup === 'major' ? new Set(['major', 'event'])"),
});

requireChecks('patch_meta', {
  overall_default: app.includes("setValue('championMetaGroup', 'all')")
    || app.includes('setValue("championMetaGroup", "all")'),
});

requireChecks('draft_lab', {
  team_cc: draftLab.includes('Team CC'),
  guaranteed_cc: draftLab.includes('\u78ba\u5b9aCC'),
  skillshot_cc: draftLab.includes('\u30b9\u30ad\u30eb\u30b7\u30e7\u30c3\u30c8CC'),
  local_roster_first: draftLab.indexOf('localChampionRosterUrl') >= 0
    && draftLab.indexOf('ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data') >= 0
    && draftLab.indexOf('localChampionRosterUrl') < draftLab.indexOf('ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data'),
  local_images: draftLab.includes('localChampionImageBaseUrl'),
  lazy_picker_images: draftLab.includes('loading="lazy"'),
  sharded_composition_data: draftLab.includes('function compositionShardBucket(')
    && draftLab.includes('/static/data/composition-synergy/${cacheKey}.json')
    && !draftLab.includes('/static/data/composition_synergy.json'),
});

requireChecks('live_collection', {
  manual_only: liveSnapshotWorkflow.includes('workflow_dispatch:')
    && !liveSnapshotWorkflow.includes('schedule:')
    && !liveSnapshotWorkflow.includes('cron:'),
});

requireChecks('draft_lens', {
  league_grouped_teams: draftLens.includes('Grouped by league.'),
  player_name: draftLens.includes('class="playerName"'),
  player_winrate_and_picks: draftLens.includes('WR ${pct(stat.winrate)}') && draftLens.includes('${picks} picks'),
  lane_matchups: draftLens.includes('id="laneMatchups"'),
  lane_matchup_comparison: draftLens.includes('class="laneVersus"')
    && draftLens.includes('No direct player matchup sample'),
  team_split_player_features: draftLens.includes('class="featureCompare"')
    && draftLens.includes('renderFeatureSide("blue")')
    && draftLens.includes('renderFeatureSide("red")'),
  team_player_prediction: draftLens.includes('id="lensPrediction"')
    && draftLens.includes('function featurePrediction()')
    && draftLens.includes('Team form (overall)')
    && draftLens.includes('Player champion')
    && draftLens.includes('Champion meta')
    && draftLens.includes('Lane matchup'),
  default_26_all: draftLens.includes('statPatch: "26ALL"'),
  filter_26_all: draftLens.includes('value: "26ALL", label: "26ALL"'),
  filter_25_all: draftLens.includes('value: "25ALL", label: "25ALL"'),
  filter_all: draftLens.includes('value: "ALL", label: "ALL"'),
});

const championRows = champions?.data && typeof champions.data === 'object'
  ? Object.values(champions.data)
  : [];
const missingImages = [];
for (const champion of championRows) {
  const filename = champion?.image?.full || `${champion?.id || ''}.png`;
  if (!filename || !(await exists(path.join(docsDir, 'static/images/champions', filename)))) {
    missingImages.push(filename || champion?.id || 'unknown');
  }
}
checks.champion_assets = {
  roster_count: championRows.length,
  missing_images: missingImages,
};
if (championRows.length < 170) errors.push(`champion_assets: expected at least 170 champions, found ${championRows.length}`);
if (missingImages.length) errors.push(`champion_assets: missing ${missingImages.length} images`);

console.log(JSON.stringify({ ok: errors.length === 0, docs_dir: docsDir, checks, errors }, null, 2));
if (errors.length) process.exit(1);

async function readText(relativePath) {
  try {
    return await fs.readFile(path.join(docsDir, relativePath), 'utf8');
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return '';
  }
}

async function readJson(relativePath) {
  const text = await readText(relativePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${relativePath}: invalid JSON: ${error.message}`);
    return null;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function requireChecks(group, values) {
  checks[group] = values;
  for (const [name, ok] of Object.entries(values)) {
    if (!ok) errors.push(`${group}: ${name} failed`);
  }
}

