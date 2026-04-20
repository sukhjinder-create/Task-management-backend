/**
 * Smart Browser Testing Engine — DOM-First, Zero Hallucination
 *
 * Core principle: Playwright discovers REAL elements from the live DOM.
 * LLM is never used to generate steps. LLM is only called once at the end
 * to write a narrative summary of what was found.
 *
 * Flow:
 *   1. Navigate to URL
 *   2. Detect login wall → pause run → emit socket event → wait for user credentials → login
 *   3. Discover all same-origin nav modules
 *   4. For each module: DOM-scan every real element → test each one systematically
 *   5. Compile professional QA report
 */

import { chromium } from "playwright";
import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";
import { createRunController } from "./testingRunControl.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CREDENTIAL_POLL_MS = 3000;
const CREDENTIAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ACTION_TIMEOUT_MS = 8000;
const NAV_TIMEOUT_MS = 20000;
const MAX_BUTTONS_PER_PAGE = 25;
const MAX_LINKS_PER_PAGE = 15;
const MAX_MODULES = 10;
const MAX_FORMS_PER_PAGE = 5;
const MAX_TABS_PER_PAGE = 20;
const MAX_SELECTS_PER_PAGE = 10;

// Buttons that could destroy data — skip them during automated testing
const DANGEROUS_BUTTON_RE = /\b(delete|remove|archive|destroy|purge|wipe|logout|sign.?out|log.?out|reset.?all|clear.?all|discard)\b/i;

// ─── Utilities ────────────────────────────────────────────────────────────────

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return "{}"; }
}

async function shot(page) {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 65, fullPage: false });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch { return null; }
}

async function patchRun(runId, patch) {
  try {
    await pool.query(
      `UPDATE testing_agent_runs
       SET output_json = output_json || $2::jsonb
       WHERE id = $1`,
      [runId, safeJson(patch)]
    );
  } catch { /* non-fatal */ }
}

// Append step result to stepResults array in output_json so the LiveRunPanel
// can show real-time progress while the test is executing.
async function appendStep(runId, result) {
  const step = {
    status: result.passed ? "passed" : "failed",
    action: result.action,
    description: result.step,
    screenshot: result.screenshot || null,
    error: result.error || null,
  };
  try {
    await pool.query(
      `UPDATE testing_agent_runs
       SET output_json = jsonb_set(
         COALESCE(output_json, '{}'),
         '{stepResults}',
         COALESCE(output_json->'stepResults', '[]'::jsonb) || $2::jsonb
       )
       WHERE id = $1`,
      [runId, safeJson([step])]
    );
    // Also update currentScreen so the live screenshot panel refreshes
    if (result.screenshot) {
      await pool.query(
        `UPDATE testing_agent_runs
         SET output_json = jsonb_set(
           COALESCE(output_json, '{}'),
           '{currentScreen}',
           $2::jsonb
         )
         WHERE id = $1`,
        [runId, safeJson({ screenshot: result.screenshot, caption: result.step, ts: Date.now() })]
      );
    }
  } catch { /* non-fatal */ }
}

// Parse URL, email, password from free-form instruction text (e.g. "guided" mode)
function parseInstructions(text) {
  const raw = String(text || "").trim();
  const urlMatch = raw.match(/https?:\/\/[^\s,'"]+/);
  const emailMatch = raw.match(/(?:email|login|username|user)\s*[:\-=]\s*([^\s,'"]+@[^\s,'"]+)/i);
  const passMatch  = raw.match(/(?:password|pass|pwd)\s*[:\-=]\s*([^\s,'"]+)/i);
  return {
    url:      urlMatch?.[0]   || null,
    email:    emailMatch?.[1] || null,
    password: passMatch?.[1]  || null,
  };
}

// ─── DOM Scanner ─────────────────────────────────────────────────────────────
// Everything here runs inside page.evaluate() — pure browser JS, no LLM.

async function scanDOM(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.visibility !== "hidden"
        && s.display !== "none"
        && parseFloat(s.opacity) > 0;
    }

    function sel(el) {
      // Build the most stable selector possible, in preference order
      if (el.id) {
        try { return `#${CSS.escape(el.id)}`; } catch { return `#${el.id}`; }
      }
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-cy") || el.getAttribute("data-qa");
      if (testId) return `[data-testid="${testId}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.length < 80) return `[aria-label="${ariaLabel}"]`;
      if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && el.name) {
        return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      }
      // Walk up to build a unique path (max 4 levels)
      const parts = [];
      let curr = el;
      for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
        let s = curr.tagName.toLowerCase();
        if (curr.id) { try { s = `#${CSS.escape(curr.id)}`; } catch { s = `#${curr.id}`; } parts.unshift(s); break; }
        const sibs = curr.parentElement
          ? [...curr.parentElement.children].filter(c => c.tagName === curr.tagName)
          : [];
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(curr) + 1})`;
        parts.unshift(s);
        curr = curr.parentElement;
      }
      return parts.join(" > ");
    }

    function label(el) {
      if (el.id) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) return lbl.textContent?.trim() || "";
        } catch { /* ignore */ }
      }
      const a = el.getAttribute("aria-label");
      if (a) return a;
      const lb = el.getAttribute("aria-labelledby");
      if (lb) { const l = document.getElementById(lb); if (l) return l.textContent?.trim() || ""; }
      let p = el.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        const l = p.querySelector("label");
        if (l) return l.textContent?.trim() || "";
      }
      return el.placeholder || el.name || "";
    }

    const seenSel = new Set();
    function fresh(el) {
      const s = sel(el);
      if (seenSel.has(s)) return false;
      seenSel.add(s);
      return true;
    }

    // ── Buttons ──────────────────────────────────────────────────────────────
    const buttons = [];
    document.querySelectorAll(
      'button:not([disabled]), [role="button"]:not([aria-disabled="true"]), input[type="submit"]:not([disabled]), input[type="button"]:not([disabled])'
    ).forEach(el => {
      if (!visible(el) || !fresh(el)) return;
      buttons.push({
        selector: sel(el),
        text: (el.textContent?.trim() || el.value || el.getAttribute("aria-label") || "").slice(0, 100),
        type: el.getAttribute("type") || "button",
      });
    });

    // ── Inputs ───────────────────────────────────────────────────────────────
    const inputs = [];
    document.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([disabled]), textarea:not([disabled])"
    ).forEach(el => {
      if (!visible(el) || !fresh(el)) return;
      inputs.push({
        selector: sel(el),
        inputType: el.type || "text",
        label: label(el),
        placeholder: el.placeholder || "",
        name: el.name || "",
        required: el.required || false,
      });
    });

    // ── Selects ──────────────────────────────────────────────────────────────
    const selects = [];
    document.querySelectorAll("select:not([disabled])").forEach(el => {
      if (!visible(el) || !fresh(el)) return;
      selects.push({
        selector: sel(el),
        label: label(el),
        name: el.name || "",
        options: [...el.options].slice(0, 10).map(o => ({ value: o.value, text: o.text.trim() })),
      });
    });

    // ── Tabs ─────────────────────────────────────────────────────────────────
    const tabs = [];
    document.querySelectorAll('[role="tab"]').forEach(el => {
      if (!visible(el) || !fresh(el)) return;
      tabs.push({
        selector: sel(el),
        text: (el.textContent?.trim() || el.getAttribute("aria-label") || "").slice(0, 80),
        selected: el.getAttribute("aria-selected") === "true",
      });
    });

    // ── Internal links ───────────────────────────────────────────────────────
    const links = [];
    const origin = window.location.origin;
    const currentPath = window.location.href;
    document.querySelectorAll("a[href]").forEach(el => {
      if (!visible(el) || !fresh(el)) return;
      const href = el.href;
      if (!href || !href.startsWith(origin)) return;
      if (href === currentPath) return;
      // Skip hash-only changes on the same page
      try {
        const u = new URL(href);
        if (u.origin + u.pathname === window.location.origin + window.location.pathname && u.hash) return;
      } catch { return; }
      links.push({
        selector: sel(el),
        text: (el.textContent?.trim() || el.getAttribute("aria-label") || href.replace(origin, "")).slice(0, 80),
        href,
      });
    });

    // ── Forms ────────────────────────────────────────────────────────────────
    const forms = [];
    document.querySelectorAll("form").forEach(frm => {
      if (!visible(frm)) return;
      const fields = [...frm.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]):not([type=button]):not([disabled]), textarea:not([disabled]), select:not([disabled])"
      )].filter(visible);
      if (fields.length === 0) return;
      const submitEl = frm.querySelector(
        'button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled]), button:not([type]):not([disabled])'
      );
      forms.push({
        selector: sel(frm),
        submitSelector: submitEl ? sel(submitEl) : null,
        fieldCount: fields.length,
        fields: fields.slice(0, 12).map(f => ({
          sel: sel(f),
          type: f.type || "text",
          name: f.name || "",
          placeholder: f.placeholder || "",
          label: label(f),
          required: f.required || false,
          tag: f.tagName.toLowerCase(),
        })),
      });
    });

    return { buttons, inputs, selects, tabs, links, forms };
  }).catch(() => ({ buttons: [], inputs: [], selects: [], tabs: [], links: [], forms: [] }));
}

// ─── Error Detector ───────────────────────────────────────────────────────────

async function findErrors(page) {
  return page.evaluate(() => {
    const sels = [
      "[role=alert]",
      ".error", ".error-message", ".alert-danger", ".alert-error",
      '[class*="error" i]:not(label):not(span)', '[class*="Error"]:not(label)',
      ".invalid-feedback", ".field-error", ".form-error",
      '[aria-live="assertive"]',
      ".toast-error", ".notification-error", ".snackbar-error",
    ];
    const found = new Set();
    for (const s of sels) {
      try {
        document.querySelectorAll(s).forEach(el => {
          const t = el.textContent?.trim();
          if (t && t.length > 2 && t.length < 400) found.add(t);
        });
      } catch { /* ignore bad selector */ }
    }
    return [...found];
  }).catch(() => []);
}

// ─── Test Value Generator ─────────────────────────────────────────────────────
// Deterministic values per field type — no LLM, no randomness

function testValue(field) {
  const type = (field.type || field.inputType || "text").toLowerCase();
  const hint = (field.name + " " + field.label + " " + field.placeholder).toLowerCase();

  if (type === "email" || hint.includes("email")) return "qa.auto@example.com";
  if (type === "password" || hint.includes("password")) return "QaTest@2024!";
  if (type === "tel" || hint.includes("phone") || hint.includes("mobile")) return "+15550100";
  if (type === "number" || hint.includes("amount") || hint.includes("price") || hint.includes("qty")) return "10";
  if (type === "date") return "2024-06-15";
  if (type === "time") return "10:00";
  if (type === "month") return "2024-06";
  if (type === "week") return "2024-W24";
  if (type === "color") return "#3b82f6";
  if (type === "range") return "50";
  if (type === "url" || hint.includes("url") || hint.includes("website") || hint.includes("link")) return "https://example.com";
  if (hint.includes("first name") || hint.includes("firstname")) return "QA";
  if (hint.includes("last name") || hint.includes("lastname")) return "Tester";
  if (hint.includes("name") || hint.includes("title")) return "QA Tester";
  if (hint.includes("company") || hint.includes("organisation") || hint.includes("organization")) return "Test Corp";
  if (hint.includes("city")) return "Test City";
  if (hint.includes("zip") || hint.includes("postal")) return "12345";
  if (hint.includes("address") || hint.includes("street")) return "123 Test Lane";
  if (hint.includes("search") || hint.includes("query") || hint.includes("keyword") || hint.includes("filter")) return "test";
  if (hint.includes("subject")) return "QA Test Subject";
  if (hint.includes("description") || hint.includes("comment") || hint.includes("message") || hint.includes("note") || hint.includes("bio") || type === "textarea") {
    return "Automated QA test entry. Please ignore.";
  }
  return "Test Input";
}

// ─── Login Wall Detection ─────────────────────────────────────────────────────

async function detectLoginWall(page) {
  return page.evaluate(() => {
    function vis(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    }
    const pwInput = document.querySelector('input[type="password"]');
    const hasPw = vis(pwInput);
    const userInput = document.querySelector(
      'input[type="email"], input[autocomplete="username"], input[name*="email" i], input[name*="username" i], input[name*="user" i], input[placeholder*="email" i], input[placeholder*="username" i]'
    );
    const hasUser = vis(userInput);
    const loginBtn = [...document.querySelectorAll("button, input[type=submit]")].find(el =>
      vis(el) && /sign\s*in|log\s*in|login/i.test(el.textContent + (el.value || ""))
    );
    return {
      isLoginWall: hasPw && (hasUser || !!loginBtn),
      pwSelector: hasPw ? "input[type=\"password\"]" : null,
      userSelector: hasUser
        ? (document.querySelector("input[type=\"email\"]") ? "input[type=\"email\"]" : "input[autocomplete=\"username\"], input[name*=\"email\" i], input[name*=\"username\" i]")
        : null,
    };
  }).catch(() => ({ isLoginWall: false }));
}

// ─── Login Performer ──────────────────────────────────────────────────────────

async function doLogin(page, email, password) {
  const userSel = 'input[type="email"], input[autocomplete="username"], input[name*="email" i], input[name*="username" i], input[placeholder*="email" i], input[placeholder*="username" i]';
  const userEl = await page.$(userSel).catch(() => null);
  if (userEl) await userEl.fill(email, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);

  const pwEl = await page.$('input[type="password"]').catch(() => null);
  if (pwEl) await pwEl.fill(password, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);

  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login"), button:has-text("Continue")';
  const submitEl = await page.$(submitSel).catch(() => null);
  if (submitEl) {
    await submitEl.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => null);
    await page.waitForTimeout(3000);
    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch { /* ok */ }
  }
}

// ─── Credential Waiter ────────────────────────────────────────────────────────
// Pauses the run and waits for the user to submit credentials via the API.

async function waitForCredentials(runId, workspaceId, loginUrl) {
  // Emit socket event so frontend can show the credential prompt modal
  try {
    const { emitTestingCredentialRequest } = await import("../realtime/socket.js");
    emitTestingCredentialRequest(workspaceId, runId, loginUrl);
  } catch { /* socket unavailable in test environments */ }

  await pool.query(
    `UPDATE testing_agent_runs
     SET status = 'waiting_input',
         output_json = jsonb_set(COALESCE(output_json,'{}'), '{waitingFor}', $2::jsonb)
     WHERE id = $1`,
    [runId, JSON.stringify({ loginUrl, requestedAt: new Date().toISOString() })]
  );

  const deadline = Date.now() + CREDENTIAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CREDENTIAL_POLL_MS));
    const { rows } = await pool.query(
      `SELECT output_json->'providedCredentials' AS creds FROM testing_agent_runs WHERE id = $1`,
      [runId]
    );
    const raw = rows[0]?.creds;
    if (raw && raw !== "null") {
      const creds = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (creds?.email && creds?.password) {
        await pool.query(
          `UPDATE testing_agent_runs SET status = 'running' WHERE id = $1`,
          [runId]
        );
        return { email: creds.email, password: creds.password };
      }
    }
  }
  throw new Error("Credential timeout — no credentials received within 5 minutes");
}

// ─── Nav Discovery ────────────────────────────────────────────────────────────

async function discoverNavLinks(page) {
  return page.evaluate(() => {
    function vis(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    }
    const origin = window.location.origin;
    const seen = new Set([window.location.href]);
    const links = [];

    // Prefer nav/sidebar/header areas for navigation links
    const navAreas = document.querySelectorAll(
      "nav, header, aside, [role=navigation], .sidebar, .side-nav, .nav, .menu, .navbar, .drawer"
    );
    const scanArea = (root) => {
      root.querySelectorAll("a[href]").forEach(el => {
        if (!vis(el)) return;
        const href = el.href;
        if (!href || !href.startsWith(origin) || seen.has(href)) return;
        try {
          const u = new URL(href);
          // Skip hash-only anchors and external
          if (u.origin !== origin) return;
          if (u.hash && u.pathname === window.location.pathname) return;
        } catch { return; }
        seen.add(href);
        links.push({ href, text: (el.textContent?.trim() || href.replace(origin, "")).slice(0, 60) });
      });
    };

    navAreas.forEach(scanArea);

    // If nav areas gave us nothing useful, fall back to all visible links
    if (links.length < 2) {
      document.querySelectorAll("a[href]").forEach(el => {
        if (!vis(el)) return;
        const href = el.href;
        if (!href || !href.startsWith(origin) || seen.has(href)) return;
        try {
          const u = new URL(href);
          if (u.hash && u.pathname === window.location.pathname) return;
        } catch { return; }
        seen.add(href);
        links.push({ href, text: (el.textContent?.trim() || href.replace(origin, "")).slice(0, 60) });
      });
    }

    return links;
  }).catch(() => []);
}

// ─── Result Builder ───────────────────────────────────────────────────────────

function makeResult(step, action, passed, opts = {}) {
  return {
    step,
    action,
    passed,
    error: opts.error ? String(opts.error).slice(0, 300) : null,
    screenshot: opts.screenshot || null,
    details: opts.details || {},
    timestamp: new Date().toISOString(),
  };
}

// ─── Page Context Builder ─────────────────────────────────────────────────────
// Converts DOM inventory into a string the LLM can reason about.

function buildPageContext(dom, pageTitle) {
  const lines = [`Page Title: "${pageTitle}"`];

  if (dom.forms?.length > 0) {
    lines.push(`\nFORMS (${dom.forms.length}):`);
    dom.forms.slice(0, 3).forEach((f, i) => {
      lines.push(`  Form ${i + 1} — ${f.fieldCount} fields:`);
      f.fields.forEach(field => {
        lines.push(`    selector="${field.sel}" type="${field.type}" name="${field.name}" label="${field.label}" placeholder="${field.placeholder}" required=${field.required}`);
      });
      if (f.submitSelector) lines.push(`    Submit: selector="${f.submitSelector}"`);
    });
  }

  const formSelectors = new Set((dom.forms || []).flatMap(f => f.fields.map(ff => ff.sel)));
  const standalone = (dom.inputs || []).filter(inp => !formSelectors.has(inp.selector));
  if (standalone.length > 0) {
    lines.push(`\nSTANDALONE INPUTS (${standalone.length}):`);
    standalone.slice(0, 8).forEach(inp => {
      lines.push(`  selector="${inp.selector}" type="${inp.inputType}" label="${inp.label}" placeholder="${inp.placeholder}"`);
    });
  }

  const safeBtns = (dom.buttons || []).filter(b => !DANGEROUS_BUTTON_RE.test(b.text));
  if (safeBtns.length > 0) {
    lines.push(`\nBUTTONS (${safeBtns.length}):`);
    safeBtns.slice(0, 12).forEach(btn => {
      lines.push(`  selector="${btn.selector}" text="${btn.text}"`);
    });
  }

  if (dom.tabs?.length > 0) {
    lines.push(`\nTABS (${dom.tabs.length}):`);
    dom.tabs.slice(0, 10).forEach(tab => {
      lines.push(`  selector="${tab.selector}" text="${tab.text}" selected=${tab.selected}`);
    });
  }

  if (dom.selects?.length > 0) {
    lines.push(`\nSELECTS (${dom.selects.length}):`);
    dom.selects.slice(0, 5).forEach(s => {
      lines.push(`  selector="${s.selector}" label="${s.label}" options=[${(s.options || []).slice(0, 4).map(o => `"${o.text}"`).join(",")}]`);
    });
  }

  return lines.join("\n");
}

// ─── Scenario Planner ─────────────────────────────────────────────────────────
// LLM receives the REAL DOM inventory and plans test scenarios.
// It can only reference selectors it was given — zero hallucination.

async function planScenarios(dom, pageTitle, pageUrl) {
  const hasInteraction =
    dom.forms?.length > 0 ||
    (dom.buttons || []).filter(b => !DANGEROUS_BUTTON_RE.test(b.text)).length > 0 ||
    dom.inputs?.length > 0 ||
    dom.selects?.length > 0 ||
    dom.tabs?.length > 0;

  if (!hasInteraction) {
    return { pageIntent: "Static/read-only page", scenarios: [] };
  }

  const inventory = buildPageContext(dom, pageTitle);
  const hasForms = dom.forms?.length > 0;
  const scenarioCount = hasForms ? "4-6" : "2-4";

  const prompt = `You are a senior QA engineer planning automated test scenarios for a web page.

${inventory}

URL: ${pageUrl}

Generate ${scenarioCount} test scenarios covering different testing angles.

AVAILABLE STEP ACTIONS (use exactly these action names):
- fill:              {action:"fill", selector:"<from inventory>", value:"...", description:"..."}
- click:             {action:"click", selector:"<from inventory>", description:"..."}
- clear:             {action:"clear", selector:"<from inventory>", description:"..."}
- select:            {action:"select", selector:"<from inventory>", value:"<option text>", description:"..."}
- assert_no_error:   {action:"assert_no_error", description:"..."} — passes if NO error messages visible
- assert_error:      {action:"assert_error", description:"..."}    — passes if an error message IS visible
- assert_text:       {action:"assert_text", text:"...", description:"..."}
- assert_navigation: {action:"assert_navigation", description:"..."}

STRICT RULES:
1. Only use selectors that appear in the inventory above. Never invent a selector.
2. Scenario categories must be one of: happy_path, error_handling, edge_case, regression
3. Max 7 steps per scenario. Every scenario must end with an assertion step.
4. For forms: always include (a) happy path with valid data, (b) empty submit expecting validation, (c) invalid data expecting error.
5. For tabs: click each tab and assert no error.
6. For buttons: click and assert_no_error (or assert_navigation if it's a link button).

EDGE CASE TEST VALUES:
- Empty: ""
- Long string: "${"x".repeat(200)}"
- Invalid email: "notanemail@@"
- SQL injection: "' OR 1=1 --"
- XSS: "<script>alert(1)</script>"
- Valid email: "qa.tester@example.com"
- Valid password: "QaTest@2024!"

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "pageIntent": "one sentence: what this page does",
  "scenarios": [
    {
      "id": "scen_1",
      "category": "happy_path",
      "name": "descriptive scenario name",
      "steps": [...]
    }
  ]
}`;

  try {
    const raw = await generateText({ prompt, maxTokens: 1600 });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { pageIntent: "", scenarios: [] };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.scenarios)) return { pageIntent: "", scenarios: [] };
    // Keep only scenarios with at least one step
    parsed.scenarios = parsed.scenarios.filter(s => Array.isArray(s.steps) && s.steps.length > 0);
    return parsed;
  } catch {
    return { pageIntent: "", scenarios: [] };
  }
}

// ─── Scenario Executor ────────────────────────────────────────────────────────
// Runs one LLM-planned scenario. All selectors come from real DOM — no invention.

async function executeScenario(page, scenario, pageUrl, runId, runController) {
  const results = [];
  const label = `[${scenario.category}] ${scenario.name}`;
  let failed = false;

  for (const step of (scenario.steps || [])) {
    if (runController?.isCancelled?.()) break;

    try {
      if (step.action === "fill") {
        await page.fill(step.selector, step.value ?? "", { timeout: ACTION_TIMEOUT_MS });
        await page.waitForTimeout(200);

      } else if (step.action === "click") {
        await page.click(step.selector, { timeout: ACTION_TIMEOUT_MS, force: true });
        await page.waitForTimeout(900);
        try { await page.waitForLoadState("networkidle", { timeout: 4000 }); } catch { /* ok */ }

      } else if (step.action === "clear") {
        await page.fill(step.selector, "", { timeout: ACTION_TIMEOUT_MS });

      } else if (step.action === "select") {
        // Try by label text first, then by value
        await page.selectOption(step.selector, { label: step.value }, { timeout: ACTION_TIMEOUT_MS })
          .catch(() => page.selectOption(step.selector, step.value ?? "", { timeout: ACTION_TIMEOUT_MS }));
        await page.waitForTimeout(300);

      } else if (step.action === "assert_no_error") {
        const errors = await findErrors(page);
        const screenshot = await shot(page);
        const passed = errors.length === 0;
        const r = makeResult(
          `${label}: ${step.description || "No errors expected"}`,
          "assert",
          passed,
          { screenshot, error: errors[0] || null, details: { category: scenario.category, scenarioId: scenario.id } }
        );
        results.push(r);
        appendStep(runId, r).catch(() => {});
        if (!passed) { failed = true; break; }

      } else if (step.action === "assert_error") {
        const errors = await findErrors(page);
        const screenshot = await shot(page);
        const passed = errors.length > 0;
        const r = makeResult(
          `${label}: ${step.description || "Error message expected"}`,
          "assert",
          passed,
          {
            screenshot,
            error: passed ? null : "Expected a validation/error message but none appeared",
            details: { category: scenario.category, scenarioId: scenario.id, foundErrors: errors },
          }
        );
        results.push(r);
        appendStep(runId, r).catch(() => {});
        if (!passed) { failed = true; break; }

      } else if (step.action === "assert_text") {
        const bodyText = await page.evaluate(() => document.body.innerText || "").catch(() => "");
        const screenshot = await shot(page);
        const passed = step.text ? bodyText.toLowerCase().includes(step.text.toLowerCase()) : true;
        const r = makeResult(
          `${label}: ${step.description || `Text "${step.text}" present`}`,
          "assert",
          passed,
          { screenshot, error: passed ? null : `Expected text "${step.text}" but not found on page`, details: { category: scenario.category, scenarioId: scenario.id } }
        );
        results.push(r);
        appendStep(runId, r).catch(() => {});
        if (!passed) { failed = true; break; }

      } else if (step.action === "assert_navigation") {
        const currentUrl = page.url();
        const screenshot = await shot(page);
        const navigated = currentUrl !== pageUrl;
        const r = makeResult(
          `${label}: ${step.description || "Page navigation"}`,
          "assert",
          navigated,
          { screenshot, error: navigated ? null : `Expected navigation away from ${pageUrl} but URL unchanged`, details: { category: scenario.category, scenarioId: scenario.id, currentUrl } }
        );
        results.push(r);
        appendStep(runId, r).catch(() => {});
        if (!navigated) { failed = true; break; }
      }

    } catch (err) {
      // Action step failed (element not found, timeout, etc.) → scenario fails here
      const screenshot = await shot(page).catch(() => null);
      const r = makeResult(
        `${label}: ${step.description || step.action} — ${step.selector || ""}`,
        step.action,
        false,
        { screenshot, error: err.message.slice(0, 250), details: { category: scenario.category, scenarioId: scenario.id } }
      );
      results.push(r);
      appendStep(runId, r).catch(() => {});
      failed = true;
      break; // Can't continue scenario after action failure
    }
  }

  // If scenario had no assertion steps, record a neutral summary result
  if (results.length === 0) {
    const r = makeResult(`${label}: completed (no assertions)`, "scenario", !failed, { details: { category: scenario.category, scenarioId: scenario.id } });
    results.push(r);
    appendStep(runId, r).catch(() => {});
  }

  return { scenarioId: scenario.id, category: scenario.category, name: scenario.name, results, failed };
}

// ─── Mechanical Fallback ──────────────────────────────────────────────────────
// Used when LLM returns no scenarios (e.g., on static pages or LLM failure).
// Clicks every element once — better than nothing.

async function mechanicalFallback(page, dom, pageUrl, push, runController) {
  // Tabs
  for (const tab of (dom.tabs || []).slice(0, MAX_TABS_PER_PAGE)) {
    if (runController?.isCancelled?.()) break;
    try {
      await page.click(tab.selector, { timeout: ACTION_TIMEOUT_MS, force: true });
      await page.waitForTimeout(500);
      const errors = await findErrors(page);
      const screenshot = await shot(page);
      push(makeResult(`Tab: "${tab.text}"`, "click_tab", errors.length === 0, { screenshot, error: errors[0] || null }));
    } catch (err) {
      push(makeResult(`Tab: "${tab.text}"`, "click_tab", false, { error: err.message }));
    }
  }

  // Forms
  for (const form of (dom.forms || []).slice(0, MAX_FORMS_PER_PAGE)) {
    if (runController?.isCancelled?.()) break;
    if (form.submitSelector) {
      try {
        await page.click(form.submitSelector, { timeout: ACTION_TIMEOUT_MS, force: true });
        await page.waitForTimeout(600);
        const errs = await findErrors(page);
        const screenshot = await shot(page);
        push(makeResult(`Form validation (${form.fieldCount} fields)`, "form_empty_submit", true, { screenshot, details: { validationErrorsShown: errs.length > 0 } }));
      } catch (err) {
        push(makeResult("Form empty submit", "form_empty_submit", false, { error: err.message }));
      }
    }
    let filled = 0;
    for (const field of form.fields) {
      if (["checkbox", "radio", "file"].includes(field.type)) continue;
      try {
        if (field.tag === "select") {
          const opts = await page.$$eval(`${field.sel} option`, os => os.slice(1, 2).map(o => o.value));
          if (opts[0] != null) await page.selectOption(field.sel, opts[0], { timeout: ACTION_TIMEOUT_MS });
        } else {
          await page.fill(field.sel, testValue(field), { timeout: ACTION_TIMEOUT_MS });
        }
        filled++;
      } catch { /* skip */ }
    }
    if (filled > 0) {
      push(makeResult(`Form fill (${filled}/${form.fieldCount} fields)`, "form_fill", true, { screenshot: await shot(page) }));
    }
  }

  // Buttons
  for (const btn of (dom.buttons || []).filter(b => !DANGEROUS_BUTTON_RE.test(b.text)).slice(0, MAX_BUTTONS_PER_PAGE)) {
    if (runController?.isCancelled?.()) break;
    const beforeUrl = page.url();
    try {
      await page.click(btn.selector, { timeout: ACTION_TIMEOUT_MS, force: true });
      await page.waitForTimeout(900);
      const afterUrl = page.url();
      const errors = await findErrors(page);
      const screenshot = await shot(page);
      if (afterUrl !== beforeUrl) await page.goBack({ timeout: NAV_TIMEOUT_MS }).catch(() => null);
      push(makeResult(`Button: "${btn.text || btn.selector}"`, "click_button", errors.length === 0, { screenshot, error: errors[0] || null, details: { navigated: afterUrl !== beforeUrl } }));
    } catch (err) {
      push(makeResult(`Button: "${btn.text}"`, "click_button", false, { error: err.message }));
    }
  }

  // Selects
  for (const sel of (dom.selects || []).slice(0, MAX_SELECTS_PER_PAGE)) {
    if (runController?.isCancelled?.()) break;
    const option = sel.options?.[1] || sel.options?.[0];
    if (!option?.value) continue;
    try {
      await page.selectOption(sel.selector, option.value, { timeout: ACTION_TIMEOUT_MS });
      await page.waitForTimeout(300);
      const errors = await findErrors(page);
      push(makeResult(`Select: "${sel.label || sel.name}" → "${option.text}"`, "select_option", errors.length === 0, { error: errors[0] || null }));
    } catch (err) {
      push(makeResult(`Select: "${sel.label || sel.name}"`, "select_option", false, { error: err.message }));
    }
  }

  // Links
  for (const link of (dom.links || []).filter((l, i, a) => a.findIndex(x => x.href === l.href) === i).slice(0, MAX_LINKS_PER_PAGE)) {
    if (runController?.isCancelled?.()) break;
    try {
      const resp = await page.goto(link.href, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);
      const status = resp?.status() ?? 0;
      const errors = await findErrors(page);
      const screenshot = await shot(page);
      const passed = status < 400 && errors.length === 0;
      push(makeResult(`Link: "${link.text}"`, "navigate_link", passed, { screenshot, error: !passed ? (errors[0] || `HTTP ${status}`) : null }));
      await page.goto(pageUrl, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => null);
    } catch (err) {
      push(makeResult(`Link: "${link.text}"`, "navigate_link", false, { error: err.message }));
    }
  }
}

// ─── Page Tester ──────────────────────────────────────────────────────────────
// Phase 1: DOM scan (pure browser JS, zero LLM)
// Phase 2: LLM scenario planner (grounded in real DOM — no hallucination)
// Phase 3: Playwright executes each scenario against real selectors
// Fallback: mechanical element-by-element test if LLM returns nothing

async function testPage(page, pageUrl, pageTitle, runId, runController) {
  const dom = await scanDOM(page);
  const allResults = [];
  const scenarioResults = [];

  const push = (r) => {
    allResults.push(r);
    appendStep(runId, r).catch(() => {});
  };

  // Ask LLM to plan scenarios grounded in this page's real DOM
  const plan = await planScenarios(dom, pageTitle, pageUrl);

  if (plan.scenarios && plan.scenarios.length > 0) {
    for (const scenario of plan.scenarios) {
      if (runController?.isCancelled?.()) break;

      // Reset to clean page state before each scenario
      try {
        await page.goto(pageUrl, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);
      } catch { /* ok — carry on */ }

      const scenResult = await executeScenario(page, scenario, pageUrl, runId, runController);
      scenarioResults.push(scenResult);
      allResults.push(...scenResult.results);
    }
  } else {
    // LLM returned nothing useful → fall back to mechanical testing
    await mechanicalFallback(page, dom, pageUrl, push, runController);
  }

  return {
    url: pageUrl,
    title: pageTitle,
    pageIntent: plan.pageIntent || "",
    elementCounts: {
      buttons: dom.buttons?.length ?? 0,
      inputs:  dom.inputs?.length  ?? 0,
      forms:   dom.forms?.length   ?? 0,
      tabs:    dom.tabs?.length    ?? 0,
      links:   dom.links?.length   ?? 0,
      selects: dom.selects?.length ?? 0,
    },
    scenarios: scenarioResults,
    results: allResults,
    testedAt: new Date().toISOString(),
  };
}

// ─── QA Report Builder ────────────────────────────────────────────────────────

async function buildReport(moduleResults, meta) {
  const allResults = moduleResults.flatMap(m => m.results || []);
  const total  = allResults.length;
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 100;

  // Group scenario outcomes by category
  const allScenarios = moduleResults.flatMap(m => m.scenarios || []);
  const CATEGORIES = [
    { key: "happy_path",     label: "Happy Path" },
    { key: "error_handling", label: "Error Handling" },
    { key: "edge_case",      label: "Edge Cases" },
    { key: "regression",     label: "Regression" },
  ];
  const categorySummary = CATEGORIES.map(({ key, label }) => {
    const cats = allScenarios.filter(s => s.category === key);
    return { category: key, label, total: cats.length, passed: cats.filter(s => !s.failed).length, failed: cats.filter(s => s.failed).length };
  }).filter(c => c.total > 0);

  const criticalIssues = allResults
    .filter(r => !r.passed && r.error)
    .slice(0, 20)
    .map(r => ({
      step: r.step,
      action: r.action,
      error: r.error,
      category: r.details?.category || null,
      page: moduleResults.find(m => m.results?.includes(r))?.url || "",
    }));

  // LLM narrative — only for the final 3-4 sentence executive summary
  let narrative = null;
  try {
    const catStr = categorySummary.map(c => `${c.label}: ${c.passed}/${c.total} scenarios passed`).join(", ");
    const issueSummary = criticalIssues.slice(0, 5).map(i => `• ${i.step}: ${i.error}`).join("\n") || "None";
    const prompt = `You are a senior QA engineer writing an executive test report summary.

Application: ${meta.url}
Pages tested: ${moduleResults.length}
Checks: ${passed}/${total} passed (${passRate}% pass rate)
By category: ${catStr || "N/A"}
${criticalIssues.length > 0 ? `\nTop failures:\n${issueSummary}` : "\nNo failures detected."}

Write a 3-4 sentence professional QA executive summary covering: overall health, what worked, what needs attention, and your recommendation. Plain text only, no markdown.`;
    narrative = await generateText({ prompt, maxTokens: 250 });
  } catch { /* report remains useful without narrative */ }

  return {
    meta: { url: meta.url, generatedAt: new Date().toISOString() },
    summary: { total, passed, failed, passRate },
    categorySummary,
    narrative,
    criticalIssues,
    modules: moduleResults.map(m => ({
      url: m.url,
      title: m.title,
      pageIntent: m.pageIntent || "",
      elementCounts: m.elementCounts,
      scenarios: (m.scenarios || []).map(s => ({
        id: s.scenarioId,
        category: s.category,
        name: s.name,
        passed: !s.failed,
        steps: s.results.length,
        failedSteps: s.results.filter(r => !r.passed).length,
      })),
      passed: (m.results || []).filter(r => r.passed).length,
      failed: (m.results || []).filter(r => !r.passed).length,
      testedAt: m.testedAt,
      error: m.error || null,
    })),
    fullResults: moduleResults,
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function runSmartBrowserTest({
  workspaceId,
  taskId,
  url,
  email = null,
  password = null,
  triggeredBy = null,
  triggerSource = "manual",
  timeoutMs = 300000, // 5 minutes default
  onRunCreated = null,
}) {
  if (!url || !url.trim().startsWith("http")) throw new Error("A valid HTTP/HTTPS URL is required");
  url = url.trim();

  const { rows: taskRows } = await pool.query(
    `SELECT id, project_id FROM tasks WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [taskId, workspaceId]
  );
  if (!taskRows[0]) throw new Error("Task not found in workspace");
  const projectId = taskRows[0].project_id;

  const { rows: [run] } = await pool.query(
    `INSERT INTO testing_agent_runs
       (workspace_id, project_id, task_id, trigger_source, mode, status, generated_cases, commands, output_json, created_by)
     VALUES ($1,$2,$3,$4,'smart_browser','running','[]'::jsonb,'[]'::jsonb,$5::jsonb,$6)
     RETURNING *`,
    [workspaceId, projectId, taskId, triggerSource, JSON.stringify({ phase: "starting", url }), triggeredBy || null]
  );
  if (onRunCreated) onRunCreated(run.id);

  const runController = createRunController(run.id);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--window-size=1920,1080",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  page.on("dialog", async d => { try { await d.accept(); } catch { /* ignore */ } });

  const moduleResults = [];
  let finalStatus = "passed";
  let fatalError = null;

  try {
    // ── Phase 1: Navigate ────────────────────────────────────────────────────
    await patchRun(run.id, { phase: "navigating", url });
    const resp = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch { /* ok */ }

    const httpStatus = resp?.status() ?? 0;
    if (httpStatus >= 400) {
      throw new Error(`Page returned HTTP ${httpStatus} — check the URL and try again`);
    }

    // ── Phase 2: Handle login wall ───────────────────────────────────────────
    const loginWall = await detectLoginWall(page);
    if (loginWall.isLoginWall) {
      let loginEmail = email;
      let loginPass = password;

      if (!loginEmail || !loginPass) {
        // Pause and emit socket event — user must provide credentials live
        await patchRun(run.id, { phase: "waiting_credentials", loginUrl: page.url() });
        const creds = await waitForCredentials(run.id, workspaceId, page.url());
        loginEmail = creds.email;
        loginPass = creds.password;
      }

      await patchRun(run.id, { phase: "logging_in" });
      const preLoginScreenshot = await shot(page);
      await doLogin(page, loginEmail, loginPass);

      // Confirm login succeeded
      const stillLoginWall = await detectLoginWall(page);
      if (stillLoginWall.isLoginWall) {
        throw new Error("Login failed — credentials rejected or login form not recognised");
      }
      await patchRun(run.id, { phase: "logged_in", preLoginScreenshot });
    }

    // ── Phase 3: Discover modules from nav ───────────────────────────────────
    await patchRun(run.id, { phase: "discovering_modules" });
    const navLinks = await discoverNavLinks(page);
    const baseOrigin = new URL(url).origin;

    const seenUrls = new Set([page.url()]);
    const modules = [{ href: page.url(), text: await page.title().catch(() => "Home") }];

    for (const link of navLinks) {
      if (modules.length >= MAX_MODULES) break;
      if (seenUrls.has(link.href)) continue;
      // Only same-origin
      try { if (new URL(link.href).origin !== baseOrigin) continue; } catch { continue; }
      seenUrls.add(link.href);
      modules.push(link);
    }

    await patchRun(run.id, { modulesPlanned: modules.map(m => ({ href: m.href, text: m.text })) });

    // ── Phase 4: Test each module ────────────────────────────────────────────
    for (let i = 0; i < modules.length; i++) {
      if (runController?.isCancelled?.()) break;
      const mod = modules[i];

      await patchRun(run.id, {
        phase: "testing",
        currentModule: mod.href,
        moduleIndex: i + 1,
        modulesTotal: modules.length,
      });

      try {
        if (i > 0) {
          await page.goto(mod.href, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1000);
          try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch { /* ok */ }
        }

        const pageTitle = await page.title().catch(() => mod.text || mod.href);
        const initialScreenshot = await shot(page);

        const modResult = await testPage(page, page.url(), pageTitle, run.id, runController);
        modResult.initialScreenshot = initialScreenshot;
        moduleResults.push(modResult);

        // Persist progress after each module
        await patchRun(run.id, { moduleResultsCount: moduleResults.length });
      } catch (modErr) {
        moduleResults.push({
          url: mod.href,
          title: mod.text,
          error: modErr.message,
          elementCounts: {},
          results: [],
          testedAt: new Date().toISOString(),
        });
      }
    }

    // ── Phase 5: Build report ────────────────────────────────────────────────
    await patchRun(run.id, { phase: "building_report" });
    const report = await buildReport(moduleResults, { url, workspaceId });

    const allResults = moduleResults.flatMap(m => m.results || []);
    const failedCount = allResults.filter(r => !r.passed).length;
    finalStatus = failedCount === 0 ? "passed" : "failed_tests";

    await pool.query(
      `UPDATE testing_agent_runs
       SET status = $2, output_json = $3::jsonb, finished_at = NOW()
       WHERE id = $1`,
      [run.id, finalStatus, safeJson({ phase: "complete", report, url })]
    );

  } catch (err) {
    fatalError = err.message;
    await pool.query(
      `UPDATE testing_agent_runs
       SET status = 'failed',
           output_json = jsonb_set(COALESCE(output_json,'{}'), '{fatalError}', $2::jsonb),
           finished_at = NOW()
       WHERE id = $1`,
      [run.id, JSON.stringify(fatalError)]
    );
  } finally {
    await browser.close().catch(() => {});
  }

  if (fatalError) throw new Error(fatalError);
  return { runId: run.id, status: finalStatus, modulesTestedCount: moduleResults.length };
}

// ─── Provide Credentials (called by the route on POST /runs/:runId/provide-credentials) ──

export async function provideRunCredentials(runId, workspaceId, email, password) {
  const { rows } = await pool.query(
    `SELECT id, status FROM testing_agent_runs WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [runId, workspaceId]
  );
  if (!rows[0]) throw new Error("Run not found");
  if (rows[0].status !== "waiting_input") throw new Error("Run is not waiting for credentials");

  await pool.query(
    `UPDATE testing_agent_runs
     SET output_json = jsonb_set(COALESCE(output_json,'{}'), '{providedCredentials}', $2::jsonb)
     WHERE id = $1`,
    [runId, JSON.stringify({ email, password, providedAt: new Date().toISOString() })]
  );
  return { ok: true };
}
