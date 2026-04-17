// ═══════════════════════════════════════════════════════════════
// LMI Property Intelligence — Cloudflare Worker orchestrator
// ═══════════════════════════════════════════════════════════════
//
// This file is a REFERENCE SOURCE for the worker deployed at
// https://lmi-proxy.aaronsimonson.workers.dev. The production worker
// lives in its own Cloudflare project — paste this module into that
// project and deploy via `wrangler deploy`.
//
// Required environment/bindings (Cloudflare dashboard → Worker Settings):
//   RAPIDAPI_KEY     — Zillow-Com1 RapidAPI key (Zillow lookup)
//   HUD_API_KEY      — huduser.gov API key (optional, free)
//   KV_NAMESPACE     — KV binding named LMI_PROPERTY_CACHE
//
// Route: GET /property-intelligence?tractId={id}&zip={zip}&county={name}
//
// NOTE ON DATA SOURCES: several endpoints below (HUDHomestore,
// HomePath, HomeSteps, CA_Deed_Transfers FeatureServer) are documented
// informally on the open web but are not guaranteed contracts. They
// are called inside Promise.allSettled so individual failures degrade
// gracefully rather than breaking the response. When the production
// worker goes live you'll likely need to adjust a few URLs.

export async function handlePropertyIntelligence(request, env) {
  const url = new URL(request.url);
  const tractId = url.searchParams.get("tractId");
  const zip     = url.searchParams.get("zip");
  const county  = url.searchParams.get("county") || "";
  const state   = url.searchParams.get("state")  || "CA";

  if (!tractId || !zip) {
    return jsonResponse({ error: "tractId and zip are required" }, 400);
  }

  // ── 1. Cache check (6h TTL) ─────────────────────────────────
  const cacheKey = `prop_intel_${tractId}_${zip}`;
  if (env.KV_NAMESPACE) {
    const cached = await env.KV_NAMESPACE.get(cacheKey, "json");
    if (cached) return jsonResponse({ ...cached, fromCache: true });
  }

  // ── 2. Parallel fetch of all data sources ───────────────────
  const [
    assessorData, hudListings, homePathListings, homeStepsListings,
    hmdaData, deedRecordings, craigslistListings,
  ] = await Promise.allSettled([
    fetchAssessorData(tractId, county, state, env),
    fetchHudListings(zip, env),
    fetchHomePathListings(zip, env),
    fetchHomeStepsListings(zip, env),
    fetchHmdaData(tractId, env),
    fetchDeedRecordings(tractId, county, env),
    fetchCraigslistListings(zip, state),
  ]);

  const properties  = assessorData.status       === "fulfilled" ? assessorData.value       : [];
  const govListings = [
    ...(hudListings.status      === "fulfilled" ? hudListings.value      : []),
    ...(homePathListings.status === "fulfilled" ? homePathListings.value : []),
    ...(homeStepsListings.status=== "fulfilled" ? homeStepsListings.value: []),
  ];
  const hmda  = hmdaData.status        === "fulfilled" ? hmdaData.value        : {};
  const deeds = deedRecordings.status  === "fulfilled" ? deedRecordings.value  : [];
  const cl    = craigslistListings.status === "fulfilled" ? craigslistListings.value : [];

  // ── 3. Score + correlate ────────────────────────────────────
  const scored = await scoreAndCorrelate(properties, govListings, deeds, hmda, cl, env);

  // ── 4. Zillow enrichment (top 20 by score) ──────────────────
  const topProperties = scored.sort((a, b) => b.score - a.score).slice(0, 20);
  const enriched = await enrichWithZillow(topProperties, env);

  // ── 5. Union enriched with unscored (beyond top 20) ─────────
  const rest = scored.slice(20);
  const allProperties = [...enriched, ...rest];

  // ── 6. Include gov listings that didn't match any assessor row
  //     (standalone listings) so MLO sees them too.
  const knownKeys = new Set(allProperties.map(p => normalizeAddress(p.address)));
  for (const g of govListings) {
    const k = normalizeAddress(g.address);
    if (k && !knownKeys.has(k)) {
      allProperties.push({
        address: g.address, city: g.city, zip: g.zip,
        assessedValue: null, owner: null, source: g.source,
        score: 95, signals: [{ type: "confirmed_listing", source: g.source }],
        govListing: g, deedInfo: null,
        isConfirmed: true, isLikelyToList: false,
        zillowData: null, realtorData: null,
      });
    }
  }

  const result = {
    tractId, zip, county,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(allProperties, hmda),
    properties: allProperties,
    hmdaInsights: hmda,
    craigslist: cl.slice(0, 20),
    fromCache: false,
  };

  // ── 7. Cache 6h ─────────────────────────────────────────────
  if (env.KV_NAMESPACE) {
    await env.KV_NAMESPACE.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
  }

  return jsonResponse(result);
}

// ═══════════════════════════════════════════════════════════════
// Data source: California County Assessor
// ═══════════════════════════════════════════════════════════════
async function fetchAssessorData(tractId, county, state, env) {
  const countyFips = tractId.substring(0, 5);

  // LA County has a first-class JSON API — use it when applicable.
  if (countyFips === "06037") {
    try { return await fetchLACountyAssessor(tractId, env); } catch { /* fall through */ }
  }

  // Statewide ArcGIS FeatureServer (CA Open Data portal).
  // The exact service URL changes periodically — keep in config so
  // operators can swap without a redeploy.
  const PARCEL_SERVICE = env.CA_PARCEL_SERVICE_URL ||
    "https://services3.arcgis.com/fdvHcZXgKW4I5hLc/arcgis/rest/services/California_Parcels/FeatureServer/0/query";

  try {
    const q = new URLSearchParams({
      where: `CENSUS_TRACT='${tractId}'`,
      outFields: "APN,SITUS_ADDR,OWNER_NAME,ASSD_VALUE,LAST_SALE_DATE,LAST_SALE_PRICE,YEAR_BUILT,SQ_FT",
      f: "json",
      resultRecordCount: "200",
    });
    const response = await fetch(`${PARCEL_SERVICE}?${q.toString()}`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.features || []).map(f => ({
      apn:           f.attributes?.APN,
      address:       f.attributes?.SITUS_ADDR,
      owner:         f.attributes?.OWNER_NAME,
      assessedValue: f.attributes?.ASSD_VALUE,
      lastSaleDate:  f.attributes?.LAST_SALE_DATE,
      lastSalePrice: f.attributes?.LAST_SALE_PRICE,
      yearBuilt:     f.attributes?.YEAR_BUILT,
      sqft:          f.attributes?.SQ_FT,
      source:        "ca_assessor",
    }));
  } catch { return []; }
}

async function fetchLACountyAssessor(tractId, env) {
  const response = await fetch(
    `https://portal.assessor.lacounty.gov/api/search?query=${encodeURIComponent(tractId)}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!response.ok) return [];
  const data = await response.json();
  const results = data.results || data.items || [];
  return results.map(r => ({
    apn:           r.apn || r.APN,
    address:       r.siteAddress || r.address,
    owner:         r.ownerName || r.owner,
    assessedValue: r.assessedValue || r.totalValue,
    lastSaleDate:  r.lastSaleDate,
    lastSalePrice: r.lastSalePrice,
    yearBuilt:     r.yearBuilt,
    sqft:          r.sqft || r.livingArea,
    source:        "la_county_assessor",
  }));
}

// ═══════════════════════════════════════════════════════════════
// Data source: HUD Homes (FHA-foreclosed / REO)
// ═══════════════════════════════════════════════════════════════
async function fetchHudListings(zip, env) {
  try {
    const response = await fetch(
      `https://www.hudhomestore.gov/HudHomes/HudHomes.aspx/getHudListings?stateCode=CA&zipCode=${zip}`,
      { headers: { "Content-Type": "application/json" } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    const rows = data.d || data.listings || [];
    return rows.map(p => ({
      address:     p.STRT_ADDR || p.address,
      city:        p.CITY_NAME || p.city,
      zip:         p.ZIP_CODE  || p.zip,
      price:       p.LIST_PRICE || p.price,
      beds:        p.BDRM_CNT  || p.bedrooms,
      baths:       p.BATH_CNT  || p.bathrooms,
      sqft:        p.SQFT_NUM  || p.sqft,
      listingType: "hud_home",
      listDate:    p.LIST_DATE || p.listDate,
      caseNumber:  p.CASE_NUM  || p.caseNumber,
      source:      "hud",
      confirmed:   true,
    }));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// Data source: Fannie Mae HomePath
// ═══════════════════════════════════════════════════════════════
async function fetchHomePathListings(zip, env) {
  try {
    const response = await fetch(
      `https://www.homepath.com/bin/propertySearch.json?zipCode=${zip}&stateCode=CA&listingStatus=active`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.properties || []).map(p => ({
      address:     p.streetAddress,
      city:        p.city,
      zip:         p.zipCode,
      price:       p.listPrice,
      beds:        p.bedrooms,
      baths:       p.bathrooms,
      sqft:        p.squareFeet,
      listingType: "fannie_mae_reo",
      source:      "homepath",
      confirmed:   true,
    }));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// Data source: Freddie Mac HomeSteps
// ═══════════════════════════════════════════════════════════════
async function fetchHomeStepsListings(zip, env) {
  try {
    const response = await fetch(
      `https://www.homesteps.com/api/properties?zipCode=${zip}&state=CA`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.results || []).map(p => ({
      address:     p.address,
      price:       p.listPrice,
      beds:        p.beds,
      baths:       p.baths,
      listingType: "freddie_mac_reo",
      source:      "homesteps",
      confirmed:   true,
    }));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// Data source: CFPB HMDA Data Browser
// ═══════════════════════════════════════════════════════════════
async function fetchHmdaData(tractId, env) {
  try {
    const year = new Date().getFullYear() - 1;
    const q = new URLSearchParams({
      census_tract: tractId,
      years: String(year),
      actions_taken: "1,2,3",
      loan_purposes: "1",
    });
    const response = await fetch(
      `https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations?${q.toString()}`
    );
    if (!response.ok) return {};
    const data = await response.json();
    const loans = data.data || data.aggregations || [];
    const originated = loans.filter(l => String(l.action_taken) === "1");
    const total = loans.length;
    const lenderCount = new Set(loans.map(l => l.lei).filter(Boolean)).size;
    const avgLoanAmount = originated.length > 0
      ? Math.round(originated.reduce((s, l) => s + Number(l.loan_amount || 0), 0) / originated.length)
      : 0;
    return {
      tractId,
      year,
      totalApplications:   total,
      originated:          originated.length,
      approvalRate:        total > 0 ? Math.round((originated.length / total) * 100) : 0,
      medianIncome:        loans[0]?.ffiec_msa_md_median_family_income,
      minorityPct:         loans[0]?.tract_minority_population_percent,
      lenders:             lenderCount,
      avgLoanAmount,
      craOpportunityScore: calculateCraOpportunity(loans),
    };
  } catch { return {}; }
}

function calculateCraOpportunity(loans) {
  if (!loans?.length) return 0;
  const approvalRate = loans.filter(l => String(l.action_taken) === "1").length / loans.length * 100;
  const minorityPct  = parseFloat(loans[0]?.tract_minority_population_percent || 0);
  const lenderCount  = new Set(loans.map(l => l.lei).filter(Boolean)).size;
  let score = 0;
  if (approvalRate < 50) score += 30;
  if (approvalRate < 30) score += 20;
  if (minorityPct > 50)  score += 25;
  if (minorityPct > 75)  score += 15;
  if (lenderCount < 5)   score += 10;
  return Math.min(score, 100);
}

// ═══════════════════════════════════════════════════════════════
// Data source: Deed Recordings (last 90 days)
// ═══════════════════════════════════════════════════════════════
async function fetchDeedRecordings(tractId, county, env) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
  const DEED_SERVICE = env.CA_DEED_SERVICE_URL ||
    "https://services3.arcgis.com/fdvHcZXgKW4I5hLc/arcgis/rest/services/CA_Deed_Transfers/FeatureServer/0/query";
  try {
    const q = new URLSearchParams({
      where: `CENSUS_TRACT='${tractId}' AND TRANSFER_DATE>='${since}'`,
      outFields: "APN,SITUS_ADDR,BUYER_NAME,SELLER_NAME,SALE_PRICE,TRANSFER_DATE,LOAN_AMOUNT,LENDER_NAME",
      f: "json",
      resultRecordCount: "100",
    });
    const response = await fetch(`${DEED_SERVICE}?${q.toString()}`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.features || []).map(f => ({
      apn:          f.attributes?.APN,
      address:      f.attributes?.SITUS_ADDR,
      buyer:        f.attributes?.BUYER_NAME,
      seller:       f.attributes?.SELLER_NAME,
      salePrice:    f.attributes?.SALE_PRICE,
      transferDate: f.attributes?.TRANSFER_DATE,
      loanAmount:   f.attributes?.LOAN_AMOUNT,
      lender:       f.attributes?.LENDER_NAME,
      source:       "deed_recording",
    }));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// Data source: Craigslist RSS (housing for sale by owner)
// ═══════════════════════════════════════════════════════════════
const CL_REGIONS = {
  "90": "losangeles", "91": "losangeles", "92": "sandiego",
  "93": "fresno",     "94": "sacramento", "95": "sfbay",
};

async function fetchCraigslistListings(zip, state) {
  const prefix = (zip || "").substring(0, 2);
  const region = CL_REGIONS[prefix] || "sfbay";
  try {
    const rssUrl = `https://${region}.craigslist.org/search/rss/rea?postal=${zip}&search_distance=5&housing_type=1&sale_date=all%2Bdates`;
    const response = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) return [];
    const xml = await response.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item  = match[1];
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1];
      const link  = (item.match(/<link>(.*?)<\/link>/) || [])[1];
      const price = (title?.match(/\$[\d,]+/) || [])[0];
      const date  = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
      if (title) {
        items.push({
          title, link,
          price:       price ? parseInt(price.replace(/[$,]/g, ""), 10) : null,
          date,
          source:      "craigslist",
          confirmed:   true,
          listingType: "for_sale_by_owner",
        });
      }
    }
    return items;
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
// Scoring + correlation engine
// ═══════════════════════════════════════════════════════════════
async function scoreAndCorrelate(properties, govListings, deeds, hmda, craigslist, env) {
  const govMap = new Map();
  govListings.forEach(l => { if (l.address) govMap.set(normalizeAddress(l.address), l); });

  const deedMap = new Map();
  deeds.forEach(d => { if (d.address) deedMap.set(normalizeAddress(d.address), d); });

  return properties.map(prop => {
    const addrKey = normalizeAddress(prop.address);
    const govListing = govMap.get(addrKey);
    const deed = deedMap.get(addrKey);

    let score = 0;
    const signals = [];

    if (govListing) {
      score += 100;
      signals.push({ type: "confirmed_listing", source: govListing.source });
    }

    if (deed) {
      const daysSince = Math.floor((Date.now() - new Date(deed.transferDate)) / 86400000);
      if (daysSince < 30) { score += 40; signals.push({ type: "very_recent_transfer" }); }
      if (daysSince < 90) { score += 20; signals.push({ type: "recent_transfer" }); }
      if (deed.buyer && /LLC|INC|CORP|TRUST|INVEST/i.test(deed.buyer)) {
        score += 15;
        signals.push({ type: "investor_buyer" });
      }
    }

    if (prop.lastSaleDate) {
      const yearsSinceSale = (Date.now() - new Date(prop.lastSaleDate)) / (365 * 86400000);
      if (yearsSinceSale > 10) {
        score += 10;
        signals.push({ type: "long_term_owner" });
      }
    }

    if (prop.assessedValue && prop.lastSalePrice) {
      const appreciation = (prop.assessedValue - prop.lastSalePrice) / prop.lastSalePrice;
      if (appreciation > 0.3) {
        score += 15;
        signals.push({ type: "significant_appreciation" });
      }
    }

    const craScore = hmda.craOpportunityScore || 0;
    score += Math.round(craScore * 0.1);

    return {
      ...prop,
      score: Math.min(score, 100),
      signals,
      govListing:  govListing || null,
      deedInfo:    deed || null,
      isConfirmed: !!govListing,
      isLikelyToList: score >= 40 && !govListing,
      zillowData:  null,
      realtorData: null,
    };
  });
}

function normalizeAddress(addr) {
  if (!addr) return "";
  return String(addr).toLowerCase().replace(/\s+/g, " ").replace(/[.,#]/g, "").trim();
}

// ═══════════════════════════════════════════════════════════════
// Zillow enrichment (address-specific; rate-limited)
// ═══════════════════════════════════════════════════════════════
async function enrichWithZillow(properties, env) {
  if (!env.RAPIDAPI_KEY) return properties;
  const enriched = [];
  for (const prop of properties) {
    if (!prop.address) { enriched.push(prop); continue; }
    try {
      const addrKey = `zillow_${normalizeAddress(prop.address)}`;
      if (env.KV_NAMESPACE) {
        const cached = await env.KV_NAMESPACE.get(addrKey, "json");
        if (cached) { enriched.push(mergeZillow(prop, cached)); continue; }
      }

      await sleep(2000); // 1 request / 2s

      const response = await fetch(
        `https://zillow-com1.p.rapidapi.com/property?address=${encodeURIComponent(prop.address + " CA")}`,
        { headers: {
            "X-RapidAPI-Key":  env.RAPIDAPI_KEY,
            "X-RapidAPI-Host": "zillow-com1.p.rapidapi.com",
        }}
      );
      if (!response.ok) { enriched.push(prop); continue; }

      const zData = await response.json();
      const zillowData = {
        zestimate:    zData.zestimate,
        listPrice:    zData.price,
        listStatus:   zData.homeStatus,
        beds:         zData.bedrooms,
        baths:        zData.bathrooms,
        sqft:         zData.livingArea,
        yearBuilt:    zData.yearBuilt,
        daysOnMarket: zData.daysOnZillow,
        listingAgent: zData.attributionInfo?.agentName,
        agentEmail:   zData.attributionInfo?.agentEmail,
        agentPhone:   zData.attributionInfo?.agentPhoneNumber,
        brokerage:    zData.attributionInfo?.brokerName,
        photos:       (zData.photos || []).slice(0, 3).map(p => p.url || p),
        zillowUrl:    zData.hdpUrl ? `https://zillow.com${zData.hdpUrl}` : null,
        isForSale:    zData.homeStatus === "FOR_SALE",
      };

      if (env.KV_NAMESPACE) {
        await env.KV_NAMESPACE.put(addrKey, JSON.stringify(zillowData), { expirationTtl: 86400 });
      }

      enriched.push(mergeZillow(prop, zillowData));
    } catch (e) {
      enriched.push(prop);
    }
  }
  return enriched;
}

function mergeZillow(prop, zillowData) {
  const isConfirmed = prop.isConfirmed || zillowData.isForSale;
  return {
    ...prop,
    zillowData,
    isConfirmed,
    listingAgent: zillowData.listingAgent || prop.listingAgent || null,
    agentPhone:   zillowData.agentPhone   || prop.agentPhone   || null,
    agentEmail:   zillowData.agentEmail   || prop.agentEmail   || null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Summary builder
// ═══════════════════════════════════════════════════════════════
function buildSummary(properties, hmda) {
  const confirmed    = properties.filter(p => p.isConfirmed);
  const likelyToList = properties.filter(p => p.isLikelyToList);
  const withAgents   = properties.filter(p => p.listingAgent);
  const govListings  = properties.filter(p => p.govListing);

  const prices = confirmed
    .map(p => p.zillowData?.listPrice || p.govListing?.price || 0)
    .filter(n => Number.isFinite(n) && n > 0);

  return {
    totalProperties:    properties.length,
    confirmedListings:  confirmed.length,
    likelyToListCount:  likelyToList.length,
    governmentOwned:    govListings.length,
    withListingAgent:   withAgents.length,
    avgListPrice:       prices.length > 0
                          ? Math.round(prices.reduce((s, n) => s + n, 0) / prices.length)
                          : null,
    craOpportunityScore: hmda.craOpportunityScore || 0,
    approvalRate:        hmda.approvalRate        || 0,
    totalHmdaLoans:      hmda.totalApplications   || 0,
    activeLenders:       hmda.lenders             || 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// Worker entry — paste this into the production worker. It
// assumes existing routes handle ZIP search + SMS; this module
// adds /property-intelligence only.
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/property-intelligence") {
      return handlePropertyIntelligence(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};
