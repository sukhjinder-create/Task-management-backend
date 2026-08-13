import test, { after } from "node:test";
import assert from "node:assert/strict";
import db from "../db.js";
import {
  SELF_SERVE_TRIAL_DAYS,
  assertWorkspaceTrialAllowsPaymentSetup,
  buildNoCardTrialMetadata,
  describeTrialLifecycle,
  getProviderTrialDays,
  getTrialIntent,
  reconcileExpiredWorkspaceTrial,
  trialEndFrom,
} from "../services/trialLifecycle.service.js";

const START = new Date("2026-08-13T10:00:00.000Z");

after(async () => {
  await db.end();
});

function noCardMetadata() {
  return buildNoCardTrialMetadata({
    metadata: { retained: true },
    selectedPlan: { id: "plan-pro", slug: "pro", name: "Pro" },
    interval: "yearly",
    currency: "INR",
  });
}

function fakeDatabase(workspace, fallbackPlan = {
  id: "plan-starter",
  slug: "starter",
  name: "Starter",
  member_limit: 10,
}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ statement, params });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
      if (statement.startsWith("SELECT * FROM workspaces")) return { rows: [workspace] };
      if (statement.startsWith("SELECT slug, name, member_limit FROM billing_plans")) {
        return { rows: fallbackPlan ? [fallbackPlan] : [] };
      }
      if (statement.startsWith("UPDATE workspaces")) {
        return {
          rows: [{
            ...workspace,
            billing_plan: fallbackPlan.slug,
            plan: fallbackPlan.slug,
            billing_status: "active",
            member_limit: fallbackPlan.member_limit,
            max_members: fallbackPlan.member_limit,
          }],
        };
      }
      if (statement.startsWith("UPDATE workspace_users")) return { rows: [], rowCount: 2 };
      throw new Error(`Unexpected test query: ${statement}`);
    },
    release() {},
  };

  return {
    queries,
    async connect() { return client; },
  };
}

test("no-card trial metadata preserves intent without storing payment data", () => {
  const metadata = noCardMetadata();
  const intent = getTrialIntent({ metadata });

  assert.equal(metadata.retained, true);
  assert.deepEqual(intent, {
    selectedPlanId: "plan-pro",
    selectedPlanSlug: "pro",
    selectedPlanName: "Pro",
    billingInterval: "yearly",
    currency: "inr",
    durationDays: SELF_SERVE_TRIAL_DAYS,
    startedWithoutPayment: true,
  });
  assert.equal(JSON.stringify(metadata).includes("card"), false);
});

test("self-serve trial ends exactly seven days after workspace creation", () => {
  assert.equal(
    trialEndFrom(START).toISOString(),
    "2026-08-20T10:00:00.000Z"
  );
});

test("active trials keep full access and defer payment setup", () => {
  const workspace = {
    trial_ends_at: "2026-08-20T10:00:00.000Z",
    billing_plan: null,
    plan: null,
    metadata: noCardMetadata(),
  };
  const state = describeTrialLifecycle(workspace, START);

  assert.equal(state.onTrial, true);
  assert.equal(state.trialCompleted, false);
  assert.equal(state.paymentSetupRequired, false);
  assert.throws(
    () => assertWorkspaceTrialAllowsPaymentSetup(workspace, START),
    (error) => error.code === "TRIAL_STILL_ACTIVE" && error.statusCode === 409
  );
});

test("a consumed workspace trial never creates a second provider trial", () => {
  assert.equal(
    getProviderTrialDays({ trial_ends_at: "2026-08-20T10:00:00.000Z" }, { trial_days: 30 }),
    0
  );
  assert.equal(getProviderTrialDays({}, { trial_days: 30 }), 30);
});

test("expired no-card trial is downgraded idempotently to Starter", async () => {
  const workspace = {
    id: "workspace-1",
    trial_ends_at: "2026-08-12T10:00:00.000Z",
    billing_plan: null,
    plan: null,
    metadata: noCardMetadata(),
  };
  const database = fakeDatabase(workspace);

  const result = await reconcileExpiredWorkspaceTrial(workspace.id, {
    database,
    now: START,
  });

  assert.equal(result.downgraded, true);
  assert.equal(result.workspace.billing_plan, "starter");
  assert.equal(result.workspace.member_limit, 10);
  assert.equal(result.state.paymentSetupRequired, true);
  assert.equal(result.state.trialDowngraded, true);
  assert.ok(database.queries.some(({ statement }) => statement.startsWith("UPDATE workspace_users")));
  assert.equal(database.queries.at(-1).statement, "COMMIT");
});

test("reconciliation leaves active trials unchanged", async () => {
  const workspace = {
    id: "workspace-2",
    trial_ends_at: "2026-08-20T10:00:00.000Z",
    billing_plan: null,
    plan: null,
    metadata: noCardMetadata(),
  };
  const database = fakeDatabase(workspace);

  const result = await reconcileExpiredWorkspaceTrial(workspace.id, {
    database,
    now: START,
  });

  assert.equal(result.downgraded, false);
  assert.equal(database.queries.some(({ statement }) => statement.startsWith("UPDATE workspaces")), false);
  assert.equal(database.queries.at(-1).statement, "COMMIT");
});
