/**
 * Cloudflare Worker: workspace subdomain router.
 *
 * Required environment bindings:
 *   APP_DOMAIN=app.example.com
 *   ROOT_DOMAIN=example.com
 */

export default {
  async fetch(request, env) {
    const appDomain = String(env.APP_DOMAIN || "").trim();
    const rootDomain = String(env.ROOT_DOMAIN || "").trim();
    if (!appDomain || !rootDomain) {
      return new Response("APP_DOMAIN and ROOT_DOMAIN are required", { status: 500 });
    }

    const url = new URL(request.url);
    const hostname = url.hostname;
    const subdomain = hostname.replace(`.${rootDomain}`, "");

    if (
      subdomain === rootDomain ||
      subdomain === "app" ||
      subdomain === "www" ||
      hostname === rootDomain
    ) {
      return fetch(request);
    }

    const targetUrl = new URL(url.pathname + url.search, `https://${appDomain}`);
    const proxiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    const response = await fetch(proxiedRequest);
    const proxiedResponse = new Response(response.body, response);
    proxiedResponse.headers.append(
      "Set-Cookie",
      `workspace_slug=${subdomain}; Domain=.${rootDomain}; Path=/; SameSite=Lax; Secure`
    );

    return proxiedResponse;
  },
};
