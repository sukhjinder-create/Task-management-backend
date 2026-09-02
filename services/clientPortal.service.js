import crypto from "crypto";
import pool from "../db.js";
import { getFrontendBaseUrl } from "../config/environment.js";
import { sendClientPortalAccessEmail } from "./email.service.js";
import { logAudit } from "./audit.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_LINK_MINUTES = 20;
const SESSION_DAYS = 7;

function httpError(message, statusCode = 400, code = "CLIENT_PORTAL_INVALID_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, maxLength, { required = false, label = "Value" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw httpError(`${label} is required`);
  if (text.length > maxLength) throw httpError(`${label} must be ${maxLength} characters or fewer`);
  return text || null;
}

function uuidValue(value, label) {
  const id = cleanText(value, 100, { required: true, label });
  if (!UUID.test(id)) throw httpError(`${label} is not valid`);
  return id;
}

export function normalizeClientEmail(value) {
  const email = cleanText(value, 320, { required: true, label: "Client email" })?.toLowerCase();
  if (!EMAIL.test(email)) throw httpError("Client email is not valid");
  return email;
}

export function hashPortalToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function futureIso(now, milliseconds) {
  return new Date(now.getTime() + milliseconds).toISOString();
}

async function transaction(database, work) {
  const client = typeof database.connect === "function" ? await database.connect() : database;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== database) client.release();
  }
}

export function normalizeClientAssignmentInput(input = {}) {
  const rawClientFacing = input.isClientFacing ?? input.is_client_facing ?? false;
  if (typeof rawClientFacing !== "boolean") throw httpError("Client-facing setting must be true or false");
  const isClientFacing = rawClientFacing;
  if (!isClientFacing) return { isClientFacing: false, clientId: null, contactId: null };

  const clientId = cleanText(input.clientId ?? input.client_id, 100);
  const contactId = cleanText(
    input.clientApproverContactId ?? input.client_approver_contact_id ?? input.contactId,
    100
  );
  if ((clientId && !UUID.test(clientId)) || (contactId && !UUID.test(contactId))) {
    throw httpError("Client selection is not valid");
  }
  if (clientId && contactId) return { isClientFacing, clientId, contactId };

  return {
    isClientFacing,
    clientId: clientId || null,
    contactId: null,
    clientName: cleanText(input.clientName ?? input.client_name, 200, { required: !clientId, label: "Client company" }),
    contactName: cleanText(input.clientApproverName ?? input.client_approver_name, 200, { required: true, label: "Client approver" }),
    contactEmail: normalizeClientEmail(input.clientApproverEmail ?? input.client_approver_email),
  };
}

export async function resolveClientAssignment({ workspaceId, actorId, role, input, database = pool }) {
  const value = normalizeClientAssignmentInput(input);
  if (!value.isClientFacing) return value;

  if (value.clientId && value.contactId) {
    const { rows } = await database.query(
      `SELECT c.id AS client_id, contact.id AS contact_id
       FROM assurance_clients c
       JOIN assurance_client_contacts contact
         ON contact.workspace_id=c.workspace_id AND contact.client_id=c.id
       WHERE c.workspace_id=$1 AND c.id=$2 AND contact.id=$3
         AND c.status='active' AND contact.status='active'
         AND (
           $4='admin'
           OR EXISTS (
             SELECT 1 FROM okr_objectives o
             LEFT JOIN users actor ON actor.id=$5 AND actor.workspace_id=o.workspace_id
             WHERE o.workspace_id=c.workspace_id AND o.client_id=c.id
               AND (
                 o.owner_id=$5
                 OR o.primary_project_id=ANY(COALESCE(actor.projects, ARRAY[]::uuid[]))
                 OR EXISTS (
                   SELECT 1 FROM okr_sprint_links link
                   JOIN sprints sprint ON sprint.id=link.sprint_id AND sprint.workspace_id=o.workspace_id
                   WHERE link.objective_id=o.id
                     AND sprint.project_id=ANY(COALESCE(actor.projects, ARRAY[]::uuid[]))
                 )
               )
           )
         )
       LIMIT 1`,
      [workspaceId, value.clientId, value.contactId, String(role || "manager").toLowerCase(), actorId]
    );
    if (!rows[0]) throw httpError("The selected client approver is unavailable", 409, "CLIENT_APPROVER_UNAVAILABLE");
    return { isClientFacing: true, clientId: rows[0].client_id, contactId: rows[0].contact_id };
  }

  let clientId = value.clientId;
  if (clientId) {
    const directory = await getClientDirectory({ workspaceId, userId: actorId, role, database });
    if (!directory.clients.some((client) => client.id === clientId && client.status === "active")) {
      throw httpError("The selected client is unavailable", 409, "CLIENT_UNAVAILABLE");
    }
  } else {
    const reusable = await database.query(
      `SELECT c.id AS client_id, contact.id AS contact_id
       FROM assurance_client_contacts contact
       JOIN assurance_clients c
         ON c.workspace_id=contact.workspace_id AND c.id=contact.client_id AND c.status='active'
       WHERE contact.workspace_id=$1 AND contact.email=$2 AND contact.status='active'
         AND NOT EXISTS (
           SELECT 1 FROM okr_objectives o
           WHERE o.workspace_id=c.workspace_id AND o.client_id=c.id AND o.is_client_facing=TRUE
         )
       FOR UPDATE OF c, contact
       LIMIT 1`,
      [workspaceId, value.contactEmail]
    );
    if (reusable.rows[0]) {
      await database.query(
        "UPDATE assurance_clients SET name=$1, updated_at=NOW() WHERE workspace_id=$2 AND id=$3",
        [value.clientName, workspaceId, reusable.rows[0].client_id]
      );
      await database.query(
        "UPDATE assurance_client_contacts SET name=$1, updated_at=NOW() WHERE workspace_id=$2 AND id=$3",
        [value.contactName, workspaceId, reusable.rows[0].contact_id]
      );
      return { isClientFacing: true, clientId: reusable.rows[0].client_id, contactId: reusable.rows[0].contact_id };
    }
    const client = await database.query(
      `INSERT INTO assurance_clients (workspace_id, name, created_by)
       VALUES ($1,$2,$3)
       RETURNING id`,
      [workspaceId, value.clientName, actorId]
    );
    clientId = client.rows[0].id;
  }

  const contact = await database.query(
    `INSERT INTO assurance_client_contacts
       (workspace_id, client_id, name, email, invited_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       name=EXCLUDED.name, updated_at=NOW()
     WHERE assurance_client_contacts.client_id=EXCLUDED.client_id
       AND assurance_client_contacts.status='active'
     RETURNING id`,
    [workspaceId, clientId, value.contactName, value.contactEmail, actorId]
  );
  if (!contact.rows[0]) {
    throw httpError(
      "That email is already assigned to another client or its access was revoked",
      409,
      "CLIENT_EMAIL_UNAVAILABLE"
    );
  }
  return { isClientFacing: true, clientId, contactId: contact.rows[0].id };
}

export async function getClientDirectory({ workspaceId, userId = null, role = "admin", database = pool }) {
  const { rows } = await database.query(
    `SELECT c.id, c.name, c.status, c.created_at, c.updated_at,
            COALESCE(outcomes.outcome_count, 0)::int AS outcome_count,
            COALESCE(contacts.items, '[]'::json) AS contacts
     FROM assurance_clients c
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS outcome_count
       FROM okr_objectives o
       WHERE o.workspace_id=c.workspace_id AND o.client_id=c.id AND o.is_client_facing=TRUE
     ) outcomes ON TRUE
     LEFT JOIN LATERAL (
       SELECT JSON_AGG(json_build_object(
         'id', contact.id,
         'name', contact.name,
         'email', contact.email,
         'status', contact.status,
         'lastAccessedAt', contact.last_accessed_at,
         'createdAt', contact.created_at
       ) ORDER BY contact.name) AS items
       FROM assurance_client_contacts contact
       WHERE contact.workspace_id=c.workspace_id AND contact.client_id=c.id
     ) contacts ON TRUE
     WHERE c.workspace_id=$1
       AND (
         $3='admin'
         OR EXISTS (
           SELECT 1 FROM okr_objectives visible
           LEFT JOIN users actor ON actor.id=$2 AND actor.workspace_id=visible.workspace_id
           WHERE visible.workspace_id=c.workspace_id AND visible.client_id=c.id
             AND (
               visible.owner_id=$2
               OR visible.primary_project_id=ANY(COALESCE(actor.projects, ARRAY[]::uuid[]))
               OR EXISTS (
                 SELECT 1 FROM okr_sprint_links link
                 JOIN sprints sprint ON sprint.id=link.sprint_id AND sprint.workspace_id=visible.workspace_id
                 WHERE link.objective_id=visible.id
                   AND sprint.project_id=ANY(COALESCE(actor.projects, ARRAY[]::uuid[]))
               )
             )
         )
       )
     ORDER BY c.status, c.name`,
    [workspaceId, userId, String(role || "manager").toLowerCase()]
  );
  return { clients: rows };
}

export async function setClientContactStatus({
  workspaceId,
  clientId,
  contactId,
  actorId,
  status,
  database = pool,
}) {
  const validatedClientId = uuidValue(clientId, "Client");
  const validatedContactId = uuidValue(contactId, "Client contact");
  const normalizedStatus = String(status || "").toLowerCase();
  if (!new Set(["active", "revoked"]).has(normalizedStatus)) throw httpError("Client contact status is not valid");

  const contact = await transaction(database, async (client) => {
    const updated = await client.query(
      `UPDATE assurance_client_contacts SET status=$1, updated_at=NOW()
       WHERE workspace_id=$2 AND client_id=$3 AND id=$4
       RETURNING id, client_id, name, email, status`,
      [normalizedStatus, workspaceId, validatedClientId, validatedContactId]
    );
    if (!updated.rows[0]) throw httpError("Client contact not found", 404, "CLIENT_CONTACT_NOT_FOUND");
    if (normalizedStatus === "revoked") {
      await Promise.all([
        client.query(
          "UPDATE client_portal_magic_links SET revoked_at=COALESCE(revoked_at,NOW()) WHERE workspace_id=$1 AND contact_id=$2 AND used_at IS NULL",
          [workspaceId, validatedContactId]
        ),
        client.query(
          "UPDATE client_portal_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL",
          [workspaceId, validatedContactId]
        ),
        client.query(
          "UPDATE assurance_client_reviews SET status='cancelled', updated_at=NOW() WHERE workspace_id=$1 AND contact_id=$2 AND status='pending'",
          [workspaceId, validatedContactId]
        ),
      ]);
    }
    return updated.rows[0];
  });

  await logAudit({
    workspaceId,
    userId: actorId,
    action: normalizedStatus === "revoked" ? "assurance.client_access.revoke" : "assurance.client_access.restore",
    entityType: "client_contact",
    entityId: contact.id,
    newValue: { clientId: contact.client_id, status: contact.status },
  });
  return contact;
}

function buildAccessUrl(token) {
  const url = new URL("/client-portal/access", getFrontendBaseUrl());
  url.searchParams.set("token", token);
  return url.toString();
}

async function issueMagicLink({ workspaceId, contactId, reviewId = null, database, now }) {
  const token = createToken();
  const expiresAt = futureIso(now, MAGIC_LINK_MINUTES * 60_000);
  await database.query(
    `DELETE FROM client_portal_magic_links
     WHERE workspace_id=$1 AND contact_id=$2
       AND (expires_at<$3 OR used_at IS NOT NULL OR revoked_at IS NOT NULL)
       AND created_at < $3::timestamptz - interval '7 days'`,
    [workspaceId, contactId, now.toISOString()]
  );
  await database.query(
    `INSERT INTO client_portal_magic_links
       (workspace_id, contact_id, review_id, token_hash, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [workspaceId, contactId, reviewId, hashPortalToken(token), expiresAt, now.toISOString()]
  );
  return { token, expiresAt };
}

export async function requestClientReview({
  workspaceId,
  actorId,
  commitment,
  input = {},
  database = pool,
  now = new Date(),
}) {
  if (!commitment?.is_client_facing || !commitment.client_id || !commitment.client_approver_contact_id) {
    throw httpError("Choose a client approver before requesting acceptance", 409, "CLIENT_APPROVER_REQUIRED");
  }
  const requestedResultSummary = cleanText(input.resultSummary, 500, { label: "Client result summary" });
  const message = cleanText(input.message, 2000, { label: "Client message" });

  const issued = await transaction(database, async (client) => {
    const context = await client.query(
      `SELECT o.id, o.title, o.success_measure, o.target_date, o.status, o.progress,
              o.client_id, o.client_approver_contact_id,
              p.name AS project_name, w.name AS workspace_name, w.slug AS workspace_slug,
              c.name AS client_name, contact.name AS contact_name, contact.email AS contact_email,
              evidence.result_evidence_count, evidence.latest_result_evidence_label,
              evidence.latest_result_evidence_at
       FROM okr_objectives o
       JOIN workspaces w ON w.id=o.workspace_id
       JOIN assurance_clients c
         ON c.workspace_id=o.workspace_id AND c.id=o.client_id AND c.status='active'
       JOIN assurance_client_contacts contact
         ON contact.workspace_id=o.workspace_id AND contact.client_id=o.client_id
        AND contact.id=o.client_approver_contact_id AND contact.status='active'
       LEFT JOIN projects p ON p.workspace_id=o.workspace_id AND p.id=o.primary_project_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS result_evidence_count,
                (ARRAY_AGG(item.label ORDER BY item.recorded_at DESC))[1] AS latest_result_evidence_label,
                MAX(item.recorded_at) AS latest_result_evidence_at
         FROM goal_assurance_evidence item
         WHERE item.workspace_id=o.workspace_id AND item.goal_id=o.id AND item.evidence_type='result'
       ) evidence ON TRUE
       WHERE o.workspace_id=$1 AND o.id=$2 AND o.is_client_facing=TRUE
         AND COALESCE(w.status, 'active')='active'
       FOR UPDATE OF o, c, contact`,
      [workspaceId, commitment.id]
    );
    if (!context.rows[0]) throw httpError("Client outcome is unavailable", 409, "CLIENT_OUTCOME_UNAVAILABLE");

    const current = context.rows[0];
    const latest = await client.query(
      `SELECT * FROM assurance_client_reviews
       WHERE workspace_id=$1 AND goal_id=$2 AND status<>'cancelled'
       ORDER BY requested_at DESC LIMIT 1
       FOR UPDATE`,
      [workspaceId, commitment.id]
    );
    const latestReview = latest.rows[0];
    if (latestReview?.status === "accepted") {
      throw httpError("The client already accepted this outcome", 409, "CLIENT_REVIEW_ACCEPTED");
    }
    if (
      latestReview?.status === "changes_requested"
      && (!current.latest_result_evidence_at
        || new Date(current.latest_result_evidence_at).getTime() <= new Date(latestReview.decided_at).getTime())
    ) {
      throw httpError("Record revised result evidence before sending the outcome back to the client", 409, "CLIENT_REVISED_EVIDENCE_REQUIRED");
    }
    if (!(current.status === "done" || Number(current.progress) >= 100) || Number(current.result_evidence_count) < 1) {
      throw httpError("Complete the outcome with result evidence before requesting client acceptance", 409, "CLIENT_RESULT_REQUIRED");
    }

    let review = latestReview?.status === "pending" ? latestReview : null;
    if (!review) {
      const resultSummary = cleanText(
        requestedResultSummary ?? current.latest_result_evidence_label,
        500,
        { required: true, label: "Client result summary" }
      );
      const snapshot = {
        schemaVersion: 1,
        title: current.title,
        successMeasure: current.success_measure,
        targetDate: String(current.target_date || "").slice(0, 10) || null,
        projectName: current.project_name || null,
        resultSummary,
        message,
      };
      const inserted = await client.query(
        `INSERT INTO assurance_client_reviews
           (workspace_id, goal_id, client_id, contact_id, snapshot, requested_by, requested_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
         RETURNING *`,
        [workspaceId, commitment.id, current.client_id, current.client_approver_contact_id, JSON.stringify(snapshot), actorId, now.toISOString()]
      );
      review = inserted.rows[0];
    }

    const recentLink = await client.query(
      `SELECT 1 FROM client_portal_magic_links
       WHERE workspace_id=$1 AND review_id=$2
         AND created_at>$3::timestamptz - interval '60 seconds'
       LIMIT 1`,
      [workspaceId, review.id, now.toISOString()]
    );
    if (recentLink.rows[0]) {
      throw httpError("A secure link was sent recently. Wait one minute before sending another.", 429, "CLIENT_REVIEW_RATE_LIMITED");
    }

    await client.query(
      `UPDATE client_portal_magic_links
       SET revoked_at=COALESCE(revoked_at,$3)
       WHERE workspace_id=$1 AND review_id=$2 AND used_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, review.id, now.toISOString()]
    );
    const link = await issueMagicLink({
      workspaceId,
      contactId: current.client_approver_contact_id,
      reviewId: review.id,
      database: client,
      now,
    });
    return { review, context: current, ...link };
  });

  const delivered = await sendClientPortalAccessEmail({
    to: issued.context.contact_email,
    contactName: issued.context.contact_name,
    clientName: issued.context.client_name,
    workspaceName: issued.context.workspace_name,
    accessUrl: buildAccessUrl(issued.token),
    outcomeTitle: issued.review.snapshot?.title || issued.context.title,
  });
  const deliveryError = delivered ? null : "Email delivery failed. Verify SMTP configuration and retry.";
  const updated = await database.query(
    `UPDATE assurance_client_reviews SET
       delivery_status=$1, delivery_error=$2,
       last_delivered_at=CASE WHEN $1='sent' THEN $3 ELSE last_delivered_at END,
       updated_at=$3
     WHERE workspace_id=$4 AND id=$5
     RETURNING *`,
    [delivered ? "sent" : "failed", deliveryError, now.toISOString(), workspaceId, issued.review.id]
  );

  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.client_review.request",
    entityType: "goal",
    entityId: commitment.id,
    newValue: { reviewId: issued.review.id, contactId: issued.context.client_approver_contact_id, delivered },
  });
  return updated.rows[0];
}

export async function cancelClientReview({
  workspaceId,
  actorId,
  commitment,
  database = pool,
  now = new Date(),
}) {
  const review = await transaction(database, async (client) => {
    const updated = await client.query(
      `UPDATE assurance_client_reviews SET status='cancelled', updated_at=$3
       WHERE workspace_id=$1 AND goal_id=$2 AND status='pending'
       RETURNING id`,
      [workspaceId, commitment.id, now.toISOString()]
    );
    if (!updated.rows[0]) throw httpError("There is no pending client review to withdraw", 409, "CLIENT_REVIEW_NOT_PENDING");
    await client.query(
      `UPDATE client_portal_magic_links SET revoked_at=COALESCE(revoked_at,$3)
       WHERE workspace_id=$1 AND review_id=$2 AND used_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, updated.rows[0].id, now.toISOString()]
    );
    return updated.rows[0];
  });
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.client_review.cancel",
    entityType: "goal",
    entityId: commitment.id,
    newValue: { reviewId: review.id },
  });
  return review;
}

export async function requestPortalAccess({
  email,
  ipAddress,
  userAgent,
  database = pool,
  now = new Date(),
}) {
  const normalizedEmail = normalizeClientEmail(email);
  const { rows } = await database.query(
    `SELECT contact.id AS contact_id, contact.name AS contact_name, contact.email,
            contact.workspace_id, c.id AS client_id, c.name AS client_name,
            w.name AS workspace_name, w.slug AS workspace_slug
     FROM assurance_client_contacts contact
     JOIN assurance_clients c
       ON c.workspace_id=contact.workspace_id AND c.id=contact.client_id AND c.status='active'
     JOIN workspaces w ON w.id=contact.workspace_id
     WHERE contact.email=$1 AND contact.status='active'
       AND COALESCE(w.status, 'active')='active'
       AND EXISTS (
         SELECT 1 FROM okr_objectives o
         WHERE o.workspace_id=contact.workspace_id AND o.client_id=contact.client_id
           AND o.is_client_facing=TRUE
       )
     ORDER BY w.name
     LIMIT 10`,
    [normalizedEmail]
  );
  if (!rows.length) return { delivered: false };

  let delivered = false;
  for (const context of rows) {
    const recent = await database.query(
      `SELECT 1 FROM client_portal_magic_links
       WHERE workspace_id=$1 AND contact_id=$2 AND created_at > $3::timestamptz - interval '60 seconds'
       LIMIT 1`,
      [context.workspace_id, context.contact_id, now.toISOString()]
    );
    if (recent.rows[0]) { delivered = true; continue; }

    const issued = await issueMagicLink({
      workspaceId: context.workspace_id,
      contactId: context.contact_id,
      database,
      now,
    });
    const sent = await sendClientPortalAccessEmail({
      to: context.email,
      contactName: context.contact_name,
      clientName: context.client_name,
      workspaceName: context.workspace_name,
      accessUrl: buildAccessUrl(issued.token),
    });
    delivered = sent || delivered;
    await logAudit({
      workspaceId: context.workspace_id,
      action: "assurance.client_portal.access_requested",
      entityType: "client_contact",
      entityId: context.contact_id,
      ipAddress,
      userAgent,
      newValue: { delivered: sent },
      metadata: { actorType: "client_contact", clientId: context.client_id },
    });
  }
  return { delivered };
}

function normalizePortalToken(token) {
  const value = cleanText(token, 200, { required: true, label: "Secure link" });
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(value)) throw httpError("Secure link is invalid or expired", 401, "CLIENT_PORTAL_LINK_INVALID");
  return value;
}

export async function exchangePortalMagicLink({ token, ipAddress, userAgent, database = pool, now = new Date() }) {
  const rawToken = normalizePortalToken(token);
  const result = await transaction(database, async (client) => {
    const consumed = await client.query(
      `UPDATE client_portal_magic_links SET used_at=$2
       WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>$2
       RETURNING workspace_id, contact_id, review_id`,
      [hashPortalToken(rawToken), now.toISOString()]
    );
    const link = consumed.rows[0];
    if (!link) throw httpError("Secure link is invalid or expired", 401, "CLIENT_PORTAL_LINK_INVALID");

    const context = await client.query(
      `SELECT contact.id AS contact_id, contact.name AS contact_name,
              c.id AS client_id, c.name AS client_name,
              w.id AS workspace_id, w.name AS workspace_name, w.slug AS workspace_slug
       FROM assurance_client_contacts contact
       JOIN assurance_clients c
         ON c.workspace_id=contact.workspace_id AND c.id=contact.client_id AND c.status='active'
       JOIN workspaces w ON w.id=contact.workspace_id
       WHERE contact.workspace_id=$1 AND contact.id=$2 AND contact.status='active'
         AND COALESCE(w.status, 'active')='active'
       LIMIT 1`,
      [link.workspace_id, link.contact_id]
    );
    if (!context.rows[0]) throw httpError("Client portal access has been revoked", 403, "CLIENT_PORTAL_REVOKED");

    const sessionToken = createToken();
    const expiresAt = futureIso(now, SESSION_DAYS * 86_400_000);
    await client.query(
      `DELETE FROM client_portal_sessions
       WHERE workspace_id=$1 AND contact_id=$2
         AND (expires_at<$3 OR revoked_at IS NOT NULL)`,
      [link.workspace_id, link.contact_id, now.toISOString()]
    );
    await client.query(
      `INSERT INTO client_portal_sessions
         (workspace_id, contact_id, token_hash, expires_at, last_seen_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$5)`,
      [link.workspace_id, link.contact_id, hashPortalToken(sessionToken), expiresAt, now.toISOString()]
    );
    await client.query(
      "UPDATE assurance_client_contacts SET last_accessed_at=$3 WHERE workspace_id=$1 AND id=$2",
      [link.workspace_id, link.contact_id, now.toISOString()]
    );
    return { sessionToken, expiresAt, focusReviewId: link.review_id || null, context: context.rows[0] };
  });
  await logAudit({
    workspaceId: result.context.workspace_id,
    action: "assurance.client_portal.login",
    entityType: "client_contact",
    entityId: result.context.contact_id,
    ipAddress,
    userAgent,
    metadata: { actorType: "client_contact", clientId: result.context.client_id },
  });
  return {
    sessionToken: result.sessionToken,
    expiresAt: result.expiresAt,
    focusReviewId: result.focusReviewId,
  };
}

export async function authenticatePortalSession({ token, database = pool, now = new Date() }) {
  let rawToken;
  try {
    rawToken = normalizePortalToken(token);
  } catch {
    throw httpError("Client portal session is invalid or expired", 401, "CLIENT_PORTAL_SESSION_INVALID");
  }
  const { rows } = await database.query(
    `SELECT s.id AS session_id, s.workspace_id, s.contact_id, s.expires_at,
            contact.name AS contact_name, c.id AS client_id, c.name AS client_name,
            w.name AS workspace_name, w.slug AS workspace_slug
     FROM client_portal_sessions s
     JOIN assurance_client_contacts contact
       ON contact.workspace_id=s.workspace_id AND contact.id=s.contact_id AND contact.status='active'
     JOIN assurance_clients c
       ON c.workspace_id=contact.workspace_id AND c.id=contact.client_id AND c.status='active'
     JOIN workspaces w ON w.id=s.workspace_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2
       AND COALESCE(w.status, 'active')='active'
     LIMIT 1`,
    [hashPortalToken(rawToken), now.toISOString()]
  );
  if (!rows[0]) throw httpError("Client portal session is invalid or expired", 401, "CLIENT_PORTAL_SESSION_INVALID");
  await database.query(
    `UPDATE client_portal_sessions SET last_seen_at=$2
     WHERE id=$1 AND last_seen_at < $2::timestamptz - interval '5 minutes'`,
    [rows[0].session_id, now.toISOString()]
  );
  return rows[0];
}

export async function listPortalCommitments({ session, database = pool }) {
  const { rows } = await database.query(
    `SELECT o.id, o.title, o.success_measure, o.target_date, p.name AS project_name,
            o.status AS outcome_status, o.progress,
            review.id AS review_id, review.status AS review_status,
            review.contact_id AS review_contact_id, review.snapshot,
            review.decision_note, review.requested_at, review.decided_at
     FROM okr_objectives o
     LEFT JOIN projects p ON p.workspace_id=o.workspace_id AND p.id=o.primary_project_id
     LEFT JOIN LATERAL (
       SELECT r.id, r.status, r.contact_id, r.snapshot, r.decision_note, r.requested_at, r.decided_at
       FROM assurance_client_reviews r
       WHERE r.workspace_id=o.workspace_id AND r.goal_id=o.id AND r.status<>'cancelled'
       ORDER BY r.requested_at DESC LIMIT 1
     ) review ON TRUE
     WHERE o.workspace_id=$1 AND o.client_id=$2 AND o.is_client_facing=TRUE
     ORDER BY p.name NULLS LAST, o.target_date, o.title`,
    [session.workspace_id, session.client_id]
  );

  return {
    account: {
      contactName: session.contact_name,
      clientName: session.client_name,
      workspaceName: session.workspace_name,
      workspaceSlug: session.workspace_slug,
    },
    commitments: rows.map((row) => {
      const completed = row.outcome_status === "done" || Number(row.progress) >= 100;
      const state = row.review_status === "accepted"
        ? "accepted"
        : row.review_status === "changes_requested"
          ? "changes_requested"
          : row.review_status === "pending"
            ? String(row.review_contact_id) === String(session.contact_id)
              ? "awaiting_your_review"
              : "awaiting_client_review"
            : completed ? "completed" : "in_progress";
      return {
        id: row.id,
        title: row.title,
        successMeasure: row.success_measure,
        targetDate: row.target_date ? String(row.target_date).slice(0, 10) : null,
        projectName: row.project_name || "Other outcomes",
        state,
        review: row.review_id ? {
          id: row.review_id,
          status: row.review_status,
          resultSummary: row.snapshot?.resultSummary || null,
          message: row.snapshot?.message || null,
          decisionNote: row.decision_note || null,
          requestedAt: row.requested_at,
          decidedAt: row.decided_at,
          canDecide: row.review_status === "pending" && String(row.review_contact_id) === String(session.contact_id),
        } : null,
      };
    }),
  };
}

export function normalizeClientDecision(input = {}) {
  const decision = String(input.decision || "").toLowerCase();
  if (!new Set(["accepted", "changes_requested"]).has(decision)) {
    throw httpError("Choose accept or request changes");
  }
  const note = cleanText(input.note, 2000, { required: decision === "changes_requested", label: "Change request" });
  return { decision, note };
}

export async function decideClientReview({
  reviewId,
  session,
  input,
  ipAddress,
  userAgent,
  database = pool,
  now = new Date(),
}) {
  const id = uuidValue(reviewId, "Review");
  const value = normalizeClientDecision(input);
  const result = await transaction(database, async (client) => {
    const updated = await client.query(
      `UPDATE assurance_client_reviews SET
         status=$1, decision_note=$2, decided_at=$3, updated_at=$3
       WHERE workspace_id=$4 AND client_id=$5 AND contact_id=$6 AND id=$7 AND status='pending'
       RETURNING *`,
      [value.decision, value.note, now.toISOString(), session.workspace_id, session.client_id, session.contact_id, id]
    );
    if (!updated.rows[0]) throw httpError("This review is no longer available", 409, "CLIENT_REVIEW_CLOSED");
    const outcome = await client.query(
      `SELECT o.id, o.title, o.owner_id, r.requested_by
       FROM assurance_client_reviews r
       JOIN okr_objectives o ON o.workspace_id=r.workspace_id AND o.id=r.goal_id
       WHERE r.workspace_id=$1 AND r.id=$2`,
      [session.workspace_id, id]
    );
    return { review: updated.rows[0], outcome: outcome.rows[0] };
  });

  await logAudit({
    workspaceId: session.workspace_id,
    action: `assurance.client_review.${value.decision}`,
    entityType: "goal",
    entityId: result.outcome.id,
    ipAddress,
    userAgent,
    newValue: { reviewId: id, decision: value.decision, note: value.note },
    metadata: { actorType: "client_contact", contactId: session.contact_id, clientId: session.client_id },
  });

  const recipients = [...new Set([result.outcome.requested_by, result.outcome.owner_id].filter(Boolean))];
  const { notifyUser } = await import("./notification.service.js");
  await Promise.all(recipients.map((userId) => notifyUser({
    user_id: userId,
    workspaceId: session.workspace_id,
    type: "assurance_decision",
    title: value.decision === "accepted" ? "Client accepted the outcome" : "Client requested changes",
    message: `${session.client_name}: ${result.outcome.title}`,
    action_url: `/outcomes#outcome-${result.outcome.id}`,
    source_key: `client-review:${id}:${value.decision}`,
    metadata: { goalId: result.outcome.id, reviewId: id, decision: value.decision },
    mirrorToChat: false,
    broadcastToSlack: false,
  }).catch(() => null)));
  return result.review;
}

export async function logoutPortalSession({ token, session, ipAddress, userAgent, database = pool, now = new Date() }) {
  const rawToken = normalizePortalToken(token);
  await database.query(
    "UPDATE client_portal_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE token_hash=$1",
    [hashPortalToken(rawToken), now.toISOString()]
  );
  await logAudit({
    workspaceId: session?.workspace_id,
    action: "assurance.client_portal.logout",
    entityType: "client_contact",
    entityId: session?.contact_id,
    ipAddress,
    userAgent,
    metadata: { actorType: "client_contact", clientId: session?.client_id },
  });
}
