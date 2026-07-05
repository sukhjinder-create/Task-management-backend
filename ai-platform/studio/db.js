// ai-platform/studio/db.js
//
// Schema-tolerant query helpers for the Studio DB layer. Every query is wrapped
// so a missing table / unreachable DB degrades to an empty result instead of
// throwing — the Studio API therefore never 500s on an un-migrated database
// (endpoints return empty lists / no-op writes). Reuses the app pool.

import pool from "../../db.js";

/** Never throws. Returns { rows, _error? }. */
export async function q(sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    return { rows: [], _error: e.message };
  }
}

export async function tableExists(name) {
  const { rows } = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`, [name]);
  return rows.length > 0;
}
