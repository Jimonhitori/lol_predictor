const UPSTREAM_URL = 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US';
const UPSTREAM_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const CACHE_SECONDS = 300;
const UPSTREAM_TIMEOUT_MS = 8000;

const PRIMARY_LEAGUE_SLUGS = new Set([
  'cblol-brazil', 'kespa_cup', 'lck', 'lck_challengers_league', 'lcp',
  'lcs', 'lec', 'lpl', 'msi', 'worlds',
]);
const EVENT_LEAGUE_SLUGS = new Set(['ewc']);

const LEAGUE_LABEL_BY_SLUG = {
  'cblol-brazil': 'CBLOL', cd: 'CD', ewc: 'EWC', kespa_cup: 'KeSPA Cup',
  lck: 'LCK', lck_challengers_league: 'LCKC', lcp: 'LCP', lcs: 'LCS',
  lec: 'LEC', lfl: 'LFL', lpl: 'LPL', msi: 'MSI', nacl: 'NACL', pcs: 'PCS',
  tcl: 'TCL', vcs: 'VCS', worlds: 'WLDs',
};

const REGION_BY_SLUG = {
  'cblol-brazil': 'americas', arabian_league: 'emea', cd: 'americas',
  esports_balkan_league: 'emea', ewc: 'international',
  hellenic_legends_league: 'emea', kespa_cup: 'korea', lck: 'korea',
  lck_challengers_league: 'korea', lcp: 'pacific', lcs: 'americas',
  lec: 'emea', les: 'americas', lfl: 'emea', lit: 'emea', lpl: 'china',
  nacl: 'americas', nlc: 'emea', pcs: 'pacific', primeleague: 'emea',
  rift_legends: 'emea', south_regional_league: 'americas', tcl: 'emea',
  vcs: 'pacific', worlds: 'international', msi: 'international',
};

export default {
  async fetch(request, env, context) {
    return handleRequest(request, env, context);
  },
};

export async function handleRequest(request, env = {}, context = {}) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return corsResponse(null, 204);
  if (request.method !== 'GET') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  if (url.pathname === '/' || url.pathname === '/health') {
    return jsonResponse({
      ok: true,
      service: 'lol-predictor-data',
      plan: 'cloudflare-workers-free',
      cache_seconds: CACHE_SECONDS,
      storage: 'cache_api_only',
    });
  }
  if (url.pathname !== '/schedule') return jsonResponse({ ok: false, error: 'not_found' }, 404);

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`${url.origin}/schedule`, { method: 'GET' });
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return withHeader(cached, 'x-lol-predictor-cache', 'HIT');

  try {
    const payload = await fetchUpstreamSchedule(env.LOL_ESPORTS_API_KEY || UPSTREAM_API_KEY);
    const response = jsonResponse(normalizeSchedule(payload), 200, {
      'cache-control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'x-lol-predictor-cache': 'MISS',
    });
    if (cache) {
      const put = cache.put(cacheKey, response.clone());
      if (typeof context.waitUntil === 'function') context.waitUntil(put);
      else await put;
    }
    return response;
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: 'schedule_upstream_unavailable',
      message: String(error?.message || error),
    }, 502, { 'cache-control': 'no-store' });
  }
}

export async function fetchUpstreamSchedule(apiKey, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(UPSTREAM_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'lol-predictor-cloudflare-free/1.0',
        'x-api-key': apiKey,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`LoL Esports schedule fetch failed: ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeSchedule(payload, generatedAt = new Date().toISOString()) {
  const events = Array.isArray(payload?.data?.schedule?.events)
    ? payload.data.schedule.events
    : [];
  const matches = events
    .filter(event => event?.type === 'match')
    .map(normalizeMatch)
    .filter(Boolean)
    .sort((left, right) => String(left.start_time).localeCompare(String(right.start_time)));
  return {
    ok: true,
    source: 'cloudflare_lolesports_schedule',
    generated_at: generatedAt,
    cache_seconds: CACHE_SECONDS,
    matches,
  };
}

export function normalizeMatch(event) {
  const match = event?.match || {};
  const teams = Array.isArray(match.teams) ? match.teams : [];
  const blue = teams[0] || {};
  const red = teams[1] || {};
  const id = text(match.id || event?.id);
  if (!id) return null;
  const slug = text(event?.league?.slug).toLowerCase();
  return {
    id,
    source_match_id: text(event?.id || id),
    league: leagueLabel(event?.league),
    league_group: leagueGroup(slug),
    region: leagueRegion(slug),
    start_time: text(event?.startTime),
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
    source: 'cloudflare_lolesports_schedule',
  };
}

export function leagueGroup(slug) {
  if (PRIMARY_LEAGUE_SLUGS.has(slug)) return 'major';
  if (EVENT_LEAGUE_SLUGS.has(slug)) return 'event';
  return 'secondary';
}

export function leagueRegion(slug) {
  return REGION_BY_SLUG[slug] || 'other';
}

function leagueLabel(league) {
  const slug = text(league?.slug).toLowerCase();
  return LEAGUE_LABEL_BY_SLUG[slug] || text(league?.name || league?.slug);
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

function normalizeStatus(value) {
  const status = text(value).toLowerCase();
  if (status === 'completed') return 'completed';
  if (status === 'inprogress' || status === 'in_progress') return 'inProgress';
  return status || 'unstarted';
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

function jsonResponse(data, status = 200, headers = {}) {
  return corsResponse(JSON.stringify(data), status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function corsResponse(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      ...headers,
    },
  });
}

function withHeader(response, name, value) {
  const next = new Response(response.body, response);
  next.headers.set(name, value);
  return next;
}
