// ═══════════════════════════════════════════════════════════
// lmi-proxy Cloudflare Worker
// Deployed at: lmi-proxy.aaronsimonson.workers.dev
//
// Routes:
//   GET  ?zip=XXXXX                → LMI tract lookup (FFIEC proxy)
//   GET  /property-intelligence    → Property Intelligence Engine
//   POST /sms/send                 → Send SMS via Twilio
//   POST /sms/incoming             → Twilio incoming SMS webhook
//   POST /sms/provision            → Provision Twilio phone number
//
// Environment variables (set in Cloudflare dashboard):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   RAPIDAPI_KEY
//   KV_NAMESPACE (KV binding → LMI_PROPERTY_CACHE)
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

function jsonResp(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      // ── Property Intelligence Engine ──────────────────────
      if (url.pathname === '/property-intelligence' && request.method === 'GET') {
        return handlePropertyIntelligence(url, env, request);
      }

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

      return jsonResp({ error: 'Not found' }, request, 404);
    } catch (e) {
      return jsonResp({ error: e.message || 'Internal error' }, request, 500);
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

async function handleLmiLookup(zip, request) {
  if (!/^\d{5}$/.test(zip)) {
    return jsonResp({ error: 'Invalid zip code' }, request, 400);
  }

  const prefix = zip.substring(0, 3);
  const countyFips = ZIP_TO_COUNTY[prefix];
  if (!countyFips) {
    return jsonResp({ error: 'ZIP code not in coverage area' }, request, 400);
  }

  const stateCode = countyFips.substring(0, 2);
  const countyCode = countyFips.substring(2);
  const msaCode = COUNTY_TO_MSA[countyFips] || '';

  try {
    // Fetch tract-level data and MSA AMI in parallel
    const acsYear = 2022; // Most recent stable ACS 5-year
    const [tractRes, amiRes] = await Promise.all([
      // B19113_001E = Median family income, B01003_001E = Population
      fetch(
        'https://api.census.gov/data/' + acsYear + '/acs/acs5' +
        '?get=NAME,B19113_001E,B01003_001E' +
        '&for=tract:*&in=state:' + stateCode + '+county:' + countyCode
      ),
      // MSA-level AMI
      msaCode
        ? fetch(
            'https://api.census.gov/data/' + acsYear + '/acs/acs5' +
            '?get=B19113_001E' +
            '&for=metropolitan%20statistical%20area/micropolitan%20statistical%20area:' + msaCode
          )
        : Promise.resolve(null),
    ]);

    if (!tractRes.ok) {
      return jsonResp({ error: 'Census API error' }, request, 502);
    }

    const tractData = await tractRes.json();
    let ami = 0;
    if (amiRes && amiRes.ok) {
      const amiData = await amiRes.json();
      ami = parseInt(amiData[1]?.[0]) || 0;
    }
    // Fallback: use county median if MSA unavailable
    if (!ami) {
      const countyIncomes = tractData.slice(1)
        .map(r => parseInt(r[1]) || 0)
        .filter(v => v > 0);
      ami = countyIncomes.length > 0
        ? Math.round(countyIncomes.reduce((s, v) => s + v, 0) / countyIncomes.length)
        : 80000;
    }

    // Parse tract data: [NAME, B19113_001E, B01003_001E, state, county, tract]
    const tracts = [];
    const countyName = (tractData[1]?.[0] || '').replace(/Census Tract [\d.]+;\s*/, '').replace(/;\s*California$/, '');

    for (let i = 1; i < tractData.length; i++) {
      const row = tractData[i];
      const tractName = row[0] || '';
      const tractIncome = parseInt(row[1]) || 0;
      const population = parseInt(row[2]) || 0;
      const tractNum = row[5] || '';
      const tractId = stateCode + countyCode + tractNum;

      if (tractIncome <= 0) continue;

      const incomeRatio = ami > 0 ? Math.round((tractIncome / ami) * 100) : 0;

      // Only include LMI tracts (income ratio <= 80%) and borderline (<=120%)
      tracts.push({
        tract_id: tractId,
        tract_md_fam_income: tractIncome,
        area_md_fam_income: ami,
        income_ratio: incomeRatio,
        county_name: countyName,
        city: '',
        population,
        minority_pct: 0,
      });
    }

    // Sort: LMI tracts first (lowest income ratio), then others
    tracts.sort((a, b) => a.income_ratio - b.income_ratio);

    return jsonResp(tracts, request);
  } catch (e) {
    return jsonResp({ error: 'Census API unreachable' }, request, 502);
  }
}


// ═══════════════════════════════════════════════════════════
// PROPERTY INTELLIGENCE ENGINE
// ═══════════════════════════════════════════════════════════
async function handlePropertyIntelligence(url, env, request) {
  const tractId = url.searchParams.get('tractId');
  const zip = url.searchParams.get('zip');
  const county = url.searchParams.get('county') || '';

  if (!tractId || !zip) {
    return jsonResp({ error: 'tractId and zip are required' }, request, 400);
  }

  // Check KV cache (6 hours)
  const cacheKey = 'prop_intel_' + tractId + '_' + zip;
  if (env.KV_NAMESPACE) {
    try {
      const cached = await env.KV_NAMESPACE.get(cacheKey, 'json');
      if (cached) return jsonResp({ ...cached, fromCache: true }, request);
    } catch (e) { /* continue without cache */ }
  }

  // Run all data sources in parallel
  const [
    assessorData,
    hudListings,
    homePathListings,
    homeStepsListings,
    hmdaData,
    craigslistListings,
  ] = await Promise.allSettled([
    fetchAssessorData(tractId, county),
    fetchHudListings(zip),
    fetchHomePathListings(zip),
    fetchHomeStepsListings(zip),
    fetchHmdaData(tractId),
    fetchCraigslistListings(zip),
  ]);

  const properties = assessorData.status === 'fulfilled' ? assessorData.value : [];
  const govListings = [
    ...(hudListings.status === 'fulfilled' ? hudListings.value : []),
    ...(homePathListings.status === 'fulfilled' ? homePathListings.value : []),
    ...(homeStepsListings.status === 'fulfilled' ? homeStepsListings.value : []),
  ];
  const hmda = hmdaData.status === 'fulfilled' ? hmdaData.value : {};
  const cl = craigslistListings.status === 'fulfilled' ? craigslistListings.value : [];

  // Score and correlate
  const scored = scoreAndCorrelate(properties, govListings, hmda, cl);

  // Enrich top 20 with Zillow (rate limited)
  const topProperties = scored.sort((a, b) => b.score - a.score).slice(0, 20);
  const enriched = env.RAPIDAPI_KEY
    ? await enrichWithZillow(topProperties, env)
    : topProperties;

  // Merge enriched back with remaining
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
      craigslist: craigslistListings.status === 'fulfilled' ? cl.length : 0,
    },
    fromCache: false,
  };

  // Cache 6 hours
  if (env.KV_NAMESPACE) {
    try {
      await env.KV_NAMESPACE.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
    } catch (e) { /* non-critical */ }
  }

  return jsonResp(result, request);
}

// ─── Data source: CA County Assessor (ArcGIS) ───────────────
async function fetchAssessorData(tractId, county) {
  const countyFips = tractId.substring(0, 5);

  // LA County direct API
  if (countyFips === '06037') {
    try {
      const r = await fetch(
        'https://portal.assessor.lacounty.gov/api/search?tract=' + encodeURIComponent(tractId),
        { headers: { 'User-Agent': 'LMI-Tool/1.0', Accept: 'application/json' } }
      );
      if (r.ok) {
        const d = await r.json();
        return (d.results || d.Parcels || []).map(p => ({
          apn: p.AIN || p.apn, address: p.SitusAddress || p.address,
          owner: p.OwnerName || p.owner, assessedValue: p.TotalValue || p.assessedValue,
          lastSaleDate: p.LastSaleDate, lastSalePrice: p.LastSaleAmount,
          yearBuilt: p.YearBuilt, sqft: p.SqFt, source: 'la_county_assessor',
        }));
      }
    } catch (e) { /* fall through */ }
  }

  // CA Open Data statewide parcel dataset
  try {
    const r = await fetch(
      'https://services3.arcgis.com/fdvHcZXgKW4I5hLc/arcgis/rest/services/' +
      'California_Parcels/FeatureServer/0/query?' +
      'where=CENSUS_TRACT%3D%27' + encodeURIComponent(tractId) + '%27&' +
      'outFields=APN,SITUS_ADDR,OWNER_NAME,ASSD_VALUE,' +
      'LAST_SALE_DATE,LAST_SALE_PRICE,YEAR_BUILT,SQ_FT&' +
      'f=json&resultRecordCount=200',
      { headers: { 'User-Agent': 'LMI-Tool/1.0' } }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.features || []).map(f => ({
      apn: f.attributes.APN, address: f.attributes.SITUS_ADDR,
      owner: f.attributes.OWNER_NAME, assessedValue: f.attributes.ASSD_VALUE,
      lastSaleDate: f.attributes.LAST_SALE_DATE, lastSalePrice: f.attributes.LAST_SALE_PRICE,
      yearBuilt: f.attributes.YEAR_BUILT, sqft: f.attributes.SQ_FT, source: 'ca_assessor',
    }));
  } catch (e) {
    return [];
  }
}

// ─── Data source: HUD Homes ─────────────────────────────────
async function fetchHudListings(zip) {
  try {
    const r = await fetch(
      'https://www.hudhomestore.gov/HudHomes/HudHomes.aspx/getHudListings?stateCode=CA&zipCode=' + zip,
      { headers: { 'Content-Type': 'application/json', 'User-Agent': 'LMI-Tool/1.0' } }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.d || d || []).map(p => ({
      address: p.STRT_ADDR || p.address, city: p.CITY_NAME || p.city,
      zip: p.ZIP_CODE || p.zip, price: p.LIST_PRICE || p.listPrice,
      beds: p.BDRM_CNT || p.beds, baths: p.BATH_CNT || p.baths,
      sqft: p.SQFT_NUM || p.sqft, listingType: 'hud_home',
      listDate: p.LIST_DATE, caseNumber: p.CASE_NUM,
      source: 'hud', confirmed: true,
    }));
  } catch (e) { return []; }
}

// ─── Data source: Fannie Mae HomePath ────────────────────────
async function fetchHomePathListings(zip) {
  try {
    const r = await fetch(
      'https://www.homepath.com/bin/propertySearch.json?zipCode=' + zip + '&stateCode=CA&listingStatus=active',
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.properties || []).map(p => ({
      address: p.streetAddress, city: p.city, zip: p.zipCode,
      price: p.listPrice, beds: p.bedrooms, baths: p.bathrooms,
      sqft: p.squareFeet, listingType: 'fannie_mae_reo',
      source: 'homepath', confirmed: true,
    }));
  } catch (e) { return []; }
}

// ─── Data source: Freddie Mac HomeSteps ──────────────────────
async function fetchHomeStepsListings(zip) {
  try {
    const r = await fetch(
      'https://www.homesteps.com/api/properties?zipCode=' + zip + '&state=CA',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).map(p => ({
      address: p.address, price: p.listPrice,
      beds: p.beds, baths: p.baths,
      listingType: 'freddie_mac_reo', source: 'homesteps', confirmed: true,
    }));
  } catch (e) { return []; }
}

// ─── Data source: CFPB HMDA ─────────────────────────────────
async function fetchHmdaData(tractId) {
  try {
    const currentYear = new Date().getFullYear();
    const yearsToTry = [currentYear - 1, currentYear - 2, currentYear - 3];
    let r;
    for (const year of yearsToTry) {
      r = await fetch(
        'https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations?' +
        'census_tracts=' + encodeURIComponent(tractId) +
        '&years=' + year + '&actions_taken=1,2,3&loan_purposes=1',
        { headers: { 'User-Agent': 'LMI-Tool/1.0', Accept: 'application/json' } }
      );
      if (r.ok) break;
    }
    if (!r || !r.ok) return {};
    const d = await r.json();
    const agg = d.aggregations || [];
    const total = agg.reduce((s, a) => s + (a.count || 0), 0);
    const originated = agg
      .filter(a => a.action_taken === 1 || a.action_taken_name === 'Loan originated')
      .reduce((s, a) => s + (a.count || 0), 0);

    const approvalRate = total > 0 ? (originated / total) * 100 : 50;
    const minorityPct = parseFloat(d.minority_population_pct || 0);
    const lenderCount = d.lender_count || 5;

    let craScore = 0;
    if (approvalRate < 50) craScore += 30;
    if (approvalRate < 30) craScore += 20;
    if (minorityPct > 50) craScore += 25;
    if (minorityPct > 75) craScore += 15;
    if (lenderCount < 5) craScore += 10;

    return {
      tractId, year: yearsToTry[0], totalApplications: total, originated,
      approvalRate: Math.round(approvalRate),
      medianIncome: d.median_family_income || null,
      minorityPct: minorityPct || null, lenders: lenderCount,
      avgLoanAmount: d.avg_loan_amount || 0,
      craOpportunityScore: Math.min(craScore, 100),
    };
  } catch (e) { return {}; }
}

// ─── Data source: Craigslist RSS ─────────────────────────────
const CL_REGIONS = {
  '93': 'fresno', '94': 'sacramento', '90': 'losangeles',
  '91': 'losangeles', '92': 'sandiego', '95': 'sfbay', '96': 'redding',
};

async function fetchCraigslistListings(zip) {
  try {
    const region = CL_REGIONS[zip.substring(0, 2)] || 'sfbay';
    const r = await fetch(
      'https://' + region + '.craigslist.org/search/rss/rea?postal=' + zip +
      '&search_distance=5&housing_type=1&sale_date=all+dates',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const item = m[1];
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1]
        || (item.match(/<title>(.*?)<\/title>/) || [])[1];
      const link = (item.match(/<link>(.*?)<\/link>/) || [])[1];
      const price = (title?.match(/\$[\d,]+/) || [])[0];
      const date = (item.match(/<dc:date>(.*?)<\/dc:date>/) || [])[1]
        || (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
      if (title) {
        items.push({
          address: title.replace(/\$[\d,]+\s*/, '').trim(), title, link,
          price: price ? parseInt(price.replace(/[$,]/g, '')) : null,
          date, source: 'craigslist', confirmed: true, listingType: 'for_sale_by_owner',
        });
      }
    }
    return items;
  } catch (e) { return []; }
}

// ─── Address normalization ───────────────────────────────────
function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.toLowerCase().replace(/\s+/g, ' ').replace(/[.,#]/g, '').trim();
}

// ─── Scoring engine ──────────────────────────────────────────
function scoreAndCorrelate(properties, govListings, hmda, craigslist) {
  const govMap = new Map();
  govListings.forEach(l => { const k = normalizeAddress(l.address); if (k) govMap.set(k, l); });
  const clMap = new Map();
  craigslist.forEach(c => { const k = normalizeAddress(c.address); if (k) clMap.set(k, c); });

  // Add gov/CL listings not already in assessor data
  const existing = new Set(properties.map(p => normalizeAddress(p.address)));
  govListings.forEach(l => {
    const k = normalizeAddress(l.address);
    if (k && !existing.has(k)) {
      properties.push({ address: l.address, city: l.city, price: l.price, beds: l.beds, baths: l.baths, sqft: l.sqft, source: l.source });
      existing.add(k);
    }
  });
  craigslist.forEach(c => {
    const k = normalizeAddress(c.address);
    if (k && !existing.has(k)) {
      properties.push({ address: c.address, price: c.price, source: c.source, link: c.link });
      existing.add(k);
    }
  });

  const craScore = hmda.craOpportunityScore || 0;

  return properties.map(prop => {
    const addrKey = normalizeAddress(prop.address);
    const govListing = govMap.get(addrKey);
    const clListing = clMap.get(addrKey);

    let score = 0;
    const signals = [];

    if (govListing) { score += 100; signals.push({ type: 'confirmed_listing', source: govListing.source }); }
    if (clListing) { score += 80; signals.push({ type: 'craigslist_listing', source: 'craigslist' }); }

    if (prop.lastSaleDate) {
      const saleTime = typeof prop.lastSaleDate === 'number' ? prop.lastSaleDate : new Date(prop.lastSaleDate).getTime();
      const yrs = (Date.now() - saleTime) / (365 * 24 * 3600000);
      if (yrs > 10) { score += 10; signals.push({ type: 'long_term_owner' }); }
    }
    if (prop.assessedValue && prop.lastSalePrice) {
      const apprec = (prop.assessedValue - prop.lastSalePrice) / prop.lastSalePrice;
      if (apprec > 0.3) { score += 15; signals.push({ type: 'significant_appreciation' }); }
    }
    score += Math.round(craScore * 0.1);

    return {
      ...prop, score: Math.min(score, 100), signals,
      govListing: govListing || null, craigslistListing: clListing || null,
      isConfirmed: !!govListing || !!clListing,
      isLikelyToList: score >= 40 && !govListing && !clListing,
      zillowData: null, listingAgent: null, agentPhone: null, agentEmail: null,
    };
  });
}

// ─── Zillow enrichment via ZLLW Working API ──────────────────
async function enrichWithZillow(properties, env) {
  if (!env.RAPIDAPI_KEY) return properties;
  const enriched = [];

  for (const prop of properties) {
    if (!prop.address) { enriched.push(prop); continue; }
    try {
      // Check KV cache for this address
      const addrKey = 'zillow_' + normalizeAddress(prop.address);
      if (env.KV_NAMESPACE) {
        const cached = await env.KV_NAMESPACE.get(addrKey, 'json');
        if (cached) { enriched.push(mergeZillow(prop, cached)); continue; }
      }

      // Rate limit: 1 per 2 seconds
      await new Promise(r => setTimeout(r, 2000));

      const r = await fetch(
        'https://zllw-working-api.p.rapidapi.com/property?' +
        'address=' + encodeURIComponent(prop.address + ' CA'),
        {
          headers: {
            'X-RapidAPI-Key': env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'zllw-working-api.p.rapidapi.com',
          },
        }
      );
      if (!r.ok) { enriched.push(prop); continue; }

      const z = await r.json();
      const zData = {
        zestimate: z.zestimate, listPrice: z.price, listStatus: z.homeStatus,
        beds: z.bedrooms, baths: z.bathrooms, sqft: z.livingArea,
        yearBuilt: z.yearBuilt, daysOnMarket: z.daysOnZillow,
        listingAgent: z.attributionInfo?.agentName,
        agentEmail: z.attributionInfo?.agentEmail,
        agentPhone: z.attributionInfo?.agentPhoneNumber,
        brokerage: z.attributionInfo?.brokerName,
        photos: (z.photos || z.responsivePhotos || []).slice(0, 3)
          .map(p => p.url || p.mixedSources?.jpeg?.[0]?.url || '').filter(Boolean),
        zillowUrl: z.hdpUrl ? 'https://zillow.com' + z.hdpUrl : null,
        isForSale: z.homeStatus === 'FOR_SALE',
      };

      // Cache 24 hours
      if (env.KV_NAMESPACE) {
        try { await env.KV_NAMESPACE.put(addrKey, JSON.stringify(zData), { expirationTtl: 86400 }); }
        catch (e) { /* non-critical */ }
      }
      enriched.push(mergeZillow(prop, zData));
    } catch (e) { enriched.push(prop); }
  }
  return enriched;
}

function mergeZillow(prop, z) {
  return {
    ...prop, zillowData: z,
    isConfirmed: prop.isConfirmed || z.isForSale,
    beds: prop.beds || z.beds, baths: prop.baths || z.baths,
    sqft: prop.sqft || z.sqft, yearBuilt: prop.yearBuilt || z.yearBuilt,
    listingAgent: z.listingAgent || null, agentPhone: z.agentPhone || null,
    agentEmail: z.agentEmail || null, brokerage: z.brokerage || null,
  };
}

// ─── Summary builder ─────────────────────────────────────────
function buildSummary(properties, hmda) {
  const confirmed = properties.filter(p => p.isConfirmed);
  const likelyToList = properties.filter(p => p.isLikelyToList);
  const govListings = properties.filter(p => p.govListing !== null);
  const withAgents = properties.filter(p => p.listingAgent);
  const prices = confirmed
    .map(p => p.zillowData?.listPrice || p.govListing?.price || p.price || 0)
    .filter(p => p > 0);

  return {
    totalProperties: properties.length,
    confirmedListings: confirmed.length,
    likelyToListCount: likelyToList.length,
    governmentOwned: govListings.length,
    withListingAgent: withAgents.length,
    avgListPrice: prices.length > 0 ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length) : null,
    craOpportunityScore: hmda.craOpportunityScore || 0,
    approvalRate: hmda.approvalRate || 0,
    totalHmdaLoans: hmda.totalApplications || 0,
    activeLenders: hmda.lenders || 0,
  };
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

async function handleSmsIncoming(request, env) {
  const formData = await request.formData();
  // Return TwiML response (empty — we log via Firestore on the client side)
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
