// services/billingPricing.service.js
// =============================================================================
// Turns a base-currency plan into the price a specific customer is shown and
// charged, and decides which payment provider can actually take that currency.
//
// Rules that matter:
//   • A published price is frozen. Once a currency has a row in the price book,
//     FX movement never changes it — only an explicit refresh does. A customer
//     cannot see one price on the pricing page and another at checkout.
//   • Manual (admin-set) prices always win over FX-derived ones.
//   • A provider that cannot settle a currency never sees it: the charge falls
//     back to a currency that provider does support.
// =============================================================================

import {
  convertMinorAmount,
  getBaseCurrency,
  getFxRates,
  getSupportedCurrencies,
  isSupportedCurrency,
  normalizeCurrency,
} from "./currency.service.js";
import {
  getPlanPrice,
  listAllPlanPrices,
  listPlanPrices,
  upsertPlanPrice,
} from "../repositories/billingPlans.repository.js";

// Razorpay settles in INR by default. Non-INR needs International Payments (and
// for recurring, multi-currency Subscriptions) enabled on the merchant account,
// so it is opt-in via env rather than assumed.
const DEFAULT_RAZORPAY_CURRENCIES = ["inr"];

export function getProviderCurrencies(provider) {
  if (provider === "razorpay") {
    const configured = String(process.env.RAZORPAY_SUPPORTED_CURRENCIES || "").trim();
    const list = configured
      ? configured.split(",").map((code) => normalizeCurrency(code)).filter(Boolean)
      : DEFAULT_RAZORPAY_CURRENCIES;
    return list.length ? [...new Set(list)] : DEFAULT_RAZORPAY_CURRENCIES;
  }

  // Stripe settles essentially every currency in our registry.
  const configured = String(process.env.STRIPE_SUPPORTED_CURRENCIES || "").trim();
  if (configured) {
    const list = configured.split(",").map((code) => normalizeCurrency(code)).filter(Boolean);
    if (list.length) return [...new Set(list)];
  }
  return getSupportedCurrencies();
}

export function providerSupportsCurrency(provider, currency) {
  const normalized = normalizeCurrency(currency);
  return !!normalized && getProviderCurrencies(provider).includes(normalized);
}

/**
 * The currency a provider will actually be charged in for a requested display
 * currency. Falls back to the provider's own default (INR for Razorpay) rather
 * than failing the checkout.
 */
export function resolveChargeCurrency(provider, displayCurrency) {
  const requested = normalizeCurrency(displayCurrency) || getBaseCurrency();
  if (providerSupportsCurrency(provider, requested)) {
    return { currency: requested, converted: false };
  }

  const supported = getProviderCurrencies(provider);
  const base = getBaseCurrency();
  const fallback = supported.includes(base) ? base : supported[0];

  return { currency: fallback, converted: true, requested };
}

function basePricesFor(plan) {
  return {
    monthly: Math.round(Number(plan.price_monthly_minor) || 0),
    yearly: Math.round(Number(plan.price_yearly_minor) || 0),
  };
}

function baseCurrencyOf(plan) {
  return normalizeCurrency(plan.base_currency) || getBaseCurrency();
}

/**
 * Resolve the published price for one plan in one currency, generating and
 * persisting it from FX the first time that currency is requested.
 */
export async function resolvePlanPrice(plan, currency, { persist = true, rates = null } = {}) {
  const target = normalizeCurrency(currency) || getBaseCurrency();
  const base = baseCurrencyOf(plan);
  const amounts = basePricesFor(plan);

  // Free plans are free everywhere.
  if (amounts.monthly === 0 && amounts.yearly === 0) {
    return { currency: target, price_monthly_minor: 0, price_yearly_minor: 0, source: "base", fx_rate: null };
  }

  if (target === base) {
    return {
      currency: base,
      price_monthly_minor: amounts.monthly,
      price_yearly_minor: amounts.yearly,
      source: "base",
      fx_rate: 1,
    };
  }

  const published = await getPlanPrice(plan.id, target);
  if (published) {
    return {
      currency: target,
      price_monthly_minor: Number(published.price_monthly_minor),
      price_yearly_minor: Number(published.price_yearly_minor),
      source: published.source,
      fx_rate: published.fx_rate == null ? null : Number(published.fx_rate),
    };
  }

  const fx = rates || (await getFxRates({ base }));
  const monthly = convertMinorAmount(amounts.monthly, target, fx.rates, { base });
  const yearly = convertMinorAmount(amounts.yearly, target, fx.rates, { base });

  if (persist) {
    try {
      await upsertPlanPrice({
        planId: plan.id,
        currency: target,
        price_monthly_minor: monthly,
        price_yearly_minor: yearly,
        source: "fx",
        fx_rate: fx.rates[target] ?? null,
        fx_rate_at: fx.fetchedAt,
      });
    } catch (err) {
      // A failed publish must not break the pricing page; the price is still
      // correct for this response and will be retried on the next request.
      console.warn(`[pricing] could not publish ${target} price for ${plan.slug}:`, err.message);
    }
  }

  return {
    currency: target,
    price_monthly_minor: monthly,
    price_yearly_minor: yearly,
    source: "fx",
    fx_rate: fx.rates[target] ?? null,
  };
}

/** Price a whole catalog in one currency with a single FX lookup. */
export async function resolveCatalogPrices(plans, currency, { persist = true } = {}) {
  const target = normalizeCurrency(currency) || getBaseCurrency();
  const needsFx = target !== getBaseCurrency() && plans.some((plan) => baseCurrencyOf(plan) !== target);
  const rates = needsFx ? await getFxRates() : null;

  const out = new Map();
  for (const plan of plans) {
    out.set(plan.id, await resolvePlanPrice(plan, target, { persist, rates }));
  }
  return out;
}

/**
 * Republish every FX-derived price at today's rates. Manual prices are left
 * alone. This is the only thing that moves an already-published local price.
 */
export async function refreshPriceBook(plans, { currencies = null, includeManual = false } = {}) {
  const fx = await getFxRates({ forceRefresh: true });
  const targets = (currencies?.length ? currencies : getSupportedCurrencies())
    .map((code) => normalizeCurrency(code))
    .filter(Boolean);

  const existing = await listAllPlanPrices();
  const manualKeys = new Set(
    existing.filter((row) => row.source === "manual").map((row) => `${row.plan_id}:${row.currency}`)
  );

  const updated = [];
  for (const plan of plans) {
    const base = baseCurrencyOf(plan);
    const amounts = basePricesFor(plan);
    if (amounts.monthly === 0 && amounts.yearly === 0) continue;

    for (const target of targets) {
      if (target === base) continue;
      if (!includeManual && manualKeys.has(`${plan.id}:${target}`)) continue;

      try {
        const row = await upsertPlanPrice({
          planId: plan.id,
          currency: target,
          price_monthly_minor: convertMinorAmount(amounts.monthly, target, fx.rates, { base }),
          price_yearly_minor: convertMinorAmount(amounts.yearly, target, fx.rates, { base }),
          source: "fx",
          fx_rate: fx.rates[target] ?? null,
          fx_rate_at: fx.fetchedAt,
        });
        updated.push({ plan: plan.slug, currency: target, monthly: row.price_monthly_minor, yearly: row.price_yearly_minor });
      } catch (err) {
        console.warn(`[pricing] refresh failed for ${plan.slug}/${target}:`, err.message);
      }
    }
  }

  return { fxSource: fx.source, fxFetchedAt: fx.fetchedAt, stale: fx.stale, updated };
}

/** Everything the checkout needs to charge one plan/interval/currency. */
export async function getChargeAmount({ plan, interval, currency }) {
  const normalizedInterval = interval === "yearly" ? "yearly" : "monthly";
  const price = await resolvePlanPrice(plan, currency);
  const amount =
    normalizedInterval === "yearly" ? price.price_yearly_minor : price.price_monthly_minor;

  return {
    interval: normalizedInterval,
    currency: price.currency,
    amountMinor: amount,
    source: price.source,
  };
}

export async function getPlanPriceBook(planId) {
  return listPlanPrices(planId);
}

export { isSupportedCurrency };
