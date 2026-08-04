import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const source = await fs.readFile(path.join(root, 'functions/api/leaguepedia-cargo.js'), 'utf8');
if (!source.includes('UPSTREAM_TIMEOUT_MS = 8_000') || !source.includes('fetchWithTimeout')) {
  throw new Error('bounded upstream timeout is missing');
}
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { onRequestGet } = await import(moduleUrl);

const fields = [
  'SG.GameId=game_id',
  'SG.MatchId=match_id',
  'SG.DateTime_UTC=date',
  'SG.Tournament=tournament',
  'SG.Patch=patch',
  'SG.Team1=blue_team',
  'SG.Team2=red_team',
  'SG.Winner=winner',
  'SG.Team1Picks=blue_picks',
  'SG.Team2Picks=red_picks',
  'SG.Team1Bans=blue_bans',
  'SG.Team2Bans=red_bans',
].join(',');
const where = "SG.DateTime_UTC >= '2026-08-01 00:00:00' AND SG.DateTime_UTC <= '2026-08-05 23:59:59' AND SG.Team1 IS NOT NULL AND SG.Team2 IS NOT NULL AND SG.Team1 != '' AND SG.Team2 != '' AND SG.Winner IS NOT NULL AND SG.Winner != ''";

function requestUrl(overrides = {}) {
  const params = new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    tables: 'ScoreboardGames=SG',
    fields,
    where,
    order_by: 'SG.DateTime_UTC DESC',
    limit: '100',
    ...overrides,
  });
  return `https://example.test/api/leaguepedia-cargo?${params}`;
}

function context(url) {
  return {
    request: new Request(url),
    waitUntil(promise) {
      void promise;
    },
  };
}

globalThis.caches = {
  default: {
    async match() { return null; },
    async put() {},
  },
};

let upstreamCalls = 0;
globalThis.fetch = async () => {
  upstreamCalls += 1;
  return new Response(JSON.stringify({ cargoquery: [{ title: { game_id: 'api-1' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const apiResponse = await onRequestGet(context(requestUrl()));
const apiPayload = await apiResponse.json();
if (apiResponse.status !== 200 || apiPayload.cargoquery?.[0]?.title?.game_id !== 'api-1') {
  throw new Error('valid proxy API response was not preserved');
}

const invalidResponse = await onRequestGet(context(requestUrl({ tables: 'Players=P' })));
if (invalidResponse.status !== 400 || upstreamCalls !== 1) {
  throw new Error('unsupported Cargo query reached the upstream service');
}

let exportCalls = 0;
globalThis.fetch = async (url) => {
  exportCalls += 1;
  if (String(url).includes('api.php')) {
    return new Response(JSON.stringify({ error: { code: 'ratelimited', info: 'retry later' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('game_id,blue_picks\nexport-1,"Azir,Vi,Gnar,Aphelios,Nautilus"\n', {
    status: 200,
    headers: { 'Content-Type': 'text/csv' },
  });
};
const exportResponse = await onRequestGet(context(requestUrl({ limit: '50' })));
const exportPayload = await exportResponse.json();
if (
  exportResponse.status !== 200
  || exportCalls !== 2
  || exportPayload.transport !== 'cloudflare_cargo_export'
  || exportPayload.cargoquery?.[0]?.title?.blue_picks !== 'Azir,Vi,Gnar,Aphelios,Nautilus'
) {
  throw new Error('CargoExport fallback was not parsed safely');
}

console.log(JSON.stringify({
  ok: true,
  api_transport_checked: true,
  export_transport_checked: true,
  arbitrary_query_rejected: true,
  upstream_timeout_bounded: true,
}, null, 2));
