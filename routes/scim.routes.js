import crypto from "node:crypto";
import express from "express";

import db from "../db.js";

const router = express.Router();
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function scimError(res, status, detail, scimType) {
  return res.status(status).type("application/scim+json").json({
    schemas: [ERROR_SCHEMA], status: String(status), detail,
    ...(scimType ? { scimType } : {}),
  });
}

const route = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error("[scim]", error.message);
    if (!res.headersSent) scimError(res, error.statusCode || 500, error.statusCode ? error.message : "SCIM request failed");
  }
};

router.use(async (req, res, next) => {
  res.type("application/scim+json");
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!/^scim_[a-f0-9]{64}$/i.test(token)) return scimError(res, 401, "Invalid SCIM bearer token");
  try {
    const result = await db.query(
      `UPDATE scim_tokens token SET last_used_at = now()
        FROM workspaces workspace
       WHERE token.token_hash = $1
         AND token.revoked_at IS NULL
         AND (token.expires_at IS NULL OR token.expires_at > now())
         AND workspace.id = token.workspace_id
         AND (workspace.status IS NULL OR workspace.status = 'active')
       RETURNING token.id, token.workspace_id`,
      [hash(token)]
    );
    if (!result.rows[0]) return scimError(res, 401, "Invalid or expired SCIM bearer token");
    req.scim = result.rows[0];
    req.workspaceId = result.rows[0].workspace_id;
    next();
  } catch (error) {
    console.error("[scim.auth]", error.message);
    scimError(res, 503, "SCIM authentication is temporarily unavailable");
  }
});

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}${req.baseUrl}`;
}

function userResource(row, req) {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    externalId: row.external_id || undefined,
    userName: row.email,
    displayName: row.username,
    name: { formatted: row.username },
    active: row.disabled_at == null && row.scim_active !== false,
    emails: [{ value: row.email, primary: true, type: "work" }],
    meta: {
      resourceType: "User",
      created: row.created_at,
      lastModified: row.updated_at || row.created_at,
      location: `${baseUrl(req)}/Users/${row.id}`,
    },
  };
}

function groupResource(row, members, req) {
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    externalId: row.external_id || undefined,
    displayName: row.display_name,
    members: members.map((member) => ({ value: member.user_id, display: member.username })),
    meta: {
      resourceType: "Group",
      created: row.created_at,
      lastModified: row.updated_at || row.created_at,
      location: `${baseUrl(req)}/Groups/${row.id}`,
    },
  };
}

function listResponse(resources, startIndex, totalResults) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function parsePaging(query) {
  return {
    startIndex: Math.max(Number(query.startIndex) || 1, 1),
    count: Math.min(Math.max(Number(query.count) || 100, 1), 200),
  };
}

function parseEqualityFilter(filter, allowed) {
  if (!filter) return null;
  const match = String(filter).match(/^([A-Za-z][\w.]*)\s+eq\s+"([^"]+)"$/i);
  if (!match || !allowed.includes(match[1].toLowerCase())) {
    throw Object.assign(new Error("Only equality filters on supported attributes are accepted"), { statusCode: 400 });
  }
  return { attribute: match[1].toLowerCase(), value: match[2] };
}

function userInput(body) {
  const email = String(body?.userName || body?.emails?.find((item) => item?.primary)?.value || body?.emails?.[0]?.value || "")
    .trim().toLowerCase();
  const displayName = String(body?.displayName || body?.name?.formatted || [body?.name?.givenName, body?.name?.familyName].filter(Boolean).join(" ") || email.split("@")[0]).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("userName must be a valid email address"), { statusCode: 400 });
  if (!displayName) throw Object.assign(new Error("displayName is required"), { statusCode: 400 });
  return { email, displayName: displayName.slice(0, 200), externalId: body?.externalId ? String(body.externalId) : null, active: body?.active !== false };
}

async function findUser(workspaceId, userId) {
  const result = await db.query(
    `SELECT app_user.*, identity.external_id, identity.active AS scim_active
       FROM users app_user
       JOIN scim_external_identities identity
         ON identity.user_id = app_user.id AND identity.workspace_id = app_user.workspace_id
      WHERE app_user.id = $1 AND app_user.workspace_id = $2`,
    [userId, workspaceId]
  );
  return result.rows[0] || null;
}

async function replaceGroupMembers(client, workspaceId, groupId, members) {
  const ids = [...new Set((Array.isArray(members) ? members : []).map((member) => String(member?.value || member)).filter(Boolean))];
  const valid = ids.length
    ? await client.query("SELECT id FROM users WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, ids])
    : { rows: [] };
  if (valid.rows.length !== ids.length) throw Object.assign(new Error("One or more group members are outside this workspace"), { statusCode: 400 });
  await client.query("DELETE FROM scim_group_members WHERE workspace_id = $1 AND group_id = $2", [workspaceId, groupId]);
  if (ids.length) {
    await client.query(
      `INSERT INTO scim_group_members (workspace_id, group_id, user_id)
       SELECT $1, $2, unnest($3::uuid[])`,
      [workspaceId, groupId, ids]
    );
  }
}

router.get("/ServiceProviderConfig", (_req, res) => res.json({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 }, changePassword: { supported: false },
  sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "Workspace-scoped SCIM bearer token", primary: true }],
}));

router.get("/ResourceTypes", (req, res) => res.json(listResponse([
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA },
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP_SCHEMA },
], 1, 2)));

router.get("/ResourceTypes/:id", (req, res) => {
  const id = String(req.params.id || "").toLowerCase();
  if (id === "user") return res.json({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA });
  if (id === "group") return res.json({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP_SCHEMA });
  return scimError(res, 404, "Resource type not found");
});

router.get("/Schemas", (_req, res) => res.json(listResponse([
  { id: USER_SCHEMA, name: "User", description: "Asystence user", attributes: [] },
  { id: GROUP_SCHEMA, name: "Group", description: "Asystence group", attributes: [] },
], 1, 2)));

router.get("/Schemas/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (id === USER_SCHEMA) return res.json({ id: USER_SCHEMA, name: "User", description: "Asystence user", attributes: [] });
  if (id === GROUP_SCHEMA) return res.json({ id: GROUP_SCHEMA, name: "Group", description: "Asystence group", attributes: [] });
  return scimError(res, 404, "Schema not found");
});

router.get("/Users", route(async (req, res) => {
  const { startIndex, count } = parsePaging(req.query);
  const filter = parseEqualityFilter(req.query.filter, ["username", "externalid"]);
  const conditions = ["app_user.workspace_id = $1"];
  const params = [req.workspaceId];
  if (filter) {
    params.push(filter.value.toLowerCase());
    conditions.push(filter.attribute === "username" ? `lower(app_user.email) = $${params.length}` : `identity.external_id = $${params.length}`);
  }
  const where = conditions.join(" AND ");
  const rows = await db.query(
    `SELECT app_user.*, identity.external_id, identity.active AS scim_active
       FROM users app_user
       JOIN scim_external_identities identity
         ON identity.user_id = app_user.id AND identity.workspace_id = app_user.workspace_id
      WHERE ${where} ORDER BY app_user.created_at
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, count, startIndex - 1]
  );
  const total = await db.query(
    `SELECT COUNT(*) FROM users app_user JOIN scim_external_identities identity
       ON identity.user_id = app_user.id AND identity.workspace_id = app_user.workspace_id
      WHERE ${where}`,
    params
  );
  res.json(listResponse(rows.rows.map((row) => userResource(row, req)), startIndex, Number(total.rows[0].count)));
}));

router.post("/Users", route(async (req, res) => {
  const input = userInput(req.body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id, workspace_id FROM users WHERE email = $1 FOR UPDATE", [input.email]);
    if (existing.rows[0] && existing.rows[0].workspace_id !== req.workspaceId) {
      throw Object.assign(new Error("A user with this userName belongs to another workspace"), { statusCode: 409 });
    }
    let userId = existing.rows[0]?.id;
    if (!userId) {
      const suffix = hash(input.email).slice(0, 6);
      const inserted = await client.query(
        `INSERT INTO users
           (username, email, role, workspace_id, email_verified_at, email_verification_method, disabled_at)
         VALUES ($1,$2,'user',$3,now(),'scim',$4) RETURNING id`,
        [`${input.displayName.slice(0, 190)}-${suffix}`, input.email, req.workspaceId, input.active ? null : new Date()]
      );
      userId = inserted.rows[0].id;
    } else {
      await client.query(
        "UPDATE users SET username = $1, disabled_at = $2, updated_at = now() WHERE id = $3 AND workspace_id = $4",
        [input.displayName, input.active ? null : new Date(), userId, req.workspaceId]
      );
    }
    await client.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, billing_status)
       VALUES ($1,$2,'user',$3)
       ON CONFLICT (user_id) DO UPDATE SET billing_status = EXCLUDED.billing_status`,
      [req.workspaceId, userId, input.active ? "active" : "pending"]
    );
    await client.query(
      `INSERT INTO scim_external_identities
         (workspace_id, user_id, external_id, active, raw_attributes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         external_id = EXCLUDED.external_id, active = EXCLUDED.active,
         raw_attributes = EXCLUDED.raw_attributes, updated_at = now()`,
      [req.workspaceId, userId, input.externalId, input.active, JSON.stringify(req.body || {})]
    );
    await client.query("COMMIT");
    const row = await findUser(req.workspaceId, userId);
    res.status(201).set("Location", `${baseUrl(req)}/Users/${userId}`).json(userResource(row, req));
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") error.statusCode = 409;
    throw error;
  } finally {
    client.release();
  }
}));

router.get("/Users/:id", route(async (req, res) => {
  const row = await findUser(req.workspaceId, req.params.id);
  if (!row) return scimError(res, 404, "User not found");
  res.json(userResource(row, req));
}));

async function updateUser(req, res, patchOnly) {
  const current = await findUser(req.workspaceId, req.params.id);
  if (!current) return scimError(res, 404, "User not found");
  let input = patchOnly
    ? { email: current.email, displayName: current.username, externalId: current.external_id, active: current.disabled_at == null }
    : userInput(req.body);
  if (patchOnly) {
    if (!Array.isArray(req.body?.Operations)) return scimError(res, 400, "PatchOp Operations are required", "invalidSyntax");
    for (const operation of req.body.Operations) {
      const op = String(operation.op || "").toLowerCase();
      if (!["add", "replace", "remove"].includes(op)) return scimError(res, 400, "Unsupported patch operation", "invalidSyntax");
      const path = String(operation.path || "").toLowerCase();
      if (!path && typeof operation.value === "object") {
        input = { ...input, ...userInput({ ...input, ...operation.value }) };
      } else if (path === "active") input.active = op === "remove" ? false : operation.value !== false;
      else if (path === "displayname" || path === "name.formatted") input.displayName = op === "remove" ? current.email.split("@")[0] : String(operation.value || "").trim();
      else if (path === "username") input.email = String(operation.value || "").trim().toLowerCase();
      else if (path === "externalid") input.externalId = op === "remove" ? null : String(operation.value || "");
      else return scimError(res, 400, `Unsupported patch path: ${operation.path}`, "invalidPath");
    }
    input = userInput({ userName: input.email, displayName: input.displayName, externalId: input.externalId, active: input.active });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users SET email = $1, username = $2, disabled_at = $3, updated_at = now()
        WHERE id = $4 AND workspace_id = $5`,
      [input.email, input.displayName, input.active ? null : new Date(), req.params.id, req.workspaceId]
    );
    await client.query(
      `UPDATE scim_external_identities SET external_id = $1, active = $2,
              raw_attributes = $3, updated_at = now()
        WHERE user_id = $4 AND workspace_id = $5`,
      [input.externalId, input.active, JSON.stringify(req.body || {}), req.params.id, req.workspaceId]
    );
    await client.query(
      "UPDATE workspace_users SET billing_status = $1 WHERE user_id = $2 AND workspace_id = $3",
      [input.active ? "active" : "pending", req.params.id, req.workspaceId]
    );
    if (!input.active) await client.query("DELETE FROM user_sessions WHERE user_id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") error.statusCode = 409;
    throw error;
  } finally {
    client.release();
  }
  res.json(userResource(await findUser(req.workspaceId, req.params.id), req));
}

router.put("/Users/:id", route((req, res) => updateUser(req, res, false)));
router.patch("/Users/:id", route((req, res) => updateUser(req, res, true)));
router.delete("/Users/:id", route(async (req, res) => {
  const result = await db.query(
    `WITH disabled AS (
       UPDATE users SET disabled_at = now(), updated_at = now()
        WHERE id = $1 AND workspace_id = $2 RETURNING id
     ), identity AS (
       UPDATE scim_external_identities SET active = false, updated_at = now()
        WHERE user_id IN (SELECT id FROM disabled) AND workspace_id = $2
     ), membership AS (
       UPDATE workspace_users SET billing_status = 'pending'
        WHERE user_id IN (SELECT id FROM disabled) AND workspace_id = $2
     )
     DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM disabled) AND workspace_id = $2
     RETURNING id`,
    [req.params.id, req.workspaceId]
  );
  if (!result.rowCount && !(await findUser(req.workspaceId, req.params.id))) return scimError(res, 404, "User not found");
  res.status(204).end();
}));

async function getGroup(workspaceId, groupId) {
  const group = await db.query("SELECT * FROM scim_groups WHERE id = $1 AND workspace_id = $2", [groupId, workspaceId]);
  if (!group.rows[0]) return null;
  const members = await db.query(
    `SELECT member.user_id, app_user.username FROM scim_group_members member
       JOIN users app_user ON app_user.id = member.user_id AND app_user.workspace_id = member.workspace_id
      WHERE member.workspace_id = $1 AND member.group_id = $2 ORDER BY app_user.username`,
    [workspaceId, groupId]
  );
  return { row: group.rows[0], members: members.rows };
}

router.get("/Groups", route(async (req, res) => {
  const { startIndex, count } = parsePaging(req.query);
  const filter = parseEqualityFilter(req.query.filter, ["displayname", "externalid"]);
  const params = [req.workspaceId];
  let filterSql = "";
  if (filter) {
    params.push(filter.value);
    filterSql = filter.attribute === "displayname" ? ` AND lower(display_name) = lower($2)` : ` AND external_id = $2`;
  }
  const result = await db.query(
    `SELECT *, COUNT(*) OVER() AS total_count FROM scim_groups
      WHERE workspace_id = $1${filterSql} ORDER BY display_name
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, count, startIndex - 1]
  );
  const resources = [];
  for (const row of result.rows) {
    const group = await getGroup(req.workspaceId, row.id);
    resources.push(groupResource(group.row, group.members, req));
  }
  res.json(listResponse(resources, startIndex, Number(result.rows[0]?.total_count || 0)));
}));

router.post("/Groups", route(async (req, res) => {
  const displayName = String(req.body?.displayName || "").trim();
  if (!displayName) return scimError(res, 400, "displayName is required", "invalidValue");
  const client = await db.connect();
  let groupId;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO scim_groups (workspace_id, external_id, display_name)
       VALUES ($1,$2,$3) RETURNING id`,
      [req.workspaceId, req.body?.externalId || null, displayName]
    );
    groupId = result.rows[0].id;
    await replaceGroupMembers(client, req.workspaceId, groupId, req.body?.members);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") error.statusCode = 409;
    throw error;
  } finally { client.release(); }
  const group = await getGroup(req.workspaceId, groupId);
  res.status(201).set("Location", `${baseUrl(req)}/Groups/${groupId}`).json(groupResource(group.row, group.members, req));
}));

router.get("/Groups/:id", route(async (req, res) => {
  const group = await getGroup(req.workspaceId, req.params.id);
  if (!group) return scimError(res, 404, "Group not found");
  res.json(groupResource(group.row, group.members, req));
}));

async function replaceGroup(req, res, patchOnly) {
  const group = await getGroup(req.workspaceId, req.params.id);
  if (!group) return scimError(res, 404, "Group not found");
  let displayName = group.row.display_name;
  let externalId = group.row.external_id;
  let members = group.members.map((member) => ({ value: member.user_id }));
  if (patchOnly) {
    if (!Array.isArray(req.body?.Operations)) return scimError(res, 400, "PatchOp Operations are required", "invalidSyntax");
    for (const operation of req.body.Operations) {
      const op = String(operation.op || "").toLowerCase();
      const path = String(operation.path || "").toLowerCase();
      if (path === "displayname") displayName = String(operation.value || "").trim();
      else if (path === "externalid") externalId = op === "remove" ? null : String(operation.value || "");
      else if (path === "members" || path.startsWith("members[")) {
        const values = Array.isArray(operation.value) ? operation.value : [operation.value];
        if (op === "add") members = [...members, ...values];
        else if (op === "replace") members = values;
        else if (op === "remove") {
          const match = path.match(/value\s+eq\s+"([^"]+)"/i);
          members = match ? members.filter((member) => member.value !== match[1]) : [];
        }
      } else if (!path && operation.value?.members) members = operation.value.members;
      else return scimError(res, 400, `Unsupported patch path: ${operation.path}`, "invalidPath");
    }
  } else {
    displayName = String(req.body?.displayName || "").trim();
    externalId = req.body?.externalId || null;
    members = req.body?.members || [];
  }
  if (!displayName) return scimError(res, 400, "displayName is required", "invalidValue");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE scim_groups SET display_name = $1, external_id = $2, updated_at = now() WHERE id = $3 AND workspace_id = $4",
      [displayName, externalId, req.params.id, req.workspaceId]
    );
    await replaceGroupMembers(client, req.workspaceId, req.params.id, members);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  const updated = await getGroup(req.workspaceId, req.params.id);
  res.json(groupResource(updated.row, updated.members, req));
}

router.put("/Groups/:id", route((req, res) => replaceGroup(req, res, false)));
router.patch("/Groups/:id", route((req, res) => replaceGroup(req, res, true)));
router.delete("/Groups/:id", route(async (req, res) => {
  const result = await db.query("DELETE FROM scim_groups WHERE id = $1 AND workspace_id = $2 RETURNING id", [req.params.id, req.workspaceId]);
  if (!result.rows[0]) return scimError(res, 404, "Group not found");
  res.status(204).end();
}));

export { PATCH_SCHEMA, USER_SCHEMA, GROUP_SCHEMA, parseEqualityFilter, userInput };
export default router;
