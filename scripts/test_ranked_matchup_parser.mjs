#!/usr/bin/env node

import assert from 'node:assert/strict';
import { parseOpggCounterPage } from './update_ranked_matchups.mjs';

const component = JSON.stringify(['$', '$L1', null, {
  data: [
    { play: 448, win: 238, win_rate: 53.1, champion: { name: 'Lux', key: 'lux', image_url: 'https://opgg-static.akamaized.net/meta/images/lol/16.14.1/champion/Lux.png' } },
    { play: 1601, win: 747, win_rate: 46.7, champion: { name: 'Aphelios', key: 'aphelios', image_url: 'https://opgg-static.akamaized.net/meta/images/lol/16.14.1/champion/Aphelios.png' } },
  ],
}]);
const payload = `55:${component}`;
const html = `<html><head><title>Kai'Sa Counters, Patch 16.14</title></head><body><script>self.__next_f.push(${JSON.stringify([1, payload])})</script></body></html>`;
const result = parseOpggCounterPage(html);

assert.equal(result.patch, '16.14');
assert.deepEqual(result.matchups.lux, { games: 448, winrate: 53.1 });
assert.deepEqual(result.matchups.aphelios, { games: 1601, winrate: 46.7 });
console.log('ranked matchup parser: ok');
