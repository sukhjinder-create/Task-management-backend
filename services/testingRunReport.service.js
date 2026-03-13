function parseJsonMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clipText(value, max = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDurationMs(ms) {
  const value = Number(ms || 0);
  if (!value) return "0ms";
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60000).toFixed(1)}m`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function summarizeDiagnostics(output = {}) {
  const diagnostics = output.diagnostics || {};
  const summary = output.summary || {};
  return {
    pageErrors: diagnostics.pageErrors ?? summary.runtimePageErrors ?? 0,
    consoleErrors: diagnostics.consoleErrors ?? summary.runtimeConsoleErrors ?? 0,
    requestFailures: diagnostics.requestFailures ?? summary.runtimeRequestFailures ?? 0,
    responseFailures: diagnostics.responseFailures ?? summary.runtimeHttpFailures ?? 0,
    examples: asArray(diagnostics.examples).slice(0, 6),
  };
}

function pickKeySteps(stepResults = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const step of stepResults) {
    const desc = clipText(step?.description || step?.action || "step", 160);
    const key = `${step?.action}:${desc}`;
    const important = step?.status === "failed" ||
      ["navigate", "ai_click", "ai_fill", "select_option", "upload_file", "check_performance"].includes(step?.action) ||
      /login|sign in|create|submit|save|invite|edit|open|search|upload|delete|chat|message|workspace|user/i.test(desc);
    if (!important || seen.has(key)) continue;
    seen.add(key);
    out.push({
      status: step?.status || "unknown",
      action: step?.action || "step",
      description: desc,
      error: clipText(step?.error || "", 300) || null,
      currentUrl: step?.currentUrl || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function buildModuleCoverage(output = {}) {
  const modules = asArray(output.modules);
  return modules.map((moduleResult) => {
    const stepResults = asArray(moduleResult.stepResults);
    const passed = stepResults.filter((step) => step?.status === "passed").length;
    const failed = stepResults.filter((step) => step?.status === "failed").length;
    const testedFeatures = [];
    if (stepResults.some((step) => /search/i.test(step?.description || ""))) testedFeatures.push("search/filter");
    if (stepResults.some((step) => /create|add|invite/i.test(step?.description || ""))) testedFeatures.push("create flow");
    if (stepResults.some((step) => /edit|update/i.test(step?.description || ""))) testedFeatures.push("edit flow");
    if (stepResults.some((step) => /upload/i.test(step?.description || ""))) testedFeatures.push("upload flow");
    if (stepResults.some((step) => /chat|message/i.test(step?.description || ""))) testedFeatures.push("chat flow");
    return {
      name: moduleResult?.name || "Unnamed module",
      status: moduleResult?.status || "unknown",
      passed,
      failed,
      total: stepResults.length,
      testedFeatures,
    };
  });
}

function buildNarrativeSections(run) {
  const output = parseJsonMaybe(run?.output_json, {});
  const insights = output.insights || null;
  const summary = output.summary || {};
  const stepResults = asArray(output.stepResults);
  const commandOutputs = asArray(output.commandOutputs);
  const moduleCoverage = buildModuleCoverage(output);
  const keySteps = pickKeySteps(stepResults);
  const failedSteps = stepResults.filter((step) => step?.status === "failed").slice(0, 12);
  const diagnostics = summarizeDiagnostics(output);
  const createdEntities = asArray(output.createdEntities);
  const credentialChecks = asArray(output.credentialChecks);
  const allBugs = asArray(output.allBugs);
  const moduleTestResults = asArray(output.moduleTestResults);

  const sections = [];

  const overviewLines = [
    `Run ID: ${run.id}`,
    `Mode: ${run.mode}`,
    `Status: ${run.status}`,
    `Task: ${run.task_name || "Unknown task"} (${run.project_name || "Unknown project"})`,
    `Started: ${formatDate(run.started_at || run.created_at)}`,
    `Finished: ${formatDate(run.finished_at)}`,
  ];
  if (summary.total != null) overviewLines.push(`Execution summary: ${summary.passed || 0} passed, ${summary.failed || 0} failed, ${summary.skipped || 0} skipped out of ${summary.total} total checks.`);
  if (summary.bugsFound != null) overviewLines.push(`Bugs found: ${summary.bugsFound} (${summary.criticalBugs || 0} critical, ${summary.highBugs || 0} high).`);
  if (insights?.verdict) overviewLines.push(`AI verdict: ${insights.verdict}`);
  sections.push({ title: "Overview", lines: overviewLines });

  if (run.mode === "deep_exploration") {
    const flowLines = [];
    if (output.instructions) flowLines.push(`Input brief: ${clipText(output.instructions, 300)}`);
    if (output.phases?.recon) {
      const r = output.phases.recon;
      flowLines.push(`Recon discovered ${r.modulesDiscovered || 0} modules, ${r.totalButtonsFound ?? 0} clickable controls, ${r.totalModalsFound ?? 0} modals, and ${r.totalTabsFound ?? 0} tab groups.`);
    }
    for (const module of moduleCoverage) {
      const featureText = module.testedFeatures.length ? ` Features exercised: ${module.testedFeatures.join(", ")}.` : "";
      flowLines.push(`${module.name}: ${module.passed}/${module.total} checks passed, ${module.failed} failed.${featureText}`);
    }
    if (createdEntities.length > 0) {
      flowLines.push(`Entities created during testing: ${createdEntities.map((e) => e.primaryValue || e.entityType || e.module || "item").slice(0, 10).join(", ")}.`);
    }
    sections.push({
      title: "Flow Covered",
      lines: flowLines.length ? flowLines : ["No deep module narrative was captured."],
    });

    // Test cases per module (from structured moduleTestResults)
    if (moduleTestResults.length > 0) {
      for (const mResult of moduleTestResults) {
        const tcLines = [];
        for (const tc of asArray(mResult.testCaseResults)) {
          const statusLabel = tc.status === "PASS" ? "[PASS]" : tc.status === "BUG" ? "[BUG]" : "[FAIL]";
          tcLines.push(`${tc.id || "TC-???"} ${statusLabel} ${tc.title || "Untitled"} (${tc.priority || "P1"})`);
          if (tc.expected) tcLines.push(`  Expected: ${clipText(tc.expected, 200)}`);
          if (tc.actualBehavior) tcLines.push(`  Actual:   ${clipText(tc.actualBehavior, 200)}`);
          if (tc.isBug && tc.bug) {
            tcLines.push(`  Bug: [${tc.bug.severity}] ${tc.bug.defectType} — ${clipText(tc.bug.description || tc.bug.title || "", 200)}`);
            tcLines.push(`  Fix: ${clipText(tc.bug.fix || "", 200)}`);
          }
        }
        if (tcLines.length > 0) {
          sections.push({ title: `Test Cases: ${mResult.name}`, lines: tcLines });
        }
      }
    }
  } else if (stepResults.length > 0) {
    sections.push({
      title: "Flow Covered",
      lines: keySteps.map((step, i) => `${i + 1}. [${step.status}] ${step.description}${step.currentUrl ? ` @ ${clipText(step.currentUrl, 100)}` : ""}`),
    });
  } else if (commandOutputs.length > 0) {
    sections.push({
      title: "Flow Covered",
      lines: commandOutputs.map((c, i) => `${i + 1}. ${c.command} -> ${c.passed ? "passed" : c.cancelled ? "cancelled" : c.timedOut ? "timed out" : "failed"} in ${formatDurationMs(c.durationMs)}.`),
    });
  }

  const brokenLines = [];
  if (allBugs.length > 0) {
    for (const bug of allBugs.slice(0, 12)) {
      brokenLines.push(`${bug.id || "BUG"} [${String(bug.severity || "Medium").toUpperCase()}] ${bug.title} (${bug.module || "general"})`);
      if (bug.description) brokenLines.push(`  Description: ${clipText(bug.description, 260)}`);
      if (bug.impact) brokenLines.push(`  Impact: ${clipText(bug.impact, 200)}`);
    }
  }
  if (!brokenLines.length) {
    for (const step of failedSteps) {
      brokenLines.push(`[${step.action}] ${clipText(step.description, 160)} -> ${clipText(step.error || "No error text captured", 280)}`);
    }
  }
  if (!brokenLines.length && commandOutputs.some((c) => !c.passed)) {
    for (const c of commandOutputs.filter((item) => !item.passed).slice(0, 8)) {
      brokenLines.push(`${c.command}: ${clipText(c.aiAnalysis || c.stderr || c.stdout || "Command failed", 280)}`);
    }
  }
  sections.push({
    title: "Defects Found",
    lines: brokenLines.length ? brokenLines : ["No hard failures or defects were recorded in this run."],
  });

  const runtimeLines = [];
  if (diagnostics.pageErrors || diagnostics.consoleErrors || diagnostics.requestFailures || diagnostics.responseFailures) {
    runtimeLines.push(`Runtime errors: ${diagnostics.pageErrors} page errors, ${diagnostics.consoleErrors} console warnings/errors, ${diagnostics.requestFailures} failed requests, ${diagnostics.responseFailures} HTTP 4xx/5xx responses.`);
  }
  if (diagnostics.examples.length) {
    runtimeLines.push(...diagnostics.examples.map((example, i) => `Example ${i + 1}: ${clipText(example, 260)}`));
  }
  if (credentialChecks.length) {
    runtimeLines.push(...credentialChecks.map((check) => `Credential closure check for ${check.label || check.email || check.username || "generated account"}: ${check.status}${check.message ? ` - ${clipText(check.message, 200)}` : ""}.`));
  }
  sections.push({
    title: "Errors And Evidence",
    lines: runtimeLines.length ? runtimeLines : ["No extra runtime diagnostics were captured beyond the step results."],
  });

  const fixLines = [];
  if (insights?.recommendations?.length) fixLines.push(...insights.recommendations.slice(0, 10));
  if (!fixLines.length && allBugs.length > 0) {
    fixLines.push(...allBugs.slice(0, 8).map((b) => `[${b.id}] ${clipText(b.fix || b.title || "Investigate this defect", 220)}`));
  }
  if (!fixLines.length && failedSteps.length) {
    fixLines.push(...failedSteps.map((step) => `Investigate ${clipText(step.description, 140)} and resolve: ${clipText(step.error || "unknown failure", 200)}`));
  }
  sections.push({
    title: "Recommended Fixes",
    lines: fixLines.length ? fixLines : ["No fix recommendations were generated for this run."],
  });

  const gapLines = [];
  if (output.discoveredModules?.length) {
    gapLines.push(`Modules discovered: ${output.discoveredModules.join(", ")}.`);
  }
  if (insights?.nextTestsToRun?.length) {
    gapLines.push(...insights.nextTestsToRun.slice(0, 6).map((t) => `Next: ${t}`));
  }
  sections.push({
    title: "Coverage And Next Checks",
    lines: gapLines.length ? gapLines : ["Coverage gaps were not explicitly reported."],
  });

  return sections;
}

// ── Convert markdown to clean plain text for PDF ──────────────────────────
function markdownToPlainText(md) {
  return md
    // Strip non-ASCII (emojis, special unicode)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    // H1 → uppercase with underline
    .replace(/^# (.+)$/gm, (_, t) => `${t.toUpperCase()}\n${"=".repeat(Math.min(t.length, 80))}`)
    // H2
    .replace(/^## (.+)$/gm, (_, t) => `\n${t.toUpperCase()}\n${"-".repeat(Math.min(t.length, 80))}`)
    // H3/H4
    .replace(/^#{3,6} (.+)$/gm, (_, t) => `\n  ${t}`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "$1")
    // Italic
    .replace(/\*(.+?)\*/g, "$1")
    // Backtick inline code
    .replace(/`(.+?)`/g, "$1")
    // Table separator rows
    .replace(/^\|[-| :]+\|$/gm, "")
    // Table rows → pipe-separated columns
    .replace(/^\|(.+)\|$/gm, (_, content) =>
      content.split("|").map((c) => c.trim()).filter(Boolean).join("  |  ")
    )
    // Horizontal rules
    .replace(/^---+$/gm, "─".repeat(72).replace(/─/g, "-"))
    // List items — keep dash
    // Multiple blank lines → double blank
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPlainText(run, sections) {
  const lines = [
    "Testing Agent Execution Report",
    "==============================",
    "",
  ];
  for (const section of sections) {
    lines.push(section.title);
    lines.push("-".repeat(section.title.length));
    for (const line of section.lines) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildMarkdown(run, sections) {
  const lines = [
    `# Testing Agent Execution Report`,
    "",
    `Run ID: \`${run.id}\``,
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const line of section.lines) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildRunReportDocument(run) {
  const output = parseJsonMaybe(run?.output_json, {});
  const sections = buildNarrativeSections(run);

  // If a professional QA markdown report was generated (deep_exploration), use it
  if (output.markdownReport && typeof output.markdownReport === "string" && output.markdownReport.length > 100) {
    return {
      generatedAt: new Date().toISOString(),
      title: "QA Test Report",
      plainText: markdownToPlainText(output.markdownReport),
      markdown: output.markdownReport,
      sections,
    };
  }

  // Fallback for other run modes (browser-run, multi-scenario, CLI)
  return {
    generatedAt: new Date().toISOString(),
    title: "Testing Agent Execution Report",
    plainText: buildPlainText(run, sections),
    markdown: buildMarkdown(run, sections),
    sections,
  };
}

// ── PDF line wrapper ──────────────────────────────────────────────────────
// Courier 9pt: each char = 5.4pt. Page 612pt, margins 45+45 = 522pt content.
// Max chars per line = floor(522 / 5.4) = 96. Use 94 to be safe.
const PDF_MAX_LINE = 94;
const PDF_FONT_SIZE = 9;
const PDF_LINE_HEIGHT = 13;
const PDF_LINES_PER_PAGE = 56;
const PDF_MARGIN_LEFT = 45;
const PDF_START_Y = 756;

function normalizeAscii(value = "") {
  return String(value || "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[ ]{2,}/g, " ");
}

function wrapLines(text = "", maxLength = PDF_MAX_LINE) {
  const output = [];
  for (const paragraph of String(text || "").split(/\r?\n/)) {
    const trimmed = paragraph.trimEnd();
    if (!trimmed) {
      output.push("");
      continue;
    }
    // If line fits, push as-is
    if (trimmed.length <= maxLength) {
      output.push(trimmed);
      continue;
    }
    // Word-wrap long lines
    let current = "";
    for (const word of trimmed.split(/\s+/)) {
      if (!current) {
        current = word;
        continue;
      }
      if (`${current} ${word}`.length > maxLength) {
        output.push(current);
        // Indent continuation lines by 2 spaces if original had indentation
        const indent = trimmed.match(/^(\s+)/) ? "  " : "";
        current = `${indent}${word}`;
      } else {
        current = `${current} ${word}`;
      }
    }
    if (current) output.push(current);
  }
  return output;
}

function escapePdfText(value = "") {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function buildPdfBufferFromReport(reportDocument, {
  title = "Testing Agent Report",
  metadata = [],
} = {}) {
  const headerLines = [title, ...metadata.filter(Boolean), ""];
  const textLines = wrapLines(normalizeAscii(reportDocument?.plainText || ""), PDF_MAX_LINE);
  const allLines = [...headerLines, ...textLines];

  const pages = [];
  for (let i = 0; i < allLines.length; i += PDF_LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + PDF_LINES_PER_PAGE));
  }
  if (!pages.length) pages.push(["No report content available."]);

  const objects = [];
  const addObject = (value) => { objects.push(value); return objects.length; };

  const catalogId = addObject("");
  const pagesId = addObject("");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageObjectIds = [];

  for (const pageLines of pages) {
    const ops = [
      "BT",
      `/F1 ${PDF_FONT_SIZE} Tf`,
      `${PDF_MARGIN_LEFT} ${PDF_START_Y} Td`,
      `${PDF_LINE_HEIGHT} TL`,
    ];
    let first = true;
    for (const line of pageLines) {
      if (first) {
        ops.push(`(${escapePdfText(line)}) Tj`);
        first = false;
      } else {
        ops.push("T*");
        ops.push(`(${escapePdfText(line)}) Tj`);
      }
    }
    ops.push("ET");
    const stream = ops.join("\n");
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageObjectIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
