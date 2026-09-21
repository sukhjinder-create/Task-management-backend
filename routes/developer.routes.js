import express from "express";

const router = express.Router();

export function buildOpenApiDocument(origin = "https://api.asystence.com") {
  const security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
  const ok = { description: "Successful response", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } };
  return {
    openapi: "3.1.0",
    info: {
      title: "Asystence Enterprise API",
      version: "1.0.0",
      description: "Workspace-scoped API for work, outcome assurance, integrations, and enterprise automation.",
    },
    servers: [{ url: origin }],
    tags: ["Tasks", "Projects", "Assurance", "Webhooks", "OAuth"].map((name) => ({ name })),
    paths: {
      "/oauth/token": {
        post: { tags: ["OAuth"], summary: "Exchange service-account credentials", security: [], requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["grant_type"], properties: { grant_type: { const: "client_credentials" }, client_id: { type: "string" }, client_secret: { type: "string" }, scope: { type: "string" } } } } } }, responses: { 200: ok, 401: { description: "Invalid client credentials" } } },
      },
      "/tasks": {
        get: { tags: ["Tasks"], summary: "List workspace tasks", security, responses: { 200: ok } },
        post: { tags: ["Tasks"], summary: "Create a task", security, requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }, responses: { 201: ok } },
      },
      "/tasks/{id}": {
        get: { tags: ["Tasks"], summary: "Get a task", security, parameters: [{ $ref: "#/components/parameters/Id" }], responses: { 200: ok, 404: { description: "Not found" } } },
        put: { tags: ["Tasks"], summary: "Update a task", security, parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }, responses: { 200: ok } },
      },
      "/projects": {
        get: { tags: ["Projects"], summary: "List workspace projects", security, responses: { 200: ok } },
        post: { tags: ["Projects"], summary: "Create a project", security, requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }, responses: { 201: ok } },
      },
      "/assurance/commitments": {
        get: { tags: ["Assurance"], summary: "List governed outcomes", security, responses: { 200: ok } },
        post: { tags: ["Assurance"], summary: "Create a governed outcome", security, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["outcome", "successMeasure", "targetDate", "ownerId"], properties: { outcome: { type: "string" }, successMeasure: { type: "string" }, targetDate: { type: "string", format: "date" }, ownerId: { type: "string", format: "uuid" } } } } } }, responses: { 201: ok } },
      },
      "/webhooks": {
        get: { tags: ["Webhooks"], summary: "List webhook subscriptions", security, responses: { 200: ok } },
        post: { tags: ["Webhooks"], summary: "Create a signed webhook subscription", security, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "url", "events"], properties: { name: { type: "string" }, url: { type: "string", format: "uri" }, secret: { type: "string" }, events: { type: "array", items: { type: "string" } } } } } } }, responses: { 201: ok } },
      },
    },
    components: {
      parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } } },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "User or OAuth client-credentials access token." },
        apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
  };
}

router.get("/openapi.json", (req, res) => {
  const origin = String(process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.set("Cache-Control", "public, max-age=300").json(buildOpenApiDocument(origin));
});

router.get("/quickstart", (_req, res) => res.json({
  authentication: ["OAuth 2.0 client_credentials", "Workspace API key"],
  tokenEndpoint: "/oauth/token",
  openapi: "/developer/openapi.json",
  webhookHeaders: ["X-Asystence-Delivery", "X-Asystence-Timestamp", "X-Asystence-Signature"],
  scimBasePath: "/scim/v2",
}));

export default router;
