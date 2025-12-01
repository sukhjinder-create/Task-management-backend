// services/auth.service.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  getUserByEmail,
  getUserById,
} from "../repositories/user.repository.js";

const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";
const JWT_EXPIRES_IN = "1h";

// Generate JWT token
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// LOGIN WITH EMAIL + PASSWORD
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

  const safeUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    projects: user.projects || [],
  };

  const token = generateToken(safeUser);
  return { token, user: safeUser };
}

// GET CURRENT LOGGED-IN USER
export async function getCurrentUser(userId) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  return user;
}
