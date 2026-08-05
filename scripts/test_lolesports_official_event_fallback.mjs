import assert from 'node:assert/strict';

import { officialPageHtmlToEvent } from '../functions/api/live-event.js';


const event = {
  id: 'event-1',
  type: 'match',
  state: 'inProgress',
  matchTeams: [
    { id: 'event-1:team-blue', name: 'Blue Team' },
    { id: 'event-1:team-red', name: 'Red Team' },
  ],
  match: {
    id: 'event-1',
    state: 'inProgress',
    games: [{ id: 'game-1', state: 'inProgress', number: 1 }],
  },
};
const transport = {
  rehydrate: {
    result: { data: { esports: { events: [event] } } },
  },
};
const html = [
  '<script>(globalThis[Symbol.for("ApolloSSRDataTransport")] ??= []).push(',
  JSON.stringify(transport),
  ')</script>',
].join('');

const recovered = officialPageHtmlToEvent(html, 'event-1');

assert.equal(recovered.id, 'event-1');
assert.equal(recovered.__source, 'lolesports_official_page');
assert.equal(recovered.__warning, 'event_details_403_official_page_fallback');
assert.deepEqual(recovered.match.teams.map(team => team.id), ['team-blue', 'team-red']);
assert.equal(officialPageHtmlToEvent(html, 'missing'), null);
console.log('official LoL Esports event fallback: PASS');
