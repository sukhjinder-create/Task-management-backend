import pool from "../db.js";
import { generateText, getLlmRuntimeDiagnostics } from "./llm.js";
import { getMeetingIntelligenceReview } from "./huddleMeetingIntelligence.service.js";
import { listWorkspaceMemoryEntries } from "./workspaceMemory.service.js";

function safeString(value, maxLength = 12000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function serviceError(reason, statusCode = 400) {
  const error = new Error(reason);
  error.reason = reason;
  error.statusCode = statusCode;
  return error;
}

function jsonObject(text) {
  const raw = safeString(text);
  const fenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw serviceError("copilot_response_invalid", 502);
  return JSON.parse(fenced.slice(start, end + 1));
}

function artifactEvidence(artifact) {
  const found = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([key, nested]) => {
      if (/evidenceSegmentIds/i.test(key) && Array.isArray(nested)) {
        nested.forEach((id) => found.add(String(id)));
      } else {
        visit(nested);
      }
    });
  };
  visit(artifact?.contentJson);
  return [...found];
}

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "did", "for", "from",
  "have", "how", "meeting", "that", "the", "their", "this", "was", "what",
  "when", "where", "which", "who", "why", "with",
]);

function searchTerms(question) {
  return [...new Set(
    safeString(question, 1000)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 2 && !SEARCH_STOP_WORDS.has(term))
  )].slice(0, 20);
}

function relevanceScore(item, terms) {
  if (!terms.length) return 0;
  const haystack = `${item.label || ""} ${item.text || ""}`.toLowerCase();
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0
  );
}

function relevantItems(items, question, limit) {
  const terms = searchTerms(question);
  return items
    .map((item, index) => ({
      item,
      index,
      score: relevanceScore(item, terms),
    }))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function buildEvidenceCatalog(review, memories, question) {
  const transcriptItems = review.transcript.slice(-400).map((segment) => ({
      ref: `T:${segment.id}`,
      type: "transcript",
      id: segment.id,
      label: segment.speaker?.label || "Participant",
      text: safeString(segment.text, 1600),
      occurredAt: segment.startedAt || segment.createdAt || null,
    }));
  const latestTranscript = transcriptItems.slice(-40);
  const relevantTranscript = relevantItems(transcriptItems, question, 80);
  const transcript = [...new Map(
    [...relevantTranscript, ...latestTranscript].map((item) => [item.ref, item])
  ).values()].slice(0, 100);
  const artifacts = [];
  for (const [name, artifact] of Object.entries(review.artifacts || {})) {
    if (
      !artifact?.id ||
      artifact.approvalStatus !== "approved" ||
      name === "sourcesByArtifactId"
    ) {
      continue;
    }
    artifacts.push({
      ref: `A:${artifact.id}`,
      type: "artifact",
      id: artifact.id,
      label: `${artifact.artifactType} artifact`,
      text: safeString(artifact.contentText, 5000),
      evidenceSegmentIds: artifactEvidence(artifact),
      occurredAt: artifact.updatedAt,
    });
  }
  const memoryItems = memories.map((memory) => ({
      ref: `M:${memory.id}`,
      type: "memory",
      id: memory.id,
      label: memory.title || "Workspace memory",
      text: safeString(memory.content, 3000),
      occurredAt: memory.updated_at,
    }));
  const memory = relevantItems(memoryItems, question, 20);
  const catalog = [...transcript, ...artifacts, ...memory];
  return catalog.filter((item) => item.text);
}

export async function askHuddleCopilot({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  question,
}) {
  const normalizedQuestion = safeString(question, 1000);
  if (!normalizedQuestion) throw serviceError("copilot_question_required", 422);
  const diagnostics = getLlmRuntimeDiagnostics();
  if (!diagnostics.configured) throw serviceError("copilot_provider_not_configured", 503);

  const [review, memories] = await Promise.all([
    getMeetingIntelligenceReview({
      workspaceId,
      sessionId,
      actorUserId,
      role,
    }),
    listWorkspaceMemoryEntries({
      workspaceId,
      userId: actorUserId,
      role,
      q: "",
      limit: 50,
    }),
  ]);
  const catalog = buildEvidenceCatalog(review, memories, normalizedQuestion);
  if (!catalog.length) throw serviceError("copilot_evidence_unavailable", 409);

  const prompt = [
    "You are an evidence-bound meeting copilot.",
    "Answer only from the supplied evidence. If evidence is insufficient, say so.",
    "Never invent people, commitments, decisions, dates, or facts.",
    "Return JSON: {\"answer\":\"...\",\"references\":[\"T:uuid\"],\"confidence\":0.0}.",
    `Question: ${normalizedQuestion}`,
    `Evidence:\n${catalog
      .map((item) => `[${item.ref}] ${item.label}: ${item.text}`)
      .join("\n")}`,
  ].join("\n\n");
  const generated = jsonObject(
    await generateText({
      prompt,
      json: true,
      temperature: 0.1,
      maxTokens: 900,
    })
  );
  const catalogByRef = new Map(catalog.map((item) => [item.ref, item]));
  const references = [...new Set(
    (Array.isArray(generated.references) ? generated.references : [])
      .map((ref) => safeString(ref, 120))
      .filter((ref) => catalogByRef.has(ref))
  )];
  if (!references.length) {
    throw serviceError("copilot_answer_missing_evidence", 502);
  }
  const answer = safeString(generated.answer, 12000);
  if (!answer) throw serviceError("copilot_answer_empty", 502);
  const evidence = references.map((ref) => {
    const item = catalogByRef.get(ref);
    return {
      ref,
      type: item.type,
      id: item.id,
      label: item.label,
      excerpt: item.text.slice(0, 500),
      occurredAt: item.occurredAt || null,
      evidenceSegmentIds: item.evidenceSegmentIds || [],
    };
  });
  const provenance = {
    source: "huddle_copilot_v1",
    meetingSessionId: sessionId,
    transcriptRevision: review.artifacts?.transcript?.currentRevision || null,
    evidenceCount: evidence.length,
    catalogCount: catalog.length,
    memoryCatalogCount: catalog.filter((item) => item.type === "memory").length,
  };
  const { rows } = await pool.query(
    `
    INSERT INTO huddle_copilot_queries (
      workspace_id,
      session_id,
      actor_user_id,
      question,
      answer,
      evidence,
      provider,
      model,
      provenance
    )
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb)
    RETURNING id, created_at
    `,
    [
      workspaceId,
      sessionId,
      actorUserId,
      normalizedQuestion,
      answer,
      JSON.stringify(evidence),
      diagnostics.provider,
      diagnostics.model,
      JSON.stringify(provenance),
    ]
  );
  return {
    id: rows[0].id,
    question: normalizedQuestion,
    answer,
    evidence,
    confidence: Number.isFinite(Number(generated.confidence))
      ? Math.max(0, Math.min(1, Number(generated.confidence)))
      : null,
    provider: diagnostics.provider,
    model: diagnostics.model,
    provenance,
    createdAt: rows[0].created_at,
  };
}

export async function listHuddleCopilotQueries({
  workspaceId,
  sessionId,
  actorUserId,
  limit = 30,
}) {
  const { rows } = await pool.query(
    `
    SELECT id, question, answer, evidence, provider, model, provenance, created_at
    FROM huddle_copilot_queries
    WHERE workspace_id = $1
      AND session_id = $2
      AND actor_user_id = $3
    ORDER BY created_at DESC
    LIMIT $4
    `,
    [workspaceId, sessionId, actorUserId, Math.min(Math.max(Number(limit) || 30, 1), 100)]
  );
  return rows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    evidence: row.evidence || [],
    provider: row.provider,
    model: row.model,
    provenance: row.provenance || {},
    createdAt: row.created_at,
  }));
}

export default {
  askHuddleCopilot,
  listHuddleCopilotQueries,
};
