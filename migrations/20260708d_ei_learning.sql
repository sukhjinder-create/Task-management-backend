-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Wave C: Learning proposals + governance reviews
--  Additive & idempotent. Append-only. Proposals never mutate config; reviews are
--  immutable decision rows (nothing auto-publishes). NOT executed by this phase.
--  Rollback: DROP TABLE IF EXISTS ei_learning_reviews; DROP TABLE IF EXISTS ei_learning_proposals;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_learning_proposals (
  id                  BIGSERIAL PRIMARY KEY,
  proposal_id         TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL,
  kind                TEXT NOT NULL,
  target              TEXT NOT NULL,             -- existing declared config key this would change
  current_value_json  JSONB,
  proposed_value_json JSONB,
  rationale_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,  -- verified outcomes/predictions/recommendations
  evidence_json       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- sampleSize/uplift/holdout/counterfactual
  cleanliness_json    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- confounded? reason?
  admissible          BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL,             -- candidate | blocked_confounded
  version             INTEGER NOT NULL DEFAULT 1,
  provenance_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_lp_ws ON ei_learning_proposals (workspace_id, status);

CREATE TABLE IF NOT EXISTS ei_learning_reviews (
  id            BIGSERIAL PRIMARY KEY,
  decision_id   TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  decision      TEXT NOT NULL,                   -- approved | rejected | deferred
  reviewer_json JSONB,
  note          TEXT,
  decided_at    TIMESTAMPTZ NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_lr_proposal ON ei_learning_reviews (workspace_id, proposal_id, decided_at);
