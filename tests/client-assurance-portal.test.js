import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  authenticatePortalSession,
  hashPortalToken,
  listPortalCommitments,
  normalizeClientAssignmentInput,
  normalizeClientDecision,
  normalizeClientEmail,
} from "../services/clientPortal.service.js";
import { buildAssuranceAttention, calculateAssuranceState } from "../services/executionAssurance.service.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = new Date("2026-09-02T10:00:00.000Z");

function completedClientOutcome(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Launch the customer portal",
    status: "done",
    progress: 100,
    target_date: "2026-10-31",
    task_count: 3,
    completed_task_count: 3,
    evidence_count: 1,
    result_evidence_count: 1,
    is_client_facing: true,
    ...overrides,
  };
}

test("client acceptance extends completion without changing existing verification", () => {
  const ready = completedClientOutcome();
  assert.equal(calculateAssuranceState(ready, NOW).state, "awaiting_client_acceptance");
  assert.equal(calculateAssuranceState({ ...ready, client_review_status: "pending" }, NOW).state, "awaiting_client_acceptance");
  assert.equal(calculateAssuranceState({ ...ready, client_review_status: "changes_requested" }, NOW).state, "client_changes_requested");
  assert.equal(calculateAssuranceState({ ...ready, client_review_status: "accepted" }, NOW).state, "verified");
  assert.equal(calculateAssuranceState({ ...ready, is_client_facing: false }, NOW).state, "verified");

  const unsent = { ...ready, assurance: calculateAssuranceState(ready, NOW) };
  assert.equal(buildAssuranceAttention(unsent).action, "request_client_acceptance");
  const pending = { ...ready, client_review_status: "pending" };
  pending.assurance = calculateAssuranceState(pending, NOW);
  assert.equal(buildAssuranceAttention(pending), null);
});

test("client identities and decisions are normalized at the trust boundary", () => {
  assert.equal(normalizeClientEmail("  Buyer@Example.COM "), "buyer@example.com");
  assert.throws(() => normalizeClientEmail("not-an-email"), /not valid/);
  assert.deepEqual(normalizeClientAssignmentInput({}), {
    isClientFacing: false,
    clientId: null,
    contactId: null,
  });
  assert.throws(
    () => normalizeClientAssignmentInput({ isClientFacing: "false" }),
    /must be true or false/
  );
  const assignment = normalizeClientAssignmentInput({
    isClientFacing: true,
    clientName: "Acme",
    clientApproverName: "Jordan Lee",
    clientApproverEmail: "JORDAN@ACME.COM",
  });
  assert.equal(assignment.contactEmail, "jordan@acme.com");
  assert.equal(normalizeClientDecision({ decision: "accepted" }).decision, "accepted");
  assert.throws(() => normalizeClientDecision({ decision: "changes_requested" }), /Change request is required/);
  assert.throws(() => normalizeClientDecision({ decision: "maybe" }), /Choose accept/);
});

test("portal credentials are deterministic digests but never the raw token", () => {
  const token = "a".repeat(43);
  const digest = hashPortalToken(token);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, token);
  assert.equal(hashPortalToken(token), digest);
  assert.notEqual(hashPortalToken(`${token}b`), digest);
});

test("missing or malformed portal session credentials use the authentication boundary", async () => {
  await assert.rejects(
    authenticatePortalSession({ token: "bad" }),
    (error) => error.statusCode === 401 && error.code === "CLIENT_PORTAL_SESSION_INVALID"
  );
});

test("portal responses expose only the client-safe outcome contract", async () => {
  const database = {
    async query(sql, values) {
      assert.match(sql, /o\.workspace_id=\$1 AND o\.client_id=\$2 AND o\.is_client_facing=TRUE/);
      assert.deepEqual(values, ["workspace-1", "client-1"]);
      return { rows: [{
        id: "goal-1",
        title: "Production launch",
        success_measure: "Client users can activate",
        target_date: "2026-10-31",
        project_name: "Portal",
        outcome_status: "done",
        progress: 100,
        review_id: "review-1",
        review_status: "pending",
        review_contact_id: "contact-1",
        snapshot: { resultSummary: "Activation verified", message: "Please review" },
        requested_at: NOW.toISOString(),
        task_count: 99,
        internal_score: 12,
      }] };
    },
  };
  const result = await listPortalCommitments({
    session: {
      workspace_id: "workspace-1",
      client_id: "client-1",
      contact_id: "contact-1",
      contact_name: "Jordan",
      client_name: "Acme",
      workspace_name: "Delivery Co",
      workspace_slug: "delivery-co",
    },
    database,
  });
  assert.equal(result.commitments[0].review.canDecide, true);
  assert.equal(result.commitments[0].review.resultSummary, "Activation verified");
  assert.equal(Object.hasOwn(result.commitments[0], "task_count"), false);
  assert.equal(Object.hasOwn(result.commitments[0], "internal_score"), false);
});

test("schema enforces tenant ownership, RLS, immutable snapshots, and digest-only credentials", () => {
  const sql = read("migrations/20260902_client_assurance_portal.sql");
  for (const table of [
    "assurance_clients",
    "assurance_client_contacts",
    "assurance_client_reviews",
    "client_portal_magic_links",
    "client_portal_sessions",
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /FOREIGN KEY \(workspace_id, client_id, goal_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, client_id, contact_id\)/);
  assert.match(sql, /token_hash CHAR\(64\) NOT NULL UNIQUE/g);
  assert.match(sql, /snapshot JSONB NOT NULL/);
  assert.match(sql, /is_client_facing BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.doesNotMatch(sql, /\btoken\s+(?:TEXT|VARCHAR)\b/i);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test("public portal and internal review routes keep separate authentication boundaries", () => {
  const index = read("index.js");
  const publicRoute = index.indexOf('app.use("/client-portal", clientPortalRoutes)');
  const globalAuth = index.indexOf("app.use(authMiddleware, requireWorkspaceForUser, reportsRouter)");
  assert.ok(publicRoute >= 0 && publicRoute < globalAuth);

  const portalRoutes = read("routes/clientPortal.routes.js");
  assert.match(portalRoutes, /router\.use\(requireClientSession\)/);
  assert.match(portalRoutes, /clientPortalAccessLimiter/);
  assert.match(portalRoutes, /\/reviews\/:id\/decision/);

  const assuranceRoutes = read("routes/assurance.routes.js");
  assert.match(assuranceRoutes, /commitments\/:id\/client-review", allowRoles\("manager", "admin"\)/);
  assert.match(assuranceRoutes, /clients\/:clientId\/contacts\/:contactId", allowRoles\("admin"\)/);
});

test("one-time exchange, revocation, deployment, recovery, and UI are wired end to end", () => {
  const service = read("services/clientPortal.service.js");
  const assurance = read("services/executionAssurance.service.js");
  assert.match(service, /used_at IS NULL AND revoked_at IS NULL AND expires_at>\$2/);
  assert.match(service, /status='cancelled'.*contact_id=\$2.*status='pending'/s);
  assert.match(service, /FOR UPDATE OF o, c, contact/);
  assert.match(service, /CLIENT_REVISED_EVIDENCE_REQUIRED/);
  assert.ok((assurance.match(/lockMutableCommitment\(client, workspaceId, id\)/g) || []).length >= 4);

  const frontend = read("../Task-management/src/pages/ClientPortal.jsx");
  assert.match(frontend, /sessionStorage\.setItem/);
  assert.match(frontend, /Internal tasks, team data, scores, and evidence history stay private/);
  assert.match(read("../Task-management/src/App.jsx"), /path="\/client-portal\/access"/);

  const recovery = read("backup/workspaceRecovery.service.js");
  for (const table of ["assurance_clients", "assurance_client_contacts", "goal_assurance_evidence", "assurance_client_reviews"]) {
    assert.match(recovery, new RegExp(`table: "${table}"`));
  }
  assert.doesNotMatch(recovery, /table: "client_portal_(?:magic_links|sessions)"/);

  const workflow = read(".github/workflows/deploy-selfhosted.yml");
  const migration = workflow.indexOf("20260902_client_assurance_portal.sql");
  const verified = workflow.indexOf("client assurance portal migration verified");
  const imagePull = workflow.indexOf('echo "pulling $IMAGE_REF');
  assert.ok(migration >= 0 && verified > migration && imagePull > verified);
});
