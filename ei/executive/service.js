// ei/executive/service.js
//
// EI V2.1 Phase 7 — orchestration: produce a full executive briefing by running every
// executive question over the reasoning corpus. Deterministic, flag-gated, additive.
// Answers are COMPUTED (not persisted) — they are pure projections of the immutable
// records, so there is nothing new to store and nothing can drift. Every answer is
// either "answered" (with references) or "insufficient_evidence" (with a reason).

import { answerExecutiveQuestion } from "./engine.js";
import { ALL_QUESTIONS } from "./questions.js";
import { isEiExecutiveEnabled } from "../config/flags.js";

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {object} args.corpus   { traces, predictions, recommendations, evidence, departmentByEntity? }
 * @param {string[]} [args.questions]  subset of question types (default: all)
 */
export async function executiveBriefing({ workspaceId, corpus = {}, questions = ALL_QUESTIONS } = {}) {
  if (!isEiExecutiveEnabled(workspaceId)) return { skipped: "flag_off" };
  const answers = questions.map((q) => answerExecutiveQuestion({ workspaceId, questionType: q, corpus }));
  const answered = answers.filter((a) => a.status === "answered").length;
  return {
    workspaceId: String(workspaceId),
    eiVersion: "2.1",
    answered,
    insufficient: answers.length - answered,
    answers,
  };
}
