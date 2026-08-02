#!/usr/bin/env node

import assert from 'node:assert/strict';
import { leagueGroup, leagueRegion, normalizeSchedule } from '../workers/schedule/src/index.mjs';

const payload = { data: { schedule: { events: [
  {
    type: 'match', startTime: '2026-08-03T08:00:00Z', state: 'unstarted',
    league: { name: 'KeSPA Cup', slug: 'kespa_cup' },
    match: {
      id: 'kespa-1', strategy: { count: 3 }, teams: [
        { name: 'Hanwha Life Esports', code: 'HLE', image: 'http://example.com/hle.png', result: { gameWins: 0 } },
        { name: 'Gen.G Esports', code: 'GEN', image: 'http://example.com/gen.png', result: { gameWins: 0 } },
      ],
    },
  },
  {
    type: 'match', startTime: '2026-08-02T08:00:00Z', state: 'completed',
    league: { name: 'LCK', slug: 'lck' },
    match: {
      id: 'lck-1', strategy: { count: 3 }, teams: [
        { name: 'Blue', code: 'BLU', result: { gameWins: 1 } },
        { name: 'Red', code: 'RED', result: { gameWins: 0 } },
      ],
    },
  },
  { type: 'show', startTime: '2026-08-03T00:00:00Z' },
] } } };

const normalized = normalizeSchedule(payload, '2026-08-02T12:00:00.000Z');
assert.equal(normalized.ok, true);
assert.equal(normalized.source, 'cloudflare_lolesports_schedule');
assert.equal(normalized.matches.length, 2);
assert.deepEqual(normalized.matches.map(match => match.id), ['lck-1', 'kespa-1']);

const lck = normalized.matches[0];
assert.equal(lck.status, 'inProgress');
assert.equal(lck.league_group, 'major');
assert.equal(lck.region, 'korea');

const kespa = normalized.matches[1];
assert.equal(kespa.league, 'KeSPA Cup');
assert.equal(kespa.league_group, 'major');
assert.equal(kespa.region, 'korea');
assert.equal(kespa.blue_image, 'https://example.com/hle.png');

assert.equal(leagueGroup('ewc'), 'event');
assert.equal(leagueGroup('lfl'), 'secondary');
assert.equal(leagueRegion('lpl'), 'china');
assert.equal(leagueRegion('unknown'), 'other');

console.log(JSON.stringify({ ok: true, checks: 16 }, null, 2));
