import test from "node:test";
import assert from "node:assert/strict";
import {
  convertMinorAmount,
  currencyForCountry,
  detectCountry,
  formatMoney,
  getCurrencyMeta,
  minorUnitFactor,
  normalizeCurrency,
  resolveRequestCurrency,
  roundToRetailPrice,
  toMajorUnits,
  toMinorUnits,
} from "../services/currency.service.js";
import { resolveChargeCurrency, providerSupportsCurrency } from "../services/billingPricing.service.js";

const RATES = { usd: 1, inr: 88, eur: 0.92, gbp: 0.79, jpy: 152, kwd: 0.31 };

test("minor units respect the ISO 4217 exponent", () => {
  assert.equal(minorUnitFactor("usd"), 100);
  assert.equal(minorUnitFactor("jpy"), 1);   // zero-decimal
  assert.equal(minorUnitFactor("kwd"), 1000); // three-decimal

  assert.equal(toMinorUnits(20, "usd"), 2000);
  assert.equal(toMinorUnits(3000, "jpy"), 3000);
  assert.equal(toMajorUnits(2000, "usd"), 20);
  assert.equal(toMajorUnits(3000, "jpy"), 3000);
});

test("unknown currency codes are rejected rather than silently accepted", () => {
  assert.equal(normalizeCurrency("USD"), "usd");
  assert.equal(normalizeCurrency("  eur "), "eur");
  assert.equal(normalizeCurrency("XYZ"), null);
  assert.equal(normalizeCurrency(""), null);
  assert.equal(getCurrencyMeta("XYZ"), null);
});

test("conversion lands on retail price points, not raw FX output", () => {
  // $20.00 at 88 INR/USD = ₹1760 raw → rounded up to a clean ₹1800.
  const inr = convertMinorAmount(2000, "inr", RATES);
  assert.equal(inr % 100, 0, "whole rupees");
  assert.ok(inr >= 176000, "never cheaper than the true converted price");
  assert.equal(inr, 180000);

  // A charm ending on the base price carries over: $19.99 → €18.99.
  const eur = convertMinorAmount(1999, "eur", RATES);
  assert.equal(eur % 100, 99);
});

test("conversion never rounds a paid plan down to free", () => {
  // $1 in a currency where one unit is worth far more than a dollar.
  const kwd = convertMinorAmount(100, "kwd", RATES);
  assert.ok(kwd > 0, "a paid plan must stay paid");
  // Three-decimal currencies must be a multiple of 10 for Stripe.
  assert.equal(kwd % 10, 0);
});

test("zero-decimal currencies produce whole-unit amounts", () => {
  const jpy = convertMinorAmount(2000, "jpy", RATES);
  assert.equal(Number.isInteger(jpy), true);
  assert.equal(jpy % 100, 0, "¥3,000 rather than ¥3,042");
});

test("base currency conversion is a no-op", () => {
  assert.equal(convertMinorAmount(2000, "usd", RATES), 2000);
});

test("a missing FX rate throws instead of pricing at zero", () => {
  assert.throws(() => convertMinorAmount(2000, "brl", RATES), /No FX rate/);
});

test("retail rounding scales its step with magnitude", () => {
  assert.equal(roundToRetailPrice(1234, "usd"), 1300);      // $12.34 → $13
  assert.equal(roundToRetailPrice(176012, "inr"), 180000);  // ₹1760.12 → ₹1800
});

test("formatMoney renders each currency in its own convention", () => {
  assert.match(formatMoney(2000, "usd"), /\$20/);
  assert.match(formatMoney(3000, "jpy"), /3,000/);
  assert.equal(formatMoney(0, "usd").includes("0"), true);
});

test("country maps to the expected currency", () => {
  assert.equal(currencyForCountry("IN"), "inr");
  assert.equal(currencyForCountry("DE"), "eur");
  assert.equal(currencyForCountry("us"), "usd");
  assert.equal(currencyForCountry("ZZ"), null);
});

test("edge country headers are read, and junk values ignored", () => {
  assert.equal(detectCountry({ headers: { "cf-ipcountry": "GB" } }), "GB");
  assert.equal(detectCountry({ headers: { "x-vercel-ip-country": "fr" } }), "FR");
  assert.equal(detectCountry({ headers: { "cf-ipcountry": "XX" } }), null); // Cloudflare's unknown
  assert.equal(detectCountry({ headers: {} }), null);
});

test("request currency precedence: explicit beats geo beats locale", () => {
  const req = {
    query: { currency: "gbp" },
    headers: { "cf-ipcountry": "IN", "accept-language": "de-DE" },
  };
  assert.equal(resolveRequestCurrency(req).currency, "gbp");

  const geoOnly = { query: {}, headers: { "cf-ipcountry": "IN", "accept-language": "de-DE" } };
  assert.equal(resolveRequestCurrency(geoOnly).currency, "inr");

  const localeOnly = { query: {}, headers: { "accept-language": "de-DE,de;q=0.9" } };
  assert.equal(resolveRequestCurrency(localeOnly).currency, "eur");

  const nothing = { query: {}, headers: {} };
  assert.equal(resolveRequestCurrency(nothing).currency, "usd");
});

test("an unsupported requested currency falls through instead of erroring", () => {
  const req = { query: { currency: "XYZ" }, headers: { "cf-ipcountry": "IN" } };
  assert.equal(resolveRequestCurrency(req).currency, "inr");
});

test("Razorpay falls back to a settleable currency instead of failing checkout", () => {
  const previous = process.env.RAZORPAY_SUPPORTED_CURRENCIES;
  process.env.RAZORPAY_SUPPORTED_CURRENCIES = "inr";

  try {
    assert.equal(providerSupportsCurrency("razorpay", "inr"), true);
    assert.equal(providerSupportsCurrency("razorpay", "eur"), false);

    const inr = resolveChargeCurrency("razorpay", "inr");
    assert.deepEqual(inr, { currency: "inr", converted: false });

    // A euro customer on an INR-only Razorpay account still gets a charge.
    const eur = resolveChargeCurrency("razorpay", "eur");
    assert.equal(eur.currency, "inr");
    assert.equal(eur.converted, true);
    assert.equal(eur.requested, "eur");

    // Stripe takes the euro directly.
    assert.equal(resolveChargeCurrency("stripe", "eur").currency, "eur");
  } finally {
    if (previous === undefined) delete process.env.RAZORPAY_SUPPORTED_CURRENCIES;
    else process.env.RAZORPAY_SUPPORTED_CURRENCIES = previous;
  }
});

test("widening RAZORPAY_SUPPORTED_CURRENCIES lets it charge in that currency", () => {
  const previous = process.env.RAZORPAY_SUPPORTED_CURRENCIES;
  process.env.RAZORPAY_SUPPORTED_CURRENCIES = "inr,usd,aed";

  try {
    assert.equal(resolveChargeCurrency("razorpay", "usd").currency, "usd");
    assert.equal(resolveChargeCurrency("razorpay", "aed").converted, false);
    assert.equal(resolveChargeCurrency("razorpay", "gbp").currency, "usd"); // base fallback
  } finally {
    if (previous === undefined) delete process.env.RAZORPAY_SUPPORTED_CURRENCIES;
    else process.env.RAZORPAY_SUPPORTED_CURRENCIES = previous;
  }
});
