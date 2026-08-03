// routes/superadminPlans.routes.js
import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  listPlans,
  getPlanById,
  createPlan,
  updatePlan,
  hardDeletePlan,
  deletePlanPrice,
  listPlanPrices,
  listProviderPrices,
  upsertPlanPrice,
} from "../repositories/billingPlans.repository.js";
import { probeRazorpayCurrencySupport, syncPlanToStripe } from "../services/payments.service.js";
import {
  formatMoney,
  getBaseCurrency,
  getCurrencyMeta,
  getFxRates,
  listCurrencies,
  normalizeCurrency,
  toMajorUnits,
  toMinorUnits,
} from "../services/currency.service.js";
import {
  getProviderCurrencies,
  refreshPriceBook,
  resolveCatalogPrices,
} from "../services/billingPricing.service.js";

const router = express.Router();
router.use(requireSuperadmin);

/** Plan prices are entered and returned in major units of the base currency. */
function decoratePlan(plan) {
  const currency = normalizeCurrency(plan.base_currency) || getBaseCurrency();
  return {
    ...plan,
    base_currency: currency.toUpperCase(),
    currency_symbol: getCurrencyMeta(currency)?.symbol || null,
    price_monthly: toMajorUnits(plan.price_monthly_minor, currency),
    price_yearly: toMajorUnits(plan.price_yearly_minor, currency),
    price_monthly_display: formatMoney(plan.price_monthly_minor, currency),
    price_yearly_display: formatMoney(plan.price_yearly_minor, currency),
  };
}

/**
 * GET /superadmin/plans
 * List all plans (including inactive for superadmin)
 */
router.get("/", async (_req, res) => {
  try {
    const plans = await listPlans({ includeInactive: true });
    return res.json(plans.map(decoratePlan));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /superadmin/plans/currencies
 * Currency registry plus what each payment provider can actually settle.
 */
router.get("/currencies", async (_req, res) => {
  try {
    const fx = await getFxRates();
    return res.json({
      base: getBaseCurrency().toUpperCase(),
      currencies: listCurrencies(),
      providers: {
        stripe: getProviderCurrencies("stripe").map((c) => c.toUpperCase()),
        razorpay: getProviderCurrencies("razorpay").map((c) => c.toUpperCase()),
      },
      fx: { source: fx.source, fetchedAt: fx.fetchedAt, stale: fx.stale, rates: fx.rates },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /superadmin/plans/refresh-price-book
 * Republish every FX-derived local price at today's rates. Manual prices are
 * left untouched unless includeManual is set.
 *
 * Body: { currencies?: string[], includeManual?: boolean }
 */
router.post("/refresh-price-book", async (req, res) => {
  try {
    const plans = await listPlans({ includeInactive: false });
    const result = await refreshPriceBook(plans, {
      currencies: Array.isArray(req.body?.currencies) ? req.body.currencies : null,
      includeManual: !!req.body?.includeManual,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * GET /superadmin/plans/razorpay/currency-support
 * Probes the live Razorpay account by creating throwaway Orders — the only
 * reliable way to tell whether International Payments is enabled.
 */
router.get("/razorpay/currency-support", async (req, res) => {
  try {
    const requested = String(req.query.currencies || "")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);
    const result = await probeRazorpayCurrencySupport(requested);
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

/**
 * GET /superadmin/plans/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const [priceBook, providerPrices] = await Promise.all([
      listPlanPrices(plan.id),
      listProviderPrices(plan.id),
    ]);

    return res.json({
      ...decoratePlan(plan),
      price_book: priceBook.map((row) => ({
        ...row,
        price_monthly: toMajorUnits(row.price_monthly_minor, row.currency),
        price_yearly: toMajorUnits(row.price_yearly_minor, row.currency),
        price_monthly_display: formatMoney(row.price_monthly_minor, row.currency),
        price_yearly_display: formatMoney(row.price_yearly_minor, row.currency),
      })),
      provider_prices: providerPrices,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /superadmin/plans/:id/prices
 * Published local prices for this plan.
 */
router.get("/:id/prices", async (req, res) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const prices = await listPlanPrices(plan.id);
    return res.json(
      prices.map((row) => ({
        ...row,
        price_monthly: toMajorUnits(row.price_monthly_minor, row.currency),
        price_yearly: toMajorUnits(row.price_yearly_minor, row.currency),
        price_monthly_display: formatMoney(row.price_monthly_minor, row.currency),
        price_yearly_display: formatMoney(row.price_yearly_minor, row.currency),
      }))
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /superadmin/plans/:id/prices/:currency
 * Pin an exact local price (a "€18", not a converted "€18.42"). Manual prices
 * survive every price-book refresh.
 *
 * Body: { price_monthly: number, price_yearly: number }  — major units
 */
router.put("/:id/prices/:currency", async (req, res) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const currency = normalizeCurrency(req.params.currency);
    if (!currency) return res.status(400).json({ error: `Unsupported currency: ${req.params.currency}` });

    const monthly = Number(req.body?.price_monthly);
    const yearly = Number(req.body?.price_yearly);
    if (!Number.isFinite(monthly) || !Number.isFinite(yearly) || monthly < 0 || yearly < 0) {
      return res.status(400).json({ error: "price_monthly and price_yearly must be non-negative numbers" });
    }

    const saved = await upsertPlanPrice({
      planId: plan.id,
      currency,
      price_monthly_minor: toMinorUnits(monthly, currency),
      price_yearly_minor: toMinorUnits(yearly, currency),
      source: "manual",
    });

    return res.json({
      ...saved,
      price_monthly: toMajorUnits(saved.price_monthly_minor, currency),
      price_yearly: toMajorUnits(saved.price_yearly_minor, currency),
      price_monthly_display: formatMoney(saved.price_monthly_minor, currency),
      price_yearly_display: formatMoney(saved.price_yearly_minor, currency),
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * DELETE /superadmin/plans/:id/prices/:currency
 * Drop a pinned price so the currency reverts to FX-derived pricing.
 */
router.delete("/:id/prices/:currency", async (req, res) => {
  try {
    const currency = normalizeCurrency(req.params.currency);
    if (!currency) return res.status(400).json({ error: `Unsupported currency: ${req.params.currency}` });
    await deletePlanPrice(req.params.id, currency);
    return res.json({ success: true });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * GET /superadmin/plans/:id/preview?currencies=EUR,GBP,INR
 * What customers in each currency would be shown, without publishing anything.
 */
router.get("/:id/preview", async (req, res) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const requested = String(req.query.currencies || "")
      .split(",")
      .map((code) => normalizeCurrency(code))
      .filter(Boolean);
    const currencies = requested.length ? requested : ["usd", "eur", "gbp", "inr", "jpy", "aud"];

    const preview = [];
    for (const currency of currencies) {
      const prices = await resolveCatalogPrices([plan], currency, { persist: false });
      const price = prices.get(plan.id);
      preview.push({
        currency: currency.toUpperCase(),
        source: price.source,
        fx_rate: price.fx_rate,
        price_monthly_minor: price.price_monthly_minor,
        price_yearly_minor: price.price_yearly_minor,
        price_monthly_display: formatMoney(price.price_monthly_minor, currency),
        price_yearly_display: formatMoney(price.price_yearly_minor, currency),
      });
    }

    return res.json({ plan: decoratePlan(plan), preview });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /superadmin/plans
 * Create a new plan
 */
router.post("/", async (req, res) => {
  try {
    const {
      name, slug, tagline, description,
      price_monthly, price_yearly, base_currency, yearly_discount_pct,
      member_limit, max_projects, max_integrations, storage_limit_gb,
      features, support_level, trial_days, grace_period_days,
      is_active, is_popular, is_custom, display_order,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: "name and slug are required" });
    }

    const currency = normalizeCurrency(base_currency) || getBaseCurrency();

    // Prices arrive in major units of the base currency (dollars) and are
    // stored in minor units (cents).
    const plan = await createPlan({
      name:                 String(name).trim(),
      slug:                 String(slug).toLowerCase().trim(),
      tagline:              tagline || null,
      description:          description || null,
      base_currency:        currency,
      price_monthly_minor:  toMinorUnits(price_monthly, currency),
      price_yearly_minor:   toMinorUnits(price_yearly, currency),
      yearly_discount_pct:  Number(yearly_discount_pct) || 0,
      member_limit:         member_limit ? Number(member_limit) : null,
      max_projects:         max_projects ? Number(max_projects) : null,
      max_integrations:     max_integrations ? Number(max_integrations) : null,
      storage_limit_gb:     storage_limit_gb ? Number(storage_limit_gb) : null,
      features:             Array.isArray(features) ? features : [],
      support_level:        support_level || "community",
      trial_days:           trial_days === undefined ? 7 : (Number(trial_days) || 0),
      grace_period_days:    grace_period_days === undefined ? 3 : (Number(grace_period_days) || 0),
      is_active:            is_active === undefined ? true : Boolean(is_active),
      is_popular:           Boolean(is_popular),
      is_custom:            Boolean(is_custom),
      display_order:        Number(display_order) || 0,
    });

    return res.status(201).json(decoratePlan(plan));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /superadmin/plans/:id
 * Update a plan (name, price, features, limits, etc.)
 */
router.put("/:id", async (req, res) => {
  try {
    const body = req.body;
    const data = {};
    const existing = await getPlanById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Plan not found" });

    const currency = normalizeCurrency(body.base_currency) || normalizeCurrency(existing.base_currency) || getBaseCurrency();

    if (body.name            !== undefined) data.name              = String(body.name).trim();
    if (body.tagline         !== undefined) data.tagline           = body.tagline;
    if (body.description     !== undefined) data.description       = body.description;
    if (body.base_currency   !== undefined) data.base_currency     = currency;
    if (body.price_monthly   !== undefined) data.price_monthly_minor = toMinorUnits(body.price_monthly, currency);
    if (body.price_yearly    !== undefined) data.price_yearly_minor  = toMinorUnits(body.price_yearly,  currency);
    if (body.yearly_discount_pct !== undefined) data.yearly_discount_pct = Number(body.yearly_discount_pct);
    if (body.member_limit    !== undefined) data.member_limit      = body.member_limit ? Number(body.member_limit) : null;
    if (body.max_projects    !== undefined) data.max_projects       = body.max_projects ? Number(body.max_projects) : null;
    if (body.max_integrations !== undefined) data.max_integrations  = body.max_integrations ? Number(body.max_integrations) : null;
    if (body.storage_limit_gb !== undefined) data.storage_limit_gb  = body.storage_limit_gb ? Number(body.storage_limit_gb) : null;
    if (body.features        !== undefined) data.features          = body.features;
    if (body.support_level   !== undefined) data.support_level     = body.support_level;
    if (body.trial_days      !== undefined) data.trial_days        = Number(body.trial_days);
    if (body.grace_period_days !== undefined) data.grace_period_days = Number(body.grace_period_days);
    if (body.is_active       !== undefined) data.is_active         = Boolean(body.is_active);
    if (body.is_popular      !== undefined) data.is_popular        = Boolean(body.is_popular);
    if (body.is_custom       !== undefined) data.is_custom         = Boolean(body.is_custom);
    if (body.display_order   !== undefined) data.display_order     = Number(body.display_order);

    const monthlyPriceChanged =
      data.price_monthly_minor !== undefined &&
      data.price_monthly_minor !== Number(existing.price_monthly_minor || 0);
    const yearlyPriceChanged =
      data.price_yearly_minor !== undefined &&
      data.price_yearly_minor !== Number(existing.price_yearly_minor || 0);
    const currencyChanged =
      data.base_currency !== undefined && data.base_currency !== existing.base_currency;

    // Provider prices are immutable. Existing subscriptions keep their old
    // provider plan; the next checkout lazily creates one at the new price.
    // Repricing the base also invalidates every FX-derived local price.
    const updated = await updatePlan(req.params.id, data, {
      resetProviderPrices: monthlyPriceChanged || yearlyPriceChanged || currencyChanged,
    });
    return res.json(decoratePlan(updated));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /superadmin/plans/:id
 * Hard-delete if no workspaces are on this plan; error if in use.
 */
router.delete("/:id", async (req, res) => {
  try {
    await hardDeletePlan(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * POST /superadmin/plans/:id/sync-stripe
 * Link this plan to Stripe Price IDs created in the Stripe Dashboard.
 * Must be called once before workspaces can subscribe to this plan.
 *
 * Body: {
 *   monthlyPriceId?: string  — e.g. "price_1OAbc123..."
 *   yearlyPriceId?:  string  — e.g. "price_1OAbc456..."
 *   productId?:      string  — e.g. "prod_1OAbc..."
 *   currency?:       string  — ISO 4217, e.g. "usd" or "inr" (default "usd")
 * }
 *
 * To get these IDs: Stripe Dashboard → Products → create a product with
 * monthly and yearly recurring prices, then copy the price IDs here.
 */
router.post("/:id/sync-stripe", async (req, res) => {
  try {
    const {
      monthlyPriceId,
      yearlyPriceId,
      productId,
      currency,
      createMissing,
      replaceExisting,
    } = req.body;
    const updated = await syncPlanToStripe(req.params.id, {
      monthlyPriceId,
      yearlyPriceId,
      productId,
      currency,
      createMissing,
      replaceExisting,
    });
    return res.json({
      success:                  true,
      stripe_product_id:        updated.stripe_product_id,
      stripe_price_monthly_id:  updated.stripe_price_monthly_id,
      stripe_price_yearly_id:   updated.stripe_price_yearly_id,
      stripe_currency:          updated.stripe_currency,
      stripe_sync:              updated.stripe_sync,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

export default router;
