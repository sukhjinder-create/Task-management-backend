/**
 * Cloudflare Worker — Workspace Subdomain Router
 *
 * Routes acme.asystence.com → app.asystence.com
 * and sets a cookie so the frontend knows which workspace to load.
 *
 * Deploy: paste this into Cloudflare Workers editor
 */

const APP_DOMAIN = "app.asystence.com";
const ROOT_DOMAIN = "asystence.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Extract subdomain: "acme" from "acme.asystence.com"
    const subdomain = hostname.replace(`.${ROOT_DOMAIN}`, "");

    // Pass through root domain and app subdomain unchanged
    if (subdomain === ROOT_DOMAIN || subdomain === "app" || subdomain === "www" || hostname === ROOT_DOMAIN) {
      return fetch(request);
    }

    // It's a workspace subdomain — proxy to app.asystence.com
    const targetUrl = new URL(url.pathname + url.search, `https://${APP_DOMAIN}`);

    const newRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    const response = await fetch(newRequest);

    // Clone response so we can add the workspace cookie
    const newResponse = new Response(response.body, response);

    // Set workspace slug cookie so the frontend React app knows which workspace
    newResponse.headers.append(
      "Set-Cookie",
      `workspace_slug=${subdomain}; Domain=.${ROOT_DOMAIN}; Path=/; SameSite=Lax; Secure`
    );

    return newResponse;
  },
};
