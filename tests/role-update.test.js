import test, { after } from "node:test";
import assert from "node:assert/strict";
import db from "../db.js";
import { generateToken } from "../services/auth.service.js";
import { updateUserService } from "../services/user.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";

after(async () => db.end());

test("a role-only update preserves profile fields and synchronizes workspace authority", async () => {
  const existing = {
    id: USER_ID,
    username: "Existing User",
    email: "existing@example.com",
    role: "user",
    projects: [],
    workspace_id: WORKSPACE_ID,
    email_verified_at: new Date(),
  };
  let updateStatement = "";
  let updateParams = null;
  const originalQuery = db.query;
  db.query = async (sql, params = []) => {
    const statement = String(sql).replace(/\s+/g, " ").trim();
    if (statement.includes("FROM users u") && statement.includes("WHERE u.id = $1")) {
      return { rows: [existing] };
    }
    if (statement.startsWith("WITH updated_user AS")) {
      updateStatement = statement;
      updateParams = params;
      return {
        rows: [{
          ...existing,
          username: params[0],
          email: params[1],
          role: params[2],
          projects: params[3],
        }],
      };
    }
    throw new Error(`Unexpected query: ${statement}`);
  };

  try {
    const updated = await updateUserService(USER_ID, { role: "manager" }, WORKSPACE_ID);
    assert.equal(updated.role, "manager");
    assert.equal(updated.username, existing.username);
    assert.equal(updated.email, existing.email);
    assert.deepEqual(updateParams, [
      existing.username,
      existing.email,
      "manager",
      existing.projects,
      USER_ID,
      WORKSPACE_ID,
    ]);
    assert.match(updateStatement, /UPDATE workspace_users SET role = \$3/);
    assert.match(updateStatement, /WHERE id = \$5 AND workspace_id = \$6/);
  } finally {
    db.query = originalQuery;
  }
});

test("authorization uses the current database role instead of a stale JWT role", async () => {
  const token = generateToken({
    id: USER_ID,
    username: "Existing User",
    email: "existing@example.com",
    role: "admin",
    workspaceId: WORKSPACE_ID,
    email_verified_at: new Date(),
  });
  const originalQuery = db.query;
  db.query = async () => ({ rows: [{
    id: USER_ID,
    username: "Existing User",
    email: "existing@example.com",
    role: "user",
    workspace_id: WORKSPACE_ID,
    email_verified_at: new Date(),
  }] });
  const req = { method: "GET", headers: { authorization: `Bearer ${token}` } };

  try {
    await authMiddleware(req, {}, () => {});
    assert.equal(req.user.role, "user");
    assert.equal(req.user.workspaceId, WORKSPACE_ID);
  } finally {
    db.query = originalQuery;
  }
});
