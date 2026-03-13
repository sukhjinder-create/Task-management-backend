import pool from "../db.js";

function parseJsonMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeJsonString(value = "") {
  const input = String(value ?? "");
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += input[i];
    }
  }
  return out;
}

function sanitizeForJson(value) {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeJsonString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForJson(item));
  if (typeof value === "object") {
    const out = {};
    for (const [key, innerValue] of Object.entries(value)) {
      out[key] = sanitizeForJson(innerValue);
    }
    return out;
  }
  return value;
}

export function safeJsonStringify(value) {
  return JSON.stringify(sanitizeForJson(value));
}

export class RunCancelledError extends Error {
  constructor(message = "Run stopped by user", details = {}) {
    super(message);
    this.name = "RunCancelledError";
    this.code = "RUN_CANCELLED";
    this.details = details;
  }
}

export function isRunCancelledError(error) {
  return error?.code === "RUN_CANCELLED" || error instanceof RunCancelledError;
}

export async function requestTestingRunStop({
  workspaceId,
  runId,
  actorId = null,
  reason = "Stopped by user",
}) {
  const control = {
    requestedAt: new Date().toISOString(),
    requestedBy: actorId || null,
    reason: sanitizeJsonString(reason),
  };

  const { rows } = await pool.query(
    `
    UPDATE testing_agent_runs
    SET
      status = CASE
        WHEN status IN ('pending', 'running', 'cancel_requested') THEN 'cancel_requested'
        ELSE status
      END,
      output_json = COALESCE(output_json, '{}'::jsonb) || jsonb_build_object('cancelControl', $3::jsonb)
    WHERE workspace_id = $1
      AND id = $2
    RETURNING *
    `,
    [workspaceId, runId, safeJsonStringify(control)]
  );

  if (!rows[0]) return null;
  return {
    ...rows[0],
    generated_cases: parseJsonMaybe(rows[0].generated_cases, []),
    commands: parseJsonMaybe(rows[0].commands, []),
    output_json: parseJsonMaybe(rows[0].output_json, {}),
  };
}

export function createRunController(runId, { pollMs = 1200 } = {}) {
  let lastState = null;
  let lastCheckedAt = 0;
  let inflight = null;

  async function read(force = false) {
    const now = Date.now();
    if (!force && lastState && now - lastCheckedAt < pollMs) {
      return lastState;
    }
    if (!force && inflight) {
      return inflight;
    }
    inflight = pool.query(
      `
      SELECT status, output_json
      FROM testing_agent_runs
      WHERE id = $1
      LIMIT 1
      `,
      [runId]
    ).then(({ rows }) => {
      const row = rows[0] || null;
      lastCheckedAt = Date.now();
      lastState = row
        ? {
            status: row.status,
            output_json: parseJsonMaybe(row.output_json, {}),
            cancelControl: parseJsonMaybe(row.output_json, {})?.cancelControl || null,
          }
        : {
            status: "missing",
            output_json: {},
            cancelControl: null,
          };
      inflight = null;
      return lastState;
    }).catch((error) => {
      inflight = null;
      throw error;
    });
    return inflight;
  }

  async function assertActive(context = {}) {
    const state = await read(false);
    if (state.status === "cancel_requested" || state.status === "cancelled") {
      throw new RunCancelledError(
        state.cancelControl?.reason || "Run stopped by user",
        { runId, cancelControl: state.cancelControl, ...context }
      );
    }
    return state;
  }

  return {
    runId,
    read,
    assertActive,
    refresh: () => read(true),
  };
}
