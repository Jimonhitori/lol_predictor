#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const STATIC_DIR = path.join(DOCS_DIR, 'static', 'data');
const API_URL = 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US';
const API_KEY = process.env.LOL_ESPORTS_API_KEY || '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const args = parseArgs(process.argv.slice(2));
const startDate = args.startDate ? parseDate(args.startDate) : null;
const endDate = args.endDate ? parseDate(args.endDate) : null;

const payload = args.input
  ? JSON.parse(await fs.readFile(path.resolve(args.input), 'utf8'))
  : await fetchSchedule();
const updates = scheduleUpdates(payload, { startDate, endDate });
const result = await updateMatchLists(updates);

console.log(JSON.stringify({
  updates_available: updates.size,
  ...result,
}, null, 2));

async function fetchSchedule() {
  const response = await fetch(API_URL, {
    headers: {
      'accept': 'application/json',
      'x-api-key': API_KEY,
      'user-agent': 'lol-predictor-static-sync/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`LoL Esports schedule fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function scheduleUpdates(payload, { startDate, endDate }) {
  const output = new Map();
  const events = payload?.data?.schedule?.events || [];
  for (const event of events) {
    if (!event || event.type !== 'match') continue;
    const eventDate = utcDate(event.startTime);
    if (startDate && (!eventDate || eventDate < startDate)) continue;
    if (endDate && (!eventDate || eventDate > endDate)) continue;

    const match = event.match || {};
    const teams = Array.isArray(match.teams) ? match.teams : [];
    const blue = teams[0] || {};
    const red = teams[1] || {};
    const id = String(match.id || event.id || '');
    if (!id) continue;
    output.set(id, {
      id,
      source_match_id: text(event.id || id),
      league: text(event.league?.name || event.league?.slug),
      start_time: text(event.startTime),
      status: normalizeEventStatus(event, match, blue, red),
      blue_team: text(blue.name || blue.code || blue.slug || 'TBD'),
      red_team: text(red.name || red.code || red.slug || 'TBD'),
      blue_code: text(blue.code || blue.name || 'TBD'),
      red_code: text(red.code || red.name || 'TBD'),
      blue_image: normalizeImage(blue.image),
      red_image: normalizeImage(red.image),
      blue_score: scoreText(blue.result?.gameWins),
      red_score: scoreText(red.result?.gameWins),
      best_of: text(match.strategy?.count),
      source: 'lolesports_api',
    });
  }
  return output;
}

async function updateMatchLists(updates) {
  const files = (await fs.readdir(STATIC_DIR))
    .filter(name => /^matches-(all|major|secondary|event)__.*\.json$/.test(name))
    .sort();
  const changed_files = [];
  let updated_matches = 0;
  for (const file of files) {
    const filePath = path.join(STATIC_DIR, file);
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    let changed = false;
    for (const match of matches) {
      const update = updates.get(String(match.id || ''));
      if (!update) continue;
      for (const [key, value] of Object.entries(update)) {
        if (value === '' && key !== 'blue_score' && key !== 'red_score') continue;
        if (match[key] !== value) {
          match[key] = value;
          changed = true;
        }
      }
      updated_matches += 1;
    }
    if (!changed) continue;
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    changed_files.push(file);
  }
  return {
    changed_files,
    updated_matches,
  };
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--input') output.input = values[++index];
    else if (value === '--start-date') output.startDate = values[++index];
    else if (value === '--end-date') output.endDate = values[++index];
  }
  return output;
}

function parseDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return value;
}

function utcDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function normalizeStatus(value) {
  const state = text(value).toLowerCase();
  if (state === 'completed') return 'completed';
  if (state === 'inprogress' || state === 'in_progress') return 'inProgress';
  return state || 'unstarted';
}

function normalizeEventStatus(event, match, blue, red) {
  const status = normalizeStatus(event?.state);
  if (status !== 'completed') return status;
  const bestOf = Number(match?.strategy?.count || 0);
  const needed = bestOf ? Math.floor(bestOf / 2) + 1 : 0;
  if (!needed) return status;
  const blueWins = Number(blue?.result?.gameWins ?? 0);
  const redWins = Number(red?.result?.gameWins ?? 0);
  return Math.max(blueWins, redWins) >= needed ? 'completed' : 'inProgress';
}

function normalizeImage(value) {
  const image = text(value);
  if (!image) return 'https://static.lolesports.com/teams/team-tbd.png';
  return image.replace(/^http:\/\//, 'https://');
}

function scoreText(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '';
}

function text(value) {
  return String(value ?? '').trim();
}
