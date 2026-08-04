const UPSTREAM_API_URL = 'https://lol.fandom.com/api.php';
const UPSTREAM_EXPORT_URL = 'https://lol.fandom.com/wiki/Special:CargoExport';
const EXPECTED_TABLES = 'ScoreboardGames=SG';
const EXPECTED_FIELDS = [
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
const EXPECTED_ORDER = 'SG.DateTime_UTC DESC';
const WHERE_PATTERN = /^SG\.DateTime_UTC >= '\d{4}-\d{2}-\d{2} 00:00:00' AND SG\.DateTime_UTC <= '\d{4}-\d{2}-\d{2} 23:59:59' AND SG\.Team1 IS NOT NULL AND SG\.Team2 IS NOT NULL AND SG\.Team1 != '' AND SG\.Team2 != '' AND SG\.Winner IS NOT NULL AND SG\.Winner != ''$/;
const MAX_ROWS = 100;
const CACHE_SECONDS = 10 * 60;
const UPSTREAM_TIMEOUT_MS = 8_000;

const RESPONSE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
  'Content-Type': 'application/json; charset=utf-8',
};

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const validation = validateQuery(requestUrl.searchParams);
  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(requestUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const query = validation.query;
  const apiUrl = new URL(UPSTREAM_API_URL);
  apiUrl.search = new URLSearchParams({ action: 'cargoquery', format: 'json', ...query }).toString();
  let apiError = null;
  try {
    const response = await fetchWithTimeout(apiUrl, { headers: upstreamHeaders('application/json') });
    const payload = await response.json();
    if (response.ok && !payload?.error) {
      return cacheResponse(context, cache, cacheKey, jsonResponse(payload));
    }
    apiError = payload?.error || { code: `http_${response.status}`, info: 'Leaguepedia API request failed' };
  } catch (error) {
    apiError = { code: 'transport_error', info: String(error?.message || error) };
  }

  try {
    const exportUrl = new URL(UPSTREAM_EXPORT_URL);
    exportUrl.search = new URLSearchParams({ ...query, format: 'csv' }).toString();
    const response = await fetchWithTimeout(exportUrl, { headers: upstreamHeaders('text/csv,*/*;q=0.8') });
    if (!response.ok) throw new Error(`CargoExport HTTP ${response.status}`);
    const text = await response.text();
    if (/^\s*(?:<!doctype html|<html|error:)/i.test(text)) {
      throw new Error('CargoExport returned a non-CSV response');
    }
    const rows = parseCsv(text);
    const payload = {
      cargoquery: rows.map((row) => ({ title: row })),
      transport: 'cloudflare_cargo_export',
      api_error: apiError,
    };
    return cacheResponse(context, cache, cacheKey, jsonResponse(payload));
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: 'leaguepedia_upstream_unavailable',
        api_error: apiError,
        export_error: String(error?.message || error),
      },
      502,
    );
  }
}

function validateQuery(params) {
  const limit = Number.parseInt(params.get('limit') || '', 10);
  const offset = Number.parseInt(params.get('offset') || '0', 10);
  if (params.get('action') !== 'cargoquery' || params.get('format') !== 'json') {
    return { ok: false, error: 'unsupported_action' };
  }
  if (params.get('tables') !== EXPECTED_TABLES || params.get('fields') !== EXPECTED_FIELDS) {
    return { ok: false, error: 'unsupported_schema' };
  }
  if (params.get('order_by') !== EXPECTED_ORDER || !WHERE_PATTERN.test(params.get('where') || '')) {
    return { ok: false, error: 'unsupported_filter' };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS || offset !== 0) {
    return { ok: false, error: 'unsupported_page' };
  }
  return {
    ok: true,
    query: {
      tables: EXPECTED_TABLES,
      fields: EXPECTED_FIELDS,
      where: params.get('where'),
      order_by: EXPECTED_ORDER,
      limit: String(limit),
    },
  };
}

function upstreamHeaders(accept) {
  return {
    Accept: accept,
    'User-Agent': 'lol-predictor-pages/1.0',
  };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: RESPONSE_HEADERS });
}

function cacheResponse(context, cache, key, response) {
  context.waitUntil(cache.put(key, response.clone()));
  return response;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  const header = rows.shift() || [];
  return rows
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] || ''])));
}
