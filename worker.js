// ═══════════════════════════════════════════════════════════
// LMI Property Intelligence Engine — Cloudflare Worker
// ═══════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = [
  'https://lmitool.com',
  'https://www.lmitool.com',
  'https://loopenta.com',
  'https://www.loopenta.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

// ═══════════════════════════════════════════════════════════
// RENTCAST QUOTA — HARD CEILING. DO NOT REMOVE THIS GUARD.
// Free tier: 50 / month. Starter paid: usually 500-1000. Pro: thousands.
// To raise when upgraded: change the number below, redeploy. That's it.
// The entire system reads from this one constant. Every path that touches
// the RentCast API goes through consumeRentCastQuota(env) which hard-blocks
// at this number. There is no code path that calls RentCast without first
// incrementing this counter.
// ═══════════════════════════════════════════════════════════
const RENTCAST_MONTHLY_LIMIT = 50;

// Super-admin access is gated by the ADMIN_PASSWORD Cloudflare secret
// (set via `npx wrangler secret put ADMIN_PASSWORD`). The admin page
// prompts for it once per session and sends it as a Bearer token.

// Default KV config if none has been saved yet. Admin page can mutate.
const DEFAULT_RENTCAST_CONFIG = {
  priorityZips: [],          // populated by "Reset to defaults" on admin page
  scheduledDay: 5,           // day of month (1-28) the cron fires real work
  killSwitch: false,         // true = disable all RentCast calls, period
};

// Canonical default priority list (the 9 cities we seeded). Admin page's
// "Reset to defaults" writes this into KV. Keeps under 50 with headroom.
const DEFAULT_PRIORITY_ZIPS = [
  // Stockton (San Joaquin)
  '95201','95202','95203','95204','95205','95206','95207','95210','95215',
  // Fresno
  '93701','93702','93703','93704','93705','93706','93722','93725','93726','93727','93728',
  // Sacramento
  '95815','95817','95820','95822','95823','95824','95828','95832','95838',
  // Madera
  '93637','93638',
  // Turlock
  '95380','95382',
  // Merced
  '95340','95341','95348',
  // Oakhurst
  '93644',
  // Hanford
  '93230',
  // Ontario
  '91761','91762','91764',
];

// ZIP → city display name (seeded list only; admin-added ZIPs return "").
// Used by the public /priority-zips endpoint so the LMI search dropdown can
// show "95201 — Stockton" etc.
const ZIP_TO_CITY = {
  '95201':'Stockton','95202':'Stockton','95203':'Stockton','95204':'Stockton','95205':'Stockton',
  '95206':'Stockton','95207':'Stockton','95210':'Stockton','95215':'Stockton',
  '93701':'Fresno','93702':'Fresno','93703':'Fresno','93704':'Fresno','93705':'Fresno',
  '93706':'Fresno','93722':'Fresno','93725':'Fresno','93726':'Fresno','93727':'Fresno','93728':'Fresno',
  '95815':'Sacramento','95817':'Sacramento','95820':'Sacramento','95822':'Sacramento',
  '95823':'Sacramento','95824':'Sacramento','95828':'Sacramento','95832':'Sacramento','95838':'Sacramento',
  '93637':'Madera','93638':'Madera',
  '95380':'Turlock','95382':'Turlock',
  '95340':'Merced','95341':'Merced','95348':'Merced',
  '93644':'Oakhurst',
  '93230':'Hanford',
  '91761':'Ontario','91762':'Ontario','91764':'Ontario',
};

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Also allow same-origin requests (no Origin header) and the worker's own domain
  if (!origin) return '*';
  return null;
}

function corsHeaders(request) {
  const origin = getAllowedOrigin(request);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // LMI census tract lookup: GET /?zip=XXXXX
    const zip = url.searchParams.get('zip');
    if (zip && url.pathname === '/') {
      return handleLmiLookup(zip, request);
    }

    // Property Intelligence API route
    if (url.pathname === '/property-intelligence' && request.method === 'GET') {
      return handlePropertyIntelligence(request, env);
    }

    // For-sale aggregate listings route (reads from KV cache only — never live)
    if (url.pathname === '/for-sale' && request.method === 'GET') {
      return handleForSale(request, env);
    }

    // Public list of priority ZIPs (with city names + cache status) — no auth.
    // Used by the LMI search dropdown to show available ZIPs.
    if (url.pathname === '/priority-zips' && request.method === 'GET') {
      return handlePriorityZips(request, env);
    }

    // ── Super-admin RentCast data endpoints (all require ADMIN_PASSWORD bearer) ──
    if (url.pathname === '/admin/rentcast-status' && request.method === 'GET') {
      return handleAdminStatus(request, env);
    }
    if (url.pathname === '/admin/rentcast-config' && request.method === 'POST') {
      return handleAdminConfig(request, env);
    }
    if (url.pathname === '/admin/rentcast-refresh-now' && request.method === 'POST') {
      return handleAdminRefreshNow(request, env);
    }
    if (url.pathname === '/admin/rentcast-refresh-zip' && request.method === 'POST') {
      return handleAdminRefreshZip(request, env);
    }
    if (url.pathname === '/admin/verify-address' && request.method === 'POST') {
      return handleAdminVerifyAddress(request, env);
    }
    if (url.pathname === '/admin/trace-address' && request.method === 'POST') {
      return handleAdminTraceAddress(request, env);
    }
    if (url.pathname === '/admin/reenrich-cache' && request.method === 'POST') {
      return handleAdminReenrichCache(request, env);
    }
    if (url.pathname === '/admin/rentcast-reset-defaults' && request.method === 'POST') {
      return handleAdminResetDefaults(request, env);
    }
    if (url.pathname === '/admin/rentcast-reset-counter' && request.method === 'POST') {
      return handleAdminResetCounter(request, env);
    }

    // ── Firebase Auth admin endpoints (require ADMIN_PASSWORD bearer) ──
    // Used by the client to create / delete Firebase Auth users without
    // signing the admin OUT of their own session (which is what would
    // happen if the client did `createUserWithEmailAndPassword` itself).
    if (url.pathname === '/admin/migrate-users' && request.method === 'POST') {
      return handleMigrateAuthUsers(request, env);
    }
    if (url.pathname === '/admin/create-auth-user' && request.method === 'POST') {
      return handleCreateAuthUser(request, env);
    }
    if (url.pathname === '/admin/delete-auth-user' && request.method === 'POST') {
      return handleDeleteAuthUser(request, env);
    }
    if (url.pathname === '/admin/set-auth-password' && request.method === 'POST') {
      return handleSetAuthPassword(request, env);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },

  // Cron trigger: runs daily (configured in wrangler.jsonc). Only executes
  // the actual RentCast refresh if today's day-of-month matches the admin-
  // configured scheduledDay. This lets the admin change the refresh day
  // without redeploying.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledRefresh(env, 'cron'));
  },
};

// ─────────────────────────────────────────
// CORS headers helper
// ─────────────────────────────────────────
function jsonResponse(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

// ─────────────────────────────────────────
// LMI Census tract lookup (FFIEC proxy)
// ─────────────────────────────────────────
// Classifies an FFIEC tract-to-MSA income ratio (percentage) into a category.
// Used everywhere we surface income level — keep the thresholds in one place.
// CRA standard (exact, matches FFIEC Geocoder):
//   Low:      ratio <  50%
//   Moderate: 50% ≤ ratio <  80%
//   Middle:   80% ≤ ratio < 120%
//   Upper:    ratio ≥ 120%
// "LMI" = Low OR Moderate (ratio < 80).
function classifyIncomeRatio(ratio) {
  if (ratio === null || ratio === undefined || !isFinite(ratio)) return 'Unknown';
  if (ratio < 50)  return 'Low';
  if (ratio < 80)  return 'Moderate';
  if (ratio < 120) return 'Middle';
  return 'Upper';
}

// Normalizes a census-tract identifier to an 11-digit FIPS GEOID string.
// FFIEC sometimes drops a leading zero (state FIPS < 10) — pad left. FCC
// returns a 15-digit Block FIPS; first 11 = tract.
function normalizeTractId(raw) {
  if (!raw) return '';
  const s = String(raw).trim().replace(/\D/g, '');
  if (!s) return '';
  if (s.length >= 15) return s.slice(0, 11);     // block FIPS → tract GEOID
  if (s.length === 11) return s;
  if (s.length === 10) return '0' + s;           // common FFIEC case
  return s.padStart(11, '0');
}

// CFPB HMDA API expects state as 2-letter postal abbreviation (not FIPS).
// Using the FIPS numeric (e.g. "06") makes the filter silently no-op and the
// endpoint returns the ENTIRE nationwide dataset — which then blows the
// Worker's 128MB memory limit. Map FIPS → abbrev up front.
const STATE_FIPS_TO_ABBREV = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA',
  '15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA',
  '26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY',
  '37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX',
  '49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI',
};

// Reads a response body as a stream, accumulating into text with a hard byte
// cap. If the response is larger than `maxBytes`, cancels the reader and
// returns { tooLarge: true }. This protects us against CFPB endpoints that
// ignore filters and return gigabyte-scale CSVs — reading those with
// `.text()` throws "Memory limit would be exceeded before EOF".
//
// Also streams line-by-line via the optional `onLine` callback. When the
// callback returns `stop: true`, we cancel the reader immediately — so for
// "find the row with matching tract then stop" we rarely touch more than a
// few hundred KB even if the full response would be huge.
async function streamTextCapped(resp, maxBytes, onLine) {
  if (!resp.body) {
    // Fallback for environments without streaming (shouldn't happen on CF).
    const text = await resp.text();
    if (text.length > maxBytes) return { tooLarge: true, bytesRead: text.length };
    if (onLine) {
      const lines = text.split('\n');
      for (const line of lines) { const r = onLine(line); if (r && r.stop) break; }
    }
    return { tooLarge: false, bytesRead: text.length, text };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bytesRead = 0;
  let stopped = false;
  let firstLine = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        return { tooLarge: true, bytesRead, firstLine };
      }
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!firstLine) firstLine = line;
        if (onLine) {
          const r = onLine(line);
          if (r && r.stop) {
            stopped = true;
            try { await reader.cancel(); } catch (e) {}
            break;
          }
        }
      }
      if (stopped) break;
    }
    if (!stopped && buffer.length && onLine) {
      onLine(buffer); // final partial line, if any
    }
  } catch (e) {
    return { tooLarge: false, bytesRead, error: String(e && e.message || e), firstLine };
  }
  return { tooLarge: false, bytesRead, firstLine, stopped };
}

// Splits a CSV line into values, respecting quoted fields that contain commas
// (HMDA tract names occasionally include commas inside quotes).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (inQ) {
      if (c === 34 /* " */) {
        if (line.charCodeAt(i + 1) === 34) { cur += '"'; i++; }
        else { inQ = false; }
      } else { cur += line[i]; }
    } else {
      if (c === 34) inQ = true;
      else if (c === 44 /* , */) { out.push(cur.trim()); cur = ''; }
      else cur += line[i];
    }
  }
  out.push(cur.trim());
  return out;
}

// Fetches the FFIEC tract list for a ZIP and returns parsed rows. Pure
// data-returning helper — no Response wrapping — so admin refresh code can
// reuse it to enrich RentCast listings. handleLmiLookup wraps this for the
// public HTTP endpoint.
async function fetchLmiTractsForZip(zip) {
  if (!/^\d{5}$/.test(zip)) return { ok: false, reason: 'invalid_zip', tracts: [] };

  // CFPB HMDA currently has data for 2018-2023 (per the API's own range
  // error). Hardcoded to the known-good range so we stop hitting invalid
  // years and wasting subrequests.
  const yearsToTry = [2023, 2022, 2021, 2020, 2019, 2018];

  let res;
  try {
    for (const year of yearsToTry) {
      // `actions_taken=1,2,3` narrows HMDA rows to originated, approved-not-
      // accepted, and denied only — cuts the response size ~4x vs. no filter,
      // which is important because some large-volume ZIPs (e.g. 95206) return
      // CSVs big enough to blow the Worker 128MB memory limit otherwise. The
      // tract-level fields (ratio / median income / population) are identical
      // across action_taken values, so filtering doesn't lose any tract data.
      const ffiecUrl =
        'https://ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv' +
        '?years=' + year +
        '&actions_taken=1,2,3' +
        '&msa_md=&state=&county=&census_tract=' +
        '&fields=census_tract,tract_population,' +
        'tract_minority_population_percent,' +
        'ffiec_msa_md_median_family_income,' +
        'tract_to_msa_income_percentage' +
        '&zip_codes=' + zip;
      res = await fetch(ffiecUrl, { headers: { 'User-Agent': 'LMI-Tool/1.0' } });
      if (res.ok) break;
    }
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', error: String(e && e.message || e), tracts: [] };
  }

  if (!res || !res.ok) return { ok: false, reason: 'ffiec_error_' + (res ? res.status : 'none'), tracts: [] };

  // Stream parse instead of `res.text()` — some busy ZIPs (e.g. 95206)
  // return CSVs big enough to blow the Worker's 128 MB memory limit if
  // read whole. 5 MB is a generous cap for tract-level ZIP data; if we
  // hit it the filter probably didn't narrow, so we return what we've
  // parsed so far with a flag (not body_read_failed).
  const MAX_BYTES = 5 * 1024 * 1024;
  let headers = null;
  const results = [];
  let streamResult;
  try {
    streamResult = await streamTextCapped(res, MAX_BYTES, (line) => {
      if (!line) return null;
      if (!headers) {
        headers = parseCsvLine(line).map(h => h.trim().replace(/"/g, ''));
        return null;
      }
      const values = parseCsvLine(line);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx]; });
      const incomeRatio = parseFloat(row.tract_to_msa_income_percentage);
      const rawId = row.census_tract || '';
      results.push({
        tract_id: rawId,
        tract_id_normalized: normalizeTractId(rawId),
        census_tract: rawId,
        tract_population: parseInt(row.tract_population) || 0,
        minority_pct: parseFloat(row.tract_minority_population_percent) || 0,
        median_family_income: parseInt(row.ffiec_msa_md_median_family_income) || 0,
        income_ratio: isFinite(incomeRatio) ? incomeRatio : null,
        lmi_status: isFinite(incomeRatio) && incomeRatio <= 80,
        lmi_category: classifyIncomeRatio(isFinite(incomeRatio) ? incomeRatio : null),
      });
      return null;
    });
  } catch (e) {
    return { ok: false, reason: 'body_read_failed', error: String(e && e.message || e), tracts: [] };
  }
  if (!headers) {
    return { ok: false, reason: 'no_headers_in_stream', bytesRead: streamResult ? streamResult.bytesRead : 0, tracts: [] };
  }

  const seen = new Set();
  const unique = results.filter(r => {
    const key = r.tract_id_normalized || r.tract_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: true, tracts: unique };
}

async function handleLmiLookup(zip, request) {
  if (!/^\d{5}$/.test(zip)) {
    return jsonResponse({ error: 'Invalid zip code' }, request, 400);
  }
  try {
    const { ok, tracts, reason } = await fetchLmiTractsForZip(zip);
    if (!ok) {
      // Preserve legacy fallback behavior for the aggregations endpoint.
      // CFPB only has data up to 2023 at the moment.
      const aggUrl =
        'https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations' +
        '?years=2023' +
        '&actions_taken=1,2,3&loan_purposes=1&zip_codes=' + zip;
      const aggRes = await fetch(aggUrl, {
        headers: { 'User-Agent': 'LMI-Tool/1.0', Accept: 'application/json' },
      });
      if (!aggRes.ok) return jsonResponse({ error: 'FFIEC API error', reason }, request, 502);
      const aggData = await aggRes.json();
      return jsonResponse(aggData.aggregations || [], request);
    }
    return jsonResponse(tracts, request);
  } catch (e) {
    return jsonResponse({ error: 'Census API unreachable' }, request, 502);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TRACT GEOCODING — resolves a lat/lon (from RentCast) to a census tract
// GEOID, then matches against the FFIEC list for that ZIP to tag each
// listing with its income level. This is what makes the tool CRA-correct:
// ZIPs overlap both LMI and non-LMI tracts, so without this step a "Fresno
// LMI ZIP" might show homes that are actually in upper-income tracts.
//
// Data path:
//   RentCast listing  →  lat/lon
//   lat/lon           →  FCC Block Find API  →  15-digit Block FIPS
//   Block FIPS[0..11] →  tract GEOID
//   tract GEOID       →  FFIEC tract row     →  income_ratio, lmi_category
//
// Cost: FREE. FCC Block Find and FFIEC are both free, no key. We cache
// per-coord results in KV so repeat refreshes don't re-geocode the same
// listings. Runs in parallel inside the scheduled refresh — ~50 listings
// per ZIP finishes in roughly 1-2 seconds.
// ═══════════════════════════════════════════════════════════════════════

// Cache key for a single coord lookup. Rounded to ~5 decimal places (~1 meter)
// so tiny floating-point noise doesn't cause misses on repeat refreshes.
function coordCacheKey(lat, lon) {
  const r = (x) => Math.round(Number(x) * 100000) / 100000;
  return 'tract_coord_' + r(lat) + '_' + r(lon);
}

async function geocodeToTract(lat, lon, env) {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  if (!isFinite(Number(lat)) || !isFinite(Number(lon))) return null;

  // Cache first — tract boundaries rarely change, so a long TTL is safe.
  const key = coordCacheKey(lat, lon);
  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(key, 'json');
      if (cached && cached.tractId) return cached.tractId;
    } catch (e) { /* fall through */ }
  }

  try {
    const url = 'https://geo.fcc.gov/api/census/block/find'
      + '?latitude=' + encodeURIComponent(Number(lat))
      + '&longitude=' + encodeURIComponent(Number(lon))
      + '&censusYear=2020&format=json';
    const resp = await fetch(url, { headers: { 'User-Agent': 'LMI-Tool/1.0' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const blockFips = data && data.Block && data.Block.FIPS;
    if (!blockFips) return null;
    const tractId = normalizeTractId(blockFips);
    if (env.KV_NAMESPACE && tractId) {
      try {
        await env.KV_NAMESPACE.put(key, JSON.stringify({ tractId, cachedAt: Date.now() }),
          { expirationTtl: 60 * 60 * 24 * 365 }); // 1 year — tracts rarely change
      } catch (e) { /* non-critical */ }
    }
    return tractId;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTHORITATIVE ADDRESS→TRACT (v2)
//
// Replaces FCC Block Find as the PRIMARY tract lookup. FCC snaps a point
// to the nearest census block, which can cross tract boundaries when
// RentCast's coords are approximate (parcel centroid vs. exact house
// location). Census Geocoder's `onelineaddress` API, by contrast, matches
// on the address string itself — same data that powers FFIEC Geocoder —
// and returns the tract containing the matched parcel. This is the fix
// for the "921 S Aurora St is Low per FFIEC but our tool classifies it
// as something else" problem.
// ═══════════════════════════════════════════════════════════════════════

function normalizeAddressForKey(address) {
  return String(address || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 180);
}

// Geocodes a full address string to a tract GEOID via Census Geocoder.
// Returns { ok, tractId, matchedAddress, lat, lon, stateFips, countyFips, tractCode, source }
// Caches in KV for 1 year (address→tract is effectively immutable).
async function geocodeAddressOneLine(address, env) {
  if (!address) return { ok: false, reason: 'no_address' };

  const key = 'addr_tract_v1_' + normalizeAddressForKey(address);
  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(key, 'json');
      if (cached && cached.ok) return cached;
    } catch (e) { /* fall through */ }
  }

  try {
    const url = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress'
      + '?address=' + encodeURIComponent(address)
      + '&benchmark=Public_AR_Current&vintage=Current_Current&format=json';
    const resp = await fetch(url, { headers: { 'User-Agent': 'LMI-Tool/1.0' } });
    if (!resp.ok) return { ok: false, reason: 'census_http_' + resp.status };
    const data = await resp.json();
    const matches = data && data.result && data.result.addressMatches;
    if (!Array.isArray(matches) || !matches.length) {
      return { ok: false, reason: 'no_match' };
    }
    const m = matches[0];
    const geos = m.geographies || {};
    const tractGeo = (geos['Census Tracts'] && geos['Census Tracts'][0]) || null;
    if (!tractGeo) return { ok: false, reason: 'no_tract_in_response' };
    const fullGeoid = String(tractGeo.GEOID || '');
    const result = {
      ok: true,
      tractId: normalizeTractId(fullGeoid),
      matchedAddress: m.matchedAddress || address,
      lat: m.coordinates ? m.coordinates.y : null,
      lon: m.coordinates ? m.coordinates.x : null,
      stateFips: fullGeoid.slice(0, 2),
      countyFips: fullGeoid.slice(2, 5),
      tractCode: fullGeoid.slice(5),
      source: 'census_onelineaddress',
    };
    if (env.KV_NAMESPACE) {
      try {
        await env.KV_NAMESPACE.put(key, JSON.stringify(result),
          { expirationTtl: 60 * 60 * 24 * 365 }); // 1 year
      } catch (e) { /* non-critical */ }
    }
    return result;
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', error: String(e && e.message || e) };
  }
}

// Looks up FFIEC tract-to-MSA income ratio for a SPECIFIC tract GEOID.
// This replaces the ZIP-list lookup, which had gaps (tracts that straddle
// ZIPs may not appear under the dominant ZIP query in CFPB Data Browser).
// Tries most recent years in order; CFPB typically has year-1 and year-2
// available at any given time.
//
// Returns { ok, tractId, incomeRatio, level, year, medianFamilyIncome,
//           tractPopulation, minorityPct, source }
//
// Caches in KV for 30 days (FFIEC updates annually; 30 days is safe and
// avoids over-reliance on CFPB uptime).
async function fetchTractIncomeRatio(tractId, env) {
  if (!tractId || !/^\d{11}$/.test(tractId)) return { ok: false, reason: 'invalid_tract_id', tractId };

  // Bump cache key to v4 — prior versions may have cached the ACS proxy
  // value (~46.21%) when we now prefer CFPB's authoritative FFIEC value
  // (~46.48%). Forcing a cache miss ensures the first post-deploy lookup
  // re-queries CFPB and writes the authoritative result.
  const cacheKey = 'tract_ratio_v4_' + tractId;
  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(cacheKey, 'json');
      if (cached && cached.ok) return cached;
    } catch (e) { /* fall through */ }
  }

  const stateFips = tractId.slice(0, 2);
  const countyFips3 = tractId.slice(2, 5);
  const tractSix = tractId.slice(5);
  const stateAbbrev = STATE_FIPS_TO_ABBREV[stateFips] || stateFips;
  const countyFips5 = tractId.slice(0, 5);
  const attempts = [];

  const countyFips3Digit = countyFips3; // 3 digits WITHIN state for ACS

  // ── PATH A: CFPB HMDA Data Browser (PRIMARY — authoritative FFIEC) ───
  // CFPB's tract_to_msa_income_percentage is FFIEC's published value,
  // computed against HUD's MSA MFI estimate. This is the authoritative
  // source banks are regulated against. We try this first for accuracy —
  // ACS county-proxy drifts 0.2-1% from FFIEC and could misclassify a
  // borderline tract near the 50% / 80% / 120% cutoffs.
  //
  // Budget-safety:
  //   • states=CA (2-letter abbrev) + counties=06077 + census_tracts=
  //     06077000700 + actions_taken=1 → typical response <100 KB
  //   • streamed with 2 MB hard byte cap (tight — the filter must work)
  //   • only 2 years tried (2023 → 2022); first success returns
  //   • if both fail we fall through to ACS
  async function tryCfpbCsv(year, scope) {
    const params =
      '?years=' + year +
      '&states=' + stateAbbrev +
      '&counties=' + countyFips5 +
      (scope === 'tract' ? ('&census_tracts=' + tractId) : '') +
      '&actions_taken=1' +
      '&fields=census_tract,tract_population,' +
      'tract_minority_population_percent,' +
      'ffiec_msa_md_median_family_income,' +
      'tract_to_msa_income_percentage';
    const url = 'https://ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv' + params;
    let resp;
    try {
      resp = await fetch(url, { headers: { 'User-Agent': 'LMI-Tool/1.0', 'Accept': 'text/csv' } });
    } catch (e) {
      attempts.push({ year, scope, ok: false, reason: 'fetch_threw', error: String(e && e.message || e) });
      return null;
    }
    if (!resp.ok) {
      let bodySample = '';
      try { bodySample = (await resp.text()).slice(0, 300); } catch (e) {}
      attempts.push({ year, scope, ok: false, status: resp.status, reason: 'http_' + resp.status, bodySample });
      return null;
    }
    const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — tight; single-tract response should be <100 KB
    const shortTract = tractSix;
    const shortTractInt = parseInt(shortTract, 10).toString();
    let hdrs = null;
    let idx = { ratio: -1, median: -1, pop: -1, minor: -1, tract: -1 };
    let found = null;
    const streamResult = await streamTextCapped(resp, MAX_BYTES, (line) => {
      if (!line) return null;
      if (!hdrs) {
        hdrs = parseCsvLine(line);
        idx.ratio = hdrs.indexOf('tract_to_msa_income_percentage');
        idx.median = hdrs.indexOf('ffiec_msa_md_median_family_income');
        idx.pop = hdrs.indexOf('tract_population');
        idx.minor = hdrs.indexOf('tract_minority_population_percent');
        idx.tract = hdrs.indexOf('census_tract');
        if (idx.ratio < 0 || idx.tract < 0) return { stop: true };
        return null;
      }
      const v = parseCsvLine(line);
      const cand = v[idx.tract] || '';
      const candNorm = normalizeTractId(cand);
      const matches = candNorm === tractId || cand === tractId || cand === shortTract || cand === shortTractInt;
      if (!matches) return null;
      const rawRatio = v[idx.ratio];
      if (!rawRatio) return null;
      const r = parseFloat(rawRatio);
      if (!isFinite(r) || r < 0) return null;
      found = { values: v, ratio: r };
      return { stop: true };
    });
    if (streamResult.tooLarge) {
      attempts.push({
        year, scope, ok: false, reason: 'response_too_large',
        bytesRead: streamResult.bytesRead,
        hint: 'CFPB filters likely ignored — response exceeded 2MB cap.',
      });
      return null;
    }
    if (!hdrs) {
      attempts.push({ year, scope, ok: false, reason: 'no_headers_in_stream', bytesRead: streamResult.bytesRead, firstLine: streamResult.firstLine });
      return null;
    }
    if (idx.ratio < 0 || idx.tract < 0) {
      attempts.push({ year, scope, ok: false, reason: 'columns_missing', headers: hdrs.slice(0, 20), bytesRead: streamResult.bytesRead });
      return null;
    }
    if (!found) {
      attempts.push({ year, scope, ok: false, reason: 'tract_not_found_in_response', bytesRead: streamResult.bytesRead });
      return null;
    }
    return {
      ok: true,
      tractId,
      incomeRatio: found.ratio,
      level: classifyIncomeRatio(found.ratio),
      year,
      medianFamilyIncome: idx.median >= 0 ? (parseInt(found.values[idx.median]) || 0) : 0,
      tractPopulation: idx.pop >= 0 ? (parseInt(found.values[idx.pop]) || 0) : 0,
      minorityPct: idx.minor >= 0 ? (parseFloat(found.values[idx.minor]) || 0) : 0,
      censusTractField: found.values[idx.tract] || '',
      source: 'cfpb_' + scope,
    };
  }

  for (const y of [2023, 2022]) {
    const r = await tryCfpbCsv(y, 'tract');
    if (r) {
      if (env.KV_NAMESPACE) { try { await env.KV_NAMESPACE.put(cacheKey, JSON.stringify(r), { expirationTtl: 60*60*24*30 }); } catch (e) {} }
      return r;
    }
  }

  // ── PATH B: Census ACS API (FALLBACK — county-MFI proxy for MSA MFI) ──
  // Only reached if CFPB above fails. Each ACS request returns ~200 bytes
  // of JSON. We compute ratio ≈ (tract MFI / county MFI) × 100. Exact for
  // single-county MSAs (Stockton = San Joaquin County) and within a few
  // % for multi-county MSAs — any classification drift is at most one
  // tier in rare edge cases. ACS variable B19113_001E = median family
  // income.
  const acsYears = [2022, 2021, 2020, 2019, 2018];
  for (const year of acsYears) {
    let tractMfi = null, countyMfi = null;
    try {
      const tUrl = 'https://api.census.gov/data/' + year + '/acs/acs5'
        + '?get=B19113_001E'
        + '&for=tract:' + tractSix
        + '&in=state:' + stateFips + '%20county:' + countyFips3Digit;
      const tr = await fetch(tUrl, { headers: { 'User-Agent': 'LMI-Tool/1.0', 'Accept': 'application/json' } });
      if (!tr.ok) {
        let b = ''; try { b = (await tr.text()).slice(0, 200); } catch (e) {}
        attempts.push({ year, scope: 'acs_tract', ok: false, status: tr.status, bodySample: b });
        continue;
      }
      const tj = await tr.json();
      if (!Array.isArray(tj) || tj.length < 2) {
        attempts.push({ year, scope: 'acs_tract', ok: false, reason: 'bad_json_shape' });
        continue;
      }
      const raw = tj[1][0];
      const n = parseInt(raw, 10);
      if (!isFinite(n) || n <= 0) {
        attempts.push({ year, scope: 'acs_tract', ok: false, reason: 'no_value', rawValue: raw });
        continue;
      }
      tractMfi = n;
    } catch (e) {
      attempts.push({ year, scope: 'acs_tract', ok: false, reason: 'fetch_threw', error: String(e && e.message || e) });
      continue;
    }
    try {
      const cUrl = 'https://api.census.gov/data/' + year + '/acs/acs5'
        + '?get=B19113_001E'
        + '&for=county:' + countyFips3Digit
        + '&in=state:' + stateFips;
      const cr = await fetch(cUrl, { headers: { 'User-Agent': 'LMI-Tool/1.0', 'Accept': 'application/json' } });
      if (!cr.ok) {
        let b = ''; try { b = (await cr.text()).slice(0, 200); } catch (e) {}
        attempts.push({ year, scope: 'acs_county', ok: false, status: cr.status, bodySample: b });
        continue;
      }
      const cj = await cr.json();
      if (!Array.isArray(cj) || cj.length < 2) {
        attempts.push({ year, scope: 'acs_county', ok: false, reason: 'bad_json_shape' });
        continue;
      }
      const raw = cj[1][0];
      const n = parseInt(raw, 10);
      if (!isFinite(n) || n <= 0) {
        attempts.push({ year, scope: 'acs_county', ok: false, reason: 'no_value', rawValue: raw });
        continue;
      }
      countyMfi = n;
    } catch (e) {
      attempts.push({ year, scope: 'acs_county', ok: false, reason: 'fetch_threw', error: String(e && e.message || e) });
      continue;
    }
    const ratio = (tractMfi / countyMfi) * 100;
    if (!isFinite(ratio) || ratio < 0) continue;
    const result = {
      ok: true,
      tractId,
      incomeRatio: Math.round(ratio * 100) / 100,
      level: classifyIncomeRatio(ratio),
      year,
      medianFamilyIncome: countyMfi,
      tractMfi,
      tractPopulation: 0,
      minorityPct: 0,
      source: 'acs_computed_county_proxy',
      note: 'Ratio computed from ACS 5-year tract MFI / county MFI. FFIEC uses HUD-estimated MSA MFI; county is a proxy that is exact for single-county MSAs (like Stockton) and within a few % for multi-county MSAs.',
    };
    if (env.KV_NAMESPACE) { try { await env.KV_NAMESPACE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60*60*24*30 }); } catch (e) {} }
    return result;
  }

  return { ok: false, reason: 'no_source_resolved', tractId, attempts };
}

// ═══════════════════════════════════════════════════════════════════════
// ADDRESS VERIFICATION — proves our classification matches FFIEC's
// authoritative Geocoder (https://geomap.ffiec.gov). Super-admins can
// paste any address and see what our system computes. The response
// includes a deep-link to FFIEC's own tool for instant cross-check.
// ═══════════════════════════════════════════════════════════════════════
async function handleAdminVerifyAddress(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }

  let body = {};
  try { body = await request.json(); } catch (e) { /* empty body OK */ }
  const rawAddress = String(body.address || '').trim();
  if (!rawAddress) {
    return jsonResponse({ ok: false, error: 'missing_address', message: 'Pass { "address": "..." } in the POST body.' }, request, 400);
  }

  // Step 1: address → tract via Census Geocoder (authoritative).
  const g = await geocodeAddressOneLine(rawAddress, env);
  if (!g.ok) {
    return jsonResponse({
      ok: false,
      error: 'address_not_found',
      reason: g.reason,
      message: 'Census Geocoder could not resolve this address. Try the standard format: "921 S Aurora St, Stockton, CA 95206".',
      input: rawAddress,
    }, request, 404);
  }

  const tractId = g.tractId;
  const matched = g.matchedAddress;
  const zipMatch = (matched || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = zipMatch ? zipMatch[1] : '';

  // Step 2: tract GEOID → FFIEC income ratio (authoritative, tract-level).
  const info = await fetchTractIncomeRatio(tractId, env);
  const classification = info.ok ? info.level : 'Unknown';
  const incomeRatio = info.ok ? info.incomeRatio : null;
  const qualifiesCRA = (classification === 'Low' || classification === 'Moderate');

  // Step 3 (diagnostic): cross-check by FCC lat/lon and by ZIP-list lookup.
  // These don't affect the classification; they just show in the response
  // so the admin can see if legacy paths disagree with the authoritative path.
  let fccCross = null;
  if (g.lat != null && g.lon != null) {
    const fccTract = await geocodeToTract(g.lat, g.lon, env);
    fccCross = {
      fccTractId: fccTract || null,
      matchesCensus: fccTract === tractId,
      note: fccTract === tractId
        ? 'FCC Block Find agrees with Census Geocoder.'
        : 'FCC Block Find returned a DIFFERENT tract than Census Geocoder. Census is authoritative; this is likely why old pipeline mis-classified.',
    };
  }
  let zipListCross = null;
  if (zip) {
    const lookup = await fetchLmiTractsForZip(zip);
    const found = lookup.ok ? lookup.tracts.find(t => t.tract_id_normalized === tractId) : null;
    zipListCross = {
      zip,
      ok: lookup.ok,
      reason: lookup.reason || null,
      totalTractsInZipList: lookup.ok ? lookup.tracts.length : 0,
      tractFoundInZipList: !!found,
      note: found
        ? 'Tract is in the FFIEC ZIP list (old pipeline would find it).'
        : 'Tract is NOT in the FFIEC ZIP list for ' + zip + '. Old pipeline would tag this listing as "Unknown" and filtering by Low would hide it. The new v2 pipeline queries by tract GEOID directly and does not depend on the ZIP list.',
    };
  }

  const ffiecLink = 'https://geomap.ffiec.gov/FFIECGeocMap/GeocodeMap1.aspx?address=' + encodeURIComponent(matched);

  return jsonResponse({
    ok: true,
    input: rawAddress,
    matchedAddress: matched,
    coordinates: { lat: g.lat, lon: g.lon },
    tractId,
    stateFips: g.stateFips,
    countyFips: g.countyFips,
    tractCode: g.tractCode,
    zip,
    ourClassification: classification,
    ourIncomeRatio: incomeRatio,
    qualifiesCRA,
    ffiecYear: info.ok ? info.year : null,
    ffiecMedianFamilyIncome: info.ok ? info.medianFamilyIncome : null,
    dataSource: 'Census Geocoder onelineaddress → CFPB Data Browser tract-direct query (same tract_to_msa_income_percentage field FFIEC Geocoder uses).',
    ratioFetchReason: info.ok ? null : info.reason,
    fccCrossCheck: fccCross,
    zipListCrossCheck: zipListCross,
    ffiecGeocoderLink: ffiecLink,
  }, request);
}

// ═══════════════════════════════════════════════════════════════════════
// TRACE ADDRESS — full-pipeline diagnostic. Shows every step of the v2
// classification pipeline for a single address, plus the legacy paths
// (FCC + ZIP-list lookup) for comparison. Use this to see *exactly* why
// a listing is classified the way it is, or why FFIEC Geocoder disagrees.
// ═══════════════════════════════════════════════════════════════════════
async function handleAdminTraceAddress(request, env) {
  try { await requireSuperAdmin(request, env); } catch (e) { return adminErrorResponse(e, request); }

  let body = {};
  try { body = await request.json(); } catch (e) { /* empty OK */ }
  const rawAddress = String(body.address || '').trim();
  if (!rawAddress) {
    return jsonResponse({ ok: false, error: 'missing_address', message: 'POST body: { "address": "..." }' }, request, 400);
  }

  const trace = {
    input: rawAddress,
    steps: [],
    final: null,
  };

  // Wrap the entire pipeline in a top-level try/catch so any unhandled
  // exception propagates back to the client as a structured error rather
  // than a generic 500. Each step also has its own try/catch so one
  // failure doesn't abort the rest of the diagnostic.
  try {
    // ───── Step 1: Census Geocoder (v2 primary path) ─────
    let geocode;
    try {
      geocode = await geocodeAddressOneLine(rawAddress, env);
    } catch (e) {
      geocode = { ok: false, reason: 'step1_exception', error: String(e && e.message || e) };
    }
    trace.steps.push({
      name: 'Step 1 — Census Geocoder (address → tract)',
      api: 'geocoding.geo.census.gov/geocoder/geographies/onelineaddress',
      ok: !!(geocode && geocode.ok),
      result: (geocode && geocode.ok) ? {
        matchedAddress: geocode.matchedAddress,
        tractId: geocode.tractId,
        coordinates: { lat: geocode.lat, lon: geocode.lon },
        stateFips: geocode.stateFips,
        countyFips: geocode.countyFips,
        tractCode: geocode.tractCode,
      } : { reason: geocode ? geocode.reason : 'unknown', error: geocode ? geocode.error : null },
    });

    const tractId = (geocode && geocode.ok) ? geocode.tractId : null;
    const matched = (geocode && geocode.ok) ? geocode.matchedAddress : rawAddress;
    const lat = (geocode && geocode.ok) ? geocode.lat : null;
    const lon = (geocode && geocode.ok) ? geocode.lon : null;
    const zipMatch = matched.match(/\b(\d{5})(?:-\d{4})?\b/);
    const zip = zipMatch ? zipMatch[1] : '';

    // ───── Step 2: FCC Block Find (legacy path, for comparison) ─────
    let fccInfo = null;
    let fccError = null;
    if (lat != null && lon != null) {
      try {
        const fccTract = await geocodeToTract(lat, lon, env);
        fccInfo = { fccTractId: fccTract || null, agreesWithCensus: fccTract === tractId };
      } catch (e) {
        fccError = String(e && e.message || e);
      }
    }
    trace.steps.push({
      name: 'Step 2 — FCC Block Find (lat/lon → tract, legacy path)',
      api: 'geo.fcc.gov/api/census/block/find',
      ok: !!(fccInfo && fccInfo.fccTractId),
      result: fccInfo || { reason: fccError ? 'step2_exception' : 'no_coords', error: fccError },
      note: fccInfo && !fccInfo.agreesWithCensus
        ? 'FCC snapped to a DIFFERENT tract than Census Geocoder. When this happens for a real listing, the old pipeline mis-classifies it. The v2 pipeline uses Census Geocoder as the authoritative source.'
        : null,
    });

    // ───── Step 3: CFPB tract-direct income ratio (v2 primary) ─────
    let info = null;
    let infoError = null;
    if (tractId) {
      try {
        info = await fetchTractIncomeRatio(tractId, env);
      } catch (e) {
        infoError = String(e && e.message || e);
      }
    }
    trace.steps.push({
      name: 'Step 3 — CFPB Data Browser (tract → income ratio)',
      api: 'ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv?states={SS}&counties={SSCCC}&census_tracts={GEOID}',
      ok: !!(info && info.ok),
      result: (info && info.ok) ? {
        tractId: info.tractId,
        incomeRatio: info.incomeRatio,
        level: info.level,
        year: info.year,
        source: info.source,
        medianFamilyIncome: info.medianFamilyIncome,
        tractPopulation: info.tractPopulation,
        minorityPct: info.minorityPct,
      } : {
        reason: info ? info.reason : (infoError ? 'step3_exception' : 'no_tract_id'),
        error: infoError,
        // When present, `attempts` shows every year/scope the helper tried
        // and why each one failed — HTTP status, body sample, missing
        // columns, etc. This is the data we need to diagnose the query.
        attempts: info && info.attempts ? info.attempts : undefined,
      },
    });

    // ───── Step 4: CFPB ZIP-list lookup (legacy path, for comparison) ─────
    let zipList = null;
    let zipError = null;
    if (zip) {
      try {
        const r = await fetchLmiTractsForZip(zip);
        const found = r.ok && tractId ? r.tracts.find(t => t.tract_id_normalized === tractId) : null;
        zipList = {
          zip,
          ok: r.ok,
          reason: r.reason || null,
          totalTractsInZipList: r.ok ? r.tracts.length : 0,
          tractFoundInZipList: !!found,
          tractRow: found || null,
        };
      } catch (e) {
        zipError = String(e && e.message || e);
      }
    }
    trace.steps.push({
      name: 'Step 4 — CFPB ZIP-list lookup (legacy path, for comparison)',
      api: 'ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv?zip_codes={ZIP}',
      ok: !!(zipList && zipList.ok),
      result: zipList || { reason: zipError ? 'step4_exception' : 'no_zip', error: zipError },
      note: zipList && !zipList.tractFoundInZipList
        ? 'Tract is NOT in the FFIEC ZIP list. This is a known edge case — tracts that straddle ZIPs may be absent from the dominant ZIP query. The old pipeline would tag listings in this tract as "Unknown" and the Low filter would hide them. The v2 pipeline does not depend on this lookup.'
        : null,
    });

    // ───── Final classification — uses the v2 primary path ─────
    const finalRatio = (info && info.ok) ? info.incomeRatio : null;
    const finalLevel = classifyIncomeRatio(finalRatio);
    const qualifiesCRA = (finalLevel === 'Low' || finalLevel === 'Moderate');
    trace.final = {
      matchedAddress: matched,
      tractId,
      incomeRatio: finalRatio,
      level: finalLevel,
      qualifiesCRA,
      ffiecYear: (info && info.ok) ? info.year : null,
      ffiecGeocoderLink: 'https://geomap.ffiec.gov/FFIECGeocMap/GeocodeMap1.aspx?address=' + encodeURIComponent(matched),
    };

    return jsonResponse({ ok: true, trace }, request);
  } catch (e) {
    return jsonResponse({
      ok: false,
      error: 'trace_internal_error',
      message: String(e && e.message || e),
      stack: String(e && e.stack || ''),
      partialTrace: trace,
    }, request, 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RE-ENRICH CACHE — re-runs v2 classification on every cached listing
// without calling RentCast. Use after a pipeline change (threshold fix,
// new geocoder) to refresh classifications on already-cached data with
// ZERO quota cost. Takes priorityZips by default, or an explicit list in
// body.zips.
// ═══════════════════════════════════════════════════════════════════════
async function handleAdminReenrichCache(request, env) {
  try { await requireSuperAdmin(request, env); } catch (e) { return adminErrorResponse(e, request); }
  if (!env.KV_NAMESPACE) {
    return jsonResponse({ ok: false, error: 'kv_not_bound' }, request, 500);
  }

  let body = {};
  try { body = await request.json(); } catch (e) { /* empty OK */ }
  const cfg = await readRentCastConfig(env);
  const reqZips = Array.isArray(body.zips) ? body.zips.filter(z => /^\d{5}$/.test(z)) : null;
  // Cloudflare Workers have a hard 1000-subrequest limit per invocation.
  // Each listing uses up to 2 subrequests (Census + CFPB) on first enrichment;
  // subsequent calls are served from KV cache. To be safe on the first run
  // before caches are warm, cap this handler at ~4 ZIPs per call (4 * ~50
  // listings * 2 = ~400 subrequests, well under the limit). The admin UI
  // chunks ZIPs client-side and calls this repeatedly until done.
  const MAX_ZIPS_PER_CALL = 4;
  const allZips = reqZips && reqZips.length ? reqZips : cfg.priorityZips;
  const zips = allZips.slice(0, MAX_ZIPS_PER_CALL);
  const skipped = allZips.slice(MAX_ZIPS_PER_CALL);

  const results = [];
  for (const zip of zips) {
    let cached = null;
    try { cached = await env.KV_NAMESPACE.get('for_sale_' + zip, 'json'); } catch (e) {}
    if (!cached || !Array.isArray(cached.listings)) {
      results.push({ zip, reenriched: false, reason: 'no_cache' });
      continue;
    }

    let reenriched;
    try {
      reenriched = await enrichListingsWithTracts(cached.listings, zip, env);
    } catch (e) {
      results.push({ zip, reenriched: false, reason: 'enrich_error', error: String(e && e.message || e) });
      continue;
    }

    const lmiCount = reenriched.filter(l => l.isLMI === true).length;
    const lowCount = reenriched.filter(l => l.tractIncomeLevel === 'Low').length;
    const modCount = reenriched.filter(l => l.tractIncomeLevel === 'Moderate').length;
    const unknownCount = reenriched.filter(l => l.tractIncomeLevel === 'Unknown').length;
    const updated = Object.assign({}, cached, {
      listings: reenriched,
      lmiCount,
      total: reenriched.length,
      enriched: true,
      enrichmentVersion: 2,
      reenrichedAt: new Date().toISOString(),
    });
    try {
      await env.KV_NAMESPACE.put('for_sale_' + zip, JSON.stringify(updated),
        { expirationTtl: 60 * 60 * 24 * 40 });
    } catch (e) {
      results.push({ zip, reenriched: false, reason: 'kv_write_failed', error: String(e) });
      continue;
    }

    results.push({
      zip,
      reenriched: true,
      total: updated.total,
      lmiCount,
      lowCount,
      moderateCount: modCount,
      unknownCount,
    });
  }

  const totals = results.reduce((acc, r) => {
    if (!r.reenriched) return acc;
    acc.zips++;
    acc.total += r.total || 0;
    acc.lmi += r.lmiCount || 0;
    acc.low += r.lowCount || 0;
    acc.moderate += r.moderateCount || 0;
    acc.unknown += r.unknownCount || 0;
    return acc;
  }, { zips: 0, total: 0, lmi: 0, low: 0, moderate: 0, unknown: 0 });

  return jsonResponse({
    ok: true,
    results,
    totals,
    skippedZips: skipped,         // let client know what's still left
    hasMore: skipped.length > 0,
    maxZipsPerCall: MAX_ZIPS_PER_CALL,
  }, request);
}

// Enriches listings with tract GEOID + CRA income level using the v2 pipeline:
//
//   1. Build full address string from the listing → Census Geocoder
//      (onelineaddress) → authoritative tract GEOID.
//   2. If Census can't match the address, fall back to lat/lon → FCC Block
//      Find → tract GEOID (less reliable; can snap to adjacent tract).
//   3. Tract GEOID → CFPB Data Browser (census_tracts=GEOID) → income
//      ratio → Low/Moderate/Middle/Upper classification.
//
// This is the fix for the "FFIEC says Low but our tool filters it out"
// problem. The old pipeline relied on lat/lon + a ZIP-level FFIEC lookup,
// both of which had edge-case failures. The new pipeline uses the same
// data sources FFIEC Geocoder itself uses.
//
// Bounded-concurrency map: runs `fn` over `items` with at most `concurrency`
// in flight at once. Prevents the thundering-herd Promise.all pattern from
// blowing through Census Geocoder's per-IP rate limits (~100/min) and
// Cloudflare's 1000-subrequest-per-invocation budget.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { __error: String(e && e.message || e) }; }
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length || 1) },
    worker
  );
  await Promise.all(workers);
  return results;
}

// Enriches listings in two deduped passes so we never fan out blindly:
//   Pass 1: geocode addresses → tractId (bounded concurrency, ~8 at a time)
//   Pass 2: fetch income ratio for each UNIQUE tract only (also bounded)
//   Pass 3: splice the per-tract ratio back onto each listing
// Many listings in a ZIP share 3-5 tracts, so Pass 2 typically reduces
// CFPB/ACS calls by 10-25x and keeps first-time runs inside the Worker's
// subrequest budget. Second-and-later runs are ~all KV cache hits.
async function enrichListingsWithTracts(listings, zip, env) {
  const GEOCODE_CONCURRENCY = 8;
  const RATIO_CONCURRENCY = 5;

  // ── Pass 1: address → tractId ────────────────────────────────────────
  const geocoded = await mapWithConcurrency(listings, GEOCODE_CONCURRENCY, async (l) => {
    const addrPieces = [];
    if (l.address) addrPieces.push(String(l.address).trim());
    const addrLower = (l.address || '').toLowerCase();
    if (l.city && !addrLower.includes(String(l.city).toLowerCase())) addrPieces.push(l.city);
    if (l.state && !addrLower.includes(String(l.state).toLowerCase())) addrPieces.push(l.state || 'CA');
    else if (!l.state) addrPieces.push('CA');
    const zipStr = l.zip || zip;
    if (zipStr && !addrLower.includes(zipStr)) addrPieces.push(zipStr);
    const fullAddress = addrPieces.filter(Boolean).join(', ');

    let geocodeSource = 'none';
    let geocodeReason = null;
    let tractId = null;
    let matchedAddress = null;

    if (fullAddress) {
      const g = await geocodeAddressOneLine(fullAddress, env);
      if (g.ok) {
        tractId = g.tractId;
        matchedAddress = g.matchedAddress;
        geocodeSource = 'census_onelineaddress';
      } else {
        geocodeReason = g.reason || 'geocode_failed';
      }
    }

    if (!tractId && l.latitude != null && l.longitude != null) {
      const fccTract = await geocodeToTract(l.latitude, l.longitude, env);
      if (fccTract) {
        tractId = fccTract;
        geocodeSource = 'fcc_block_find_fallback';
      }
    }

    return { listing: l, tractId, matchedAddress, geocodeSource, geocodeReason };
  });

  // ── Pass 2: UNIQUE tractId → income ratio (deduped) ──────────────────
  const uniqueTracts = Array.from(new Set(
    geocoded
      .filter(r => r && !r.__error && r.tractId)
      .map(r => r.tractId)
  ));
  const ratioByTract = new Map();
  await mapWithConcurrency(uniqueTracts, RATIO_CONCURRENCY, async (tractId) => {
    const info = await fetchTractIncomeRatio(tractId, env);
    ratioByTract.set(tractId, info);
  });

  // ── Pass 3: assemble final listings with provenance ──────────────────
  return geocoded.map((r, i) => {
    const original = listings[i];
    if (!r || r.__error) {
      return {
        ...original,
        tractId: null,
        matchedAddress: null,
        tractIncomeRatio: null,
        tractIncomeLevel: 'Unknown',
        isLMI: null,
        geocodeSource: 'error',
        geocodeReason: r && r.__error ? r.__error : 'unknown_error',
        ratioSource: null,
        ratioYear: null,
        ratioReason: null,
      };
    }
    const info = r.tractId ? ratioByTract.get(r.tractId) : null;
    const ok = info && info.ok;
    const level = ok ? info.level : 'Unknown';
    const isLMI = ok ? (level === 'Low' || level === 'Moderate') : null;
    return {
      ...original,
      tractId: r.tractId || null,
      matchedAddress: r.matchedAddress || null,
      tractIncomeRatio: ok ? info.incomeRatio : null,
      tractIncomeLevel: level,
      isLMI,
      geocodeSource: r.geocodeSource,
      geocodeReason: r.geocodeReason,
      ratioSource: ok ? info.source : null,
      ratioYear: ok ? info.year : null,
      ratioReason: ok ? null : (info && info.reason) || (r.tractId ? null : 'no_tract_id'),
    };
  });
}

// ─────────────────────────────────────────
// For-sale endpoint — READS FROM KV CACHE ONLY.
// This handler NEVER calls RentCast live. All RentCast calls happen via the
// scheduled refresh path (cron or admin "Run Refresh Now"), which enforces
// the hard 50/month cap. That way there is no code path where frontend
// traffic can drain the quota.
// GET /for-sale?zip=XXXXX
// ─────────────────────────────────────────
async function handleForSale(request, env) {
  const url = new URL(request.url);
  const zip = url.searchParams.get('zip') || '';

  if (!/^\d{5}$/.test(zip)) {
    return jsonResponse({ error: 'Invalid zip code' }, request, 400);
  }

  const cacheKey = `for_sale_${zip}`;

  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(cacheKey, 'json');
      if (cached) {
        return jsonResponse({ ...cached, fromCache: true }, request);
      }
    } catch (e) { /* KV error — fall through to "not available" response */ }
  }

  // No cached data for this ZIP. Return a structured empty response so the
  // frontend can show a friendly "not on priority list" message.
  return jsonResponse({
    zip,
    generatedAt: new Date().toISOString(),
    total: 0,
    listings: [],
    sources: { rentcast: 0 },
    fromCache: false,
    notAvailable: true,
    reason: 'zip_not_in_priority_list',
    message: 'This ZIP is not in the scheduled refresh list. A super admin can add it from the RentCast Data page.',
  }, request);
}

// ─────────────────────────────────────────
// Public priority-ZIP list — what the LMI search dropdown consumes.
// Returns only ZIPs that currently have cached data (so the dropdown
// never advertises a ZIP that would return "not available").
// ─────────────────────────────────────────
async function handlePriorityZips(request, env) {
  const cfg = await readRentCastConfig(env);
  const zips = Array.isArray(cfg.priorityZips) ? cfg.priorityZips : [];
  let entries = zips.map(z => ({ zip: z, city: ZIP_TO_CITY[z] || '', cached: false, total: 0 }));

  if (env.KV_NAMESPACE && entries.length) {
    try {
      const checks = await Promise.all(entries.map(async (e) => {
        const v = await env.KV_NAMESPACE.get('for_sale_' + e.zip, 'json');
        return v ? { cached: true, total: v.total || 0 } : { cached: false, total: 0 };
      }));
      entries = entries.map((e, i) => ({ ...e, cached: checks[i].cached, total: checks[i].total }));
    } catch (e) { /* non-critical — show without cache info */ }
  }

  // Only expose ZIPs that actually have listings cached. Pending ones are
  // hidden so the user never picks a ZIP that returns "not available."
  const visible = entries.filter(e => e.cached);
  visible.sort((a, b) => {
    if (a.city !== b.city) return (a.city || 'zzz').localeCompare(b.city || 'zzz');
    return a.zip.localeCompare(b.zip);
  });

  return jsonResponse({ zips: visible, totalCached: visible.length, totalConfigured: entries.length }, request);
}

// ─────────────────────────────────────────
// Master orchestrator
// ─────────────────────────────────────────
async function handlePropertyIntelligence(request, env) {
  const url = new URL(request.url);
  const tractId = url.searchParams.get('tractId');
  const zip = url.searchParams.get('zip');
  const county = url.searchParams.get('county') || '';
  const state = 'CA';

  if (!tractId || !zip) {
    return jsonResponse({ error: 'tractId and zip are required' }, request, 400);
  }

  // Check KV cache first (6 hours)
  const cacheKey = `prop_intel_${tractId}_${zip}`;
  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(cacheKey, 'json');
      if (cached) {
        return jsonResponse({ ...cached, fromCache: true }, request);
      }
    } catch (e) { /* KV not configured — continue without cache */ }
  }

  // Run all data sources in parallel
  const [
    assessorData,
    hudListings,
    homePathListings,
    homeStepsListings,
    hmdaData,
    deedRecordings,
    craigslistListings,
  ] = await Promise.allSettled([
    fetchAssessorData(tractId, county, state, env),
    fetchHudListings(zip, env),
    fetchHomePathListings(zip, env),
    fetchHomeStepsListings(zip, env),
    fetchHmdaData(tractId, env),
    fetchDeedRecordings(tractId, county, env),
    fetchCraigslistListings(zip, state),
  ]);

  // Extract successful results
  const properties = assessorData.status === 'fulfilled' ? assessorData.value : [];
  const govListings = [
    ...(hudListings.status === 'fulfilled' ? hudListings.value : []),
    ...(homePathListings.status === 'fulfilled' ? homePathListings.value : []),
    ...(homeStepsListings.status === 'fulfilled' ? homeStepsListings.value : []),
  ];
  const hmda = hmdaData.status === 'fulfilled' ? hmdaData.value : {};
  const deeds = deedRecordings.status === 'fulfilled' ? deedRecordings.value : [];
  const cl = craigslistListings.status === 'fulfilled' ? craigslistListings.value : [];

  // Score and correlate all properties
  const scored = scoreAndCorrelate(properties, govListings, deeds, hmda, cl);

  // Enrich top 20 scored properties with Zillow (rate limited)
  const topProperties = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  const enriched = env.RAPIDAPI_KEY
    ? await enrichWithZillow(topProperties, env)
    : topProperties;

  // Build remaining (non-enriched) properties
  const enrichedAddrs = new Set(enriched.map(p => normalizeAddress(p.address)));
  const remaining = scored
    .filter(p => !enrichedAddrs.has(normalizeAddress(p.address)))
    .sort((a, b) => b.score - a.score);

  const allProperties = [...enriched, ...remaining];

  const result = {
    tractId,
    zip,
    county,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(allProperties, hmda),
    properties: allProperties,
    hmdaInsights: hmda,
    dataSources: {
      assessor: assessorData.status === 'fulfilled' ? properties.length : 0,
      hud: hudListings.status === 'fulfilled' ? hudListings.value.length : 0,
      homepath: homePathListings.status === 'fulfilled' ? homePathListings.value.length : 0,
      homesteps: homeStepsListings.status === 'fulfilled' ? homeStepsListings.value.length : 0,
      hmda: hmdaData.status === 'fulfilled' ? 'ok' : 'error',
      deeds: deedRecordings.status === 'fulfilled' ? deeds.length : 0,
      craigslist: craigslistListings.status === 'fulfilled' ? cl.length : 0,
    },
    fromCache: false,
  };

  // Cache for 6 hours
  if (env.KV_NAMESPACE) {
    try {
      await env.KV_NAMESPACE.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
    } catch (e) { /* KV write failed — non-critical */ }
  }

  return jsonResponse(result, request);
}

// ─────────────────────────────────────────
// Data source: California County Assessor
// ─────────────────────────────────────────
async function fetchAssessorData(tractId, county, state, env) {
  const countyFips = tractId.substring(0, 5);

  // Try LA County direct API (best coverage)
  if (countyFips === '06037') {
    return fetchLACountyAssessor(tractId, env);
  }

  // CA Open Data statewide parcel dataset via ArcGIS
  const response = await fetch(
    'https://services3.arcgis.com/fdvHcZXgKW4I5hLc/arcgis/rest/services/' +
    'California_Parcels/FeatureServer/0/query?' +
    'where=CENSUS_TRACT%3D%27' + encodeURIComponent(tractId) + '%27&' +
    'outFields=APN,SITUS_ADDR,OWNER_NAME,ASSD_VALUE,' +
    'LAST_SALE_DATE,LAST_SALE_PRICE,YEAR_BUILT,SQ_FT&' +
    'f=json&resultRecordCount=200',
    { headers: { 'User-Agent': 'LMI-Tool/1.0' } }
  );
  if (!response.ok) return [];
  const data = await response.json();
  return (data.features || []).map(f => ({
    apn: f.attributes.APN,
    address: f.attributes.SITUS_ADDR,
    owner: f.attributes.OWNER_NAME,
    assessedValue: f.attributes.ASSD_VALUE,
    lastSaleDate: f.attributes.LAST_SALE_DATE,
    lastSalePrice: f.attributes.LAST_SALE_PRICE,
    yearBuilt: f.attributes.YEAR_BUILT,
    sqft: f.attributes.SQ_FT,
    source: 'ca_assessor',
  }));
}

async function fetchLACountyAssessor(tractId, env) {
  try {
    const response = await fetch(
      'https://portal.assessor.lacounty.gov/api/search?tract=' +
      encodeURIComponent(tractId),
      { headers: { 'User-Agent': 'LMI-Tool/1.0', Accept: 'application/json' } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.results || data.Parcels || []).map(p => ({
      apn: p.AIN || p.apn,
      address: p.SitusAddress || p.address,
      owner: p.OwnerName || p.owner,
      assessedValue: p.TotalValue || p.assessedValue,
      lastSaleDate: p.LastSaleDate || p.lastSaleDate,
      lastSalePrice: p.LastSaleAmount || p.lastSalePrice,
      yearBuilt: p.YearBuilt || p.yearBuilt,
      sqft: p.SqFt || p.sqft,
      source: 'la_county_assessor',
    }));
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────
// DEPRECATED: HUD Homes (Free API) — kept for property-intelligence callers
// that still expect this function. Always returns [] now; real listings
// come from RentCast via the scheduled refresh path.
// ─────────────────────────────────────────
async function fetchHudListings(zip, env) { return []; }

// ─────────────────────────────────────────
// Data source: Fannie Mae HomePath
// ─────────────────────────────────────────
async function fetchHomePathListings(zip, env) { return []; }

// ─────────────────────────────────────────
// Data source: Freddie Mac HomeSteps
// ─────────────────────────────────────────
async function fetchHomeStepsListings(zip, env) { return []; }

// ─────────────────────────────────────────
// Data source: CFPB HMDA Lending Data
// ─────────────────────────────────────────
async function fetchHmdaData(tractId, env) {
  try {
    // CFPB HMDA currently only has data through 2023.
    const year = 2023;
    const response = await fetch(
      'https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations?' +
      'census_tracts=' + encodeURIComponent(tractId) + '&' +
      'years=' + year + '&' +
      'actions_taken=1,2,3&' +
      'loan_purposes=1',
      { headers: { 'User-Agent': 'LMI-Tool/1.0', Accept: 'application/json' } }
    );
    if (!response.ok) return {};
    const data = await response.json();

    const aggregations = data.aggregations || [];
    const total = aggregations.reduce((s, a) => s + (a.count || 0), 0);
    const originated = aggregations
      .filter(a => a.action_taken === 1 || a.action_taken_name === 'Loan originated')
      .reduce((s, a) => s + (a.count || 0), 0);

    return {
      tractId,
      year,
      totalApplications: total,
      originated,
      approvalRate: total > 0 ? Math.round((originated / total) * 100) : 0,
      medianIncome: data.median_family_income || null,
      minorityPct: data.minority_population_pct || null,
      lenders: data.lender_count || 0,
      avgLoanAmount: data.avg_loan_amount || 0,
      craOpportunityScore: calculateCraOpportunity(total, originated, data),
    };
  } catch (e) {
    return {};
  }
}

function calculateCraOpportunity(total, originated, data) {
  const approvalRate = total > 0 ? (originated / total) * 100 : 50;
  const minorityPct = parseFloat(data.minority_population_pct || 0);
  const lenderCount = data.lender_count || 5;

  let score = 0;
  if (approvalRate < 50) score += 30;
  if (approvalRate < 30) score += 20;
  if (minorityPct > 50) score += 25;
  if (minorityPct > 75) score += 15;
  if (lenderCount < 5) score += 10;

  return Math.min(score, 100);
}

// ─────────────────────────────────────────
// Data source: Deed Recordings
// ─────────────────────────────────────────
async function fetchDeedRecordings(tractId, county, env) {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    const response = await fetch(
      'https://services3.arcgis.com/fdvHcZXgKW4I5hLc/arcgis/rest/' +
      'services/CA_Deed_Transfers/FeatureServer/0/query?' +
      "where=CENSUS_TRACT%3D'" + encodeURIComponent(tractId) + "'" +
      "%20AND%20TRANSFER_DATE%3E%3D'" + since + "'&" +
      'outFields=APN,SITUS_ADDR,BUYER_NAME,SELLER_NAME,' +
      'SALE_PRICE,TRANSFER_DATE,LOAN_AMOUNT,LENDER_NAME&' +
      'f=json&resultRecordCount=100',
      { headers: { 'User-Agent': 'LMI-Tool/1.0' } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.features || []).map(f => ({
      apn: f.attributes.APN,
      address: f.attributes.SITUS_ADDR,
      buyer: f.attributes.BUYER_NAME,
      seller: f.attributes.SELLER_NAME,
      salePrice: f.attributes.SALE_PRICE,
      transferDate: f.attributes.TRANSFER_DATE,
      loanAmount: f.attributes.LOAN_AMOUNT,
      lender: f.attributes.LENDER_NAME,
      source: 'deed_recording',
    }));
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────
// Data source: Craigslist RSS
// ─────────────────────────────────────────
const CL_REGIONS = {
  '93': 'fresno',
  '94': 'sacramento',
  '90': 'losangeles',
  '91': 'losangeles',
  '92': 'sandiego',
  '95': 'sfbay',
  '96': 'redding',
  '97': 'medford',
};

async function fetchCraigslistListings(zip, state) { return []; }

// ─────────────────────────────────────────
// Scoring and correlation engine
// ─────────────────────────────────────────
function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,#]/g, '')
    .trim();
}

function scoreAndCorrelate(properties, govListings, deeds, hmda, craigslist) {
  // Build lookup maps for fast correlation
  const govMap = new Map();
  govListings.forEach(l => {
    const key = normalizeAddress(l.address);
    if (key) govMap.set(key, l);
  });

  const deedMap = new Map();
  deeds.forEach(d => {
    const key = normalizeAddress(d.address);
    if (key) deedMap.set(key, d);
  });

  const clMap = new Map();
  craigslist.forEach(c => {
    const key = normalizeAddress(c.address);
    if (key) clMap.set(key, c);
  });

  // Also add gov listings and craigslist as standalone properties
  // if not already in assessor data
  const existingAddrs = new Set(properties.map(p => normalizeAddress(p.address)));

  govListings.forEach(l => {
    const key = normalizeAddress(l.address);
    if (key && !existingAddrs.has(key)) {
      properties.push({
        address: l.address,
        city: l.city,
        price: l.price,
        beds: l.beds,
        baths: l.baths,
        sqft: l.sqft,
        source: l.source,
      });
      existingAddrs.add(key);
    }
  });

  craigslist.forEach(c => {
    const key = normalizeAddress(c.address);
    if (key && !existingAddrs.has(key)) {
      properties.push({
        address: c.address,
        price: c.price,
        source: c.source,
        link: c.link,
      });
      existingAddrs.add(key);
    }
  });

  const craScore = hmda.craOpportunityScore || 0;

  return properties.map(prop => {
    const addrKey = normalizeAddress(prop.address);
    const govListing = govMap.get(addrKey);
    const deed = deedMap.get(addrKey);
    const clListing = clMap.get(addrKey);

    let score = 0;
    const signals = [];

    // Government listing = confirmed for sale
    if (govListing) {
      score += 100;
      signals.push({ type: 'confirmed_listing', source: govListing.source });
    }

    // Craigslist listing = confirmed for sale
    if (clListing) {
      score += 80;
      signals.push({ type: 'craigslist_listing', source: 'craigslist' });
    }

    // Recent deed transfer
    if (deed) {
      const transferTime = typeof deed.transferDate === 'number'
        ? deed.transferDate
        : new Date(deed.transferDate).getTime();
      const daysSince = Math.floor((Date.now() - transferTime) / 86400000);
      if (daysSince < 30) {
        score += 40;
        signals.push({ type: 'very_recent_transfer' });
      } else if (daysSince < 90) {
        score += 20;
        signals.push({ type: 'recent_transfer' });
      }
      // Investor buyer name patterns
      if (/LLC|INC|CORP|TRUST|INVEST/i.test(deed.buyer)) {
        score += 15;
        signals.push({ type: 'investor_buyer' });
      }
    }

    // Long-term owner = potential seller
    if (prop.lastSaleDate) {
      const saleTime = typeof prop.lastSaleDate === 'number'
        ? prop.lastSaleDate
        : new Date(prop.lastSaleDate).getTime();
      const yearsSinceSale = (Date.now() - saleTime) / (365 * 24 * 60 * 60 * 1000);
      if (yearsSinceSale > 10) {
        score += 10;
        signals.push({ type: 'long_term_owner' });
      }
    }

    // Significant appreciation
    if (prop.assessedValue && prop.lastSalePrice) {
      const appreciation = (prop.assessedValue - prop.lastSalePrice) / prop.lastSalePrice;
      if (appreciation > 0.3) {
        score += 15;
        signals.push({ type: 'significant_appreciation' });
      }
    }

    // CRA opportunity boost
    score += Math.round(craScore * 0.1);

    return {
      ...prop,
      score: Math.min(score, 100),
      signals,
      govListing: govListing || null,
      deedInfo: deed || null,
      craigslistListing: clListing || null,
      isConfirmed: !!govListing || !!clListing,
      isLikelyToList: score >= 40 && !govListing && !clListing,
      zillowData: null,
      listingAgent: null,
      agentPhone: null,
      agentEmail: null,
    };
  });
}

// ─────────────────────────────────────────
// Zillow enrichment (address-specific)
// ─────────────────────────────────────────
async function enrichWithZillow(properties, env) {
  if (!env.RAPIDAPI_KEY) return properties;

  const enriched = [];
  for (const prop of properties) {
    if (!prop.address) {
      enriched.push(prop);
      continue;
    }

    try {
      // Check KV cache for this address
      const addrKey = 'zillow_' + normalizeAddress(prop.address);
      if (env.KV_NAMESPACE) {
        const cached = await env.KV_NAMESPACE.get(addrKey, 'json');
        if (cached) {
          enriched.push(mergeZillowData(prop, cached));
          continue;
        }
      }

      // Rate limit: 1 request per 2 seconds
      await new Promise(r => setTimeout(r, 2000));

      const response = await fetch(
        'https://zillow-com1.p.rapidapi.com/property?' +
        'address=' + encodeURIComponent(prop.address + ' CA'),
        {
          headers: {
            'X-RapidAPI-Key': env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'zillow-com1.p.rapidapi.com',
          },
        }
      );

      if (!response.ok) {
        enriched.push(prop);
        continue;
      }

      const zData = await response.json();
      const zillowData = {
        zestimate: zData.zestimate,
        listPrice: zData.price,
        listStatus: zData.homeStatus,
        beds: zData.bedrooms,
        baths: zData.bathrooms,
        sqft: zData.livingArea,
        yearBuilt: zData.yearBuilt,
        daysOnMarket: zData.daysOnZillow,
        listingAgent: zData.attributionInfo?.agentName,
        agentEmail: zData.attributionInfo?.agentEmail,
        agentPhone: zData.attributionInfo?.agentPhoneNumber,
        brokerage: zData.attributionInfo?.brokerName,
        photos: (zData.photos || zData.responsivePhotos || []).slice(0, 3).map(
          p => p.url || p.mixedSources?.jpeg?.[0]?.url || ''
        ).filter(Boolean),
        zillowUrl: zData.hdpUrl ? 'https://zillow.com' + zData.hdpUrl : null,
        isForSale: zData.homeStatus === 'FOR_SALE',
      };

      // Cache for 24 hours
      if (env.KV_NAMESPACE) {
        try {
          await env.KV_NAMESPACE.put(addrKey, JSON.stringify(zillowData), { expirationTtl: 86400 });
        } catch (e) { /* non-critical */ }
      }

      enriched.push(mergeZillowData(prop, zillowData));
    } catch (e) {
      enriched.push(prop);
    }
  }

  return enriched;
}

function mergeZillowData(prop, zillowData) {
  const isConfirmed = prop.isConfirmed || zillowData.isForSale;
  return {
    ...prop,
    zillowData,
    isConfirmed,
    beds: prop.beds || zillowData.beds,
    baths: prop.baths || zillowData.baths,
    sqft: prop.sqft || zillowData.sqft,
    yearBuilt: prop.yearBuilt || zillowData.yearBuilt,
    listingAgent: zillowData.listingAgent || null,
    agentPhone: zillowData.agentPhone || null,
    agentEmail: zillowData.agentEmail || null,
    brokerage: zillowData.brokerage || null,
  };
}

// ─────────────────────────────────────────
// Summary builder
// ─────────────────────────────────────────
function buildSummary(properties, hmda) {
  const confirmed = properties.filter(p => p.isConfirmed);
  const likelyToList = properties.filter(p => p.isLikelyToList);
  const withAgents = properties.filter(p => p.listingAgent);
  const govListings = properties.filter(p => p.govListing !== null);

  const confirmedPrices = confirmed
    .map(p => p.zillowData?.listPrice || p.govListing?.price || p.price || 0)
    .filter(p => p > 0);

  return {
    totalProperties: properties.length,
    confirmedListings: confirmed.length,
    likelyToListCount: likelyToList.length,
    governmentOwned: govListings.length,
    withListingAgent: withAgents.length,
    avgListPrice: confirmedPrices.length > 0
      ? Math.round(confirmedPrices.reduce((s, p) => s + p, 0) / confirmedPrices.length)
      : null,
    craOpportunityScore: hmda.craOpportunityScore || 0,
    approvalRate: hmda.approvalRate || 0,
    totalHmdaLoans: hmda.totalApplications || 0,
    activeLenders: hmda.lenders || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RENTCAST — BELT-AND-SUSPENDERS QUOTA ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════
// Architecture:
//   1. Single hard-coded constant RENTCAST_MONTHLY_LIMIT defines the cap.
//   2. All RentCast calls go through fetchRentCastListings(zip, env) which
//      calls consumeRentCastQuota(env) FIRST. The counter is incremented
//      BEFORE the fetch — so even if fetch fails, the counter has advanced
//      (conservative / bias toward under-using).
//   3. Counter is stored in KV under rentcast_count_YYYY_MM. Monthly key
//      auto-rolls at month boundary; counter restarts at 0 automatically.
//   4. KV key has a 40-day TTL so stale counters are garbage-collected.
//   5. There are only TWO entry points that can ever consume quota:
//         - runScheduledRefresh()  (cron and admin "Run Refresh Now")
//         - (that's it — no other)
//      The public /for-sale endpoint never calls RentCast. Period.
//   6. Kill switch in KV config (rentcast_config.killSwitch) bypasses the
//      entire RentCast path independent of the counter.
// ═══════════════════════════════════════════════════════════════════════

function currentMonthKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}_${m}`;
}

function counterKvKey() {
  return `rentcast_count_${currentMonthKey()}`;
}

async function getRentCastUsage(env) {
  if (!env.KV_NAMESPACE) return { count: 0, limit: RENTCAST_MONTHLY_LIMIT, remaining: RENTCAST_MONTHLY_LIMIT, month: currentMonthKey() };
  try {
    const raw = await env.KV_NAMESPACE.get(counterKvKey());
    const count = Math.max(0, parseInt(raw || '0', 10) || 0);
    return {
      count,
      limit: RENTCAST_MONTHLY_LIMIT,
      remaining: Math.max(0, RENTCAST_MONTHLY_LIMIT - count),
      month: currentMonthKey(),
    };
  } catch (e) {
    return { count: 0, limit: RENTCAST_MONTHLY_LIMIT, remaining: RENTCAST_MONTHLY_LIMIT, month: currentMonthKey() };
  }
}

// consumeRentCastQuota: attempts to reserve 1 quota slot. Returns { ok: true }
// if reserved, { ok: false, reason, count, limit } if refused. Increments
// BEFORE returning so callers can't forget to update the counter.
async function consumeRentCastQuota(env) {
  if (!env.KV_NAMESPACE) {
    return { ok: false, reason: 'no_kv_binding' };
  }
  const cfg = await readRentCastConfig(env);
  if (cfg.killSwitch) {
    return { ok: false, reason: 'kill_switch_active' };
  }
  const key = counterKvKey();
  let current = 0;
  try {
    const raw = await env.KV_NAMESPACE.get(key);
    current = Math.max(0, parseInt(raw || '0', 10) || 0);
  } catch (e) {
    return { ok: false, reason: 'kv_read_failed' };
  }
  if (current >= RENTCAST_MONTHLY_LIMIT) {
    return { ok: false, reason: 'monthly_limit_reached', count: current, limit: RENTCAST_MONTHLY_LIMIT };
  }
  const next = current + 1;
  try {
    // 40 days TTL covers any month length and auto-expires old counters.
    await env.KV_NAMESPACE.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 40 });
  } catch (e) {
    return { ok: false, reason: 'kv_write_failed' };
  }
  return { ok: true, count: next, limit: RENTCAST_MONTHLY_LIMIT };
}

// The ONLY function in this worker that calls api.rentcast.io.
// It is the bottleneck — every path that wants listings goes through here.
async function fetchRentCastListings(zip, env) {
  if (!env.RENTCAST_API_KEY) {
    return { ok: false, reason: 'api_key_missing', listings: [] };
  }
  const reserve = await consumeRentCastQuota(env);
  if (!reserve.ok) {
    return { ok: false, reason: reserve.reason, count: reserve.count, limit: reserve.limit, listings: [] };
  }
  try {
    // IMPORTANT: status=Active filters out sold / expired / off-market listings.
    // Without this, RentCast's default response mixes active and inactive records,
    // which is why users were hitting "Show on Zillow" and landing on off-market
    // pages — the listings had already come down.
    const resp = await fetch(
      'https://api.rentcast.io/v1/listings/sale?zipCode=' + encodeURIComponent(zip) + '&status=Active&limit=100',
      { headers: { 'X-Api-Key': env.RENTCAST_API_KEY, 'Accept': 'application/json' } }
    );
    if (!resp.ok) {
      return { ok: false, reason: 'api_error_' + resp.status, listings: [] };
    }
    const raw = await resp.json();
    const rows = Array.isArray(raw) ? raw : (raw.listings || raw.data || []);
    // Defensive second pass — even with status=Active in the query, filter any
    // row whose explicit status field is non-Active, in case RentCast ever
    // changes their default behavior.
    const active = rows.filter(r => {
      if (!r || typeof r !== 'object') return false;
      const s = String(r.status || '').trim().toLowerCase();
      return s === '' || s === 'active';
    });
    const listings = active.map(r => ({
      address: r.formattedAddress || r.addressLine1 || r.address || '',
      city: r.city || '',
      state: r.state || 'CA',
      zip: r.zipCode || zip,
      // RentCast top-level lat/lon. Required for census-tract enrichment —
      // without these we can't CRA-tag a listing (it falls back to Unknown).
      latitude: isFinite(Number(r.latitude)) ? Number(r.latitude) : null,
      longitude: isFinite(Number(r.longitude)) ? Number(r.longitude) : null,
      price: Number(r.price) || null,
      beds: r.bedrooms || null,
      baths: r.bathrooms || null,
      sqft: r.squareFootage || null,
      yearBuilt: r.yearBuilt || null,
      propertyType: r.propertyType || null,
      listingType: r.listingType || null,
      status: r.status || 'Active',
      daysOnMarket: r.daysOnMarket || null,
      listedDate: r.listedDate || null,
      // RentCast's own URL to the source listing (MLS / broker / portal). When
      // present, this is the most reliable link — it points directly at the
      // real active listing. The client prefers this over a generated Zillow
      // search URL.
      link: r.url || null,
      source: 'rentcast',
      confirmed: true,
    }));
    return { ok: true, listings };
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', error: String(e && e.message || e), listings: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// KV CONFIG — admin page reads/writes this through the /admin endpoints.
// ═══════════════════════════════════════════════════════════════════════

const CONFIG_KV_KEY = 'rentcast_config';
const LAST_RUN_KV_KEY = 'rentcast_last_run';
const RUN_HISTORY_KV_KEY = 'rentcast_run_history';

async function readRentCastConfig(env) {
  if (!env.KV_NAMESPACE) return { ...DEFAULT_RENTCAST_CONFIG };
  try {
    const stored = await env.KV_NAMESPACE.get(CONFIG_KV_KEY, 'json');
    if (!stored) return { ...DEFAULT_RENTCAST_CONFIG };
    return {
      priorityZips: Array.isArray(stored.priorityZips) ? stored.priorityZips : [],
      scheduledDay: clampDay(stored.scheduledDay),
      killSwitch: !!stored.killSwitch,
    };
  } catch (e) {
    return { ...DEFAULT_RENTCAST_CONFIG };
  }
}

async function writeRentCastConfig(env, cfg) {
  if (!env.KV_NAMESPACE) throw new Error('KV not bound');
  const safe = {
    priorityZips: Array.isArray(cfg.priorityZips)
      ? cfg.priorityZips.filter(z => /^\d{5}$/.test(z)).slice(0, RENTCAST_MONTHLY_LIMIT)
      : [],
    scheduledDay: clampDay(cfg.scheduledDay),
    killSwitch: !!cfg.killSwitch,
  };
  await env.KV_NAMESPACE.put(CONFIG_KV_KEY, JSON.stringify(safe));
  return safe;
}

function clampDay(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(28, Math.max(1, n));
}

async function readLastRun(env) {
  if (!env.KV_NAMESPACE) return null;
  try { return await env.KV_NAMESPACE.get(LAST_RUN_KV_KEY, 'json'); } catch (e) { return null; }
}

async function writeLastRun(env, run) {
  if (!env.KV_NAMESPACE) return;
  try {
    await env.KV_NAMESPACE.put(LAST_RUN_KV_KEY, JSON.stringify(run));
    const prev = (await env.KV_NAMESPACE.get(RUN_HISTORY_KV_KEY, 'json')) || [];
    const next = [run, ...prev].slice(0, 12);
    await env.KV_NAMESPACE.put(RUN_HISTORY_KV_KEY, JSON.stringify(next));
  } catch (e) { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════
// ADMIN AUTH — shared secret model.
// The app uses a custom currentUser system (not Firebase Auth), so there is
// no real ID token to verify. Instead, the super admin sets a strong
// password as a Cloudflare secret (ADMIN_PASSWORD). The admin page prompts
// for it on first use, caches in sessionStorage, and sends it as a Bearer
// token. Constant-time comparison prevents timing attacks.
// ═══════════════════════════════════════════════════════════════════════

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function requireSuperAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new Error('admin_password_not_configured');
  const auth = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('no_auth_header');
  if (!constantTimeEqual(m[1].trim(), String(env.ADMIN_PASSWORD).trim())) throw new Error('bad_admin_password');
  return { ok: true };
}

function adminErrorResponse(err, request) {
  const msg = String(err && err.message || err || 'auth_failed');
  const status = msg === 'no_auth_header' || msg === 'bad_admin_password' ? 401 :
                 msg === 'admin_password_not_configured' ? 500 : 401;
  return jsonResponse({ error: msg }, request, status);
}

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINT HANDLERS
// ═══════════════════════════════════════════════════════════════════════

async function handleAdminStatus(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }
  const [usage, config, lastRun] = await Promise.all([
    getRentCastUsage(env),
    readRentCastConfig(env),
    readLastRun(env),
  ]);
  // Inventory of cached ZIPs (which ZIPs currently have listings in KV)
  let cachedZipInventory = [];
  if (env.KV_NAMESPACE) {
    try {
      const entries = await Promise.all(config.priorityZips.map(async (z) => {
        const v = await env.KV_NAMESPACE.get('for_sale_' + z, 'json');
        return { zip: z, cached: !!v, total: v ? v.total : 0, generatedAt: v ? v.generatedAt : null };
      }));
      cachedZipInventory = entries;
    } catch (e) { /* non-critical */ }
  }
  return jsonResponse({
    usage,
    config,
    defaults: { priorityZips: DEFAULT_PRIORITY_ZIPS },
    lastRun,
    cachedZipInventory,
    apiKeyConfigured: !!env.RENTCAST_API_KEY,
  }, request);
}

async function handleAdminConfig(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  const current = await readRentCastConfig(env);
  const merged = {
    priorityZips: Array.isArray(body.priorityZips) ? body.priorityZips : current.priorityZips,
    scheduledDay: body.scheduledDay !== undefined ? clampDay(body.scheduledDay) : current.scheduledDay,
    killSwitch: body.killSwitch !== undefined ? !!body.killSwitch : current.killSwitch,
  };
  const saved = await writeRentCastConfig(env, merged);
  return jsonResponse({ ok: true, config: saved }, request);
}

async function handleAdminResetDefaults(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }
  const current = await readRentCastConfig(env);
  const saved = await writeRentCastConfig(env, {
    ...current,
    priorityZips: DEFAULT_PRIORITY_ZIPS.slice(),
  });
  return jsonResponse({ ok: true, config: saved }, request);
}

// DANGER: Zeroes the current month's usage counter. Only call this if you're
// certain RentCast didn't actually charge quota for failed calls. Requires
// a confirmation token in the body so the endpoint can't be hit accidentally.
async function handleAdminResetCounter(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty body */ }
  if (body.confirm !== 'RESET') {
    return jsonResponse({ error: 'confirmation_required', hint: 'POST body must include {"confirm":"RESET"}' }, request, 400);
  }
  if (!env.KV_NAMESPACE) {
    return jsonResponse({ error: 'kv_not_bound' }, request, 500);
  }
  const key = counterKvKey();
  const before = await getRentCastUsage(env);
  try {
    await env.KV_NAMESPACE.delete(key);
  } catch (e) {
    return jsonResponse({ error: 'kv_delete_failed', detail: String(e && e.message || e) }, request, 500);
  }
  return jsonResponse({ ok: true, reset: true, month: currentMonthKey(), before: before.count, after: 0, limit: RENTCAST_MONTHLY_LIMIT }, request);
}

async function handleAdminRefreshNow(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }
  const run = await runScheduledRefresh(env, 'manual');
  return jsonResponse({ ok: true, run }, request);
}

// Refresh a single ZIP — burns exactly 1 RentCast quota slot. Used by the
// admin page "Refresh one ZIP" button so super-admins can test changes
// (status=Active filter, URL field, etc.) without burning their whole
// remaining quota on a full refresh. The ZIP does NOT need to be in the
// priority list for this endpoint, so admins can test arbitrary ZIPs.
async function handleAdminRefreshZip(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    return adminErrorResponse(e, request);
  }

  let body = {};
  try { body = await request.json(); } catch (e) { /* body may be empty */ }
  const zip = String(body.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return jsonResponse({ ok: false, error: 'invalid_zip', message: 'Provide a 5-digit ZIP in the POST body as { "zip": "12345" }.' }, request, 400);
  }

  const cfg = await readRentCastConfig(env);
  if (cfg.killSwitch) {
    return jsonResponse({ ok: false, error: 'kill_switch_active', message: 'RentCast kill switch is on. Disable it in the admin panel first.' }, request, 409);
  }

  const usageBefore = await getRentCastUsage(env);
  if (usageBefore.count >= RENTCAST_MONTHLY_LIMIT) {
    return jsonResponse({
      ok: false,
      error: 'monthly_limit_reached',
      message: 'Monthly RentCast cap (' + RENTCAST_MONTHLY_LIMIT + ') already reached. Reset the counter or wait until next month.',
      usage: usageBefore,
    }, request, 429);
  }

  const result = await fetchRentCastListings(zip, env);
  if (!result.ok) {
    return jsonResponse({
      ok: false,
      error: result.reason || 'fetch_failed',
      zip,
      usage: await getRentCastUsage(env),
      detail: result,
    }, request, 502);
  }

  // Enrich with tract + LMI tagging (same as batch refresh).
  let enrichedListings;
  try {
    enrichedListings = await enrichListingsWithTracts(result.listings, zip, env);
  } catch (e) {
    enrichedListings = result.listings.map(l => ({ ...l, tractId: null, tractIncomeRatio: null, tractIncomeLevel: 'Unknown', isLMI: null }));
  }

  // Same sort + write-to-KV behavior as the batch refresh so the data shape
  // stays consistent.
  enrichedListings.sort((a, b) => {
    const ap = Number(a.price), bp = Number(b.price);
    const av = Number.isFinite(ap) && ap > 0, bv = Number.isFinite(bp) && bp > 0;
    if (av && bv) return ap - bp;
    if (av) return -1;
    if (bv) return 1;
    return 0;
  });
  const runId = 'single_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const lmiCount = enrichedListings.filter(l => l.isLMI === true).length;
  const cached = {
    zip,
    generatedAt: new Date().toISOString(),
    total: enrichedListings.length,
    lmiCount,
    listings: enrichedListings,
    sources: { rentcast: enrichedListings.length },
    fromCache: false,
    runId,
    singleZipRefresh: true,
    enriched: true,
    enrichmentVersion: 2,
  };
  if (env.KV_NAMESPACE) {
    try {
      await env.KV_NAMESPACE.put('for_sale_' + zip, JSON.stringify(cached),
        { expirationTtl: 60 * 60 * 24 * 40 });
    } catch (e) { /* non-critical */ }
  }

  const usageAfter = await getRentCastUsage(env);
  return jsonResponse({
    ok: true,
    zip,
    total: cached.total,
    lmiCount: cached.lmiCount,
    sample: cached.listings.slice(0, 3), // quick sanity-check preview
    usageBefore,
    usageAfter,
    runId,
  }, request);
}

// ═══════════════════════════════════════════════════════════════════════
// SCHEDULED REFRESH — cron path + admin manual trigger go through here.
// Iterates priority ZIPs, calls fetchRentCastListings for each (which
// enforces the quota). Stops as soon as the quota is exhausted. Writes
// results to KV and logs run summary.
// ═══════════════════════════════════════════════════════════════════════

async function runScheduledRefresh(env, source /* 'cron' | 'manual' */) {
  const startedAt = new Date().toISOString();
  const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const cfg = await readRentCastConfig(env);
  const usage = await getRentCastUsage(env);

  // Cron-only gate: only do real work if today matches configured day.
  if (source === 'cron') {
    const todayDay = new Date().getUTCDate();
    if (todayDay !== cfg.scheduledDay) {
      const run = { runId, startedAt, finishedAt: new Date().toISOString(), source,
        skipped: true, reason: 'not_scheduled_day', todayDay, scheduledDay: cfg.scheduledDay };
      return run;
    }
  }

  if (cfg.killSwitch) {
    const run = { runId, startedAt, finishedAt: new Date().toISOString(), source,
      skipped: true, reason: 'kill_switch_active' };
    await writeLastRun(env, run);
    return run;
  }

  const succeeded = [];
  const failed = [];
  let stoppedEarly = false;
  const zips = Array.isArray(cfg.priorityZips) ? cfg.priorityZips.slice() : [];

  for (const zip of zips) {
    // Pre-check usage. If we've reached the cap, stop immediately — no more calls.
    const u = await getRentCastUsage(env);
    if (u.count >= RENTCAST_MONTHLY_LIMIT) {
      stoppedEarly = true;
      failed.push({ zip, reason: 'monthly_limit_reached' });
      break;
    }
    const result = await fetchRentCastListings(zip, env);
    if (!result.ok) {
      failed.push({ zip, reason: result.reason });
      if (result.reason === 'monthly_limit_reached' || result.reason === 'kill_switch_active') {
        stoppedEarly = true;
        break;
      }
      continue;
    }
    // Enrich with census-tract + LMI classification. This is what turns the
    // tool from ZIP-scoped (imprecise for CRA) into tract-scoped (precise).
    // Free — uses FCC + FFIEC, both no-key public APIs.
    let enrichedListings;
    try {
      enrichedListings = await enrichListingsWithTracts(result.listings, zip, env);
    } catch (e) {
      // Enrichment failure should never lose us the underlying listings —
      // fall back to untagged records.
      enrichedListings = result.listings.map(l => ({ ...l, tractId: null, tractIncomeRatio: null, tractIncomeLevel: 'Unknown', isLMI: null }));
    }
    // Sort by price asc, unpriced last — consistent with frontend expectation.
    enrichedListings.sort((a, b) => {
      const ap = Number(a.price), bp = Number(b.price);
      const av = Number.isFinite(ap) && ap > 0, bv = Number.isFinite(bp) && bp > 0;
      if (av && bv) return ap - bp;
      if (av) return -1;
      if (bv) return 1;
      return 0;
    });
    const lmiCount = enrichedListings.filter(l => l.isLMI === true).length;
    const cached = {
      zip,
      generatedAt: new Date().toISOString(),
      total: enrichedListings.length,
      lmiCount,
      listings: enrichedListings,
      sources: { rentcast: enrichedListings.length },
      fromCache: false,
      runId,
      // Marker that this cache entry went through tract enrichment. Older
      // cached blobs (pre-enrichment deploy) will be missing this field and
      // the client shows a banner asking the user to refresh.
      enriched: true,
      enrichmentVersion: 2,
    };
    if (env.KV_NAMESPACE) {
      try {
        // Cache for 40 days so listings stay available even if a refresh is skipped.
        await env.KV_NAMESPACE.put('for_sale_' + zip, JSON.stringify(cached),
          { expirationTtl: 60 * 60 * 24 * 40 });
      } catch (e) { /* non-critical */ }
    }
    succeeded.push({ zip, total: cached.total });
  }

  const finalUsage = await getRentCastUsage(env);
  const run = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    source,
    skipped: false,
    zipsAttempted: succeeded.length + failed.length,
    zipsSucceeded: succeeded.length,
    zipsFailed: failed.length,
    succeeded,
    failed,
    stoppedEarly,
    usageBefore: usage,
    usageAfter: finalUsage,
  };
  await writeLastRun(env, run);
  return run;
}

// ═══════════════════════════════════════════════════════════════════════
// FIREBASE AUTH ADMIN (Identity Toolkit REST)
// ═══════════════════════════════════════════════════════════════════════
// The Worker signs a short-lived RS256 JWT with the service account's
// private key, trades it for a Google OAuth2 access token, and calls
// the Identity Toolkit REST API. Access tokens are cached in KV for
// ~50 minutes (Google issues them with 1hr TTL).
//
// Env secrets required:
//   FIREBASE_SERVICE_ACCOUNT — full JSON of the service-account key
//                              (client_email, private_key, project_id,
//                               token_uri)
//   ADMIN_PASSWORD           — already configured; bearer-token gate
//
// These endpoints let the admin UI create/delete Firebase Auth users
// WITHOUT doing it from the browser, because client-side
// createUserWithEmailAndPassword signs the admin's own session out.

const FBA_KV_TOKEN_KEY  = 'fba_access_token_v1';
const FBA_SCOPES        = 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase';

function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlEncodeString(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const stripped = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(stripped);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function getServiceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('firebase_service_account_not_configured');
  }
  let sa;
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
  catch (e) { throw new Error('firebase_service_account_malformed'); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('firebase_service_account_missing_fields');
  }
  return sa;
}

async function signServiceAccountJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: FBA_SCOPES,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = b64urlEncodeString(JSON.stringify(header)) + '.' +
                       b64urlEncodeString(JSON.stringify(payload));
  const keyData = pemToArrayBuffer(sa.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  return signingInput + '.' + b64urlEncode(sig);
}

async function getFirebaseAccessToken(env) {
  // Check KV cache (tokens have 1hr TTL; we cache for 50min).
  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(FBA_KV_TOKEN_KEY, 'json');
      if (cached && cached.token && cached.expiresAt > Date.now() + 60_000) {
        return cached.token;
      }
    } catch (e) { /* non-fatal */ }
  }
  const sa = getServiceAccount(env);
  const jwt = await signServiceAccountJwt(sa);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('oauth_token_exchange_failed: ' + resp.status + ' ' + txt.slice(0, 200));
  }
  const json = await resp.json();
  const token = json.access_token;
  if (!token) throw new Error('oauth_token_missing_in_response');
  if (env.KV_NAMESPACE) {
    try {
      await env.KV_NAMESPACE.put(FBA_KV_TOKEN_KEY, JSON.stringify({
        token, expiresAt: Date.now() + 50 * 60_000,
      }), { expirationTtl: 60 * 60 });
    } catch (e) { /* non-fatal */ }
  }
  return token;
}

async function firebaseAdminFetch(env, path, method, body) {
  const token = await getFirebaseAccessToken(env);
  const sa = getServiceAccount(env);
  const url = 'https://identitytoolkit.googleapis.com/v1/projects/' +
              encodeURIComponent(sa.project_id) + path;
  const resp = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// POST /admin/migrate-users
// Body: { users: [{ email, password, uid? }, ...] }
// Creates Firebase Auth accounts for each user. Idempotent: if an
// account already exists for that email, reports "already_exists"
// and still returns its UID.
async function handleMigrateAuthUsers(request, env) {
  try { await requireSuperAdmin(request, env); }
  catch (e) { return adminErrorResponse(e, request); }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }

  const users = Array.isArray(body && body.users) ? body.users : [];
  if (!users.length) return jsonResponse({ error: 'no_users' }, request, 400);

  const migrated = [];
  const failed = [];
  const alreadyExists = [];

  for (const u of users) {
    const email = (u && u.email || '').trim().toLowerCase();
    const password = (u && u.password || '').trim();
    if (!email || !password) {
      failed.push({ email: email || '(missing)', err: 'missing_email_or_password' });
      continue;
    }
    // Firebase Auth minimum password length is 6 chars. Existing
    // cleartext passwords shorter than 6 fail to import; flag them
    // so the admin can force-reset those accounts manually later.
    if (password.length < 6) {
      failed.push({ email, err: 'password_below_firebase_min_length' });
      continue;
    }
    try {
      const createBody = { email, password, emailVerified: false };
      if (u.uid && typeof u.uid === 'string') createBody.localId = u.uid;
      const res = await firebaseAdminFetch(env, '/accounts', 'POST', createBody);
      if (res.ok) {
        migrated.push({ email, uid: res.data.localId || u.uid || '' });
      } else {
        const code = res.data && res.data.error && res.data.error.message || '';
        if (code === 'EMAIL_EXISTS' || code.startsWith('EMAIL_EXISTS')) {
          // Look up the existing UID so the caller can link the
          // Firestore record to the right Auth account.
          const lookup = await firebaseAdminFetch(env, '/accounts:lookup', 'POST', { email: [email] });
          const uid = lookup.ok && lookup.data.users && lookup.data.users[0]
            ? lookup.data.users[0].localId : '';
          alreadyExists.push({ email, uid });
        } else {
          failed.push({ email, err: code || ('http_' + res.status) });
        }
      }
    } catch (e) {
      failed.push({ email, err: String(e.message || e) });
    }
  }

  return jsonResponse({
    migrated: migrated.length,
    alreadyExisted: alreadyExists.length,
    failedCount: failed.length,
    users: { migrated, alreadyExists, failed },
  }, request);
}

// POST /admin/create-auth-user
// Body: { email, password, uid? }
// Creates a single Firebase Auth user. Used by the admin "Add MLO"
// flow — the client cannot do this itself without signing the admin
// out of their own session.
async function handleCreateAuthUser(request, env) {
  try { await requireSuperAdmin(request, env); }
  catch (e) { return adminErrorResponse(e, request); }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) {
    return jsonResponse({ error: 'missing_email_or_password' }, request, 400);
  }
  if (password.length < 12) {
    return jsonResponse({ error: 'password_below_policy_min_length' }, request, 400);
  }

  try {
    const createBody = { email, password, emailVerified: false };
    if (body.uid && typeof body.uid === 'string') createBody.localId = body.uid;
    const res = await firebaseAdminFetch(env, '/accounts', 'POST', createBody);
    if (!res.ok) {
      const code = res.data && res.data.error && res.data.error.message || ('http_' + res.status);
      return jsonResponse({ error: code }, request, 400);
    }
    return jsonResponse({ uid: res.data.localId, email: res.data.email }, request);
  } catch (e) {
    return jsonResponse({ error: String(e.message || e) }, request, 500);
  }
}

// POST /admin/delete-auth-user
// Body: { uid }
async function handleDeleteAuthUser(request, env) {
  try { await requireSuperAdmin(request, env); }
  catch (e) { return adminErrorResponse(e, request); }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }

  const uid = String(body.uid || '').trim();
  if (!uid) return jsonResponse({ error: 'missing_uid' }, request, 400);

  try {
    const res = await firebaseAdminFetch(env, '/accounts:delete', 'POST', { localId: uid });
    if (!res.ok) {
      const code = res.data && res.data.error && res.data.error.message || ('http_' + res.status);
      return jsonResponse({ error: code }, request, 400);
    }
    return jsonResponse({ deleted: true, uid }, request);
  } catch (e) {
    return jsonResponse({ error: String(e.message || e) }, request, 500);
  }
}

// POST /admin/set-auth-password
// Body: { uid, password }
// Admin-initiated password reset. Used rarely (e.g. user locked out
// with no recovery code). Regular users change their own password
// via the client SDK.
async function handleSetAuthPassword(request, env) {
  try { await requireSuperAdmin(request, env); }
  catch (e) { return adminErrorResponse(e, request); }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }

  const uid = String(body.uid || '').trim();
  const password = String(body.password || '');
  if (!uid || !password) {
    return jsonResponse({ error: 'missing_uid_or_password' }, request, 400);
  }
  if (password.length < 12) {
    return jsonResponse({ error: 'password_below_policy_min_length' }, request, 400);
  }

  try {
    const res = await firebaseAdminFetch(env, '/accounts:update', 'POST', {
      localId: uid, password,
    });
    if (!res.ok) {
      const code = res.data && res.data.error && res.data.error.message || ('http_' + res.status);
      return jsonResponse({ error: code }, request, 400);
    }
    return jsonResponse({ updated: true, uid }, request);
  } catch (e) {
    return jsonResponse({ error: String(e.message || e) }, request, 500);
  }
}
