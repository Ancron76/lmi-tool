// ═══════════════════════════════════════════════════════════
// lmi-proxy Cloudflare Worker
// Deployed at: lmi-proxy.aaronsimonson.workers.dev
//
// Routes:
//   GET  ?zip=XXXXX                → LMI tract lookup (FFIEC fallback for
//                                    the main lmi-tool worker)
//   POST /sms/send                 → Send SMS via Twilio
//   POST /sms/incoming             → Twilio incoming SMS webhook
//                                    (verifies X-Twilio-Signature)
//   POST /sms/provision            → Provision Twilio phone number
//
// Environment variables (set in Cloudflare dashboard):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN — for the SMS routes
//   (RAPIDAPI_KEY no longer needed — property intelligence was
//    moved entirely into worker.js)
// ═══════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = [
  'https://lmitool.com',
  'https://www.lmitool.com',
  'https://loopenta.com',
  'https://www.loopenta.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Allow same-origin requests (no Origin header) and direct worker hits
  if (!origin) return '*';
  return null;
}

function corsHeaders(request) {
  const origin = getAllowedOrigin(request);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResp(data, request, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

// Emits an error with an `x-deny-reason` header so the frontend can
// self-diagnose without parsing the body. The body still carries detail.
// Also emits `x-attempts-summary` (a compact "year:scope=status,..." string)
// so per-year diagnostic info survives the frontend's body-truncation.
function errResp(reason, data, request, status, attempts) {
  const body = { error: data && data.error || reason, reason };
  if (data) Object.assign(body, data);
  if (attempts && attempts.length) body.attempts = attempts;
  const extra = { 'x-deny-reason': reason };
  if (attempts && attempts.length) {
    extra['x-attempts-summary'] = attempts
      .map(a => {
        const scope = a.scope || '?';
        const code = a.ok ? 'ok' : (a.status || a.reason || 'err');
        return (a.year ? a.year + ':' : '') + scope + '=' + code;
      })
      .join(',')
      .slice(0, 400);
  }
  return jsonResp(body, request, status, extra);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      // (Property Intelligence Engine was removed from the proxy — the
      // canonical handler lives in worker.js, the frontend uses same-
      // origin for it, and the proxy copy had drifted away from the
      // worker version. Audit confirmed no external callers.)

      // ── SMS routes ────────────────────────────────────────
      if (url.pathname === '/sms/send' && request.method === 'POST') {
        return handleSmsSend(request, env);
      }
      if (url.pathname === '/sms/incoming' && request.method === 'POST') {
        return handleSmsIncoming(request, env);
      }
      if (url.pathname === '/sms/provision' && request.method === 'POST') {
        return handleSmsProvision(request, env);
      }

      // ── LMI Tract Lookup (default route) ──────────────────
      const zip = url.searchParams.get('zip');
      if (zip) {
        return handleLmiLookup(zip, request);
      }

      return errResp('not_found', { error: 'Not found', path: url.pathname }, request, 404);
    } catch (e) {
      return errResp('internal_error', { error: e.message || 'Internal error' }, request, 500);
    }
  },
};

// ═══════════════════════════════════════════════════════════
// LMI TRACT LOOKUP (Census Bureau ACS API)
// ═══════════════════════════════════════════════════════════

// CA ZIP prefix → county FIPS (state FIPS 06 + county code)
const ZIP_TO_COUNTY = {
  '900': '06037', '901': '06037', '902': '06037', '903': '06037', '904': '06037',
  '905': '06037', '906': '06037', '907': '06037', '908': '06037',
  '910': '06037', '911': '06037', '912': '06037', '913': '06037', '914': '06037',
  '915': '06037', '916': '06037', '917': '06037', '918': '06037',
  '919': '06111', // Ventura
  '920': '06073', '921': '06073', // San Diego
  '922': '06025', // Imperial
  '923': '06065', '924': '06065', '925': '06065', // Riverside
  '926': '06059', '927': '06059', '928': '06059', // Orange
  '930': '06111', // Ventura (Oxnard, Thousand Oaks, Simi Valley)
  '931': '06083', // Santa Barbara (Santa Barbara, Goleta, Lompoc)
  '932': '06029', '933': '06029', // Kern
  '934': '06079', // San Luis Obispo
  '935': '06029', // Kern (Mojave, Tehachapi, Ridgecrest)
  '936': '06019', '937': '06019', // Fresno
  '938': '06019', // Fresno
  '939': '06107', // Tulare
  '940': '06081', // San Mateo
  '941': '06075', // San Francisco
  '942': '06081', // San Mateo
  '943': '06001', // Alameda
  '944': '06075', // San Francisco
  '945': '06001', // Alameda
  '946': '06001', // Alameda
  '947': '06013', // Contra Costa
  '948': '06097', // Sonoma
  '949': '06041', // Marin
  '950': '06085', // Santa Clara
  '951': '06085', // Santa Clara
  '952': '06087', // Santa Cruz
  '953': '06069', // San Benito
  '954': '06085', // Santa Clara
  '955': '06077', // San Joaquin
  '956': '06077', // San Joaquin
  '957': '06039', // Madera
  '958': '06067', // Sacramento
  '959': '06067', // Sacramento
  '960': '06089', // Shasta
  '961': '06007', // Butte
  '962': '06007', // Butte
};

// MSA codes for CA counties (for AMI lookup)
const COUNTY_TO_MSA = {
  '06037': '31080', '06059': '31080', // LA-Long Beach-Anaheim
  '06073': '41740', // San Diego
  '06065': '40140', '06071': '40140', // Riverside-San Bernardino
  '06019': '23420', // Fresno
  '06077': '44700', // Stockton
  '06067': '40900', // Sacramento
  '06085': '41940', '06081': '41940', '06075': '41940', '06001': '41940', '06013': '41940', '06041': '41940', // SF Bay Area
  '06029': '12540', // Bakersfield (Kern)
  '06111': '37100', // Ventura (Oxnard)
  '06107': '47300', // Visalia (Tulare)
  '06083': '42200', // Santa Barbara (Santa Maria)
  '06025': '20940', // El Centro (Imperial)
  '06089': '39820', // Redding (Shasta)
  '06007': '17020', // Chico (Butte)
  '06039': '31460', // Madera
  '06079': '42020', // San Luis Obispo
  '06087': '42100', // Santa Cruz
  '06069': '41940', // San Benito (part of SJ-SF-Oakland)
  '06097': '42220', // Santa Rosa (Sonoma)
};

// ─────────────────────────────────────────────────────────────
// LMI lookup helpers — mirrors the main lmi-tool worker.
//
// The previous implementation hit api.census.gov directly, but production
// diagnostics in commit 450bb68/24e872a showed every ACS year (2023-2020)
// failing from this Worker's network path. Census API blocks or throttles
// some Cloudflare egress; switching to CFPB FFIEC matches what the main
// worker uses successfully. Both workers now share the same data source,
// so the proxy is a true hot standby — when the main worker is briefly
// unreachable (deploys in flight, route hiccups), the frontend's
// proxy-fallback path lands on identical logic.
// ─────────────────────────────────────────────────────────────

function classifyIncomeRatio(ratio) {
  if (ratio === null || ratio === undefined || !isFinite(ratio)) return 'Unknown';
  if (ratio < 50)  return 'Low';
  if (ratio < 80)  return 'Moderate';
  if (ratio < 120) return 'Middle';
  return 'Upper';
}

function normalizeTractId(raw) {
  if (!raw) return '';
  const s = String(raw).trim().replace(/\D/g, '');
  if (!s) return '';
  if (s.length >= 15) return s.slice(0, 11);
  if (s.length === 11) return s;
  if (s.length === 10) return '0' + s;
  return s.padStart(11, '0');
}

// Stream a response body line-by-line with a hard byte cap. CFPB redirects
// every nationwide CSV query to the same ~3 MB pre-built file (filters are
// silently ignored), so a 5 MB cap is generous headroom without risking
// the Worker's 128 MB memory limit on `.text()`.
async function streamTextCapped(resp, maxBytes, onLine) {
  if (!resp.body) {
    const text = await resp.text();
    if (text.length > maxBytes) return { tooLarge: true, bytesRead: text.length };
    if (onLine) for (const line of text.split('\n')) { const r = onLine(line); if (r && r.stop) break; }
    return { tooLarge: false, bytesRead: text.length, text };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        return { tooLarge: true, bytesRead };
      }
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (onLine) {
          const r = onLine(line);
          if (r && r.stop) { try { await reader.cancel(); } catch (e) {} return { tooLarge: false, bytesRead, stopped: true }; }
        }
      }
    }
    if (buffer.length && onLine) onLine(buffer);
  } catch (e) {
    return { tooLarge: false, bytesRead, error: String(e && e.message || e) };
  }
  return { tooLarge: false, bytesRead };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (inQ) {
      if (c === 34) {
        if (line.charCodeAt(i + 1) === 34) { cur += '"'; i++; }
        else { inQ = false; }
      } else { cur += line[i]; }
    } else {
      if (c === 34) inQ = true;
      else if (c === 44) { out.push(cur.trim()); cur = ''; }
      else cur += line[i];
    }
  }
  out.push(cur.trim());
  return out;
}

// Fetches tracts for a county FIPS from the CFPB FFIEC HMDA nationwide CSV.
// IMPORTANT: CFPB's data-browser-api ignores every filter besides `years`
// and `actions_taken` (verified — Fresno, LA, and no-filter all redirect to
// the same pre-built file). We get the full national dataset and filter
// rows in the stream by the 5-digit state+county FIPS prefix.
async function fetchCfpbTractsForCounty(countyFips, attempts) {
  const yearsToTry = [2023, 2022, 2021, 2020, 2019, 2018];
  for (const year of yearsToTry) {
    const ffiecUrl =
      'https://ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv' +
      '?years=' + year +
      '&actions_taken=1,2,3' +
      '&fields=census_tract,tract_population,' +
      'tract_minority_population_percent,' +
      'ffiec_msa_md_median_family_income,' +
      'tract_to_msa_income_percentage';

    let res;
    try {
      res = await fetch(ffiecUrl, { headers: { 'User-Agent': 'LMI-Tool/1.0' } });
    } catch (e) {
      attempts.push({ year, scope: 'cfpb', ok: false, reason: 'fetch_threw', error: String(e && e.message || e) });
      continue;
    }
    if (!res.ok) {
      attempts.push({ year, scope: 'cfpb', ok: false, status: res.status });
      continue;
    }

    const MAX_BYTES = 5 * 1024 * 1024;
    let headers = null;
    const tracts = [];
    const seen = new Set();
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
        // Filter: keep only tracts inside the requested county.
        if (!rawId.startsWith(countyFips)) return null;
        const incomeRatio = parseFloat(row.tract_to_msa_income_percentage);
        const msaMfi = parseInt(row.ffiec_msa_md_median_family_income) || 0;
        const tractMfi = isFinite(incomeRatio) && msaMfi
          ? Math.round((incomeRatio / 100) * msaMfi)
          : 0;
        const tractPop = parseInt(row.tract_population) || 0;
        const key = normalizeTractId(rawId);
        if (seen.has(key)) return null;
        seen.add(key);
        tracts.push({
          tract_id: rawId,
          tract_id_normalized: key,
          census_tract: rawId,
          tract_population: tractPop,
          population: tractPop,
          minority_pct: parseFloat(row.tract_minority_population_percent) || 0,
          median_family_income: msaMfi,
          area_md_fam_income: msaMfi,
          tract_md_fam_income: tractMfi,
          income_ratio: isFinite(incomeRatio) ? incomeRatio : null,
          lmi_status: isFinite(incomeRatio) && incomeRatio <= 80,
          lmi_category: classifyIncomeRatio(isFinite(incomeRatio) ? incomeRatio : null),
          city: '',
          hmda_year: year,
        });
        return null;
      });
    } catch (e) {
      attempts.push({ year, scope: 'cfpb', ok: false, reason: 'body_read_failed', error: String(e && e.message || e) });
      continue;
    }
    if (!headers) {
      attempts.push({ year, scope: 'cfpb', ok: false, reason: 'no_headers_in_stream', bytesRead: streamResult && streamResult.bytesRead });
      continue;
    }
    if (!tracts.length) {
      attempts.push({ year, scope: 'cfpb', ok: false, reason: 'no_tracts_in_county', countyFips });
      continue;
    }
    attempts.push({ year, scope: 'cfpb', ok: true, tracts: tracts.length });
    return { year, tracts };
  }
  return null;
}

async function handleLmiLookup(zip, request) {
  if (!/^\d{5}$/.test(zip)) {
    return errResp('invalid_zip', { error: 'Invalid zip code' }, request, 400);
  }

  const prefix = zip.substring(0, 3);
  const countyFips = ZIP_TO_COUNTY[prefix];
  if (!countyFips) {
    return errResp('zip_not_in_coverage', {
      error: 'ZIP code not in coverage area',
      zip,
      coverage: 'California only (lmi-proxy fallback). The primary lmi-tool Worker covers all states.',
    }, request, 400);
  }

  const attempts = [];
  let result;
  try {
    result = await fetchCfpbTractsForCounty(countyFips, attempts);
  } catch (e) {
    return errResp('cfpb_unreachable', {
      error: 'CFPB FFIEC API unreachable',
      detail: String(e && e.message || e),
    }, request, 502, attempts);
  }

  if (!result) {
    return errResp('cfpb_all_years_failed', {
      error: 'CFPB FFIEC returned no usable data for any tried year',
      zip,
      countyFips,
    }, request, 502, attempts);
  }

  // Sort: LMI tracts first (lowest income ratio), then others.
  result.tracts.sort((a, b) => {
    const ar = a.income_ratio == null ? 9999 : a.income_ratio;
    const br = b.income_ratio == null ? 9999 : b.income_ratio;
    return ar - br;
  });
  return jsonResp(result.tracts, request);
}


// ═══════════════════════════════════════════════════════════
// SMS ROUTES
// ═══════════════════════════════════════════════════════════

async function handleSmsSend(request, env) {
  const { to, message, fromNumber } = await request.json();
  if (!to || !message || !fromNumber) return jsonResp({ success: false, error: 'Missing to, message, or fromNumber' }, request, 400);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return jsonResp({ success: false, error: 'Twilio not configured' }, request, 500);

  const twilioUrl = 'https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_ACCOUNT_SID + '/Messages.json';
  const auth = btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN);

  const body = new URLSearchParams({ To: to, From: fromNumber, Body: message });

  const resp = await fetch(twilioUrl, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await resp.json();
  if (data.sid) {
    return jsonResp({ success: true, messageSid: data.sid }, request);
  }
  return jsonResp({ success: false, error: data.message || 'Twilio error' }, request, 500);
}

// Twilio webhook signature verification.
// https://www.twilio.com/docs/usage/security#validating-requests
// Signature = base64( HMAC-SHA1( authToken, url + sortedFormParams ) ).
// Twilio sends it in the X-Twilio-Signature header.
async function verifyTwilioSignature(request, env, urlOverride) {
  if (!env || !env.TWILIO_AUTH_TOKEN) return false;
  const sig = request.headers.get('X-Twilio-Signature') || '';
  if (!sig) return false;
  // Twilio signs the FULL URL Twilio was configured to POST to (including
  // any query string). Use the override if provided so callers can pin
  // the exact URL Twilio sees (especially behind a reverse proxy).
  const url = urlOverride || request.url;
  const form = await request.clone().formData();
  // Sort form params by key, concatenate as key+value pairs.
  const keys = [];
  form.forEach((_, k) => { keys.push(k); });
  keys.sort();
  let payload = url;
  for (const k of keys) payload += k + form.get(k);
  // HMAC-SHA1 via Web Crypto.
  const keyBytes = new TextEncoder().encode(env.TWILIO_AUTH_TOKEN);
  const dataBytes = new TextEncoder().encode(payload);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign']
  );
  const macBuf = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  const mac = btoa(String.fromCharCode.apply(null, new Uint8Array(macBuf)));
  // Constant-time comparison.
  if (mac.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function handleSmsIncoming(request, env) {
  // Verify the call really came from Twilio. Previously this endpoint
  // returned 200 to any POST — anyone could forge "incoming" SMS
  // events. Currently a no-op, but if we ever wire in auto-replies,
  // billing, or analytics this becomes an abuse vector. Reject anything
  // that doesn't carry a valid X-Twilio-Signature.
  const ok = await verifyTwilioSignature(request, env);
  if (!ok) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders(request) });
  }
  // (Body intentionally unused — we log inbound SMS via Firestore
  // client-side. Kept the signature gate above for future expansion.)
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml', ...corsHeaders(request) } }
  );
}

async function handleSmsProvision(request, env) {
  const { areaCode } = await request.json();
  if (!areaCode) return jsonResp({ success: false, error: 'Missing areaCode' }, request, 400);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return jsonResp({ success: false, error: 'Twilio not configured' }, request, 500);

  const auth = btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN);

  // Search for available numbers
  const searchUrl = 'https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_ACCOUNT_SID +
    '/AvailablePhoneNumbers/US/Local.json?AreaCode=' + areaCode + '&SmsEnabled=true&VoiceEnabled=true&PageSize=5';

  const searchResp = await fetch(searchUrl, {
    headers: { Authorization: 'Basic ' + auth },
  });
  const searchData = await searchResp.json();
  const numbers = searchData.available_phone_numbers || [];

  if (!numbers.length) return jsonResp({ success: false, error: 'No numbers available for area code ' + areaCode }, request);

  // Purchase the first available number
  const purchaseUrl = 'https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_ACCOUNT_SID + '/IncomingPhoneNumbers.json';
  const purchaseBody = new URLSearchParams({
    PhoneNumber: numbers[0].phone_number,
    SmsUrl: 'https://lmi-proxy.aaronsimonson.workers.dev/sms/incoming',
    SmsMethod: 'POST',
  });

  const purchaseResp = await fetch(purchaseUrl, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: purchaseBody.toString(),
  });
  const purchaseData = await purchaseResp.json();

  if (purchaseData.sid) {
    return jsonResp({
      success: true,
      phoneNumber: purchaseData.phone_number,
      friendlyName: purchaseData.friendly_name,
      sid: purchaseData.sid,
    }, request);
  }
  return jsonResp({ success: false, error: purchaseData.message || 'Purchase failed' }, request, 500);
}
