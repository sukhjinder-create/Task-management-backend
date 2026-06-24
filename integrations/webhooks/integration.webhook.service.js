import axios from "axios";
import crypto from "crypto";
import pool from "../../db.js";
import { emitIntegrationEvent } from "../integration.events.js";
import { hashIntegrationState } from "../../events/utils/hashState.js";
import youtrackAdapter from "../youtrack/youtrack.adapter.js";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const ASANA_TASK_FIELDS =
  "gid,name,completed,assignee,assignee.gid,modified_at,created_at";
const DEFAULT_YOUTRACK_HEADER = "X-YouTrack-Token";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function normalizeProjectKey(value) {
  return String(value || "").trim();
}

function normalizeProjectKeyForCompare(value) {
  return normalizeProjectKey(value).toLowerCase();
}

function buildYouTrackProjectWebhookUrl(publicBaseUrl, workspaceId, webhookId) {
  return (
    `${normalizeBaseUrl(publicBaseUrl)}/integration-webhooks/youtrack/` +
    `${workspaceId}/projects/${webhookId}`
  );
}

function getYouTrackProjectWebhooks(config) {
  const projects = config?.webhook?.projects;
  return Array.isArray(projects) ? projects : [];
}

function findYouTrackProjectWebhook(config, webhookId) {
  const id = String(webhookId || "").trim();
  return getYouTrackProjectWebhooks(config).find(
    (projectWebhook) => String(projectWebhook?.id || "") === id
  );
}

function exposeYouTrackProjectWebhook(projectWebhook) {
  if (!projectWebhook) return null;

  return {
    id: projectWebhook.id,
    provider: "youtrack",
    resourceType: "project",
    projectId: projectWebhook.projectId || projectWebhook.projectKey || null,
    projectKey: projectWebhook.projectKey || projectWebhook.projectId || null,
    projectName:
      projectWebhook.projectName ||
      projectWebhook.projectKey ||
      projectWebhook.projectId ||
      null,
    status: projectWebhook.status || "manual_setup",
    targetUrl: projectWebhook.targetUrl || null,
    headerName: projectWebhook.headerName || DEFAULT_YOUTRACK_HEADER,
    token: projectWebhook.token || null,
    tokenPreview: projectWebhook.tokenPreview || null,
    createdAt: projectWebhook.createdAt || null,
    updatedAt: projectWebhook.updatedAt || null,
    lastEventAt: projectWebhook.lastEventAt || null,
    lastError: projectWebhook.lastError || null,
  };
}

export function resolveIntegrationWebhookBaseUrl(req) {
  const configured =
    process.env.INTEGRATION_WEBHOOK_BASE_URL ||
    process.env.PUBLIC_API_BASE_URL ||
    process.env.BACKEND_URL;

  if (configured) {
    return normalizeBaseUrl(configured);
  }

  if (process.env.ASANA_REDIRECT_URI) {
    try {
      return new URL(process.env.ASANA_REDIRECT_URI).origin;
    } catch {
      // Fall through to request host.
    }
  }

  if (req) {
    return normalizeBaseUrl(`${req.protocol}://${req.get("host")}`);
  }

  throw new Error("Unable to resolve public webhook base URL");
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeSignature(signature) {
  return String(signature || "").replace(/^sha256=/i, "").trim();
}

async function getIntegrationConfig(workspaceId, provider) {
  const { rows } = await pool.query(
    `
    SELECT config
    FROM workspace_integrations
    WHERE workspace_id = $1
      AND provider = $2
      AND status = 'connected'
    LIMIT 1
    `,
    [workspaceId, provider]
  );

  return rows[0]?.config || null;
}

async function updateIntegrationConfig(workspaceId, provider, updater) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT config
      FROM workspace_integrations
      WHERE workspace_id = $1
        AND provider = $2
      LIMIT 1
      FOR UPDATE
      `,
      [workspaceId, provider]
    );

    if (!rows.length) {
      throw new Error(`${provider} integration is not connected`);
    }

    const current = asObject(rows[0].config);
    const next = await updater(current);

    await client.query(
      `
      UPDATE workspace_integrations
      SET config = $3::jsonb,
          updated_at = NOW()
      WHERE workspace_id = $1
        AND provider = $2
      `,
      [workspaceId, provider, JSON.stringify(next)]
    );

    await client.query("COMMIT");
    return next;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function isAsanaTokenExpired(err) {
  const messages = err.response?.data?.errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .join(" ");

  return (
    err.response?.status === 401 &&
    /expired|invalid.*token|token.*invalid/i.test(messages || err.message || "")
  );
}

async function refreshAsanaToken(workspaceId, config) {
  if (!config?.refresh_token) {
    throw new Error("Asana refresh token missing");
  }

  const res = await axios.post(
    "https://app.asana.com/-/oauth_token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ASANA_CLIENT_ID,
      client_secret: process.env.ASANA_CLIENT_SECRET,
      refresh_token: config.refresh_token,
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const tokens = res.data;
  const nextRefreshToken = tokens.refresh_token || config.refresh_token;

  await updateIntegrationConfig(workspaceId, "asana", (current) => ({
    ...current,
    access_token: tokens.access_token,
    refresh_token: nextRefreshToken,
    expires_at: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : current.expires_at,
  }));

  return {
    ...config,
    access_token: tokens.access_token,
    refresh_token: nextRefreshToken,
  };
}

async function withAsanaAuth(workspaceId, fn) {
  let config = await getIntegrationConfig(workspaceId, "asana");

  if (!config?.access_token) {
    throw new Error("Asana integration is not connected");
  }

  try {
    return await fn(config.access_token);
  } catch (err) {
    if (!isAsanaTokenExpired(err)) {
      throw err;
    }

    config = await refreshAsanaToken(workspaceId, config);
    return fn(config.access_token);
  }
}

async function fetchAsanaProjects(workspaceId) {
  return withAsanaAuth(workspaceId, async (accessToken) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const workspacesRes = await axios.get(`${ASANA_API_BASE}/workspaces`, {
      headers,
    });
    const asanaWorkspace = workspacesRes.data?.data?.[0];

    if (!asanaWorkspace) {
      return [];
    }

    const projects = [];
    let offset = null;

    do {
      const projectRes = await axios.get(`${ASANA_API_BASE}/projects`, {
        headers,
        params: {
          workspace: asanaWorkspace.gid,
          archived: false,
          limit: 100,
          offset,
          opt_fields: "gid,name",
        },
      });

      projects.push(...(projectRes.data?.data || []));
      offset = projectRes.data?.next_page?.offset || null;
    } while (offset);

    return projects
      .filter((project) => project?.gid)
      .map((project) => ({
        gid: project.gid,
        name: project.name || project.gid,
      }));
  });
}

async function fetchAsanaTask(workspaceId, taskGid) {
  return withAsanaAuth(workspaceId, async (accessToken) => {
    const res = await axios.get(`${ASANA_API_BASE}/tasks/${taskGid}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { opt_fields: ASANA_TASK_FIELDS },
    });

    return res.data?.data || null;
  });
}

async function createAsanaWebhook(workspaceId, resourceGid, target) {
  return withAsanaAuth(workspaceId, async (accessToken) => {
    const res = await axios.post(
      `${ASANA_API_BASE}/webhooks`,
      {
        data: {
          resource: resourceGid,
          target,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return {
      data: res.data?.data || null,
      secret: res.data?.data?.secret || res.headers["x-hook-secret"] || null,
    };
  });
}

async function getPreviousEntityHash(workspaceId, provider, externalId) {
  const { rows } = await pool.query(
    `
    SELECT state_hash
    FROM integration_entity_state
    WHERE workspace_id = $1
      AND provider = $2
      AND external_entity_id = $3
    LIMIT 1
    `,
    [workspaceId, provider, externalId]
  );

  return rows[0]?.state_hash || null;
}

async function saveEntityHash(workspaceId, provider, externalId, hash) {
  await pool.query(
    `
    INSERT INTO integration_entity_state
      (workspace_id, provider, external_entity_id, state_hash, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (workspace_id, provider, external_entity_id)
    DO UPDATE SET
      state_hash = EXCLUDED.state_hash,
      updated_at = NOW()
    `,
    [workspaceId, provider, externalId, hash]
  );
}

async function emitIfChanged({
  workspaceId,
  provider,
  externalId,
  snapshot,
  eventPayload,
}) {
  const newHash = hashIntegrationState(snapshot);
  const previousHash = await getPreviousEntityHash(
    workspaceId,
    provider,
    externalId
  );

  if (previousHash === newHash) {
    return { emitted: false, changed: false };
  }

  await saveEntityHash(workspaceId, provider, externalId, newHash);

  await emitIntegrationEvent("integration.activity.observed", {
    origin: "integration_webhook",
    provider,
    workspaceId,
    entityType: "task",
    externalId,
    observedAt: new Date().toISOString(),
    ...eventPayload,
  });

  return { emitted: true, changed: true };
}

export async function recordAsanaHandshakeSecret({
  workspaceId,
  resourceGid,
  nonce,
  secret,
}) {
  await updateIntegrationConfig(workspaceId, "asana", (current) => {
    const webhook = asObject(current.webhook);
    const pendingSecrets = asObject(webhook.pendingSecrets);

    return {
      ...current,
      webhook: {
        ...webhook,
        provider: "asana",
        mode: "automatic",
        pendingSecrets: {
          ...pendingSecrets,
          [nonce]: {
            resourceGid,
            secret,
            receivedAt: new Date().toISOString(),
          },
        },
      },
    };
  });
}

export async function setupAsanaWebhooks({
  workspaceId,
  publicBaseUrl,
  force = false,
  resourceGids = null,
}) {
  const baseUrl = normalizeBaseUrl(publicBaseUrl);
  const requestedResources = Array.isArray(resourceGids)
    ? new Set(resourceGids.map((gid) => String(gid || "").trim()).filter(Boolean))
    : null;
  const allProjects = await fetchAsanaProjects(workspaceId);
  const projects = requestedResources
    ? allProjects.filter((project) => requestedResources.has(String(project.gid)))
    : allProjects;
  const currentConfig = await getIntegrationConfig(workspaceId, "asana");
  const currentWebhook = asObject(currentConfig?.webhook);
  const existingSubscriptions = Array.isArray(currentWebhook.subscriptions)
    ? currentWebhook.subscriptions
    : [];
  const existingByResource = new Map(
    existingSubscriptions
      .filter((subscription) => subscription?.resourceGid)
      .map((subscription) => [subscription.resourceGid, subscription])
  );

  const created = [];
  const skipped = [];
  const errors = [];

  for (const project of projects) {
    const existing = existingByResource.get(project.gid);

    if (existing?.webhookGid && !force) {
      skipped.push({
        resourceGid: project.gid,
        resourceName: project.name,
        reason: "already_configured",
      });
      continue;
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const target =
      `${baseUrl}/integration-webhooks/asana/` +
      `${workspaceId}/${project.gid}/${nonce}`;

    try {
      const webhookResult = await createAsanaWebhook(
        workspaceId,
        project.gid,
        target
      );

      const latestConfig = await getIntegrationConfig(workspaceId, "asana");
      const pendingSecret =
        latestConfig?.webhook?.pendingSecrets?.[nonce]?.secret || null;
      const secret = webhookResult.secret || pendingSecret;

      if (!secret) {
        throw new Error("Asana webhook secret was not received");
      }

      const subscription = {
        provider: "asana",
        resourceType: "project",
        resourceGid: project.gid,
        resourceName: project.name,
        webhookGid: webhookResult.data?.gid || webhookResult.data?.id || null,
        target,
        nonce,
        secret,
        status: "active",
        createdAt: new Date().toISOString(),
      };

      await updateIntegrationConfig(workspaceId, "asana", (current) => {
        const webhook = asObject(current.webhook);
        const pendingSecrets = { ...asObject(webhook.pendingSecrets) };
        delete pendingSecrets[nonce];

        const subscriptions = Array.isArray(webhook.subscriptions)
          ? webhook.subscriptions
          : [];
        const nextSubscriptions = subscriptions.filter(
          (item) => item?.resourceGid !== project.gid
        );
        nextSubscriptions.push(subscription);

        return {
          ...current,
          webhook: {
            ...webhook,
            provider: "asana",
            mode: "automatic",
            status: "active",
            targetBaseUrl: baseUrl,
            pendingSecrets,
            subscriptions: nextSubscriptions,
            lastSetupAt: new Date().toISOString(),
            lastError: null,
          },
        };
      });

      created.push({
        resourceGid: project.gid,
        resourceName: project.name,
        webhookGid: subscription.webhookGid,
      });
    } catch (err) {
      errors.push({
        resourceGid: project.gid,
        resourceName: project.name,
        error: err.response?.data?.errors?.[0]?.message || err.message,
      });
    }
  }

  const status = errors.length
    ? created.length || skipped.length
      ? "partial"
      : "failed"
    : "active";

  await updateIntegrationConfig(workspaceId, "asana", (current) => {
    const webhook = asObject(current.webhook);

    return {
      ...current,
      webhook: {
        ...webhook,
        provider: "asana",
        mode: "automatic",
        status,
        targetBaseUrl: baseUrl,
        lastSetupAt: new Date().toISOString(),
        lastError: errors[0]?.error || null,
      },
    };
  });

  return {
    provider: "asana",
    supported: true,
    mode: "automatic",
    status,
    projectsSeen: projects.length,
    created,
    skipped,
    errors,
  };
}

function findAsanaSubscription(config, { resourceGid, nonce }) {
  const subscriptions = config?.webhook?.subscriptions || [];

  return subscriptions.find(
    (subscription) =>
      subscription?.nonce === nonce || subscription?.resourceGid === resourceGid
  );
}

function verifyAsanaSignature(config, { resourceGid, nonce, rawBody, signature }) {
  const subscription = findAsanaSubscription(config, { resourceGid, nonce });

  if (!subscription?.secret) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", subscription.secret)
    .update(rawBody || Buffer.from(""))
    .digest("hex");

  return safeCompare(expected, normalizeSignature(signature));
}

function extractAsanaTaskGid(event) {
  const resource = asObject(event?.resource);
  const parent = asObject(event?.parent);

  if (resource.resource_type === "task" || resource.type === "task") {
    return resource.gid || resource.id || null;
  }

  if (parent.resource_type === "task" || parent.type === "task") {
    return parent.gid || parent.id || null;
  }

  if (event?.resource_type === "task" || event?.type === "task") {
    return event?.resource_gid || event?.gid || null;
  }

  return null;
}

async function processAsanaTaskEvent({ workspaceId, event, resourceGid }) {
  const taskGid = extractAsanaTaskGid(event);

  if (!taskGid) {
    return { ignored: true, reason: "not_task_event" };
  }

  const deleted =
    event?.action === "deleted" ||
    event?.action === "removed" ||
    event?.type === "deleted";

  let task = null;
  let effectiveDeleted = deleted;

  if (!deleted) {
    try {
      task = await fetchAsanaTask(workspaceId, taskGid);
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      effectiveDeleted = true;
    }
  }

  const snapshot = effectiveDeleted
    ? { deleted: true }
    : {
        completed: task.completed,
        assignee: task.assignee?.gid || null,
        deleted: false,
      };

  const eventResult = await emitIfChanged({
    workspaceId,
    provider: "asana",
    externalId: taskGid,
    snapshot,
    eventPayload: {
      title: task?.name || event?.resource?.name || taskGid,
      projectName: event?.parent?.name || resourceGid,
      action: effectiveDeleted
        ? "task_deleted"
        : task?.completed
          ? "task_completed"
          : "task_active",
      modifiedAt: task?.modified_at || event?.created_at || null,
      createdAt: task?.created_at || null,
      webhookEvent: event,
    },
  });

  return {
    ignored: false,
    externalId: taskGid,
    ...eventResult,
  };
}

export async function handleAsanaWebhookEvent({
  workspaceId,
  resourceGid,
  nonce,
  rawBody,
  body,
  headers,
}) {
  const config = await getIntegrationConfig(workspaceId, "asana");

  if (!config) {
    throw new Error("Asana integration is not connected");
  }

  if (
    !verifyAsanaSignature(config, {
      resourceGid,
      nonce,
      rawBody,
      signature: headers["x-hook-signature"],
    })
  ) {
    const err = new Error("Invalid Asana webhook signature");
    err.statusCode = 403;
    throw err;
  }

  const events = Array.isArray(body?.events) ? body.events : [];
  const results = [];

  for (const event of events) {
    results.push(await processAsanaTaskEvent({ workspaceId, event, resourceGid }));
  }

  await updateIntegrationConfig(workspaceId, "asana", (current) => ({
    ...current,
    webhook: {
      ...asObject(current.webhook),
      provider: "asana",
      mode: "automatic",
      status: "active",
      lastEventAt: new Date().toISOString(),
      lastError: null,
    },
  }));

  return {
    received: events.length,
    processed: results.filter((result) => !result.ignored).length,
    emitted: results.filter((result) => result.emitted).length,
    results,
  };
}

export async function setupYouTrackWebhook({
  workspaceId,
  publicBaseUrl,
  rotate = false,
  headerName = DEFAULT_YOUTRACK_HEADER,
}) {
  const existingConfig = await getIntegrationConfig(workspaceId, "youtrack");

  if (!existingConfig) {
    throw new Error("YouTrack integration is not connected");
  }

  const existingWebhook = asObject(existingConfig.webhook);
  const token =
    !rotate && existingWebhook.token
      ? existingWebhook.token
      : crypto.randomBytes(32).toString("hex");
  const targetUrl = `${normalizeBaseUrl(publicBaseUrl)}/integration-webhooks/youtrack/${workspaceId}`;

  const nextConfig = await updateIntegrationConfig(
    workspaceId,
    "youtrack",
    (current) => ({
      ...current,
      webhook: {
        ...asObject(current.webhook),
        provider: "youtrack",
        mode: "manual",
        status: "manual_setup",
        targetUrl,
        headerName: headerName || DEFAULT_YOUTRACK_HEADER,
        token,
        tokenPreview: `${token.slice(0, 8)}...${token.slice(-4)}`,
        supportedEvents: [
          "issueCreated",
          "issueUpdated",
          "issueDeleted",
          "commentAdded",
          "commentUpdated",
          "commentDeleted",
          "workItemAdded",
          "workItemUpdated",
          "workItemDeleted",
          "attachmentAdded",
          "attachmentDeleted",
        ],
        lastSetupAt: new Date().toISOString(),
      },
    })
  );

  return {
    provider: "youtrack",
    supported: true,
    mode: "manual",
    status: nextConfig.webhook.status,
    targetUrl,
    headerName: nextConfig.webhook.headerName,
    token,
    instructions: [
      "Install or enable the YouTrack Webhook Triggers app.",
      "Attach it to the projects you want to sync.",
      "Set the webhook token and header name shown here.",
      "Add the webhook URL under All Events or issue events.",
    ],
  };
}

export async function setupYouTrackProjectWebhook({
  workspaceId,
  publicBaseUrl,
  projectId = null,
  projectKey = null,
  projectName = null,
  rotate = false,
  headerName = DEFAULT_YOUTRACK_HEADER,
}) {
  const key = normalizeProjectKey(projectKey || projectId);

  if (!key) {
    const err = new Error("projectKey or projectId is required");
    err.statusCode = 400;
    throw err;
  }

  const existingConfig = await getIntegrationConfig(workspaceId, "youtrack");

  if (!existingConfig) {
    throw new Error("YouTrack integration is not connected");
  }

  let savedWebhook = null;

  await updateIntegrationConfig(workspaceId, "youtrack", (current) => {
    const webhook = asObject(current.webhook);
    const projects = getYouTrackProjectWebhooks(current).map((item) => ({
      ...item,
    }));
    const existingIndex = projects.findIndex((item) => {
      const existingKey = normalizeProjectKeyForCompare(
        item.projectKey || item.projectId
      );
      return existingKey && existingKey === normalizeProjectKeyForCompare(key);
    });
    const previous = existingIndex >= 0 ? projects[existingIndex] : null;
    const id = previous?.id || crypto.randomBytes(16).toString("hex");
    const token =
      !rotate && previous?.token
        ? previous.token
        : crypto.randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const targetUrl = buildYouTrackProjectWebhookUrl(
      publicBaseUrl,
      workspaceId,
      id
    );

    savedWebhook = {
      ...previous,
      id,
      provider: "youtrack",
      resourceType: "project",
      projectId: normalizeProjectKey(projectId) || previous?.projectId || key,
      projectKey: key,
      projectName:
        normalizeProjectKey(projectName) ||
        previous?.projectName ||
        previous?.projectKey ||
        key,
      mode: "manual",
      status: "manual_setup",
      targetUrl,
      headerName: headerName || previous?.headerName || DEFAULT_YOUTRACK_HEADER,
      token,
      tokenPreview: `${token.slice(0, 8)}...${token.slice(-4)}`,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      lastError: null,
    };

    if (existingIndex >= 0) {
      projects[existingIndex] = savedWebhook;
    } else {
      projects.push(savedWebhook);
    }

    return {
      ...current,
      webhook: {
        ...webhook,
        provider: "youtrack",
        mode: "manual",
        status: "manual_setup",
        projects,
        lastSetupAt: now,
      },
    };
  });

  return {
    provider: "youtrack",
    supported: true,
    mode: "manual",
    status: savedWebhook.status,
    projectWebhook: exposeYouTrackProjectWebhook(savedWebhook),
    instructions: [
      "Create a YouTrack webhook trigger for this specific project.",
      "Use this project's URL, header name, and token.",
      "Repeat for each YouTrack project you want to integrate.",
    ],
  };
}

export async function rotateYouTrackProjectWebhook({
  workspaceId,
  publicBaseUrl,
  webhookId,
  headerName = null,
}) {
  const config = await getIntegrationConfig(workspaceId, "youtrack");
  const existing = findYouTrackProjectWebhook(config, webhookId);

  if (!existing) {
    const err = new Error("YouTrack project webhook not found");
    err.statusCode = 404;
    throw err;
  }

  let savedWebhook = null;

  await updateIntegrationConfig(workspaceId, "youtrack", (current) => {
    const webhook = asObject(current.webhook);
    const projects = getYouTrackProjectWebhooks(current).map((item) => ({
      ...item,
    }));
    const index = projects.findIndex(
      (item) => String(item?.id || "") === String(webhookId)
    );

    if (index < 0) {
      const err = new Error("YouTrack project webhook not found");
      err.statusCode = 404;
      throw err;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    savedWebhook = {
      ...projects[index],
      status: "manual_setup",
      targetUrl: buildYouTrackProjectWebhookUrl(
        publicBaseUrl,
        workspaceId,
        projects[index].id
      ),
      headerName:
        headerName || projects[index].headerName || DEFAULT_YOUTRACK_HEADER,
      token,
      tokenPreview: `${token.slice(0, 8)}...${token.slice(-4)}`,
      updatedAt: now,
      lastError: null,
    };
    projects[index] = savedWebhook;

    return {
      ...current,
      webhook: {
        ...webhook,
        provider: "youtrack",
        mode: "manual",
        status: "manual_setup",
        projects,
        lastSetupAt: now,
      },
    };
  });

  return {
    provider: "youtrack",
    supported: true,
    mode: "manual",
    status: savedWebhook.status,
    projectWebhook: exposeYouTrackProjectWebhook(savedWebhook),
  };
}

export async function deleteYouTrackProjectWebhook({
  workspaceId,
  webhookId,
}) {
  let removed = null;

  await updateIntegrationConfig(workspaceId, "youtrack", (current) => {
    const webhook = asObject(current.webhook);
    const projects = getYouTrackProjectWebhooks(current);
    const nextProjects = projects.filter((item) => {
      const match = String(item?.id || "") === String(webhookId || "");
      if (match) removed = item;
      return !match;
    });

    if (!removed) {
      const err = new Error("YouTrack project webhook not found");
      err.statusCode = 404;
      throw err;
    }

    return {
      ...current,
      webhook: {
        ...webhook,
        provider: "youtrack",
        mode: "manual",
        projects: nextProjects,
        updatedAt: new Date().toISOString(),
      },
    };
  });

  return {
    deleted: true,
    provider: "youtrack",
    projectWebhook: exposeYouTrackProjectWebhook(removed),
  };
}

function extractYouTrackIssueId(payload) {
  const projectShortName =
    payload?.project?.shortName ||
    payload?.issue?.project?.shortName ||
    payload?.projectShortName;
  const numberInProject =
    payload?.numberInProject ||
    payload?.issue?.numberInProject ||
    payload?.issueNumber;

  if (payload?.idReadable) return payload.idReadable;
  if (payload?.issue?.idReadable) return payload.issue.idReadable;
  if (projectShortName && numberInProject) {
    return `${projectShortName}-${numberInProject}`;
  }
  if (payload?.issue?.id) return payload.issue.id;
  if (payload?.id) return payload.id;

  return null;
}

function extractYouTrackProjectKey(payload) {
  const direct =
    payload?.project?.shortName ||
    payload?.issue?.project?.shortName ||
    payload?.projectShortName ||
    payload?.projectKey;

  if (direct) return normalizeProjectKey(direct);

  const readable = payload?.idReadable || payload?.issue?.idReadable;
  if (readable && String(readable).includes("-")) {
    return String(readable).split("-")[0];
  }

  return null;
}

function isDifferentYouTrackProject(left, right) {
  const a = normalizeProjectKeyForCompare(left);
  const b = normalizeProjectKeyForCompare(right);
  return Boolean(a && b && a !== b);
}

async function processYouTrackEvent({
  workspaceId,
  payload,
  projectWebhook = null,
}) {
  const issueId = extractYouTrackIssueId(payload);

  if (!issueId) {
    return { ignored: true, reason: "issue_id_missing" };
  }

  const payloadProjectKey = extractYouTrackProjectKey(payload);
  if (
    projectWebhook?.projectKey &&
    payloadProjectKey &&
    isDifferentYouTrackProject(payloadProjectKey, projectWebhook.projectKey)
  ) {
    return {
      ignored: true,
      reason: "project_mismatch",
      projectKey: payloadProjectKey,
      expectedProjectKey: projectWebhook.projectKey,
    };
  }

  const eventName = String(payload?.event || "").toLowerCase();
  const deleted = eventName.includes("deleted") && eventName.includes("issue");
  let issue = null;
  let effectiveDeleted = deleted;

  if (!deleted) {
    try {
      issue = await youtrackAdapter.getTask(workspaceId, issueId);
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      effectiveDeleted = true;
    }
  }

  const resolvedProjectKey = issue?.projectKey || payloadProjectKey;
  if (
    projectWebhook?.projectKey &&
    resolvedProjectKey &&
    isDifferentYouTrackProject(resolvedProjectKey, projectWebhook.projectKey)
  ) {
    return {
      ignored: true,
      reason: "project_mismatch",
      projectKey: resolvedProjectKey,
      expectedProjectKey: projectWebhook.projectKey,
    };
  }

  const externalId = issue?.id || issueId;
  const snapshot = effectiveDeleted
    ? { deleted: true }
    : {
        completed: issue.completed,
        status: issue.status,
        assignee: issue.assignee,
        updated: issue.updated,
        deleted: false,
      };

  const result = await emitIfChanged({
    workspaceId,
    provider: "youtrack",
    externalId,
    snapshot,
    eventPayload: {
      title: issue?.name || payload?.summary || externalId,
      projectName:
        issue?.projectName ||
        payload?.project?.name ||
        payload?.issue?.project?.name ||
        null,
      action: effectiveDeleted
        ? "task_deleted"
        : issue?.completed
          ? "task_completed"
          : "task_active",
      modifiedAt:
        issue?.updated ||
        payload?.timestamp ||
        payload?.updated ||
        new Date().toISOString(),
      createdAt: issue?.created || payload?.created || null,
      projectWebhookId: projectWebhook?.id || null,
      projectKey: resolvedProjectKey || projectWebhook?.projectKey || null,
      webhookEvent: payload,
    },
  });

  return {
    ignored: false,
    externalId,
    ...result,
  };
}

export async function handleYouTrackWebhookEvent({
  workspaceId,
  webhookId = null,
  body,
  headers,
}) {
  const config = await getIntegrationConfig(workspaceId, "youtrack");
  const projectWebhook = webhookId
    ? findYouTrackProjectWebhook(config, webhookId)
    : null;

  if (webhookId && !projectWebhook) {
    const err = new Error("YouTrack project webhook not found");
    err.statusCode = 404;
    throw err;
  }

  const webhookConfig = projectWebhook || config?.webhook;

  if (!webhookConfig?.token) {
    const err = new Error("YouTrack webhook is not configured");
    err.statusCode = 404;
    throw err;
  }

  const headerName = String(
    webhookConfig.headerName || DEFAULT_YOUTRACK_HEADER
  ).toLowerCase();
  const receivedToken = headers[headerName];

  if (!safeCompare(receivedToken, webhookConfig.token)) {
    const err = new Error("Invalid YouTrack webhook token");
    err.statusCode = 403;
    throw err;
  }

  const payloads = Array.isArray(body) ? body : [body];
  const results = [];

  for (const payload of payloads) {
    results.push(
      await processYouTrackEvent({ workspaceId, payload, projectWebhook })
    );
  }

  await updateIntegrationConfig(workspaceId, "youtrack", (current) => {
    const webhook = asObject(current.webhook);
    const now = new Date().toISOString();

    if (!projectWebhook) {
      return {
        ...current,
        webhook: {
          ...webhook,
          provider: "youtrack",
          mode: "manual",
          status: "active",
          lastEventAt: now,
          lastError: null,
        },
      };
    }

    const projects = getYouTrackProjectWebhooks(current).map((item) =>
      String(item?.id || "") === String(projectWebhook.id)
        ? {
            ...item,
            status: "active",
            lastEventAt: now,
            lastError: null,
          }
        : item
    );

    return {
      ...current,
      webhook: {
        ...webhook,
        provider: "youtrack",
        mode: "manual",
        status: "active",
        projects,
        lastEventAt: now,
        lastError: null,
      },
    };
  });

  return {
    received: payloads.length,
    processed: results.filter((result) => !result.ignored).length,
    emitted: results.filter((result) => result.emitted).length,
    projectWebhookId: projectWebhook?.id || null,
    results,
  };
}

function safeWebhookStatus(config, provider, publicBaseUrl, workspaceId) {
  if (!config) {
    return {
      provider,
      supported: provider === "asana" || provider === "youtrack",
      connected: false,
      status: "not_connected",
    };
  }

  const webhook = asObject(config.webhook);

  if (provider === "youtrack") {
    const targetUrl =
      webhook.targetUrl ||
      `${normalizeBaseUrl(publicBaseUrl)}/integration-webhooks/youtrack/${workspaceId}`;
    const projectWebhooks = getYouTrackProjectWebhooks(config).map((item) => {
      const target =
        item.targetUrl ||
        buildYouTrackProjectWebhookUrl(publicBaseUrl, workspaceId, item.id);

      return exposeYouTrackProjectWebhook({
        ...item,
        targetUrl: target,
      });
    });
    const status =
      webhook.status ||
      (webhook.token || projectWebhooks.length ? "manual_setup" : "not_setup");

    return {
      provider,
      supported: true,
      connected: true,
      mode: "manual",
      status,
      targetUrl,
      headerName: webhook.headerName || DEFAULT_YOUTRACK_HEADER,
      token: webhook.token || null,
      tokenPreview: webhook.tokenPreview || null,
      projectWebhooks,
      lastSetupAt: webhook.lastSetupAt || null,
      lastEventAt: webhook.lastEventAt || null,
      instructions: [
        "Install or enable the YouTrack Webhook Triggers app.",
        "Create one project webhook per YouTrack project you want to sync.",
        "Set each project's URL, header name, and token in YouTrack.",
      ],
    };
  }

  if (provider === "asana") {
    const subscriptions = Array.isArray(webhook.subscriptions)
      ? webhook.subscriptions
      : [];

    return {
      provider,
      supported: true,
      connected: true,
      mode: "automatic",
      status: webhook.status || (subscriptions.length ? "active" : "not_setup"),
      targetBaseUrl: webhook.targetBaseUrl || normalizeBaseUrl(publicBaseUrl),
      subscriptions: subscriptions.map((subscription) => ({
        resourceType: subscription.resourceType,
        resourceGid: subscription.resourceGid,
        resourceName: subscription.resourceName,
        webhookGid: subscription.webhookGid,
        status: subscription.status,
        createdAt: subscription.createdAt,
      })),
      lastSetupAt: webhook.lastSetupAt || null,
      lastEventAt: webhook.lastEventAt || null,
      lastError: webhook.lastError || null,
    };
  }

  return {
    provider,
    supported: false,
    connected: true,
    status: "unsupported",
  };
}

export async function getIntegrationWebhookStatus({
  workspaceId,
  publicBaseUrl,
  provider = null,
}) {
  const providers = provider ? [provider] : ["asana", "youtrack"];
  const statuses = {};

  for (const item of providers) {
    const config = await getIntegrationConfig(workspaceId, item);
    statuses[item] = safeWebhookStatus(config, item, publicBaseUrl, workspaceId);
  }

  return provider ? statuses[provider] : statuses;
}
