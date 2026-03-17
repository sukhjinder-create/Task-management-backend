import pg from "pg";
import { readFileSync } from "fs";

const pool = new pg.Pool({
  connectionString:
    "postgres://apytask_manager_user:f3X9aT7zM1pQ8nR6wK2j@10.0.0.6:5432/apytask_manager",
});

const migrations = [
  {
    file: "./migrations/20260316_add_task_types_and_points.sql",
    label: "story_points, task_type, is_blocked columns",
  },
  {
    file: "./migrations/20260316_backfill_ticket_numbers.sql",
    label: "backfill ticket_number for existing tasks",
  },
  {
    file: "./migrations/20260317_youtrack_features.sql",
    label: "tags, issue links, time tracking, watchers, votes, templates, saved filters, multiple assignees, WIP limits",
  },
];

for (const { file, label } of migrations) {
  const sql = readFileSync(file, "utf8");
  try {
    await pool.query(sql);
    console.log(`✅ Migration complete — ${label}.`);
  } catch (err) {
    if (err.message.includes("already exists")) {
      console.log(`✅ Already applied — ${label}.`);
    } else {
      console.error(`❌ Migration failed (${label}):`, err.message);
    }
  }
}

await pool.end();
