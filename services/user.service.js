import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  createUserRepo,
  getAllUsersRepo, // ⚠️ legacy (kept, not used by default)
  getAllUsersByWorkspaceRepo, // ✅ NEW SAFE METHOD
  getUserById,
  getUserByEmail,
  updateUserRepo,
  deleteUserRepo,
  addUserToWorkspaceRepo
} from "../repositories/user.repository.js";
import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import { sendWelcomeMagicLink } from "./magicLink.service.js";

const WORKSPACE_GLOBAL = "GLOBAL";

/* =====================================================
   CREATE IMPORTED USER
   Universal entry point for all migration sources:
   Slack, Asana, YouTrack, or any future import.
   Creates the user + sends welcome magic link email.
===================================================== */
export async function createImportedUser({
  username,
  email,
  role = "user",
  added_by,
  projects = [],
  workspace_id,
  avatar_url = null,
}) {
  if (!workspace_id || workspace_id === WORKSPACE_GLOBAL) {
    throw new Error("Invalid workspace context");
  }

  // Imported users have no password — magic link is their first login
  const randomPassword  = crypto.randomBytes(16).toString("hex");
  const password_hash   = await bcrypt.hash(randomPassword, 10);

  const user = await createUserRepo({
    username,
    email,
    password_hash,
    role,
    added_by: added_by || "import",
    projects,
    workspace_id,
  });

  await addUserToWorkspaceRepo(user.id, workspace_id);

  if (avatar_url) {
    await pool.query(
      `UPDATE users SET avatar_url = $1 WHERE id = $2`,
      [avatar_url, user.id]
    ).catch(() => {}); // non-fatal
  }

  // Fire-and-forget: send welcome email with magic login link
  sendWelcomeMagicLink({ id: user.id, email: user.email, username: user.username });

  return user;
}

/* =====================================================
   CREATE USER
   🔐 Workspace is now FORCED from caller
===================================================== */
export async function createUserService({
  username,
  email,
  password,
  role = "user",
  added_by,
  projects = [],
  workspace_id, // 🔐 REQUIRED (comes from route → middleware)
}) {
  if (!username || !email || !password) {
    throw new Error("username, email, password are required");
  }

  if (!workspace_id || workspace_id === WORKSPACE_GLOBAL) {
    throw new Error("Invalid workspace context");
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    throw new Error("Email is already in use");
  }

  const password_hash = await bcrypt.hash(password, 10);

    const user = await createUserRepo({
    username,
    email,
    password_hash,
    role,
    added_by: added_by || "admin",
    projects,
    workspace_id,
  });

  // 🔐 REQUIRED: bind user to workspace_users
  await addUserToWorkspaceRepo(user.id, workspace_id);

  return user;
}

/* =====================================================
   GET ALL USERS
   🔐 WORKSPACE SAFE (default)
===================================================== */
export async function getAllUsersService({ workspaceId } = {}) {
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) {
    // 🔴 DO NOT leak users across workspaces
    return [];
  }

  return getAllUsersByWorkspaceRepo(workspaceId);
}

/* =====================================================
   UPDATE USER
   🔐 Workspace enforced BEFORE update
===================================================== */
export async function updateUserService(
  id,
  { username, email, role, projects },
  workspaceId
) {
  if (!username || !email || !role) {
    throw new Error("username, email and role are required");
  }

  const existing = await getUserById(id);
  if (!existing) {
    throw new Error("User not found");
  }

  // 🔐 HARD BLOCK: cross-workspace modification
  if (String(existing.workspace_id) !== String(workspaceId)) {
    throw new Error("Workspace access denied");
  }

  const updated = await updateUserRepo(id, {
    username,
    email,
    role,
    projects,
  });

  // Notify user about newly assigned projects
  try {
    const existingProjects = Array.isArray(existing.projects) ? existing.projects : [];
    const newProjects      = Array.isArray(projects)          ? projects          : [];
    const addedProjects    = newProjects.filter((p) => !existingProjects.includes(p));

    for (const projectId of addedProjects) {
      // Fetch project name for a meaningful message
      let projectName = "a project";
      try {
        const { rows } = await pool.query(
          `SELECT name FROM projects WHERE id = $1 LIMIT 1`,
          [projectId]
        );
        if (rows[0]?.name) projectName = rows[0].name;
      } catch {}

      await notifyUser({
        user_id:    id,
        type:       "project_assigned",
        message:    `You have been assigned to project "${projectName}"`,
        project_id: projectId,
        workspaceId,
      });
    }
  } catch (notifErr) {
    console.error("[notifications] updateUserService project_assigned failed:", notifErr.message);
  }

  return updated;
}

/* =====================================================
   DELETE USER
   🔐 Workspace enforced BEFORE delete
===================================================== */
export async function deleteUserService(id, workspaceId) {
  const existing = await getUserById(id);
  if (!existing) {
    throw new Error("User not found");
  }

  // 🔐 HARD BLOCK: cross-workspace delete
  if (String(existing.workspace_id) !== String(workspaceId)) {
    throw new Error("Workspace access denied");
  }

  const ok = await deleteUserRepo(id);
  if (!ok) {
    throw new Error("User not found");
  }

  return true;
}
