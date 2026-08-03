// services/currency.service.js
// =============================================================================
// Currency, FX and localised pricing.
//
// The plan catalog is authored in a single base currency (USD). Every other
// currency is derived from it and then *published* into billing_plan_prices, so
// a price a customer has seen never moves underneath them because the FX market
// moved. FX is only consulted when a currency is priced for the first time or
// when a superadmin explicitly refreshes the price book.
//
// Env:
//   BILLING_BASE_CURRENCY          default 'usd'
//   BILLING_SUPPORTED_CURRENCIES   comma list, default = full registry below
//   FX_RATES_URL                   default https://open.er-api.com/v6/latest/USD
//   FX_RATES_TTL_HOURS             default 24
//   FX_RATES_STATIC                JSON map to pin rates offline, e.g. {"inr":88}
// =============================================================================

import axios from "axios";
import db from "../db.js";

const DEFAULT_FX_URL = "https://open.er-api.com/v6/latest/USD";

// ── Currency registry ────────────────────────────────────────────────────────
// `exp` is the ISO 4217 minor-unit exponent: the number of decimal places.
// Zero-decimal currencies (JPY, KRW, …) have no sub-unit at all; three-decimal
// currencies (KWD, BHD, …) need amounts that are multiples of 10 for Stripe.

const CURRENCIES = {
  usd: { name: "US Dollar",           symbol: "$",    exp: 2, locale: "en-US" },
  eur: { name: "Euro",                symbol: "€",    exp: 2, locale: "de-DE" },
  gbp: { name: "British Pound",       symbol: "£",    exp: 2, locale: "en-GB" },
  inr: { name: "Indian Rupee",        symbol: "₹",    exp: 2, locale: "en-IN" },
  cad: { name: "Canadian Dollar",     symbol: "CA$",  exp: 2, locale: "en-CA" },
  aud: { name: "Australian Dollar",   symbol: "A$",   exp: 2, locale: "en-AU" },
  nzd: { name: "New Zealand Dollar",  symbol: "NZ$",  exp: 2, locale: "en-NZ" },
  sgd: { name: "Singapore Dollar",    symbol: "S$",   exp: 2, locale: "en-SG" },
  hkd: { name: "Hong Kong Dollar",    symbol: "HK$",  exp: 2, locale: "en-HK" },
  chf: { name: "Swiss Franc",         symbol: "CHF",  exp: 2, locale: "de-CH" },
  sek: { name: "Swedish Krona",       symbol: "kr",   exp: 2, locale: "sv-SE" },
  nok: { name: "Norwegian Krone",     symbol: "kr",   exp: 2, locale: "nb-NO" },
  dkk: { name: "Danish Krone",        symbol: "kr",   exp: 2, locale: "da-DK" },
  pln: { name: "Polish Zloty",        symbol: "zł",   exp: 2, locale: "pl-PL" },
  czk: { name: "Czech Koruna",        symbol: "Kč",   exp: 2, locale: "cs-CZ" },
  ron: { name: "Romanian Leu",        symbol: "lei",  exp: 2, locale: "ro-RO" },
  huf: { name: "Hungarian Forint",    symbol: "Ft",   exp: 2, locale: "hu-HU" },
  bgn: { name: "Bulgarian Lev",       symbol: "лв",   exp: 2, locale: "bg-BG" },
  try: { name: "Turkish Lira",        symbol: "₺",    exp: 2, locale: "tr-TR" },
  ils: { name: "Israeli Shekel",      symbol: "₪",    exp: 2, locale: "he-IL" },
  aed: { name: "UAE Dirham",          symbol: "AED",  exp: 2, locale: "en-AE" },
  sar: { name: "Saudi Riyal",         symbol: "SAR",  exp: 2, locale: "en-SA" },
  qar: { name: "Qatari Riyal",        symbol: "QAR",  exp: 2, locale: "en-QA" },
  zar: { name: "South African Rand",  symbol: "R",    exp: 2, locale: "en-ZA" },
  ngn: { name: "Nigerian Naira",      symbol: "₦",    exp: 2, locale: "en-NG" },
  kes: { name: "Kenyan Shilling",     symbol: "KSh",  exp: 2, locale: "en-KE" },
  egp: { name: "Egyptian Pound",      symbol: "E£",   exp: 2, locale: "en-EG" },
  brl: { name: "Brazilian Real",      symbol: "R$",   exp: 2, locale: "pt-BR" },
  mxn: { name: "Mexican Peso",        symbol: "MX$",  exp: 2, locale: "es-MX" },
  ars: { name: "Argentine Peso",      symbol: "ARS",  exp: 2, locale: "es-AR" },
  cop: { name: "Colombian Peso",      symbol: "COP",  exp: 2, locale: "es-CO" },
  clp: { name: "Chilean Peso",        symbol: "CLP",  exp: 0, locale: "es-CL" },
  pen: { name: "Peruvian Sol",        symbol: "S/",   exp: 2, locale: "es-PE" },
  jpy: { name: "Japanese Yen",        symbol: "¥",    exp: 0, locale: "ja-JP" },
  krw: { name: "South Korean Won",    symbol: "₩",    exp: 0, locale: "ko-KR" },
  cny: { name: "Chinese Yuan",        symbol: "CN¥",  exp: 2, locale: "zh-CN" },
  twd: { name: "New Taiwan Dollar",   symbol: "NT$",  exp: 2, locale: "zh-TW" },
  thb: { name: "Thai Baht",           symbol: "฿",    exp: 2, locale: "th-TH" },
  vnd: { name: "Vietnamese Dong",     symbol: "₫",    exp: 0, locale: "vi-VN" },
  idr: { name: "Indonesian Rupiah",   symbol: "Rp",   exp: 2, locale: "id-ID" },
  myr: { name: "Malaysian Ringgit",   symbol: "RM",   exp: 2, locale: "ms-MY" },
  php: { name: "Philippine Peso",     symbol: "₱",    exp: 2, locale: "en-PH" },
  pkr: { name: "Pakistani Rupee",     symbol: "₨",    exp: 2, locale: "en-PK" },
  bdt: { name: "Bangladeshi Taka",    symbol: "৳",    exp: 2, locale: "bn-BD" },
  lkr: { name: "Sri Lankan Rupee",    symbol: "Rs",   exp: 2, locale: "en-LK" },
  npr: { name: "Nepalese Rupee",      symbol: "NRs",  exp: 2, locale: "ne-NP" },
  kwd: { name: "Kuwaiti Dinar",       symbol: "KD",   exp: 3, locale: "en-KW" },
  bhd: { name: "Bahraini Dinar",      symbol: "BD",   exp: 3, locale: "en-BH" },
  omr: { name: "Omani Rial",          symbol: "OMR",  exp: 3, locale: "en-OM" },
  jod: { name: "Jordanian Dinar",     symbol: "JD",   exp: 3, locale: "en-JO" },
  tnd: { name: "Tunisian Dinar",      symbol: "DT",   exp: 3, locale: "ar-TN" },
};

// Country → currency. Used to pick a sensible default from the caller's IP.
const COUNTRY_CURRENCY = {
  US: "usd", IN: "inr", GB: "gbp", CA: "cad", AU: "aud", NZ: "nzd", SG: "sgd",
  HK: "hkd", CH: "chf", SE: "sek", NO: "nok", DK: "dkk", PL: "pln", CZ: "czk",
  RO: "ron", HU: "huf", BG: "bgn", TR: "try", IL: "ils", AE: "aed", SA: "sar",
  QA: "qar", ZA: "zar", NG: "ngn", KE: "kes", EG: "egp", BR: "brl", MX: "mxn",
  AR: "ars", CO: "cop", CL: "clp", PE: "pen", JP: "jpy", KR: "krw", CN: "cny",
  TW: "twd", TH: "thb", VN: "vnd", ID: "idr", MY: "myr", PH: "php", PK: "pkr",
  BD: "bdt", LK: "lkr", NP: "npr", KW: "kwd", BH: "bhd", OM: "omr", JO: "jod",
  TN: "tnd",
  // Eurozone
  AT: "eur", BE: "eur", CY: "eur", EE: "eur", FI: "eur", FR: "eur", DE: "eur",
  GR: "eur", IE: "eur", IT: "eur", LV: "eur", LT: "eur", LU: "eur", MT: "eur",
  NL: "eur", PT: "eur", SK: "eur", SI: "eur", ES: "eur", HR: "eur",
};

// Last-resort rates so pricing pages still render if the FX provider and the
// cache are both unavailable. Deliberately conservative and clearly stale.
const FALLBACK_RATES = {
  usd: 1, eur: 0.92, gbp: 0.79, inr: 88, cad: 1.36, aud: 1.52, nzd: 1.65,
  sgd: 1.34, hkd: 7.8, chf: 0.88, sek: 10.5, nok: 10.7, dkk: 6.85, pln: 3.95,
  czk: 22.8, ron: 4.57, huf: 355, bgn: 1.8, try: 34, ils: 3.7, aed: 3.67,
  sar: 3.75, qar: 3.64, zar: 18.5, ngn: 1550, kes: 129, egp: 48, brl: 5.5,
  mxn: 18.5, ars: 1000, cop: 4100, clp: 950, pen: 3.75, jpy: 152, krw: 1350,
  cny: 7.2, twd: 32, thb: 34.5, vnd: 25000, idr: 15800, myr: 4.4, php: 58,
  pkr: 278, bdt: 120, lkr: 300, npr: 141, kwd: 0.31, bhd: 0.376, omr: 0.385,
  jod: 0.709, tnd: 3.1,
};

// ── Basics ───────────────────────────────────────────────────────────────────

export function getBaseCurrency() {
  return normalizeCurrency(process.env.BILLING_BASE_CURRENCY || "usd") || "usd";
}

export function normalizeCurrency(code) {
  const normalized = String(code || "").trim().toLowerCase();
  return CURRENCIES[normalized] ? normalized : null;
}

export function isSupportedCurrency(code) {
  return getSupportedCurrencies().includes(normalizeCurrency(code));
}

export function getSupportedCurrencies() {
  const configured = String(process.env.BILLING_SUPPORTED_CURRENCIES || "").trim();
  if (!configured) return Object.keys(CURRENCIES);

  const list = configured
    .split(",")
    .map((code) => normalizeCurrency(code))
    .filter(Boolean);

  const base = getBaseCurrency();
  if (!list.includes(base)) list.unshift(base);
  return list.length ? [...new Set(list)] : Object.keys(CURRENCIES);
}

export function getCurrencyMeta(code) {
  const normalized = normalizeCurrency(code);
  if (!normalized) return null;
  const meta = CURRENCIES[normalized];
  return {
    code: normalized,
    display: normalized.toUpperCase(),
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.exp,
    locale: meta.locale,
  };
}

export function listCurrencies() {
  return getSupportedCurrencies().map((code) => getCurrencyMeta(code));
}

/** Number of minor units in one major unit (100 for USD, 1 for JPY). */
export function minorUnitFactor(code) {
  const meta = CURRENCIES[normalizeCurrency(code) || "usd"];
  return 10 ** meta.exp;
}

export function toMinorUnits(majorAmount, code) {
  return Math.round((Number(majorAmount) || 0) * minorUnitFactor(code));
}

export function toMajorUnits(minorAmount, code) {
  return (Number(minorAmount) || 0) / minorUnitFactor(code);
}

export function formatMoney(minorAmount, code, { maximumFractionDigits } = {}) {
  const meta = getCurrencyMeta(code) || getCurrencyMeta(getBaseCurrency());
  const major = toMajorUnits(minorAmount, meta.code);
  const digits =
    maximumFractionDigits === undefined
      ? Number.isInteger(major)
        ? 0
        : meta.decimals
      : maximumFractionDigits;

  try {
    return new Intl.NumberFormat(meta.locale, {
      style: "currency",
      currency: meta.display,
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${meta.symbol}${major.toFixed(digits)}`;
  }
}

// ── FX rates ─────────────────────────────────────────────────────────────────

function getStaticRates() {
  const raw = String(process.env.FX_RATES_STATIC || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [code, rate] of Object.entries(parsed)) {
      const normalized = normalizeCurrency(code);
      const value = Number(rate);
      if (normalized && Number.isFinite(value) && value > 0) out[normalized] = value;
    }
    return out;
  } catch {
    console.warn("[currency] FX_RATES_STATIC is not valid JSON — ignoring");
    return {};
  }
}

function getRatesTtlMs() {
  const hours = Number(process.env.FX_RATES_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

async function readCachedRates(base) {
  try {
    const { rows } = await db.query(
      `SELECT currency, rate, source, fetched_at
         FROM fx_rates
        WHERE base_currency = $1`,
      [base]
    );
    if (!rows.length) return null;

    const rates = {};
    let newest = 0;
    let source = "cache";
    for (const row of rows) {
      rates[row.currency] = Number(row.rate);
      const at = new Date(row.fetched_at).getTime();
      if (at > newest) {
        newest = at;
        source = row.source;
      }
    }
    return { rates, fetchedAt: new Date(newest).toISOString(), source, stale: Date.now() - newest > getRatesTtlMs() };
  } catch (err) {
    console.warn("[currency] FX cache read failed:", err.message);
    return null;
  }
}

async function writeCachedRates(base, rates, source) {
  const entries = Object.entries(rates);
  if (!entries.length) return;
  try {
    await db.query(
      `INSERT INTO fx_rates (base_currency, currency, rate, source, fetched_at)
       SELECT $1, code, rate, $4, now()
         FROM unnest($2::text[], $3::numeric[]) AS t(code, rate)
       ON CONFLICT (base_currency, currency)
       DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
      [base, entries.map(([code]) => code), entries.map(([, rate]) => rate), source]
    );
  } catch (err) {
    console.warn("[currency] FX cache write failed:", err.message);
  }
}

async function fetchLiveRates(base) {
  const url = process.env.FX_RATES_URL || DEFAULT_FX_URL;
  const response = await axios.get(url, { timeout: 8000, validateStatus: () => true });
  if (response.status >= 400) {
    throw new Error(`FX provider returned ${response.status}`);
  }

  // Supports both open.er-api.com ({ rates }) and exchangerate.host ({ rates }).
  const raw = response.data?.rates || response.data?.conversion_rates || null;
  if (!raw || typeof raw !== "object") {
    throw new Error("FX provider returned no rates");
  }

  const providerBase = String(response.data?.base_code || response.data?.base || "usd").toLowerCase();
  const rates = {};
  for (const [code, value] of Object.entries(raw)) {
    const normalized = normalizeCurrency(code);
    const rate = Number(value);
    if (normalized && Number.isFinite(rate) && rate > 0) rates[normalized] = rate;
  }

  // Rebase if the provider quotes against something other than our base.
  if (providerBase !== base && rates[base]) {
    const divisor = rates[base];
    for (const code of Object.keys(rates)) rates[code] /= divisor;
  }
  rates[base] = 1;

  if (Object.keys(rates).length < 5) throw new Error("FX provider returned too few usable rates");
  return rates;
}

let inflightRefresh = null;

/**
 * Resolve the rate table for `base`, preferring: static env pins > fresh cache >
 * live provider > stale cache > built-in fallback. Never throws.
 */
export async function getFxRates({ base = getBaseCurrency(), forceRefresh = false } = {}) {
  const staticRates = getStaticRates();
  const cached = await readCachedRates(base);

  if (!forceRefresh && cached && !cached.stale) {
    return { base, rates: { ...cached.rates, ...staticRates, [base]: 1 }, source: cached.source, fetchedAt: cached.fetchedAt, stale: false };
  }

  inflightRefresh ??= (async () => {
    try {
      const rates = await fetchLiveRates(base);
      await writeCachedRates(base, rates, new URL(process.env.FX_RATES_URL || DEFAULT_FX_URL).host);
      return rates;
    } finally {
      inflightRefresh = null;
    }
  })();

  try {
    const rates = await inflightRefresh;
    return {
      base,
      rates: { ...rates, ...staticRates, [base]: 1 },
      source: "live",
      fetchedAt: new Date().toISOString(),
      stale: false,
    };
  } catch (err) {
    console.warn("[currency] live FX refresh failed:", err.message);
    if (cached) {
      return { base, rates: { ...cached.rates, ...staticRates, [base]: 1 }, source: cached.source, fetchedAt: cached.fetchedAt, stale: true };
    }
    return { base, rates: { ...FALLBACK_RATES, ...staticRates, [base]: 1 }, source: "fallback", fetchedAt: null, stale: true };
  }
}

export async function refreshFxRates() {
  return getFxRates({ forceRefresh: true });
}

// ── Conversion with retail rounding ──────────────────────────────────────────

/**
 * Round a converted amount to a price a human would actually put on a page.
 * Steps scale with magnitude, and a charm ending on the base price ($19.99) is
 * carried over to the local price (₹1,799 → ₹1,799; €18.42 → €18.99).
 */
export function roundToRetailPrice(minorAmount, code, { charm = false } = {}) {
  const currency = normalizeCurrency(code) || getBaseCurrency();
  const factor = minorUnitFactor(currency);
  const major = minorAmount / factor;
  if (major <= 0) return 0;

  const step =
    major < 20 ? 1 :
    major < 100 ? 5 :
    major < 500 ? 10 :
    major < 2000 ? 50 :
    major < 10000 ? 100 :
    major < 100000 ? 500 : 1000;

  let rounded = Math.ceil(major / step) * step;

  // Charm pricing only makes sense where the currency has sub-units and the
  // number is small enough for the ".99" to read as a discount.
  if (charm && factor > 1 && rounded <= 2000) {
    rounded -= 1 / factor;
  }

  const result = Math.round(rounded * factor);

  // Stripe requires three-decimal currency amounts to be a multiple of 10.
  if (CURRENCIES[currency].exp === 3) return Math.round(result / 10) * 10;
  return result;
}

function hasCharmEnding(minorAmount, code) {
  const factor = minorUnitFactor(code);
  if (factor <= 1) return false;
  return minorAmount % factor === factor - 1; // …99 for a 2-decimal currency
}

/**
 * Convert a base-currency amount into `targetCurrency`, rounded to a retail
 * price point. Returns minor units of the target currency.
 */
export function convertMinorAmount(baseMinorAmount, targetCurrency, rates, { base = getBaseCurrency(), round = true } = {}) {
  const target = normalizeCurrency(targetCurrency);
  if (!target) throw new Error(`Unsupported currency: ${targetCurrency}`);
  if (target === base) return Math.round(Number(baseMinorAmount) || 0);

  const rate = Number(rates?.[target]);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`No FX rate available for ${target.toUpperCase()}`);
  }

  const baseMajor = toMajorUnits(baseMinorAmount, base);
  const rawTargetMinor = baseMajor * rate * minorUnitFactor(target);
  if (!round) return Math.round(rawTargetMinor);

  return roundToRetailPrice(rawTargetMinor, target, {
    charm: hasCharmEnding(baseMinorAmount, base),
  });
}

// ── Request-scoped currency resolution ───────────────────────────────────────

export function currencyForCountry(country) {
  const code = String(country || "").trim().toUpperCase();
  return normalizeCurrency(COUNTRY_CURRENCY[code]) || null;
}

/** Country from the edge headers Cloudflare/Vercel/AWS put on the request. */
export function detectCountry(req) {
  const header =
    req?.headers?.["cf-ipcountry"] ||
    req?.headers?.["x-vercel-ip-country"] ||
    req?.headers?.["x-appengine-country"] ||
    req?.headers?.["cloudfront-viewer-country"] ||
    null;

  const country = String(header || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === "XX" || country === "T1") return null;
  return country;
}

function currencyFromAcceptLanguage(req) {
  const header = String(req?.headers?.["accept-language"] || "");
  const match = header.match(/[a-z]{2,3}-([A-Z]{2})/);
  return match ? currencyForCountry(match[1]) : null;
}

/**
 * Pick the currency for a request. Precedence:
 *   explicit ?currency= → saved workspace preference → IP country → locale → base
 * Anything not in BILLING_SUPPORTED_CURRENCIES falls through to the next source.
 */
export function resolveRequestCurrency(req, { preferred = null } = {}) {
  const supported = getSupportedCurrencies();
  const base = getBaseCurrency();

  const candidates = [
    { code: req?.query?.currency, source: "explicit" },
    { code: preferred, source: "workspace" },
    { code: currencyForCountry(detectCountry(req)), source: "geo" },
    { code: currencyFromAcceptLanguage(req), source: "locale" },
  ];

  for (const candidate of candidates) {
    const normalized = normalizeCurrency(candidate.code);
    if (normalized && supported.includes(normalized)) {
      return { currency: normalized, source: candidate.source, country: detectCountry(req) };
    }
  }

  return { currency: base, source: "default", country: detectCountry(req) };
}

export const __testing = { CURRENCIES, COUNTRY_CURRENCY, FALLBACK_RATES };
