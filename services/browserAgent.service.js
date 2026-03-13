// services/browserAgent.service.js
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { generateText } from "../intelligence/llm/llmClient.js";
import pool from "../db.js";
import {
  createRunController,
  isRunCancelledError,
  RunCancelledError,
} from "./testingRunControl.service.js";

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

function clipText(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
        i++;
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

function safeJsonStringify(value) {
  return JSON.stringify(sanitizeForJson(value));
}

function normalizeActionTimeoutMs(value, fallback = 20000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(parsed, 1000);
}

async function waitWithCancellation(page, ms = 0, runController = null) {
  const total = Math.max(0, Number(ms || 0));
  if (!total) return;
  const sliceMs = 250;
  let elapsed = 0;
  while (elapsed < total) {
    if (runController) {
      await runController.assertActive({ phase: "wait", remainingMs: total - elapsed });
    }
    const chunk = Math.min(sliceMs, total - elapsed);
    await page.waitForTimeout(chunk);
    elapsed += chunk;
  }
}

function shouldSkipOptionalError(message = "") {
  const text = String(message || "").toLowerCase();
  return [
    "could not find",
    "not found on page",
    "element not found",
    "no tab found",
    "unknown action",
    "no element for",
    "could not find chat input",
    "could not find selectable control",
    "no matching option",
    "input[type=\"file\"]",
  ].some((pattern) => text.includes(pattern));
}

function pushBounded(list, entry, max = 30) {
  if (!Array.isArray(list)) return;
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

function ensurePageDiagnostics(page) {
  if (page.__testAgentDiagnostics) return page.__testAgentDiagnostics;

  const state = {
    pageErrors: [],
    consoleErrors: [],
    requestFailures: [],
    responseFailures: [],
    dialogs: [],
  };

  page.on("pageerror", (err) => {
    pushBounded(state.pageErrors, {
      message: clipText(err?.message || err, 220),
      time: Date.now(),
    });
  });

  page.on("console", (msg) => {
    const type = String(msg.type?.() || "");
    if (!["error", "warning"].includes(type)) return;
    pushBounded(state.consoleErrors, {
      type,
      text: clipText(msg.text?.() || "", 220),
      time: Date.now(),
    });
  });

  page.on("requestfailed", (req) => {
    pushBounded(state.requestFailures, {
      method: req.method?.() || "GET",
      url: clipText(req.url?.() || "", 180),
      errorText: clipText(req.failure?.()?.errorText || "request failed", 180),
      time: Date.now(),
    });
  });

  page.on("response", (res) => {
    const status = Number(res.status?.() || 0);
    if (status < 400) return;
    pushBounded(state.responseFailures, {
      status,
      url: clipText(res.url?.() || "", 180),
      time: Date.now(),
    });
  });

  page.on("dialog", (dialog) => {
    pushBounded(state.dialogs, {
      type: dialog.type?.() || "dialog",
      message: clipText(dialog.message?.() || "", 180),
      time: Date.now(),
    });
  });

  page.__testAgentDiagnostics = state;
  return state;
}

function snapshotPageDiagnostics(state) {
  return {
    pageErrors: state.pageErrors.length,
    consoleErrors: state.consoleErrors.length,
    requestFailures: state.requestFailures.length,
    responseFailures: state.responseFailures.length,
    dialogs: state.dialogs.length,
  };
}

function collectPageDiagnosticsDelta(state, snapshot) {
  const delta = {
    pageErrors: state.pageErrors.slice(snapshot.pageErrors),
    consoleErrors: state.consoleErrors.slice(snapshot.consoleErrors),
    requestFailures: state.requestFailures.slice(snapshot.requestFailures),
    responseFailures: state.responseFailures.slice(snapshot.responseFailures),
    dialogs: state.dialogs.slice(snapshot.dialogs),
  };
  delta.counts = {
    pageErrors: delta.pageErrors.length,
    consoleErrors: delta.consoleErrors.length,
    requestFailures: delta.requestFailures.length,
    responseFailures: delta.responseFailures.length,
    dialogs: delta.dialogs.length,
  };
  return delta;
}

function hasPageDiagnostics(delta) {
  if (!delta?.counts) return false;
  return Object.values(delta.counts).some((count) => Number(count || 0) > 0);
}

function summarizeRunDiagnostics(stepResults = []) {
  const summary = {
    pageErrors: 0,
    consoleErrors: 0,
    requestFailures: 0,
    responseFailures: 0,
    dialogs: 0,
    examples: [],
  };

  for (const step of stepResults) {
    const diag = step?.diagnostics;
    if (!diag?.counts) continue;
    summary.pageErrors += diag.counts.pageErrors || 0;
    summary.consoleErrors += diag.counts.consoleErrors || 0;
    summary.requestFailures += diag.counts.requestFailures || 0;
    summary.responseFailures += diag.counts.responseFailures || 0;
    summary.dialogs += diag.counts.dialogs || 0;

    const sample =
      diag.pageErrors?.[0]?.message ||
      diag.consoleErrors?.[0]?.text ||
      diag.requestFailures?.[0]?.errorText ||
      (diag.responseFailures?.[0] ? `${diag.responseFailures[0].status} ${diag.responseFailures[0].url}` : "") ||
      diag.dialogs?.[0]?.message;

    if (sample && summary.examples.length < 8) {
      summary.examples.push(`${step.description}: ${clipText(sample, 140)}`);
    }
  }

  return summary;
}

function ensureUploadFixtureFile() {
  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const fixturePath = path.join(uploadsDir, "__test_agent_upload.txt");
  if (!fs.existsSync(fixturePath)) {
    fs.writeFileSync(
      fixturePath,
      "Test Agent Upload Fixture\nGenerated automatically for browser upload coverage.\n",
      "utf8"
    );
  }
  return fixturePath;
}

function normalizeHintWords(description = "") {
  return String(description || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((word) => ![
      "select",
      "option",
      "dropdown",
      "choose",
      "pick",
      "field",
      "input",
      "filter",
      "value",
      "the",
      "and",
      "for",
      "with",
      "from",
      "into",
      "form",
      "list",
      "box",
      "menu",
    ].includes(word));
}

function inferFillIntent(description = "") {
  const text = String(description || "").toLowerCase();
  if (!text) return "text";
  if (/\bpassword|passcode|pwd\b/.test(text)) return "password";
  if (/\bemail|e-mail\b/.test(text)) return "email";
  if (/\busername|user name|login\b/.test(text)) return "username";
  if (/\bsearch|query\b/.test(text)) return "search";
  if (/\burl|website|link\b/.test(text)) return "url";
  if (/\bnumber|count|qty|quantity|amount|age|year\b/.test(text)) return "number";
  if (/\bdate\b/.test(text)) return "date";
  if (/\btime\b/.test(text)) return "time";
  if (/\bdescription|comment|message|note|bio|details\b/.test(text)) return "textarea";
  return "text";
}

async function findBestSelectableControl(page, description = "") {
  const hintWords = normalizeHintWords(description);
  return page.evaluate((words) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const textOf = (el) => normalize(el?.textContent || "");
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const tag = el.tagName.toLowerCase();
      const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${escapeAttr(name)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.length < 160) return `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const labelTextFor = (el) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      push(el.getAttribute?.("aria-label"));
      push(el.getAttribute?.("placeholder"));
      push(el.getAttribute?.("name"));
      push(el.id);

      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
          push(textOf(document.getElementById(id)));
        }
      }

      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        push(textOf(label));
      }

      push(textOf(el.closest("label")));

      const fieldContainer =
        el.closest("[data-testid], [role='group'], [role='dialog'], form, .field, .form-group, .input-group, .filters, .filter, .rs__control, [class*='select__control']") ||
        el.parentElement;
      if (fieldContainer) {
        const nearby = fieldContainer.querySelector("label, span, strong, legend, p");
        push(textOf(nearby));
      }

      return parts.join(" ");
    };
    const score = (text) => {
      if (!words.length) return 0;
      return words.reduce((sum, word) => sum + (text.includes(word) ? 2 : 0), 0);
    };

    const nodes = [
      ...document.querySelectorAll("select"),
      ...document.querySelectorAll("input[role='combobox']"),
      ...document.querySelectorAll("[role='combobox']"),
      ...document.querySelectorAll("input[id*='react-select'][id$='-input']"),
      ...document.querySelectorAll("[class*='select__control'], [class*='rs__control'], [class*='react-select__control']"),
    ];

    const seen = new Set();
    const candidates = [];
    for (const node of nodes) {
      let target = node;
      let mode = "combobox";

      if (node.matches("select")) {
        mode = "native-select";
      } else if (node.matches("[class*='select__control'], [class*='rs__control'], [class*='react-select__control']")) {
        target = node.querySelector("input[role='combobox'], input") || node;
        mode = target.matches("input, textarea") ? "combobox-input" : "combobox";
      } else if (node.matches("input, textarea")) {
        mode = "combobox-input";
      }

      const selector = cssPath(target);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);

      const labelText = labelTextFor(target);
      candidates.push({
        selector,
        mode,
        score: score(labelText),
        visible: visible(target) ? 1 : 0,
        labelText,
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.visible !== a.visible) return b.visible - a.visible;
      if (a.mode === "native-select" && b.mode !== "native-select") return -1;
      if (b.mode === "native-select" && a.mode !== "native-select") return 1;
      return 0;
    });

    return candidates[0] || null;
  }, hintWords).catch(() => null);
}

async function findBestFillableInput(page, description = "") {
  const hintWords = normalizeHintWords(description).filter(
    (word) => !["fill", "type", "enter", "input", "field", "box", "value", "text"].includes(word)
  );
  const intent = inferFillIntent(description);
  return page.evaluate(({ words, wantedIntent }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const textOf = (el) => normalize(el?.textContent || "");
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const tag = el.tagName.toLowerCase();
      const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const namedAttr = [
        ["data-testid", el.getAttribute("data-testid")],
        ["data-test", el.getAttribute("data-test")],
        ["data-qa", el.getAttribute("data-qa")],
      ].find(([, value]) => value);
      if (namedAttr) return `${tag}[${namedAttr[0]}="${escapeAttr(namedAttr[1])}"]`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${escapeAttr(name)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.length < 160) return `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const labelTextFor = (input) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      push(input.getAttribute("aria-label"));
      push(input.getAttribute("placeholder"));
      push(input.getAttribute("name"));
      push(input.id);
      const labelledBy = input.getAttribute("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
          push(textOf(document.getElementById(id)));
        }
      }
      if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        push(textOf(label));
      }
      push(textOf(input.closest("label")));
      push(textOf(input.closest("form, [role='dialog'], .field, .form-group, .input-group, [role='group']")?.querySelector("label, span, strong, legend, p")));
      push(textOf(input.parentElement?.querySelector("label, span, strong, legend, p")));
      push(textOf(input.parentElement?.previousElementSibling));
      push(textOf(input.closest("section, article, main, aside, div")?.querySelector("h1, h2, h3, h4, legend, [class*='title'], [class*='heading']")));
      return parts.join(" ");
    };
    const score = (candidate) => {
      let total = candidate.visible ? 1 : 0;
      const corpus = [
        candidate.labelText,
        candidate.placeholder,
        candidate.name,
        candidate.id,
        candidate.type,
      ]
        .map((value) => normalize(value))
        .join(" ");
      total += words.reduce((sum, word) => {
        if (!word) return sum;
        if (corpus === word) return sum + 6;
        if (corpus.includes(word)) return sum + 3;
        return sum;
      }, 0);

      if (wantedIntent === "email") {
        if (candidate.type === "email" || /\bemail\b/.test(corpus)) total += 10;
        if (/\buser(name)?\b|\blogin\b/.test(corpus)) total += 4;
        if (/\bpassword\b/.test(corpus)) total -= 10;
      } else if (wantedIntent === "password") {
        if (candidate.type === "password" || /\bpassword|passcode|pwd\b/.test(corpus)) total += 10;
        if (/\bemail\b/.test(corpus)) total -= 8;
      } else if (wantedIntent === "search") {
        if (candidate.type === "search" || /\bsearch|query\b/.test(corpus)) total += 8;
      } else if (wantedIntent === "url") {
        if (candidate.type === "url" || /\burl|website|link\b/.test(corpus)) total += 8;
      } else if (wantedIntent === "number") {
        if (candidate.type === "number" || /\bnumber|count|qty|quantity|amount|age|year\b/.test(corpus)) total += 8;
      } else if (wantedIntent === "date") {
        if (candidate.type === "date" || /\bdate\b/.test(corpus)) total += 8;
      } else if (wantedIntent === "time") {
        if (candidate.type === "time" || /\btime\b/.test(corpus)) total += 8;
      } else if (wantedIntent === "textarea") {
        if (candidate.type === "textarea" || /\bdescription|comment|message|note|bio|details\b/.test(corpus)) total += 8;
      }

      return total;
    };

    const raw = [
      ...document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']):not([type='file'])"),
      ...document.querySelectorAll("textarea"),
      ...document.querySelectorAll("[contenteditable='true']"),
      ...document.querySelectorAll("[role='textbox']"),
    ];
    const seen = new Set();
    const candidates = [];

    for (const input of raw) {
      const selector = cssPath(input);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      const type = (input.getAttribute("type") || input.tagName || "").toLowerCase();
      candidates.push({
        selector,
        labelText: labelTextFor(input),
        placeholder: input.getAttribute("placeholder") || null,
        name: input.getAttribute("name") || null,
        id: input.id || null,
        type,
        visible: visible(input) ? 1 : 0,
        attached: input.isConnected ? 1 : 0,
      });
    }

    candidates.sort((a, b) => {
      const scoreDiff = score(b) - score(a);
      if (scoreDiff !== 0) return scoreDiff;
      if (b.visible !== a.visible) return b.visible - a.visible;
      return b.attached - a.attached;
    });

    return candidates[0] || null;
  }, { words: hintWords, wantedIntent: intent }).catch(() => null);
}

async function locatorMatchesFillIntent(locator, description = "") {
  const intent = inferFillIntent(description);
  if (!description || intent === "text") return true;
  return locator.evaluate((el, wantedIntent) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const textOf = (node) => normalize(node?.textContent || "");
    const parts = [];
    const push = (value) => {
      const text = normalize(value);
      if (text && !parts.includes(text)) parts.push(text);
    };
    const type = normalize(el.getAttribute?.("type") || el.tagName || "");
    push(el.getAttribute?.("aria-label"));
    push(el.getAttribute?.("placeholder"));
    push(el.getAttribute?.("name"));
    push(el.id);
    if (el.id) {
      push(textOf(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)));
    }
    push(textOf(el.closest("label")));
    push(textOf(el.parentElement?.previousElementSibling));
    push(textOf(el.closest("form, [role='dialog'], .field, .form-group, .input-group, [role='group']")?.querySelector("label, span, strong, legend, p")));
    const corpus = parts.join(" ");

    if (wantedIntent === "email") {
      return type === "email" || ((/\bemail\b/.test(corpus) || /\buser(name)?\b|\blogin\b/.test(corpus)) && !/\bpassword\b/.test(corpus));
    }
    if (wantedIntent === "password") {
      return type === "password" || /\bpassword|passcode|pwd\b/.test(corpus);
    }
    if (wantedIntent === "search") {
      return type === "search" || /\bsearch|query\b/.test(corpus);
    }
    if (wantedIntent === "url") {
      return type === "url" || /\burl|website|link\b/.test(corpus);
    }
    if (wantedIntent === "number") {
      return type === "number" || /\bnumber|count|qty|quantity|amount|age|year\b/.test(corpus);
    }
    if (wantedIntent === "date") {
      return type === "date" || /\bdate\b/.test(corpus);
    }
    if (wantedIntent === "time") {
      return type === "time" || /\btime\b/.test(corpus);
    }
    if (wantedIntent === "textarea") {
      return el.tagName.toLowerCase() === "textarea" || /\bdescription|comment|message|note|bio|details\b/.test(corpus);
    }
    return true;
  }, intent).catch(() => true);
}

async function setInputValueDirectly(page, selector, value, description = "") {
  const assignBySelector = async (sel) => {
    if (!sel) return false;
    return page.evaluate(({ rawSelector, rawValue }) => {
      const assign = (el) => {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
        el.focus();
        el.value = "";
        el.value = rawValue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };

      let el = document.querySelector(rawSelector);
      if (!el) {
        const placeholderMatch = rawSelector.match(/placeholder="([\s\S]+?)"/i);
        if (placeholderMatch) {
          const wanted = placeholderMatch[1].replace(/\\\\/g, "\\");
          el = [...document.querySelectorAll("input, textarea")].find((node) => {
            const placeholder = node.getAttribute("placeholder") || "";
            return placeholder === wanted || (wanted && placeholder.includes(wanted.split(/\r?\n/)[0]));
          }) || null;
        }
      }
      return assign(el);
    }, { rawSelector: sel, rawValue: value }).catch(() => false);
  };

  if (await assignBySelector(selector)) return true;
  if (description) {
    const fallbackCandidate = await findBestFillableInput(page, description);
    if (fallbackCandidate?.selector) {
      return assignBySelector(fallbackCandidate.selector);
    }
  }
  return false;
}

async function findBestFileInput(page, description = "") {
  const hintWords = normalizeHintWords(description).filter((word) => !["upload", "file", "attachment", "attach"].includes(word));
  return page.evaluate((words) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const tag = el.tagName.toLowerCase();
      const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const namedAttr = [
        ["data-testid", el.getAttribute("data-testid")],
        ["data-test", el.getAttribute("data-test")],
        ["data-qa", el.getAttribute("data-qa")],
      ].find(([, value]) => value);
      if (namedAttr) return `${tag}[${namedAttr[0]}="${escapeAttr(namedAttr[1])}"]`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${escapeAttr(name)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const score = (text) => {
      if (!words.length) return 0;
      return words.reduce((sum, word) => sum + (text.includes(word) ? 2 : 0), 0);
    };
    const textOf = (el) => normalize(el?.textContent || "");
    const labelTextFor = (input) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      push(input.getAttribute("aria-label"));
      push(input.getAttribute("name"));
      push(input.id);
      if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        push(textOf(label));
      }
      push(textOf(input.closest("label")));
      push(textOf(input.closest("form, [role='dialog'], .field, .form-group, .input-group")?.querySelector("label, span, p, button")));
      return parts.join(" ");
    };

    const candidates = [...document.querySelectorAll('input[type="file"]')]
      .map((input) => ({
        selector: cssPath(input),
        labelText: labelTextFor(input),
        visible: visible(input) ? 1 : 0,
        attached: input.isConnected ? 1 : 0,
      }))
      .filter((item) => item.selector);

    candidates.sort((a, b) => {
      const scoreDiff = score(b.labelText) - score(a.labelText);
      if (scoreDiff !== 0) return scoreDiff;
      if (b.visible !== a.visible) return b.visible - a.visible;
      return b.attached - a.attached;
    });

    return candidates[0] || null;
  }, hintWords).catch(() => null);
}

async function pickVisibleOptionFromPopup(page, value, timeoutMs = 10000) {
  const desired = String(value || "").trim().toLowerCase();
  const selector = await page.evaluate((wanted) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const tag = el.tagName.toLowerCase();
      const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const namedAttr = [
        ["data-testid", el.getAttribute("data-testid")],
        ["data-test", el.getAttribute("data-test")],
        ["data-qa", el.getAttribute("data-qa")],
      ].find(([, value]) => value);
      if (namedAttr) return `${tag}[${namedAttr[0]}="${escapeAttr(namedAttr[1])}"]`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${escapeAttr(name)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.length < 160) return `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };

    const candidates = [
      ...document.querySelectorAll("[role='option']"),
      ...document.querySelectorAll("[id*='-option-']"),
      ...document.querySelectorAll(".rs__option, [class*='select__option']"),
      ...document.querySelectorAll("[role='listbox'] *"),
    ]
      .filter((el) => visible(el))
      .map((el) => ({
        selector: cssPath(el),
        text: normalize(el.textContent || ""),
      }))
      .filter((item) => item.selector && item.text);

    const exact = candidates.find((item) => item.text === wanted);
    if (exact) return exact.selector;
    const includes = candidates.find((item) => item.text.includes(wanted) || wanted.includes(item.text));
    return includes?.selector || null;
  }, desired).catch(() => null);

  if (!selector) return false;
  const option = page.locator(selector).first();
  await option.click({ timeout: Math.min(timeoutMs, 6000) });
  return true;
}

async function selectOptionRobust(page, step, timeoutMs = 10000) {
  const desiredValue = String(step.value ?? "").trim();
  const description = String(step.description ?? "").trim();
  const optionText = desiredValue || description;

  // ── Detect bad selectors: React dynamic IDs (#\:r2\:) and deep structural paths ──
  const hasDynamicId = /#\\?:[a-z0-9]+/i.test(step.selector || "");
  const isTooDeep = (step.selector || "").split(">").length > 4;
  const selectorIsUsable = step.selector && !hasDynamicId && !isTooDeep;

  // ── Phase 1: Handle native <select> ──
  if (selectorIsUsable) {
    try {
      const located = await smartLocate(page, step.selector, 4000);
      const tag = await located.loc.evaluate(el => el.tagName.toLowerCase()).catch(() => "");
      if (tag === "select") {
        const matched = await located.loc.evaluate((el, wanted) => {
          if (!(el instanceof HTMLSelectElement)) return null;
          const norm = v => String(v || "").trim().toLowerCase();
          const opts = [...el.options].filter(o => !o.disabled);
          const found = opts.find(o => norm(o.value) === norm(wanted) || norm(o.textContent) === norm(wanted))
            || opts.find(o => norm(o.value).includes(norm(wanted)) || norm(o.textContent).includes(norm(wanted)));
          return found ? { value: found.value } : null;
        }, desiredValue).catch(() => null);
        if (matched?.value) {
          await located.loc.selectOption(matched.value, { timeout: timeoutMs });
          return { usedSelector: located.usedSelector, healed: located.healed, mode: "native-select" };
        }
      }
    } catch { /* fall through to semantic approach */ }
  }

  // ── Phase 2: Check if listbox/dropdown is already open ──
  const alreadyOpen = await page.evaluate(() =>
    !!document.querySelector('[role="listbox"]:not([aria-hidden="true"]), .MuiMenu-paper:not([aria-hidden="true"]), .MuiPopover-paper [role="option"]')
  ).catch(() => false);

  // ── Phase 3: Find + click the trigger to open the dropdown ──
  let triggerSelector = null;
  if (!alreadyOpen) {
    // Try provided selector ONLY if it's a combobox/trigger (not a listbox item)
    let triggerLoc = null;
    if (selectorIsUsable) {
      try {
        const located = await smartLocate(page, step.selector, 3000);
        const isOption = await located.loc.evaluate(el =>
          el.getAttribute("role") === "option" ||
          el.getAttribute("aria-disabled") === "true" ||
          el.tagName.toLowerCase() === "li"
        ).catch(() => false);
        if (!isOption) {
          triggerLoc = located.loc;
          triggerSelector = located.usedSelector;
        }
      } catch { /* fall through */ }
    }

    // Semantic trigger discovery by description
    if (!triggerLoc) {
      const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const allTriggers = await page.evaluate(() => {
        const selects = document.querySelectorAll(
          '[role="combobox"], .MuiSelect-select, [aria-haspopup="listbox"], select, [class*="select-trigger"], [class*="SelectTrigger"]'
        );
        return [...selects].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).map(el => ({
          text: (el.textContent || el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60),
          label: (() => {
            const p = el.closest(".MuiFormControl-root, .form-group, [class*='field'], [class*='Field']");
            return p ? (p.querySelector("label, .MuiFormLabel-root, .MuiInputLabel-root")?.textContent || "").trim() : "";
          })(),
          ariaLabel: el.getAttribute("aria-label") || "",
          id: el.id || "",
        }));
      }).catch(() => []);

      // Score each trigger
      let bestScore = 0;
      let bestTrigger = null;
      for (const t of allTriggers) {
        const haystack = (t.text + " " + t.label + " " + t.ariaLabel).toLowerCase();
        const score = descWords.filter(w => haystack.includes(w)).length;
        if (score > bestScore) { bestScore = score; bestTrigger = t; }
      }

      if (bestTrigger) {
        const sel = bestTrigger.id ? `#${CSS.escape(bestTrigger.id)}` :
          bestTrigger.ariaLabel ? `[aria-label="${bestTrigger.ariaLabel}"]` :
          '[role="combobox"]';
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
            triggerLoc = loc; triggerSelector = sel;
          }
        } catch { /* next */ }
      }

      // Last resort: first visible combobox
      if (!triggerLoc) {
        const fallbackLoc = page.locator('[role="combobox"], .MuiSelect-select, [aria-haspopup="listbox"]').first();
        if (await fallbackLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
          triggerLoc = fallbackLoc; triggerSelector = '[role="combobox"]';
        }
      }
    }

    if (!triggerLoc) {
      throw new Error(`Could not find dropdown trigger for "${description || desiredValue}"`);
    }

    await triggerLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await triggerLoc.click({ timeout: 6000 });
    await page.waitForTimeout(500);
  }

  // ── Phase 4: Pick option by text from open listbox ──
  await page.waitForSelector('[role="option"], [role="listbox"]', { timeout: 5000 }).catch(() => {});

  const escText = optionText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionLoc = page.locator(
    '[role="option"]:not([aria-disabled="true"]):not(.Mui-disabled), [role="listbox"] li:not([aria-disabled="true"]):not(.Mui-disabled)'
  ).filter({ hasText: new RegExp(escText, "i") }).first();

  if (await optionLoc.isVisible({ timeout: 3000 }).catch(() => false)) {
    await optionLoc.click({ timeout: 5000 });
    await page.waitForTimeout(400);
    return { usedSelector: triggerSelector || '[role="combobox"]', healed: true, mode: "listbox-text" };
  }

  // Scan all non-disabled options for text match
  const allOptions = await page.locator('[role="option"]:not([aria-disabled="true"]):not(.Mui-disabled)').all().catch(() => []);
  for (const opt of allOptions.slice(0, 30)) {
    const text = await opt.textContent().catch(() => "");
    if (text.trim().toLowerCase().includes(optionText.toLowerCase())) {
      await opt.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await opt.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      return { usedSelector: triggerSelector || '[role="combobox"]', healed: true, mode: "listbox-scan" };
    }
  }

  // Pick first available option if nothing matches text
  if (allOptions.length > 0) {
    await allOptions[0].click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { usedSelector: triggerSelector || '[role="combobox"]', healed: true, mode: "listbox-first" };
  }

  // Fallback: type-to-filter combobox
  const inputLoc = page.locator('input[role="combobox"], input[aria-autocomplete="list"], input[aria-haspopup="listbox"]').first();
  if (await inputLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
    await inputLoc.fill("", { timeout: 3000 }).catch(() => {});
    await inputLoc.type(optionText, { delay: 30 });
    await page.waitForTimeout(400);
    const clickedOption = await pickVisibleOptionFromPopup(page, optionText, timeoutMs);
    if (!clickedOption) await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(400);
    return { usedSelector: triggerSelector || 'input[role="combobox"]', healed: true, mode: "combobox-type" };
  }

  await page.keyboard.press("Escape").catch(() => {});
  throw new Error(`Could not select option "${optionText}" — no matching non-disabled option found`);
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
      "--window-size=1920,1080",
    ],
  });
}

async function createStealthContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
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

// ─────────────────────────────────────────────────────────
// FORCE CLOSE MODAL — multi-strategy, verifies closure
// Replaces bare keyboard.press("Escape") throughout the agent.
// Always call this after interacting with a modal; it guarantees
// the modal is gone before the next step executes.
// ─────────────────────────────────────────────────────────
async function isModalOpen(page) {
  return page.evaluate(() => {
    const sel = [
      '[role="dialog"]:not([aria-hidden="true"])',
      '[aria-modal="true"]:not([aria-hidden="true"])',
      '.MuiDialog-root:not([aria-hidden="true"])',
      '.MuiModal-root:not([aria-hidden="true"])',
      '[class*="modal-open"], [class*="Modal"]:not([aria-hidden="true"])',
    ].join(", ");
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0);
  }).catch(() => false);
}

async function forceCloseModal(page, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const open = await isModalOpen(page);
    if (!open) return true; // already closed

    if (attempt === 1) {
      // Strategy 1: Escape key
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(350);
    } else if (attempt === 2) {
      // Strategy 2: Find Cancel/Close/X button inside the modal and click it
      const clicked = await page.evaluate(() => {
        const CLOSE_TEXT = /^(cancel|close|dismiss|discard|don't save|no thanks|✕|×|x|back|abort)$/i;
        const CLOSE_LABEL = /close|cancel|dismiss/i;
        const modals = document.querySelectorAll(
          '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"]), .MuiDialog-root:not([aria-hidden="true"])'
        );
        for (const modal of modals) {
          const btn =
            [...modal.querySelectorAll("button")].find(b => {
              const t = (b.innerText || b.getAttribute("aria-label") || b.title || "").trim();
              return CLOSE_TEXT.test(t) || CLOSE_LABEL.test(t);
            }) ||
            modal.querySelector('[aria-label="Close"], [aria-label="close"], [data-testid="close"], [class*="close-btn"], [class*="CloseButton"], [class*="modal-close"]') ||
            // MUI: the X button is typically the first button in DialogTitle
            modal.querySelector('.MuiDialogTitle-root button, .MuiModal-root > div > button');
          if (btn) { btn.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (!clicked) {
        // Second Escape attempt
        await page.keyboard.press("Escape").catch(() => {});
      }
      await page.waitForTimeout(400);
    } else if (attempt === 3) {
      // Strategy 3: Click the backdrop/overlay (outside the modal box)
      const clickedBackdrop = await page.evaluate(() => {
        const backdrop =
          document.querySelector(".MuiBackdrop-root, .MuiModal-backdrop, [class*='overlay'], [class*='Overlay'], [class*='backdrop'], [class*='Backdrop']");
        if (backdrop) { backdrop.click(); return true; }
        // Click outside the modal box at top-left corner
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (modal) {
          const r = modal.getBoundingClientRect();
          if (r.top > 20) {
            // Click above the modal
            document.elementFromPoint(r.left + r.width / 2, r.top - 10)?.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (!clickedBackdrop) {
        await page.mouse.click(10, 10).catch(() => {}); // click top-left corner
      }
      await page.waitForTimeout(400);
    } else {
      // Strategy 4: JS force-remove the modal from DOM (last resort)
      await page.evaluate(() => {
        const modals = document.querySelectorAll(
          '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"]), .MuiDialog-root:not([aria-hidden="true"])'
        );
        modals.forEach(m => {
          m.setAttribute("aria-hidden", "true");
          m.style.display = "none";
        });
        // Also remove body overflow lock
        document.body.style.overflow = "";
        document.body.classList.remove("modal-open", "overflow-hidden");
      }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // Final verification
  const stillOpen = await isModalOpen(page).catch(() => false);
  if (stillOpen) {
    console.warn("[forceCloseModal] Modal could not be closed after all strategies — forcing DOM removal");
    await page.evaluate(() => {
      document.querySelectorAll('[role="dialog"], [aria-modal="true"], .MuiDialog-root, .MuiModal-root').forEach(m => {
        m.style.display = "none";
        m.setAttribute("aria-hidden", "true");
      });
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    }).catch(() => {});
    await page.waitForTimeout(200);
  }
  return true;
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
      [runId, safeJsonStringify(livePayload)]
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
      [runId, safeJsonStringify({ screenshot: screenshot || null, caption, ts: Date.now() })]
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
  const placeholderMatch = selector.match(/placeholder="([\s\S]+?)"/i);
  const placeholderHint = placeholderMatch ? placeholderMatch[1].trim() : null;
  const placeholderFirstLine = placeholderHint ? placeholderHint.split(/\r?\n/)[0].trim() : null;
  const escapeCssValue = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Extract words from hint for partial matching
  const hintWords = textHint ? textHint.toLowerCase().split(/\s+/).filter(s => s.length > 2) : [];
  const firstWord = hintWords[0] || null;
  const placeholderWords = placeholderFirstLine ? placeholderFirstLine.toLowerCase().split(/\s+/).filter((s) => s.length > 2) : [];
  const placeholderWord = placeholderWords[0] || null;

  const strategies = [
    selector,
    selector.includes(":nth-child") ? selector.replace(/:\s*nth-child\(\d+\)/gi, "").trim() : null,
    textHint ? `text=${textHint}` : null,
    textHint ? `button:has-text("${textHint}")` : null,
    textHint ? `[role="button"]:has-text("${textHint}")` : null,
    textHint ? `a:has-text("${textHint}")` : null,
    textHint ? `[aria-label="${textHint}"]` : null,
    textHint ? `input[placeholder="${textHint}"]` : null,
    placeholderFirstLine ? `textarea[placeholder*="${escapeCssValue(placeholderFirstLine)}"]` : null,
    placeholderFirstLine ? `input[placeholder*="${escapeCssValue(placeholderFirstLine)}"]` : null,
    // Broader partial matches for inputs
    firstWord ? `input[placeholder*="${firstWord}"]` : null,
    firstWord ? `[aria-label*="${firstWord}"]` : null,
    firstWord ? `input[name*="${firstWord}"]` : null,
    placeholderWord ? `textarea[placeholder*="${escapeCssValue(placeholderWord)}"]` : null,
    placeholderWord ? `input[placeholder*="${escapeCssValue(placeholderWord)}"]` : null,
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
      const el =
        document.querySelector('input[type="password"]') ||
        document.querySelector('input[name*="password" i]') ||
        document.querySelector('input[autocomplete="current-password"]') ||
        document.querySelector('input[autocomplete="new-password"]') ||
        document.querySelector('input[placeholder*="password" i]') ||
        document.querySelector('input[aria-label*="password" i]');
      if (!el) return null;
      if (el.name) return `input[name="${el.name}"]`;
      if (el.id) return `#${el.id}`;
      if (el.getAttribute("placeholder")) return `input[placeholder="${el.getAttribute("placeholder")}"]`;
      if (el.getAttribute("aria-label")) return `input[aria-label="${el.getAttribute("aria-label")}"]`;
      return 'input[type="password"]';
    }).catch(() => null);
    if (found) return found;
  }

  // ── Email / username inputs ──
  if (isInputIntent && !isButtonIntent && (desc.includes("email") || desc.includes("username") || desc.includes("user name"))) {
    const found = await page.evaluate(() => {
      const el = document.querySelector('input[type="email"]') ||
                 document.querySelector('input[name*="email" i]') ||
                 document.querySelector('input[name*="user" i]') ||
                 document.querySelector('input[autocomplete="email"]') ||
                 document.querySelector('input[autocomplete="username"]') ||
                 document.querySelector('input[placeholder*="email" i]') ||
                 document.querySelector('input[placeholder*="user" i]') ||
                 document.querySelector('input[aria-label*="email" i]') ||
                 document.querySelector('input[aria-label*="user" i]');
      if (!el) return null;
      if (el.name) return `input[name="${el.name}"]`;
      if (el.id) return `#${el.id}`;
      if (el.placeholder) return `input[placeholder="${el.placeholder}"]`;
      if (el.getAttribute("aria-label")) return `input[aria-label="${el.getAttribute("aria-label")}"]`;
      return el.type === "email" ? 'input[type="email"]' : 'input[type="text"]';
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
async function validateElementForAction(page, description, mode = "click") {
  if (!description || typeof description !== "string") {
    return { found: false, loc: null, confidence: 0, selector: null, reason: "invalid description" };
  }

  try {
    if (mode === "fill") {
      const semanticCandidate = await findBestFillableInput(page, description);
      if (semanticCandidate?.selector) {
        try {
          const located = await smartLocate(page, semanticCandidate.selector, 4000);
          const visible = await located.loc.isVisible({ timeout: 1000 }).catch(() => false);
          return {
            found: visible,
            loc: located.loc,
            confidence: visible ? 0.95 : 0.3,
            selector: located.usedSelector,
            reason: visible ? "fillable control found semantically" : "fillable control found but not visible",
          };
        } catch {
          // Fall through to other fill-only strategies.
        }
      }

      for (const selector of ['input:not([type="hidden"])', "textarea", "select", '[role="textbox"]', '[contenteditable="true"]']) {
        try {
          const loc = page.locator(selector).first();
          const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
          if (visible) {
            return {
              found: true,
              loc,
              confidence: 0.4,
              selector,
              reason: "generic fillable control found",
            };
          }
        } catch {
          // Keep trying.
        }
      }
    }

    const selector = await aiIdentifySelector(page, description);
    if (!selector || typeof selector !== "string") {
      return { found: false, loc: null, confidence: 0, selector: null, reason: "aiIdentifySelector returned nothing" };
    }

    // Try to locate with a short timeout
    let loc = null;
    let usedSelector = selector;
    try {
      const located = await smartLocate(page, selector, 1500); // short pre-flight timeout
      loc = located.loc;
      usedSelector = located.usedSelector;
    } catch {
      // Quick role-based fallback (800ms per attempt — pre-flight must be fast)
      const words = description.replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 2).slice(0, 3);
      for (const word of words) {
        if (mode !== "fill") {
          try {
            const roleLoc = page.getByRole("button", { name: new RegExp(word, "i") }).first();
            const vis = await roleLoc.isVisible({ timeout: 800 }).catch(() => false);
            if (vis) { loc = roleLoc; usedSelector = `role=button[name~=${word}]`; break; }
          } catch { /* continue */ }
          try {
            const textLoc = page.getByText(new RegExp(word, "i")).first();
            const vis = await textLoc.isVisible({ timeout: 800 }).catch(() => false);
            if (vis) { loc = textLoc; usedSelector = `text~=${word}`; break; }
          } catch { /* continue */ }
        }
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
// ANALYZE TEST CASE RESULT
// Compares actual execution results against the expected result
// to produce a PASS / FAIL / BUG verdict with full bug details.
// Called per test case after Phase 3 execution.
// ─────────────────────────────────────────────────────────
async function analyzeTestCaseResult({ testCase, stepResults, pageText = "", screenshot = null }) {
  const passedCount = stepResults.filter(s => s.status === "passed").length;
  const failedSteps = stepResults.filter(s => s.status === "failed");
  const failedSummary = failedSteps
    .map(s => `  - [${s.action}] "${s.description}": ${String(s.error || "no error").slice(0, 120)}`)
    .join("\n");
  const assertionResults = stepResults
    .filter(s => s.action === "ai_assert")
    .map(s => `  ${s.status === "passed" ? "✓" : "✗"} ${s.description}`)
    .join("\n");

  const prompt = `You are a senior QA engineer reviewing test execution results.

TEST CASE: ${testCase.id || "TC-???"}
Title: "${testCase.title || "Untitled"}"
Priority: ${testCase.priority || "P1"}
Category: ${testCase.category || "functional"}

EXPECTED RESULT:
"${testCase.expected || "test passed without errors"}"

ACTUAL EXECUTION:
- Steps run: ${stepResults.length} (${passedCount} passed, ${failedSteps.length} failed)
${failedSummary ? "- Failed steps:\n" + failedSummary : "- No step failures"}
${assertionResults ? "- Assertions:\n" + assertionResults : ""}
- Page text visible after test: "${String(pageText || "").slice(0, 400)}"

Determine: does actual behavior match expected?
Key question: Is this a REAL APP BUG or just an automation/selector issue?
- "selector not found" / "timeout" alone = likely NOT a real bug (mark FAIL, not BUG)
- "button clicked but nothing happened" / "wrong error message" / "feature non-functional" = REAL BUG
- "XSS/SQL passed through without sanitization" = CRITICAL SECURITY BUG
- "validation errors not shown on empty submit" = MEDIUM BUG
- "missing feature" (feature described in UI but not implemented) = HIGH BUG

Return ONLY this JSON (no markdown):
{
  "status": "PASS",
  "actualBehavior": "one sentence describing what actually happened",
  "isBug": false,
  "bug": null
}
OR if a real bug:
{
  "status": "BUG",
  "actualBehavior": "one sentence describing what actually happened",
  "isBug": true,
  "bug": {
    "title": "short precise bug title",
    "severity": "Critical",
    "defectType": "Security Vulnerability | Functional Bug | Missing Feature | UX Issue | Performance Issue",
    "impact": "one sentence user/business impact",
    "fix": "one to two sentence fix recommendation"
  }
}`;

  try {
    const raw = await generateText({ prompt, maxTokens: 400 });
    const parsed = parseJsonSafe(raw, null);
    if (parsed && typeof parsed.status === "string") {
      return {
        status: parsed.status,
        actualBehavior: String(parsed.actualBehavior || "").slice(0, 300),
        isBug: Boolean(parsed.isBug),
        bug: parsed.isBug && parsed.bug ? parsed.bug : null,
      };
    }
  } catch { /* fall through */ }

  // Safe default: if more than half steps failed, mark as FAIL; else PASS
  const verdict = failedSteps.length > stepResults.length / 2 ? "FAIL" : "PASS";
  return {
    status: verdict,
    actualBehavior: verdict === "PASS"
      ? `${passedCount} of ${stepResults.length} steps passed.`
      : `${failedSteps.length} of ${stepResults.length} steps failed: ${failedSteps[0]?.description || "unknown step"}.`,
    isBug: false,
    bug: null,
  };
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
async function executeBrowserSteps(steps, timeoutMs = 120000, {
  runId = null,
  stopOnFailure = true,
  _existingPage = null,
  _existingContext = null,
  _existingBrowser = null,
  _resultOffset = 0,
  liveScreen = false,
  autoScreenshot = false,
  runController = null,
} = {}) {
  timeoutMs = normalizeActionTimeoutMs(timeoutMs, 20000);
  const _ownsBrowser = !_existingPage;
  let liveScreenInterval = null;
  const browser = _existingBrowser || await createStealthBrowser();
  const results = [];
  const activeRunController = runController || (runId ? createRunController(runId) : null);
  // Shared variable store — extract_text stores here, ${varName} is interpolated in later steps
  const variables = {};
  // Tab/page registry for multi-tab workflows
  const pages = [];

  // Pre-process: expand repeat blocks into individual steps
  const expandedSteps = expandSteps(steps);

  try {
    const context = _existingContext || await createStealthContext(browser);
    const page = _existingPage || await context.newPage();
    ensurePageDiagnostics(page);
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
      if (activeRunController) {
        await activeRunController.assertActive({ stepIndex: i + _resultOffset });
      }
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
      const pageDiagnostics = ensurePageDiagnostics(page);
      const diagnosticsSnapshot = snapshotPageDiagnostics(pageDiagnostics);

      // ── Overlay-state guard ───────────────────────────────────────
      // Before navigate/click/fill/assert steps: close any lingering modal OR
      // open dropdown/listbox/popover left over from a previous step.
      // An open dropdown will intercept all subsequent clicks if not dismissed first.
      if (["navigate", "ai_click", "click", "ai_fill", "ai_assert", "select_option"].includes(step.action)) {
        // 1. Check for open modal (dialog)
        const modalStillOpen = await isModalOpen(page).catch(() => false);
        if (modalStillOpen && step.action !== "select_option") {
          // Don't close modal before select_option — the modal itself may contain the select
          await forceCloseModal(page);
          await page.waitForTimeout(300);
        }

        // 2. Check for open dropdown / listbox / popover / menu
        //    These are NOT dialogs — MUI renders them as portals outside the modal
        const dropdownStillOpen = await page.evaluate(() => {
          const selectors = [
            '[role="listbox"]:not([aria-hidden="true"])',
            '[role="menu"]:not([aria-hidden="true"])',
            '.MuiMenu-paper:not([aria-hidden="true"])',
            '.MuiPopover-paper:not([aria-hidden="true"])',
            '.MuiAutocomplete-popper:not([aria-hidden="true"])',
            '[data-popper-placement]:not([aria-hidden="true"])',
            '[class*="dropdown-menu"]:not([aria-hidden="true"])',
            '[class*="DropdownMenu"]:not([aria-hidden="true"])',
          ].join(", ");
          const el = document.querySelector(selectors);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
        }).catch(() => false);

        if (dropdownStillOpen && step.action !== "select_option") {
          // Dismiss with Escape — dropdowns always close on Escape
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(250);
          // If still open, click outside at top-left corner
          const stillOpen = await page.evaluate(() => {
            const el = document.querySelector('[role="listbox"]:not([aria-hidden="true"]), [role="menu"]:not([aria-hidden="true"]), .MuiMenu-paper:not([aria-hidden="true"])');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).catch(() => false);
          if (stillOpen) {
            await page.mouse.click(10, 10).catch(() => {});
            await page.waitForTimeout(200);
          }
        }
      }
      // ──────────────────────────────────────────────────────────────

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
            if (step.selector) {
              try {
                locResult = await smartLocate(page, step.selector, timeoutMs);
              } catch { /* fall through to semantic lookup */ }
            }
            const validated = locResult
              ? { found: true, confidence: 1, loc: locResult.loc, selector: locResult.usedSelector, reason: "selector provided" }
              : await validateElementForAction(page, step.description);
            result.confidence = validated.confidence;

            if (!locResult && validated.found && validated.confidence >= 0.5) {
              // High-confidence: element found and visible — use it directly
              locResult = { loc: validated.loc, usedSelector: validated.selector, healed: false };
            } else if (!locResult) {
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
            let semanticFillCandidate = null;

            // LAYER 4: Validate element exists before filling (Observe → Plan → Select → Validate → Execute)
            if (step.selector) {
              try {
                fillLocResult = await smartLocate(page, step.selector, timeoutMs);
              } catch { /* fall through to semantic lookup */ }
            }
            if (!fillLocResult && step.description) {
              semanticFillCandidate = await findBestFillableInput(page, step.description);
              if (semanticFillCandidate?.selector) {
                try {
                  fillLocResult = await smartLocate(page, semanticFillCandidate.selector, timeoutMs);
                  fillLocResult.healed = true;
                } catch { /* continue to broader validation */ }
              }
            }
            const fillValidated = fillLocResult
              ? { found: true, confidence: 1, loc: fillLocResult.loc, selector: fillLocResult.usedSelector, reason: "selector provided" }
              : await validateElementForAction(page, step.description, "fill");
            result.confidence = fillValidated.confidence;

            if (!fillLocResult && fillValidated.found && fillValidated.confidence >= 0.5) {
              // High-confidence — element found and visible, use directly
              fillLocResult = { loc: fillValidated.loc, usedSelector: fillValidated.selector, healed: false };
            } else if (!fillLocResult) {
              const fillSel = fillValidated.selector || await aiIdentifySelector(page, step.description);

              // Attempt 1: AI-identified selector
              try { fillLocResult = await smartLocate(page, fillSel, timeoutMs); } catch { /* try fallbacks */ }

              if (!fillLocResult && semanticFillCandidate?.selector) {
                try {
                  fillLocResult = await smartLocate(page, semanticFillCandidate.selector, timeoutMs);
                  fillLocResult.healed = true;
                } catch { /* continue */ }
              }

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

            if (step.description) {
              const matchesIntent = await locatorMatchesFillIntent(fillLocResult.loc, step.description);
              if (!matchesIntent) {
                const fallbackCandidate = await findBestFillableInput(page, step.description);
                if (fallbackCandidate?.selector && fallbackCandidate.selector !== fillLocResult.usedSelector) {
                  try {
                    fillLocResult = await smartLocate(page, fallbackCandidate.selector, timeoutMs);
                    fillLocResult.healed = true;
                  } catch {
                    throw new Error(`Located field for "${step.description}" does not match the requested input type`);
                  }
                } else {
                  throw new Error(`Located field for "${step.description}" does not match the requested input type`);
                }
              }
            }

            result.usedSelector = fillLocResult.usedSelector;
            result.healed = fillLocResult.healed;

            // Verify the located element is actually fillable
            const isActualInput = await fillLocResult.loc.evaluate((el) =>
              el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
              el.contentEditable === "true" || el.isContentEditable
            ).catch(() => false);

            if (!isActualInput) {
              // Strategy A: look for input nested inside the located element
              const innerInput = fillLocResult.loc.locator("input, textarea, [contenteditable='true']").first();
              const innerVis = await innerInput.isVisible({ timeout: 800 }).catch(() => false);
              if (innerVis) {
                fillLocResult = { ...fillLocResult, loc: innerInput, healed: true };
              } else {
                // Strategy B: click the element to focus it, then use document.activeElement
                // Custom search components (MUI SearchBar, etc.) focus an inner <input> on click
                await fillLocResult.loc.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(200);
                const activeIsInput = await page.evaluate(() => {
                  const ae = document.activeElement;
                  return ae && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || ae.contentEditable === "true");
                }).catch(() => false);
                if (activeIsInput) {
                  // activeElement is now the real input — use keyboard type directly
                  await page.keyboard.type(String(step.value ?? ""), { delay: 20 });
                  break; // skip the fill block below, we already typed
                }
                // Strategy C: page-wide input scan
                const inputs = [
                  'input[type="search"]', 'input[type="text"]',
                  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])',
                  'textarea', '[contenteditable="true"]',
                ];
                let found = false;
                for (const sel of inputs) {
                  const candidate = page.locator(sel).first();
                  const vis = await candidate.isVisible({ timeout: 600 }).catch(() => false);
                  if (vis) {
                    fillLocResult = { ...fillLocResult, loc: candidate, usedSelector: sel, healed: true };
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  throw new Error(`Located element for "${step.description}" is not fillable (tag: ${await fillLocResult.loc.evaluate(el => el.tagName).catch(() => "unknown")})`);
                }
              }
            }

            // Check if target is a contenteditable div (chat apps, rich text editors)
            const isContentEditable = await fillLocResult.loc.evaluate((el) =>
              el.contentEditable === "true" || el.isContentEditable
            ).catch(() => false);

            if (isContentEditable) {
              await typeSlowly(page, fillLocResult.loc, String(step.value ?? ""), 30);
            } else {
              const inputMeta = await fillLocResult.loc.evaluate((el) => ({
                tag: el.tagName.toLowerCase(),
                type: (el.getAttribute("type") || "").toLowerCase(),
              })).catch(() => ({ tag: "", type: "" }));
              const fillValue = String(step.value ?? "");
              await fillLocResult.loc.click({ timeout: 3000 }).catch(() => {});
              try {
                await fillLocResult.loc.fill(fillValue, { timeout: timeoutMs });
              } catch (fillError) {
                const assigned = await fillLocResult.loc.evaluate((el, value) => {
                  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
                  el.focus();
                  el.value = "";
                  el.value = value;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }, fillValue).catch(() => false);
                if (!assigned) {
                  const assignedDirectly = await setInputValueDirectly(page, fillLocResult.usedSelector, fillValue, step.description);
                  if (assignedDirectly) {
                    break;
                  }
                  if (["number", "date", "time", "datetime-local"].includes(inputMeta.type)) {
                    await fillLocResult.loc.evaluate((el, value) => {
                      el.focus();
                      el.value = "";
                      el.value = value;
                      el.dispatchEvent(new Event("input", { bubbles: true }));
                      el.dispatchEvent(new Event("change", { bubbles: true }));
                    }, fillValue);
                  } else {
                    throw fillError;
                  }
                }
              }
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
            await waitWithCancellation(page, Number(step.ms) || 1000, activeRunController);
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
            const selectMeta = await selectOptionRobust(page, step, timeoutMs);
            result.usedSelector = selectMeta.usedSelector;
            result.healed = selectMeta.healed;
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
              if (activeRunController) {
                await activeRunController.assertActive({ stepIndex: i + _resultOffset, loop: "loop_until", iteration: iterations + 1 });
              }
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
                  runController: activeRunController,
                });
                // Push sub-step results into the live run
                if (runId && innerResult.length > 0) {
                  const merged = [...results, ...innerResult];
                  await updateRunLive(runId, merged);
                }
              }

              await waitWithCancellation(page, step.pauseMs || 800, activeRunController);

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
              if (activeRunController) {
                await activeRunController.assertActive({ stepIndex: i + _resultOffset, loop: "complete_flow", flowStepCount: flowStepCount + 1 });
              }
              flowStepCount++;

              // Observe current page state
              await waitWithCancellation(page, 800, activeRunController);
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
                runController: activeRunController,
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
            ensurePageDiagnostics(newPage);
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
            ensurePageDiagnostics(activePage);
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
            const runtime = ensurePageDiagnostics(page);
            const runtimeIssues = [
              ...runtime.pageErrors.slice(-3).map((e) => e.message),
              ...runtime.consoleErrors.slice(-3).map((e) => `${e.type}: ${e.text}`),
              ...runtime.requestFailures.slice(-2).map((e) => `${e.method} ${e.url}: ${e.errorText}`),
              ...runtime.responseFailures.slice(-2).map((e) => `HTTP ${e.status} ${e.url}`),
            ];
            if (errors.length > 0 || runtimeIssues.length > 0) {
              throw new Error(`JS/runtime errors detected: ${[...errors.slice(0, 3), ...runtimeIssues].slice(0, 4).join("; ")}`);
            }
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
            const resolvedFilePath = step.filePath && fs.existsSync(step.filePath)
              ? path.resolve(step.filePath)
              : step.file && fs.existsSync(step.file)
                ? path.resolve(step.file)
                : ensureUploadFixtureFile();
            result.description = `Upload file: ${path.basename(resolvedFilePath)}`;
            let fileInput = null;
            let usedSelector = null;
            if (step.selector) {
              try {
                const located = await smartLocate(page, step.selector, timeoutMs);
                fileInput = located.loc;
                usedSelector = located.usedSelector;
                result.healed = located.healed;
              } catch {
                // Dynamic forms often rerender file inputs; fall back to semantic discovery below.
              }
            }
            if (!fileInput && step.description) {
              const discovered = await findBestFileInput(page, step.description);
              if (discovered?.selector) {
                fileInput = page.locator(discovered.selector).first();
                usedSelector = discovered.selector;
                result.healed = true;
              }
            }
            if (!fileInput) {
              usedSelector = 'input[type="file"]';
              fileInput = page.locator(usedSelector).first();
            }
            result.usedSelector = usedSelector;
            await fileInput.setInputFiles(resolvedFilePath, { timeout: timeoutMs });
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
            const selectMeta = await selectOptionRobust(page, step, timeoutMs);
            result.usedSelector = selectMeta.usedSelector;
            result.healed = selectMeta.healed;
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
        if (isRunCancelledError(err)) {
          throw err;
        }
        const errorMessage = err.message?.slice(0, 400) ?? "Unknown error";
        result.error = errorMessage;
        if (step.optional && shouldSkipOptionalError(errorMessage)) {
          result.status = "skipped";
          result.description = `Optional: ${result.description}`;
        } else {
          result.status = "failed";
        }
        try { result.screenshot = await takeScreenshot(page); } catch { /* ignore */ }
        if (result.status === "failed") {
          result.aiAnalysis = await aiAnalyzeFailure(step, result.error);
        }
      }

      result.durationMs = Date.now() - t0;
      result.currentUrl = clipText(activePage.url(), 220);
      const diagnosticsDelta = collectPageDiagnosticsDelta(pageDiagnostics, diagnosticsSnapshot);
      if (hasPageDiagnostics(diagnosticsDelta)) {
        result.diagnostics = diagnosticsDelta;
      }
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
  const runController = createRunController(run.id);
  const actionTimeoutMs = normalizeActionTimeoutMs(timeoutMs, 20000);

  // Phase 1: Discover page (stealth browser)
  let pageInfo = { title: "", visibleText: "", elements: [] };
  let initialScreenshot = null;
  const discoverBrowser = await createStealthBrowser();
  try {
    const ctx = await createStealthContext(discoverBrowser);
    const page = await ctx.newPage();
    await page.goto(url, { timeout: actionTimeoutMs, waitUntil: "domcontentloaded" });
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
      [run.id, safeJsonStringify({ error: `Page discovery failed: ${err.message}`, url })]
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
    [run.id, safeJsonStringify(discoveredSteps)]
  );

  // Phase 3: Execute
  let stepResults = [];
  try {
    stepResults = await executeBrowserSteps(discoveredSteps, actionTimeoutMs, {
      runId: run.id,
      stopOnFailure: false,
      runController,
    });
  } catch (err) {
    if (isRunCancelledError(err)) {
      const output = {
        url,
        pageTitle: pageInfo.title,
        initialScreenshot,
        discoveredSteps,
        stepResults,
        cancelControl: {
          message: err.message,
          details: err.details || null,
        },
        summary: {
          total: stepResults.length,
          passed: stepResults.filter((step) => step.status === "passed").length,
          failed: stepResults.filter((step) => step.status === "failed").length,
          skipped: stepResults.filter((step) => step.status === "skipped").length,
          cancelled: true,
        },
      };
      await pool.query(
        `UPDATE testing_agent_runs SET status='cancelled', output_json=$2, finished_at=NOW() WHERE id=$1`,
        [run.id, safeJsonStringify(output)]
      );
      return {
        runId: run.id,
        status: "cancelled",
        summary: output.summary,
      };
    }
    await pool.query(
      `UPDATE testing_agent_runs SET status='failed', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, safeJsonStringify({ error: err.message, url, discoveredSteps })]
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
    [run.id, finalStatus, safeJsonStringify(output)]
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

function buildMultiScenarioSummary(scenarioResults = []) {
  const total = scenarioResults.length;
  const passed = scenarioResults.filter((scenario) => scenario.status === "passed").length;
  const failed = scenarioResults.filter((scenario) => scenario.status === "failed").length;
  const skipped = scenarioResults.filter((scenario) => scenario.status === "skipped").length;
  const cancelled = scenarioResults.some((scenario) => scenario.status === "cancelled");
  const overallStatus = cancelled
    ? "cancelled"
    : total > 0 && passed === total
      ? "passed"
      : total > 0 && failed === total
        ? "failed"
        : "partial";
  return { total, passed, failed, skipped, cancelled, overallStatus };
}

export async function runMultiScenario({
  workspaceId,
  taskId,
  description,
  url = null,
  triggeredBy = null,
  triggerSource = "manual",
  timeoutMs = 60000,
  onRunCreated = null,
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
  const actionTimeoutMs = normalizeActionTimeoutMs(timeoutMs, 20000);

  const plannedScenarioTypes = Object.entries(scenarios)
    .filter(([, steps]) => Array.isArray(steps) && steps.length > 0)
    .map(([type]) => type);

  const { rows: [run] } = await pool.query(
    `INSERT INTO testing_agent_runs
       (workspace_id, project_id, task_id, trigger_source, mode, status, generated_cases, commands, output_json, created_by)
     VALUES ($1,$2,$3,$4,'multi_scenario','running',$5::jsonb,$6::jsonb,$7::jsonb,$8)
     RETURNING *`,
    [
      workspaceId,
      projectId,
      taskId,
      triggerSource,
      safeJsonStringify(plannedScenarioTypes),
      safeJsonStringify(plannedScenarioTypes.map((type) => LABELS[type] || type)),
      safeJsonStringify({
        description,
        url,
        scenarios: [],
        stepResults: [],
        summary: {
          total: plannedScenarioTypes.length,
          passed: 0,
          failed: 0,
          skipped: 0,
          cancelled: false,
          overallStatus: "running",
        },
      }),
      triggeredBy || null,
    ]
  );
  if (onRunCreated) onRunCreated(run.id);
  const runController = createRunController(run.id);

  const scenarioResults = [];

  for (const [type, steps] of Object.entries(scenarios)) {
    if (!Array.isArray(steps) || steps.length === 0) continue;

    let stepResults = [];
    try {
      await runController.assertActive({ phase: "scenario_start", scenario: type });
      stepResults = await executeBrowserSteps(steps, actionTimeoutMs, {
        runId: run.id,
        stopOnFailure: false,
        runController,
      });
    } catch (err) {
      if (isRunCancelledError(err)) {
        const summary = buildMultiScenarioSummary(scenarioResults);
        const output = {
          description,
          url,
          scenarios: scenarioResults,
          stepResults: scenarioResults.flatMap((scenario) => scenario.stepResults || []),
          summary,
          overallStatus: "cancelled",
          cancelControl: {
            message: err.message,
            details: err.details || null,
          },
        };
        await pool.query(
          `UPDATE testing_agent_runs SET status='cancelled', output_json=$2, finished_at=NOW() WHERE id=$1`,
          [run.id, safeJsonStringify(output)]
        );
        return {
          runId: run.id,
          status: "cancelled",
          description,
          scenarios: scenarioResults,
          overallStatus: "cancelled",
          summary,
        };
      }
      stepResults = [{ stepIndex: 0, action: "error", description: err.message, status: "failed", error: err.message, screenshot: null, metrics: null, durationMs: 0, healed: false, aiAnalysis: null, usedSelector: null, value: null, selector: null }];
    }

    const passed = stepResults.filter((s) => s.status === "passed").length;
    const failed = stepResults.filter((s) => s.status === "failed").length;
    const skipped = stepResults.filter((s) => s.status === "skipped").length;
    const finalStatus = failed > 0 ? "failed" : "passed";
    const insights = await generateRunInsights(stepResults, `multi_scenario:${type}`);

    scenarioResults.push({
      runId: run.id,
      type,
      label: LABELS[type],
      status: finalStatus,
      insights,
      stepResults,
      summary: { total: stepResults.length, passed, failed, skipped },
      steps: stepResults.map((s) => ({ ...s, screenshot: s.screenshot ? true : null })),
    });

    const summary = buildMultiScenarioSummary(scenarioResults);
    await pool.query(
      `UPDATE testing_agent_runs SET output_json=$2 WHERE id=$1`,
      [run.id, safeJsonStringify({
        description,
        url,
        scenarios: scenarioResults,
        stepResults: scenarioResults.flatMap((scenario) => scenario.stepResults || []),
        summary,
        overallStatus: summary.overallStatus,
        activeScenario: type,
      })]
    );
  }

  const summary = buildMultiScenarioSummary(scenarioResults);
  const finalStatus = summary.overallStatus === "passed" ? "passed" : summary.overallStatus === "failed" ? "failed" : "partial";
  const output = {
    description,
    url,
    scenarios: scenarioResults,
    stepResults: scenarioResults.flatMap((scenario) => scenario.stepResults || []),
    summary,
    overallStatus: finalStatus,
  };

  await pool.query(
    `UPDATE testing_agent_runs SET status=$2, output_json=$3, finished_at=NOW() WHERE id=$1`,
    [run.id, finalStatus, safeJsonStringify(output)]
  );

  return {
    runId: run.id,
    status: finalStatus,
    description,
    scenarios: scenarioResults,
    overallStatus: finalStatus,
    summary,
  };
}

// ─────────────────────────────────────────────────────────
// DEEP EXPLORATION HELPERS
// ─────────────────────────────────────────────────────────

function extractCredentialValue(instructions, labels = []) {
  for (const label of labels) {
    const regex = new RegExp(
      `${label}\\s*(?:=|:|-)\\s*(?:"([^"]+)"|'([^']+)'|([^\\n,;]+))`,
      "i"
    );
    const match = instructions.match(regex);
    if (!match) continue;
    const value = match[1] || match[2] || match[3];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function parseCredentialsFromInstructions(instructions) {
  const explicitUrl = extractCredentialValue(instructions, ["url", "website", "site"]);
  const urlMatch = instructions.match(/https?:\/\/[^\s,'"]+/);
  const url = explicitUrl || (urlMatch ? urlMatch[0] : null);
  const email = extractCredentialValue(instructions, ["email", "e-mail", "username", "user", "login"]);
  const password = extractCredentialValue(instructions, ["password", "pass", "pwd"]);

  return {
    url,
    email,
    password,
  };
}

async function navigateToDiscoveredModule(page, navItem, originUrl = null) {
  try {
    if (navItem?.href && /^https?:\/\//.test(navItem.href)) {
      await page.goto(navItem.href, { timeout: 20000, waitUntil: "domcontentloaded" });
    } else if (navItem?.href && navItem.href.startsWith("/")) {
      const origin = originUrl ? new URL(originUrl).origin : new URL(page.url()).origin;
      await page.goto(new URL(navItem.href, origin).toString(), { timeout: 20000, waitUntil: "domcontentloaded" });
    } else if (navItem?.url && /^https?:\/\//.test(navItem.url)) {
      await page.goto(navItem.url, { timeout: 20000, waitUntil: "domcontentloaded" });
    } else if (navItem?.text) {
      const loc = page.getByText(navItem.text, { exact: false }).first();
      const vis = await loc.isVisible({ timeout: 3000 }).catch(() => false);
      if (!vis) return false;
      await loc.click({ timeout: 5000 });
    } else {
      return false;
    }

    await page.waitForTimeout(1500);
    try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch { /* ok */ }
    await dismissOverlays(page).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// Broad navigation discovery — uses position-based primary + class-based secondary
async function discoverAllNavigationItems(page) {
  // ── Pre-step 1: Try to open collapsed MUI Drawer / hamburger menu ──
  // MUI Drawer items have getBoundingClientRect() = 0 when collapsed (CSS transform off-screen)
  // Clicking the hamburger opens the drawer so DOM items become visible
  const hamburgerClicked = await page.evaluate(() => {
    // Look for hamburger/menu toggle in the header/appbar area
    const candidates = [
      document.querySelector('[aria-label*="menu" i]:not([aria-haspopup="listbox"]):not([aria-haspopup="menu"])'),
      document.querySelector('[aria-label*="open navigation" i]'),
      document.querySelector('[aria-label*="open sidebar" i]'),
      document.querySelector('[aria-label*="toggle menu" i]'),
      document.querySelector('[aria-label*="toggle nav" i]'),
      document.querySelector('.MuiIconButton-root[aria-label*="menu" i]'),
      // MUI hamburger: button wrapping a MenuIcon SVG
      document.querySelector('button svg[data-testid="MenuIcon"]')?.closest("button"),
      document.querySelector('button svg[data-testid="MenuOpenIcon"]')?.closest("button"),
      // Generic: button in header with no text (icon-only buttons)
      ...[...document.querySelectorAll("header button, [class*='AppBar'] button, [class*='appbar'] button, [class*='toolbar'] button, [class*='Toolbar'] button")]
        .filter(b => {
          const r = b.getBoundingClientRect();
          const txt = (b.innerText || b.getAttribute("aria-label") || "").trim();
          // Icon-only button (no text or very short) in the header area
          return r.top < 80 && r.width > 0 && txt.length < 5;
        }),
    ].filter(Boolean);
    if (candidates[0]) { try { candidates[0].click(); return true; } catch {} }
    return false;
  }).catch(() => false);
  if (hamburgerClicked) await page.waitForTimeout(700).catch(() => {});

  // ── Pre-step 2: Expand any collapsed accordion/nav groups ──
  await page.evaluate(() => {
    document.querySelectorAll("[aria-expanded='false'][role='button'], [aria-expanded='false'][class*='Accordion'], [aria-expanded='false'][class*='Collapse']").forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.left < 400) { try { el.click(); } catch {} }
    });
  }).catch(() => {});
  await page.waitForTimeout(500).catch(() => {});

  // ── STRATEGY 0: Full DOM href scan (catches MUI Drawer items even when drawer is collapsed) ──
  // MUI Drawer with variant="persistent"/"temporary" renders <a href> in DOM even when off-screen.
  // getBoundingClientRect() returns zero for these, so position-based scan misses them.
  // This scan finds ALL internal href links regardless of visibility.
  const hrefItems = await page.evaluate(() => {
    const seen = new Set();
    const items = [];
    const hostname = window.location.hostname;
    const NOISE = /^(sign.?out|log.?out|close|×|✕|cancel|help|support|ok|profile|avatar|logo|\?|⚙|settings|back|home icon|notifications?|\d+)$/i;

    // Scan every <a href> in the entire document (including hidden/off-screen ones)
    document.querySelectorAll("a[href]").forEach(el => {
      const href = el.getAttribute("href") || "";
      const text = (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (!text || text.length < 2 || text.length > 55) return;
      if (NOISE.test(text)) return;
      if (seen.has(text.toLowerCase())) return;
      if (/^(mailto:|tel:|javascript:|#$)/.test(href)) return;
      if (/^https?:\/\//.test(href)) {
        try { if (new URL(href).hostname !== hostname) return; } catch { return; }
      }
      // Skip external-looking hrefs
      if (href.startsWith("http") && !href.includes(hostname)) return;
      seen.add(text.toLowerCase());
      items.push({ text, href: href || null });
    });
    return items.slice(0, 60);
  }).catch(() => []);

  // ── PRIMARY STRATEGY: Position-based scan ──
  // Find ALL clickable elements visually located in the left sidebar region (x < 320px, y > 56px)
  // This works regardless of CSS framework, class names, or component library
  const positionItems = await page.evaluate(() => {
    const seen = new Set();
    const items = [];
    const SIDEBAR_MAX_X = Math.min(340, window.innerWidth * 0.22);
    const HEADER_HEIGHT = 56;
    const NOISE = /^(×|✕|close|≡|☰|🔔|\?|⚙|›|‹|>|<|\d{1,3}|notifications?|account|avatar|logo)$/i;

    const candidates = [
      ...document.querySelectorAll(
        'a, button, [role="button"], [role="menuitem"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'
      )
    ];

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.left > SIDEBAR_MAX_X) continue;
      if (rect.top < HEADER_HEIGHT) continue;
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height > 72) continue; // skip large panels

      // Get the cleanest text available (prefer direct children, avoid icon text)
      const raw = (el.innerText || el.getAttribute("aria-label") || el.title || el.getAttribute("data-label") || "")
        .trim().replace(/\s+/g, " ");
      // Remove leading icon characters (emojis, SVG text artefacts)
      const text = raw.replace(/^[\s\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+/u, "").trim().slice(0, 60);

      if (!text || text.length < 2 || text.length > 55) continue;
      if (NOISE.test(text)) continue;
      if (seen.has(text.toLowerCase())) continue;

      const href = el.getAttribute("href") || null;
      if (href && /^(mailto:|tel:|javascript:|#$)/.test(href)) continue;
      if (href && /^https?:\/\//.test(href)) {
        try { if (new URL(href).hostname !== window.location.hostname) continue; } catch { continue; }
      }

      seen.add(text.toLowerCase());
      items.push({ text, href: href || null });
    }
    return items;
  }).catch(() => []);

  // ── SECONDARY STRATEGY: Class/selector-based scan ──
  // Catches items that may be outside the left column or use non-standard positions
  const classItems = await page.evaluate(() => {
    const seen = new Set();
    const collected = [];
    const NOISE = /^(×|✕|close|≡|☰|🔔|\?|⚙|›|‹)$/i;

    function getText(el) {
      return (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
    }
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function addItem(el) {
      const text = getText(el);
      if (!text || text.length < 2 || text.length > 55) return;
      if (NOISE.test(text)) return;
      if (seen.has(text.toLowerCase())) return;
      if (!isVisible(el)) return;
      const href = el.getAttribute("href") || null;
      if (href && /^(mailto:|tel:|javascript:|#$)/.test(href)) return;
      if (href && /^https?:\/\//.test(href)) {
        try { if (new URL(href).hostname !== window.location.hostname) return; } catch { return; }
      }
      seen.add(text.toLowerCase());
      collected.push({ text, href: href || null });
    }

    // Nav containers
    const containers = [
      "nav", "aside", "[role='navigation']",
      "[class*='sidebar']", "[class*='Sidebar']", "[class*='side-bar']",
      "[class*='drawer']", "[class*='Drawer']", "[class*='SideNav']",
      "[class*='app-nav']", "[class*='main-nav']", "[class*='left-panel']",
    ];
    for (const csel of containers) {
      const container = document.querySelector(csel);
      if (!container) continue;
      container.querySelectorAll("a[href], button, [role='menuitem'], [role='option'], [role='tab']").forEach(addItem);
      // MUI-specific
      container.querySelectorAll("[class*='MuiListItemButton'], [class*='MuiMenuItem']").forEach(el => {
        if (el.querySelectorAll("[class*='MuiListItemButton']").length > 1) return;
        addItem(el);
      });
    }

    // Global MUI nav elements
    document.querySelectorAll("[class*='MuiListItemButton-root']").forEach(el => {
      if (el.querySelectorAll("[class*='MuiListItemButton']").length > 1) return;
      addItem(el);
    });

    // ARIA roles
    document.querySelectorAll("[role='menuitem'], [role='tab'], [data-route], [data-page]").forEach(addItem);

    return collected.slice(0, 60);
  }).catch(() => []);

  // ── Merge: hrefItems first (catches hidden drawer), then position-based, then class-based ──
  const seen = new Set();
  const merged = [];
  for (const item of [...hrefItems, ...positionItems]) {
    if (!seen.has(item.text.toLowerCase())) {
      seen.add(item.text.toLowerCase());
      merged.push(item);
    }
  }
  for (const item of classItems) {
    if (!seen.has(item.text.toLowerCase())) {
      merged.push(item);
      seen.add(item.text.toLowerCase());
    }
  }

  // ── Scroll sidebar halfway + re-scan for items below fold ──
  await page.evaluate(() => {
    const sidebar = document.querySelector(
      "aside, nav, [class*='sidebar'], [class*='Sidebar'], [class*='drawer'], [class*='Drawer'], [role='navigation']"
    );
    if (sidebar && sidebar.scrollHeight > sidebar.clientHeight) {
      sidebar.scrollTop = sidebar.scrollHeight / 2;
    }
  }).catch(() => {});
  await page.waitForTimeout(400).catch(() => {});

  const extraItems = await page.evaluate(() => {
    const seen2 = new Set();
    const extra = [];
    const SIDEBAR_MAX_X = Math.min(340, window.innerWidth * 0.22);
    const candidates = [...document.querySelectorAll('a, button, [role="menuitem"], [role="link"]')];
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.left > SIDEBAR_MAX_X) continue;
      if (rect.top < 56) continue;
      if (rect.width === 0 || rect.height === 0) continue;
      const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (!text || text.length < 2 || text.length > 55) continue;
      if (seen2.has(text.toLowerCase())) continue;
      seen2.add(text.toLowerCase());
      extra.push({ text, href: el.getAttribute("href") || null });
    }
    return extra;
  }).catch(() => []);

  for (const item of extraItems) {
    if (!seen.has(item.text.toLowerCase())) {
      merged.push(item);
      seen.add(item.text.toLowerCase());
    }
  }

  // ── Scroll sidebar back to top ──
  await page.evaluate(() => {
    const sidebar = document.querySelector("aside, nav, [class*='sidebar'], [class*='Sidebar'], [class*='drawer'], [class*='Drawer']");
    if (sidebar) sidebar.scrollTop = 0;
  }).catch(() => {});

  // ── Filter noise ──
  const noisePattern = /^(sign.?out|log.?out|close|cancel|back|help|support|ok|yes|no|confirm|notification|profile picture|avatar|logo|home icon)$/i;
  const finalSeen = new Set();
  return merged.filter(item => {
    if (!item.text || noisePattern.test(item.text.trim())) return false;
    if (finalSeen.has(item.text.toLowerCase())) return false;
    finalSeen.add(item.text.toLowerCase());
    return true;
  });
}

// Discover tabs / sub-sections within the currently visible page
async function discoverPageTabs(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const tabs = [];
  const selectors = [
    "[role='tablist'] [role='tab']",
    "[role='tab']",
    // MUI Tabs
    "[class*='MuiTab-root']",
    "[class*='MuiTabs-root'] button",
    "[class*='MuiButtonBase-root'][class*='tab']",
    // Ant Design
    ".ant-tabs-tab",
    ".ant-tabs-nav [role='tab']",
    // Headless UI / Radix
    "[data-state='active'][role='tab']",
    "[data-headlessui-state] button[role='tab']",
    // Generic CSS patterns
    ".tabs a, .tabs button, .tabs li",
    "[class*='tab-bar'] a, [class*='tab-bar'] button",
    "[class*='tabs'] a, [class*='tabs'] button",
    "[class*='Tabs'] button",
    "[class*='TabItem']",
    "[class*='tab-item']",
    "ul.nav-tabs li a",
    // Bootstrap
    ".nav-tabs .nav-link",
    ".nav-pills .nav-link",
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
    return tabs.slice(0, 12);
  }).catch(() => []);
}

// Detect if a modal/dialog/drawer/sheet has opened and extract its actual fields
async function detectOpenModal(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const tag = el.tagName.toLowerCase();
      const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const namedAttr = [
        ["data-testid", el.getAttribute("data-testid")],
        ["data-test", el.getAttribute("data-test")],
        ["data-qa", el.getAttribute("data-qa")],
      ].find(([, value]) => value);
      if (namedAttr) return `${tag}[${namedAttr[0]}="${escapeAttr(namedAttr[1])}"]`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${escapeAttr(name)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.length < 160) return `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const labelTextFor = (el, scope) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      push(el.getAttribute?.("aria-label"));
      push(el.getAttribute?.("placeholder"));
      push(el.getAttribute?.("name"));
      push(el.id);
      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
          push(scope.querySelector(`#${CSS.escape(id)}`)?.textContent);
          push(document.getElementById(id)?.textContent);
        }
      }
      if (el.id) {
        const label = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`) || document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        push(label?.textContent);
      }
      push(el.closest("label")?.textContent);
      push(el.closest(".field, .form-group, .input-group, [role='group']")?.querySelector("label, span, strong, legend, p")?.textContent);
      push(el.parentElement?.querySelector("label, span, strong, legend, p")?.textContent);
      push(el.parentElement?.previousElementSibling?.textContent);
      push(el.closest("div, section, article")?.querySelector("label, span, strong, legend, p")?.textContent);
      return parts.join(" ");
    };
    const fieldFrom = (el, scope) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || tag).toLowerCase();
      let kind = "input";
      if (type === "file") kind = "file";
      else if (tag === "select") kind = "select";
      else if (type === "checkbox") kind = "checkbox";
      else if (type === "radio") kind = "radio";
      else if (tag === "textarea") kind = "textarea";
      else if (el.getAttribute("role") === "combobox" || /react-select/i.test(el.id || "") || el.getAttribute("aria-autocomplete") === "list") kind = "combobox";
      else if (type === "date" || type === "datetime-local" || type === "time") kind = type;
      else if (type === "number" || type === "range") kind = "number";
      else if (el.isContentEditable || el.getAttribute("contenteditable") === "true") kind = "richtext";
      const options = tag === "select"
        ? [...el.options]
            .filter((opt) => !opt.disabled)
            .map((opt) => ({ value: opt.value, text: normalize(opt.textContent || opt.value) }))
            .filter((opt) => opt.text)
            .slice(0, 20)
        : [];
      return {
        tag,
        type,
        kind,
        selector: cssPath(el),
        name: el.getAttribute("name") || null,
        placeholder: el.getAttribute("placeholder") || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        id: el.id || null,
        label: labelTextFor(el, scope) || null,
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
        options,
      };
    };
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
        const nodes = [...document.querySelectorAll(sel)].filter((node) => visible(node));
        for (const el of nodes) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 50) continue;

          const seenInputs = new Set();
          const inputs = [...el.querySelectorAll(
            "input:not([type='hidden']):not([type='submit']), textarea, select, [role='combobox'], [contenteditable='true']"
          )]
            .filter((inp) => visible(inp))
            .map((inp) => fieldFrom(inp, el))
            .filter((inp) => inp.selector && !seenInputs.has(inp.selector) && seenInputs.add(inp.selector));

          const buttonDetails = [...el.querySelectorAll("button, [role='button'], input[type='submit']")]
            .filter((btn) => visible(btn))
            .map((btn) => ({
              text: normalize(btn.innerText || btn.value || btn.getAttribute("aria-label") || btn.getAttribute("title") || ""),
              selector: cssPath(btn),
            }))
            .filter((btn) => btn.text && btn.text.length < 80)
            .slice(0, 10);
          const buttons = buttonDetails.map((btn) => btn.text);
          const title = (
            el.querySelector("h1,h2,h3,h4,[class*='title'],[class*='heading'],[class*='header']")?.innerText || ""
          ).trim().slice(0, 80);
          return { found: true, inputs, buttons, buttonDetails, title };
        }
      } catch { /* ignore */ }
    }
    return { found: false, inputs: [], buttons: [], buttonDetails: [], title: "" };
  }).catch(() => ({ found: false, inputs: [], buttons: [], buttonDetails: [], title: "" }));
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

function getFormFieldLabel(field = {}) {
  return clipText(
    field.label ||
    field.placeholder ||
    field.ariaLabel ||
    field.name ||
    field.id ||
    field.title ||
    field.kind ||
    field.type ||
    "field",
    80
  );
}

function getFormFieldKind(field = {}) {
  const raw = String(field.kind || field.type || field.tag || "").toLowerCase();
  if (raw.includes("file")) return "file";
  if (raw.includes("select")) return "select";
  if (raw.includes("combobox")) return "combobox";
  if (raw.includes("checkbox")) return "checkbox";
  if (raw.includes("radio")) return "radio";
  if (raw.includes("textarea")) return "textarea";
  if (raw.includes("number") || raw.includes("range")) return "number";
  if (raw.includes("date")) return "date";
  if (raw.includes("time")) return "time";
  if (raw.includes("datetime")) return "datetime";
  if (raw.includes("email")) return "email";
  if (raw.includes("password")) return "password";
  if (raw.includes("url")) return "url";
  if (raw.includes("search")) return "search";
  if (raw.includes("richtext")) return "richtext";
  return "text";
}

function isTextLikeFormField(field = {}) {
  return ["text", "textarea", "email", "password", "url", "search", "number", "richtext"].includes(getFormFieldKind(field));
}

function chooseSubmitButton(buttons = []) {
  const list = Array.isArray(buttons) ? buttons : [];
  const normalized = list
    .map((btn) => typeof btn === "string" ? { text: btn, selector: null } : btn)
    .filter((btn) => btn && btn.text);
  const priority = [
    /^(save|create|submit|update|apply|send|run|generate|invite|confirm|continue|next|done|finish|start)\b/i,
    /\b(save|create|submit|update|apply|send|run|generate|invite|confirm|continue|next|done|finish|start)\b/i,
  ];
  for (const pattern of priority) {
    const match = normalized.find((btn) => pattern.test(btn.text));
    if (match) return match;
  }
  return normalized[0] || null;
}

function pickOptionForField(field = {}, preference = "valid") {
  const options = Array.isArray(field.options) ? field.options : [];
  if (options.length === 0) return null;
  const filtered = options.filter((opt) => {
    const text = String(opt?.text || opt?.value || "").trim().toLowerCase();
    return text && !["select", "select...", "choose", "choose..."].includes(text);
  });
  const usable = filtered.length > 0 ? filtered : options;
  if (preference === "alternate" && usable[1]) return usable[1];
  return usable[0] || null;
}

function buildFieldScenarioValue(field = {}, scenario = "valid", context = {}) {
  const kind = getFormFieldKind(field);
  const label = getFormFieldLabel(field).toLowerCase();
  const moduleName = String(context?.moduleName || "module");
  const sessionMemory = context?.sessionMemory || null;
  const today = new Date().toISOString().slice(0, 10);
  const dateTime = `${today}T09:30`;
  const token = `${moduleName.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 14) || "module"}-${String(sessionMemory?.seed || "deep").slice(-8)}`;
  const compactToken = token.replace(/[^a-z0-9]+/gi, "").slice(-10) || "deepqa";
  const prettyToken = compactToken.slice(-6).toUpperCase();

  if (kind === "file") return ensureUploadFixtureFile();
  if (kind === "checkbox" || kind === "radio") return true;
  if (kind === "select" || kind === "combobox") {
    const picked = pickOptionForField(field, scenario === "boundary" ? "alternate" : "valid");
    return picked ? (picked.value || picked.text) : null;
  }
  if (kind === "date") return today;
  if (kind === "time") return "09:30";
  if (kind === "datetime") return dateTime;

  if (scenario === "xss") return BREAK_TEST_VALUES.xssImg;
  if (scenario === "sql") return BREAK_TEST_VALUES.sqlBasic;
  if (scenario === "boundary") {
    if (kind === "number") return BREAK_TEST_VALUES.overflowNum;
    return BREAK_TEST_VALUES.longString;
  }
  if (scenario === "invalid") {
    if (kind === "email") return "not-an-email";
    if (kind === "password") return "1";
    if (kind === "number") return "not-a-number";
    if (kind === "url") return "notaurl";
    return BREAK_TEST_VALUES.whitespaceOnly;
  }

  if (/first.?name/.test(label)) return "Deep";
  if (/last.?name|surname/.test(label)) return `Tester${prettyToken}`;
  if (/workspace|organization|company/.test(label)) return `Deep ${moduleName} ${prettyToken}`;
  if (/full.?name|display.?name|name/.test(label)) return `Deep ${moduleName} ${prettyToken}`;
  if (/user.?name|handle/.test(label)) return `deep_${compactToken}`;
  if (/email/.test(label) || kind === "email") return `deep.${compactToken}@local.test`;
  if (/password/.test(label) || kind === "password") return `Deep!${compactToken}A1`;
  if (/phone|mobile|tel/.test(label)) return "+1234567890";
  if (/title|subject/.test(label)) return `Deep ${moduleName} Title ${prettyToken}`;
  if (/message|comment|description|note|bio|about|details/.test(label) || kind === "textarea" || kind === "richtext") {
    return `Created by the deep browser testing agent for ${moduleName} (${prettyToken}).`;
  }
  if (/address/.test(label)) return "123 Test Street";
  if (/city/.test(label)) return "Test City";
  if (/state|province/.test(label)) return "Test State";
  if (/zip|postal|pincode/.test(label)) return "12345";
  if (/website|url/.test(label) || kind === "url") return "https://example.com";
  if (kind === "number") return "1";
  return `Deep ${moduleName} ${prettyToken}`;
}

function buildEntityRecord(moduleName, filledFields = []) {
  const normalizedModule = String(moduleName || "module");
  const record = {
    module: normalizedModule,
    entityType: /workspace|organization|tenant|team/i.test(normalizedModule)
      ? "workspace"
      : /user|member|people|employee|staff|invite/i.test(normalizedModule)
        ? "user"
        : "record",
    fields: [],
    primaryValue: null,
    email: null,
    username: null,
    password: null,
    title: null,
    name: null,
  };

  for (const field of filledFields) {
    const label = String(field?.label || "").toLowerCase();
    const value = field?.value == null ? null : String(field.value);
    if (!value) continue;
    record.fields.push({ label: field.label, value, kind: field.kind });
    if (!record.primaryValue && value.trim()) record.primaryValue = value;
    if (!record.email && (/email/.test(label) || field.kind === "email")) record.email = value;
    if (!record.username && /user.?name|handle|login/.test(label)) record.username = value;
    if (!record.password && (/password/.test(label) || field.kind === "password")) record.password = value;
    if (!record.title && /title|subject|workspace|organization|company/.test(label)) record.title = value;
    if (!record.name && /name/.test(label)) record.name = value;
  }

  record.primaryValue = record.title || record.name || record.email || record.username || record.primaryValue;
  if ((record.email || record.username) && record.password) {
    record.entityType = "user";
  }
  return record;
}

function rememberCreatedEntity(sessionMemory, entityRecord) {
  if (!sessionMemory || !entityRecord?.primaryValue) return;
  const exists = sessionMemory.createdEntities.some((entity) =>
    entity.primaryValue === entityRecord.primaryValue &&
    entity.module === entityRecord.module
  );
  if (!exists) {
    sessionMemory.createdEntities.push({
      ...entityRecord,
      createdAt: new Date().toISOString(),
    });
  }
  if ((entityRecord.email || entityRecord.username) && entityRecord.password) {
    const loginKey = entityRecord.email || entityRecord.username;
    const duplicate = sessionMemory.pendingCredentialChecks.some((item) => (item.email || item.username) === loginKey);
    if (!duplicate) {
      sessionMemory.pendingCredentialChecks.push({
        label: entityRecord.primaryValue || loginKey,
        email: entityRecord.email,
        username: entityRecord.username,
        password: entityRecord.password,
      });
    }
  }
}

async function verifyCreatedEntityClosure({ step, page, entityRecord, slug }) {
  if (!entityRecord?.primaryValue) return;
  await step({
    action: "ai_fill",
    description: "search bar or search input",
    value: entityRecord.primaryValue,
    optional: true,
  });
  await page.waitForTimeout(500);
  await step({ action: "screenshot", label: `${slug}_created_entity_search` });
  await step({
    action: "ai_assert",
    description: `${entityRecord.primaryValue} or the newly created ${entityRecord.entityType} is visible in the current module`,
    optional: true,
  });
  const openCreated = await step({
    action: "ai_click",
    description: `${entityRecord.primaryValue} row or card or first matching created ${entityRecord.entityType}`,
    optional: true,
  });
  if (openCreated.status === "passed") {
    await page.waitForTimeout(800);
    await step({ action: "screenshot", label: `${slug}_created_entity_opened` });
    await step({
      action: "ai_assert",
      description: `details or profile page for ${entityRecord.primaryValue} is visible`,
      optional: true,
    });
    await forceCloseModal(page);
  }
}

async function runCredentialClosureChecks({
  browser,
  sessionMemory,
  runId,
  resultOffset,
  runController = null,
}) {
  const stepResults = [];
  const pending = Array.isArray(sessionMemory?.pendingCredentialChecks)
    ? sessionMemory.pendingCredentialChecks.slice(0, 3)
    : [];

  for (const credential of pending) {
    if (runController) {
      await runController.assertActive({ phase: "credential_check", identity: credential.email || credential.username });
    }

    const authContext = await createStealthContext(browser);
    const authPage = await authContext.newPage();
    authPage.on("dialog", async (dialog) => { try { await dialog.accept("yes"); } catch { /* ignore */ } });

    const loginId = credential.email || credential.username;
    const loginSteps = [
      { action: "navigate", url: sessionMemory.auth.loginUrl, description: `Open login for created ${credential.label || "account"}` },
      { action: "ai_fill", description: "email or username input field", value: loginId },
      { action: "ai_fill", description: "password input field", value: credential.password },
      { action: "ai_click", description: "login or sign in submit button" },
      { action: "wait", ms: 2500, description: "Wait for credential-login redirect" },
      { action: "screenshot", label: `credential_login_${String(credential.label || loginId).replace(/[^a-z0-9]+/gi, "_").toLowerCase()}` },
      { action: "ai_assert", description: "logged in successfully or dashboard/home page visible", optional: true },
    ];

    try {
      const results = await executeBrowserSteps(loginSteps, 18000, {
        runId,
        stopOnFailure: false,
        _existingPage: authPage,
        _existingContext: authContext,
        _existingBrowser: browser,
        _resultOffset: resultOffset + stepResults.length,
        runController,
      });
      stepResults.push(...results);

      const loginStillVisible = await authPage.evaluate(() => {
        const visible = (el) => {
          if (!(el instanceof Element)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
        };
        return visible(document.querySelector('input[type="password"], input[name*="password" i]'));
      }).catch(() => false);

      sessionMemory.credentialChecks.push({
        label: credential.label,
        email: credential.email || null,
        username: credential.username || null,
        status: loginStillVisible ? "failed" : "passed",
        message: loginStillVisible
          ? "Generated credentials could not complete a fresh login session."
          : "Generated credentials completed a fresh login session.",
      });
    } finally {
      await authContext.close().catch(() => {});
    }
  }

  return stepResults;
}

async function collectVisiblePageForms(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const tag = el.tagName.toLowerCase();
      const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const namedAttr = [
        ["data-testid", el.getAttribute("data-testid")],
        ["data-test", el.getAttribute("data-test")],
        ["data-qa", el.getAttribute("data-qa")],
      ].find(([, value]) => value);
      if (namedAttr) return `${tag}[${namedAttr[0]}="${escapeAttr(namedAttr[1])}"]`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${escapeAttr(name)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.length < 160) return `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const labelTextFor = (el, scope) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      push(el.getAttribute?.("aria-label"));
      push(el.getAttribute?.("placeholder"));
      push(el.getAttribute?.("name"));
      push(el.id);
      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
          push(scope.querySelector(`#${CSS.escape(id)}`)?.textContent);
          push(document.getElementById(id)?.textContent);
        }
      }
      if (el.id) {
        const label = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`) || document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        push(label?.textContent);
      }
      push(el.closest("label")?.textContent);
      push(el.closest(".field, .form-group, .input-group, [role='group']")?.querySelector("label, span, strong, legend, p")?.textContent);
      push(el.parentElement?.querySelector("label, span, strong, legend, p")?.textContent);
      push(el.parentElement?.previousElementSibling?.textContent);
      push(el.closest("div, section, article")?.querySelector("label, span, strong, legend, p")?.textContent);
      return parts.join(" ");
    };
    const fieldFrom = (el, scope) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || tag).toLowerCase();
      let kind = "input";
      if (type === "file") kind = "file";
      else if (tag === "select") kind = "select";
      else if (type === "checkbox") kind = "checkbox";
      else if (type === "radio") kind = "radio";
      else if (tag === "textarea") kind = "textarea";
      else if (el.getAttribute("role") === "combobox" || /react-select/i.test(el.id || "") || el.getAttribute("aria-autocomplete") === "list") kind = "combobox";
      else if (type === "date" || type === "datetime-local" || type === "time") kind = type;
      else if (type === "number" || type === "range") kind = "number";
      else if (el.isContentEditable || el.getAttribute("contenteditable") === "true") kind = "richtext";
      const options = tag === "select"
        ? [...el.options]
            .filter((opt) => !opt.disabled)
            .map((opt) => ({ value: opt.value, text: normalize(opt.textContent || opt.value) }))
            .filter((opt) => opt.text)
            .slice(0, 20)
        : [];
      return {
        tag,
        type,
        kind,
        selector: cssPath(el),
        name: el.getAttribute("name") || null,
        placeholder: el.getAttribute("placeholder") || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        id: el.id || null,
        label: labelTextFor(el, scope) || null,
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
        options,
      };
    };
    const buttonDetailsFor = (scope) =>
      [...scope.querySelectorAll("button, [role='button'], input[type='submit']")]
        .filter((btn) => visible(btn))
        .map((btn) => ({
          text: normalize(btn.innerText || btn.value || btn.getAttribute("aria-label") || btn.getAttribute("title") || ""),
          selector: cssPath(btn),
        }))
        .filter((btn) => btn.text && btn.text.length < 80)
        .slice(0, 10);
    const fieldSelector = "input:not([type='hidden']):not([type='submit']), textarea, select, [role='combobox'], [contenteditable='true']";
    const forms = [];
    const seen = new Set();

    for (const form of [...document.querySelectorAll("form")]) {
      if (!visible(form) || form.closest("[role='dialog'], [aria-modal='true']")) continue;
      const fieldSeen = new Set();
      const fields = [...form.querySelectorAll(fieldSelector)]
        .filter((el) => visible(el))
        .map((el) => fieldFrom(el, form))
        .filter((field) => field.selector && !fieldSeen.has(field.selector) && fieldSeen.add(field.selector));
      const buttonDetails = buttonDetailsFor(form);
      if (fields.length === 0 || buttonDetails.length === 0) continue;
      const signature = fields.map((field) => field.selector).join("|");
      if (seen.has(signature)) continue;
      seen.add(signature);
      forms.push({
        scope: "page",
        synthetic: false,
        title: normalize(form.querySelector("h1,h2,h3,h4,legend,[class*='title'],[class*='heading']")?.textContent || ""),
        fields,
        buttons: buttonDetails.map((btn) => btn.text),
        buttonDetails,
      });
    }

    const submitPattern = /\b(save|update|submit|apply|run|generate|invite|create|send|confirm|continue|next|done|finish|start)\b/i;
    const containerCandidates = [...document.querySelectorAll("section, article, aside, main, [class*='card'], [class*='panel'], [class*='form'], div")]
      .filter((el) => visible(el) && !el.closest("form") && !el.closest("[role='dialog'], [aria-modal='true']"));

    for (const container of containerCandidates.slice(0, 40)) {
      const fieldSeen = new Set();
      const fields = [...container.querySelectorAll(fieldSelector)]
        .filter((el) => visible(el) && !el.closest("form") && !el.closest("[role='dialog'], [aria-modal='true']"))
        .map((el) => fieldFrom(el, container))
        .filter((field) => field.selector && !fieldSeen.has(field.selector) && fieldSeen.add(field.selector));
      const buttonDetails = buttonDetailsFor(container).filter((btn) => submitPattern.test(btn.text));
      if (fields.length < 2 || buttonDetails.length === 0) continue;
      const signature = fields.map((field) => field.selector).join("|");
      if (seen.has(signature)) continue;
      seen.add(signature);
      forms.push({
        scope: "page",
        synthetic: true,
        title: normalize(container.querySelector("h1,h2,h3,h4,[class*='title'],[class*='heading']")?.textContent || ""),
        fields,
        buttons: buttonDetails.map((btn) => btn.text),
        buttonDetails,
      });
      if (forms.length >= 8) break;
    }

    return forms.slice(0, 8);
  }).catch(() => []);
}

async function collectSelectableControls(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${CSS.escape(node.id)}`;
          parts.unshift(part);
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const labelTextFor = (el) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      push(el.getAttribute?.("aria-label"));
      push(el.getAttribute?.("placeholder"));
      push(el.getAttribute?.("name"));
      push(el.id);
      if (el.id) {
        push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
      }
      push(el.closest("label")?.textContent);
      push(el.closest(".field, .form-group, .input-group, [role='group']")?.querySelector("label, span, strong, legend, p")?.textContent);
      push(el.parentElement?.querySelector("label, span, strong, legend, p")?.textContent);
      push(el.parentElement?.previousElementSibling?.textContent);
      push(el.closest("div, section, article")?.querySelector("label, span, strong, legend, p")?.textContent);
      return parts.join(" ");
    };

    const raw = [
      ...document.querySelectorAll("select"),
      ...document.querySelectorAll("input[role='combobox']"),
      ...document.querySelectorAll("[role='combobox']"),
      ...document.querySelectorAll("input[id*='react-select'][id$='-input']"),
      ...document.querySelectorAll("[class*='select__control'], [class*='rs__control'], [class*='react-select__control']"),
    ];
    const controls = [];
    const seen = new Set();

    for (const node of raw) {
      if (!visible(node)) continue;
      let target = node;
      let kind = "combobox";
      if (node.matches("select")) {
        kind = "select";
      } else if (node.matches("[class*='select__control'], [class*='rs__control'], [class*='react-select__control']")) {
        target = node.querySelector("input[role='combobox'], input") || node;
      }
      const selector = cssPath(target);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      const label = labelTextFor(target) || "select";
      const options = kind === "select"
        ? [...target.options]
            .filter((opt) => !opt.disabled)
            .map((opt) => ({ value: opt.value, text: normalize(opt.textContent || opt.value) }))
            .filter((opt) => opt.text)
            .slice(0, 20)
        : [];
      controls.push({ label, selector, kind, options });
    }

    return controls.slice(0, 15);
  }).catch(() => []);
}

async function sampleSelectableOptions(page, control, timeoutMs = 10000) {
  if (Array.isArray(control?.options) && control.options.length > 0) {
    return control.options;
  }
  if (!control?.selector) return [];

  try {
    const loc = page.locator(control.selector).first();
    await loc.scrollIntoViewIfNeeded({ timeout: Math.min(timeoutMs, 4000) }).catch(() => {});
    await loc.click({ timeout: Math.min(timeoutMs, 5000) });
    await page.waitForTimeout(300);
    const options = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof Element)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
      };
      return [
        ...document.querySelectorAll("[role='option']"),
        ...document.querySelectorAll("[id*='-option-']"),
        ...document.querySelectorAll(".rs__option, [class*='select__option']"),
      ]
        .filter((el) => visible(el))
        .map((el) => {
          const text = normalize(el.textContent || "");
          return text ? { value: text, text } : null;
        })
        .filter(Boolean)
        .slice(0, 12);
    }).catch(() => []);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    return options;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return [];
  }
}

async function fillFormField(step, field, scenario = "valid", context = {}) {
  const kind = getFormFieldKind(field);
  const label = getFormFieldLabel(field);
  const value = buildFieldScenarioValue(field, scenario, context);
  if (value === null || value === undefined) {
    return { status: "skipped", reason: "no test value", kind, label, value: null, field };
  }

  let stepResult;
  if (kind === "checkbox" || kind === "radio") {
    stepResult = await step({ action: "ai_click", description: `${label} option`, selector: field.selector, optional: true });
  } else if (kind === "file") {
    stepResult = await step({ action: "upload_file", description: label, selector: field.selector, filePath: value, optional: true });
  } else if (kind === "select" || kind === "combobox") {
    stepResult = await step({ action: "select_option", description: label, selector: field.selector, value, optional: true });
  } else {
    stepResult = await step({ action: "ai_fill", description: `${label} field`, selector: field.selector, value, optional: true });
  }

  return {
    ...(stepResult || { status: "skipped" }),
    kind,
    label,
    value,
    field,
  };
}

async function exerciseFormScenario({
  step,
  page,
  form,
  scenario,
  screenshotLabel,
  successAssertion,
  moduleName = "module",
  slug = "module",
  sessionMemory = null,
}) {
  const submitButton = chooseSubmitButton(form?.buttonDetails || form?.buttons || []);
  if (!submitButton?.text) {
    return { status: "skipped", reason: "no submit button" };
  }

  const fields = Array.isArray(form?.fields) ? form.fields.slice(0, 20) : [];
  if (scenario === "empty") {
    const clickResult = await step({ action: "ai_click", description: submitButton.text, selector: submitButton.selector, optional: true });
    await page.waitForTimeout(700);
    await step({ action: "screenshot", label: screenshotLabel });
    await step({ action: "ai_assert", description: "validation errors or required field messages are visible", optional: true });
    return clickResult;
  }

  let targetedMutation = false;
  const filledFields = [];
  for (const field of fields) {
    const kind = getFormFieldKind(field);
    let fieldScenario = "valid";
    if (!targetedMutation && ["xss", "sql", "boundary", "invalid"].includes(scenario) && isTextLikeFormField(field)) {
      fieldScenario = scenario;
      targetedMutation = true;
    } else if (!(field.required || ["valid", "boundary"].includes(scenario) || ["checkbox", "radio", "select", "combobox", "file"].includes(kind))) {
      continue;
    }

    const filled = await fillFormField(step, field, fieldScenario, { moduleName, sessionMemory });
    if (filled?.value != null) {
      filledFields.push({
        label: filled.label,
        kind: filled.kind,
        value: filled.value,
      });
    }
  }

  if (["xss", "sql", "boundary", "invalid"].includes(scenario) && !targetedMutation) {
    return { status: "skipped", reason: "no suitable target field" };
  }

  const clickResult = await step({ action: "ai_click", description: submitButton.text, selector: submitButton.selector, optional: true });
  await page.waitForTimeout(1100);
  await step({ action: "screenshot", label: screenshotLabel });
  if (scenario === "valid") {
    await step({ action: "ai_assert", description: successAssertion || "success message shown or new item appears in list", optional: true });
    const entityRecord = buildEntityRecord(moduleName, filledFields);
    rememberCreatedEntity(sessionMemory, entityRecord);
    await verifyCreatedEntityClosure({ step, page, entityRecord, slug });
  } else if (scenario === "invalid") {
    await step({ action: "ai_assert", description: "validation error or rejection message is shown and the page does not crash", optional: true });
  } else {
    await step({ action: "ai_assert", description: "no alert dialog appeared and no SQL, server, or unhandled error is visible", optional: true });
  }
  return clickResult;
}

// ─────────────────────────────────────────────────────────
// ADAPTIVE DEEP MODULE TESTER
// Observes the page at each step — fills forms from ACTUAL modal DOM, not pre-snapshot
// ─────────────────────────────────────────────────────────
async function executeDeepModuleTest(page, moduleName, {
  context,
  browser,
  runId,
  resultOffset,
  moduleTimeoutMs,
  expectedModuleUrl = null,
  runController = null,
  sessionMemory = null,
  reconData = null,   // Phase 1 deep-recon output — buttons, tabs, tabContents, forms, tables
}) {
  const allResults = [];
  const slug = moduleName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const actionTimeoutMs = normalizeActionTimeoutMs(moduleTimeoutMs, 18000);
  const expectedPathKey = (() => {
    try {
      const pathname = new URL(expectedModuleUrl || page.url()).pathname;
      return pathname.split("/").filter(Boolean)[0] || "root";
    } catch {
      return null;
    }
  })();

  // Run one step on the shared page and collect result
  async function step(s) {
    if (runController) {
      await runController.assertActive({
        phase: "module_step",
        moduleName,
        stepIndex: resultOffset + allResults.length,
      });
    }

    if (
      expectedModuleUrl &&
      !["navigate", "go_back", "open_tab", "switch_tab"].includes(s.action || "")
    ) {
      try {
        const currentPathKey = new URL(page.url()).pathname.split("/").filter(Boolean)[0] || "root";
        if (expectedPathKey && currentPathKey !== expectedPathKey) {
          await page.goto(expectedModuleUrl, { timeout: Math.min(actionTimeoutMs, 20000), waitUntil: "domcontentloaded" });
          await page.waitForTimeout(900);
          await dismissOverlays(page).catch(() => {});
        }
      } catch {
        // Best-effort context recovery only.
      }
    }

    const r = await executeBrowserSteps([s], Math.min(actionTimeoutMs, 20000), {
      runId,
      stopOnFailure: false,
      _existingPage: page,
      _existingContext: context,
      _existingBrowser: browser,
      _resultOffset: resultOffset + allResults.length,
      runController,
    });
    allResults.push(...r);
    return r[0] || { status: "skipped" };
  }

  // ── 1. Initial state capture ──
  await step({ action: "screenshot", label: `${slug}_initial` });
  const info = await extractPageInfoFull(page);
  const pageTabs = await discoverPageTabs(page);
  const pageForms = await collectVisiblePageForms(page);
  const selectableControls = await collectSelectableControls(page);
  await step({ action: "check_performance", description: `${moduleName} performance`, failOnSlow: false });

  // ── Detect module type for specialized handling ──
  const moduleNameLower = moduleName.toLowerCase();
  const isChatModule = /\bchat\b|message|inbox|conversation|support|helpdesk|ticket|dm\b/.test(moduleNameLower);
  const isReportModule = /report|analytic|statistic|insight|dashboard|metric|chart|graph/.test(moduleNameLower);

  // ── 2. Tab / sub-section exploration — ALL tabs, tested deeply ──
  // Merge runtime-discovered tabs with any extra tabs found during Phase 1 recon
  const reconTabContents = reconData?.tabContents || [];
  const allTabNames = new Set([
    ...pageTabs.map(t => t.text),
    ...reconTabContents.map(t => t.tab),
  ]);
  const tabsToTest = [...allTabNames].filter(Boolean);

  for (const tabName of tabsToTest) {
    const tabSlug = tabName.replace(/\s+/g, "_").toLowerCase();
    const r = await step({ action: "ai_click", description: `"${tabName}" tab`, optional: true });
    if (r.status !== "passed") continue;
    await page.waitForTimeout(800);
    await step({ action: "screenshot", label: `${slug}_tab_${tabSlug}` });

    // Detect forms and buttons now visible inside this tab
    const tabPageForms = await collectVisiblePageForms(page).catch(() => []);

    // Exercise any form visible inside this tab
    if (tabPageForms.length > 0) {
      const tabForm = tabPageForms[0];
      await exerciseFormScenario({
        step, page,
        form: tabForm,
        scenario: "empty",
        screenshotLabel: `${slug}_tab_${tabSlug}_empty_validation`,
        moduleName, slug, sessionMemory,
      });
      await forceCloseModal(page);
      await exerciseFormScenario({
        step, page,
        form: tabForm,
        scenario: "valid",
        screenshotLabel: `${slug}_tab_${tabSlug}_valid_submit`,
        successAssertion: "success message shown or item saved",
        moduleName, slug, sessionMemory,
      });
      await forceCloseModal(page);
    }

    // Click every button inside this tab that opens a modal (from Phase 1 recon)
    const reconTab = reconTabContents.find(t => t.tab === tabName);
    for (const mb of (reconTab?.modalButtons || []).slice(0, 8)) {
      const mbResult = await step({ action: "ai_click", description: `"${mb.text}" button inside "${tabName}" tab`, optional: true });
      if (mbResult.status !== "passed") continue;
      await page.waitForTimeout(1000);
      const innerModal = await detectOpenModal(page).catch(() => ({ found: false, inputs: [], buttons: [] }));
      if (innerModal.found && innerModal.inputs.length > 0) {
        await step({ action: "screenshot", label: `${slug}_tab_${tabSlug}_${mb.text.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}_modal` });
        await exerciseFormScenario({
          step, page,
          form: { fields: innerModal.inputs, buttons: innerModal.buttons, buttonDetails: innerModal.buttonDetails },
          scenario: "empty",
          screenshotLabel: `${slug}_tab_${tabSlug}_${mb.text.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}_empty`,
          moduleName, slug, sessionMemory,
        });
        await forceCloseModal(page);
        await step({ action: "ai_click", description: `"${mb.text}" button inside "${tabName}" tab`, optional: true });
        await page.waitForTimeout(800);
        const innerModal2 = await detectOpenModal(page).catch(() => ({ found: false, inputs: [], buttons: [] }));
        if (innerModal2.found && innerModal2.inputs.length > 0) {
          await exerciseFormScenario({
            step, page,
            form: { fields: innerModal2.inputs, buttons: innerModal2.buttons, buttonDetails: innerModal2.buttonDetails },
            scenario: "valid",
            screenshotLabel: `${slug}_tab_${tabSlug}_${mb.text.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}_valid`,
            successAssertion: "success or item created",
            moduleName, slug, sessionMemory,
          });
        }
        await forceCloseModal(page);
      }
    }

    // Click non-modal buttons visible in this tab (in-page interactions)
    if (!reconTab) {
      const inPageBtns = await page.evaluate(() =>
        [...document.querySelectorAll("button:not([disabled]), [role='button']:not([aria-disabled='true'])")]
          .filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > 100;
          })
          .map(b => (b.innerText || b.getAttribute("aria-label") || "").trim())
          .filter(t => t.length > 1 && t.length < 40)
          .slice(0, 5)
      ).catch(() => []);
      for (const btnText of inPageBtns) {
        await step({ action: "ai_click", description: `"${btnText}" button`, optional: true });
        await page.waitForTimeout(500);
        await forceCloseModal(page);
      }
    }

    await step({ action: "screenshot", label: `${slug}_tab_${tabSlug}_done` });
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
      for (const entry of chatEntries.slice(0, 6)) {
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

    const huddleProbe = await step({
      action: "ai_click",
      description: "start huddle or join huddle button",
      optional: true,
    });
    if (huddleProbe.status === "passed") {
      await page.waitForTimeout(1200);
      await step({ action: "screenshot", label: `${slug}_huddle_probe` });
      await step({
        action: "ai_assert",
        description: "huddle UI opened, permission prompt appeared, or a clear realtime status is visible",
        optional: true,
      });
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
    const searchScenarios = [
      {
        value: "test",
        screenshot: `${slug}_search_results`,
        assertion: "search results or filtered content are visible",
      },
      {
        value: BREAK_TEST_VALUES.sqlBasic,
        screenshot: `${slug}_search_injection_attempt`,
        assertion: "page did not crash and no SQL or server error is visible",
      },
      {
        value: BREAK_TEST_VALUES.xssImg,
        screenshot: `${slug}_search_xss_attempt`,
        assertion: "no alert dialog appeared and the page stayed stable",
      },
      {
        value: BREAK_TEST_VALUES.longString,
        screenshot: `${slug}_search_boundary_attempt`,
        assertion: "search input handled the long query without freezing or breaking the layout",
      },
    ];
    for (const scenario of searchScenarios) {
      const searchResult = await step({
        action: "ai_fill",
        description: "search bar or search input",
        value: scenario.value,
        optional: true,
      });
      if (searchResult.status === "passed") {
        await page.waitForTimeout(900);
        await step({ action: "screenshot", label: scenario.screenshot });
        await step({ action: "ai_assert", description: scenario.assertion, optional: true });
      }
    }
    // Clear search to restore state
    await step({ action: "ai_fill", description: "search bar or search input", value: "", optional: true });
    await page.waitForTimeout(400);
  }

  if (info.hasTable) {
    // ── Re-verify table is still visible on the live page before row testing ──
    const tableStillVisible = await page.evaluate(() => {
      const el = document.querySelector("table, [role='grid'], [role='table'], [class*='data-table'], [class*='DataGrid'], [class*='MuiDataGrid']");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).catch(() => false);

    if (tableStillVisible) {
    // ── Open first 3 rows to verify detail view works ──
    for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
      const rowDesc = rowIndex === 0 ? "first" : rowIndex === 1 ? "second" : "third";
      const rowUrlBefore = page.url();

      // Guard: confirm table rows exist on live page before clicking
      const hasRows = await page.evaluate(() => {
        const rows = document.querySelectorAll(
          "table tbody tr, [role='row']:not([role='columnheader']):not([role='rowgroup']), [class*='MuiDataGrid-row'], [class*='table-row']:not([class*='header'])"
        );
        return rows.length > 0;
      }).catch(() => false);
      if (!hasRows) break;

      const openRow = await step({
        action: "ai_click",
        description: `${rowDesc} row or ${rowDesc} item or ${rowDesc} record in table or list`,
        optional: true,
      });
      if (openRow.status === "passed") {
        await page.waitForTimeout(900);
        await step({ action: "screenshot", label: `${slug}_row_${rowIndex + 1}_opened` });
        await step({ action: "ai_assert", description: "record details or drawer or modal opened", optional: true });
        await forceCloseModal(page);
        if (page.url() !== rowUrlBefore) {
          await step({ action: "go_back", description: "Return to list view", optional: true });
          // Wait for table to re-appear after back navigation (SPA may need time to hydrate)
          await page.waitForTimeout(800);
          const tableBack = await page.waitForSelector(
            "table, [role='grid'], [role='table'], [class*='DataGrid'], [class*='MuiDataGrid']",
            { timeout: 5000, state: "visible" }
          ).then(() => true).catch(() => false);
          if (!tableBack) break; // table didn't come back — stop row testing
        }
      } else {
        break; // no more rows
      }
    }
    } // end tableStillVisible

    // ── Column sort — click each visible column header and verify order changes ──
    const columnHeaders = await page.evaluate(() => {
      const seen = new Set();
      return [
        ...document.querySelectorAll(
          "th, [role='columnheader'], thead td, [class*='table-header'] > *, [class*='TableHead'] th, [class*='DataGrid-columnHeader']"
        ),
      ]
        .filter(h => {
          const r = h.getBoundingClientRect();
          const t = (h.innerText || h.getAttribute("aria-label") || "").trim();
          if (!t || t.length < 2 || seen.has(t.toLowerCase())) return false;
          seen.add(t.toLowerCase());
          return r.width > 0 && r.height > 0;
        })
        .map(h => (h.innerText || h.getAttribute("aria-label") || "").trim())
        .slice(0, 8);
    }).catch(() => []);

    for (const headerText of columnHeaders) {
      const sortResult = await step({
        action: "ai_click",
        description: `"${headerText}" column header to sort`,
        optional: true,
      });
      if (sortResult.status === "passed") {
        await page.waitForTimeout(600);
        await step({ action: "screenshot", label: `${slug}_sort_${headerText.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}` });
        await step({ action: "ai_assert", description: "table data appears reordered or sort indicator visible", optional: true });
        // Click again to test reverse sort
        await step({ action: "ai_click", description: `"${headerText}" column header to reverse sort`, optional: true });
        await page.waitForTimeout(400);
        await step({ action: "screenshot", label: `${slug}_sort_${headerText.replace(/\s+/g, "_").toLowerCase().slice(0, 20)}_desc` });
      }
    }

    // ── Pagination — navigate to next page if available ──
    const hasPagination = await page.evaluate(() => {
      const next = document.querySelector(
        '[aria-label*="next" i], [title*="next page" i], [class*="next-page"], [data-testid*="next"], .MuiPaginationItem-root, [class*="pagination"] button, button[aria-label="Go to next page"]'
      );
      if (!next) return false;
      const r = next.getBoundingClientRect();
      const disabled = next.disabled || next.getAttribute("aria-disabled") === "true" || next.classList.contains("Mui-disabled");
      return r.width > 0 && !disabled;
    }).catch(() => false);

    if (hasPagination) {
      const pageUrlBefore = page.url();
      const nextResult = await step({ action: "ai_click", description: "next page button or page 2 pagination", optional: true });
      if (nextResult.status === "passed") {
        await page.waitForTimeout(800);
        await step({ action: "screenshot", label: `${slug}_page_2` });
        await step({ action: "ai_assert", description: "different data loaded on page 2", optional: true });
        // Go back to page 1
        await step({ action: "ai_click", description: "previous page button or page 1 pagination", optional: true });
        await page.waitForTimeout(600);
        if (page.url() !== pageUrlBefore) {
          await step({ action: "go_back", description: "Return to page 1", optional: true });
        }
      }
    }
  }

  for (const control of selectableControls.slice(0, 12)) {
    const sampledOptions = await sampleSelectableOptions(page, control, actionTimeoutMs);
    const primary = pickOptionForField({ ...control, options: sampledOptions.length > 0 ? sampledOptions : control.options }, "valid");
    const alternate = pickOptionForField({ ...control, options: sampledOptions.length > 0 ? sampledOptions : control.options }, "alternate");
    const candidateValues = [primary, alternate].filter((opt, index, arr) =>
      opt && arr.findIndex((item) => String(item.value || item.text) === String(opt.value || opt.text)) === index
    );

    for (const option of candidateValues.slice(0, 4)) {
      const selectResult = await step({
        action: "select_option",
        description: control.label,
        selector: control.selector,
        value: option.value || option.text,
        optional: true,
      });
      if (selectResult.status === "passed") {
        await page.waitForTimeout(700);
        await step({ action: "screenshot", label: `${slug}_select_${control.label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}` });
        await step({ action: "ai_assert", description: "page content updated after selecting an option", optional: true });
      }
    }
  }

  const uploadTargets = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="file"]')]
      .filter((inp) => {
        const rect = inp.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0 || inp.closest("label, form, [role='dialog']");
      })
      .slice(0, 2)
      .map((inp) => inp.getAttribute("aria-label") || inp.name || inp.id || "file upload input")
  ).catch(() => []);

  if (uploadTargets.length > 0) {
    const uploadFixturePath = ensureUploadFixtureFile();
    for (const target of uploadTargets) {
      const uploadResult = await step({
        action: "upload_file",
        description: target,
        filePath: uploadFixturePath,
        optional: true,
      });
      if (uploadResult.status === "passed") {
        await page.waitForTimeout(700);
        await step({ action: "screenshot", label: `${slug}_upload_${target.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}` });
        await step({ action: "ai_assert", description: "uploaded file name or attachment preview is visible", optional: true });
      }
    }
  }

  // ── 5. CREATE flow — adaptive: detects actual modal fields after opening ──
  if (info.hasCreateBtn) {
    const createResult = await step({ action: "ai_click", description: "create or add or new or invite button", optional: true });
    if (createResult.status === "passed") {
      await page.waitForTimeout(1400);
      const modal = await detectOpenModal(page);
      await step({ action: "screenshot", label: `${slug}_create_opened` });

      if (modal.found && modal.inputs.length > 0) {
        await exerciseFormScenario({
          step,
          page,
          form: { fields: modal.inputs, buttons: modal.buttons, buttonDetails: modal.buttonDetails },
          scenario: "empty",
          screenshotLabel: `${slug}_create_empty_validation`,
          moduleName,
          slug,
          sessionMemory,
        });
        await forceCloseModal(page); // verified close

        await step({ action: "ai_click", description: "create or add or new or invite button", optional: true });
        await page.waitForTimeout(800);
        const xssModal = await detectOpenModal(page);
        if (xssModal.found && xssModal.inputs.length > 0) {
          await exerciseFormScenario({
            step,
            page,
            form: { fields: xssModal.inputs, buttons: xssModal.buttons, buttonDetails: xssModal.buttonDetails },
            scenario: "xss",
            screenshotLabel: `${slug}_create_xss_probe`,
            moduleName,
            slug,
            sessionMemory,
          });
          await forceCloseModal(page); // verified close
        }

        await step({ action: "ai_click", description: "create or add or new or invite button", optional: true });
        await page.waitForTimeout(800);
        const sqlModal = await detectOpenModal(page);
        if (sqlModal.found && sqlModal.inputs.length > 0) {
          await exerciseFormScenario({
            step,
            page,
            form: { fields: sqlModal.inputs, buttons: sqlModal.buttons, buttonDetails: sqlModal.buttonDetails },
            scenario: "sql",
            screenshotLabel: `${slug}_create_sql_probe`,
            moduleName,
            slug,
            sessionMemory,
          });
          await forceCloseModal(page); // verified close
        }

        await step({ action: "ai_click", description: "create or add or new or invite button", optional: true });
        await page.waitForTimeout(800);
        const validModal = await detectOpenModal(page);
        if (validModal.found && validModal.inputs.length > 0) {
          await exerciseFormScenario({
            step,
            page,
            form: { fields: validModal.inputs, buttons: validModal.buttons, buttonDetails: validModal.buttonDetails },
            scenario: "valid",
            screenshotLabel: `${slug}_after_create`,
            successAssertion: "success message shown or new item appears in list",
            moduleName,
            slug,
            sessionMemory,
          });
        }
      } else {
        const inlineCreateForm = pageForms[0];
        if (inlineCreateForm) {
          await exerciseFormScenario({
            step,
            page,
            form: inlineCreateForm,
            scenario: "valid",
            screenshotLabel: `${slug}_after_create`,
            successAssertion: "success message shown or settings saved successfully",
            moduleName,
            slug,
            sessionMemory,
          });
        } else {
          await step({ action: "ai_fill", description: "name or title input field", value: "Deep Test Item", optional: true });
          await step({ action: "ai_click", description: "save or submit button", optional: true });
          await page.waitForTimeout(1500);
          await step({ action: "screenshot", label: `${slug}_after_create` });
        }
      }
    }
  }

  // ── 6. TEST ALL MODAL-OPENING BUTTONS from reconData (not just hasCreateBtn) ──
  // Phase 1 recon discovered every button that opens a form — test each one fully.
  const reconModalButtons = (reconData?.clickableButtons || []).filter(b => b.opensModal && b.modalFields?.length > 0);
  // Skip buttons already tested by the create flow (avoid exact same "create/add/new/invite" re-run)
  const createKeywords = /^(create|add|new|invite|register)/i;
  const extraModalButtons = reconModalButtons.filter(b => !createKeywords.test((b.text || "").trim()));

  for (const mb of extraModalButtons.slice(0, 12)) {
    const mbSlug = mb.text.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24);
    const openResult = await step({ action: "ai_click", description: `"${mb.text}" button`, optional: true });
    if (openResult.status !== "passed") continue;
    await page.waitForTimeout(1000);
    const openedModal = await detectOpenModal(page);
    if (!openedModal.found) { await forceCloseModal(page); continue; }
    await step({ action: "screenshot", label: `${slug}_btn_${mbSlug}_opened` });

    // Empty validation
    await exerciseFormScenario({
      step, page,
      form: { fields: openedModal.inputs, buttons: openedModal.buttons, buttonDetails: openedModal.buttonDetails },
      scenario: "empty",
      screenshotLabel: `${slug}_btn_${mbSlug}_empty`,
      moduleName, slug, sessionMemory,
    });
    await forceCloseModal(page);

    // XSS probe
    await step({ action: "ai_click", description: `"${mb.text}" button`, optional: true });
    await page.waitForTimeout(800);
    const xssM = await detectOpenModal(page);
    if (xssM.found && xssM.inputs.length > 0) {
      await exerciseFormScenario({
        step, page,
        form: { fields: xssM.inputs, buttons: xssM.buttons, buttonDetails: xssM.buttonDetails },
        scenario: "xss",
        screenshotLabel: `${slug}_btn_${mbSlug}_xss`,
        moduleName, slug, sessionMemory,
      });
    }
    await forceCloseModal(page);

    // Valid submit
    await step({ action: "ai_click", description: `"${mb.text}" button`, optional: true });
    await page.waitForTimeout(800);
    const validM = await detectOpenModal(page);
    if (validM.found && validM.inputs.length > 0) {
      await exerciseFormScenario({
        step, page,
        form: { fields: validM.inputs, buttons: validM.buttons, buttonDetails: validM.buttonDetails },
        scenario: "valid",
        screenshotLabel: `${slug}_btn_${mbSlug}_valid`,
        successAssertion: "success message shown or record appeared in list",
        moduleName, slug, sessionMemory,
      });
    }
    await forceCloseModal(page);
  }

  // ── 7. EDIT flow — boundary probe then valid save ──
  if (info.hasTable) {
    const editResult = await step({ action: "ai_click", description: "edit or pencil icon or modify button on first row or record", optional: true });
    if (editResult.status === "passed") {
      await page.waitForTimeout(1000);
      const editModal = await detectOpenModal(page);
      await step({ action: "screenshot", label: `${slug}_edit_opened` });
      if (editModal.found && editModal.inputs.length > 0) {
        await exerciseFormScenario({
          step, page,
          form: { fields: editModal.inputs, buttons: editModal.buttons, buttonDetails: editModal.buttonDetails },
          scenario: "boundary",
          screenshotLabel: `${slug}_edit_boundary_probe`,
          moduleName, slug, sessionMemory,
        });
        await forceCloseModal(page);

        await step({ action: "ai_click", description: "edit or pencil icon or modify button on first row or record", optional: true });
        await page.waitForTimeout(800);
        const confirmEditModal = await detectOpenModal(page);
        if (confirmEditModal.found && confirmEditModal.inputs.length > 0) {
          await exerciseFormScenario({
            step, page,
            form: { fields: confirmEditModal.inputs, buttons: confirmEditModal.buttons, buttonDetails: confirmEditModal.buttonDetails },
            scenario: "valid",
            screenshotLabel: `${slug}_after_edit`,
            successAssertion: "changes saved successfully",
            moduleName, slug, sessionMemory,
          });
        }
        await forceCloseModal(page);
      }
    }
  }

  // ── 8. DELETE flow — only on entity we just created (safe; avoids deleting existing data) ──
  const createdHere = (sessionMemory?.createdEntities || []).find(e => e.module === moduleName);
  if (createdHere?.primaryValue) {
    // Try to find and click the delete button on the row of the just-created entity
    const deleteResult = await step({
      action: "ai_click",
      description: `delete or trash or remove icon on row or card containing "${createdHere.primaryValue}"`,
      optional: true,
    });
    if (deleteResult.status === "passed") {
      await page.waitForTimeout(700);
      // Confirm dialog if shown
      const confirmDel = await detectOpenModal(page);
      if (confirmDel.found) {
        await step({ action: "ai_click", description: "confirm or yes or delete button in confirmation dialog", optional: true });
        await page.waitForTimeout(600);
      }
      await step({ action: "screenshot", label: `${slug}_after_delete` });
      await step({ action: "ai_assert", description: `"${createdHere.primaryValue}" is no longer visible in the list or a deletion success message appeared`, optional: true });
    }
  } else if (info.hasTable) {
    // No entity we own — just verify delete button exists (don't click it)
    await step({ action: "ai_assert", description: "delete or remove or trash button is visible on at least one row", optional: true });
  }

  // ── 9. VALIDATION test — submit page-level forms with boundary/invalid/valid scenarios ──
  if (pageForms.length > 0) {
    const primaryPageForm = pageForms[0];
    await exerciseFormScenario({
      step, page,
      form: primaryPageForm,
      scenario: "invalid",
      screenshotLabel: `${slug}_page_form_invalid`,
      moduleName, slug, sessionMemory,
    });
    await exerciseFormScenario({
      step, page,
      form: primaryPageForm,
      scenario: "boundary",
      screenshotLabel: `${slug}_page_form_boundary`,
      moduleName, slug, sessionMemory,
    });
    await exerciseFormScenario({
      step, page,
      form: primaryPageForm,
      scenario: "valid",
      screenshotLabel: `${slug}_page_form_valid`,
      successAssertion: "settings saved successfully or success feedback is visible",
      moduleName, slug, sessionMemory,
    });
  }

  // ── 10. Final screenshot ──
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
    // Scroll page to reveal lazy-loaded content + expand any accordions
    await page.evaluate(() => {
      // Scroll main content area down and back up
      const main = document.querySelector("main, [role='main'], .main-content, [class*='content-area'], [class*='main-container']");
      if (main) {
        main.scrollTop = main.scrollHeight;
        setTimeout(() => { main.scrollTop = 0; }, 200);
      } else {
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => { window.scrollTo(0, 0); }, 200);
      }
      // Try to expand collapsed sections
      document.querySelectorAll("[aria-expanded='false']").forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) { try { el.click(); } catch {} }
      });
    }).catch(() => {});
    await page.waitForTimeout(500);

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
    for (const tab of tabs.slice(0, 15)) {
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
        const SKIP = /^(sign.?out|log.?out|delete.?all|clear.?all|reset.?all|cancel.?all|close$|save$|submit$|confirm$|approve$|publish$|pay$|purchase$|checkout$|place order$|send$)/i;
        for (const btnText of tabBtns.slice(0, 12)) {
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
                modalActions: modal.buttons.slice(0, 8),
              });
              await forceCloseModal(page); // verified multi-strategy close
            } else {
              // Re-click tab to restore state if button navigated or changed content
              await forceCloseModal(page);
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
    const SKIP_PATTERN = /^(sign.?out|log.?out|delete.?all|clear.?all|remove.?all|reset.?all|cancel.?all|close$|save$|submit$|confirm$|approve$|publish$|pay$|purchase$|checkout$|place order$|send$)/i;
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
            modalActions: modal.buttons.slice(0, 10),
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
          // Close modal — verified multi-strategy close
          await forceCloseModal(page);
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
      const ddStr = b.modalDropdowns?.map(d => `dropdown "${d.label}":[${d.options.slice(0, 12).join("|")}]`).join("; ") || "";
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
    `SELECT "${d.label}": options [${d.options.slice(0, 20).join(" | ")}]`
  ).join("\n");

  const tableDetail = tables.map(t =>
    `TABLE: columns [${t.headers.join(", ")}] — ${t.rowCount} rows visible`
  ).join("\n");

  const pageFormDetail = forms.flatMap(f => f.fields || [])
    .map(f => `"${f.label}"(${f.type}${f.required ? ",required" : ""})`).join(", ");

  // ── Module abbreviation for test case IDs ──
  const moduleAbbr = moduleName.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 6) || "MOD";

  const prompt = `You are a senior QA engineer. Your job is to generate STRUCTURED test cases with priorities and exact expected results.
You have already explored "${moduleName}" and know exactly what UI elements exist.
NEVER invent elements. Only reference the DISCOVERED elements below.

MODULE: "${moduleName}"
URL: "${url}"

=== DISCOVERED BUTTONS & MODALS ===
${buttonDetails || "(none found)"}

${tabDetail ? "=== TABS ===\n" + tabDetail : ""}
${dropdownDetail ? "=== DROPDOWNS ===\n" + dropdownDetail : ""}
${tableDetail ? "=== TABLE ===\n" + tableDetail : ""}
${pageFormDetail ? "=== PAGE FORM FIELDS ===\n" + pageFormDetail : ""}
Page visible text: "${visibleText.slice(0, 300)}"

Generate 15-25 structured test cases covering: happy path, validation, security, edge cases, UX.

PRIORITY RULES:
- P0: Core feature works at all (login, create, save, load data)
- P1: Important features (edit, delete, validation errors, permissions)
- P2: Security tests (XSS, SQL injection, input sanitization)
- P3: UX/edge cases (empty states, long inputs, special chars)

SECURITY TESTS (always include for every module with forms):
- XSS: fill text field with <script>alert("xss")</script> → expected: no alert fires, page stays stable
- SQL injection: fill with ' OR '1'='1 → expected: no DB error, graceful handling
- Long input: fill with 500-char string → expected: no crash, truncated or error shown

Return ONLY a valid JSON array with this EXACT structure per test case:
[
  {
    "id": "TC-${moduleAbbr}-001",
    "title": "short human-readable title",
    "priority": "P0",
    "category": "happy_path",
    "steps": [
      { "action": "navigate", "url": "${url}", "description": "Open ${moduleName}" },
      { "action": "ai_click", "description": "exact button name from discovered data", "optional": true },
      { "action": "ai_fill", "description": "exact field name", "value": "test value" },
      { "action": "screenshot", "label": "descriptive_label" }
    ],
    "expected": "Precise description of what should happen — specific enough to verify (e.g. 'Success toast appears with text \"Item created\"' or 'Validation error appears under Name field')",
    "assertions": [
      { "action": "ai_assert", "description": "specific condition to verify — matches the expected result", "optional": false }
    ]
  }
]

RULES:
- "expected" must be SPECIFIC — not "success message shown" but "toast message 'Task created successfully' appears and item appears in list"
- Every form must have: empty-submit test (P1), valid-submit test (P0), XSS test (P2), SQL test (P2)
- Every table must have: sort-by-column test, open-row test
- Mark speculative steps optional:true
- Return ONLY JSON array, no markdown`;

  // ── Mandatory tab steps (always appended to guarantee tab coverage in Phase 3 fallback) ──
  const mandatoryTabSteps = tabs.flatMap(tabName => [
    { action: "ai_click", description: `"${tabName}" tab`, optional: true },
    { action: "wait", ms: 800 },
    { action: "screenshot", label: `${slug}_tab_${tabName.toLowerCase().replace(/\s+/g, "_")}` },
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
          { action: "ai_click", description: `"${mb.text}" button`, optional: true },
          { action: "wait", ms: 700 },
          { action: "ai_click", description: saveBtn, optional: true },
          { action: "ai_assert", description: "validation errors shown for empty required fields", optional: true },
        ] : [
          { action: "ai_click", description: saveBtn, optional: true },
        ]),
      ];
    })),
  ]);

  try {
    const raw = await generateText({ prompt, maxTokens: 4000 });
    const testCases = parseJsonSafe(raw, null);
    if (Array.isArray(testCases) && testCases.length >= 3 && testCases[0]?.steps) {
      // Structured test cases — add mandatory tab coverage as extra raw steps appended
      const extraSteps = mandatoryTabSteps;
      console.log(`[generateTestCases] "${moduleName}": ${testCases.length} structured test cases generated`);
      // Return structured format — Phase 3 adaptive code uses the steps array; report uses id/title/priority/expected
      return testCases.map(tc => ({
        ...tc,
        // Ensure steps is a flat array of Playwright actions
        steps: Array.isArray(tc.steps) ? tc.steps : [],
        assertions: Array.isArray(tc.assertions) ? tc.assertions : [],
      }));
    }
    // Fallback: LLM returned flat steps array instead of structured — wrap them
    if (Array.isArray(testCases) && testCases.length >= 5 && testCases[0]?.action) {
      console.log(`[generateTestCases] "${moduleName}": LLM returned flat steps (${testCases.length}), wrapping`);
      const mergedSteps = [...testCases, ...mandatoryTabSteps];
      return [{ id: `TC-${moduleAbbr}-FLAT`, title: `${moduleName} — full test`, priority: "P1", category: "adaptive", steps: mergedSteps, expected: "All features function without errors", assertions: [] }];
    }
  } catch { /* use fallback */ }

  // ── Smart fallback — return minimal structured test cases ──
  const fallbackTestCases = [];
  let tcNum = 1;

  // Happy path per modal button
  for (const btn of modalButtons.slice(0, 10)) {
    const firstField = btn.modalFields?.[0];
    const saveBtn = btn.modalActions?.find(a => /^(save|create|submit|confirm|add|ok|done)/i.test(a)) || "save or submit button";
    const btnSlug = btn.text.slice(0, 15).replace(/\s/g, "_");
    fallbackTestCases.push({
      id: `TC-${moduleAbbr}-${String(tcNum++).padStart(3, "0")}`,
      title: `"${btn.text}" — valid submit`,
      priority: "P0", category: "happy_path",
      steps: [
        { action: "navigate", url, description: `Open ${moduleName}` },
        { action: "ai_click", description: `"${btn.text}" button`, optional: true },
        { action: "wait", ms: 800 },
        ...(firstField ? [{ action: "ai_fill", description: `"${firstField.label}" field`, value: "Test Value", optional: true }] : []),
        { action: "ai_click", description: saveBtn, optional: true },
        { action: "screenshot", label: `${slug}_${btnSlug}_happy` },
      ],
      expected: "Form submits successfully, success message or new item appears in list",
      assertions: [{ action: "ai_assert", description: "success message or new item appeared after form submit", optional: true }],
    });
    fallbackTestCases.push({
      id: `TC-${moduleAbbr}-${String(tcNum++).padStart(3, "0")}`,
      title: `"${btn.text}" — empty submit validation`,
      priority: "P1", category: "validation",
      steps: [
        { action: "navigate", url, description: `Open ${moduleName}` },
        { action: "ai_click", description: `"${btn.text}" button`, optional: true },
        { action: "wait", ms: 800 },
        { action: "ai_click", description: saveBtn, optional: true },
        { action: "screenshot", label: `${slug}_${btnSlug}_empty` },
      ],
      expected: "Validation errors appear on required fields — form is NOT submitted",
      assertions: [{ action: "ai_assert", description: "validation error messages visible on required fields", optional: true }],
    });
    if (firstField) {
      fallbackTestCases.push({
        id: `TC-${moduleAbbr}-${String(tcNum++).padStart(3, "0")}`,
        title: `"${btn.text}" — XSS injection`,
        priority: "P2", category: "security",
        steps: [
          { action: "navigate", url, description: `Open ${moduleName}` },
          { action: "ai_click", description: `"${btn.text}" button`, optional: true },
          { action: "wait", ms: 800 },
          { action: "ai_fill", description: `"${firstField.label}" field`, value: BREAK_TEST_VALUES.xss, optional: true },
          { action: "ai_click", description: saveBtn, optional: true },
          { action: "screenshot", label: `${slug}_${btnSlug}_xss` },
        ],
        expected: "XSS payload is sanitized — no alert dialog fires, no raw script renders",
        assertions: [{ action: "ai_assert", description: "no JavaScript alert appeared and the page is still intact", optional: true }],
      });
    }
  }

  // Tab coverage
  for (const tabName of tabs.slice(0, 12)) {
    fallbackTestCases.push({
      id: `TC-${moduleAbbr}-${String(tcNum++).padStart(3, "0")}`,
      title: `Tab "${tabName}" — content loads`,
      priority: "P1", category: "happy_path",
      steps: [
        { action: "navigate", url, description: `Open ${moduleName}` },
        { action: "ai_click", description: `"${tabName}" tab`, optional: true },
        { action: "wait", ms: 800 },
        { action: "screenshot", label: `${slug}_tab_${tabName.toLowerCase().replace(/\s+/g, "_")}` },
      ],
      expected: `"${tabName}" tab content loads without blank screen or error`,
      assertions: [{ action: "ai_assert", description: `"${tabName}" tab is active and its content is visible`, optional: true }],
    });
  }

  // Search
  if (hasSearch) {
    fallbackTestCases.push({
      id: `TC-${moduleAbbr}-${String(tcNum++).padStart(3, "0")}`,
      title: "Search — SQL injection",
      priority: "P2", category: "security",
      steps: [
        { action: "navigate", url, description: `Open ${moduleName}` },
        { action: "ai_fill", description: "search input or search bar", value: BREAK_TEST_VALUES.sqlBasic, optional: true },
        { action: "wait", ms: 500 },
        { action: "screenshot", label: `${slug}_search_sql` },
      ],
      expected: "No database error, no server crash — graceful handling or empty results",
      assertions: [{ action: "ai_assert", description: "no SQL error or server-side error is displayed", optional: true }],
    });
  }

  return fallbackTestCases;
}

// ─────────────────────────────────────────────────────────
// ANALYZE ALL MODULE RESULTS — per test case, compare expected vs actual
// Returns { moduleTestResults, allBugs }
// ─────────────────────────────────────────────────────────
async function analyzeAllModuleResults(moduleResults, moduleTestPlans, allStepResults) {
  const moduleTestResults = [];
  const allBugs = [];
  let bugCounter = 1;

  for (const moduleResult of moduleResults) {
    const testPlan = moduleTestPlans.find(p => p.name === moduleResult.name);
    const testCases = testPlan?.testCases || [];
    const moduleStepResults = moduleResult.stepResults || [];

    const analyzedCases = [];

    // If we have structured test cases with expected results — analyze each
    if (testCases.length > 0 && testCases[0]?.expected) {
      // Map step results back to test cases by index ranges
      // Each test case owns a slice of step results proportionally
      const stepsPerCase = Math.ceil(moduleStepResults.length / testCases.length) || 1;

      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const tcSteps = moduleStepResults.slice(i * stepsPerCase, (i + 1) * stepsPerCase);
        const pageText = tcSteps.map(s => s.description).join(" | ");

        const analysis = await analyzeTestCaseResult({
          testCase: tc,
          stepResults: tcSteps.length > 0 ? tcSteps : moduleStepResults,
          pageText,
        });

        const tcResult = { ...tc, ...analysis };
        analyzedCases.push(tcResult);

        if (analysis.isBug && analysis.bug) {
          const moduleAbbr = moduleResult.name.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 6);
          allBugs.push({
            id: `BUG-${moduleAbbr}-${String(bugCounter++).padStart(3, "0")}`,
            testCaseId: tc.id,
            severity: analysis.bug.severity || "Medium",
            title: analysis.bug.title || tc.title,
            module: moduleResult.name,
            defectType: analysis.bug.defectType || "Functional Bug",
            description: `${analysis.actualBehavior} Expected: ${tc.expected}`,
            impact: analysis.bug.impact || "",
            fix: analysis.bug.fix || "",
            priority: tc.priority || "P1",
          });
        }
      }
    }

    // If no structured cases — analyze the module's step results as a whole
    if (analyzedCases.length === 0) {
      const modulePassRate = moduleStepResults.filter(s => s.status === "passed").length / Math.max(1, moduleStepResults.length);
      analyzedCases.push({
        id: `TC-${moduleResult.name.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 6)}-001`,
        title: `${moduleResult.name} — adaptive test run`,
        priority: "P1",
        status: moduleResult.status === "passed" ? "PASS" : "FAIL",
        actualBehavior: `${moduleResult.summary.passed} of ${moduleResult.summary.total} steps passed.`,
        expected: "All module features function correctly",
        isBug: false, bug: null,
      });
    }

    moduleTestResults.push({
      name: moduleResult.name,
      url: moduleResult.url,
      status: moduleResult.status,
      summary: moduleResult.summary,
      testCaseResults: analyzedCases,
    });
  }

  return { moduleTestResults, allBugs };
}

// ─────────────────────────────────────────────────────────
// GENERATE MARKDOWN QA REPORT — exact professional format
// ─────────────────────────────────────────────────────────
function generateMarkdownQAReport({ url, email, moduleTestResults, allBugs, testDate, appName }) {
  const today = testDate || new Date().toISOString().split("T")[0];
  const app = appName || (url ? new URL(url).hostname : "Application");

  // ── Collect all test cases ──
  const allCases = moduleTestResults.flatMap(m => m.testCaseResults || []);
  const totalCases = allCases.length;
  const passedCases = allCases.filter(tc => tc.status === "PASS").length;
  const failedCases = allCases.filter(tc => tc.status !== "PASS").length;

  // Priority breakdown
  const byPriority = { P0: { total: 0, passed: 0, failed: 0 }, P1: { total: 0, passed: 0, failed: 0 }, P2: { total: 0, passed: 0, failed: 0 }, P3: { total: 0, passed: 0, failed: 0 } };
  for (const tc of allCases) {
    const p = tc.priority || "P1";
    if (!byPriority[p]) byPriority[p] = { total: 0, passed: 0, failed: 0 };
    byPriority[p].total++;
    if (tc.status === "PASS") byPriority[p].passed++;
    else byPriority[p].failed++;
  }

  const overallStatus = allBugs.some(b => b.severity === "Critical") ? "❌ FAIL — Critical bugs found"
    : allBugs.length > 0 ? `❌ FAIL — ${allBugs.length} defect${allBugs.length === 1 ? "" : "s"} found`
    : "✅ PASS";

  const bugSummaryLine = allBugs.length > 0
    ? `${allBugs.filter(b => b.severity === "Critical").length} Critical, ${allBugs.filter(b => b.severity === "High").length} High, ${allBugs.filter(b => b.severity === "Medium").length} Medium, ${allBugs.filter(b => b.severity === "Low").length} Low`
    : "No defects found";

  const severityEmoji = { Critical: "🔴", High: "🟠", Medium: "🟡", Low: "🟢" };

  let md = `# ${app} — QA Test Report\n`;
  md += `**Application:** ${app} (${url || ""})\n`;
  md += `**Tester:** Automated QA Agent (via Playwright)\n`;
  md += `**Test Date:** ${today}\n`;
  if (email) md += `**Credentials Used:** ${email}\n`;
  md += `\n---\n\n`;

  // Executive Summary
  md += `## Executive Summary\n\n`;
  md += `| Priority | Total | Passed | Failed / Bug |\n`;
  md += `|----------|-------|--------|--------------|\n`;
  for (const [p, stats] of Object.entries(byPriority)) {
    if (stats.total > 0) md += `| ${p} | ${stats.total} | ${stats.passed} | ${stats.failed} |\n`;
  }
  md += `| **Total** | **${totalCases}** | **${passedCases}** | **${failedCases}** |\n`;
  md += `\n**Overall Status: ${overallStatus}**\n`;
  if (allBugs.length > 0) md += `**Defects:** ${bugSummaryLine}\n`;
  md += `\n---\n\n`;

  // Test Results by Module
  md += `## Test Results by Module\n\n`;
  for (const moduleResult of moduleTestResults) {
    const mPassed = (moduleResult.testCaseResults || []).filter(tc => tc.status === "PASS").length;
    const mTotal = (moduleResult.testCaseResults || []).length;
    const mStatus = mPassed === mTotal ? "✅" : "❌";
    md += `### ${mStatus} ${moduleResult.name}\n\n`;

    for (const tc of (moduleResult.testCaseResults || [])) {
      const statusIcon = tc.status === "PASS" ? "✅ PASS" : tc.status === "BUG" ? "❌ BUG" : "❌ FAIL";
      md += `#### ${tc.id || "TC-???"} · ${tc.title || "Untitled"}\n`;
      md += `- **Status:** ${statusIcon}\n`;
      if (tc.priority) md += `- **Priority:** ${tc.priority}\n`;
      if (tc.expected) md += `- **Expected:** ${tc.expected}\n`;
      if (tc.actualBehavior) md += `- **Actual:** ${tc.actualBehavior}\n`;
      if (tc.isBug && tc.bug) {
        md += `- **Bug Severity:** ${severityEmoji[tc.bug.severity] || "🟡"} ${tc.bug.severity}\n`;
        md += `- **Defect Type:** ${tc.bug.defectType}\n`;
        md += `- **Impact:** ${tc.bug.impact}\n`;
        md += `- **Fix:** ${tc.bug.fix}\n`;
      }
      md += `\n`;
    }
    md += `---\n\n`;
  }

  // Defect Summary
  if (allBugs.length > 0) {
    md += `## Defect Summary\n\n`;
    md += `| ID | Description | Severity | Priority | Module | Status |\n`;
    md += `|----|-------------|----------|----------|--------|--------|\n`;
    for (const bug of allBugs) {
      md += `| ${bug.id} | ${bug.title} | ${severityEmoji[bug.severity] || "🟡"} ${bug.severity} | ${bug.priority} | ${bug.module} | Open |\n`;
    }
    md += `\n---\n\n`;

    // Detailed bug reports
    md += `## Detailed Defect Reports\n\n`;
    for (const bug of allBugs) {
      md += `### ${bug.id} — ${bug.title}\n`;
      md += `- **Severity:** ${severityEmoji[bug.severity] || "🟡"} ${bug.severity}\n`;
      md += `- **Module:** ${bug.module}\n`;
      md += `- **Defect Type:** ${bug.defectType}\n`;
      md += `- **Description:** ${bug.description}\n`;
      md += `- **Impact:** ${bug.impact}\n`;
      md += `- **Fix Recommendation:** ${bug.fix}\n`;
      md += `\n`;
    }
    md += `---\n\n`;
  }

  // Test Environment
  md += `## Test Environment\n\n`;
  md += `| Item | Value |\n`;
  md += `|------|-------|\n`;
  md += `| URL | ${url || "N/A"} |\n`;
  md += `| Browser | Chromium (Playwright) |\n`;
  md += `| Test Date | ${today} |\n`;
  md += `| Tester | Automated QA Agent |\n`;
  md += `| Test Type | Automated Deep Exploration |\n\n`;

  md += `*Report generated by QA Agent — ${today}*\n`;

  return md;
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

  const runController = createRunController(run.id);
  const actionTimeoutMs = normalizeActionTimeoutMs(timeoutMs, 20000);
  const allStepResults = [];
  const moduleReconData = [];   // Phase 1 output: what we observed
  const moduleTestPlans = [];   // Phase 2 output: LLM-generated test cases
  const moduleResults = [];     // Phase 3 output: execution results
  const sessionMemory = {
    seed: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdEntities: [],
    pendingCredentialChecks: [],
    credentialChecks: [],
    auth: {
      loginUrl: url,
      initialEmail: email || null,
    },
  };

  const browser = await createStealthBrowser();
  let context, page;
  let cancelledError = null;
  let fatalError = null;

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

    const loginResults = await executeBrowserSteps(loginSteps, actionTimeoutMs, {
      runId: run.id,
      stopOnFailure: false,
      liveScreen: true,
      autoScreenshot: true,
      _existingPage: page,
      _existingContext: context,
      _existingBrowser: browser,
      _resultOffset: 0,
      runController,
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

    if (email && password) {
      const postLoginNavItems = await discoverAllNavigationItems(page);
      const loginStillVisible = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!(el instanceof Element)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0);
        };
        const passwordInput = document.querySelector('input[type="password"], input[name*="password" i], input[placeholder*="password" i], input[aria-label*="password" i]');
        const emailLikeInput = document.querySelector('input[type="email"], input[name*="email" i], input[name*="user" i], input[autocomplete="username"], input[placeholder*="email" i], input[placeholder*="user" i], input[aria-label*="email" i], input[aria-label*="user" i]');
        return isVisible(passwordInput) || isVisible(emailLikeInput);
      }).catch(() => false);
      if (loginStillVisible && (/\/login\b/i.test(page.url()) || postLoginNavItems.length < 2)) {
        throw new Error("Login likely failed — still on login screen after credential submit");
      }
    }

    // Step 1b: Discover all navigation items
    await updateCurrentScreen(run.id, await takeScreenshot(page), "Phase 1: Discovering all modules in navigation…");
    await page.waitForTimeout(2500);
    await dismissOverlays(page).catch(() => {});

    // ── Try to open any collapsed sidebar/drawer before nav scan ──
    // MUI Drawer items are in DOM even when closed but getBoundingClientRect() = 0
    // Strategy: (1) scan all <a href> in DOM (hrefItems), (2) click hamburger if sidebar not visible
    const sidebarVisible = await page.evaluate(() => {
      const sidebar = document.querySelector(
        "aside, nav, [class*='sidebar'], [class*='Sidebar'], [class*='drawer'], [class*='Drawer'], [role='navigation']"
      );
      if (!sidebar) return false;
      const r = sidebar.getBoundingClientRect();
      return r.width > 50;
    }).catch(() => false);

    if (!sidebarVisible) {
      // Try clicking any hamburger/menu button to reveal sidebar
      const opened = await page.evaluate(() => {
        const btn = [
          document.querySelector('[aria-label*="menu" i]:not([aria-haspopup])'),
          document.querySelector('[aria-label*="open" i][role="button"]'),
          ...[...document.querySelectorAll("header button, [class*='AppBar'] button")]
            .filter(b => {
              const t = (b.innerText || b.getAttribute("aria-label") || "").trim();
              return t.length < 4 && b.getBoundingClientRect().width > 0;
            }),
        ].filter(Boolean)[0];
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (opened) await page.waitForTimeout(800).catch(() => {});
    }

    let navItems = await discoverAllNavigationItems(page);

    // Scroll sidebar down to discover items hidden below the fold
    await page.evaluate(() => {
      const sidebar = document.querySelector(
        "aside, nav, [class*='sidebar'], [class*='Sidebar'], [class*='drawer'], [class*='Drawer'], [role='navigation']"
      );
      if (sidebar) {
        sidebar.scrollTop = sidebar.scrollHeight / 2;
      }
    }).catch(() => {});
    await page.waitForTimeout(800);
    const moreNavItems = await discoverAllNavigationItems(page);
    // Merge unique items
    const navSeen = new Set(navItems.map(n => n.text.toLowerCase()));
    for (const item of moreNavItems) {
      if (!navSeen.has(item.text.toLowerCase())) {
        navItems.push(item);
        navSeen.add(item.text.toLowerCase());
      }
    }

    // Scroll back to top
    await page.evaluate(() => {
      const sidebar = document.querySelector(
        "aside, nav, [class*='sidebar'], [class*='Sidebar'], [class*='drawer'], [class*='Drawer'], [role='navigation']"
      );
      if (sidebar) sidebar.scrollTop = 0;
    }).catch(() => {});
    await page.waitForTimeout(400);

    if (navItems.length < 3) {
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

        await runController.assertActive({ phase: "recon", moduleName: navItem.text });
        const navigated = await navigateToDiscoveredModule(page, navItem, url);

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
        if (isRunCancelledError(err)) throw err;
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
          testCases: [{
            id: `TC-${recon.name.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 6)}-001`,
            title: `${recon.name} — basic load`,
            priority: "P0", category: "happy_path",
            steps: [
              { action: "navigate", url: recon.url, description: `Open ${recon.name}` },
              { action: "screenshot", label: `${recon.name.toLowerCase().replace(/\s+/g, "_")}_fallback` },
            ],
            expected: `${recon.name} loads without errors`,
            assertions: [{ action: "ai_assert", description: "page loaded with visible content", optional: true }],
          }],
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 3: EXECUTE ALL TEST PLANS AGGRESSIVELY
    // ═══════════════════════════════════════════════════════
    console.log(`[deepExplore] Phase 3: Executing adaptive deep tests for ${moduleReconData.length} modules`);

    for (const recon of moduleReconData) {
      await runController.assertActive({ phase: "module_execute", moduleName: recon.name });
      const moduleOffset = allStepResults.length;
      await updateCurrentScreen(run.id, await takeScreenshot(page), `Phase 3: Testing "${recon.name}" with adaptive DOM coverage`);

      let moduleStepResults = [];
      try {
        const navigated = await navigateToDiscoveredModule(page, recon, url);
        if (!navigated) {
          throw new Error(`Could not navigate back to module "${recon.name}"`);
        }
        const expectedModuleUrl = page.url();

        moduleStepResults = await executeDeepModuleTest(page, recon.name, {
          context,
          browser,
          runId: run.id,
          resultOffset: moduleOffset,
          moduleTimeoutMs: actionTimeoutMs,
          expectedModuleUrl,
          runController,
          sessionMemory,
          reconData: recon,   // pass Phase 1 discovery — buttons, tabs, tabContents, forms
        });

        const hardFailure = moduleStepResults.length < 4 || moduleStepResults.every((s) => s.status !== "passed");
        if (hardFailure) {
          const fallbackPlan = moduleTestPlans.find((candidate) => candidate.name === recon.name);
          if (fallbackPlan?.testCases?.length) {
            console.warn(`[deepExplore] Adaptive pass weak for "${recon.name}" - running generated fallback plan`);
            // Extract raw Playwright steps from structured test cases
            const fallbackSteps = fallbackPlan.testCases.flatMap(tc =>
              Array.isArray(tc.steps) ? [...tc.steps, ...(tc.assertions || [])] : (tc.action ? [tc] : [])
            );
            const fallbackResults = await executeBrowserSteps(fallbackSteps, actionTimeoutMs, {
              runId: run.id,
              stopOnFailure: false,
              liveScreen: true,
              autoScreenshot: true,
              _existingPage: page,
              _existingContext: context,
              _existingBrowser: browser,
              _resultOffset: moduleOffset + moduleStepResults.length,
              runController,
            });
            moduleStepResults.push(...fallbackResults);
          }
        }
      } catch (err) {
        if (isRunCancelledError(err)) throw err;
        console.warn(`[deepExplore] Phase 3 execution failed for "${recon.name}":`, err.message);
        moduleStepResults = [{
          stepIndex: moduleOffset,
          action: "error",
          description: `Execution error in ${recon.name}: ${err.message}`,
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
        name: recon.name,
        url: recon.url,
        status: mFailed > 0 ? "failed" : "passed",
        stepResults: moduleStepResults,
        testCasesGenerated: moduleTestPlans.find((candidate) => candidate.name === recon.name)?.testCases?.length || 0,
        summary: { total: moduleStepResults.length, passed: mPassed, failed: mFailed },
      });
      console.log(`[deepExplore] Module "${recon.name}": ${mPassed}✓ ${mFailed}✗`);
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 3.5: CASCADING VERIFICATION
    // For every entity created during testing, navigate to related modules
    // and verify that the entity's effect is visible there too.
    // Example: create a Task → check Calendar module shows it; create a User → check Team module lists them.
    // ═══════════════════════════════════════════════════════
    const createdEntities = sessionMemory?.createdEntities || [];
    if (createdEntities.length > 0 && moduleReconData.length > 1) {
      await updateCurrentScreen(run.id, await takeScreenshot(page), `Phase 3.5: Cascading verification — checking ${createdEntities.length} created entities across ${moduleReconData.length} modules…`);
      console.log(`[deepExplore] Phase 3.5: Cascading check for ${createdEntities.length} entities`);

      for (const entity of createdEntities.slice(0, 5)) {
        if (!entity.primaryValue) continue;

        // Find related modules — heuristic: any module whose name shares keywords with the entity type
        const entityType = (entity.entityType || entity.module || "").toLowerCase();
        const relatedModules = moduleReconData.filter(m => {
          if (m.name === entity.module) return false; // skip source module
          const mName = m.name.toLowerCase();
          // Common cascading relationships
          if (/task|project/.test(entityType) && /calendar|timeline|gantt|board|sprint|backlog/.test(mName)) return true;
          if (/user|member|team|employee/.test(entityType) && /team|group|department|user|member|people/.test(mName)) return true;
          if (/role|permission/.test(entityType) && /user|member|access/.test(mName)) return true;
          if (/project/.test(entityType) && /task|report|dashboard/.test(mName)) return true;
          if (/invoice|order/.test(entityType) && /report|finance|account/.test(mName)) return true;
          return false;
        });

        for (const relModule of relatedModules.slice(0, 2)) {
          try {
            await runController.assertActive({ phase: "cascading", entity: entity.primaryValue, relatedModule: relModule.name });
            const navigated = await navigateToDiscoveredModule(page, relModule, url);
            if (!navigated) continue;
            await page.waitForTimeout(1200);
            await dismissOverlays(page).catch(() => {});

            const cascadeOffset = allStepResults.length;
            const cascadeResults = await executeBrowserSteps([
              { action: "screenshot", label: `cascade_${entity.module}_to_${relModule.name.replace(/\s+/g, "_").toLowerCase()}` },
              {
                action: "ai_assert",
                description: `"${entity.primaryValue}" is visible or reflected in ${relModule.name} after being created in ${entity.module}`,
                optional: true,
              },
            ], actionTimeoutMs, {
              runId: run.id,
              stopOnFailure: false,
              _existingPage: page,
              _existingContext: context,
              _existingBrowser: browser,
              _resultOffset: cascadeOffset,
              runController,
            });
            allStepResults.push(...cascadeResults);
            await updateRunLive(run.id, allStepResults);
            console.log(`[deepExplore] Cascade: "${entity.primaryValue}" checked in "${relModule.name}"`);
          } catch (err) {
            if (isRunCancelledError(err)) throw err;
            console.warn(`[deepExplore] Cascade check failed: "${entity.primaryValue}" in "${relModule.name}":`, err.message);
          }
        }
      }
    }

    if (sessionMemory.pendingCredentialChecks.length > 0) {
      await updateCurrentScreen(run.id, await takeScreenshot(page), "Phase 4: Verifying generated credentials in fresh sessions…");
      const credentialResults = await runCredentialClosureChecks({
        browser,
        sessionMemory,
        runId: run.id,
        resultOffset: allStepResults.length,
        runController,
      });
      allStepResults.push(...credentialResults);
      await updateRunLive(run.id, allStepResults);
    }

  } catch (err) {
    if (isRunCancelledError(err)) {
      cancelledError = err;
    } else {
      fatalError = err;
    }
  } finally {
    await browser.close();
  }

  if (cancelledError) {
    const passed = allStepResults.filter((step) => step.status === "passed").length;
    const failed = allStepResults.filter((step) => step.status === "failed").length;
    const skipped = allStepResults.filter((step) => step.status === "skipped").length;
    const output = {
      instructions: raw,
      discoveredModules: moduleResults.map((moduleResult) => moduleResult.name),
      modules: moduleResults.map((moduleResult) => ({
        ...moduleResult,
        stepResults: moduleResult.stepResults.map((step) => ({ ...step, screenshot: step.screenshot ? true : null })),
      })),
      stepResults: allStepResults,
      createdEntities: sessionMemory.createdEntities,
      credentialChecks: sessionMemory.credentialChecks,
      cancelControl: {
        message: cancelledError.message,
        details: cancelledError.details || null,
      },
      summary: {
        total: allStepResults.length,
        passed,
        failed,
        skipped,
        modules: moduleResults.length,
        cancelled: true,
      },
    };
    await pool.query(
      `UPDATE testing_agent_runs SET status='cancelled', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, safeJsonStringify(output)]
    );
    return {
      runId: run.id,
      status: "cancelled",
      summary: output.summary,
      discoveredModules: output.discoveredModules,
    };
  }

  if (fatalError) {
    await pool.query(
      `UPDATE testing_agent_runs SET status='failed', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, safeJsonStringify({ error: fatalError.message, instructions: raw, stepResults: allStepResults })]
    );
    throw fatalError;
  }

  // ── Generate comprehensive QA report ──
  await updateCurrentScreen(run.id, null, "Analyzing test results and generating QA report…");
  const passed = allStepResults.filter(s => s.status === "passed").length;
  const failed = allStepResults.filter(s => s.status === "failed").length;
  const skipped = allStepResults.filter(s => s.status === "skipped").length;
  const finalStatus = failed > 0 ? "failed" : "passed";
  const diagnosticsSummary = summarizeRunDiagnostics(allStepResults);

  // Per-test-case analysis: compare expected vs actual, extract real bugs
  const { moduleTestResults, allBugs } = await analyzeAllModuleResults(moduleResults, moduleTestPlans, allStepResults);

  // Structured markdown report in the exact professional QA format
  const appName = (() => { try { return new URL(url).hostname; } catch { return "Application"; } })();
  const markdownReport = generateMarkdownQAReport({
    url, email, appName,
    moduleTestResults,
    allBugs,
    testDate: new Date().toISOString().split("T")[0],
  });

  // Backward-compatible insights object
  const insights = {
    verdict: allBugs.length === 0
      ? "All tests passed — no defects found."
      : `${allBugs.length} defect${allBugs.length === 1 ? "" : "s"} found: ${allBugs.filter(b => b.severity === "Critical").length} critical, ${allBugs.filter(b => b.severity === "High").length} high.`,
    whatWorked: moduleTestResults.filter(m => m.testCaseResults?.every(tc => tc.status === "PASS")).map(m => m.name).slice(0, 5),
    whatFailed: allBugs.slice(0, 5).map(b => b.title),
    rootCause: allBugs[0]?.description || null,
    recommendations: allBugs.slice(0, 4).map(b => b.fix).filter(Boolean),
    nextTestsToRun: [],
    performanceNote: null,
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
      plan: { modulesPlanned: moduleTestPlans.length, totalTestCases: moduleTestPlans.reduce((s, p) => s + (p.testCases || []).length, 0) },
      execute: { modulesExecuted: moduleResults.length },
    },
    discoveredModules: moduleResults.map(m => m.name),
    modules: moduleResults.map(m => ({
      ...m,
      stepResults: m.stepResults.map(s => ({ ...s, screenshot: s.screenshot ? true : null })),
    })),
    moduleTestResults,
    stepResults: allStepResults,
    diagnostics: diagnosticsSummary,
    createdEntities: sessionMemory.createdEntities,
    credentialChecks: sessionMemory.credentialChecks,
    allBugs,
    markdownReport,
    insights,
    summary: {
      total: allStepResults.length,
      passed,
      failed,
      skipped,
      modules: moduleResults.length,
      bugsFound: allBugs.length,
      criticalBugs: allBugs.filter(b => b.severity === "Critical").length,
      highBugs: allBugs.filter(b => b.severity === "High").length,
      runtimePageErrors: diagnosticsSummary.pageErrors,
      runtimeConsoleErrors: diagnosticsSummary.consoleErrors,
      runtimeRequestFailures: diagnosticsSummary.requestFailures,
      runtimeHttpFailures: diagnosticsSummary.responseFailures,
    },
  };

  await pool.query(
    `UPDATE testing_agent_runs SET status=$2, output_json=$3, finished_at=NOW() WHERE id=$1`,
    [run.id, finalStatus, safeJsonStringify(output)]
  );

  return {
    runId: run.id,
    status: finalStatus,
    summary: output.summary,
    allBugs,
    markdownReport,
    insights,
    discoveredModules: output.discoveredModules,
    modules: moduleResults.map(m => ({
      name: m.name,
      status: m.status,
      summary: m.summary,
      testCasesGenerated: (moduleTestPlans.find(p => p.name === m.name)?.testCases || []).length,
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
        timeoutMs,
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
    [workspaceId, projectId, taskId, triggerSource, safeJsonStringify(parsedSteps), triggeredBy || null]
  );
  if (onRunCreated) onRunCreated(run.id);
  const runController = createRunController(run.id);
  const actionTimeoutMs = normalizeActionTimeoutMs(timeoutMs, 20000);

  let stepResults;
  try {
    stepResults = await executeBrowserSteps(parsedSteps, actionTimeoutMs, {
      runId: run.id,
      stopOnFailure: false,
      runController,
    });
  } catch (err) {
    if (isRunCancelledError(err)) {
      const output = {
        instructions: raw,
        parsedSteps,
        stepResults: Array.isArray(stepResults) ? stepResults : [],
        cancelControl: {
          message: err.message,
          details: err.details || null,
        },
        summary: {
          total: Array.isArray(stepResults) ? stepResults.length : 0,
          passed: Array.isArray(stepResults) ? stepResults.filter((step) => step.status === "passed").length : 0,
          failed: Array.isArray(stepResults) ? stepResults.filter((step) => step.status === "failed").length : 0,
          skipped: Array.isArray(stepResults) ? stepResults.filter((step) => step.status === "skipped").length : 0,
          cancelled: true,
        },
      };
      await pool.query(
        `UPDATE testing_agent_runs SET status='cancelled', output_json=$2, finished_at=NOW() WHERE id=$1`,
        [run.id, safeJsonStringify(output)]
      );
      return {
        runId: run.id,
        status: "cancelled",
        summary: output.summary,
        parsedSteps,
      };
    }
    await pool.query(
      `UPDATE testing_agent_runs SET status='failed', output_json=$2, finished_at=NOW() WHERE id=$1`,
      [run.id, safeJsonStringify({ error: err.message, instructions: raw })]
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
    [run.id, finalStatus, safeJsonStringify(output)]
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
