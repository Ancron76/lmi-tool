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

// ZIP3 prefix → 5-digit county FIPS. Required because CFPB's HMDA
// data-browser-api does NOT accept a `zip_codes` filter — only `states`,
// `counties`, `census_tracts`, and `msamds`. Before this map existed,
// `fetchLmiTractsForZip` passed `&zip_codes=` and CFPB silently ignored
// it, dumping the entire national HMDA dataset (3 MB+) which the frontend
// then rendered as if those random out-of-state tracts belonged to the
// searched ZIP. Mirrors lmi-proxy-worker.js's CA-only coverage.
const ZIP3_TO_COUNTY_FIPS = {
  '900': '06037', '901': '06037', '902': '06037', '903': '06037', '904': '06037',
  '905': '06037', '906': '06037', '907': '06037', '908': '06037',
  '910': '06037', '911': '06037', '912': '06037', '913': '06037', '914': '06037',
  '915': '06037', '916': '06037', '917': '06037', '918': '06037',
  '919': '06111', // Ventura
  '920': '06073', '921': '06073', // San Diego
  '922': '06025', // Imperial
  '923': '06065', '924': '06065', '925': '06065', // Riverside
  '926': '06059', '927': '06059', '928': '06059', // Orange
  '930': '06111', // Ventura
  '931': '06083', // Santa Barbara
  '932': '06029', '933': '06029', // Kern
  '934': '06079', // San Luis Obispo
  '935': '06029', // Kern
  '936': '06019', '937': '06019', '938': '06019', // Fresno
  '939': '06107', // Tulare
  '940': '06081', // San Mateo
  '941': '06075', // San Francisco
  '942': '06081', // San Mateo
  '943': '06001', // Alameda
  '944': '06075', // San Francisco
  '945': '06001', '946': '06001', // Alameda
  '947': '06013', // Contra Costa
  '948': '06097', // Sonoma
  '949': '06041', // Marin
  '950': '06085', '951': '06085', '954': '06085', // Santa Clara
  '952': '06087', // Santa Cruz
  '953': '06069', // San Benito
  '955': '06077', '956': '06077', // San Joaquin
  '957': '06039', // Madera
  '958': '06067', '959': '06067', // Sacramento
  '960': '06089', // Shasta
  '961': '06007', '962': '06007', // Butte
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
    // Rate-limited — unauthenticated, can hit CFPB / consume subrequests.
    const zip = url.searchParams.get('zip');
    if (zip && url.pathname === '/') {
      const rl = await checkPublicRateLimit(request, env, 'lmi');
      if (rl) return rl;
      return handleLmiLookup(zip, request);
    }

    // Property Intelligence API route — rate-limited, expensive.
    if (url.pathname === '/property-intelligence' && request.method === 'GET') {
      const rl = await checkPublicRateLimit(request, env, 'propintel');
      if (rl) return rl;
      return handlePropertyIntelligence(request, env);
    }

    // For-sale aggregate listings route (reads from KV cache only — never live)
    if (url.pathname === '/for-sale' && request.method === 'GET') {
      const rl = await checkPublicRateLimit(request, env, 'forsale');
      if (rl) return rl;
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

    // ── MFA (worker-side TOTP, RFC 6238) ─────────────────────────
    // Public health probe — no auth, returns config + crypto self-test.
    if (url.pathname === '/mfa/health' && request.method === 'GET') {
      return handleMfaHealth(request, env);
    }
    // All other /mfa/* routes verify the caller's Firebase ID token
    // first (passed in JSON body). Per-IP rate-limited via the
    // mfa_status / mfa_enroll / mfa_verify scopes. Per-UID lockout
    // (5 fails / 30 min) layered on top — KV-backed.
    if (url.pathname === '/mfa/status' && request.method === 'POST') {
      return handleMfaStatus(request, env);
    }
    if (url.pathname === '/mfa/enroll-start' && request.method === 'POST') {
      return handleMfaEnrollStart(request, env);
    }
    if (url.pathname === '/mfa/enroll-confirm' && request.method === 'POST') {
      return handleMfaEnrollConfirm(request, env);
    }
    if (url.pathname === '/mfa/verify' && request.method === 'POST') {
      return handleMfaVerify(request, env);
    }
    if (url.pathname === '/mfa/verify-backup' && request.method === 'POST') {
      return handleMfaVerifyBackup(request, env);
    }
    if (url.pathname === '/mfa/regenerate-backup' && request.method === 'POST') {
      return handleMfaRegenerateBackup(request, env);
    }
    if (url.pathname === '/mfa/unenroll' && request.method === 'POST') {
      return handleMfaUnenroll(request, env);
    }
    if (url.pathname === '/mfa/show-qr' && request.method === 'POST') {
      return handleMfaShowQr(request, env);
    }

    // ── Public error-report sink ─────────────────────────────────
    // The frontend posts uncaught exceptions + unhandled rejections
    // here. Rate-limited per IP. Body is logged via console.error so
    // it shows up in `wrangler tail` and (if enabled) the worker's
    // observability dashboard. Returns 204 fast — never blocks the
    // user's page.
    if (url.pathname === '/error-report' && request.method === 'POST') {
      const rl = await checkPublicRateLimit(request, env, 'error_report');
      if (rl) return rl;
      try {
        const body = await request.json();
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const ua = request.headers.get('User-Agent') || 'unknown';
        console.error('[client-error]', JSON.stringify({
          ip, ua,
          message: String(body.message || '').slice(0, 500),
          source: String(body.source || '').slice(0, 200),
          lineno: body.lineno,
          colno: body.colno,
          stack: String(body.stack || '').slice(0, 2000),
          url: String(body.url || '').slice(0, 500),
          userAgentClient: String(body.ua || '').slice(0, 200),
          tag: String(body.tag || '').slice(0, 50),
          ts: body.ts || new Date().toISOString(),
        }));
      } catch (e) { /* malformed body — ignore */ }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
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

  // CFPB HMDA's data-browser-api does NOT support a `zip_codes` query
  // parameter on the nationwide CSV endpoint — only `states`, `counties`,
  // `census_tracts`, `msamds`. Resolve ZIP → county FIPS first, then ask
  // for that county's tracts. (The frontend renders all returned tracts
  // for the area, matching how lmi-proxy-worker.js behaves.)
  const countyFips = ZIP3_TO_COUNTY_FIPS[zip.substring(0, 3)];
  if (!countyFips) {
    return {
      ok: false,
      reason: 'zip_not_in_coverage',
      detail: 'ZIP ' + zip + ' is outside the current CA coverage area. ' +
        'Add the ZIP3 prefix to ZIP3_TO_COUNTY_FIPS in worker.js to extend coverage.',
      tracts: []
    };
  }

  // CFPB HMDA currently has data for 2018-2023 (per the API's own range
  // error). Hardcoded to the known-good range so we stop hitting invalid
  // years and wasting subrequests.
  const yearsToTry = [2023, 2022, 2021, 2020, 2019, 2018];

  let res;
  try {
    for (const year of yearsToTry) {
      // `actions_taken=1,2,3` narrows HMDA rows to originated, approved-not-
      // accepted, and denied only — cuts the response size ~4x vs. no filter,
      // which matters because some large counties (e.g. LA = 06037) return
      // CSVs big enough to blow the Worker 128MB memory limit otherwise. The
      // tract-level fields (ratio / median income / population) are identical
      // across action_taken values, so filtering doesn't lose any tract data.
      const ffiecUrl =
        'https://ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv' +
        '?years=' + year +
        '&actions_taken=1,2,3' +
        '&counties=' + countyFips +
        '&fields=census_tract,tract_population,' +
        'tract_minority_population_percent,' +
        'ffiec_msa_md_median_family_income,' +
        'tract_to_msa_income_percentage';
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
      const rawId = row.census_tract || '';
      // CFPB's data-browser-api ignores `counties=` on the nationwide CSV
      // endpoint — every query just returns the pre-built actions_taken×year
      // slice of the WHOLE country (verified: Fresno + LA + no-filter all
      // redirect to the same file hash). So filter here against the 5-digit
      // state+county FIPS prefix of the resolved county.
      if (countyFips && !rawId.startsWith(countyFips)) return null;
      const incomeRatio = parseFloat(row.tract_to_msa_income_percentage);
      const msaMfi = parseInt(row.ffiec_msa_md_median_family_income) || 0;
      // Tract MFI is not in CFPB's response — derive from ratio × MSA MFI.
      // This is what the frontend's renderResults expects in
      // `tract_md_fam_income`. Exact when ratio is exact, otherwise off by
      // CFPB's rounding (negligible).
      const tractMfi = isFinite(incomeRatio) && msaMfi
        ? Math.round((incomeRatio / 100) * msaMfi)
        : 0;
      const tractPop = parseInt(row.tract_population) || 0;
      results.push({
        tract_id: rawId,
        tract_id_normalized: normalizeTractId(rawId),
        census_tract: rawId,
        tract_population: tractPop,
        population: tractPop,                 // alias used by frontend renderers
        minority_pct: parseFloat(row.tract_minority_population_percent) || 0,
        median_family_income: msaMfi,         // legacy/diagnostic
        area_md_fam_income: msaMfi,           // frontend alias (MSA AMI)
        tract_md_fam_income: tractMfi,        // frontend alias (tract MFI)
        income_ratio: isFinite(incomeRatio) ? incomeRatio : null,
        lmi_status: isFinite(incomeRatio) && incomeRatio <= 80,
        lmi_category: classifyIncomeRatio(isFinite(incomeRatio) ? incomeRatio : null),
        city: '',
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
    const result = await fetchLmiTractsForZip(zip);
    if (result.ok) {
      return jsonResponse(result.tracts, request);
    }
    // Surface the actual failure reason from the primary path so the
    // frontend can show a useful error instead of "Census unreachable".
    // The previous aggregations fallback queried CFPB with `zip_codes=`,
    // but that endpoint silently ignores `zip_codes` (audit confirmed
    // every query 301-redirects to the same pre-built national file).
    // Returning the unfiltered national HMDA aggregations is worse than
    // returning a structured error.
    return jsonResponse({
      error: 'No LMI data available for this ZIP',
      reason: result.reason || 'unknown',
      detail: result.detail || null,
    }, request, result.reason === 'zip_not_in_coverage' ? 400 : 502);
  } catch (e) {
    console.error('[handleLmiLookup]', zip, e && e.stack || e);
    return jsonResponse({ error: 'LMI lookup failed', reason: 'internal_error' }, request, 502);
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
    // Log the full stack trace to the worker console (visible via
    // `wrangler tail`), but do NOT include it in the HTTP response —
    // even behind ADMIN_PASSWORD, leaking stack frames is information
    // disclosure. The frontend only needs the message + partial trace.
    console.error('[trace-address] internal error:', e && e.stack || e);
    return jsonResponse({
      ok: false,
      error: 'trace_internal_error',
      message: String(e && e.message || 'internal error'),
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

  // Input validation — both fields end up interpolated into outbound URLs
  // (ArcGIS `where=CENSUS_TRACT='${tractId}'`, RentCast `?zipCode=`, etc).
  // Audit found tractId injection was possible because ArcGIS treats `'`
  // as a SQL delimiter; an unvalidated tractId like `' OR 1=1 --` could
  // exfiltrate the full parcel database. Reject anything that isn't an
  // 11-digit FIPS tract / 5-digit ZIP up front so no downstream call can
  // be coerced into something else.
  if (!/^\d{11}$/.test(tractId)) {
    return jsonResponse({ error: 'invalid tractId (expected 11-digit FIPS)' }, request, 400);
  }
  if (!/^\d{5}$/.test(zip)) {
    return jsonResponse({ error: 'invalid zip (expected 5 digits)' }, request, 400);
  }
  if (county && !/^[A-Za-z .'\-]{2,40}$/.test(county)) {
    return jsonResponse({ error: 'invalid county' }, request, 400);
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

// consumeRentCastQuota: attempts to reserve 1 quota slot. Returns
// { ok: true } if reserved, { ok: false, reason, count, limit } if
// refused. Increments BEFORE returning so callers can't forget to
// update the counter.
//
// CONCURRENCY NOTE
// Cloudflare KV is eventually consistent and supports neither atomic
// counters nor compare-and-swap. Two parallel calls can both read
// `current=49`, both write `50`, and both proceed — overshooting the
// cap by 1. To bound the overshoot, we apply a safety margin:
// QUOTA_SAFETY_MARGIN slots are reserved as concurrency headroom. The
// effective usable cap is RENTCAST_MONTHLY_LIMIT - QUOTA_SAFETY_MARGIN
// (typical real-world worst case = 1-2 concurrent calls). Trade-off
// is documented and tunable; true atomicity would require a Durable
// Object backing store, which is overkill for a 50/month cap.
//
// If overshoot DOES happen (count climbs above LIMIT - margin between
// the read and a subsequent caller), we log a warning so ops can see
// it without changing user-visible behavior. The hard ceiling at
// RENTCAST_MONTHLY_LIMIT itself is still enforced — that's the safety
// stop the comment block at the top of this file mandates.
const QUOTA_SAFETY_MARGIN = 2;

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
  // Soft cap (with safety margin) blocks BEFORE the race window can
  // make us overshoot the hard cap. Hard cap is also enforced below
  // as belt-and-suspenders in case the soft cap is ever tuned down.
  const softCap = Math.max(0, RENTCAST_MONTHLY_LIMIT - QUOTA_SAFETY_MARGIN);
  if (current >= softCap) {
    // Even within margin, never go past the hard cap.
    if (current >= RENTCAST_MONTHLY_LIMIT) {
      return { ok: false, reason: 'monthly_limit_reached', count: current, limit: RENTCAST_MONTHLY_LIMIT };
    }
    // We're inside the margin band — refuse but log so ops sees usage
    // creeping into the headroom (means concurrency is high enough that
    // QUOTA_SAFETY_MARGIN may need to grow).
    console.warn('[quota] caller hit safety margin band: count=' + current
      + ' softCap=' + softCap + ' hardCap=' + RENTCAST_MONTHLY_LIMIT);
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

// Per-IP brute-force throttle for ADMIN_PASSWORD.
// ─────────────────────────────────────────────────────────────
// ADMIN_PASSWORD is the only thing guarding RentCast quota, the
// Firebase Auth admin endpoints, the cache re-enrichment endpoint,
// and every other /admin/* route. Without per-IP throttling an
// attacker could spray guesses globally from a CF Worker isolate
// pool and find the password.
//
// Strategy:
//   - Successful auth: reset the counter to 0 (in-flight legitimate
//     admin can keep going without surprise lockouts).
//   - Failed auth: increment counter, window = 15 minutes.
//   - After 5 failures in the window: respond 429 with a Retry-After
//     equal to remaining window. Counter must clear before retries
//     are accepted.
//   - Key = CF-Connecting-IP. If somehow missing (private network /
//     internal call), fall back to a synthetic 'unknown_ip' bucket
//     which is shared and very strict (3 per window).
//   - KV write failures are logged but don't open the gate — better
//     to false-positive lock out a legitimate admin than silently
//     remove the throttle.
const ADMIN_THROTTLE_WINDOW_S = 15 * 60;  // 15 minutes
const ADMIN_THROTTLE_MAX_FAILS = 5;
const ADMIN_THROTTLE_KEY_PREFIX = 'admin_throttle_v1_';

async function getAdminThrottleState(env, ip) {
  if (!env.KV_NAMESPACE) return { count: 0, kvAvailable: false };
  try {
    const raw = await env.KV_NAMESPACE.get(ADMIN_THROTTLE_KEY_PREFIX + ip, 'json');
    if (!raw) return { count: 0, kvAvailable: true };
    // Expired? Treat as no record.
    if (raw.windowEndsAt && Date.now() > raw.windowEndsAt) return { count: 0, kvAvailable: true };
    return { count: raw.count || 0, windowEndsAt: raw.windowEndsAt, kvAvailable: true };
  } catch (e) {
    console.warn('[admin-throttle] KV read failed:', e && e.message || e);
    return { count: 0, kvAvailable: false };
  }
}

async function incrementAdminFailure(env, ip) {
  if (!env.KV_NAMESPACE) return;
  try {
    const state = await getAdminThrottleState(env, ip);
    const newCount = (state.count || 0) + 1;
    const windowEndsAt = state.windowEndsAt && state.count > 0
      ? state.windowEndsAt
      : Date.now() + ADMIN_THROTTLE_WINDOW_S * 1000;
    await env.KV_NAMESPACE.put(
      ADMIN_THROTTLE_KEY_PREFIX + ip,
      JSON.stringify({ count: newCount, windowEndsAt }),
      { expirationTtl: ADMIN_THROTTLE_WINDOW_S + 60 }
    );
  } catch (e) {
    console.warn('[admin-throttle] KV write failed:', e && e.message || e);
  }
}

async function clearAdminFailures(env, ip) {
  if (!env.KV_NAMESPACE) return;
  try { await env.KV_NAMESPACE.delete(ADMIN_THROTTLE_KEY_PREFIX + ip); }
  catch (e) { /* non-fatal */ }
}

// Public-endpoint rate limit. Same KV pattern as the admin throttle but
// with a per-minute sliding window and per-scope buckets so a heavy LMI
// search doesn't also block property-intelligence lookups for the same
// IP. Returns a 429 Response when the bucket is full, or null when the
// caller can proceed.
//
// Defaults tuned for "normal UI use" (a dashboard might issue a handful
// of ZIP lookups per minute) while still blocking obvious abuse (script
// hammering 1k/sec). Tune via env vars later if real traffic shows
// false positives.
const PUBLIC_RATE_WINDOW_S = 60;
const PUBLIC_RATE_MAX = {
  lmi: 40,           // /?zip=X — generous, UIs paginate
  propintel: 30,     // /property-intelligence — slower, more expensive
  forsale: 60,       // /for-sale — KV-cache reads, cheap
  error_report: 20,  // /error-report — one buggy page shouldn't drown the log
  mfa_status: 30,    // /mfa/status — called on every settings page load
  mfa_enroll: 5,     // /mfa/enroll-start — expensive (Firebase write), rare
  mfa_verify: 10,    // /mfa/verify, /mfa/verify-backup, /mfa/enroll-confirm,
                     //   /mfa/regenerate-backup, /mfa/unenroll — UID-lockout
                     //   (5 fails / 30 min) is the hard cap
  default: 30,
};
const PUBLIC_RATE_KEY_PREFIX = 'public_rate_v1_';

async function checkPublicRateLimit(request, env, scope) {
  if (!env.KV_NAMESPACE) return null; // KV not available, no throttle (logs in admin path)
  scope = scope || 'default';
  const cap = PUBLIC_RATE_MAX[scope] || PUBLIC_RATE_MAX.default;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown_ip';
  // Unknown_ip is shared so be aggressive — half the normal cap.
  const effectiveCap = ip === 'unknown_ip' ? Math.max(5, Math.floor(cap / 2)) : cap;
  const key = PUBLIC_RATE_KEY_PREFIX + scope + ':' + ip;

  let state;
  try {
    state = await env.KV_NAMESPACE.get(key, 'json');
  } catch (e) {
    // KV read failed — fail OPEN for public endpoints (don't let a KV
    // hiccup turn into a customer-facing 429).
    return null;
  }
  const now = Date.now();
  // Drop expired window.
  if (state && state.windowEndsAt && now > state.windowEndsAt) state = null;

  const count = (state && state.count) || 0;
  if (count >= effectiveCap) {
    const remainingSec = state && state.windowEndsAt
      ? Math.max(1, Math.ceil((state.windowEndsAt - now) / 1000))
      : PUBLIC_RATE_WINDOW_S;
    return new Response(JSON.stringify({
      error: 'rate_limited',
      scope: scope,
      retryAfterSeconds: remainingSec,
      detail: 'Too many requests from this IP. Slow down and retry.'
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(remainingSec),
        ...corsHeaders(request),
      },
    });
  }
  // Increment counter (fire-and-forget so the request isn't slowed by KV).
  try {
    const newCount = count + 1;
    const windowEndsAt = (state && state.windowEndsAt) || (now + PUBLIC_RATE_WINDOW_S * 1000);
    await env.KV_NAMESPACE.put(
      key,
      JSON.stringify({ count: newCount, windowEndsAt }),
      { expirationTtl: PUBLIC_RATE_WINDOW_S + 30 }
    );
  } catch (e) { /* non-fatal */ }
  return null;
}

async function requireSuperAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new Error('admin_password_not_configured');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown_ip';

  // Pre-flight throttle check BEFORE we look at the bearer token.
  const state = await getAdminThrottleState(env, ip);
  const maxForThisBucket = ip === 'unknown_ip' ? 3 : ADMIN_THROTTLE_MAX_FAILS;
  if (state.count >= maxForThisBucket) {
    const remaining = state.windowEndsAt
      ? Math.max(1, Math.ceil((state.windowEndsAt - Date.now()) / 1000))
      : ADMIN_THROTTLE_WINDOW_S;
    const err = new Error('rate_limited');
    err.retryAfter = remaining;
    err.failCount = state.count;
    throw err;
  }

  const auth = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    // Missing header is still abuse-detectable — count it.
    await incrementAdminFailure(env, ip);
    throw new Error('no_auth_header');
  }
  if (!constantTimeEqual(m[1].trim(), String(env.ADMIN_PASSWORD).trim())) {
    await incrementAdminFailure(env, ip);
    throw new Error('bad_admin_password');
  }
  // Successful auth — reset the per-IP counter so a legitimate admin
  // who fat-fingered the password once doesn't get locked out.
  await clearAdminFailures(env, ip);
  return { ok: true };
}

function adminErrorResponse(err, request) {
  const msg = String(err && err.message || err || 'auth_failed');
  if (msg === 'rate_limited') {
    return new Response(JSON.stringify({
      error: 'rate_limited',
      retryAfterSeconds: err.retryAfter || 60,
      detail: 'Too many failed attempts from this IP. Wait before retrying.'
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(err.retryAfter || 60),
        ...corsHeaders(request),
      },
    });
  }
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

  // Cron-only gate: only do real work if today matches configured day.
  if (source === 'cron') {
    const todayDay = new Date().getUTCDate();
    if (todayDay !== cfg.scheduledDay) {
      const run = { runId, startedAt, finishedAt: new Date().toISOString(), source,
        skipped: true, reason: 'not_scheduled_day', todayDay, scheduledDay: cfg.scheduledDay };
      return run;
    }
  }

  // Idempotency guard: if cron fires twice on the same UTC day (Cloudflare
  // retries are rare but not impossible, and admin can press "Run Now"
  // while a cron-fired refresh is mid-flight), refuse the second run.
  // Without this, two parallel runs each burn ~30 RentCast quota slots.
  // Key TTL is 25 h so it auto-expires before the next day's cron.
  if (env.KV_NAMESPACE) {
    const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const lockKey = 'cron_lock_' + dayKey;
    try {
      const existing = await env.KV_NAMESPACE.get(lockKey, 'json');
      if (existing) {
        return { runId, startedAt, finishedAt: new Date().toISOString(), source,
          skipped: true, reason: 'already_ran_today', lockedBy: existing.runId,
          lockedAt: existing.lockedAt };
      }
      await env.KV_NAMESPACE.put(lockKey,
        JSON.stringify({ runId, lockedAt: startedAt, source }),
        { expirationTtl: 25 * 60 * 60 });
    } catch (e) {
      console.warn('[cron-lock] KV write failed, proceeding without guard:', e && e.message || e);
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

// ════════════════════════════════════════════════════════════════
// Worker-side TOTP MFA (RFC 6238) — hardened for regulator review
// ════════════════════════════════════════════════════════════════
//
// THREAT MODEL
// ────────────
// What this defends against:
//   • Stolen password alone → cannot sign in (needs second factor)
//   • Phishing of password → attacker still can't pass TOTP without
//     real-time access to the user's authenticator app
//   • Credential stuffing from other breaches → blocked by TOTP
//   • Replay of a sniffed valid code → blocked by per-counter cache
//   • Brute-force of the 6-digit code → blocked by 5-fail lockout
//     plus the per-IP rate limit (mfa_verify scope)
//   • KV-only compromise (read-access to keys) → secret is AES-GCM
//     encrypted with a key only the worker holds; attacker would
//     need BOTH the KV dump AND the MFA_ENCRYPTION_KEY secret to
//     extract the TOTP secret
//   • Stolen session attempting to disable MFA → /mfa/unenroll
//     requires a valid current TOTP code
//   • Lost authenticator → user has 10 one-time backup codes from
//     enrollment; they self-recover without admin intervention
//
// What this does NOT defend against (out of scope):
//   • Endpoint compromise of the user's device (malware that reads
//     the authenticator's local storage). TOTP is AAL2, not AAL3.
//     For AAL3 you need a hardware token (YubiKey via WebAuthn).
//   • Insider with worker secret access AND KV access (we have
//     audit logging via Cloudflare Logpush + Firestore /auditLog
//     so detection is the control, not prevention)
//
// COMPLIANCE NOTES
// ────────────────
// NIST SP 800-63B Authenticator Assurance Level 2 (AAL2):
//   • §5.1.4 Single-Factor OTP — meets requirements because:
//     - 6-digit code (≥6 digits) ✓
//     - HMAC-SHA1 per RFC 4226 ✓
//     - 30-second time step per RFC 6238 ✓
//     - Replay defense (counter cache) ✓
//     - Rate limit (5 fails / 30 min lockout per UID) ✓
//   • Combined with the password (something-you-know) and the
//     authenticator-app possession (something-you-have), this
//     yields AAL2 multi-factor authentication.
//
// FFIEC / GLBA / state mortgage regulator alignment:
//   • Customer authentication risk = high (PII, NPI, financial
//     data). Multi-factor auth is industry standard.
//   • Audit trail: every MFA operation writes to immutable
//     Firestore /auditLog (rules deny update/delete).
//   • Recovery procedure: backup codes (user-side) + KV wipe via
//     wrangler (admin-side). Both documented in RUNBOOK.md.
//
// DATA AT REST
// ────────────
// KV keys and what's in them:
//   mfa_totp_<uid>          {ciphertext, iv, enrolledAt}  AES-GCM
//   mfa_totp_pending_<uid>  {ciphertext, iv, createdAt}   AES-GCM, 10m TTL
//   mfa_backup_<uid>        ["sha256_hash_b64", ...]      hashed, single-use
//   mfa_lock_<uid>          {fails, until?, lastFailAt}   30m TTL
//   mfa_replay_<uid>_<c>    "1"                           90s TTL
//
// CONFIGURATION
// ─────────────
// Required Wrangler secrets:
//   FIREBASE_SERVICE_ACCOUNT  — JSON of service-account key for ID
//                               token verification + custom claims
//   MFA_ENCRYPTION_KEY        — 32 random bytes, base64-encoded.
//                               Generate with:
//                                 node -e "console.log(crypto.randomBytes(32).toString('base64'))"
//                               then:
//                                 npx wrangler secret put MFA_ENCRYPTION_KEY
//
// Once set, NEVER rotate without a planned re-enrollment of every
// user, because rotating the key makes all stored secrets
// undecryptable. The replay/lock/backup KV keys would be unaffected.

const MFA_KV_SECRET_PREFIX  = 'mfa_totp_';
const MFA_KV_PENDING_PREFIX = 'mfa_totp_pending_';
const MFA_KV_LOCK_PREFIX    = 'mfa_lock_';
const MFA_KV_REPLAY_PREFIX  = 'mfa_replay_';
const MFA_KV_BACKUP_PREFIX  = 'mfa_backup_';
const MFA_PENDING_TTL_S     = 10 * 60;       // 10 min to finish enroll
const MFA_LOCK_FAIL_MAX     = 5;
const MFA_LOCK_WINDOW_S     = 30 * 60;       // 30 min lockout after max fails
const MFA_REPLAY_TTL_S      = 90;            // can't re-use same counter
const MFA_VERIFIED_VALID_S  = 12 * 60 * 60;  // mfaVerifiedAt claim valid for 12h
const MFA_STEP_SECONDS      = 30;            // RFC 6238 standard
const MFA_WINDOW            = 1;             // ±1 step (±30s) tolerance
const MFA_BACKUP_CODE_COUNT = 10;            // codes issued per enrollment
const MFA_BACKUP_CODE_LEN   = 10;            // chars per code (10×log2(31) ≈ 49 bits)

// Base32 (RFC 4648). Used for the otpauth:// URI + the authenticator
// secret display. Authenticator apps expect Base32 with this alphabet.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Backup-code alphabet: visually unambiguous (no 0/O, 1/I/L, etc).
// Reduces transcription errors when the user is reading from a
// printout in a recovery scenario.
const MFA_BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function mfaBase32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function mfaBase32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) throw new Error('invalid_base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function mfaBytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function mfaBase64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// AES-GCM secret-at-rest layer. The TOTP secret is encrypted with
// a key only the worker holds; KV stores ciphertext + IV. If KV is
// read-compromised but the worker secret isn't, the TOTP secrets
// stay confidential.
async function getMfaEncryptionKey(env) {
  if (!env.MFA_ENCRYPTION_KEY) {
    throw new Error('mfa_encryption_key_not_configured');
  }
  // Tolerate stray whitespace/newlines that `wrangler secret put`
  // sometimes carries when pasting from a terminal. The atob built-in
  // is strict about both whitespace and invalid chars, so normalize
  // first. Also accept both standard ('+/') and URL-safe ('-_') base64.
  const cleaned = String(env.MFA_ENCRYPTION_KEY)
    .replace(/\s+/g, '')
    .replace(/-/g, '+').replace(/_/g, '/');
  let raw;
  try { raw = mfaBase64ToBytes(cleaned); }
  catch (e) {
    throw new Error('mfa_encryption_key_not_base64: ' +
      'value (first 8 chars) "' + cleaned.slice(0, 8) + '…" ' +
      'length=' + cleaned.length);
  }
  if (raw.length !== 32) {
    throw new Error('mfa_encryption_key_must_be_32_bytes_after_base64_decode: got ' +
      raw.length + ' bytes (expected 32). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  return await crypto.subtle.importKey(
    'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

async function mfaEncryptSecret(secretBase32, env) {
  const key = await getMfaEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(secretBase32);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, plaintext
  ));
  return { ciphertext: mfaBytesToBase64(ct), iv: mfaBytesToBase64(iv) };
}

async function mfaDecryptSecret(stored, env) {
  if (!stored || !stored.ciphertext || !stored.iv) {
    throw new Error('mfa_stored_record_malformed');
  }
  const key = await getMfaEncryptionKey(env);
  const iv = mfaBase64ToBytes(stored.iv);
  const ct = mfaBase64ToBytes(stored.ciphertext);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, ct
  );
  return new TextDecoder().decode(pt);
}

// HMAC-SHA1(secret, counter) → 6-digit code per RFC 4226/6238.
async function totpComputeCode(secretBytes, counter) {
  const counterBuf = new ArrayBuffer(8);
  const view = new DataView(counterBuf);
  // 64-bit big-endian counter. JS numbers exceed 2^53 only ~5000 yrs
  // from now, so split-write is safe for our lifetime.
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw', secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));
  // RFC 4226 §5.3 dynamic truncation
  const offset = sig[sig.length - 1] & 0x0f;
  const binCode = ((sig[offset] & 0x7f) << 24)
                | ((sig[offset + 1] & 0xff) << 16)
                | ((sig[offset + 2] & 0xff) << 8)
                | (sig[offset + 3] & 0xff);
  const code = binCode % 1_000_000;
  return code.toString().padStart(6, '0');
}

// Verify a 6-digit code against a base32 secret with ±MFA_WINDOW
// step tolerance. Returns { ok, counter } where counter is the
// matched window's counter (for replay-cache).
async function totpVerify(secretBase32, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return { ok: false };
  const secret = mfaBase32Decode(secretBase32);
  const now = Math.floor(Date.now() / 1000);
  const baseCounter = Math.floor(now / MFA_STEP_SECONDS);
  for (let w = -MFA_WINDOW; w <= MFA_WINDOW; w++) {
    const c = baseCounter + w;
    const expected = await totpComputeCode(secret, c);
    // Constant-time string equality (no early return on first mismatch)
    let diff = code.length ^ expected.length;
    for (let i = 0; i < expected.length; i++) {
      diff |= code.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return { ok: true, counter: c };
  }
  return { ok: false };
}

// Generate fresh backup recovery codes. Returns the plaintext array
// so the caller can display them once; only hashes are stored.
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < MFA_BACKUP_CODE_COUNT; i++) {
    const raw = crypto.getRandomValues(new Uint8Array(MFA_BACKUP_CODE_LEN));
    let s = '';
    for (let j = 0; j < raw.length; j++) {
      s += MFA_BACKUP_ALPHABET[raw[j] % MFA_BACKUP_ALPHABET.length];
    }
    // Insert a hyphen mid-way for readability (XXXXX-XXXXX)
    codes.push(s.slice(0, 5) + '-' + s.slice(5));
  }
  return codes;
}

function normalizeBackupCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
}

async function hashBackupCode(code) {
  const buf = new TextEncoder().encode(normalizeBackupCode(code));
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return mfaBytesToBase64(new Uint8Array(hash));
}

async function setBackupCodes(env, uid, plainCodes) {
  const hashed = await Promise.all(plainCodes.map(hashBackupCode));
  await env.KV_NAMESPACE.put(MFA_KV_BACKUP_PREFIX + uid, JSON.stringify(hashed));
}

// Consume a backup code (single-use). Returns true if accepted.
// Uses constant-time array search so timing doesn't reveal which
// position the matching hash held.
async function consumeBackupCode(env, uid, code) {
  const list = await env.KV_NAMESPACE.get(MFA_KV_BACKUP_PREFIX + uid, 'json');
  if (!Array.isArray(list) || list.length === 0) return { ok: false, remaining: 0 };
  const target = await hashBackupCode(code);
  let matchIdx = -1;
  // Walk the full array even after we find a match — keeps timing
  // independent of position.
  for (let i = 0; i < list.length; i++) {
    let diff = target.length ^ list[i].length;
    for (let j = 0; j < target.length; j++) {
      diff |= target.charCodeAt(j) ^ list[i].charCodeAt(j);
    }
    if (diff === 0 && matchIdx === -1) matchIdx = i;
  }
  if (matchIdx === -1) return { ok: false, remaining: list.length };
  list.splice(matchIdx, 1);
  await env.KV_NAMESPACE.put(MFA_KV_BACKUP_PREFIX + uid, JSON.stringify(list));
  return { ok: true, remaining: list.length };
}

// Verify a Firebase ID token by calling the identitytoolkit
// accounts:lookup endpoint with our service-account credentials.
// Returns { uid, email, emailVerified, claims } on success.
async function verifyFirebaseIdToken(env, idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('missing_id_token');
  }
  const token = await getFirebaseAccessToken(env);
  const sa = getServiceAccount(env);
  const url = 'https://identitytoolkit.googleapis.com/v1/projects/' +
              encodeURIComponent(sa.project_id) + '/accounts:lookup';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ idToken }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('id_token_invalid: ' + resp.status + ' ' + t.slice(0, 200));
  }
  const data = await resp.json();
  const user = data.users && data.users[0];
  if (!user) throw new Error('id_token_user_not_found');
  let claims = {};
  if (user.customAttributes) {
    try { claims = JSON.parse(user.customAttributes); } catch (e) { /* */ }
  }
  return {
    uid: user.localId,
    email: user.email || '',
    emailVerified: !!user.emailVerified,
    claims,
  };
}

// Merge a patch into the user's customAttributes. Firebase stores
// custom claims as a JSON string under customAttributes — total
// size <1000 bytes. We read existing, merge, write back.
async function setUserCustomClaims(env, uid, patch) {
  const lookup = await firebaseAdminFetch(env, '/accounts:lookup', 'POST', {
    localId: [uid],
  });
  if (!lookup.ok) throw new Error('lookup_failed_' + lookup.status);
  const user = lookup.data && lookup.data.users && lookup.data.users[0];
  if (!user) throw new Error('user_not_found');
  let existing = {};
  if (user.customAttributes) {
    try { existing = JSON.parse(user.customAttributes); } catch (e) { /* */ }
  }
  const merged = { ...existing };
  for (const k in patch) {
    if (patch[k] === null) delete merged[k];
    else merged[k] = patch[k];
  }
  const customAttributes = JSON.stringify(merged);
  if (customAttributes.length > 1000) {
    throw new Error('custom_claims_too_large');
  }
  const upd = await firebaseAdminFetch(env, '/accounts:update', 'POST', {
    localId: uid, customAttributes,
  });
  if (!upd.ok) throw new Error('update_failed_' + upd.status);
  return merged;
}

// Per-UID lockout state.
async function getMfaLockState(env, uid) {
  if (!env.KV_NAMESPACE) return { locked: false, fails: 0 };
  const raw = await env.KV_NAMESPACE.get(MFA_KV_LOCK_PREFIX + uid, 'json');
  if (!raw) return { locked: false, fails: 0 };
  const now = Math.floor(Date.now() / 1000);
  if (raw.until && raw.until > now) {
    return { locked: true, until: raw.until, fails: raw.fails || 0 };
  }
  return { locked: false, fails: raw.fails || 0 };
}

async function recordMfaFail(env, uid) {
  if (!env.KV_NAMESPACE) return;
  const cur = await env.KV_NAMESPACE.get(MFA_KV_LOCK_PREFIX + uid, 'json') || { fails: 0 };
  const fails = (cur.fails || 0) + 1;
  const now = Math.floor(Date.now() / 1000);
  const patch = { fails, lastFailAt: now };
  if (fails >= MFA_LOCK_FAIL_MAX) {
    patch.until = now + MFA_LOCK_WINDOW_S;
  }
  await env.KV_NAMESPACE.put(
    MFA_KV_LOCK_PREFIX + uid,
    JSON.stringify(patch),
    { expirationTtl: MFA_LOCK_WINDOW_S }
  );
}

async function clearMfaFails(env, uid) {
  if (!env.KV_NAMESPACE) return;
  try { await env.KV_NAMESPACE.delete(MFA_KV_LOCK_PREFIX + uid); } catch (e) { /* */ }
}

// Replay protection: each counter that successfully verified is
// remembered for MFA_REPLAY_TTL_S so an attacker who sniffs a
// valid code can't re-submit it inside the same window.
async function isReplayed(env, uid, counter) {
  if (!env.KV_NAMESPACE) return false;
  const key = MFA_KV_REPLAY_PREFIX + uid + '_' + counter;
  return !!(await env.KV_NAMESPACE.get(key));
}

async function markReplayUsed(env, uid, counter) {
  if (!env.KV_NAMESPACE) return;
  await env.KV_NAMESPACE.put(
    MFA_KV_REPLAY_PREFIX + uid + '_' + counter,
    '1',
    { expirationTtl: MFA_REPLAY_TTL_S }
  );
}

// Structured audit-log breadcrumb. Picked up by `wrangler tail` and
// (if observability is enabled) by Cloudflare Logs. Pairs with the
// client-side write to Firestore /auditLog so both surfaces have
// the same record.
function mfaLog(action, uid, request, extra) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 120);
  const entry = Object.assign({
    action: 'mfa_' + action,
    uid: uid ? uid.slice(0, 8) + '…' : '?',
    ip,
    ua,
    ts: new Date().toISOString(),
  }, extra || {});
  console.log('[mfa-audit]', JSON.stringify(entry));
}

function mfaResponse(action, uid, payload, request, status, extra) {
  mfaLog(action, uid, request, Object.assign({ status: status || 200 }, extra || {}));
  return jsonResponse(payload, request, status || 200);
}

// ── GET /mfa/health ─────────────────────────────────────────────
// Public, no auth. Returns the result of running RFC 6238 Appendix B
// test vectors through totpComputeCode + an AES-GCM round-trip.
// Use this in CI or after a deploy to confirm the crypto path is
// intact. Surfaces missing config (KV, encryption key, service acct).
async function handleMfaHealth(request, env) {
  // RFC 6238 Appendix B test vector for SHA-1, secret = ASCII
  // "12345678901234567890" (20 bytes), counter = 1 → "287082"
  const testKey = new Uint8Array([
    0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30,
    0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30,
  ]);
  const code = await totpComputeCode(testKey, 1);
  const totpOk = code === '287082';

  let aesOk = false, aesErr = null;
  try {
    const sample = 'JBSWY3DPEHPK3PXP';  // a base32 string
    const enc = await mfaEncryptSecret(sample, env);
    const dec = await mfaDecryptSecret(enc, env);
    aesOk = dec === sample;
  } catch (e) {
    aesErr = String(e.message || e);
  }

  return jsonResponse({
    totp_rfc6238_test_vector_ok: totpOk,
    totp_computed: code,
    totp_expected: '287082',
    aes_gcm_roundtrip_ok: aesOk,
    aes_gcm_error: aesErr,
    config: {
      kv_namespace: !!env.KV_NAMESPACE,
      mfa_encryption_key: !!env.MFA_ENCRYPTION_KEY,
      firebase_service_account: !!env.FIREBASE_SERVICE_ACCOUNT,
    },
    timestamp: new Date().toISOString(),
  }, request);
}

// ── POST /mfa/status ────────────────────────────────────────────
async function handleMfaStatus(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_status');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }
  const stored = env.KV_NAMESPACE
    ? await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid, 'json')
    : null;
  const backupRaw = env.KV_NAMESPACE
    ? await env.KV_NAMESPACE.get(MFA_KV_BACKUP_PREFIX + user.uid, 'json')
    : null;
  const lock = await getMfaLockState(env, user.uid);
  return mfaResponse('status', user.uid, {
    enrolled: !!stored,
    enrolledAt: stored ? stored.enrolledAt : null,
    backupCodesRemaining: Array.isArray(backupRaw) ? backupRaw.length : 0,
    locked: lock.locked,
    lockUntil: lock.until || null,
    verifiedAt: user.claims.mfaVerifiedAt || null,
    verifiedValidUntil: user.claims.mfaVerifiedAt
      ? user.claims.mfaVerifiedAt + MFA_VERIFIED_VALID_S
      : null,
  }, request);
}

// ── POST /mfa/enroll-start ──────────────────────────────────────
async function handleMfaEnrollStart(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_enroll');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);
  if (!env.MFA_ENCRYPTION_KEY) {
    return jsonResponse({
      error: 'mfa_encryption_key_not_configured',
      hint: 'Set wrangler secret MFA_ENCRYPTION_KEY (32 random bytes, base64). See RUNBOOK.md.',
    }, request, 500);
  }

  // Already enrolled? Refuse — they must unenroll first (which
  // requires a valid current code, so they can't lock themselves
  // out accidentally).
  const existing = await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid);
  if (existing) {
    return mfaResponse('enroll_start', user.uid, { error: 'already_enrolled' }, request, 409);
  }

  // 160 bits of entropy per RFC 4226 §4 recommendation (≥128 bits).
  const raw = crypto.getRandomValues(new Uint8Array(20));
  const secret = mfaBase32Encode(raw);
  const issuer = 'Loopenta';
  const label  = encodeURIComponent(issuer + ':' + (user.email || user.uid));
  const otpauthUri = 'otpauth://totp/' + label +
    '?secret=' + secret +
    '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=6&period=' + MFA_STEP_SECONDS;

  // Encrypt the pending secret too — the 10-min TTL window is short
  // but defense-in-depth costs nothing.
  let pendingRecord;
  try {
    const enc = await mfaEncryptSecret(secret, env);
    pendingRecord = Object.assign({ createdAt: Math.floor(Date.now() / 1000) }, enc);
  } catch (e) {
    return jsonResponse({ error: 'encryption_failed', detail: String(e.message || e) }, request, 500);
  }
  await env.KV_NAMESPACE.put(
    MFA_KV_PENDING_PREFIX + user.uid,
    JSON.stringify(pendingRecord),
    { expirationTtl: MFA_PENDING_TTL_S }
  );

  return mfaResponse('enroll_start', user.uid, {
    secret, otpauthUri,
    expiresInSeconds: MFA_PENDING_TTL_S,
  }, request);
}

// ── POST /mfa/enroll-confirm ────────────────────────────────────
async function handleMfaEnrollConfirm(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_verify');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);

  const pending = await env.KV_NAMESPACE.get(MFA_KV_PENDING_PREFIX + user.uid, 'json');
  if (!pending || !pending.ciphertext) {
    return jsonResponse({ error: 'no_pending_enrollment' }, request, 400);
  }
  let pendingSecret;
  try { pendingSecret = await mfaDecryptSecret(pending, env); }
  catch (e) { return jsonResponse({ error: 'decryption_failed', detail: String(e.message || e) }, request, 500); }

  const code = String(body.code || '').trim();
  const verify = await totpVerify(pendingSecret, code);
  if (!verify.ok) {
    return mfaResponse('enroll_confirm_failed', user.uid, { error: 'invalid_code' }, request, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  // Promote pending → permanent (still encrypted).
  let permanentRecord;
  try {
    const enc = await mfaEncryptSecret(pendingSecret, env);
    permanentRecord = Object.assign({ enrolledAt: now }, enc);
  } catch (e) {
    return jsonResponse({ error: 'encryption_failed', detail: String(e.message || e) }, request, 500);
  }
  await env.KV_NAMESPACE.put(
    MFA_KV_SECRET_PREFIX + user.uid,
    JSON.stringify(permanentRecord)
  );
  await env.KV_NAMESPACE.delete(MFA_KV_PENDING_PREFIX + user.uid);
  await markReplayUsed(env, user.uid, verify.counter);

  // Issue 10 backup codes. Plaintext returned ONCE to the client.
  const backupCodes = generateBackupCodes();
  await setBackupCodes(env, user.uid, backupCodes);

  try {
    await setUserCustomClaims(env, user.uid, {
      mfaEnabled: true,
      mfaEnrolledAt: now,
      mfaVerifiedAt: now,
    });
  } catch (e) {
    // Secret + backup codes are saved. Surface the error — the user
    // can retry the enroll-confirm and we'll re-merge the claim
    // (setUserCustomClaims is idempotent). Note the secret persists,
    // which is the safer failure mode (they can verify with the
    // code; the claim will sync on next /mfa/verify).
    return jsonResponse({ error: 'claim_write_failed', detail: String(e.message || e) }, request, 500);
  }

  return mfaResponse('enroll_confirmed', user.uid, {
    enrolled: true, enrolledAt: now,
    backupCodes,  // shown ONCE; client must persist or display now
    backupCodesNote: 'Save these immediately. They are shown only once. Each can be used a single time if you lose your authenticator.',
  }, request);
}

// ── POST /mfa/verify ────────────────────────────────────────────
// Used at sign-in for accounts with mfaEnabled: true. Sets
// mfaVerifiedAt claim so Firestore rules can require recent verify.
async function handleMfaVerify(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_verify');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);

  const lock = await getMfaLockState(env, user.uid);
  if (lock.locked) {
    return mfaResponse('verify_locked', user.uid, {
      error: 'mfa_locked',
      lockUntil: lock.until,
      retryAfterSeconds: lock.until - Math.floor(Date.now() / 1000),
    }, request, 429);
  }

  const stored = await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid, 'json');
  if (!stored || !stored.ciphertext) {
    return jsonResponse({ error: 'not_enrolled' }, request, 400);
  }
  let secret;
  try { secret = await mfaDecryptSecret(stored, env); }
  catch (e) { return jsonResponse({ error: 'decryption_failed', detail: String(e.message || e) }, request, 500); }

  const code = String(body.code || '').trim();
  const verify = await totpVerify(secret, code);
  if (!verify.ok) {
    await recordMfaFail(env, user.uid);
    const after = await getMfaLockState(env, user.uid);
    return mfaResponse('verify_failed', user.uid, {
      error: 'invalid_code',
      failsRemaining: Math.max(0, MFA_LOCK_FAIL_MAX - after.fails),
      locked: after.locked,
      lockUntil: after.until || null,
    }, request, 400);
  }
  if (await isReplayed(env, user.uid, verify.counter)) {
    await recordMfaFail(env, user.uid);
    return mfaResponse('verify_replay_blocked', user.uid, { error: 'code_already_used' }, request, 400);
  }
  await markReplayUsed(env, user.uid, verify.counter);
  await clearMfaFails(env, user.uid);

  const now = Math.floor(Date.now() / 1000);
  try {
    await setUserCustomClaims(env, user.uid, { mfaVerifiedAt: now });
  } catch (e) {
    return jsonResponse({ error: 'claim_write_failed', detail: String(e.message || e) }, request, 500);
  }

  return mfaResponse('verified', user.uid, {
    verified: true, verifiedAt: now,
    validUntil: now + MFA_VERIFIED_VALID_S,
  }, request);
}

// ── POST /mfa/verify-backup ─────────────────────────────────────
// Single-use backup code path for users who've lost their
// authenticator. Same lockout + claim behaviour as /mfa/verify
// (the backup code IS a valid second factor), but consumes the
// code from KV so it can never be reused.
async function handleMfaVerifyBackup(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_verify');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);

  const lock = await getMfaLockState(env, user.uid);
  if (lock.locked) {
    return mfaResponse('backup_locked', user.uid, {
      error: 'mfa_locked',
      lockUntil: lock.until,
    }, request, 429);
  }

  const stored = await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid, 'json');
  if (!stored) return jsonResponse({ error: 'not_enrolled' }, request, 400);

  const code = body.backupCode || '';
  const result = await consumeBackupCode(env, user.uid, code);
  if (!result.ok) {
    await recordMfaFail(env, user.uid);
    const after = await getMfaLockState(env, user.uid);
    return mfaResponse('backup_failed', user.uid, {
      error: 'invalid_backup_code',
      remaining: result.remaining,
      failsRemaining: Math.max(0, MFA_LOCK_FAIL_MAX - after.fails),
      locked: after.locked,
      lockUntil: after.until || null,
    }, request, 400);
  }

  await clearMfaFails(env, user.uid);

  const now = Math.floor(Date.now() / 1000);
  try {
    await setUserCustomClaims(env, user.uid, { mfaVerifiedAt: now });
  } catch (e) {
    return jsonResponse({ error: 'claim_write_failed', detail: String(e.message || e) }, request, 500);
  }

  return mfaResponse('backup_consumed', user.uid, {
    verified: true, verifiedAt: now,
    validUntil: now + MFA_VERIFIED_VALID_S,
    backupCodesRemaining: result.remaining,
    warnLowBackup: result.remaining <= 3,
  }, request);
}

// ── POST /mfa/regenerate-backup ─────────────────────────────────
// Issue a fresh set of 10 backup codes. Requires a valid CURRENT
// TOTP code (so a stolen session can't regenerate codes; the
// authenticator app is still required).
async function handleMfaRegenerateBackup(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_verify');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);

  const lock = await getMfaLockState(env, user.uid);
  if (lock.locked) {
    return mfaResponse('regen_locked', user.uid, { error: 'mfa_locked', lockUntil: lock.until }, request, 429);
  }

  const stored = await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid, 'json');
  if (!stored || !stored.ciphertext) {
    return jsonResponse({ error: 'not_enrolled' }, request, 400);
  }
  let secret;
  try { secret = await mfaDecryptSecret(stored, env); }
  catch (e) { return jsonResponse({ error: 'decryption_failed' }, request, 500); }

  const code = String(body.code || '').trim();
  const verify = await totpVerify(secret, code);
  if (!verify.ok) {
    await recordMfaFail(env, user.uid);
    return mfaResponse('regen_failed', user.uid, { error: 'invalid_code' }, request, 400);
  }

  // Issue fresh codes.
  const fresh = generateBackupCodes();
  await setBackupCodes(env, user.uid, fresh);

  return mfaResponse('backup_regenerated', user.uid, {
    backupCodes: fresh,
    note: 'Old backup codes are now invalid. Save these immediately.',
  }, request);
}

// ── POST /mfa/unenroll ──────────────────────────────────────────
// Requires a valid CURRENT TOTP code (so a stolen session can't
// silently disable MFA).
async function handleMfaUnenroll(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_verify');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);

  const lock = await getMfaLockState(env, user.uid);
  if (lock.locked) {
    return mfaResponse('unenroll_locked', user.uid, { error: 'mfa_locked', lockUntil: lock.until }, request, 429);
  }

  const stored = await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid, 'json');
  if (!stored || !stored.ciphertext) {
    return jsonResponse({ error: 'not_enrolled' }, request, 400);
  }
  let secret;
  try { secret = await mfaDecryptSecret(stored, env); }
  catch (e) { return jsonResponse({ error: 'decryption_failed' }, request, 500); }

  const code = String(body.code || '').trim();
  const verify = await totpVerify(secret, code);
  if (!verify.ok) {
    await recordMfaFail(env, user.uid);
    return mfaResponse('unenroll_failed', user.uid, { error: 'invalid_code' }, request, 400);
  }

  await env.KV_NAMESPACE.delete(MFA_KV_SECRET_PREFIX + user.uid);
  await env.KV_NAMESPACE.delete(MFA_KV_BACKUP_PREFIX + user.uid);
  await clearMfaFails(env, user.uid);
  try {
    await setUserCustomClaims(env, user.uid, {
      mfaEnabled: null,
      mfaEnrolledAt: null,
      mfaVerifiedAt: null,
    });
  } catch (e) {
    return jsonResponse({ error: 'claim_write_failed', detail: String(e.message || e) }, request, 500);
  }

  return mfaResponse('unenrolled', user.uid, { unenrolled: true }, request);
}

// ── POST /mfa/show-qr ───────────────────────────────────────────
// Re-display the otpauth:// URI for the user's existing enrollment
// so they can scan it into a different/additional authenticator app
// (e.g. lost the iOS Passwords entry, switching to 1Password, etc.).
//
// Security model — why this is safe:
//   • Requires a recent `mfaVerifiedAt` claim (< 15 min old). An
//     attacker with a stolen session but no current TOTP code or
//     backup code can't satisfy this — they'd have to defeat MFA
//     first, at which point they're already past it.
//   • Audit-logged loudly via mfaLog + Firestore /auditLog so we
//     can spot abuse pattern (repeated show-qr by same user).
//   • Returns the SAME secret already in KV (not a new one) — the
//     authenticator app entry the user already has remains valid.
//
// What this is NOT for:
//   • First-time enrollment (use /mfa/enroll-start)
//   • Recovery after MFA failure (use /mfa/verify-backup with a
//     saved backup code)
const MFA_RECENT_VERIFY_S = 15 * 60;  // 15 min window for show-qr

async function handleMfaShowQr(request, env) {
  const rl = await checkPublicRateLimit(request, env, 'mfa_verify');
  if (rl) return rl;
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid_json' }, request, 400); }
  let user;
  try { user = await verifyFirebaseIdToken(env, body.idToken); }
  catch (e) { return jsonResponse({ error: 'id_token_invalid' }, request, 401); }

  if (!env.KV_NAMESPACE) return jsonResponse({ error: 'kv_not_configured' }, request, 500);

  // Require recent mfaVerifiedAt — this is the proof that the
  // caller actually has the second factor (or did within the last
  // 15 min). A stolen session alone shouldn't be enough.
  const verifiedAt = user.claims.mfaVerifiedAt || 0;
  const now = Math.floor(Date.now() / 1000);
  if (!verifiedAt || verifiedAt < now - MFA_RECENT_VERIFY_S) {
    return mfaResponse('show_qr_denied_stale', user.uid, {
      error: 'recent_mfa_verification_required',
      message: 'For security, this requires that you verified your authenticator within the last 15 minutes. Sign out and sign back in (or use a backup code) and try immediately after.',
      verifiedAt: verifiedAt || null,
      requiredAfter: now - MFA_RECENT_VERIFY_S,
    }, request, 403);
  }

  const stored = await env.KV_NAMESPACE.get(MFA_KV_SECRET_PREFIX + user.uid, 'json');
  if (!stored || !stored.ciphertext) {
    return jsonResponse({ error: 'not_enrolled' }, request, 400);
  }
  let secret;
  try { secret = await mfaDecryptSecret(stored, env); }
  catch (e) { return jsonResponse({ error: 'decryption_failed', detail: String(e.message || e) }, request, 500); }

  const issuer = 'Loopenta';
  const label  = encodeURIComponent(issuer + ':' + (user.email || user.uid));
  const otpauthUri = 'otpauth://totp/' + label +
    '?secret=' + secret +
    '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=6&period=' + MFA_STEP_SECONDS;

  return mfaResponse('show_qr', user.uid, {
    secret,
    otpauthUri,
    enrolledAt: stored.enrolledAt || null,
    note: 'Scanning this into another authenticator app gives that app the SAME secret as your existing enrollment — codes will match. If you want a different secret, remove your enrollment first, then re-enroll fresh.',
  }, request);
}
