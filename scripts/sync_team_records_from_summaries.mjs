import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.join(ROOT, 'docs', 'static', 'data');
const SUMMARIES_DIR = path.join(STATIC_DIR, 'summaries');
const TEAM_RECORDS_DIR = path.join(STATIC_DIR, 'team-records');

const requestedLeagues = new Set(
  process.argv
    .slice(2)
    .filter((value) => value && !value.startsWith('-'))
    .map((value) => staticKey(value))
);
const overwrite = process.argv.includes('--overwrite');

await fs.mkdir(TEAM_RECORDS_DIR, { recursive: true });

const summaryFiles = (await fs.readdir(SUMMARIES_DIR))
  .filter((name) => name.startsWith('league__') && name.endsWith('.json'))
  .filter((name) => requestedLeagues.size === 0 || requestedLeagues.has(name.slice('league__'.length, -'.json'.length)))
  .sort();

const result = {
  created: [],
  updated_blank: [],
  skipped_existing: [],
  skipped_invalid: [],
};

for (const fileName of summaryFiles) {
  const leagueKey = fileName.slice('league__'.length, -'.json'.length);
  const summary = JSON.parse(await fs.readFile(path.join(SUMMARIES_DIR, fileName), 'utf8'));
  const league = Array.isArray(summary.leagues) && summary.leagues.length ? summary.leagues[0] : leagueKey.toUpperCase();
  const teams = Array.isArray(summary.teams) ? summary.teams : [];

  for (const team of teams) {
    if (!team?.name || !team.game_record) {
      result.skipped_invalid.push(`${leagueKey}:${team?.name || 'unknown'}`);
      continue;
    }

    const targetName = `${leagueKey}__${staticKey(team.name)}.json`;
    const targetPath = path.join(TEAM_RECORDS_DIR, targetName);
    const record = buildRecord({ league, leagueKey, summary, team });
    let existing = null;

    try {
      existing = JSON.parse(await fs.readFile(targetPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (existing?.league_record && !overwrite) {
      result.skipped_existing.push(targetName);
      continue;
    }

    await fs.writeFile(targetPath, `${JSON.stringify({ ...existing, ...record }, null, 2)}\n`);
    if (existing) result.updated_blank.push(targetName);
    else result.created.push(targetName);
  }
}

console.log(JSON.stringify(result, null, 2));

function buildRecord({ league, leagueKey, summary, team }) {
  const games = Number(team.games || 0);
  const wins = Number(team.wins || 0);
  const losses = Number(team.losses || 0);
  const winrate = games > 0 ? wins / games : parsePercent(team.winrate);
  return {
    team: team.name,
    matched_team: team.name,
    league,
    split: `${league} ${new Date().getUTCFullYear()}`,
    league_wins: wins,
    league_losses: losses,
    league_record: `${wins}-${losses}`,
    games,
    wins,
    losses,
    winrate,
    record: team.game_record,
    label: `${new Date().getUTCFullYear()} ${league}`,
    source: 'league_summary_standings',
    summary_source: `summaries/league__${leagueKey}.json`,
    summary_patch: summary.patch || null,
  };
}

function parsePercent(value) {
  const number = Number(String(value || '').replace('%', ''));
  return Number.isFinite(number) ? number / 100 : 0;
}

function staticKey(value) {
  return String(value || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
}
