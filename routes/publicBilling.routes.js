import express from "express";
import { listPlans } from "../repositories/billingPlans.repository.js";
import {
  formatMoney,
  getBaseCurrency,
  getCurrencyMeta,
  listCurrencies,
  resolveRequestCurrency,
  toMajorUnits,
} from "../services/currency.service.js";
import { resolveCatalogPrices, resolveChargeCurrency } from "../services/billingPricing.service.js";
import { resolvePaymentsProviderForCurrency } from "../services/payments.service.js";

const router = express.Router();

/**
 * Public plan projection.
 *
 * `price_monthly` / `price_yearly` are major units of `currency` — the numbers a
 * pricing page renders. `price_monthly_minor` is the exact integer the payment
 * provider will be charged, so the UI never has to re-derive it from a float.
 * `base_*` fields keep the USD list price visible for comparison.
 */
export function toPublicBillingPlan(plan, price = null) {
  const baseCurrency = String(plan.base_currency || getBaseCurrency()).toLowerCase();
  const baseMonthly = Number(plan.price_monthly_minor) || 0;
  const baseYearly = Number(plan.price_yearly_minor) || 0;

  const currency = String(price?.currency || baseCurrency).toLowerCase();
  // Which provider would take this payment, and what it can actually settle.
  const provider = resolvePaymentsProviderForCurrency(currency);
  const charge = resolveChargeCurrency(provider, currency);
  const monthlyMinor = price ? Number(price.price_monthly_minor) || 0 : baseMonthly;
  const yearlyMinor = price ? Number(price.price_yearly_minor) || 0 : baseYearly;
  const meta = getCurrencyMeta(currency) || getCurrencyMeta(getBaseCurrency());

  return {
    id: plan.id,
    name: plan.name,
    slug: plan.slug,
    tagline: plan.tagline || null,
    description: plan.description || null,

    currency: meta.display,
    currency_symbol: meta.symbol,
    currency_decimals: meta.decimals,
    price_monthly: toMajorUnits(monthlyMinor, currency),
    price_yearly: toMajorUnits(yearlyMinor, currency),
    price_monthly_minor: monthlyMinor,
    price_yearly_minor: yearlyMinor,
    price_monthly_display: formatMoney(monthlyMinor, currency),
    price_yearly_display: formatMoney(yearlyMinor, currency),

    base_currency: baseCurrency.toUpperCase(),
    base_price_monthly: toMajorUnits(baseMonthly, baseCurrency),
    base_price_yearly: toMajorUnits(baseYearly, baseCurrency),
    price_source: price?.source || "base",

    // The currency the card is actually debited in, which is not always the
    // one quoted: Razorpay settles recurring subscriptions in INR only, so an
    // overseas visitor shown $11 is charged the rupee equivalent. Stating it
    // here lets the signup form say so before payment rather than leaving the
    // customer to discover it on their statement.
    charge_currency: charge.currency.toUpperCase(),
    charge_currency_differs: charge.currency !== currency,

    yearly_discount_pct: Number(plan.yearly_discount_pct) || 0,
    member_limit: plan.member_limit == null ? null : Number(plan.member_limit),
    max_projects: plan.max_projects == null ? null : Number(plan.max_projects),
    max_integrations: plan.max_integrations == null ? null : Number(plan.max_integrations),
    storage_limit_gb: plan.storage_limit_gb == null ? null : Number(plan.storage_limit_gb),
    features: Array.isArray(plan.features) ? plan.features : [],
    support_level: plan.support_level || null,
    trial_days: Number(plan.trial_days) || 0,
    is_popular: !!plan.is_popular,
    is_custom: !!plan.is_custom,
    display_order: Number(plan.display_order) || 0,
  };
}

/**
 * GET /billing/plans[?currency=EUR]
 *
 * Public, sanitized plan catalog shared by the landing page and signup UI.
 * Without ?currency the currency is inferred from the caller's country, so a
 * visitor in Germany sees euros without asking.
 */
router.get("/plans", async (req, res) => {
  try {
    const { currency, source, country } = resolveRequestCurrency(req);
    const plans = await listPlans({ includeInactive: false });
    const prices = await resolveCatalogPrices(plans, currency);

    // Geo-derived prices differ per visitor, so they must not be shared caches.
    res.set(
      "Cache-Control",
      source === "explicit"
        ? "public, max-age=300, stale-while-revalidate=600"
        : "private, max-age=60"
    );
    res.set("Vary", "CF-IPCountry, Accept-Language");
    res.set("X-Billing-Currency", currency.toUpperCase());

    return res.json(plans.map((plan) => toPublicBillingPlan(plan, prices.get(plan.id))));
  } catch (err) {
    console.error("[public-billing] failed to load plans:", err.message);
    return res.status(500).json({ error: "Plans are temporarily unavailable" });
  }
});

/**
 * GET /billing/currencies
 * Currency picker options plus the currency we would pick for this visitor.
 */
router.get("/currencies", (req, res) => {
  const { currency, source, country } = resolveRequestCurrency(req);
  res.set("Cache-Control", "private, max-age=300");
  return res.json({
    base: getBaseCurrency().toUpperCase(),
    detected: currency.toUpperCase(),
    detected_source: source,
    country: country || null,
    currencies: listCurrencies().map((meta) => ({
      code: meta.display,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
    })),
  });
});

export default router;
