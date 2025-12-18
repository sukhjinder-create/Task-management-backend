import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  getUserByEmail,
  getUserById,
} from "../repositories/user.repository.js";

const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
const WORKSPACE_GLOBAL = "GLOBAL";

/**
 * Helper: normalize DB user row to a safe user object
 * ❗ IMPORTANT:
 * - workspaceId MUST come from DB
 * - NO silent fallback to GLOBAL for normal users
 */
function normalizeUserRow(user) {
  if (!user) return null;

  const role = user.role || "user";

  // Workspace must exist for non-superadmin
  const workspaceId = user.workspace_id ?? user.workspaceId ?? null;

  if (!workspaceId && role !== "superadmin") {
    throw new Error("User is not assigned to any workspace");
  }

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role,
    projects: user.projects || [],
    workspaceId: role === "superadmin" ? WORKSPACE_GLOBAL : workspaceId,
    workspace_id: role === "superadmin" ? WORKSPACE_GLOBAL : workspaceId,
  };
}

/**
 * Generate JWT token
 * 🔐 workspaceId is mandatory for normal users
 */
export function generateToken(user) {
  const role = user.role || "user";

  const workspaceId =
    role === "superadmin"
      ? WORKSPACE_GLOBAL
      : user.workspaceId ?? user.workspace_id ?? null;

  if (!workspaceId && role !== "superadmin") {
    throw new Error("Cannot generate token without workspace");
  }

  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role,
      workspaceId,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * LOGIN WITH EMAIL + PASSWORD
 */
export async function loginWithEmail(email, password) {
  if (!email || !password) {
    throw new Error("Email and password are required");
  }

  const user = await getUserByEmail(email);

  if (!user) {
    throw new Error("Invalid email or password");
  }

  if (!user.password_hash) {
    throw new Error("User has no password set. Contact admin.");
  }

  const match = await bcrypt.compare(password, user.password_hash);

  if (!match) {
    throw new Error("Invalid email or password");
  }

  // 🔐 Normalize + enforce workspace
  const safeUser = normalizeUserRow(user);

  const token = generateToken(safeUser);

  return {
    token,
    user: safeUser,
  };
}

/**
 * GET CURRENT LOGGED-IN USER
 * (unchanged behavior)
 */
export async function getCurrentUser(userId) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  return user;
}
