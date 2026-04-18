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
    'Access-Control-Allow-Headers': 'Content-Type',
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

    // Everything else → static assets
    return env.ASSETS.fetch(request);
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
async function handleLmiLookup(zip, request) {
  if (!/^\d{5}$/.test(zip)) {
    return jsonResponse({ error: 'Invalid zip code' }, request, 400);
  }

  // FFIEC data lags ~1-2 years; try last year first, then fall back
  const currentYear = new Date().getFullYear();
  const yearsToTry = [currentYear - 1, currentYear - 2, currentYear - 3];

  try {
    let res;
    for (const year of yearsToTry) {
      const ffiecUrl =
        'https://ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv' +
        '?years=' + year +
        '&msa_md=&state=&county=&census_tract=' +
        '&fields=census_tract,tract_population,' +
        'tract_minority_population_percent,' +
        'ffiec_msa_md_median_family_income,' +
        'tract_to_msa_income_percentage' +
        '&zip_codes=' + zip;

      res = await fetch(ffiecUrl, {
        headers: { 'User-Agent': 'LMI-Tool/1.0' },
      });

      if (res.ok) break;
    }

    if (!res || !res.ok) {
      // Fallback: try the aggregations endpoint
      const aggUrl =
        'https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations' +
        '?years=' + yearsToTry[0] +
        '&actions_taken=1,2,3' +
        '&loan_purposes=1' +
        '&zip_codes=' + zip;

      const aggRes = await fetch(aggUrl, {
        headers: { 'User-Agent': 'LMI-Tool/1.0', Accept: 'application/json' },
      });

      if (!aggRes.ok) {
        return jsonResponse({ error: 'FFIEC API error' }, request, 502);
      }

      const aggData = await aggRes.json();
      return jsonResponse(aggData.aggregations || [], request);
    }

    // Parse CSV response
    const csv = await res.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2) {
      return jsonResponse([], request);
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const results = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx]; });

      const incomeRatio = parseFloat(row.tract_to_msa_income_percentage) || null;

      results.push({
        tract_id: row.census_tract || '',
        census_tract: row.census_tract || '',
        tract_population: parseInt(row.tract_population) || 0,
        minority_pct: parseFloat(row.tract_minority_population_percent) || 0,
        median_family_income: parseInt(row.ffiec_msa_md_median_family_income) || 0,
        income_ratio: incomeRatio,
        lmi_status: incomeRatio !== null && incomeRatio <= 80,
        lmi_category: incomeRatio === null
          ? 'Unknown'
          : incomeRatio <= 50
            ? 'Low'
            : incomeRatio <= 80
              ? 'Moderate'
              : incomeRatio <= 120
                ? 'Middle'
                : 'Upper',
      });
    }

    // Deduplicate by tract ID
    const seen = new Set();
    const unique = results.filter(r => {
      if (seen.has(r.tract_id)) return false;
      seen.add(r.tract_id);
      return true;
    });

    return jsonResponse(unique, request);
  } catch (e) {
    return jsonResponse({ error: 'Census API unreachable' }, request, 502);
  }
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
// Data source: HUD Homes (Free API)
// ─────────────────────────────────────────
async function fetchHudListings(zip, env) {
  try {
    const response = await fetch(
      'https://www.hudhomestore.gov/HudHomes/HudHomes.aspx/' +
      'getHudListings?stateCode=CA&zipCode=' + zip,
      { headers: { 'Content-Type': 'application/json', 'User-Agent': 'LMI-Tool/1.0' } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.d || data || []).map(p => ({
      address: p.STRT_ADDR || p.address,
      city: p.CITY_NAME || p.city,
      zip: p.ZIP_CODE || p.zip,
      price: p.LIST_PRICE || p.listPrice,
      beds: p.BDRM_CNT || p.beds,
      baths: p.BATH_CNT || p.baths,
      sqft: p.SQFT_NUM || p.sqft,
      listingType: 'hud_home',
      listDate: p.LIST_DATE || p.listDate,
      caseNumber: p.CASE_NUM,
      source: 'hud',
      confirmed: true,
    }));
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────
// Data source: Fannie Mae HomePath
// ─────────────────────────────────────────
async function fetchHomePathListings(zip, env) {
  try {
    const response = await fetch(
      'https://www.homepath.com/bin/propertySearch.json' +
      '?zipCode=' + zip + '&stateCode=CA&listingStatus=active',
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.properties || []).map(p => ({
      address: p.streetAddress,
      city: p.city,
      zip: p.zipCode,
      price: p.listPrice,
      beds: p.bedrooms,
      baths: p.bathrooms,
      sqft: p.squareFeet,
      listingType: 'fannie_mae_reo',
      source: 'homepath',
      confirmed: true,
    }));
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────
// Data source: Freddie Mac HomeSteps
// ─────────────────────────────────────────
async function fetchHomeStepsListings(zip, env) {
  try {
    const response = await fetch(
      'https://www.homesteps.com/api/properties?' +
      'zipCode=' + zip + '&state=CA',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.results || []).map(p => ({
      address: p.address,
      price: p.listPrice,
      beds: p.beds,
      baths: p.baths,
      listingType: 'freddie_mac_reo',
      source: 'homesteps',
      confirmed: true,
    }));
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────
// Data source: CFPB HMDA Lending Data
// ─────────────────────────────────────────
async function fetchHmdaData(tractId, env) {
  try {
    const year = new Date().getFullYear() - 1;
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

async function fetchCraigslistListings(zip, state) {
  try {
    const prefix = zip.substring(0, 2);
    const region = CL_REGIONS[prefix] || 'sfbay';

    const rssUrl =
      'https://' + region + '.craigslist.org/search/rss/rea' +
      '?postal=' + zip + '&search_distance=5&housing_type=1' +
      '&sale_date=all+dates';

    const response = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) return [];

    const xml = await response.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1]
        || (item.match(/<title>(.*?)<\/title>/) || [])[1];
      const link = (item.match(/<link>(.*?)<\/link>/) || [])[1];
      const price = (title?.match(/\$[\d,]+/) || [])[0];
      const date = (item.match(/<dc:date>(.*?)<\/dc:date>/) || [])[1]
        || (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];

      if (title) {
        items.push({
          address: title.replace(/\$[\d,]+\s*/, '').trim(),
          title,
          link,
          price: price ? parseInt(price.replace(/[$,]/g, '')) : null,
          date,
          source: 'craigslist',
          confirmed: true,
          listingType: 'for_sale_by_owner',
        });
      }
    }
    return items;
  } catch (e) {
    return [];
  }
}

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
