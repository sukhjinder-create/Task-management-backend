// services/user.service.js
import bcrypt from "bcryptjs";
import {
  createUserRepo,
  getAllUsersRepo,
  getUserById,
  getUserByEmail,
  updateUserRepo,
  deleteUserRepo,
} from "../repositories/user.repository.js";

// CREATE USER (admin Creates users)
export async function createUserService({
  username,
  email,
  password,
  role = "user",
  added_by,
  projects = [],
}) {
  if (!username || !email || !password) {
    throw new Error("username, email, password are required");
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    throw new Error("Email is already in use");
  }

  const password_hash = await bcrypt.hash(password, 10);

  return createUserRepo({
    username,
    email,
    password_hash,
    role,
    added_by: added_by || "admin",
    projects,
  });
}

// GET ALL USERS (for admin/manager)
export async function getAllUsersService() {
  return getAllUsersRepo();
}

// UPDATE USER (admin only)
export async function updateUserService(id, { username, email, role, projects }) {
  if (!username || !email || !role) {
    throw new Error("username, email and role are required");
  }

  const updated = await updateUserRepo(id, {
    username,
    email,
    role,
    projects,
  });

  if (!updated) {
    throw new Error("User not found");
  }

  return updated;
}

// DELETE USER (admin only)
export async function deleteUserService(id) {
  const ok = await deleteUserRepo(id);
  if (!ok) {
    throw new Error("User not found");
  }
}
