/**
 * Canonical Attribution Resolver (plain JavaScript, Variable Template–style)
 *
 * Objective:
 * - Extract attribution signals (click IDs and UTMs) from a URL
 * - Normalize inputs and resolve attribution precedence deterministically
 * - Produce a canonical attribution object and a sanitized ("clean") URL
 *
 * Notes:
 * - Pure functions only (no DOM access, no storage) to remain compatible with
 *   GTM template and server-side execution principles.
 */

const DEFAULT_OPTIONS = Object.freeze({
  // setting which parameters to remove.
  removeParams: [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "utm_id",
    "gclid",
    "gbraid",
    "wbraid",
    "fbclid",
    "msclkid",
    "ttclid",
    "li_fat_id"
  ],

  keepClickIdsInCleanUrl: false,
  consent: {
    adStorageGranted: true,
    analyticsStorageGranted: true
  },

  // Precedence rule(strongest to weaker)
  precedence: ["gclid", "gbraid_wbraid", "utm", "referrer", "direct"],

  // Consider those domains as "self-referral" (ignore referrer)
  selfReferralHosts: []
});

/** Public API */
function resolveAttribution(input, options = {}) {
  const opts = deepMerge(DEFAULT_OPTIONS, options);

  const normalizedInput = normalizeInput(input);
  const pageUrl = safeParseUrl(normalizedInput.page_location);
  const refUrl = safeParseUrl(normalizedInput.page_referrer);

  const queryParams = pageUrl ? readParams(pageUrl.searchParams) : {};
  const clickIds = extractClickIds(queryParams);
  const utms = extractUtms(queryParams);

  // Normalize values (trim, remove null-ish, etc.)
  const normalizedClickIds = normalizeObjectValues(clickIds);
  const normalizedUtms = normalizeObjectValues(utms);

  // If ads consent are revoked, optional to remove click IDs
  const consentedClickIds = applyConsentToClickIds(normalizedClickIds, opts.consent);

  const resolved = resolveByPrecedence({
    page_location: normalizedInput.page_location,
    page_referrer: normalizedInput.page_referrer,
    page_host: pageUrl ? pageUrl.hostname : null,
    referrer_host: refUrl ? refUrl.hostname : null,
    click_ids: consentedClickIds,
    utm: normalizedUtms,
    options: opts
  });

  const cleanedUrl = pageUrl
    ? buildCleanUrl(pageUrl, {
        removeParams: opts.removeParams,
        keepClickIdsInCleanUrl: opts.keepClickIdsInCleanUrl
      })
    : null;

  return Object.freeze({
    version: "1.0.0",
    input: Object.freeze({
      page_location: normalizedInput.page_location,
      page_referrer: normalizedInput.page_referrer
    }),
    signals: Object.freeze({
      click_ids: consentedClickIds,
      utm: normalizedUtms
    }),
    attribution: Object.freeze(resolved),
    cleaned_url: cleanedUrl
  });
}

/* ----------------------------- Core logic ----------------------------- */

function resolveByPrecedence(ctx) {
  const {
    click_ids,
    utm,
    page_referrer,
    referrer_host,
    options
  } = ctx;

  const hasGclid = isNonEmpty(click_ids.gclid);
  const hasBraid = isNonEmpty(click_ids.gbraid) || isNonEmpty(click_ids.wbraid);
  const hasUtm = hasAnyUtm(utm);

  // 1) gclid
  if (hasGclid && options.precedence.includes("gclid")) {
    return {
      channel: "paid",
      source: "google",
      medium: "cpc",
      campaign: utm.utm_campaign || null,
      content: utm.utm_content || null,
      term: utm.utm_term || null,
      click_id: { type: "gclid", value: click_ids.gclid },
      touch_type: "last_touch",
      reason: "gclid_present"
    };
  }

  // 2) gbraid/wbraid
  if (hasBraid && options.precedence.includes("gbraid_wbraid")) {
    const type = isNonEmpty(click_ids.gbraid) ? "gbraid" : "wbraid";
    const value = click_ids[type];
    return {
      channel: "paid",
      source: "google",
      medium: "cpc",
      campaign: utm.utm_campaign || null,
      content: utm.utm_content || null,
      term: utm.utm_term || null,
      click_id: { type, value },
      touch_type: "last_touch",
      reason: "gbraid_or_wbraid_present"
    };
  }

  // 3) UTMs
  if (hasUtm && options.precedence.includes("utm")) {
    const source = utm.utm_source || "unknown";
    const medium = utm.utm_medium || "unknown";
    const channel = classifyChannelFromMedium(medium);

    return {
      channel,
      source,
      medium,
      campaign: utm.utm_campaign || null,
      content: utm.utm_content || null,
      term: utm.utm_term || null,
      click_id: chooseAnyClickId(click_ids),
      touch_type: "last_touch",
      reason: "utm_present"
    };
  }

  // 4) Referrer
  if (options.precedence.includes("referrer")) {
    const ref = normalizeReferrer(page_referrer, options.selfReferralHosts);
    if (ref) {
      return {
        channel: "referral",
        source: ref.host,
        medium: "referral",
        campaign: null,
        content: null,
        term: null,
        click_id: null,
        touch_type: "last_touch",
        reason: "referrer_present"
      };
    }
  }

  // 5) Direct
  return {
    channel: "direct",
    source: "(direct)",
    medium: "(none)",
    campaign: null,
    content: null,
    term: null,
    click_id: null,
    touch_type: "last_touch",
    reason: "no_signals"
  };
}

/* ----------------------------- Extractors ----------------------------- */

function extractClickIds(params) {
  return {
    gclid: params.gclid,
    gbraid: params.gbraid,
    wbraid: params.wbraid,
    fbclid: params.fbclid,
    msclkid: params.msclkid,
    ttclid: params.ttclid,
    li_fat_id: params.li_fat_id
  };
}

function extractUtms(params) {
  return {
    utm_source: params.utm_source,
    utm_medium: params.utm_medium,
    utm_campaign: params.utm_campaign,
    utm_content: params.utm_content,
    utm_term: params.utm_term,
    utm_id: params.utm_id
  };
}

/* ----------------------------- Normalization ----------------------------- */

function normalizeInput(input) {
  const safe = input && typeof input === "object" ? input : {};
  return {
    page_location: toStringOrNull(safe.page_location),
    page_referrer: toStringOrNull(safe.page_referrer)
  };
}

function normalizeObjectValues(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = normalizeValue(obj[k]);
    if (v !== null) out[k] = v;
  }
  return out;
}

function normalizeValue(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;

  const lowered = s.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "(not set)") return null;

  return s;
}

function applyConsentToClickIds(clickIds, consent) {
  const adGranted = !!(consent && consent.adStorageGranted);
  if (adGranted) return clickIds;

  //Remove ads identifiers when ad_storage is not "granted".
  const { fbclid, msclkid, ttclid, li_fat_id, gclid, gbraid, wbraid } = clickIds;
  const hasAny = isNonEmpty(fbclid) || isNonEmpty(msclkid) || isNonEmpty(ttclid) || isNonEmpty(li_fat_id) || isNonEmpty(gclid) || isNonEmpty(gbraid) || isNonEmpty(wbraid);
  if (!hasAny) return clickIds;

  return {};
}

/* ----------------------------- URL utils ----------------------------- */

function safeParseUrl(url) {
  try {
    if (!isNonEmpty(url)) return null;
    return new URL(url);
  } catch {
    return null;
  }
}

function readParams(searchParams) {
  const out = {};
  if (!searchParams) return out;

  for (const [k, v] of searchParams.entries()) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

function buildCleanUrl(urlObj, cfg) {
  const u = new URL(urlObj.toString());
  const removeSet = new Set(cfg.removeParams || []);

  if (cfg.keepClickIdsInCleanUrl) {
    for (const p of ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id"]) {
      removeSet.delete(p);
    }
  }

  for (const key of Array.from(u.searchParams.keys())) {
    if (removeSet.has(key)) u.searchParams.delete(key);
  }

  const s = u.searchParams.toString();
  const base = u.origin + u.pathname + (s ? `?${s}` : "") + u.hash;

  return base;
}

function normalizeReferrer(pageReferrer, selfReferralHosts) {
  const ref = safeParseUrl(pageReferrer);
  if (!ref) return null;

  const host = ref.hostname;
  if (!host) return null;

  const deny = new Set((selfReferralHosts || []).map(String));
  if (deny.has(host)) return null;

  // Also ignores empty referrer.
  if (host === "localhost") return null;

  return { host };
}

/* ----------------------------- Helpers ----------------------------- */

function classifyChannelFromMedium(medium) {
  const m = (medium || "").toLowerCase();

  if (m.includes("cpc") || m.includes("ppc") || m.includes("paid")) return "paid";
  if (m.includes("email")) return "email";
  if (m.includes("social")) return "social";
  if (m.includes("affiliate")) return "affiliate";
  if (m.includes("display") || m.includes("banner")) return "display";
  if (m.includes("referral")) return "referral";
  if (m.includes("organic") || m.includes("seo")) return "organic";

  return "other";
}

function chooseAnyClickId(clickIds) {
  const order = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id"];
  for (const k of order) {
    if (isNonEmpty(clickIds[k])) return { type: k, value: clickIds[k] };
  }
  return null;
}

function hasAnyUtm(utm) {
  if (!utm) return false;
  return (
    isNonEmpty(utm.utm_source) ||
    isNonEmpty(utm.utm_medium) ||
    isNonEmpty(utm.utm_campaign) ||
    isNonEmpty(utm.utm_content) ||
    isNonEmpty(utm.utm_term) ||
    isNonEmpty(utm.utm_id)
  );
}

function isNonEmpty(v) {
  return v !== null && v !== undefined && String(v).trim().length > 0;
}

function toStringOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };

  if (!override || typeof override !== "object") return out;

  for (const k of Object.keys(override)) {
    const bv = base ? base[k] : undefined;
    const ov = override[k];

    if (Array.isArray(ov)) out[k] = [...ov];
    else if (ov && typeof ov === "object" && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, ov);
    } else {
      out[k] = ov;
    }
  }

  return out;
}

/* ----------------------------- Examples (optional) ----------------------------- */

// Run in NodeServer to see outputs
if (typeof require !== "undefined" && require.main === module) {
  const examples = [
    {
      name: "Paid - gclid wins",
      input: {
        page_location:
          "https://example.com/product?gclid=AAA111&utm_source=facebook&utm_medium=paid_social&utm_campaign=summer",
        page_referrer: "https://google.com/"
      }
    },
    {
      name: "UTM only",
      input: {
        page_location:
          "https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=jan",
        page_referrer: ""
      }
    },
    {
      name: "No signals => direct",
      input: {
        page_location: "https://example.com/",
        page_referrer: ""
      }
    }
  ];

  for (const ex of examples) {
    const res = resolveAttribution(ex.input, {
      consent: { adStorageGranted: true, analyticsStorageGranted: true }
    });
    console.log("\n---", ex.name, "---");
    console.log(JSON.stringify(res, null, 2));
  }
}

// Export para uso em outros arquivos
module.exports = { resolveAttribution };
