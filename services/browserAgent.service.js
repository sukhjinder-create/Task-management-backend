// services/browserAgent.service.js
import { chromium } from "playwright";
import { generateText } from "../intelligence/llm/llmClient.js";
import pool from "../db.js";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function parseJsonSafe(raw, fallback = null) {
  try {
    let s = String(raw || "").trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    const isArr = s.indexOf("[") !== -1 && (s.indexOf("[") < (s.indexOf("{") === -1 ? Infinity : s.indexOf("{")));
    const open = isArr ? "[" : "{";
    const close = isArr ? "]" : "}";
    const start = s.indexOf(open);
    const end = s.lastIndexOf(close);
    if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function takeScreenshot(page) {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// STEALTH BROWSER FACTORY
// ─────────────────────────────────────────────────────────
async function createStealthBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--window-size=1280,800",
    ],
  });
}

async function createStealthContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  // Mask automation signals
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  return context;
}

// ─────────────────────────────────────────────────────────
// CONSENT + OVERLAY HANDLER
// Handles YouTube "Before you continue", GDPR, cookie banners
// ─────────────────────────────────────────────────────────
async function forceAcceptConsent(page) {
  // Method 1: Direct JS click — finds any visible accept/agree button in the DOM
  const clicked = await page.evaluate(() => {
    const ACCEPT_WORDS = ["accept all", "accept cookies", "agree", "allow all", "got it", "reject all", "continue", "ok"];
    const btns = [...document.querySelectorAll("button, [role='button'], a[href*='consent'], input[type='submit']")];
    for (const btn of btns) {
      const txt = (btn.innerText || btn.value || btn.textContent || "").toLowerCase().trim();
      if (ACCEPT_WORDS.some(w => txt.includes(w)) && btn.offsetParent !== null) {
        btn.click();
        return txt;
      }
    }
    // YouTube consent form — submit it directly
    const form = document.querySelector('form[action*="consent"]');
    if (form) { const btn2 = form.querySelector("button"); if (btn2) { btn2.click(); return "form-submit"; } }
    return null;
  }).catch(() => null);
  if (clicked) { await page.waitForTimeout(600); return true; }
  return false;
}

async function dismissOverlays(page) {
  const url = page.url();

  // If on a dedicated consent page (consent.youtube.com, accounts.google.com, etc.)
  if (url.includes("consent.") || url.includes("accounts.google") || url.includes("/consent")) {
    await forceAcceptConsent(page);
    try { await page.waitForNavigation({ timeout: 5000, waitUntil: "domcontentloaded" }); } catch { /* ok */ }
    await page.waitForTimeout(800);
    return;
  }

  // Generic: try JS-based accept first (instant, no timeout cost)
  const accepted = await forceAcceptConsent(page);
  if (accepted) return;

  // Playwright locator fallback (handles cases where JS click doesn't work due to shadow DOM)
  try {
    const sel = [
      'button:has-text("Accept all")', 'button:has-text("Accept All")',
      'button:has-text("Accept cookies")', 'button:has-text("I accept")',
      'button:has-text("I agree")', 'button:has-text("Agree")',
      'button:has-text("Allow all")', 'button:has-text("Got it")',
      'button:has-text("Reject all")', 'button:has-text("Reject All")',
      '[role="button"]:has-text("Accept all")', '[role="button"]:has-text("Got it")',
      '[aria-label="Close"]', '[aria-label="close"]',
      '#onetrust-accept-btn-handler', '.cc-accept',
    ].join(", ");
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 700 }).catch(() => false);
    if (visible) { await btn.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(300); }
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────
// JS CLICK FALLBACK (for elements that block .click())
// ─────────────────────────────────────────────────────────
async function jsClickFallback(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }
    else throw new Error(`jsClick: no element for "${sel}"`);
  }, selector);
}

// ─────────────────────────────────────────────────────────
// TYPE SLOWLY — mimics human typing (for chat/message inputs)
// Required for contenteditable divs (WhatsApp Web, Discord, Slack)
// ─────────────────────────────────────────────────────────
async function typeSlowly(page, locator, text, delayMs = 40) {
  await locator.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  // Check if it's a contenteditable element
  const isContentEditable = await locator.evaluate((el) =>
    el.contentEditable === "true" || el.isContentEditable
  ).catch(() => false);

  if (isContentEditable) {
    // For contenteditable: click, focus, then keyboard type
    await locator.evaluate((el) => { el.focus(); el.textContent = ""; }).catch(() => {});
    await page.keyboard.type(text, { delay: delayMs });
  } else {
    // For standard inputs: clear then type
    await locator.fill("", { timeout: 3000 }).catch(() => {});
    await page.keyboard.type(text, { delay: delayMs });
  }
}

// ─────────────────────────────────────────────────────────
// SCROLL FEED — scrolls down N times for infinite scroll feeds
// (Twitter, Reddit, Instagram, LinkedIn, TikTok web, etc.)
// ─────────────────────────────────────────────────────────
async function scrollFeed(page, times = 3, pixelsPerScroll = 700, delayMs = 1200) {
  for (let i = 0; i < times; i++) {
    await page.evaluate((px) => window.scrollBy({ top: px, behavior: "smooth" }), pixelsPerScroll);
    await page.waitForTimeout(delayMs);
    // Try to wait for new content to load
    try { await page.waitForLoadState("networkidle", { timeout: 3000 }); } catch { /* ok */ }
  }
}

// ─────────────────────────────────────────────────────────
// IFRAME SEARCH — finds elements inside iframes
// (YouTube embeds, Google reCAPTCHA, chat widgets, etc.)
// ─────────────────────────────────────────────────────────
async function findInIframes(page, selector) {
  try {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const loc = frame.locator(selector).first();
        const visible = await loc.isVisible({ timeout: 800 }).catch(() => false);
        if (visible) return { loc, frame };
      } catch { /* continue */ }
    }
  } catch { /* ignore */ }
  return null;
}

// ─────────────────────────────────────────────────────────
// SHADOW DOM QUERY — pierces shadow roots to find elements
// ─────────────────────────────────────────────────────────
async function queryShadowDom(page, selector) {
  return page.evaluate((sel) => {
    function deepQuery(root, s) {
      const el = root.querySelector(s);
      if (el) return el;
      const shadowHosts = [...root.querySelectorAll("*")].filter((e) => e.shadowRoot);
      for (const host of shadowHosts) {
        const found = deepQuery(host.shadowRoot, s);
        if (found) return found;
      }
      return null;
    }
    const el = deepQuery(document, sel);
    if (!el) return null;
    if (el.id) return `#${el.id}`;
    if (el.className && typeof el.className === "string") return `.${el.className.trim().split(" ")[0]}`;
    return sel;
  }, selector).catch(() => null);
}

// ─────────────────────────────────────────────────────────
// WAIT FOR CHAT RESPONSE — polls DOM until new content appears
// Used by conversation_loop and wait_for_response
// ─────────────────────────────────────────────────────────
async function waitForChatResponse(page, baseline, timeoutMs = 20000, stabilizeMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(500);
    try {
      const current = await page.evaluate(() => document.body.innerText.slice(-1200)).catch(() => "");
      if (current.length > baseline.length + 5) {
        // New content appeared — wait for it to stabilize (streaming responses)
        let prev = current;
        const stabilizeStart = Date.now();
        while (Date.now() - stabilizeStart < stabilizeMs) {
          await page.waitForTimeout(400);
          const next = await page.evaluate(() => document.body.innerText.slice(-1200)).catch(() => current);
          if (next === prev) break;
          prev = next;
        }
        // Return just the new content
        const finalText = await page.evaluate(() => document.body.innerText.slice(-1200)).catch(() => current);
        const newPart = finalText.slice(baseline.length).trim();
        return newPart || finalText.slice(-300).trim();
      }
    } catch { /* ignore */ }
  }
  return ""; // timeout — no response detected
}

// ─────────────────────────────────────────────────────────
// GENERATE CHAT REPLY — LLM generates contextual response
// Used when conversation_loop has no pre-defined messages
// ─────────────────────────────────────────────────────────
async function generateChatReply(history, lastMessage, persona = null) {
  const historyText = history.slice(-6).map((h) =>
    `You sent: "${h.sent}"\nThey replied: "${h.received}"`
  ).join("\n");
  const prompt = `You are having a real conversation on a website.${persona ? ` Personality: ${persona}.` : " Be natural, friendly, and curious."}

Conversation so far:
${historyText || "(this is the start of the conversation)"}

Their latest message: "${lastMessage}"

Write your NEXT reply in 1-2 sentences. Be contextual — respond to what they said. Return ONLY the reply text, no quotes, no labels.`;
  try {
    const reply = String(await generateText({ prompt, maxTokens: 120 })).trim()
      .replace(/^["']|["']$/g, "").replace(/^(reply|response|answer):\s*/i, "").trim();
    return reply || "That's really interesting! Can you tell me more?";
  } catch {
    return "That's really interesting! Can you tell me more?";
  }
}

// ─────────────────────────────────────────────────────────
// INTERPOLATE VARIABLES — replace ${varName} in step values
// Allows extract_text → reuse in later ai_fill / ai_assert
// ─────────────────────────────────────────────────────────
function interpolateVars(value, variables) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => variables[name] ?? "");
}

// ─────────────────────────────────────────────────────────
// EXPAND STEPS — pre-process step list:
//   - Expands repeat: { action:"repeat", times:N, steps:[...] }
//   - Allows nested step blocks
// ─────────────────────────────────────────────────────────
function expandSteps(steps) {
  const out = [];
  for (const step of steps) {
    if (step.action === "repeat") {
      const times = Math.min(step.times || 1, 20); // cap at 20 to prevent runaway
      for (let t = 0; t < times; t++) {
        out.push(...expandSteps(step.steps || []));
      }
    } else {
      out.push(step);
    }
  }
  return out;
}

async function updateRunLive(runId, stepResults) {
  try {
    // For live polling: keep the latest screenshot full, strip older ones.
    // This keeps payloads small while still showing the current screen in the UI.
    const livePayload = stepResults.map((s, i) => {
      const isLast = i === stepResults.length - 1;
      const hasRealShot = s.screenshot && s.screenshot !== true;
      return {
        ...s,
        screenshot: isLast && hasRealShot ? s.screenshot : (hasRealShot ? true : s.screenshot),
      };
    });
    await pool.query(
      `UPDATE testing_agent_runs
       SET output_json = jsonb_set(COALESCE(output_json, '{}'), '{stepResults}', $2::jsonb)
       WHERE id = $1`,
      [runId, JSON.stringify(livePayload)]
    );
  } catch (err) {
    console.warn("[browserAgent] Live update failed:", err.message);
  }
}

// Write current screen snapshot for live video feed (separate from stepResults)
async function updateCurrentScreen(runId, screenshot, caption = "") {
  if (!runId) return;
  try {
    await pool.query(
      `UPDATE testing_agent_runs
       SET output_json = jsonb_set(COALESCE(output_json, '{}'), '{currentScreen}', $2::jsonb)
       WHERE id = $1`,
      [runId, JSON.stringify({ screenshot: screenshot || null, caption, ts: Date.now() })]
    );
  } catch { /* silent */ }
}

// Break-it test payloads for aggressive security/edge testing
const BREAK_TEST_VALUES = {
  xss: '<script>alert("XSS")</script>',
  xssImg: '<img src=x onerror=alert(1)>',
  xssEvent: '"><svg onload=alert(1)>',
  sqlBasic: "' OR '1'='1",
  sqlDrop: "'; DROP TABLE users; --",
  sqlUnion: "' UNION SELECT null,null,null--",
  longString: "A".repeat(5000),
  specialChars: "!@#$%^&*()_+-=[]{}|;':\",./<>?`~\\",
  unicode: "日本語テスト🚀👋🎉",
  emptyString: "",
  whitespaceOnly: "   \t\n   ",
  negativeNum: "-999999",
  zero: "0",
  overflowNum: "99999999999999999",
  floatEdge: "1.7976931348623157e+308",
  jsonInject: '{"$gt": ""}',
  pathTraversal: "../../etc/passwd",
  newlines: "Line1\nLine2\nLine3".repeat(100),
};

// ─────────────────────────────────────────────────────────
// SELF-HEALING LOCATOR
// ─────────────────────────────────────────────────────────
async function smartLocate(page, selector, timeoutMs = 10000) {
  // Guard: invalid selector crashes selector.match() with TypeError
  if (!selector || typeof selector !== "string" || selector.trim() === "") {
    throw new Error(`smartLocate: invalid selector received: "${selector}" — must be a non-empty string`);
  }
  const SHORT = Math.min(timeoutMs, 3000);
  let textHint = null;
  const textMatch = selector.match(/(?:has-text\(['"]?|text=)(['"]?)([^'")\]]+)\1/i);
  if (textMatch) textHint = textMatch[2].trim();

  // Extract words from hint for partial matching
  const hintWords = textHint ? textHint.toLowerCase().split(/\s+/).filter(s => s.length > 2) : [];
  const firstWord = hintWords[0] || null;

  const strategies = [
    selector,
    selector.includes(":nth-child") ? selector.replace(/:\s*nth-child\(\d+\)/gi, "").trim() : null,
    textHint ? `text=${textHint}` : null,
    textHint ? `button:has-text("${textHint}")` : null,
    textHint ? `[role="button"]:has-text("${textHint}")` : null,
    textHint ? `a:has-text("${textHint}")` : null,
    textHint ? `[aria-label="${textHint}"]` : null,
    textHint ? `input[placeholder="${textHint}"]` : null,
    // Broader partial matches for inputs
    firstWord ? `input[placeholder*="${firstWord}"]` : null,
    firstWord ? `[aria-label*="${firstWord}"]` : null,
    firstWord ? `input[name*="${firstWord}"]` : null,
    // Generic search input fallback
    textHint && (textHint.includes("search") || textHint.includes("query"))
      ? `input[type="search"], input[name="search_query"], input[name="q"]`
      : null,
  ].filter(Boolean);

  const seen = new Set();
  const unique = strategies.filter((s) => { if (seen.has(s)) return false; seen.add(s); return true; });

  let lastErr = null;
  for (const s of unique) {
    try {
      const loc = page.locator(s).first();
      await loc.waitFor({ state: "visible", timeout: s === selector ? SHORT : 1500 });
      return { loc, usedSelector: s, healed: s !== selector };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not locate "${selector}" (tried ${unique.length} strategies). ${lastErr?.message?.slice(0, 100)}`);
}

// ─────────────────────────────────────────────────────────
// PERFORMANCE METRICS
// ─────────────────────────────────────────────────────────
async function capturePerformanceMetrics(page) {
  try {
    const data = await page.evaluate(() => {
      // Use modern Navigation Timing API (Level 2)
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        return {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          loadComplete: Math.round(nav.loadEventEnd),
          firstByte: Math.round(nav.responseStart),
          domInteractive: Math.round(nav.domInteractive),
          resourceCount: performance.getEntriesByType("resource").length,
        };
      }
      // Fallback for older browsers
      const t = performance.timing;
      return {
        domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
        loadComplete: t.loadEventEnd - t.navigationStart,
        firstByte: t.responseStart - t.navigationStart,
        domInteractive: t.domInteractive - t.navigationStart,
        resourceCount: performance.getEntriesByType("resource").length,
      };
    });
    if (data.loadComplete < 0 || data.loadComplete > 120000) data.loadComplete = null;
    if (data.firstByte < 0) data.firstByte = null;
    return data;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// AI UTILITIES
// ─────────────────────────────────────────────────────────
async function aiAnalyzeFailure(step, errorMessage) {
  const prompt = `Browser automation step failed. Explain why and how to fix in 2-3 sentences.
Action: ${step.action} | Selector: ${step.selector || "N/A"} | Desc: ${step.description || ""}
Error: ${String(errorMessage || "").slice(0, 200)}
Plain text only, no markdown.`;
  try {
    const raw = await generateText({ prompt, maxTokens: 200 });
    return String(raw || "").trim() || null;
  } catch {
    return null;
  }
}

async function aiIdentifySelector(page, description) {
  // Guard: prevent crash when description is undefined/null/non-string
  if (!description || typeof description !== "string" || description.trim() === "") {
    return `[aria-label*="button" i]`; // safe generic fallback
  }
  const desc = description.toLowerCase();

  // ── Determine intent: is this about a BUTTON/LINK or an INPUT? ──
  const isButtonIntent = /\b(button|click|link|tap|next|submit|sign.?in|log.?in|continue|proceed|confirm|ok)\b/.test(desc);
  const isInputIntent = !isButtonIntent || /\b(input|field|box|bar|type|enter|fill)\b/.test(desc);

  // ── Submit / action buttons (sign in, next, continue, login, ok) ──
  if (isButtonIntent && (
    desc.includes("sign in") || desc.includes("signin") || desc.includes("log in") || desc.includes("login") ||
    desc.includes("next button") || desc.includes("submit") || desc.includes("continue button") ||
    desc.includes("ok button") || desc.includes("proceed")
  )) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector("#passwordNext button") ||
        document.querySelector("#identifierNext button") ||
        document.querySelector("#next") ||
        document.querySelector('button[type="submit"]') ||
        document.querySelector('input[type="submit"]') ||
        document.querySelector('[data-action="save"]') ||
        // Google sign-in spinner buttons
        document.querySelector('.VfPpkd-LgbsSe[jsname]') ||
        null;
      if (!el) return null;
      if (el.id) return `#${el.id}`;
      if (el.getAttribute("jsname")) return `[jsname="${el.getAttribute("jsname")}"]`;
      return 'button[type="submit"]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Search inputs (works on YouTube, Google, Amazon, GitHub, etc.) ──
  if (isInputIntent && (desc.includes("search") || desc.includes("query"))) {
    const found = await page.evaluate(() => {
      const candidates = [
        document.querySelector('input[name="search_query"]'),
        document.querySelector('input[name="q"]'),
        document.querySelector('input[type="search"]'),
        document.querySelector('input[placeholder*="Search" i]'),
        document.querySelector('input[aria-label*="Search" i]'),
        document.querySelector('input[id*="search" i]'),
        document.querySelector('input[name*="search" i]'),
        document.querySelector('[role="searchbox"]'),
      ].filter(Boolean);
      if (!candidates[0]) return null;
      const el = candidates[0];
      if (el.name) return `input[name="${el.name}"]`;
      if (el.id) return `input#${el.id}`;
      if (el.placeholder) return `input[placeholder="${el.placeholder}"]`;
      const label = el.getAttribute("aria-label");
      if (label) return `[aria-label="${label}"]`;
      return "input[type='search']";
    }).catch(() => null);
    if (found) return found;
  }

  // ── Password inputs — ONLY when description is about the input itself ──
  if (isInputIntent && !isButtonIntent && desc.includes("password")) {
    const found = await page.evaluate(() => {
      const el = document.querySelector('input[type="password"]');
      return el ? (el.id ? `#${el.id}` : 'input[type="password"]') : null;
    }).catch(() => null);
    if (found) return found;
  }

  // ── Email / username inputs ──
  if (isInputIntent && !isButtonIntent && (desc.includes("email") || desc.includes("username") || desc.includes("user name"))) {
    const found = await page.evaluate(() => {
      const el = document.querySelector('input[type="email"]') ||
                 document.querySelector('input[name="email"]') ||
                 document.querySelector('input[name="username"]') ||
                 document.querySelector('input[autocomplete="email"]') ||
                 document.querySelector('input[autocomplete="username"]');
      if (!el) return null;
      if (el.name) return `input[name="${el.name}"]`;
      if (el.id) return `#${el.id}`;
      return 'input[type="email"]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── YouTube-specific video card selectors ──
  if (desc.includes("video result") || desc.includes("first video") || desc.includes("video card") || desc.includes("watch") || desc.includes("video link")) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector("ytd-video-renderer a#video-title") ||
        document.querySelector("ytd-rich-item-renderer a#video-title") ||
        document.querySelector("ytd-compact-video-renderer a#video-title") ||
        document.querySelector("a#video-title") ||
        null;
      if (!el) return null;
      const href = el.getAttribute("href");
      return href ? `a[href="${href}"]` : "a#video-title";
    }).catch(() => null);
    if (found) return found;
  }

  // ── YouTube Shorts — scan including off-screen elements ──
  if (desc.includes("short") || desc.includes("reel")) {
    const found = await page.evaluate(() => {
      // Check all anchors on page, not just visible ones
      const allLinks = [...document.querySelectorAll("a[href*='/shorts/']")];
      if (allLinks.length > 0) {
        const href = allLinks[0].getAttribute("href");
        return href ? `a[href="${href}"]` : `a[href*='/shorts/']`;
      }
      const el =
        document.querySelector("ytd-reel-item-renderer a") ||
        document.querySelector("ytd-rich-item-renderer[is-short] a") ||
        null;
      if (el) {
        const href = el.getAttribute("href");
        return href ? `a[href="${href}"]` : null;
      }
      return null;
    }).catch(() => null);
    if (found) return found;
    return "a[href*='/shorts/']";
  }

  // ── Play button (video player) ──
  if (isButtonIntent && (desc.includes("play button") || desc.includes("play video") || (desc.includes("play") && !desc.includes("playlist")))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector(".ytp-play-button") ||
        document.querySelector("[aria-label*='Play']") ||
        document.querySelector("[data-title-no-tooltip='Play']") ||
        null;
      if (!el) return null;
      const label = el.getAttribute("aria-label");
      if (label) return `[aria-label="${label}"]`;
      if (el.className) return `.${el.className.trim().split(" ")[0]}`;
      return ".ytp-play-button";
    }).catch(() => null);
    if (found) return found;
    return ".ytp-play-button";
  }

  // ── Like / heart / upvote buttons (YouTube, Twitter, Reddit, TikTok, Instagram) ──
  if (isButtonIntent && (desc.includes("like") || desc.includes("heart") || desc.includes("upvote") || desc.includes("thumbs up"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label*="like" i]') ||
        document.querySelector('[aria-label*="upvote" i]') ||
        document.querySelector('[data-testid*="like" i]') ||
        document.querySelector('[data-testid="like-button"]') ||
        document.querySelector('#vote-up-count')?.parentElement ||
        document.querySelector('.like-button') ||
        document.querySelector('ytd-toggle-button-renderer[is-icon-button] button') ||
        document.querySelector('[aria-label="Like"]') ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      if (el.id) return `#${el.id}`;
      return '[aria-label*="like" i]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Dislike / downvote buttons ──
  if (isButtonIntent && (desc.includes("dislike") || desc.includes("downvote") || desc.includes("thumbs down"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label*="dislike" i]') ||
        document.querySelector('[aria-label*="downvote" i]') ||
        document.querySelector('[data-testid*="dislike" i]') ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      return '[aria-label*="dislike" i]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Subscribe / follow / unfollow buttons ──
  if (isButtonIntent && (desc.includes("subscribe") || desc.includes("follow") || desc.includes("unfollow") || desc.includes("unsubscribe"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label*="subscribe" i]') ||
        document.querySelector('[aria-label*="follow" i]') ||
        document.querySelector('ytd-subscribe-button-renderer button') ||
        document.querySelector('[data-testid="follow-button"]') ||
        document.querySelector('[data-testid="subscribe-button"]') ||
        [...document.querySelectorAll("button")].find(b => /subscribe|follow/i.test(b.innerText)) ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      const text = (el.innerText || "").trim().slice(0, 30);
      if (text) return `button:has-text("${text}")`;
      return 'ytd-subscribe-button-renderer button';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Comment / reply box (contenteditable for Twitter, YouTube, Facebook, etc.) ──
  if (isInputIntent && (desc.includes("comment") || desc.includes("reply") || desc.includes("write a comment") || desc.includes("add comment"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[placeholder*="comment" i]') ||
        document.querySelector('[aria-label*="comment" i]') ||
        document.querySelector('[aria-label*="Add a comment" i]') ||
        document.querySelector('[data-testid*="comment" i]') ||
        document.querySelector('#simplebox-placeholder') ||
        document.querySelector('.public-DraftEditorPlaceholder-root')?.parentElement?.parentElement ||
        document.querySelector('[contenteditable="true"][aria-label*="comment" i]') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector('textarea[placeholder*="comment" i]') ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      if (el.id) return `#${el.id}`;
      if (el.getAttribute("placeholder")) return `[placeholder="${el.getAttribute("placeholder")}"]`;
      if (el.contentEditable === "true") return '[contenteditable="true"]';
      return 'textarea[placeholder*="comment" i]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Chat / message input (Discord, WhatsApp Web, Slack, chatbots, live chat) ──
  if (isInputIntent && (desc.includes("chat") || desc.includes("message") || desc.includes("send message") || desc.includes("type message") || desc.includes("chatbot"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label*="message" i]') ||
        document.querySelector('[placeholder*="message" i]') ||
        document.querySelector('[placeholder*="chat" i]') ||
        document.querySelector('[data-testid*="message-input" i]') ||
        document.querySelector('[data-testid*="chat-input" i]') ||
        document.querySelector('[contenteditable="true"][aria-label*="message" i]') ||
        document.querySelector('[contenteditable="true"][data-placeholder*="message" i]') ||
        document.querySelector('[contenteditable="true"][data-placeholder*="chat" i]') ||
        // Generic: first visible contenteditable in a chat-like container
        document.querySelector('[role="textbox"]') ||
        document.querySelector('[contenteditable="true"]') ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      if (el.getAttribute("placeholder")) return `[placeholder="${el.getAttribute("placeholder")}"]`;
      if (el.getAttribute("role") === "textbox") return '[role="textbox"]';
      if (el.contentEditable === "true") return '[contenteditable="true"]';
      return null;
    }).catch(() => null);
    if (found) return found;
  }

  // ── Send / submit message buttons (chat) ──
  if (isButtonIntent && (desc.includes("send message") || desc.includes("send button") || desc.includes("send chat") || desc.includes("submit message"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label*="send" i]') ||
        document.querySelector('[data-testid*="send" i]') ||
        document.querySelector('button[type="submit"]') ||
        [...document.querySelectorAll("button")].find(b => /^send$/i.test((b.innerText || "").trim())) ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      return 'button[type="submit"]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Share buttons ──
  if (isButtonIntent && (desc.includes("share") || desc.includes("retweet") || desc.includes("repost"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label*="share" i]') ||
        document.querySelector('[data-testid*="share" i]') ||
        document.querySelector('[aria-label*="retweet" i]') ||
        document.querySelector('[data-testid="retweet"]') ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      return '[aria-label*="share" i]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Canvas / game elements ──
  if (desc.includes("canvas") || desc.includes("game") || desc.includes("draw")) {
    const found = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return null;
      if (canvas.id) return `canvas#${canvas.id}`;
      return "canvas";
    }).catch(() => null);
    if (found) return found;
  }

  // ── Close / dismiss / X buttons ──
  if (isButtonIntent && (desc.includes("close") || desc.includes("dismiss") || desc.includes("cancel") || desc.includes("x button"))) {
    const found = await page.evaluate(() => {
      const el =
        document.querySelector('[aria-label="Close"]') ||
        document.querySelector('[aria-label="close"]') ||
        document.querySelector('[aria-label="Dismiss"]') ||
        document.querySelector('[data-testid="close"]') ||
        document.querySelector('[class*="close" i] button') ||
        document.querySelector('button[class*="close" i]') ||
        null;
      if (!el) return null;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      return '[aria-label="Close"]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Collect page elements and ask LLM ──
  let elements = [];
  try {
    elements = await page.evaluate(() =>
      [...document.querySelectorAll("a,button,input,select,textarea,[role='button'],[role='searchbox'],[tabindex]:not([tabindex='-1'])")].slice(0, 80).map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute("name") || null,
        text: (el.innerText || el.value || "").trim().slice(0, 40) || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        type: el.type || null,
        role: el.getAttribute("role") || null,
      }))
    );
  } catch { /* ignore */ }

  // ── Build selector from elements directly (no LLM) for common cases ──
  // Find best matching input element by scoring
  const inputCandidates = elements.filter(el => ["input", "textarea", "select"].includes(el.tag));
  let scored = [];
  if (inputCandidates.length > 0) {
    scored = inputCandidates.map(el => {
      const fields = [el.placeholder, el.ariaLabel, el.name, el.id, el.text].map(v => (v || "").toLowerCase());
      const score = fields.reduce((s, f) => s + (f && desc.split(" ").some(word => word.length > 2 && f.includes(word)) ? 1 : 0), 0);
      return { el, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    if (scored[0]) {
      const el = scored[0].el;
      if (el.name) return `input[name="${el.name}"]`;
      if (el.id) return `#${el.id}`;
      if (el.placeholder) return `input[placeholder="${el.placeholder}"]`;
      if (el.ariaLabel) return `[aria-label="${el.ariaLabel}"]`;
    }
  }

  // ── LLM fallback ──
  const prompt = `Page elements: ${JSON.stringify(elements).slice(0, 800)}
Find the best Playwright selector for: "${description}"
Rules: id > name > placeholder > aria-label. For inputs use input[name=x] or input[placeholder=x]. NEVER use text= for inputs.
Return ONLY the selector string. No quotes, no explanation.`;
  try {
    const raw = String(await generateText({ prompt, maxTokens: 80 })).trim()
      .replace(/^['"`]|['"`]$/g, "").replace(/^selector:\s*/i, "").trim();
    if (raw && !raw.toLowerCase().startsWith("text=") && raw.length < 200) return raw;
  } catch { /* ignore */ }

  // ── Button / link DOM scoring — LLM-independent fallback for clicks ──
  if (isButtonIntent) {
    const btnCandidates = elements.filter(el =>
      ["a", "button"].includes(el.tag) || el.role === "button" || el.role === "link"
    );
    const descWords = desc.replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 2);
    const btnScored = btnCandidates.map(el => {
      const fields = [el.text, el.ariaLabel, el.id, el.name].map(v => (v || "").toLowerCase());
      const score = fields.reduce((s, f) => s + descWords.filter(w => f.includes(w)).length, 0);
      return { el, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (btnScored[0]) {
      const el = btnScored[0].el;
      if (el.id) return `#${el.id}`;
      if (el.ariaLabel) return `[aria-label="${el.ariaLabel}"]`;
      if (el.text) return `text="${el.text}"`;
    }
  }

  // ── Shadow DOM search (for custom elements, web components) ──
  if (inputCandidates.length === 0 || (scored && scored.length === 0)) {
    const shadowResult = await queryShadowDom(page, `[placeholder*="${desc.split(" ")[0]}" i]`).catch(() => null)
      || await queryShadowDom(page, `[aria-label*="${desc.split(" ")[0]}" i]`).catch(() => null);
    if (shadowResult) return shadowResult;
  }

  // ── Last resort: return aria-label guess ──
  return `[aria-label*="${description.split(" ")[0]}" i]`;
}

// ─────────────────────────────────────────────────────────
// LAYER 4: ELEMENT VALIDATION (pre-flight before action)
// Observe → Plan → Select → [Validate] → Execute → Verify
// ─────────────────────────────────────────────────────────
async function validateElementForAction(page, description) {
  if (!description || typeof description !== "string") {
    return { found: false, loc: null, confidence: 0, selector: null, reason: "invalid description" };
  }

  try {
    const selector = await aiIdentifySelector(page, description);
    if (!selector || typeof selector !== "string") {
      return { found: false, loc: null, confidence: 0, selector: null, reason: "aiIdentifySelector returned nothing" };
    }

    // Try to locate with a short timeout
    let loc = null;
    let usedSelector = selector;
    try {
      const located = await smartLocate(page, selector, 4000);
      loc = located.loc;
      usedSelector = located.usedSelector;
    } catch {
      // Try Playwright role-based fallback
      const words = description.replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 2).slice(0, 3);
      for (const word of words) {
        try {
          const roleLoc = page.getByRole("button", { name: new RegExp(word, "i") }).first();
          const vis = await roleLoc.isVisible({ timeout: 1500 }).catch(() => false);
          if (vis) { loc = roleLoc; usedSelector = `role=button[name~=${word}]`; break; }
        } catch { /* continue */ }
        try {
          const textLoc = page.getByText(new RegExp(word, "i")).first();
          const vis = await textLoc.isVisible({ timeout: 1500 }).catch(() => false);
          if (vis) { loc = textLoc; usedSelector = `text~=${word}`; break; }
        } catch { /* continue */ }
      }
    }

    if (!loc) {
      return { found: false, loc: null, confidence: 0, selector: usedSelector, reason: "element not found in DOM after all strategies" };
    }

    const isVisible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
    const isEnabled = await loc.isEnabled({ timeout: 1000 }).catch(() => true); // assume enabled if check fails

    const confidence = isVisible && isEnabled ? 0.9 : isVisible ? 0.5 : 0.1;
    return { found: isVisible, loc, confidence, selector: usedSelector, reason: isVisible ? "element found and visible" : "element found but not visible" };

  } catch (err) {
    return { found: false, loc: null, confidence: 0, selector: null, reason: err.message.slice(0, 100) };
  }
}

async function generateRunInsights(stepResults, mode = "browser") {
  const defaultInsights = {
    verdict: stepResults.filter((s) => s.status === "failed").length > 0 ? "Some tests failed" : "All tests passed",
    whatWorked: stepResults.filter((s) => s.status === "passed").map((s) => s.description).slice(0, 4),
    whatFailed: stepResults.filter((s) => s.status === "failed").map((s) => s.description).slice(0, 4),
    rootCause: null,
    recommendations: [],
    nextTestsToRun: [],
    performanceNote: null,
  };
  try {
    const passed = stepResults.filter((s) => s.status === "passed").length;
    const failed = stepResults.filter((s) => s.status === "failed").length;
    const failedSummary = stepResults.filter((s) => s.status === "failed")
      .map((s) => `${s.description}: ${String(s.error || "").slice(0, 80)}`).join("; ").slice(0, 400);
    const passedNames = stepResults.filter((s) => s.status === "passed").map((s) => s.description).slice(0, 5).join(", ");

    const prompt = `Test run (${mode}): ${passed} passed, ${failed} failed of ${stepResults.length} steps.
Passed: ${passedNames || "none"}. Failed: ${failedSummary || "none"}.
Return JSON only (no markdown):
{"verdict":"All tests passed|Some tests failed|Critical failure","whatWorked":["..."],"whatFailed":["..."],"rootCause":"...or null","recommendations":["..."],"nextTestsToRun":["..."],"performanceNote":"...or null"}`;

    const raw = await generateText({ prompt, maxTokens: 500 });
    const parsed = parseJsonSafe(raw, null);
    if (parsed && typeof parsed === "object") return { ...defaultInsights, ...parsed };
  } catch { /* fall through */ }
  return defaultInsights;
}

// ─────────────────────────────────────────────────────────
// STEP PARSER (NL → structured steps)
// ─────────────────────────────────────────────────────────
async function parseInstructionsToSteps(instructions, pageContext = null) {
  const today = new Date().toISOString().split("T")[0];
  const pageHint = pageContext
    ? `\nREAL PAGE ELEMENTS (scanned from the actual page — ONLY create steps for these, NEVER invent modules or links not listed here):\nClickable/Nav: [${pageContext.navList || "none"}]\nInput fields: [${pageContext.inputList || "none"}]\nIf the instruction says "test all modules", only test the modules that appear in the Clickable/Nav list above.\n`
    : "";
  const prompt = `You are a browser automation assistant. Convert ANY human web instruction into Playwright automation steps.

INSTRUCTIONS: "${instructions}"
${pageHint}
Return ONLY a valid JSON array. No markdown, no explanation.

ACTIONS (pick the right one):
- navigate:             { action, url, description }
- press:                { action, key, description }              — "Enter", "Escape", "Tab", "ArrowDown"
- key_chord:            { action, key, description }              — "Control+a", "Control+c", "Meta+Enter"
- wait:                 { action, ms, description }
- screenshot:           { action, label }
- assert_url:           { action, expected, description }
- ai_click:             { action, description, optional? }       — AI finds & clicks; set optional:true for exploration (module/page navigation that may not exist)
- ai_fill:              { action, description, value }            — AI fills input (including contenteditable)
- ai_assert:            { action, description }                   — AI verifies a condition is true
- ai_hover:             { action, description }                   — hover to reveal tooltip/dropdown
- type_slowly:          { action, description, value, delayMs }   — char-by-char typing for chat/message inputs
- conversation_loop:    { action, chatInput, turns, messages?, initialMessage?, persona?, sendKey?, responseTimeoutMs?, variableName?, until?, maxTurns? }
                          — MULTI-TURN CHAT: types message, waits for response, reads it, generates reply, repeats
                          — messages[] = predefined replies; if omitted, AI auto-generates contextual replies
                          — turns:"auto" + until:"closure" → keeps going until bot says goodbye/done (up to maxTurns)
                          — until:"any natural language condition" → stops when condition is met
                          — variableName stores full conversation history as JSON
- loop_until:           { action, condition, steps:[...], maxIterations?, pauseMs?, failIfNotMet?, jsCondition? }
                          — Repeats inner steps until AI confirms condition is satisfied (e.g. item appears in list)
                          — condition: natural language string like "item appears in results" or "email sent"
- complete_flow:        { action, description, successCondition, maxSteps?, failIfIncomplete? }
                          — Adaptively navigates a multi-step process (checkout, signup wizard, multi-page form)
                          — Agent observes page at each step, decides what to do next, until successCondition met
- wait_for_response:    { action, description, timeoutMs, variableName? } — wait for new content to appear (bot reply, page update)
- extract_text:         { action, description, selector?, variableName }  — read text from element → store in \${varName}
- repeat:               { action, times, steps: [...] }           — repeat inner steps N times (like/scroll N posts)
- if_condition:         { action, condition, then: [...], else?: [...] } — conditional execution
- double_click:         { action, description }
- right_click:          { action, description }
- scroll_to:            { action, description }
- scroll_feed:          { action, times, pixels }                 — infinite scroll feeds (Twitter, Reddit, etc.)
- drag_and_drop:        { action, from, to }
- mouse_move:           { action, x, y, steps }                   — for canvas/games
- mouse_click_at:       { action, x, y, button }                  — click at exact coordinates
- upload_file:          { action, description, filePath }
- go_back:              { action, description }
- go_forward:           { action, description }
- reload:               { action, description }
- open_tab:             { action, url? }                          — open new browser tab
- switch_tab:           { action, index?, urlPattern? }           — switch to tab by index or URL match
- close_tab:            { action }                                — close current tab
- set_cookie:           { action, name, value, domain? }
- clear_cookies:        { action }
- set_storage:          { action, key, value, storageType? }      — "local" or "session"
- read_storage:         { action, key, variableName, storageType? }
- intercept_request:    { action, urlPattern, mockBody?, mockStatus?, abort? }
- check_performance:    { action, description, failOnSlow }
- execute_js:           { action, script, description }           — raw JS (media controls, DOM manipulation)
- emulate_device:       { action, device }                        — "mobile", "tablet", "desktop"

CRITICAL RULES:
1. Always start with navigate
2. NEVER use raw CSS selectors — use ai_click, ai_fill, or execute_js
3. For text inputs, search bars, form fields → ai_fill
4. For chat/messaging apps (Discord, WhatsApp, Slack, chatbots, live chat) → conversation_loop (NOT ai_fill+press)
5. For single chat message → type_slowly + press Enter
6. For buttons, links, icons, tabs, like/share/subscribe → ai_click
7. For video speed/play/pause → execute_js
8. For liking/upvoting a post → ai_click with "like button" or "upvote button"
9. For commenting → ai_fill with "comment box", value=comment text, then ai_click "submit comment button"
10. For infinite scroll feeds (Twitter, Reddit, Instagram) → scroll_feed with times=3
11. For going back → go_back
12. For repeating an action N times (like 10 posts, scroll 5 pages) → repeat with inner steps
13. For reading text from page to use later → extract_text with variableName, then use \${varName} in later steps
14. For opening multiple sites or comparing pages → open_tab then switch_tab
15. Add screenshots at key moments (after navigate, after submit, at end)
16. Generate ALL steps for the FULL instruction. Max 25 steps. Today: ${today}
17. When exploring modules/sections/pages that MAY OR MAY NOT exist (e.g. "explore all modules"), mark those ai_click steps with "optional": true — if the element isn't on the page the step is skipped gracefully instead of failing the run
18. Required steps (login, form submit, core flow) must NOT be optional
19. MOST IMPORTANT: If REAL PAGE ELEMENTS are provided above, you MUST NOT generate ai_click steps for modules, pages, or links that are NOT in the Clickable/Nav list. Do not invent "Analytics", "Reports", "Users" or any other module that doesn't appear in the list. Only navigate to what is confirmed to exist.
20. "CHAT UNTIL CLOSURE/DONE/END/COMPLETE" → conversation_loop with turns:"auto", until:"conversation reaches natural closure or goodbye", maxTurns:25
21. "UNTIL [CONDITION]" in any instruction → use loop_until with that condition, or conversation_loop with until:"that condition"
22. "COMPLETE THE ENTIRE / FULL / END-TO-END [FLOW/PROCESS]" → use complete_flow with successCondition describing the end state
23. "TEST THOROUGHLY / ALL EDGE CASES / COMPREHENSIVE" → generate extra steps: happy path + validation (empty submit) + wrong inputs + boundary conditions. Do NOT stop at just the happy path.
24. "KEEP [DOING X] UNTIL [Y]" → loop_until with condition=Y and inner steps=[the action X]

EXAMPLE 1 — YouTube flow with like + comment:
[
  { "action": "navigate", "url": "https://youtube.com", "description": "Open YouTube" },
  { "action": "ai_fill", "description": "YouTube search bar", "value": "lofi music" },
  { "action": "press", "key": "Enter", "description": "Submit search" },
  { "action": "screenshot", "label": "search_results" },
  { "action": "ai_click", "description": "first video result in search list" },
  { "action": "wait", "ms": 3000, "description": "Video loads" },
  { "action": "execute_js", "script": "const v=document.querySelector('video'); if(v && v.paused) v.play()", "description": "Start video" },
  { "action": "execute_js", "script": "document.querySelector('video').playbackRate = 1.5", "description": "Set speed 1.5x" },
  { "action": "ai_click", "description": "like button" },
  { "action": "ai_click", "description": "comment box to start typing" },
  { "action": "ai_fill", "description": "YouTube comment input box", "value": "Great video!" },
  { "action": "screenshot", "label": "final_state" }
]

EXAMPLE 2 — Full chatbot conversation (agent reads replies and responds intelligently):
[
  { "action": "navigate", "url": "https://chatbase.co/chatbot-demo", "description": "Open chatbot" },
  { "action": "wait", "ms": 2000, "description": "Chat widget loads" },
  { "action": "conversation_loop",
    "chatInput": "chat message input or text box",
    "turns": 4,
    "initialMessage": "Hello! What can you help me with?",
    "persona": "curious user exploring the product",
    "responseTimeoutMs": 15000,
    "variableName": "chatHistory",
    "description": "Have 4-turn conversation with bot"
  },
  { "action": "screenshot", "label": "conversation_complete" },
  { "action": "ai_assert", "description": "chatbot has been responding to messages" }
]

EXAMPLE 3 — Reddit: upvote 5 posts by scrolling + repeating:
[
  { "action": "navigate", "url": "https://reddit.com/r/programming", "description": "Open Reddit" },
  { "action": "screenshot", "label": "feed_loaded" },
  { "action": "repeat", "times": 5, "steps": [
    { "action": "ai_click", "description": "upvote button on first unvoted post" },
    { "action": "scroll_feed", "times": 1, "pixels": 600 },
    { "action": "wait", "ms": 500, "description": "Settle" }
  ]},
  { "action": "screenshot", "label": "after_voting" }
]

EXAMPLE 4 — Multi-tab comparison:
[
  { "action": "navigate", "url": "https://site-a.com", "description": "Open site A" },
  { "action": "extract_text", "description": "main headline or hero title", "variableName": "siteATitle" },
  { "action": "open_tab", "url": "https://site-b.com", "description": "Open site B in new tab" },
  { "action": "extract_text", "description": "main headline or hero title", "variableName": "siteBTitle" },
  { "action": "screenshot", "label": "site_b" },
  { "action": "switch_tab", "index": 0, "description": "Back to site A" },
  { "action": "screenshot", "label": "site_a" }
]

EXAMPLE 5 — Chat until the conversation naturally closes:
[
  { "action": "navigate", "url": "https://myapp.com/chat", "description": "Open chat" },
  { "action": "wait", "ms": 2000, "description": "Chat loads" },
  { "action": "conversation_loop",
    "chatInput": "message input box",
    "turns": "auto",
    "until": "conversation reaches natural closure or agent says goodbye",
    "maxTurns": 25,
    "initialMessage": "Hi, I need help with my order",
    "persona": "customer with a support question",
    "responseTimeoutMs": 30000,
    "variableName": "chatHistory",
    "description": "Chat until closure"
  },
  { "action": "screenshot", "label": "conversation_ended" }
]

EXAMPLE 6 — Complete a multi-step checkout:
[
  { "action": "navigate", "url": "https://shop.com/cart", "description": "Open cart" },
  { "action": "screenshot", "label": "cart" },
  { "action": "complete_flow",
    "description": "Complete the entire checkout process",
    "successCondition": "order confirmation page shown or 'thank you' message visible",
    "maxSteps": 20,
    "failIfIncomplete": false
  },
  { "action": "screenshot", "label": "after_checkout" }
]

EXAMPLE 7 — Test login form thoroughly (happy path + edge cases):
[
  { "action": "navigate", "url": "https://myapp.com/login", "description": "Open login" },
  { "action": "screenshot", "label": "login_page" },
  { "action": "ai_click", "description": "Login submit button without filling anything", "optional": true },
  { "action": "screenshot", "label": "empty_validation" },
  { "action": "ai_assert", "description": "validation error messages visible for required fields" },
  { "action": "ai_fill", "description": "email input", "value": "notanemail" },
  { "action": "ai_fill", "description": "password input", "value": "x" },
  { "action": "ai_click", "description": "Login submit button" },
  { "action": "screenshot", "label": "invalid_inputs" },
  { "action": "ai_assert", "description": "error message shown for invalid credentials" },
  { "action": "ai_fill", "description": "email input", "value": "user@example.com" },
  { "action": "ai_fill", "description": "password input", "value": "CorrectPassword123" },
  { "action": "ai_click", "description": "Login submit button" },
  { "action": "wait", "ms": 2000, "description": "Login processing" },
  { "action": "screenshot", "label": "after_login" },
  { "action": "ai_assert", "description": "logged in successfully, dashboard or home page visible" }
]

Return ONLY the JSON array.`;

  try {
    const raw = await generateText({ prompt, maxTokens: 3000 });
    const steps = parseJsonSafe(raw, null);
    if (Array.isArray(steps) && steps.length > 0) return steps.slice(0, 25);
  } catch (err) {
    console.error("[browserAgent] LLM step parse failed:", err.message);
  }
  return fallbackParseInstructions(instructions);
}

function fallbackParseInstructions(instructions) {
  const steps = [];
  const lines = instructions.split(/[,\n;]+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    const urlMatch = line.match(/https?:\/\/[^\s,]+/);
    if (urlMatch) { steps.push({ action: "navigate", url: urlMatch[0], description: line }); steps.push({ action: "screenshot", label: "Page loaded" }); continue; }
    if (lower.match(/^(go to|open|navigate)/)) { const url = line.match(/https?:\/\/[^\s,]+/)?.[0]; if (url) { steps.push({ action: "navigate", url, description: line }); } continue; }
    if (lower.match(/^(click|press|tap)/)) { steps.push({ action: "ai_click", description: line.replace(/^(click|press|tap)\s+/i, "").trim() }); continue; }
    if (lower.match(/^(type|enter|fill|search for|search)/)) {
      const m = line.match(/(?:type|enter|fill)\s+["']?([^"']+?)["']?\s+(?:in|into|on|at)\s+(.+)/i);
      if (m) steps.push({ action: "ai_fill", description: m[2].trim(), value: m[1].trim() });
      else {
        const searchMatch = line.match(/search(?:\s+for)?\s+["']?([^"']+)/i);
        if (searchMatch) steps.push({ action: "ai_fill", description: "search bar / search input", value: searchMatch[1].trim() });
      }
      continue;
    }
    if (lower.match(/^(set|change)\s.*speed|playback|rate/)) {
      const rateMatch = line.match(/(\d+(?:\.\d+)?)\s*x/i);
      const rate = rateMatch ? rateMatch[1] : "1";
      steps.push({ action: "execute_js", script: `document.querySelector('video').playbackRate = ${rate}`, description: line });
      continue;
    }
    if (lower.match(/^(verify|check|assert|ensure|confirm|see if)/)) { steps.push({ action: "ai_assert", description: line.replace(/^(verify|check|assert|ensure|confirm|see if)\s+/i, "").trim() }); continue; }
    if (lower.includes("screenshot") || lower.includes("snapshot")) { steps.push({ action: "screenshot", label: line }); continue; }
    if (lower.startsWith("wait")) { const ms = Number(line.match(/(\d+)\s*ms/i)?.[1] || (line.match(/(\d+)\s*sec/i)?.[1] ?? 1) * 1000); steps.push({ action: "wait", ms, description: line }); continue; }
    // Default: treat as ai_click for anything else
    if (lower.length > 3) steps.push({ action: "ai_click", description: line });
  }
  if (steps.length > 0 && steps[steps.length - 1]?.action !== "screenshot") steps.push({ action: "screenshot", label: "Final state" });
  return steps;
}

// ─────────────────────────────────────────────────────────
// ENHANCED BROWSER EXECUTOR
// ─────────────────────────────────────────────────────────
async function executeBrowserSteps(steps, timeoutMs = 120000, { runId = null, stopOnFailure = true, _existingPage = null, _existingContext = null, _existingBrowser = null, _resultOffset = 0, liveScreen = false, autoScreenshot = false } = {}) {
  const _ownsBrowser = !_existingPage;
  let liveScreenInterval = null;
  const browser = _existingBrowser || await createStealthBrowser();
  const results = [];
  // Shared variable store — extract_text stores here, ${varName} is interpolated in later steps
  const variables = {};
  // Tab/page registry for multi-tab workflows
  const pages = [];

  // Pre-process: expand repeat blocks into individual steps
  const expandedSteps = expandSteps(steps);

  try {
    const context = _existingContext || await createStealthContext(browser);
    const page = _existingPage || await context.newPage();
    pages.push(page);
    let activePage = page; // pointer to currently active tab

    // Auto-handle browser dialogs (alert, confirm, prompt) — accept by default
    activePage.on("dialog", async (dialog) => {
      try {
        if (dialog.type() === "prompt") await dialog.accept("yes");
        else await dialog.accept();
      } catch { /* ignore */ }
    });

    // Background screen capture for live video feed (every 1.5s)
    if (liveScreen && runId) {
      liveScreenInterval = setInterval(async () => {
        try {
          const shot = await takeScreenshot(activePage);
          if (shot) {
            const caption = results.length > 0
              ? `Step ${results.length + 1} — ${results[results.length - 1]?.description || ""}`.slice(0, 80)
              : "Starting…";
            await updateCurrentScreen(runId, shot, caption);
          }
        } catch { /* ignore */ }
      }, 1500);
    }

    for (let i = 0; i < expandedSteps.length; i++) {
      // Interpolate ${varName} references in value/url/expected fields from extracted variables
      const rawStep = expandedSteps[i];
      const step = {
        ...rawStep,
        value: interpolateVars(rawStep.value, variables),
        url: interpolateVars(rawStep.url, variables),
        expected: interpolateVars(rawStep.expected, variables),
      };
      const t0 = Date.now();
      const result = {
        stepIndex: i + _resultOffset,
        action: step.action,
        description: step.description || step.label || step.action,
        selector: step.selector || null,
        value: step.value || null,
        status: "passed",
        error: null,
        aiAnalysis: null,
        healed: false,
        usedSelector: step.selector || null,
        screenshot: null,
        metrics: null,
        durationMs: 0,
      };

      // Always work on the active tab (multi-tab support)
      const page = activePage;

      try {
        switch (step.action) {
          case "navigate": {
            await page.goto(step.url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1500);
            try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch { /* ok */ }

            // Handle consent redirects — if we landed on a consent/auth page, accept and wait for redirect
            let consentAttempts = 0;
            while (consentAttempts < 3) {
              const curUrl = page.url();
              const onConsentPage = curUrl.includes("consent.") || curUrl.includes("accounts.google") ||
                curUrl.includes("/consent") || curUrl.includes("signin") || curUrl.includes("login");
              if (!onConsentPage) break;
              await forceAcceptConsent(page);
              try { await page.waitForNavigation({ timeout: 4000, waitUntil: "domcontentloaded" }); } catch { /* ok */ }
              await page.waitForTimeout(800);
              consentAttempts++;
            }

            // Also dismiss any in-page overlays (cookie banners, GDPR popups)
            await dismissOverlays(page);
            // Second attempt in case overlay appeared after initial load
            await page.waitForTimeout(500);
            await dismissOverlays(page);

            result.screenshot = await takeScreenshot(page);
            result.metrics = await capturePerformanceMetrics(page);
            break;
          }

          case "click": {
            await dismissOverlays(page);
            const { loc, usedSelector, healed } = await smartLocate(page, step.selector, timeoutMs);
            result.usedSelector = usedSelector; result.healed = healed;
            try {
              await loc.click({ timeout: timeoutMs });
            } catch {
              await jsClickFallback(page, usedSelector);
            }
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          case "fill": {
            const { loc, usedSelector, healed } = await smartLocate(page, step.selector, timeoutMs);
            result.usedSelector = usedSelector; result.healed = healed;
            await loc.click({ timeout: 3000 }).catch(() => {});
            await loc.fill(String(step.value ?? ""), { timeout: timeoutMs });
            break;
          }

          case "ai_click": {
            await dismissOverlays(page);
            result.description = `AI click: ${step.description}`;

            // LAYER 4: Validate element exists before acting (Observe → Plan → Select → Validate → Execute → Verify)
            let locResult = null;
            const validated = await validateElementForAction(page, step.description);
            result.confidence = validated.confidence;

            if (validated.found && validated.confidence >= 0.5) {
              // High-confidence: element found and visible — use it directly
              locResult = { loc: validated.loc, usedSelector: validated.selector, healed: false };
            } else {
              // Lower confidence: try additional recovery strategies
              const sel = validated.selector || await aiIdentifySelector(page, step.description);

              // Attempt 1: AI-identified selector
              try { locResult = await smartLocate(page, sel, timeoutMs); } catch { /* try fallbacks */ }

              // Attempt 2: scroll and retry
              if (!locResult) {
                try {
                  await page.evaluate(() => window.scrollBy(0, 300));
                  await page.waitForTimeout(500);
                  locResult = await smartLocate(page, sel, timeoutMs);
                } catch { /* try fallbacks */ }
              }

              // Attempt 3: Playwright text-based selectors derived from description
              if (!locResult) {
                const descWords = (step.description || "").replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 3);
                for (const word of descWords.slice(0, 4)) {
                  try {
                    const textLoc = page.getByText(new RegExp(word, "i")).first();
                    const vis = await textLoc.isVisible({ timeout: 1500 }).catch(() => false);
                    if (vis) { locResult = { loc: textLoc, usedSelector: `text~=${word}`, healed: true }; break; }
                  } catch { /* continue */ }
                }
              }
              // Attempt 4: role-based locator
              if (!locResult) {
                const namePattern = new RegExp(step.description.split(" ").slice(0, 2).join("|"), "i");
                for (const roleType of ["button", "link", "menuitem", "tab"]) {
                  try {
                    const roleLoc = page.getByRole(roleType, { name: namePattern }).first();
                    const vis = await roleLoc.isVisible({ timeout: 1500 }).catch(() => false);
                    if (vis) { locResult = { loc: roleLoc, usedSelector: `role=${roleType}[name~=${step.description}]`, healed: true }; break; }
                  } catch { /* continue */ }
                }
              }
              // Attempt 5: Full page scan — score ALL visible links/buttons by text similarity
              if (!locResult) {
                try {
                  const pageLinks = await page.evaluate(() =>
                    [...document.querySelectorAll("a, button, [role='button'], [role='link'], [role='menuitem'], [role='tab'], nav a, aside a, li a")]
                      .filter(el => el.offsetParent !== null)
                      .map(el => ({ text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 60) }))
                      .filter(el => el.text.length > 0)
                      .slice(0, 60)
                  ).catch(() => []);
                  const descWords = (step.description || "").toLowerCase().replace(/\bmodule\b/g, "").split(/\s+/).filter(w => w.length > 2);
                  const pageScoredLinks = pageLinks
                    .map(el => ({ el, score: descWords.filter(w => el.text.toLowerCase().includes(w)).length }))
                    .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
                  if (pageScoredLinks[0]) {
                    const loc = page.getByText(pageScoredLinks[0].el.text, { exact: false }).first();
                    const vis = await loc.isVisible({ timeout: 1500 }).catch(() => false);
                    if (vis) { locResult = { loc, usedSelector: `text=${pageScoredLinks[0].el.text}`, healed: true }; }
                  }
                } catch { /* give up */ }
              }
            }

            if (!locResult) {
              if (step.optional) {
                result.status = "skipped";
                result.description = `Optional: "${step.description}" — not found on page (confidence=${validated.confidence.toFixed(2)}), skipped`;
                result.screenshot = await takeScreenshot(page).catch(() => null);
                break;
              }
              throw new Error(`Could not find element to click: "${step.description}" — confidence=${validated.confidence.toFixed(2)}, reason: ${validated.reason}`);
            }

            result.usedSelector = locResult.usedSelector; result.healed = locResult.healed;
            const urlBeforeClick = page.url();
            try {
              await locResult.loc.click({ timeout: timeoutMs });
            } catch {
              // JS-level click as final fallback
              await jsClickFallback(page, locResult.usedSelector);
            }
            // Wait and settle — more time if a navigation happened
            await page.waitForTimeout(600);
            try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch { /* ok */ }
            if (page.url() !== urlBeforeClick) await dismissOverlays(page);
            // VERIFY: take screenshot to confirm action executed
            result.screenshot = await takeScreenshot(page);
            break;
          }

          case "ai_fill": {
            result.description = `AI fill: ${step.description}`;
            let fillLocResult = null;

            // LAYER 4: Validate element exists before filling (Observe → Plan → Select → Validate → Execute)
            const fillValidated = await validateElementForAction(page, step.description);
            result.confidence = fillValidated.confidence;

            if (fillValidated.found && fillValidated.confidence >= 0.5) {
              // High-confidence — element found and visible, use directly
              fillLocResult = { loc: fillValidated.loc, usedSelector: fillValidated.selector, healed: false };
            } else {
              const fillSel = fillValidated.selector || await aiIdentifySelector(page, step.description);

              // Attempt 1: AI-identified selector
              try { fillLocResult = await smartLocate(page, fillSel, timeoutMs); } catch { /* try fallbacks */ }

              // Attempt 2: scroll down and retry
              if (!fillLocResult) {
                try {
                  await page.evaluate(() => window.scrollBy(0, 200));
                  await page.waitForTimeout(400);
                  fillLocResult = await smartLocate(page, fillSel, timeoutMs);
                } catch { /* try fallbacks */ }
              }

              // Attempt 3: broad fallback selectors — catches search bars, login forms on any site
              if (!fillLocResult) {
                const fallbacks = [
                  'input[type="search"]', 'input[name="search_query"]', 'input[name="q"]',
                  'input[placeholder*="Search" i]', '[aria-label*="Search" i]',
                  'input[name*="search" i]', '[role="searchbox"]',
                  'input[type="text"]', 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])',
                  'textarea',
                ];
                for (const fb of fallbacks) {
                  try {
                    const fbLoc = page.locator(fb).first();
                    const fbVis = await fbLoc.isVisible({ timeout: 1000 }).catch(() => false);
                    if (fbVis) { fillLocResult = { loc: fbLoc, usedSelector: fb, healed: true }; break; }
                  } catch { /* continue */ }
                }
              }
            }

            if (!fillLocResult) {
              throw new Error(`Could not find input for: "${step.description}" — confidence=${fillValidated.confidence.toFixed(2)}, reason: ${fillValidated.reason}`);
            }

            result.usedSelector = fillLocResult.usedSelector;
            result.healed = fillLocResult.healed;

            // Check if target is a contenteditable div (chat apps, rich text editors)
            const isContentEditable = await fillLocResult.loc.evaluate((el) =>
              el.contentEditable === "true" || el.isContentEditable
            ).catch(() => false);

            if (isContentEditable) {
              await typeSlowly(page, fillLocResult.loc, String(step.value ?? ""), 30);
            } else {
              await fillLocResult.loc.click({ timeout: 3000 }).catch(() => {});
              await fillLocResult.loc.fill(String(step.value ?? ""), { timeout: timeoutMs });
            }
            break;
          }

          case "ai_assert": {
            result.description = `AI assert: ${step.description}`;
            const assertDesc = (step.description || "").toLowerCase();

            // ── JS-based checks for measurable properties ──
            // Video playback rate check
            if (assertDesc.includes("playback rate") || assertDesc.includes("play speed") || assertDesc.includes("speed") && assertDesc.includes("x")) {
              const rateMatch = step.description.match(/(\d+(?:\.\d+)?)\s*x/i);
              if (rateMatch) {
                const expectedRate = parseFloat(rateMatch[1]);
                const actualRate = await page.evaluate(() => {
                  const v = document.querySelector("video");
                  return v ? v.playbackRate : null;
                }).catch(() => null);
                result.screenshot = await takeScreenshot(page);
                if (actualRate === null) throw new Error(`No video element found on page`);
                if (Math.abs(actualRate - expectedRate) > 0.05) {
                  throw new Error(`Playback rate is ${actualRate}x, expected ${expectedRate}x — rate was reset`);
                }
                break; // assertion passed
              }
            }

            // Video playing check
            if (assertDesc.includes("video is playing") || assertDesc.includes("video playing") || assertDesc.includes("is playing")) {
              const state = await page.evaluate(() => {
                const v = document.querySelector("video");
                return v ? { paused: v.paused, ended: v.ended, currentTime: v.currentTime, readyState: v.readyState } : null;
              }).catch(() => null);
              result.screenshot = await takeScreenshot(page);
              if (!state) throw new Error(`No video element found on page`);
              if (state.paused) throw new Error(`Video is paused (currentTime=${state.currentTime.toFixed(1)}s)`);
              break;
            }

            // Video paused check
            if (assertDesc.includes("video is paused") || assertDesc.includes("paused")) {
              const paused = await page.evaluate(() => { const v = document.querySelector("video"); return v ? v.paused : null; }).catch(() => null);
              result.screenshot = await takeScreenshot(page);
              if (paused === null) throw new Error(`No video element found on page`);
              if (!paused) throw new Error(`Video is still playing, expected paused`);
              break;
            }

            // Element exists check
            if (assertDesc.includes("exists") || assertDesc.includes("visible") || assertDesc.includes("present")) {
              const pageText2 = await page.evaluate(() => document.body.innerText.slice(0, 1500));
              const hasContent = pageText2.trim().length > 50;
              result.screenshot = await takeScreenshot(page);
              if (!hasContent) throw new Error(`Page appears empty — no visible content`);
              break;
            }

            // ── General text-based AI assertion ──
            const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
            result.screenshot = await takeScreenshot(page);
            const assertPrompt = `Page text (first 600 chars): "${pageText.slice(0, 600)}"
Current URL: ${page.url()}
Is this condition true: "${step.description}"?
Reply ONLY with YES or NO.`;
            let assertAnswer = "UNKNOWN";
            try {
              assertAnswer = String(await generateText({ prompt: assertPrompt, maxTokens: 10 })).trim().toUpperCase();
            } catch (llmErr) {
              // LLM unavailable — fall back to page-content heuristic
              const hasContent = pageText.trim().length > 100;
              result.warning = `LLM unavailable (${llmErr.message}) — used content heuristic`;
              assertAnswer = hasContent ? "YES" : "NO";
            }
            if (!assertAnswer.startsWith("YES")) throw new Error(`Assertion failed: "${step.description}" — page content does not confirm this`);
            break;
          }

          case "check_performance": {
            result.metrics = await capturePerformanceMetrics(page);
            result.screenshot = await takeScreenshot(page);
            if (result.metrics) {
              const ms = result.metrics.loadComplete;
              result.description = ms ? `Performance: ${ms}ms load, TTFB ${result.metrics.firstByte}ms, ${result.metrics.resourceCount} resources` : "Performance check";
              if (step.failOnSlow && ms && ms > 3000) throw new Error(`Page too slow: ${ms}ms (threshold: 3000ms)`);
            }
            break;
          }

          case "press": {
            const urlBefore = page.url();
            await page.keyboard.press(step.key || "Enter");
            // Wait for any navigation that might follow (search submit, form submit)
            await page.waitForTimeout(1200);
            try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch { /* ok */ }
            // If URL changed (navigation happened), dismiss any new overlays
            if (page.url() !== urlBefore) await dismissOverlays(page);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          case "wait": {
            await page.waitForTimeout(Number(step.ms) || 1000);
            break;
          }

          case "wait_for_url": {
            await page.waitForURL(step.url, { timeout: timeoutMs });
            result.screenshot = await takeScreenshot(page);
            break;
          }

          case "wait_for_visible": {
            const { loc, usedSelector, healed } = await smartLocate(page, step.selector, timeoutMs);
            result.usedSelector = usedSelector; result.healed = healed;
            await loc.waitFor({ state: "visible", timeout: timeoutMs });
            break;
          }

          case "screenshot": {
            result.screenshot = await takeScreenshot(page);
            result.description = step.label || "Screenshot";
            break;
          }

          case "assert_visible": {
            const { loc, usedSelector, healed } = await smartLocate(page, step.selector, timeoutMs);
            result.usedSelector = usedSelector; result.healed = healed;
            await loc.waitFor({ state: "visible", timeout: timeoutMs });
            result.screenshot = await takeScreenshot(page);
            break;
          }

          case "assert_text": {
            const el = await page.locator(step.selector).first().textContent({ timeout: timeoutMs });
            if (!String(el ?? "").includes(step.expected ?? "")) throw new Error(`Expected "${step.expected}", found "${String(el ?? "").slice(0, 120)}"`);
            break;
          }

          case "assert_url": {
            const url = page.url();
            if (!url.includes(step.expected ?? "")) throw new Error(`Expected URL to contain "${step.expected}", got "${url}"`);
            break;
          }

          case "hover": {
            const { loc, usedSelector, healed } = await smartLocate(page, step.selector, timeoutMs);
            result.usedSelector = usedSelector; result.healed = healed;
            await loc.hover({ timeout: timeoutMs });
            break;
          }

          case "scroll": {
            const { loc, usedSelector, healed } = await smartLocate(page, step.selector, timeoutMs);
            result.usedSelector = usedSelector; result.healed = healed;
            await loc.scrollIntoViewIfNeeded({ timeout: timeoutMs });
            break;
          }

          case "select": {
            await page.locator(step.selector).first().selectOption(step.value, { timeout: timeoutMs });
            break;
          }

          case "execute_js": {
            const script = String(step.script || "void 0");
            // Wrap in function if it's a statement (not an expression)
            const wrappedScript = script.includes("return ") ? `(() => { ${script} })()` : `(() => { return (${script}); })()`;
            let jsResult;
            try {
              jsResult = await page.evaluate(wrappedScript);
            } catch {
              // Fallback: execute as statement
              jsResult = await page.evaluate(`(() => { ${script}; })() `);
            }
            result.description = step.description || `Execute JS: ${script.slice(0, 60)}`;
            if (jsResult !== undefined && jsResult !== null) {
              result._jsResult = String(jsResult).slice(0, 200);
            }
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ═══════════════════════════════════════════════════════════
          // CONVERSATIONAL CHAT — the agent reads responses and replies
          // ═══════════════════════════════════════════════════════════

          // ─── conversation_loop: full multi-turn chat with response detection ───
          case "conversation_loop": {
            const chatInputDesc = step.chatInput || step.inputDescription || "message input";
            // turns:"auto" → run up to maxTurns, stop early on closure detection
            const isAutoMode = step.turns === "auto" || step.until != null;
            const maxTurns = isAutoMode
              ? Math.min(step.maxTurns || 25, 50)
              : Math.min(step.turns || (step.messages?.length) || 3, 50);
            const predefinedMessages = Array.isArray(step.messages) ? step.messages : [];
            const responseTimeout = step.responseTimeoutMs || 30000;
            const sendKey = step.sendKey || "Enter";
            const persona = step.persona || null;
            const untilCondition = step.until || null; // natural language condition to stop
            const conversationHistory = [];

            result.description = isAutoMode
              ? `Conversation until: "${untilCondition || "closure"}" (max ${maxTurns} turns)`
              : `Conversation loop: ${maxTurns} turns`;

            // Detect if bot response signals end of conversation
            async function isClosureResponse(text) {
              if (!text) return false;
              const lower = text.toLowerCase();
              // Hard-coded closure patterns (instant, no LLM call)
              const closurePhrases = [
                "goodbye", "good bye", "bye!", "see you later", "take care", "have a nice day",
                "have a great day", "is there anything else", "anything else i can help",
                "anything else you need", "if you have any other", "feel free to reach",
                "hope that helped", "glad i could help", "my pleasure", "you're welcome, goodbye",
                "conversation ended", "chat closed", "session ended", "thank you for chatting",
              ];
              if (closurePhrases.some((p) => lower.includes(p))) return true;

              // If step has explicit `until` condition, ask AI
              if (untilCondition && conversationHistory.length > 0) {
                const prompt = `Chat turn ${conversationHistory.length}: bot just said: "${text.slice(0, 300)}"\nDoes this satisfy: "${untilCondition}"?\nReply ONLY YES or NO.`;
                const ans = String(await generateText({ prompt, maxTokens: 5 }).catch(() => "NO")).trim().toUpperCase();
                return ans.startsWith("YES");
              }
              return false;
            }

            // Find and cache the chat input selector once
            const chatInputSel = await aiIdentifySelector(page, chatInputDesc);

            for (let turn = 0; turn < maxTurns; turn++) {
              // 1. Determine what to send this turn
              let messageToSend;
              if (predefinedMessages[turn]) {
                messageToSend = predefinedMessages[turn];
              } else if (turn === 0) {
                messageToSend = step.initialMessage || step.firstMessage || "Hello! How can you help me?";
              } else {
                // If steering toward closure, the persona/generateChatReply handles natural flow
                const lastReceived = conversationHistory[conversationHistory.length - 1]?.received || "";
                messageToSend = await generateChatReply(conversationHistory, lastReceived,
                  persona || (untilCondition ? `user trying to reach: ${untilCondition}` : null));
              }

              // 2. Capture DOM baseline so we can detect the response
              const baseline = await page.evaluate(() => document.body.innerText.slice(-1500)).catch(() => "");

              // 3. Find input and type the message
              let inputFound = false;
              try {
                const locResult = await smartLocate(page, chatInputSel, 8000);
                await typeSlowly(page, locResult.loc, messageToSend, step.typeDelayMs || 40);
                inputFound = true;
              } catch {
                // Fallback: try contenteditable or role=textbox
                for (const fb of ['[role="textbox"]', '[contenteditable="true"]', 'textarea', 'input[type="text"]']) {
                  try {
                    const loc = page.locator(fb).first();
                    if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
                      await typeSlowly(page, loc, messageToSend, step.typeDelayMs || 40);
                      inputFound = true;
                      break;
                    }
                  } catch { /* continue */ }
                }
              }
              if (!inputFound) throw new Error(`conversation_loop: could not find chat input ("${chatInputDesc}") on turn ${turn + 1}`);

              // 4. Send the message
              if (step.sendButtonDesc) {
                try {
                  const sendSel = await aiIdentifySelector(page, step.sendButtonDesc);
                  const sendLoc = await smartLocate(page, sendSel, 5000);
                  await sendLoc.loc.click({ timeout: 5000 });
                } catch { await page.keyboard.press(sendKey); }
              } else {
                await page.keyboard.press(sendKey);
              }

              // 5. Wait for the response to appear (with streaming detection)
              const received = await waitForChatResponse(page, baseline, responseTimeout, step.stabilizeMs || 1500);

              // 6. Record this turn
              conversationHistory.push({ turn: turn + 1, sent: messageToSend, received });
              result.screenshot = await takeScreenshot(page);

              // 7. Check for closure / until condition BEFORE deciding to continue
              if (isAutoMode && await isClosureResponse(received)) {
                console.log(`[conversation_loop] Closure detected at turn ${turn + 1}: "${received.slice(0, 80)}"`);
                break;
              }

              // 8. Pause between turns (configurable, default 1s)
              if (turn < maxTurns - 1) await page.waitForTimeout(step.turnDelayMs || 1000);
            }

            result._conversationHistory = conversationHistory;
            result.description = `Conversation: ${conversationHistory.length} turn${conversationHistory.length !== 1 ? "s" : ""}, last reply: "${(conversationHistory[conversationHistory.length - 1]?.received || "").slice(0, 80)}"`;
            if (step.variableName) variables[step.variableName] = JSON.stringify(conversationHistory);
            break;
          }

          // ─── loop_until: repeat inner steps until condition is met ───
          case "loop_until": {
            const maxIter = Math.min(step.maxIterations || 15, 30);
            const condition = step.condition || step.until || "";
            const innerSteps = expandSteps(step.steps || []);
            result.description = `Loop until: "${condition}" (max ${maxIter} iterations)`;

            let iterations = 0;
            let conditionMet = false;

            while (!conditionMet && iterations < maxIter) {
              iterations++;

              // Execute inner steps for this iteration (don't stop on failure)
              for (const innerStep of innerSteps) {
                const innerResult = await executeBrowserSteps([innerStep], Math.min(timeoutMs, 15000), {
                  runId,
                  stopOnFailure: false,
                  _existingPage: page,
                  _existingContext: context,
                  _existingBrowser: browser,
                  _resultOffset: _resultOffset + results.length + iterations,
                });
                // Push sub-step results into the live run
                if (runId && innerResult.length > 0) {
                  const merged = [...results, ...innerResult];
                  await updateRunLive(runId, merged);
                }
              }

              await page.waitForTimeout(step.pauseMs || 800);

              // Check condition
              if (step.jsCondition) {
                conditionMet = await page.evaluate(step.jsCondition).catch(() => false);
              } else if (condition) {
                const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1200)).catch(() => "");
                const ans = String(await generateText({
                  prompt: `Page: "${pageText.slice(0, 500)}" URL: ${page.url()}\nIs this satisfied: "${condition}"?\nReply ONLY YES or NO.`,
                  maxTokens: 5,
                }).catch(() => "NO")).trim().toUpperCase();
                conditionMet = ans.startsWith("YES");
              }
            }

            result.screenshot = await takeScreenshot(page);
            result.description = `Loop completed: ${iterations} iteration${iterations !== 1 ? "s" : ""}, condition ${conditionMet ? "MET" : "NOT MET (max reached)"}`;
            if (!conditionMet && step.failIfNotMet) {
              throw new Error(`loop_until: condition "${condition}" not met after ${iterations} iterations`);
            }
            break;
          }

          // ─── complete_flow: adaptively navigate a multi-step process until success ───
          // Used for checkout, sign-up wizards, multi-step forms, etc.
          case "complete_flow": {
            const flowDesc = step.description || step.goal || "complete the process";
            const successCondition = step.successCondition || step.until || "process completed successfully";
            const maxSteps = Math.min(step.maxSteps || 20, 40);
            result.description = `Complete flow: "${flowDesc}"`;

            let flowDone = false;
            let flowStepCount = 0;

            while (!flowDone && flowStepCount < maxSteps) {
              flowStepCount++;

              // Observe current page state
              await page.waitForTimeout(800);
              await dismissOverlays(page).catch(() => {});

              const pageInfo = await extractPageInfoFull(page).catch(() => ({ elements: [], hasForms: false, hasCreateBtn: false, hasTable: false, hasSearch: false, visibleText: "", title: "" }));
              const modal = await detectOpenModal(page).catch(() => ({ found: false, inputs: [], buttons: [], title: "" }));
              const currentUrl = page.url();
              const visibleText = pageInfo.visibleText.slice(0, 400);

              // Check if success condition is already met
              const checkPrompt = `URL: ${currentUrl}\nPage: "${visibleText.slice(0, 300)}"\nGoal: "${successCondition}"\nIs the goal achieved? Reply ONLY YES or NO.`;
              const isDone = String(await generateText({ prompt: checkPrompt, maxTokens: 5 }).catch(() => "NO")).trim().toUpperCase().startsWith("YES");
              if (isDone) { flowDone = true; break; }

              // Ask LLM what to do next given current page state
              const interactiveEls = pageInfo.elements
                .filter((e) => ["button", "a", "input", "select", "textarea"].includes(e.tag))
                .slice(0, 20)
                .map((e) => `${e.tag}[${e.text || e.placeholder || e.ariaLabel || e.type || ""}]`)
                .join(", ");
              const modalInfo = modal.found
                ? `Open modal: "${modal.title}" with inputs [${modal.inputs.map((i) => i.placeholder || i.ariaLabel || i.name || i.type).join(", ")}] and buttons [${modal.buttons.slice(0, 5).join(", ")}]`
                : "No modal open";

              const nextActionPrompt = `You are completing a task: "${flowDesc}". Goal: "${successCondition}".
Current URL: ${currentUrl}
Page content: "${visibleText}"
Interactive elements: [${interactiveEls}]
${modalInfo}
Step ${flowStepCount} of ${maxSteps}.

What is the SINGLE BEST next action? Return JSON only:
{"action":"ai_click|ai_fill|press|wait|screenshot","description":"...","value":"...if fill"}
If the task is stuck or unclear, action should be "screenshot" to capture state.`;

              const nextRaw = await generateText({ prompt: nextActionPrompt, maxTokens: 150 }).catch(() => null);
              const nextStep = parseJsonSafe(nextRaw, { action: "screenshot", description: `Flow step ${flowStepCount}` });

              // Execute the decided action
              const actionResult = await executeBrowserSteps([nextStep], Math.min(timeoutMs, 12000), {
                runId,
                stopOnFailure: false,
                _existingPage: page,
                _existingContext: context,
                _existingBrowser: browser,
                _resultOffset: _resultOffset + results.length + flowStepCount,
              });
              if (runId && actionResult.length > 0) {
                await updateRunLive(runId, [...results, ...actionResult]);
              }
            }

            result.screenshot = await takeScreenshot(page);
            result.description = `Flow "${flowDesc}": ${flowDone ? "SUCCESS" : `incomplete after ${flowStepCount} steps`}`;
            if (!flowDone && step.failIfIncomplete) {
              throw new Error(`complete_flow: "${successCondition}" not achieved after ${maxSteps} steps`);
            }
            break;
          }

          // ─── wait_for_response: wait until new content appears in the page ───
          case "wait_for_response": {
            result.description = `Wait for response: ${step.description || ""}`;
            const baseline = await page.evaluate(() => document.body.innerText.slice(-1200)).catch(() => "");
            const received = await waitForChatResponse(page, baseline, step.timeoutMs || 20000, step.stabilizeMs || 1500);
            result.screenshot = await takeScreenshot(page);
            if (step.variableName) variables[step.variableName] = received;
            if (!received && step.failOnTimeout) throw new Error("No response detected within timeout");
            result.description = `Response received: "${received.slice(0, 100)}"`;
            break;
          }

          // ─── extract_text: read text from element and store in variable ───
          case "extract_text": {
            result.description = `Extract text: ${step.description}`;
            let extracted = "";
            try {
              const sel = step.selector || await aiIdentifySelector(page, step.description || "element");
              extracted = await page.locator(sel).first().innerText({ timeout: 5000 }).catch(() => "");
            } catch {
              // Fallback: get broader page text
              const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
              extracted = pageText.slice(0, 500);
            }
            if (step.variableName) variables[step.variableName] = extracted.trim();
            result.description = `Extracted "${(extracted || "").slice(0, 80)}" → $\{${step.variableName || "text"}\}`;
            break;
          }

          // ═══════════════════════════════════════════════════════════
          // MULTI-TAB MANAGEMENT
          // ═══════════════════════════════════════════════════════════

          // ─── open_tab: open a new browser tab ───
          case "open_tab": {
            result.description = `Open new tab${step.url ? `: ${step.url}` : ""}`;
            const newPage = await context.newPage();
            newPage.on("dialog", async (d) => { try { await d.accept(); } catch { /* ignore */ } });
            pages.push(newPage);
            activePage = newPage;
            if (step.url) {
              await newPage.goto(step.url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
              await newPage.waitForTimeout(1000);
              await dismissOverlays(newPage);
            }
            result.screenshot = await takeScreenshot(activePage);
            break;
          }

          // ─── switch_tab: switch to tab by index or URL pattern ───
          case "switch_tab": {
            const idx = step.index ?? null;
            const pattern = step.urlPattern || step.url || null;
            if (idx !== null && pages[idx]) {
              activePage = pages[idx];
            } else if (pattern) {
              const match = pages.find((p) => p.url().includes(pattern));
              if (match) activePage = match;
              else throw new Error(`No tab found with URL matching "${pattern}"`);
            } else {
              activePage = pages[pages.length - 1]; // last tab
            }
            result.description = `Switched to tab: ${activePage.url()}`;
            result.screenshot = await takeScreenshot(activePage);
            break;
          }

          // ─── close_tab: close current tab and switch to previous ───
          case "close_tab": {
            result.description = "Close current tab";
            const closedUrl = activePage.url();
            await activePage.close().catch(() => {});
            const idx = pages.indexOf(activePage);
            if (idx > -1) pages.splice(idx, 1);
            activePage = pages[Math.max(0, (idx ?? pages.length) - 1)] || page;
            result.description = `Closed tab (${closedUrl.slice(0, 60)}), now on: ${activePage.url()}`;
            break;
          }

          // ═══════════════════════════════════════════════════════════
          // COOKIE & STORAGE MANAGEMENT
          // ═══════════════════════════════════════════════════════════

          // ─── set_cookie: inject a cookie into the browser context ───
          case "set_cookie": {
            result.description = `Set cookie: ${step.name}`;
            await context.addCookies([{
              name: step.name,
              value: String(step.value ?? ""),
              domain: step.domain || new URL(page.url()).hostname,
              path: step.path || "/",
              httpOnly: step.httpOnly || false,
              secure: step.secure || false,
            }]);
            break;
          }

          // ─── clear_cookies: delete all cookies ───
          case "clear_cookies": {
            result.description = "Clear all cookies";
            await context.clearCookies();
            break;
          }

          // ─── set_storage: set localStorage / sessionStorage value ───
          case "set_storage": {
            const storageType = step.storageType || "local";
            result.description = `Set ${storageType}Storage["${step.key}"]`;
            await page.evaluate(({ type, key, val }) => {
              const store = type === "session" ? sessionStorage : localStorage;
              store.setItem(key, val);
            }, { type: storageType, key: step.key, val: String(step.value ?? "") });
            break;
          }

          // ─── read_storage: read localStorage / sessionStorage into variable ───
          case "read_storage": {
            const storageType = step.storageType || "local";
            result.description = `Read ${storageType}Storage["${step.key}"]`;
            const storageVal = await page.evaluate(({ type, key }) => {
              const store = type === "session" ? sessionStorage : localStorage;
              return store.getItem(key);
            }, { type: storageType, key: step.key }).catch(() => null);
            if (step.variableName) variables[step.variableName] = storageVal ?? "";
            result.description = `Storage["${step.key}"] = "${String(storageVal || "").slice(0, 80)}"`;
            break;
          }

          // ═══════════════════════════════════════════════════════════
          // NETWORK INTERCEPTION
          // ═══════════════════════════════════════════════════════════

          // ─── intercept_request: mock API responses for testing ───
          case "intercept_request": {
            result.description = `Intercept: ${step.urlPattern}`;
            await page.route(step.urlPattern || "**/*", async (route) => {
              if (step.mockBody !== undefined) {
                await route.fulfill({
                  status: step.mockStatus || 200,
                  contentType: step.contentType || "application/json",
                  body: typeof step.mockBody === "string" ? step.mockBody : JSON.stringify(step.mockBody),
                });
              } else if (step.abort) {
                await route.abort(step.abort || "failed");
              } else {
                await route.continue();
              }
            });
            break;
          }

          // ─── stop_intercept: remove all route interceptors ───
          case "stop_intercept": {
            result.description = "Stop all network intercepts";
            await page.unroute("**/*").catch(() => {});
            break;
          }

          // ═══════════════════════════════════════════════════════════
          // CONDITIONAL & FLOW CONTROL
          // ═══════════════════════════════════════════════════════════

          // ─── if_condition: execute steps only if a condition is true ───
          case "if_condition": {
            result.description = `If: ${step.condition}`;
            // Evaluate condition: JS expression or AI check
            let conditionMet = false;
            if (step.jsCondition) {
              conditionMet = await page.evaluate(step.jsCondition).catch(() => false);
            } else if (step.condition) {
              const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => "");
              const answer = String(await generateText({
                prompt: `Page text: "${pageText.slice(0, 500)}" URL: ${page.url()}\nIs this true: "${step.condition}"?\nReply ONLY YES or NO.`,
                maxTokens: 5,
              }).catch(() => "NO")).trim().toUpperCase();
              conditionMet = answer.startsWith("YES");
            }
            result.description = `If "${step.condition}" → ${conditionMet ? "TRUTHY (running then steps)" : "FALSY (running else steps)"}`;
            const branchSteps = expandSteps(conditionMet ? (step.then || []) : (step.else || []));
            // Insert branch steps into the queue right after this step
            expandedSteps.splice(i + 1, 0, ...branchSteps);
            break;
          }

          // ─── assert_no_errors: check console/page for JS errors ───
          case "assert_no_errors": {
            result.description = "Assert no JS errors on page";
            const errors = await page.evaluate(() =>
              window.__testAgentErrors || []
            ).catch(() => []);
            if (errors.length > 0) throw new Error(`JS errors detected: ${errors.slice(0, 3).join("; ")}`);
            // Also check for obvious error pages
            const title = await page.title().catch(() => "");
            if (/error|404|500|forbidden|not found/i.test(title)) {
              throw new Error(`Error page detected: "${title}"`);
            }
            break;
          }

          // ─── inject_error_monitor: inject JS error listener ───
          case "inject_error_monitor": {
            result.description = "Inject JS error monitor";
            await page.evaluate(() => {
              window.__testAgentErrors = [];
              window.addEventListener("error", (e) => window.__testAgentErrors.push(e.message));
              window.addEventListener("unhandledrejection", (e) => window.__testAgentErrors.push(String(e.reason)));
            }).catch(() => {});
            break;
          }

          // ─── type_slowly: character-by-character typing (chat, messaging, bots) ───
          case "type_slowly": {
            result.description = `Type slowly: ${step.description}`;
            const sel = await aiIdentifySelector(page, step.description);
            let locResult = null;
            try { locResult = await smartLocate(page, sel, timeoutMs); } catch { /* fallback */ }
            // iframe check
            if (!locResult) {
              const iframeMatch = await findInIframes(page, sel);
              if (iframeMatch) locResult = { loc: iframeMatch.loc, usedSelector: sel, healed: true };
            }
            if (!locResult) throw new Error(`Could not find input for typing: "${step.description}"`);
            result.usedSelector = locResult.usedSelector; result.healed = locResult.healed;
            await typeSlowly(page, locResult.loc, String(step.value ?? ""), step.delayMs || 50);
            await page.waitForTimeout(300);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── double_click: double-click an element ───
          case "double_click": {
            result.description = `Double-click: ${step.description}`;
            const sel = await aiIdentifySelector(page, step.description);
            const locResult = await smartLocate(page, sel, timeoutMs);
            result.usedSelector = locResult.usedSelector; result.healed = locResult.healed;
            await locResult.loc.dblclick({ timeout: timeoutMs });
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── right_click: context menu on an element ───
          case "right_click": {
            result.description = `Right-click: ${step.description}`;
            const sel = await aiIdentifySelector(page, step.description);
            const locResult = await smartLocate(page, sel, timeoutMs);
            result.usedSelector = locResult.usedSelector; result.healed = locResult.healed;
            await locResult.loc.click({ button: "right", timeout: timeoutMs });
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── hover_and_wait: hover element, wait for tooltip/dropdown ───
          case "hover_and_wait": {
            result.description = `Hover: ${step.description}`;
            const sel = await aiIdentifySelector(page, step.description);
            const locResult = await smartLocate(page, sel, timeoutMs);
            result.usedSelector = locResult.usedSelector; result.healed = locResult.healed;
            await locResult.loc.hover({ timeout: timeoutMs });
            await page.waitForTimeout(step.waitMs || 1000);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── ai_hover: alias for hover_and_wait ───
          case "ai_hover": {
            result.description = `AI hover: ${step.description}`;
            const sel = await aiIdentifySelector(page, step.description);
            const locResult = await smartLocate(page, sel, timeoutMs);
            result.usedSelector = locResult.usedSelector; result.healed = locResult.healed;
            await locResult.loc.hover({ timeout: timeoutMs });
            await page.waitForTimeout(step.waitMs || 800);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── scroll_to: scroll page or to an element ───
          case "scroll_to": {
            result.description = `Scroll to: ${step.description || `(${step.x || 0}, ${step.y || 0})`}`;
            if (step.description && !step.x && !step.y) {
              try {
                const sel = await aiIdentifySelector(page, step.description);
                const locResult = await smartLocate(page, sel, timeoutMs);
                await locResult.loc.scrollIntoViewIfNeeded({ timeout: timeoutMs });
              } catch {
                await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), step.pixels || 400);
              }
            } else {
              await page.evaluate(({ x, y }) => window.scrollTo({ left: x || 0, top: y || 0, behavior: "smooth" }), { x: step.x || 0, y: step.y || 0 });
            }
            await page.waitForTimeout(600);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── scroll_feed: scroll N times (infinite scroll for Twitter, Reddit, Instagram) ───
          case "scroll_feed": {
            const times = step.times || 3;
            result.description = `Scroll feed ${times}x`;
            await scrollFeed(page, times, step.pixels || 700, step.delayMs || 1200);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── drag_and_drop: drag source to target by description ───
          case "drag_and_drop": {
            result.description = `Drag "${step.from}" → "${step.to}"`;
            const fromSel = await aiIdentifySelector(page, step.from || step.description);
            const toSel = await aiIdentifySelector(page, step.to || step.target || step.description);
            const fromLoc = await smartLocate(page, fromSel, timeoutMs);
            const toLoc = await smartLocate(page, toSel, timeoutMs);
            await fromLoc.loc.dragTo(toLoc.loc, { timeout: timeoutMs });
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── mouse_move: move mouse to x,y coordinates (canvas games) ───
          case "mouse_move": {
            const x = step.x || 0, y = step.y || 0;
            result.description = `Mouse move to (${x}, ${y})`;
            await page.mouse.move(x, y, { steps: step.steps || 10 });
            await page.waitForTimeout(200);
            break;
          }

          // ─── mouse_click_at: click at specific coordinates (canvas, games) ───
          case "mouse_click_at": {
            const x = step.x || 0, y = step.y || 0;
            result.description = `Mouse click at (${x}, ${y})`;
            await page.mouse.click(x, y, { button: step.button || "left", clickCount: step.clickCount || 1 });
            await page.waitForTimeout(300);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── upload_file: upload a file through a file input ───
          case "upload_file": {
            result.description = `Upload file: ${step.filePath}`;
            // Find file input by description or generic
            let fileInput = null;
            if (step.description) {
              try {
                const sel = await aiIdentifySelector(page, step.description);
                fileInput = page.locator(sel).first();
              } catch { /* fallback */ }
            }
            if (!fileInput) fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(step.filePath || step.file, { timeout: timeoutMs });
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── handle_dialog: explicitly handle next dialog (before it appears) ───
          case "handle_dialog": {
            const dialogAction = step.dialogAction || "accept";
            const dialogValue = step.dialogValue || "";
            result.description = `Handle dialog: ${dialogAction}`;
            page.once("dialog", async (dialog) => {
              try {
                if (dialogAction === "dismiss") await dialog.dismiss();
                else await dialog.accept(dialogValue);
              } catch { /* ignore */ }
            });
            break;
          }

          // ─── select_option: select dropdown option by value or text ───
          case "select_option": {
            result.description = `Select option "${step.value}" in ${step.description}`;
            let sel = step.selector;
            if (!sel && step.description) sel = await aiIdentifySelector(page, step.description);
            await page.locator(sel || "select").first().selectOption(
              step.value,
              { timeout: timeoutMs }
            );
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── clear_input: clear an input field ───
          case "clear_input": {
            result.description = `Clear: ${step.description}`;
            const sel = step.selector || await aiIdentifySelector(page, step.description || "input");
            const loc = page.locator(sel).first();
            await loc.click({ timeout: 3000 }).catch(() => {});
            await loc.fill("", { timeout: timeoutMs });
            break;
          }

          // ─── key_chord: press a key combination (Ctrl+A, Cmd+C, etc.) ───
          case "key_chord": {
            const chord = step.key || step.chord || "Enter";
            result.description = `Key chord: ${chord}`;
            await page.keyboard.press(chord);
            await page.waitForTimeout(300);
            break;
          }

          // ─── iframe_click: click inside an iframe ───
          case "iframe_click": {
            result.description = `Click in iframe: ${step.description}`;
            const frames = page.frames();
            let clicked = false;
            for (const frame of frames) {
              try {
                const sel = await aiIdentifySelector(page, step.description);
                const loc = frame.locator(sel).first();
                const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
                if (visible) {
                  await loc.click({ timeout: timeoutMs });
                  clicked = true;
                  break;
                }
              } catch { /* try next frame */ }
            }
            if (!clicked) throw new Error(`Could not click "${step.description}" in any iframe`);
            await page.waitForTimeout(500);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── assert_count: assert number of elements matching a selector ───
          case "assert_count": {
            result.description = `Assert count: ${step.description}`;
            const sel = step.selector || await aiIdentifySelector(page, step.description || "element");
            const count = await page.locator(sel).count();
            const expected = step.expected || step.count || 1;
            const op = step.operator || "gte"; // gte, lte, eq
            let pass = false;
            if (op === "eq") pass = count === expected;
            else if (op === "lte") pass = count <= expected;
            else pass = count >= expected;
            if (!pass) throw new Error(`Element count for "${sel}": got ${count}, expected ${op} ${expected}`);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── assert_attribute: assert element has specific attribute value ───
          case "assert_attribute": {
            result.description = `Assert attribute: ${step.description}`;
            const sel = step.selector || await aiIdentifySelector(page, step.description || "element");
            const attrValue = await page.locator(sel).first().getAttribute(step.attribute, { timeout: timeoutMs });
            if (!String(attrValue || "").includes(step.expected || "")) {
              throw new Error(`Attribute "${step.attribute}" = "${attrValue}", expected to include "${step.expected}"`);
            }
            break;
          }

          // ─── go_back / go_forward: browser history navigation ───
          case "go_back": {
            result.description = "Navigate back";
            await page.goBack({ timeout: timeoutMs, waitUntil: "domcontentloaded" }).catch(() => page.evaluate(() => window.history.back()));
            await page.waitForTimeout(1200);
            await dismissOverlays(page);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          case "go_forward": {
            result.description = "Navigate forward";
            await page.goForward({ timeout: timeoutMs, waitUntil: "domcontentloaded" }).catch(() => page.evaluate(() => window.history.forward()));
            await page.waitForTimeout(1000);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── reload: reload the current page ───
          case "reload": {
            result.description = "Reload page";
            await page.reload({ timeout: timeoutMs, waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1000);
            await dismissOverlays(page);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          // ─── set_geolocation: mock GPS location (maps, location-based apps) ───
          case "set_geolocation": {
            result.description = `Set location: lat=${step.latitude}, lng=${step.longitude}`;
            await context.setGeolocation({ latitude: step.latitude || 0, longitude: step.longitude || 0, accuracy: 100 });
            await context.grantPermissions(["geolocation"]);
            break;
          }

          // ─── emulate_device: switch viewport to mobile/tablet ───
          case "emulate_device": {
            const device = step.device || "mobile";
            result.description = `Emulate: ${device}`;
            const viewports = {
              mobile: { width: 390, height: 844 },
              tablet: { width: 768, height: 1024 },
              desktop: { width: 1280, height: 800 },
            };
            const vp = viewports[device] || viewports.mobile;
            await page.setViewportSize(vp);
            await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
            await page.waitForTimeout(800);
            result.screenshot = await takeScreenshot(page);
            break;
          }

          default: {
            result.status = "skipped";
            result.error = `Unknown action: ${step.action}`;
          }
        }
      } catch (err) {
        result.status = "failed";
        result.error = err.message?.slice(0, 400) ?? "Unknown error";
        try { result.screenshot = await takeScreenshot(page); } catch { /* ignore */ }
        result.aiAnalysis = await aiAnalyzeFailure(step, result.error);
      }

      result.durationMs = Date.now() - t0;
      // Capture screenshot after every step when autoScreenshot is enabled
      if (autoScreenshot && !result.screenshot) {
        try { result.screenshot = await takeScreenshot(activePage); } catch { /* ignore */ }
      }
      results.push(result);
      if (runId) await updateRunLive(runId, results);
      if (stopOnFailure && result.status === "failed") break;
    }
  } finally {
    if (liveScreenInterval) clearInterval(liveScreenInterval);
    if (_ownsBrowser) await browser.close();
  }

  return results;
}

// ─────────────────────────────────────────────────────────
// AUTO-DISCOVER: paste URL → AI explores → runs its own test
// ─────────────────────────────────────────────────────────
async function generateAutoDiscoveryPlan(url, pageInfo) {
  const navElements = pageInfo.elements.filter(el =>
    ["a", "button"].includes(el.tag) || el.role === "button" || el.role === "link"
  ).slice(0, 25);
  const inputElements = pageInfo.elements.filter(el =>
    ["input", "textarea", "select"].includes(el.tag)
  ).slice(0, 10);
  const navList = navElements.map(el => el.text || el.ariaLabel || el.id || el.tag).filter(Boolean).join(", ");
  const inputList = inputElements.map(el => el.placeholder || el.ariaLabel || el.name || el.type || el.tag).filter(Boolean).join(", ");

  const prompt = `You are a QA engineer. Create a browser test plan for this page.
URL: ${url}
Title: "${pageInfo.title}"
Page text snippet: "${pageInfo.visibleText.slice(0, 400)}"
Clickable elements found on page: [${navList || "none"}]
Input elements found on page: [${inputList || "none"}]

CRITICAL RULES:
- ONLY create ai_click steps for elements that ACTUALLY APPEAR in the "Clickable elements" list above
- ONLY create ai_fill steps for elements that ACTUALLY APPEAR in the "Input elements" list above
- Do NOT invent navigation items, modules, or links that are not in the lists above
- Start with navigate to the exact URL, then check_performance, then screenshot
- If login form visible (email/password inputs), fill and submit it
- After actions, take screenshots to capture state changes
- ai_click description must match text from the Clickable elements list
- ai_fill description must match a field from the Input elements list
- Mark ai_click navigation/exploration steps with "optional": true so they are skipped gracefully if not present
- Generate 6-12 steps total

Return ONLY the JSON array, no markdown.`;

  const raw = await generateText({ prompt, maxTokens: 1500 });
  const steps = parseJsonSafe(raw, null);
  if (Array.isArray(steps) && steps.length >= 3) return steps.slice(0, 20);

  let hostname = url;
  try { hostname = new URL(url).hostname; } catch { /* use url */ }
  return [
    { action: "navigate", url, description: "Open application" },
    { action: "check_performance", description: "Page load performance" },
    { action: "screenshot", label: "Initial state" },
    { action: "assert_url", expected: hostname, description: "Verify correct domain" },
    { action: "ai_assert", description: "page has loaded with visible content" },
  ];
}

export async function autoDiscoverAndTest({
  workspaceId,
  taskId,
  url,
  triggeredBy = null,
  triggerSource = "manual",
  timeoutMs = 45000,
  onRunCreated = null,
}) {
  if (!url || !String(url).trim().startsWith("http")) throw new Error("A valid HTTP URL is required");

  const { rows: taskRows } = await pool.query(
    `SELECT id, project_id FROM tasks WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [taskId, workspaceId]
  );
  if (!taskRows[0]) throw new Error("Task not found in workspace");
  const projectId = taskRows[0].project_id;

  const { rows: [run] } = await pool.query(
    `INSERT INTO testing_agent_runs
       (workspace_id, project_id, task_id, trigger_source, mode, status, generated_cases, commands, output_json, created_by)
     VALUES ($1,$2,$3,$4,'auto_discover','running','[]'::jsonb,'[]'::jsonb,'{"stepResults":[]}'::jsonb,$5)
     RETURNING *`,
    [workspaceId, projectId, taskId, triggerSource, triggeredBy || null]
  );
  if (onRunCreated) onRunCreated(run.id);

  // Phase 1: Discover page (stealth browser)
  let pageInfo = { title: "", visibleText: "", elements: [] };
  let initialScreenshot = null;
  const discoverBrowser = await createStealthBrowser();
  try {
    const ctx = await createStealthContext(discoverBrowser);
    const page = await ctx.newPage();
    await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch { /* ok */ }
    await dismissOverlays(page);
    initialScreenshot = await takeScreenshot(page);
    pageInfo = await page.evaluate(() => ({
      title: document.title,
      visibleText: document.body.innerText.slice(0, 500),
      elements: [...document.querySelectorAll("a,button,input,select,textarea,[role='button']")].slice(0, 80).map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute("name") || null,
        text: (el.innerText || el.value || "").trim().slice(0, 40) || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        type: el.type || null,
      })),
    }));
  } catch (err) {
    await discoverBrowser.close().catch(() => {});
    await pool.query(
      `UPDATE testing_agent_runs SET status='failed', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, JSON.stringify({ error: `Page discovery failed: ${err.message}`, url })]
    );
    throw err;
  }
  await discoverBrowser.close().catch(() => {});

  // Phase 2: Generate plan
  let discoveredSteps;
  try {
    discoveredSteps = await generateAutoDiscoveryPlan(url, pageInfo);
  } catch {
    discoveredSteps = [{ action: "navigate", url, description: "Open app" }, { action: "screenshot", label: "Page" }];
  }

  await pool.query(
    `UPDATE testing_agent_runs SET commands=$2::jsonb WHERE id=$1`,
    [run.id, JSON.stringify(discoveredSteps)]
  );

  // Phase 3: Execute
  let stepResults = [];
  try {
    stepResults = await executeBrowserSteps(discoveredSteps, timeoutMs, { runId: run.id, stopOnFailure: false });
  } catch (err) {
    await pool.query(
      `UPDATE testing_agent_runs SET status='failed', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, JSON.stringify({ error: err.message, url, discoveredSteps })]
    );
    throw err;
  }

  const passed = stepResults.filter((s) => s.status === "passed").length;
  const failed = stepResults.filter((s) => s.status === "failed").length;
  const skipped = stepResults.filter((s) => s.status === "skipped").length;
  const finalStatus = failed > 0 ? "failed" : "passed";
  const insights = await generateRunInsights(stepResults, "auto_discover");

  const output = { url, pageTitle: pageInfo.title, initialScreenshot, discoveredSteps, stepResults, insights, summary: { total: stepResults.length, passed, failed, skipped } };

  await pool.query(
    `UPDATE testing_agent_runs SET status=$2, output_json=$3, finished_at=NOW() WHERE id=$1`,
    [run.id, finalStatus, JSON.stringify(output)]
  );

  return {
    runId: run.id,
    status: finalStatus,
    pageTitle: pageInfo.title,
    discoveredSteps,
    insights,
    summary: output.summary,
    steps: stepResults.map((s) => ({ ...s, screenshot: s.screenshot ? true : null })),
  };
}

// ─────────────────────────────────────────────────────────
// MULTI-SCENARIO: 4 scenario types from one description
// ─────────────────────────────────────────────────────────
async function generateScenarioPlans(description, url) {
  const prompt = `QA architect. Create exactly 4 browser test scenarios for this feature.
Feature: "${description}"
${url ? `Base URL: ${url}` : ""}

Return JSON with exactly these keys:
{"happy_path":[...steps],"error_handling":[...steps],"edge_cases":[...steps],"performance":[...steps]}

Each scenario: 4-8 steps. Actions: navigate, click, fill, press, wait, screenshot, assert_visible, assert_text, assert_url, ai_click, ai_fill, ai_assert, check_performance.
Return ONLY the JSON object. No markdown.`;

  const raw = await generateText({ prompt, maxTokens: 2000 });
  const parsed = parseJsonSafe(raw, null);
  if (parsed && typeof parsed === "object") {
    return {
      happy_path: Array.isArray(parsed.happy_path) ? parsed.happy_path : [],
      error_handling: Array.isArray(parsed.error_handling) ? parsed.error_handling : [],
      edge_cases: Array.isArray(parsed.edge_cases) ? parsed.edge_cases : [],
      performance: Array.isArray(parsed.performance) ? parsed.performance : [],
    };
  }
  const base = url ? [{ action: "navigate", url, description: "Open app" }, { action: "screenshot", label: "Initial" }] : [];
  return {
    happy_path: [...base, { action: "ai_assert", description: "page loaded with visible content" }],
    error_handling: [...base, { action: "ai_assert", description: "page shows proper error messages" }],
    edge_cases: [...base, { action: "ai_assert", description: "page handles edge cases" }],
    performance: [...base, { action: "check_performance", description: "Page load performance", failOnSlow: false }],
  };
}

export async function runMultiScenario({
  workspaceId,
  taskId,
  description,
  url = null,
  triggeredBy = null,
  triggerSource = "manual",
  timeoutMs = 60000,
}) {
  if (!description || String(description).trim().length < 5) throw new Error("Feature description is required");

  const { rows: taskRows } = await pool.query(
    `SELECT id, project_id FROM tasks WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [taskId, workspaceId]
  );
  if (!taskRows[0]) throw new Error("Task not found in workspace");
  const projectId = taskRows[0].project_id;

  const scenarios = await generateScenarioPlans(description.trim(), url || "");
  const LABELS = { happy_path: "Happy Path", error_handling: "Error Handling", edge_cases: "Edge Cases", performance: "Performance" };

  const scenarioResults = [];

  for (const [type, steps] of Object.entries(scenarios)) {
    if (!Array.isArray(steps) || steps.length === 0) continue;

    const { rows: [run] } = await pool.query(
      `INSERT INTO testing_agent_runs
         (workspace_id, project_id, task_id, trigger_source, mode, status, generated_cases, commands, output_json, created_by)
       VALUES ($1,$2,$3,$4,'multi_scenario','running','[]'::jsonb,$5::jsonb,'{"stepResults":[]}'::jsonb,$6)
       RETURNING *`,
      [workspaceId, projectId, taskId, triggerSource, JSON.stringify([`${type}`]), triggeredBy || null]
    );

    let stepResults = [];
    try {
      stepResults = await executeBrowserSteps(steps, timeoutMs, { runId: run.id, stopOnFailure: false });
    } catch (err) {
      stepResults = [{ stepIndex: 0, action: "error", description: err.message, status: "failed", error: err.message, screenshot: null, metrics: null, durationMs: 0, healed: false, aiAnalysis: null, usedSelector: null, value: null, selector: null }];
    }

    const passed = stepResults.filter((s) => s.status === "passed").length;
    const failed = stepResults.filter((s) => s.status === "failed").length;
    const finalStatus = failed > 0 ? "failed" : "passed";
    const insights = await generateRunInsights(stepResults, `multi_scenario:${type}`);

    const output = { scenarioType: type, scenarioLabel: LABELS[type], description, stepResults, insights, summary: { total: stepResults.length, passed, failed } };

    await pool.query(
      `UPDATE testing_agent_runs SET status=$2, output_json=$3, finished_at=NOW() WHERE id=$1`,
      [run.id, finalStatus, JSON.stringify(output)]
    );

    scenarioResults.push({
      runId: run.id,
      type,
      label: LABELS[type],
      status: finalStatus,
      insights,
      summary: output.summary,
      steps: stepResults.map((s) => ({ ...s, screenshot: s.screenshot ? true : null })),
    });
  }

  const allPassed = scenarioResults.every((s) => s.status === "passed");
  const allFailed = scenarioResults.every((s) => s.status === "failed");

  return {
    description,
    scenarios: scenarioResults,
    overallStatus: allPassed ? "passed" : allFailed ? "failed" : "partial",
    summary: {
      total: scenarioResults.length,
      passed: scenarioResults.filter((s) => s.status === "passed").length,
      failed: scenarioResults.filter((s) => s.status === "failed").length,
    },
  };
}

// ─────────────────────────────────────────────────────────
// DEEP EXPLORATION HELPERS
// ─────────────────────────────────────────────────────────

function parseCredentialsFromInstructions(instructions) {
  const urlMatch = instructions.match(/https?:\/\/[^\s,'"]+/);
  const url = urlMatch ? urlMatch[0] : null;
  const emailMatch =
    instructions.match(/email\s*[-:]\s*([^\s,;]+@[^\s,;]+)/i) ||
    instructions.match(/email\s*[-:]\s*([^\s,;]+)/i) ||
    instructions.match(/username\s*[-:]\s*([^\s,;]+)/i);
  const passwordMatch =
    instructions.match(/password\s*[-:]\s*([^\s,;]+)/i) ||
    instructions.match(/pass\s*[-:]\s*([^\s,;]+)/i);
  return {
    url,
    email: emailMatch ? emailMatch[1].replace(/[,;]$/, "") : null,
    password: passwordMatch ? passwordMatch[1].replace(/[,;]$/, "") : null,
  };
}

// Broad navigation discovery — scans links, tabs, role-based elements AND clickable divs in nav containers
async function discoverAllNavigationItems(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const items = [];

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.width < 600;
    }
    function getText(el) {
      return (el.innerText || el.getAttribute("aria-label") || el.title || el.getAttribute("data-label") || "")
        .trim().replace(/\s+/g, " ").slice(0, 60);
    }
    function addItem(el, hrefOverride) {
      const text = getText(el);
      if (!text || text.length < 2 || text.length > 50) return;
      if (seen.has(text.toLowerCase())) return;
      if (!isVisible(el)) return;
      const href = hrefOverride || el.getAttribute("href") || "";
      if (/^(mailto:|tel:|javascript:|#$)/.test(href)) return;
      if (/^https?:\/\//.test(href)) {
        try { if (new URL(href).hostname !== window.location.hostname) return; } catch { return; }
      }
      seen.add(text.toLowerCase());
      items.push({ text, href: href || null });
    }

    // 1. Traditional link-based nav
    const linkSelectors = [
      "nav a", "aside a", "[role='navigation'] a",
      "[data-sidebar] a", ".sidebar a", ".nav a", ".side-nav a",
      "header nav a", ".topbar a", ".app-header a",
      ".menu a", "ul.menu li a",
      "[class*='sidebar'] a", "[class*='nav-item'] a",
      "[class*='menu-item'] a", "ul[class*='nav'] li a",
      "[class*='navlink']", "[class*='nav-link']",
    ];
    for (const sel of linkSelectors) {
      try { [...document.querySelectorAll(sel)].forEach((el) => addItem(el)); } catch { /* ignore */ }
    }

    // 2. ARIA / data-attribute nav (React Router, tabs, drawers)
    for (const sel of ["[role='tab']", "[role='menuitem']", "[role='option']", "[data-tab]", "[data-route]", "[data-page]"]) {
      try { [...document.querySelectorAll(sel)].forEach((el) => addItem(el)); } catch { /* ignore */ }
    }

    // 3. Clickable items INSIDE known nav containers (buttons, divs, li)
    const navContainerSelectors = [
      "nav", "aside", "[role='navigation']", "[role='sidebar']",
      "[class*='sidebar']", "[class*='nav-bar']", "[class*='side-bar']",
      "[class*='app-nav']", "[class*='main-nav']", "[class*='left-panel']",
      "[class*='left-menu']", "[class*='drawer']",
    ];
    for (const csel of navContainerSelectors) {
      try {
        const container = document.querySelector(csel);
        if (!container) continue;
        [...container.querySelectorAll("button, li, div[class*='item'], div[class*='link'], span[class*='item']")]
          .forEach((el) => {
            if (el.querySelectorAll("a, button").length > 2) return; // skip wrapper containers
            addItem(el);
          });
      } catch { /* ignore */ }
    }

    // 4. Explicit tab-class buttons (top-level horizontal tab bars common in React apps)
    for (const sel of [
      "button[class*='tab']", "li[class*='tab']",
      "div[class*='tab-item']", "div[class*='tabItem']", "div[class*='TabItem']",
    ]) {
      try { [...document.querySelectorAll(sel)].forEach((el) => addItem(el)); } catch { /* ignore */ }
    }

    return items.slice(0, 25);
  }).catch(() => []);
}

// Discover tabs / sub-sections within the currently visible page
async function discoverPageTabs(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const tabs = [];
    const selectors = [
      "[role='tablist'] [role='tab']",
      "[role='tab']",
      ".tabs a, .tabs button, .tabs li",
      "[class*='tab-bar'] a, [class*='tab-bar'] button",
      "[class*='tabs'] a, [class*='tabs'] button",
      "ul.nav-tabs li a",
    ];
    for (const sel of selectors) {
      try {
        [...document.querySelectorAll(sel)].forEach((el) => {
          const text = (el.innerText || el.getAttribute("aria-label") || "").trim();
          if (!text || text.length < 2 || text.length > 40 || seen.has(text.toLowerCase())) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0) return;
          seen.add(text.toLowerCase());
          tabs.push({ text });
        });
      } catch { /* ignore */ }
    }
    return tabs.slice(0, 6);
  }).catch(() => []);
}

// Detect if a modal/dialog/drawer/sheet has opened and extract its actual fields
async function detectOpenModal(page) {
  return page.evaluate(() => {
    const modalSelectors = [
      "[role='dialog']", "[role='alertdialog']",
      "[aria-modal='true']",
      "[data-state='open']",
      ".modal.show", ".modal.active", ".modal[style*='block']",
      "[class*='modal'][class*='open']", "[class*='dialog'][class*='open']",
      "[class*='drawer'][class*='open']", "[class*='sheet'][class*='open']",
      "[class*='overlay']:not([style*='display: none'])",
      "[class*='popup']",
    ];
    for (const sel of modalSelectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) continue;

        const inputs = [...el.querySelectorAll(
          "input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea, select"
        )].map(inp => ({
          type: inp.type || inp.tagName.toLowerCase(),
          name: inp.name || null,
          placeholder: inp.placeholder || null,
          ariaLabel: inp.getAttribute("aria-label") || null,
          id: inp.id || null,
          required: inp.required,
        }));
        const buttons = [...el.querySelectorAll("button, [role='button'], input[type='submit']")]
          .map(b => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim())
          .filter(t => t.length > 0 && t.length < 50);
        const title = (
          el.querySelector("h1,h2,h3,h4,[class*='title'],[class*='heading'],[class*='header']")?.innerText || ""
        ).trim().slice(0, 80);
        return { found: true, inputs, buttons, title };
      } catch { /* ignore */ }
    }
    return { found: false, inputs: [], buttons: [], title: "" };
  }).catch(() => ({ found: false, inputs: [], buttons: [], title: "" }));
}

// Improved page info extraction — only scans visible elements
async function extractPageInfoFull(page) {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll(
      "a, button, input, select, textarea, [role='button'], [role='link'], [role='menuitem'], [role='tab']"
    )].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    }).slice(0, 100).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute("name") || null,
      text: (el.innerText || el.value || "").trim().slice(0, 50) || null,
      placeholder: el.placeholder || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      type: el.type || null,
      role: el.getAttribute("role") || null,
    }));
    const hasForms = document.querySelectorAll("form").length > 0;
    const hasTable = document.querySelectorAll("table, [role='grid'], [role='table'], [class*='data-table']").length > 0;
    const hasSearch = !!document.querySelector(
      "input[type='search'], input[placeholder*='search' i], input[aria-label*='search' i], [role='searchbox']"
    );
    const hasCreateBtn = !![...document.querySelectorAll("button, [role='button'], a")].find(b => {
      const t = (b.innerText || b.getAttribute("aria-label") || "").toLowerCase().trim();
      return /^(create|add|new|invite|add new|\+ |plus)/.test(t) || t === "+";
    });
    const pageText = (document.body.innerText || "").slice(0, 800);
    const title = document.title || "";
    return { elements, hasForms, hasTable, hasSearch, hasCreateBtn, visibleText: pageText, title };
  }).catch(() => ({ elements: [], hasForms: false, hasTable: false, hasSearch: false, hasCreateBtn: false, visibleText: "", title: "" }));
}

// ─────────────────────────────────────────────────────────
// ADAPTIVE DEEP MODULE TESTER
// Observes the page at each step — fills forms from ACTUAL modal DOM, not pre-snapshot
// ─────────────────────────────────────────────────────────
async function executeDeepModuleTest(page, moduleName, { context, browser, runId, resultOffset, moduleTimeoutMs }) {
  const allResults = [];
  const slug = moduleName.replace(/[^a-z0-9]/gi, "_").toLowerCase();

  // Run one step on the shared page and collect result
  async function step(s) {
    const r = await executeBrowserSteps([s], Math.min(moduleTimeoutMs, 14000), {
      runId,
      stopOnFailure: false,
      _existingPage: page,
      _existingContext: context,
      _existingBrowser: browser,
      _resultOffset: resultOffset + allResults.length,
    });
    allResults.push(...r);
    return r[0] || { status: "skipped" };
  }

  // ── 1. Initial state capture ──
  await step({ action: "screenshot", label: `${slug}_initial` });
  const info = await extractPageInfoFull(page);
  const pageTabs = await discoverPageTabs(page);
  await step({ action: "check_performance", description: `${moduleName} performance`, failOnSlow: false });

  // ── Detect module type for specialized handling ──
  const moduleNameLower = moduleName.toLowerCase();
  const isChatModule = /\bchat\b|message|inbox|conversation|support|helpdesk|ticket|dm\b/.test(moduleNameLower);
  const isReportModule = /report|analytic|statistic|insight|dashboard|metric|chart|graph/.test(moduleNameLower);

  // ── 2. Tab / sub-section exploration ──
  if (pageTabs.length > 1) {
    for (const tab of pageTabs.slice(0, 4)) {
      const r = await step({ action: "ai_click", description: `${tab.text} tab or section`, optional: true });
      if (r.status === "passed") {
        await page.waitForTimeout(600);
        await step({ action: "screenshot", label: `${slug}_tab_${tab.text.replace(/\s+/g, "_").toLowerCase()}` });
      }
    }
  }

  // ── 3. Module-type-specific deep tests ──

  // Chat/Messaging/Bot module: discover all conversations/bots and test each
  if (isChatModule) {
    await step({ action: "ai_assert", description: `${moduleName} interface has loaded` });
    await step({ action: "screenshot", label: `${slug}_chat_overview` });

    // Discover individual chat entries / bots / conversations in a list
    const chatEntries = await page.evaluate(() => {
      const seen = new Set();
      const entries = [];
      const listSelectors = [
        "[class*='conversation'] li", "[class*='chat-item']", "[class*='chatItem']",
        "[class*='bot-item']", "[class*='botItem']", "[class*='contact-item']",
        "[class*='thread']", "[class*='inbox'] li", "[class*='message-list'] li",
        "[role='listitem']", "[role='row']",
        "ul li a", "ul li button", ".list-group-item",
      ];
      for (const sel of listSelectors) {
        try {
          [...document.querySelectorAll(sel)].slice(0, 10).forEach((el) => {
            const text = (el.innerText || "").trim().split("\n")[0].slice(0, 50);
            if (!text || text.length < 2 || seen.has(text.toLowerCase())) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            seen.add(text.toLowerCase());
            entries.push(text);
          });
        } catch { /* ignore */ }
      }
      return entries.slice(0, 5);
    }).catch(() => []);

    if (chatEntries.length > 0) {
      console.log(`[deepExplore] Found ${chatEntries.length} chat entries in ${moduleName}:`, chatEntries);
      // Test each chat entry (up to 3 to keep runtime reasonable)
      for (const entry of chatEntries.slice(0, 3)) {
        const clicked = await step({ action: "ai_click", description: `"${entry}" chat entry or conversation item`, optional: true });
        if (clicked.status === "passed") {
          await page.waitForTimeout(1000);
          await step({ action: "screenshot", label: `${slug}_opened_${entry.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}` });
          // Have a real conversation
          await step({
            action: "conversation_loop",
            chatInput: "message input or chat text box or type a message",
            turns: "auto",
            until: "received a reply or bot responded or conversation reached natural end",
            maxTurns: 6,
            initialMessage: "Hello! Can you help me with something?",
            persona: "user testing the chat feature",
            responseTimeoutMs: 20000,
            description: `Chat with "${entry}"`,
            optional: true,
          });
          await step({ action: "screenshot", label: `${slug}_after_chat_${entry.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}` });
          // Go back to list for next entry
          await step({ action: "go_back", description: "Back to chat list", optional: true });
          await page.waitForTimeout(700);
        }
      }
    } else {
      // No list found — try to start a new chat directly
      const openChat = await step({ action: "ai_click", description: "new chat or compose message or start conversation button", optional: true });
      if (openChat.status === "passed") {
        await page.waitForTimeout(800);
        await step({ action: "screenshot", label: `${slug}_chat_opened` });
      }
      await step({
        action: "conversation_loop",
        chatInput: "message input or chat text box",
        turns: "auto",
        until: "received a reply or conversation reached natural end",
        maxTurns: 6,
        initialMessage: "Hello, I have a test question",
        persona: "test user checking if chat works",
        responseTimeoutMs: 20000,
        description: `${moduleName}: chat test`,
        optional: true,
      });
      await step({ action: "screenshot", label: `${slug}_after_conversation` });
    }
  } else if (isReportModule) {
    // Analytics/Reports: verify charts load, try filters
    await step({ action: "ai_assert", description: `${moduleName} charts or data visualizations have loaded` });
    await step({ action: "ai_click", description: "date range picker or filter button", optional: true });
    await page.waitForTimeout(600);
    await step({ action: "screenshot", label: `${slug}_with_filters` });
    await step({ action: "ai_assert", description: "data or metrics are displayed on the page" });
  } else if (info.hasTable) {
    await step({ action: "ai_assert", description: `${moduleName} list or table has loaded with content` });
  } else {
    await step({ action: "ai_assert", description: `${moduleName} page has loaded with visible content` });
  }

  // ── 4. Search functionality ──
  if (info.hasSearch) {
    const r = await step({ action: "ai_fill", description: "search bar or search input", value: "test", optional: true });
    if (r.status === "passed") {
      await page.waitForTimeout(900);
      await step({ action: "screenshot", label: `${slug}_search_results` });
    }
    // Clear search to restore state
    await step({ action: "ai_fill", description: "search bar or search input", value: "", optional: true });
    await page.waitForTimeout(400);
  }

  // ── 5. CREATE flow — adaptive: detects actual modal fields after opening ──
  if (info.hasCreateBtn) {
    const createResult = await step({ action: "ai_click", description: "create or add or new or invite button", optional: true });
    if (createResult.status === "passed") {
      await page.waitForTimeout(1400);
      const modal = await detectOpenModal(page);
      await step({ action: "screenshot", label: `${slug}_create_opened` });

      if (modal.found && modal.inputs.length > 0) {
        // Fill from ACTUAL fields in the opened modal/form
        const TEST = {
          name: "Deep Test Item",
          email: "deeptest@example.com",
          username: "deeptest_user",
          password: "TestPassword123!",
          phone: "+1234567890",
          description: "Created by automated deep test",
          title: "Test Entry",
          message: "Hello from deep test agent",
          number: "1",
        };
        for (const inp of modal.inputs.slice(0, 8)) {
          const hint = (inp.placeholder || inp.ariaLabel || inp.name || inp.type || "").toLowerCase();
          if (!hint || hint === "hidden") continue;
          let val = TEST.name;
          if (/email/.test(hint)) val = TEST.email;
          else if (/password|pass/.test(hint)) val = TEST.password;
          else if (/phone|mobile|tel/.test(hint)) val = TEST.phone;
          else if (/description|note|bio|about|comment/.test(hint)) val = TEST.description;
          else if (/title/.test(hint)) val = TEST.title;
          else if (/message|text/.test(hint)) val = TEST.message;
          else if (/username|user.?name/.test(hint)) val = TEST.username;
          else if (/number|count|qty|amount/.test(hint)) val = TEST.number;
          await step({ action: "ai_fill", description: `${hint} field`, value: val, optional: true });
        }
        // Click the actual submit button text found in the modal
        const submitText = modal.buttons.find(b => /^(save|create|submit|confirm|add|invite|ok|done|proceed)/i.test(b));
        await step({ action: "ai_click", description: submitText || "save or create or submit button", optional: true });
        await page.waitForTimeout(1800);
        await step({ action: "screenshot", label: `${slug}_after_create` });
        await step({ action: "ai_assert", description: "success message shown or new item appears in list", optional: true });
      } else {
        // No modal detected — try generic fill + submit (for inline forms)
        await step({ action: "ai_fill", description: "name or title input field", value: "Deep Test Item", optional: true });
        await step({ action: "ai_click", description: "save or submit button", optional: true });
        await page.waitForTimeout(1500);
        await step({ action: "screenshot", label: `${slug}_after_create` });
      }
    }
  }

  // ── 6. EDIT flow — click edit on first row, detect form, update a field ──
  if (info.hasTable) {
    const editResult = await step({ action: "ai_click", description: "edit or pencil icon or modify button on first row or record", optional: true });
    if (editResult.status === "passed") {
      await page.waitForTimeout(1000);
      const editModal = await detectOpenModal(page);
      await step({ action: "screenshot", label: `${slug}_edit_opened` });
      if (editModal.found && editModal.inputs.length > 0) {
        const editInp = editModal.inputs[0];
        const fieldDesc = editInp.placeholder || editInp.ariaLabel || editInp.name || "first field";
        await step({ action: "ai_fill", description: `${fieldDesc} field`, value: "Updated Deep Test", optional: true });
        const saveText = editModal.buttons.find(b => /^(save|update|confirm)/i.test(b));
        await step({ action: "ai_click", description: saveText || "save or update button", optional: true });
        await page.waitForTimeout(1200);
        await step({ action: "screenshot", label: `${slug}_after_edit` });
        await step({ action: "ai_assert", description: "changes saved successfully", optional: true });
      }
    }
  }

  // ── 7. VALIDATION test — submit empty form to check error messages ──
  if (info.hasCreateBtn && info.hasForms) {
    const createR = await step({ action: "ai_click", description: "create or add or new button", optional: true });
    if (createR.status === "passed") {
      await page.waitForTimeout(800);
      // Submit without filling anything
      await step({ action: "ai_click", description: "save or create or submit button", optional: true });
      await page.waitForTimeout(700);
      await step({ action: "screenshot", label: `${slug}_validation_errors` });
      await step({ action: "ai_assert", description: "validation errors or required field messages are visible", optional: true });
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  // ── 8. Final screenshot ──
  await step({ action: "screenshot", label: `${slug}_final` });

  return allResults;
}

// ─────────────────────────────────────────────────────────
// PHASE 1 HELPER: Interactive deep recon — clicks every button,
// opens every modal, explores every tab to build a rich feature map
// ─────────────────────────────────────────────────────────
async function deepReconModule(page, moduleName) {
  const startUrl = page.url();
  const recon = {
    name: moduleName,
    url: startUrl,
    title: "",
    visibleText: "",
    tabs: [],          // tab names found
    tabContents: [],   // { tab, visibleText, buttons, hasForms, hasTable }
    clickableButtons: [], // { text, opensModal, modalTitle, modalFields, modalActions, navigatedTo, effect }
    forms: [],         // { fields: [{label, type, required}] } — forms visible on page
    dropdowns: [],     // { label, options[] } — select elements with their options
    tables: [],        // { headers[], rowCount } — table structures
    hasForms: false,
    hasTable: false,
    hasSearch: false,
    hasCreateBtn: false,
    elements: [],
  };

  try {
    // ── Base page info ──
    const pageInfo = await extractPageInfoFull(page);
    recon.title = pageInfo.title;
    recon.visibleText = pageInfo.visibleText;
    recon.hasForms = pageInfo.hasForms;
    recon.hasTable = pageInfo.hasTable;
    recon.hasSearch = pageInfo.hasSearch;
    recon.hasCreateBtn = pageInfo.hasCreateBtn;
    recon.elements = pageInfo.elements.slice(0, 40);

    // ── Discover select/dropdown options ──
    recon.dropdowns = await page.evaluate(() =>
      [...document.querySelectorAll("select")].slice(0, 8).map(s => ({
        label: s.getAttribute("aria-label") || s.name || s.id || "select",
        options: [...s.options].map(o => o.text.trim()).filter(t => t.length > 0 && t.length < 50).slice(0, 20),
      }))
    ).catch(() => []);

    // ── Discover table structures ──
    recon.tables = await page.evaluate(() =>
      [...document.querySelectorAll("table, [role='grid'], [role='table'], [class*='data-grid'], [class*='ag-root']")]
        .slice(0, 3).map(t => ({
          headers: [...t.querySelectorAll("th, [role='columnheader']")]
            .map(h => h.innerText.trim()).filter(Boolean).slice(0, 12),
          rowCount: Math.max(
            t.querySelectorAll("tr").length,
            t.querySelectorAll("[role='row']").length
          ),
        }))
    ).catch(() => []);

    // ── Visible form fields (not inside modals) ──
    const pageFields = await page.evaluate(() =>
      [...document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='checkbox']):not([type='radio']), textarea")]
        .filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(i => ({ type: i.type || i.tagName.toLowerCase(), label: i.placeholder || i.getAttribute("aria-label") || i.name || i.type || "input", required: i.required }))
        .slice(0, 12)
    ).catch(() => []);
    if (pageFields.length > 0) recon.forms = [{ fields: pageFields }];

    // ── Explore tabs (click each, record content + nested buttons/modals) ──
    const tabs = await discoverPageTabs(page);
    recon.tabs = tabs.map(t => t.text);
    for (const tab of tabs.slice(0, 8)) {
      try {
        const tabLoc = page.locator(`[role="tab"]:has-text("${tab.text}"), .tab:has-text("${tab.text}"), button:has-text("${tab.text}")`).first();
        const tabVisible = await tabLoc.isVisible({ timeout: 1500 }).catch(() => false);
        if (!tabVisible) continue;
        await tabLoc.click({ timeout: 3000 });
        await page.waitForTimeout(900);
        const tabInfo = await extractPageInfoFull(page);
        const tabBtns = tabInfo.elements
          .filter(e => e.tag === "button" || e.role === "button")
          .map(e => e.text || e.ariaLabel).filter(Boolean).slice(0, 10);

        // Discover table inside this tab
        const tabTables = await page.evaluate(() =>
          [...document.querySelectorAll("table, [role='grid'], [role='table']")].slice(0, 2).map(t => ({
            headers: [...t.querySelectorAll("th,[role='columnheader']")].map(h => h.innerText.trim()).filter(Boolean).slice(0, 8),
            rowCount: t.querySelectorAll("tr,[role='row']").length,
          }))
        ).catch(() => []);

        // Discover modals triggered by buttons inside this tab (shallow — just record names)
        const tabModalButtons = [];
        const SKIP = /^(sign.?out|log.?out|delete.?all|clear.?all|reset.?all|cancel.?all|close$)/i;
        for (const btnText of tabBtns.slice(0, 6)) {
          if (!btnText || SKIP.test(btnText)) continue;
          try {
            const bLoc = page.locator(`button:has-text("${btnText}"), [role="button"]:has-text("${btnText}")`).first();
            const bVis = await bLoc.isVisible({ timeout: 800 }).catch(() => false);
            if (!bVis) continue;
            await bLoc.click({ timeout: 2000 });
            await page.waitForTimeout(700);
            const modal = await detectOpenModal(page);
            if (modal.found && (modal.inputs.length > 0 || modal.title)) {
              tabModalButtons.push({
                text: btnText,
                opensModal: true,
                modalTitle: modal.title || "",
                modalFields: modal.inputs.map(i => ({
                  label: i.placeholder || i.ariaLabel || i.name || i.type || "field",
                  type: i.type || "text",
                  required: i.required,
                })),
                modalActions: modal.buttons.slice(0, 4),
              });
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(400);
              await dismissOverlays(page).catch(() => {});
            } else {
              // Re-click tab to restore state if button navigated or changed content
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(300);
            }
          } catch { /* skip this button */ }
        }

        recon.tabContents.push({
          tab: tab.text,
          visibleText: tabInfo.visibleText.slice(0, 250),
          buttons: tabBtns,
          modalButtons: tabModalButtons,
          tables: tabTables,
          hasForms: tabInfo.hasForms,
          hasTable: tabInfo.hasTable || tabTables.length > 0,
        });
      } catch { /* skip tab */ }
    }

    // ── Discover buttons and what they reveal ──
    // Get all visible buttons (skip dangerous ones)
    const SKIP_PATTERN = /^(sign.?out|log.?out|delete.?all|clear.?all|remove.?all|reset.?all|cancel.?all|close$)/i;
    const btnCandidates = await page.evaluate(() => {
      const seen = new Set();
      return [...document.querySelectorAll("button, [role='button'], [class*='btn']")]
        .filter(b => {
          const rect = b.getBoundingClientRect();
          const text = (b.innerText || b.getAttribute("aria-label") || b.title || "").trim();
          if (!text || text.length === 0 || text.length > 50) return false;
          if (rect.width === 0 && rect.height === 0) return false;
          if (seen.has(text.toLowerCase())) return false;
          seen.add(text.toLowerCase());
          return true;
        })
        .map(b => ({ text: (b.innerText || b.getAttribute("aria-label") || b.title || "").trim() }))
        .slice(0, 20);
    }).catch(() => []);

    for (const btn of btnCandidates) {
      if (!btn.text || SKIP_PATTERN.test(btn.text)) continue;
      try {
        const urlBefore = page.url();
        const btnLoc = page.locator(`button:has-text("${btn.text}"), [role="button"]:has-text("${btn.text}")`).first();
        const vis = await btnLoc.isVisible({ timeout: 1200 }).catch(() => false);
        if (!vis) continue;

        await btnLoc.click({ timeout: 3000 });
        await page.waitForTimeout(1000);

        const modal = await detectOpenModal(page);
        if (modal.found && (modal.inputs.length > 0 || modal.title || modal.buttons.length > 0)) {
          // Modal or dialog opened — record what's inside
          recon.clickableButtons.push({
            text: btn.text,
            opensModal: true,
            modalTitle: modal.title || "",
            modalFields: modal.inputs.map(i => ({
              label: i.placeholder || i.ariaLabel || i.name || i.type || "field",
              type: i.type || "text",
              required: i.required,
            })),
            modalActions: modal.buttons.slice(0, 5),
          });
          // Also capture dropdown options inside the modal
          const modalDropdowns = await page.evaluate(() =>
            [...document.querySelectorAll("[role='dialog'] select, [aria-modal='true'] select, [data-state='open'] select")]
              .slice(0, 3).map(s => ({
                label: s.getAttribute("aria-label") || s.name || "select",
                options: [...s.options].map(o => o.text.trim()).filter(Boolean).slice(0, 15),
              }))
          ).catch(() => []);
          if (modalDropdowns.length > 0) {
            recon.clickableButtons[recon.clickableButtons.length - 1].modalDropdowns = modalDropdowns;
          }
          // Close modal
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(500);
          await dismissOverlays(page).catch(() => {});
        } else {
          const urlAfter = page.url();
          if (urlAfter !== urlBefore && urlAfter !== startUrl) {
            // Button navigated somewhere — record and go back
            const newPageTitle = await page.title().catch(() => "");
            recon.clickableButtons.push({ text: btn.text, opensModal: false, navigatedTo: urlAfter, pageTitle: newPageTitle });
            await page.goBack({ timeout: 8000, waitUntil: "domcontentloaded" }).catch(async () => {
              await page.goto(startUrl, { timeout: 10000, waitUntil: "domcontentloaded" }).catch(() => {});
            });
            await page.waitForTimeout(800);
          } else {
            // In-page change (filter, sort, refresh, toggle)
            const newContent = await page.evaluate(() => document.body.innerText.slice(0, 80)).catch(() => "");
            recon.clickableButtons.push({ text: btn.text, opensModal: false, effect: "in-page", preview: newContent });
          }
        }
      } catch (err) {
        recon.clickableButtons.push({ text: btn.text, opensModal: false, error: err.message.slice(0, 50) });
      }
    }
  } catch (err) {
    console.warn(`[deepRecon] Error in "${moduleName}":`, err.message);
  }

  console.log(`[deepRecon] "${moduleName}": ${recon.clickableButtons.length} buttons, ${recon.tabs.length} tabs, ${recon.tables.length} tables, ${recon.dropdowns.length} selects`);
  return recon;
}

// ─────────────────────────────────────────────────────────
// PHASE 2 HELPER: Generate PRECISE test cases from rich recon data
// ─────────────────────────────────────────────────────────
async function generateModuleTestCases(moduleName, reconData) {
  const { url = "", visibleText = "", clickableButtons = [], tabs = [], tabContents = [], forms = [], dropdowns = [], tables = [], hasSearch } = reconData;
  const slug = moduleName.toLowerCase().replace(/\s+/g, "_");

  // ── Build rich feature description for LLM ──
  const modalButtons = clickableButtons.filter(b => b.opensModal && b.modalFields?.length > 0);

  const buttonDetails = clickableButtons.map(b => {
    if (b.opensModal && b.modalFields?.length > 0) {
      const fields = b.modalFields.map(f => `"${f.label}"(${f.type}${f.required ? ",required" : ""})`).join(", ");
      const ddStr = b.modalDropdowns?.map(d => `dropdown "${d.label}":[${d.options.slice(0, 5).join("|")}]`).join("; ") || "";
      return `BUTTON "${b.text}" → opens modal "${b.modalTitle || "form"}" with fields:[${fields}]${ddStr ? " + " + ddStr : ""} actions:[${(b.modalActions || []).slice(0, 3).join(",")}]`;
    }
    if (b.navigatedTo) return `BUTTON "${b.text}" → navigates to ${b.navigatedTo} (page: "${b.pageTitle || ""}")`;
    if (b.effect === "in-page") return `BUTTON "${b.text}" → triggers in-page change`;
    return null;
  }).filter(Boolean).join("\n");

  const tabDetail = tabContents.map(t => {
    const modalBtnStr = (t.modalButtons || []).map(b => {
      const fields = (b.modalFields || []).map(f => `"${f.label}"(${f.type}${f.required ? ",req" : ""})`).join(", ");
      return `  BUTTON "${b.text}" → modal "${b.modalTitle}" fields:[${fields}]`;
    }).join("\n");
    return `TAB "${t.tab}": hasForms=${t.hasForms} hasTable=${t.hasTable} buttons:[${t.buttons.join(", ")}]\n${modalBtnStr ? modalBtnStr + "\n" : ""}  content:"${t.visibleText.slice(0, 100)}"`;
  }).join("\n");

  const dropdownDetail = dropdowns.map(d =>
    `SELECT "${d.label}": options [${d.options.slice(0, 10).join(" | ")}]`
  ).join("\n");

  const tableDetail = tables.map(t =>
    `TABLE: columns [${t.headers.join(", ")}] — ${t.rowCount} rows visible`
  ).join("\n");

  const pageFormDetail = forms.flatMap(f => f.fields || [])
    .map(f => `"${f.label}"(${f.type}${f.required ? ",required" : ""})`).join(", ");

  const prompt = `You are a precision QA engineer generating exact, targeted test steps.
You have already explored this module and know EXACTLY what UI elements exist.
DO NOT be generic. Every step must target a REAL element you see below.

MODULE: "${moduleName}"
URL: "${url}"

=== DISCOVERED UI ELEMENTS ===
${buttonDetails || "(no buttons with modals found)"}

${tabDetail ? "=== TABS ===\n" + tabDetail : ""}

${dropdownDetail ? "=== DROPDOWNS ===\n" + dropdownDetail : ""}

${tableDetail ? "=== TABLE ===\n" + tableDetail : ""}

${pageFormDetail ? "=== PAGE FORM FIELDS ===\n" + pageFormDetail : ""}

Page text sample: "${visibleText.slice(0, 150)}"

=== TEST REQUIREMENTS ===
Generate 20-40 SPECIFIC test steps. For each modal-opening button:
1. Happy path: open → fill ALL fields with valid data → click save → assert success
2. Empty submit: open → click save without filling → assert validation errors appear
3. XSS test: open → fill first text field with <script>alert("xss")</script> → save → assert no alert appeared
4. SQL inject: open → fill first text field with ' OR '1'='1 → save → assert no database error

For each TAB: click it → assert content loaded → screenshot

For each in-page BUTTON (filter, sort, export, refresh): click it → screenshot → assert change happened

For each TABLE: if rows exist → click first row → observe what opens → close/back

For SEARCH (if present): search for "test" → assert results appear. Then search ' OR '1'='1 → assert no SQL error

For page-level DROPDOWNS: select each option → assert page responds correctly

For NAVIGATION buttons: click → verify page loaded → go back

IMPORTANT:
- Use exact button/field names from the discovered elements above
- After every XSS/injection fill, immediately add ai_assert checking "no alert dialog appeared and no error was thrown"
- After every empty form submit, add ai_assert checking "required field validation error is shown"
- Always add screenshot after significant actions

Return ONLY valid JSON array. Actions: navigate, ai_click, ai_fill, ai_assert, screenshot, wait, press, go_back.`;

  // ── Mandatory tab steps (appended regardless of LLM output) ──
  // This guarantees EVERY discovered tab is explicitly visited in Phase 3
  const mandatoryTabSteps = tabs.flatMap(tabName => [
    { action: "ai_click", description: `"${tabName}" tab`, optional: true },
    { action: "wait", ms: 800 },
    { action: "screenshot", label: `${slug}_tab_${tabName.toLowerCase().replace(/\s+/g, "_")}` },
    // If tab has modal buttons, test each one
    ...((tabContents.find(t => t.tab === tabName)?.modalButtons || []).slice(0, 3).flatMap(mb => {
      const saveBtn = (mb.modalActions || []).find(a => /^(save|create|submit|confirm|add|ok|done)/i.test(a)) || "save or submit button";
      const firstField = mb.modalFields?.[0];
      return [
        { action: "ai_click", description: `"${mb.text}" button`, optional: true },
        { action: "wait", ms: 700 },
        ...(firstField ? [
          { action: "ai_fill", description: `"${firstField.label}" field`, value: "Test Value", optional: true },
          { action: "ai_click", description: saveBtn, optional: true },
          { action: "screenshot", label: `${slug}_tab_${tabName.slice(0,8)}_${mb.text.slice(0,10).replace(/\s/g,"_")}_happy` },
          { action: "press", key: "Escape", description: "Close modal" },
          { action: "wait", ms: 400 },
          // Empty submit test
          { action: "ai_click", description: `"${mb.text}" button`, optional: true },
          { action: "wait", ms: 700 },
          { action: "ai_click", description: saveBtn, optional: true },
          { action: "ai_assert", description: "validation errors shown for empty required fields", optional: true },
          { action: "press", key: "Escape", description: "Close modal" },
        ] : [
          { action: "ai_click", description: saveBtn, optional: true },
          { action: "press", key: "Escape", description: "Close modal" },
        ]),
      ];
    })),
  ]);

  try {
    const raw = await generateText({ prompt, maxTokens: 3000 });
    const steps = parseJsonSafe(raw, null);
    if (Array.isArray(steps) && steps.length >= 5) {
      // Merge: LLM steps first, then inject any tab steps the LLM missed
      const llmTabNames = new Set(
        steps.filter(s => s.action === "ai_click" && s.description)
          .map(s => s.description.replace(/['"]/g, "").toLowerCase())
      );
      const missingTabSteps = mandatoryTabSteps.filter((s) => {
        if (s.action !== "ai_click" || !s.description) return true; // keep non-click steps
        const tabMatch = tabs.find(t => s.description.includes(t));
        if (!tabMatch) return true;
        return !llmTabNames.has(tabMatch.toLowerCase());
      });
      const merged = [...steps, ...missingTabSteps];
      console.log(`[generateTestCases] "${moduleName}": LLM=${steps.length} + mandatory_tabs=${missingTabSteps.length} = ${merged.length} total steps`);
      return merged;
    }
  } catch { /* use fallback */ }

  // ── Smart fallback based on discovered elements ──
  const fallback = [
    { action: "navigate", url, description: `Open ${moduleName}` },
    { action: "screenshot", label: `${slug}_start` },
  ];

  // Test each modal-opening button
  for (const btn of modalButtons.slice(0, 4)) {
    const firstField = btn.modalFields?.[0];
    const saveBtn = btn.modalActions?.find(a => /^(save|create|submit|confirm|add|ok|done)/i.test(a)) || "save or submit button";
    // 1. Empty submit
    fallback.push(
      { action: "ai_click", description: `"${btn.text}" button`, optional: true },
      { action: "wait", ms: 800 },
      { action: "ai_click", description: saveBtn, optional: true },
      { action: "screenshot", label: `${slug}_${btn.text.slice(0, 15).replace(/\s/g, "_")}_empty` },
      { action: "ai_assert", description: "validation errors shown for empty required fields", optional: true },
      { action: "press", key: "Escape", description: "Close modal" },
      { action: "wait", ms: 400 }
    );
    // 2. XSS in first text field
    if (firstField) {
      fallback.push(
        { action: "ai_click", description: `"${btn.text}" button`, optional: true },
        { action: "wait", ms: 800 },
        { action: "ai_fill", description: `"${firstField.label}" field`, value: BREAK_TEST_VALUES.xss, optional: true },
        { action: "ai_click", description: saveBtn, optional: true },
        { action: "ai_assert", description: "no XSS alert appeared and input was sanitized", optional: true },
        { action: "press", key: "Escape", description: "Close modal" }
      );
    }
  }

  // Always test ALL discovered tabs (use mandatoryTabSteps which already covers them)
  fallback.push(...mandatoryTabSteps);

  // Search abuse
  if (hasSearch) {
    fallback.push(
      { action: "ai_fill", description: "search input or search bar", value: "test", optional: true },
      { action: "wait", ms: 500 },
      { action: "screenshot", label: `${slug}_search_results` },
      { action: "ai_fill", description: "search input or search bar", value: BREAK_TEST_VALUES.sqlBasic, optional: true },
      { action: "ai_assert", description: "no SQL error or database error shown after injection", optional: true }
    );
  }

  fallback.push({ action: "screenshot", label: `${slug}_end` });
  return fallback;
}

// ─────────────────────────────────────────────────────────
// PHASE 3 HELPER: Generate full QA report after all tests run
// ─────────────────────────────────────────────────────────
async function generateFullQAReport(allStepResults, moduleResults) {
  const defaultReport = {
    overallHealthScore: 5,
    verdict: "Testing completed. See module reports and bug list for details.",
    bugsFound: [],
    moduleReports: moduleResults.map(m => ({
      module: m.name,
      healthScore: m.status === "passed" ? 8 : 4,
      summary: `${m.summary.passed} steps passed, ${m.summary.failed} steps failed out of ${m.summary.total} total.`,
      testedFeatures: [],
      issues: m.stepResults.filter(s => s.status === "failed").map(s => s.description).slice(0, 5),
    })),
    securityConcerns: [],
    performanceIssues: [],
    logicalInconsistencies: [],
    coverageGaps: [],
    topPriorityFixes: [],
  };

  try {
    const totalSteps = allStepResults.length;
    const totalPassed = allStepResults.filter(s => s.status === "passed").length;
    const totalFailed = allStepResults.filter(s => s.status === "failed").length;

    const failedSteps = allStepResults
      .filter(s => s.status === "failed")
      .map(s => `[${s.action}] "${s.description}": ${String(s.error || "").slice(0, 120)}`)
      .slice(0, 50)
      .join("\n");

    const moduleSummary = moduleResults
      .map(m => `${m.name}: ${m.summary.passed}✓ ${m.summary.failed}✗`)
      .join(", ");

    const prompt = `You are a senior QA engineer writing a comprehensive bug report after automated testing.

TEST RUN SUMMARY:
Total steps: ${totalSteps} | Passed: ${totalPassed} | Failed: ${totalFailed}
Modules tested: ${moduleSummary}

FAILED STEPS (key evidence):
${failedSteps || "No failures recorded"}

Write a detailed, comprehensive QA report. Be specific. For each bug, describe exactly what failed.
Identify if XSS, SQL injection, input validation, performance, or logic issues were found based on the failed steps.
If XSS/injection steps PASSED (no error), that is a SECURITY CONCERN — note it.
If a "validation errors visible" assertion failed after empty submit, that is a MEDIUM bug.
If a step failed with a timeout/selector error, that is likely a UI bug or test infrastructure issue.

Return ONLY valid JSON (no markdown fences):
{
  "overallHealthScore": <1-10 integer>,
  "verdict": "<2-3 sentence overall assessment of application quality>",
  "bugsFound": [
    {"id":"BUG-001","severity":"critical|high|medium|low","title":"<short title>","module":"<module name>","description":"<detailed description>","stepsToReproduce":["step1","step2"],"expectedBehavior":"<what should happen>","actualBehavior":"<what happened>","impact":"<business/security impact>"}
  ],
  "moduleReports": [
    {"module":"<name>","healthScore":<1-10>,"summary":"<1-2 sentences>","testedFeatures":["<feature1>"],"issues":["<issue1>"]}
  ],
  "securityConcerns": ["<concern1>"],
  "performanceIssues": ["<issue1>"],
  "logicalInconsistencies": ["<inconsistency1>"],
  "coverageGaps": ["<gap1>"],
  "topPriorityFixes": ["<fix1>"]
}`;

    const raw = await generateText({ prompt, maxTokens: 3000 });
    const parsed = parseJsonSafe(raw, null);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.bugsFound)) {
      return { ...defaultReport, ...parsed };
    }
  } catch (err) {
    console.warn("[browserAgent] generateFullQAReport error:", err.message);
  }

  return defaultReport;
}

// ─────────────────────────────────────────────────────────
// DEEP EXPLORATION: Login → Discover all modules → Deep test each one
// ─────────────────────────────────────────────────────────
export async function runDeepExploration({
  workspaceId,
  taskId,
  instructions,
  triggeredBy = null,
  triggerSource = "manual",
  timeoutMs = 600000,  // 10 min default — deep testing is thorough
  onRunCreated = null,
}) {
  const raw = String(instructions ?? "").trim();
  if (!raw) throw new Error("Instructions are required");

  const { url, email, password } = parseCredentialsFromInstructions(raw);
  if (!url) throw new Error("No URL found in instructions — include a full https:// URL");

  const { rows: taskRows } = await pool.query(
    `SELECT id, project_id FROM tasks WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [taskId, workspaceId]
  );
  if (!taskRows[0]) throw new Error("Task not found in workspace");
  const projectId = taskRows[0].project_id;

  const { rows: [run] } = await pool.query(
    `INSERT INTO testing_agent_runs
       (workspace_id, project_id, task_id, trigger_source, mode, status, generated_cases, commands, output_json, created_by)
     VALUES ($1,$2,$3,$4,'deep_exploration','running','[]'::jsonb,'[]'::jsonb,'{"phase":"login","stepResults":[]}'::jsonb,$5)
     RETURNING *`,
    [workspaceId, projectId, taskId, triggerSource, triggeredBy || null]
  );
  if (onRunCreated) onRunCreated(run.id);

  const allStepResults = [];
  const moduleReconData = [];   // Phase 1 output: what we observed
  const moduleTestPlans = [];   // Phase 2 output: LLM-generated test cases
  const moduleResults = [];     // Phase 3 output: execution results

  const browser = await createStealthBrowser();
  let context, page;

  try {
    context = await createStealthContext(browser);
    page = await context.newPage();
    page.on("dialog", async (d) => { try { await d.accept("yes"); } catch { /* ignore */ } });

    // ═══════════════════════════════════════════════════════
    // PHASE 1: LOGIN + RECON (observe every module, no testing)
    // ═══════════════════════════════════════════════════════
    await updateCurrentScreen(run.id, null, "Phase 1: Logging in and mapping the application…");

    // Step 1a: Login
    const loginSteps = [
      { action: "navigate", url, description: "Open application" },
      { action: "check_performance", description: "Initial page load performance" },
      { action: "screenshot", label: "login_page" },
    ];
    if (email && password) {
      loginSteps.push(
        { action: "ai_fill", description: "email or username input field", value: email },
        { action: "ai_fill", description: "password input field", value: password },
        { action: "ai_click", description: "login or sign in submit button" },
        { action: "wait", ms: 3000, description: "Wait for login redirect" },
        { action: "screenshot", label: "after_login" }
      );
    }

    const loginResults = await executeBrowserSteps(loginSteps, Math.min(timeoutMs, 60000), {
      runId: run.id,
      stopOnFailure: false,
      liveScreen: true,
      autoScreenshot: true,
      _existingPage: page,
      _existingContext: context,
      _existingBrowser: browser,
      _resultOffset: 0,
    });
    allStepResults.push(...loginResults);

    const criticalLoginFailed = email && loginResults.some((r) =>
      r.status === "failed" &&
      (r.action === "ai_fill" || r.action === "ai_click") &&
      r.action !== "check_performance"
    );
    if (criticalLoginFailed) throw new Error("Login failed — cannot proceed with deep exploration");

    try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch { /* ok */ }
    await page.waitForTimeout(2000);

    // Step 1b: Discover all navigation items
    await updateCurrentScreen(run.id, await takeScreenshot(page), "Phase 1: Discovering all modules in navigation…");
    await page.waitForTimeout(2500);
    await dismissOverlays(page).catch(() => {});

    let navItems = await discoverAllNavigationItems(page);
    if (navItems.length < 3) {
      await page.evaluate(() => {
        const sidebar = document.querySelector("aside, nav, [class*='sidebar'], [class*='side-bar'], [role='navigation']");
        if (sidebar) sidebar.scrollTop = 0;
      }).catch(() => {});
      await page.waitForTimeout(1000);
      navItems = await discoverAllNavigationItems(page);
    }
    if (navItems.length === 0) {
      navItems = await page.evaluate(() => {
        const hostname = window.location.hostname;
        const seen = new Set();
        return [...document.querySelectorAll("a[href]")]
          .filter((a) => {
            const href = a.getAttribute("href") || "";
            const text = (a.innerText || "").trim();
            if (!text || text.length < 2 || text.length > 40) return false;
            if (/^(mailto:|tel:|#|javascript:)/.test(href)) return false;
            if (/^https?:\/\//.test(href) && !href.includes(hostname)) return false;
            const rect = a.getBoundingClientRect();
            return rect.width > 0 || rect.height > 0;
          })
          .map((a) => ({ text: (a.innerText || "").trim(), href: a.getAttribute("href") }))
          .filter((item) => {
            if (seen.has(item.text.toLowerCase())) return false;
            seen.add(item.text.toLowerCase());
            return true;
          })
          .slice(0, 30);
      }).catch(() => []);
    }
    const targetModules = navItems.length > 0 ? navItems : [{ text: "Main", href: page.url() }];
    console.log(`[deepExplore] Phase 1: Discovered ${targetModules.length} modules:`, targetModules.map(n => n.text).join(", "));

    // Step 1c: Visit every module and collect recon data (observe only — no aggressive testing yet)
    for (const navItem of targetModules) {
      try {
        await updateCurrentScreen(run.id, await takeScreenshot(page), `Phase 1: Observing "${navItem.text}" module…`);

        const navigated = await (async () => {
          try {
            if (navItem.href && /^https?:\/\//.test(navItem.href)) {
              await page.goto(navItem.href, { timeout: 15000, waitUntil: "domcontentloaded" });
            } else if (navItem.href && navItem.href.startsWith("/")) {
              const origin = new URL(page.url()).origin;
              await page.goto(origin + navItem.href, { timeout: 15000, waitUntil: "domcontentloaded" });
            } else {
              const loc = page.getByText(navItem.text, { exact: false }).first();
              const vis = await loc.isVisible({ timeout: 3000 }).catch(() => false);
              if (vis) await loc.click({ timeout: 5000 });
              else return false;
            }
            await page.waitForTimeout(1500);
            try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch { /* ok */ }
            await dismissOverlays(page).catch(() => {});
            return true;
          } catch { return false; }
        })();

        if (!navigated) {
          console.log(`[deepExplore] Could not navigate to "${navItem.text}", skipping`);
          continue;
        }

        // ── Deep interactive recon: click every button, explore every tab ──
        await updateCurrentScreen(run.id, await takeScreenshot(page), `Phase 1: Deep exploring "${navItem.text}" — clicking buttons, mapping modals…`);
        const deepRecon = await deepReconModule(page, navItem.text);

        // Store a live screenshot step so the user can see progress
        const reconShot = deepRecon.elements.length > 0 ? await takeScreenshot(page) : null;
        allStepResults.push({
          stepIndex: allStepResults.length,
          action: "screenshot",
          description: `Recon: ${navItem.text} — ${deepRecon.clickableButtons.length} buttons, ${deepRecon.tabs.length} tabs discovered`,
          status: "passed",
          screenshot: reconShot,
          durationMs: 0,
        });
        await updateRunLive(run.id, allStepResults);

        moduleReconData.push({ ...deepRecon, screenshot: reconShot });
        console.log(`[deepExplore] Deep recon OK: "${navItem.text}" — ${deepRecon.clickableButtons.filter(b => b.opensModal).length} modals, ${deepRecon.tabs.length} tabs`);
      } catch (err) {
        console.warn(`[deepExplore] Recon failed for "${navItem.text}":`, err.message);
      }
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 2: AI GENERATES AGGRESSIVE TEST PLAN PER MODULE
    // ═══════════════════════════════════════════════════════
    const totalModals = moduleReconData.reduce((n, r) => n + (r.clickableButtons || []).filter(b => b.opensModal).length, 0);
    const totalTabs = moduleReconData.reduce((n, r) => n + (r.tabs || []).length, 0);
    await updateCurrentScreen(run.id, await takeScreenshot(page),
      `Phase 2: AI generating precise test cases — ${moduleReconData.length} modules, ${totalModals} modals discovered, ${totalTabs} tabs…`);
    console.log(`[deepExplore] Phase 2: ${moduleReconData.length} modules, ${totalModals} modals, ${totalTabs} tabs found during recon`);

    for (const recon of moduleReconData) {
      try {
        const testCases = await generateModuleTestCases(recon.name, recon);
        moduleTestPlans.push({ name: recon.name, url: recon.url, testCases });
        console.log(`[deepExplore] Phase 2: Generated ${testCases.length} test cases for "${recon.name}"`);
      } catch (err) {
        console.warn(`[deepExplore] Test case generation failed for "${recon.name}":`, err.message);
        moduleTestPlans.push({
          name: recon.name,
          url: recon.url,
          testCases: [
            { action: "navigate", url: recon.url, description: `Open ${recon.name}` },
            { action: "screenshot", label: `${recon.name.toLowerCase().replace(/\s+/g, "_")}_fallback` },
          ],
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 3: EXECUTE ALL TEST PLANS AGGRESSIVELY
    // ═══════════════════════════════════════════════════════
    console.log(`[deepExplore] Phase 3: Executing test plans for ${moduleTestPlans.length} modules`);

    for (const plan of moduleTestPlans) {
      const moduleOffset = allStepResults.length;
      await updateCurrentScreen(run.id, await takeScreenshot(page), `Phase 3: Testing "${plan.name}" — ${plan.testCases.length} test cases…`);

      let moduleStepResults = [];
      try {
        // Allocate time proportionally — each module gets at least 60s, at most 180s
        const remainingTime = timeoutMs - 120000; // reserve 2 min for finalization
        const perModuleMs = Math.min(
          Math.max(Math.floor(remainingTime / Math.max(moduleTestPlans.length, 1)), 60000),
          180000
        );
        moduleStepResults = await executeBrowserSteps(plan.testCases, perModuleMs, {
          runId: run.id,
          stopOnFailure: false,
          liveScreen: true,
          autoScreenshot: true,
          _existingPage: page,
          _existingContext: context,
          _existingBrowser: browser,
          _resultOffset: moduleOffset,
        });
      } catch (err) {
        console.warn(`[deepExplore] Phase 3 execution failed for "${plan.name}":`, err.message);
        moduleStepResults = [{
          stepIndex: moduleOffset,
          action: "error",
          description: `Execution error in ${plan.name}: ${err.message}`,
          status: "failed",
          error: err.message,
          screenshot: null,
          durationMs: 0,
          healed: false,
          aiAnalysis: null,
        }];
      }

      allStepResults.push(...moduleStepResults);
      await updateRunLive(run.id, allStepResults);

      const mPassed = moduleStepResults.filter(s => s.status === "passed").length;
      const mFailed = moduleStepResults.filter(s => s.status === "failed").length;
      moduleResults.push({
        name: plan.name,
        url: plan.url,
        status: mFailed > 0 ? "failed" : "passed",
        stepResults: moduleStepResults,
        testCasesGenerated: plan.testCases.length,
        summary: { total: moduleStepResults.length, passed: mPassed, failed: mFailed },
      });
      console.log(`[deepExplore] Module "${plan.name}": ${mPassed}✓ ${mFailed}✗`);
    }

  } finally {
    await browser.close();
  }

  // Generate comprehensive QA report
  await updateCurrentScreen(run.id, null, "Generating comprehensive QA bug report…");
  const passed = allStepResults.filter(s => s.status === "passed").length;
  const failed = allStepResults.filter(s => s.status === "failed").length;
  const skipped = allStepResults.filter(s => s.status === "skipped").length;
  const finalStatus = failed > 0 ? "failed" : "passed";

  const qaReport = await generateFullQAReport(allStepResults, moduleResults);

  // Backward-compatible insights object derived from the QA report
  const insights = {
    verdict: qaReport.verdict,
    whatWorked: qaReport.moduleReports.filter(m => m.healthScore >= 7).map(m => m.module).slice(0, 5),
    whatFailed: qaReport.bugsFound.slice(0, 5).map(b => b.title),
    rootCause: qaReport.bugsFound[0]?.description || null,
    recommendations: qaReport.topPriorityFixes.slice(0, 4),
    nextTestsToRun: qaReport.coverageGaps.slice(0, 4),
    performanceNote: qaReport.performanceIssues.length > 0 ? qaReport.performanceIssues[0] : null,
  };

  const output = {
    instructions: raw,
    phases: {
      recon: {
        modulesDiscovered: moduleReconData.length,
        modules: moduleReconData.map(m => m.name),
        totalModalsFound: moduleReconData.reduce((n, r) => n + (r.clickableButtons || []).filter(b => b.opensModal).length, 0),
        totalTabsFound: moduleReconData.reduce((n, r) => n + (r.tabs || []).length, 0),
        totalButtonsFound: moduleReconData.reduce((n, r) => n + (r.clickableButtons || []).length, 0),
      },
      plan: { modulesPlanned: moduleTestPlans.length, totalTestCases: moduleTestPlans.reduce((s, p) => s + p.testCases.length, 0) },
      execute: { modulesExecuted: moduleResults.length },
    },
    discoveredModules: moduleResults.map(m => m.name),
    modules: moduleResults.map(m => ({
      ...m,
      stepResults: m.stepResults.map(s => ({ ...s, screenshot: s.screenshot ? true : null })),
    })),
    stepResults: allStepResults,
    qaReport,
    insights,
    summary: {
      total: allStepResults.length,
      passed,
      failed,
      skipped,
      modules: moduleResults.length,
      bugsFound: qaReport.bugsFound.length,
      securityIssues: qaReport.securityConcerns.length,
      overallHealthScore: qaReport.overallHealthScore,
    },
  };

  await pool.query(
    `UPDATE testing_agent_runs SET status=$2, output_json=$3, finished_at=NOW() WHERE id=$1`,
    [run.id, finalStatus, JSON.stringify(output)]
  );

  return {
    runId: run.id,
    status: finalStatus,
    summary: output.summary,
    qaReport,
    insights,
    discoveredModules: output.discoveredModules,
    modules: moduleResults.map(m => ({
      name: m.name,
      status: m.status,
      summary: m.summary,
      testCasesGenerated: m.testCasesGenerated,
    })),
  };
}

// ─────────────────────────────────────────────────────────
// PUBLIC API (backward compatible)
// ─────────────────────────────────────────────────────────
// Quick pre-scan: navigate to URL, extract real nav + input elements for LLM grounding
async function quickPageScan(url) {
  const browser = await createStealthBrowser();
  try {
    const ctx = await createStealthContext(browser);
    const page = await ctx.newPage();
    await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    await dismissOverlays(page);
    return await page.evaluate(() => {
      const navEls = [...document.querySelectorAll(
        "nav a, aside a, [role='navigation'] a, [role='menuitem'], [role='tab'], [class*='nav'] a, [class*='sidebar'] a, header a"
      )].slice(0, 30);
      const inputEls = [...document.querySelectorAll("input, textarea, select")].slice(0, 15);
      return {
        navList: navEls.map(el => (el.innerText || el.getAttribute("aria-label") || "").trim())
          .filter(t => t.length > 1 && t.length < 50).join(", "),
        inputList: inputEls.map(el => (el.placeholder || el.getAttribute("aria-label") || el.name || el.type || "").trim())
          .filter(t => t.length > 0).join(", "),
      };
    }).catch(() => ({ navList: "", inputList: "" }));
  } catch {
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function runBrowserAgent({
  workspaceId,
  taskId,
  instructions,
  triggeredBy = null,
  triggerSource = "manual",
  timeoutMs = 120000,   // 2 minutes default; callers can pass up to 600000 (10 min) for long sessions
  onRunCreated = null,
}) {
  const raw = String(instructions ?? "").trim();
  if (!raw) throw new Error("Instructions are required");

  // ── Detect "explore / test all modules" intent ──
  // When the user says "test all modules", "explore everything", etc., the pre-scan trick
  // won't work because nav links only appear AFTER login. Route to runDeepExploration
  // which correctly logs in first, then discovers real nav items.
  const isDeepExploreIntent = /\b(all\s+modules?|all\s+features?|all\s+pages?|every\s+module|every\s+feature|explore\s+all|test\s+all|test\s+every|explore\s+every|check\s+all\s+modules?|test\s+each\s+module|go\s+through\s+all|entire\s+app|full\s+app|all\s+functionality)\b/i.test(raw);
  if (isDeepExploreIntent) {
    const { url } = parseCredentialsFromInstructions(raw);
    if (url) {
      console.log("[browserAgent] Detected explore-all-modules intent — routing to deep exploration");
      return runDeepExploration({
        workspaceId,
        taskId,
        instructions: raw,
        triggeredBy,
        triggerSource,
        timeoutMs: Math.max(timeoutMs, 300000), // at least 5 min for deep exploration
        onRunCreated,
      });
    }
  }

  // Pre-scan: if a URL is in the instructions, fetch real page elements so LLM
  // only generates steps for elements that ACTUALLY exist (no hallucinated modules).
  // Note: this only works for public pages — auth-gated pages will return no nav.
  let pageContext = null;
  const urlMatch = raw.match(/https?:\/\/[^\s,'"]+/);
  if (urlMatch) {
    pageContext = await quickPageScan(urlMatch[0]).catch(() => null);
  }

  const parsedSteps = await parseInstructionsToSteps(raw, pageContext);
  if (parsedSteps.length === 0) throw new Error('Could not parse steps. Try: "go to https://myapp.com, click Login, verify dashboard"');

  const { rows: taskRows } = await pool.query(
    `SELECT id, project_id FROM tasks WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [taskId, workspaceId]
  );
  if (!taskRows[0]) throw new Error("Task not found in workspace");
  const projectId = taskRows[0].project_id;

  const { rows: [run] } = await pool.query(
    `INSERT INTO testing_agent_runs
       (workspace_id, project_id, task_id, trigger_source, mode, status, generated_cases, commands, output_json, created_by)
     VALUES ($1,$2,$3,$4,'browser','running','[]'::jsonb,$5::jsonb,'{"stepResults":[]}'::jsonb,$6)
     RETURNING *`,
    [workspaceId, projectId, taskId, triggerSource, JSON.stringify(parsedSteps), triggeredBy || null]
  );
  if (onRunCreated) onRunCreated(run.id);

  let stepResults;
  try {
    stepResults = await executeBrowserSteps(parsedSteps, timeoutMs, { runId: run.id, stopOnFailure: false });
  } catch (err) {
    await pool.query(
      `UPDATE testing_agent_runs SET status='failed', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, JSON.stringify({ error: err.message, instructions: raw })]
    );
    throw err;
  }

  const passed = stepResults.filter((s) => s.status === "passed").length;
  const failed = stepResults.filter((s) => s.status === "failed").length;
  const skipped = stepResults.filter((s) => s.status === "skipped").length;
  const finalStatus = failed > 0 ? "failed" : "passed";

  const insights = await generateRunInsights(stepResults, "browser");
  const output = { instructions: raw, parsedSteps, stepResults, insights, summary: { total: stepResults.length, passed, failed, skipped } };

  await pool.query(
    `UPDATE testing_agent_runs SET status=$2, output_json=$3, finished_at=NOW() WHERE id=$1`,
    [run.id, finalStatus, JSON.stringify(output)]
  );

  return {
    runId: run.id,
    status: finalStatus,
    summary: output.summary,
    insights,
    steps: stepResults.map((s) => ({ ...s, screenshot: s.screenshot ? true : null })),
    parsedSteps,
  };
}

export async function getBrowserAgentRunById({ workspaceId, runId }) {
  const { rows } = await pool.query(
    `SELECT r.*, t.task AS task_name, p.name AS project_name
     FROM testing_agent_runs r
     INNER JOIN tasks t ON t.id = r.task_id
     INNER JOIN projects p ON p.id = r.project_id
     WHERE r.workspace_id = $1 AND r.id = $2
     LIMIT 1`,
    [workspaceId, runId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...r,
    generated_cases: typeof r.generated_cases === "string" ? JSON.parse(r.generated_cases) : r.generated_cases,
    commands: typeof r.commands === "string" ? JSON.parse(r.commands) : r.commands,
    output_json: typeof r.output_json === "string" ? JSON.parse(r.output_json) : r.output_json,
  };
}
