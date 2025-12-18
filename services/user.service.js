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

const WORKSPACE_GLOBAL = "GLOBAL";

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
