import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenApiDocument } from "../routes/developer.routes.js";

test("enterprise OpenAPI document publishes stable authentication and core paths", () => {
  const document = buildOpenApiDocument("https://api.example.test");
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.servers[0].url, "https://api.example.test");
  assert.equal(document.paths["/oauth/token"].post.security.length, 0);
  assert.ok(document.paths["/tasks"].get.security);
  assert.equal(document.components.securitySchemes.apiKeyAuth.name, "X-API-Key");
});
