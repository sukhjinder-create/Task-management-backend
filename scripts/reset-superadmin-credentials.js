import bcrypt from "bcryptjs";
import { assertDatabaseScriptSafety } from "../utils/databaseSafety.js";

assertDatabaseScriptSafety({ operation: "Super Admin credential reset", force: true });
const { default: pool } = await import("../db.js");

const email = String(process.env.SUPERADMIN_RESET_EMAIL || "").trim().toLowerCase();
const password = String(process.env.SUPERADMIN_RESET_PASSWORD || "");
const allowCreate = String(process.env.SUPERADMIN_RESET_CREATE || "").toLowerCase() === "true";
const confirmed = process.env.CONFIRM_SUPERADMIN_RESET === "RESET";

function validate() {
  if (!confirmed) throw new Error("Set CONFIRM_SUPERADMIN_RESET=RESET to authorize this one-time operation");
  if (!email || !email.includes("@")) throw new Error("SUPERADMIN_RESET_EMAIL must be a valid email");
  if (password.length < 12) throw new Error("SUPERADMIN_RESET_PASSWORD must contain at least 12 characters");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error("SUPERADMIN_RESET_PASSWORD must include upper, lower, number, and symbol characters");
  }
}

async function run() {
  validate();
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id FROM superadmins WHERE lower(email) = $1 FOR UPDATE",
      [email]
    );
    let superadminId;
    if (existing.rowCount) {
      superadminId = existing.rows[0].id;
      await client.query(
        "UPDATE superadmins SET password_hash = $1 WHERE id = $2",
        [passwordHash, superadminId]
      );
    } else {
      if (!allowCreate) {
        throw new Error("Super Admin account does not exist. Set SUPERADMIN_RESET_CREATE=true only if bootstrap creation is intended");
      }
      const inserted = await client.query(
        "INSERT INTO superadmins (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      superadminId = inserted.rows[0].id;
    }

    const sessionsTable = await client.query("SELECT to_regclass('public.superadmin_sessions') AS name");
    if (sessionsTable.rows[0]?.name) {
      await client.query(
        `UPDATE superadmin_sessions
            SET revoked_at = COALESCE(revoked_at, now())
          WHERE superadmin_id = $1`,
        [superadminId]
      );
    }
    await client.query("COMMIT");
    console.log(`Super Admin credentials reset for ${email}; all existing sessions were revoked.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error("Super Admin credential reset failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => pool.end());
