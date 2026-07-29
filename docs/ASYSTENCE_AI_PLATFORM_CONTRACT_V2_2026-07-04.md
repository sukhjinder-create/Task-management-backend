# Asystence AI Platform — Contract v2 (Constitutional Document)

**Status:** Definitive public contract. Design-only. No implementation, no migration, no API/UI.
**Authority:** Supersedes the Phase 1 spec's contract. Every present and future AI capability MUST conform.
**Stability pledge:** This contract is **frozen at major version 2**. Evolution is **additive-only** (see §1.4). A `3.x` may never be needed and is discouraged by design.
**Resolves:** all 8 Critical findings from the Architecture Review Gate (mapping in §0.2).
**Notation:** TypeScript-style interfaces are used as *design notation* (language-agnostic contract), not implementation. Fields marked `?` are optional; `readonly` denotes immutable-after-creation.
**Date:** 2026-07-04

---

## §0. How to read this document

### 0.1 The one sentence
> Every AI action in Asystence — today's text summary and tomorrow's autonomous multi-tool vision agent — is expressed as **one `AIRequest` invoking one registered `Capability`, executed by the `Gateway` through `Ports`, returning one `AIResponse`** — where new modalities and features arrive as **new optional parts/fields**, never as breaking changes.

### 0.2 Critical-findings closure map (from the gate)
| # | Gate Critical | Resolved by |
|---|---|---|
| 1 | Text-only contract | §2 Parts model + §3 streaming envelope (modality-agnostic) |
| 2 | No provider/model capability discovery | §5 `describe()`/negotiation + §6 model matrix + §4 `requires` |
| 3 | Registry too thin / split-brain | §4 Contract (code) vs Configuration (DB) split + full metadata |
| 4 | No per-workspace keys / who-pays | §10 Key Ownership (KeyRef + billing owner) |
| 5 | Prompt injection & no output validation | §11 Safety pipeline + §7 structured prompt + output schema |
| 6 | `ai_*` isolation + fail-open | §9 tenant scoping + §1.5 fail-closed-when-required invariant |
| 7 | Cost cannot enforce (est=null) | §17 pre-execution estimate + fail-closed budgets |
| 8 | No tool/memory/orchestration ports | §14 Tools, §15 Memory, §16 Retrieval, §13 orchestration/steps |

### 0.3 Glossary
**Capability** = a registered AI use-case (immutable contract + governed config). **Invocation** = one execution of a capability via an `AIRequest`. **Part** = one typed unit of input/output content. **Port** = an interface the core depends on (Provider/Tool/Memory/Retrieval/KeyVault). **Adapter** = a provider/vendor-specific implementation of a port. **Resolution** = choosing the effective provider/model/prompt/policies for an invocation.

---

## §1. Core Philosophy

### 1.1 Five load-bearing ideas
1. **Uniform invocation.** There is exactly **one** execution contract (`AIRequest → AIResponse`) for all capabilities and all modalities. Complexity (tools, memory, agents, streaming) is expressed *inside* the envelope, never by a second contract.
2. **Parts over payloads.** Input and output are **ordered lists of typed `Part`s** (a discriminated union). A new modality (video, 3D, sensor) is a new `Part.kind` — purely additive. Consumers switch on `kind` and **ignore unknown kinds** (forward compatibility).
3. **Ports & Adapters (hexagonal).** The platform core knows only Ports. All vendor knowledge (OpenAI, Claude, Bedrock, a future provider) lives behind adapters. *No provider-specific type, header, or SDK ever appears in a request, response, capability, or business module.*
4. **Contract ≠ Configuration.** A capability's **contract** (its I/O schema, requirements, execution class) is immutable and **code-owned**. Its **configuration** (which provider/model/prompt/policy, enablement, locks, overrides) is mutable, **DB-owned**, and governed. These never live in the same object again (kills the split-brain).
5. **Negotiation, not assumption.** A request declares *requirements*; the platform **proves** a provider/model can satisfy them (context window, JSON, tools, vision, streaming) or **fails deterministically** with a typed error. Silent mis-routing is impossible by contract.

### 1.2 Why it survives 10 years
- **Additive-only evolution** (§1.4) means old callers never break.
- **Modality-agnostic parts** absorb every future input/output type without a new contract.
- **Capability negotiation** decouples *what a feature needs* from *what a provider offers*, so provider churn (new models weekly, deprecations monthly) is a data change.
- **Cross-cutting invariants** (tenancy, governance, safety, cost, observability) are properties of the envelope, so they cannot be "forgotten" by a new capability.

### 1.3 Why it is stable
The envelope has a **small, closed set of top-level fields**, each an extension point (maps/unions), rather than a wide, open set of scalars. You extend by populating an existing extension point, not by adding a sibling field. Stability comes from *shape*, not from freezing behavior.

### 1.4 Evolution rules (the constitution's amendment process)
- **MINOR (2.x):** add optional fields; add `Part.kind` variants; add capability flags; add policy kinds; add error codes. Old consumers MUST ignore what they don't understand.
- **MAJOR (3.x):** reserved for **removal/repurposing** of a field — which this platform commits **not** to do. Effectively frozen at 2.
- **Required-capability gate:** if a request needs a feature an executor lacks, resolution FAILS (typed), never degrades silently.
- **Deprecation:** fields are marked `@deprecated` and kept forever; never deleted.

### 1.5 Global invariants (true for every invocation, no exceptions)
- **Multi-tenant:** every object is scoped by `workspaceId`; superadmin scope is `PLATFORM`.
- **Governed:** every mutable object obeys the §9 permission matrix + inheritance/locking.
- **Safe:** every invocation passes the §11 safety pipeline.
- **Metered:** every invocation is cost-estimated (pre) and cost-recorded (post).
- **Observable:** every invocation emits a trace span within an execution tree.
- **Fail-closed where required:** security/cost/safety controls fail **closed** whenever the platform is in `enforced` mode; they may fail **open** only in explicit `permissive/bootstrap` mode. (Non-regression bootstrap is a mode, not the default forever.)

---

## §2. AI Request Contract

```ts
/** The single, versioned entry object for ALL AI work. Additive-only. */
interface AIRequest {
  readonly contractVersion: "2.0";            // envelope version (see §1.4)
  readonly requestId: string;                 // ULID; client- or platform-generated
  readonly idempotencyKey?: string;           // dedup + safe retry (see §13)

  // ── WHO / WHERE ──────────────────────────────────────────────
  identity: RequestIdentity;                  // actor + auth context (never raw secrets)
  tenant: TenantContext;                       // workspaceId | PLATFORM, residency, plan

  // ── WHAT ─────────────────────────────────────────────────────
  capability: string;                          // registered capability key (§4)
  capabilityVersion?: string;                  // pin a contract version; default = active

  // ── WHY ──────────────────────────────────────────────────────
  trigger?: Trigger;                           // business event that caused this (§11-events)
  executionContext?: ExecutionContext;         // parent request, workflow, step, journey (§12)

  // ── INPUT (modality-agnostic) ────────────────────────────────
  input: Part[];                               // ordered typed parts (§2.1)
  conversation?: ConversationRef;              // prior turns (id or inline messages)
  attachments?: Attachment[];                  // large binaries by reference (blob/S3/R2)
  variables?: Record<string, JsonValue>;       // prompt template variables (validated §7)

  // ── AUGMENTATION (opt-in, all additive) ──────────────────────
  memory?: MemoryDirective;                     // read/write scopes (§15)
  retrieval?: RetrievalDirective;               // RAG sources + params (§16)
  tools?: ToolDirective;                        // allowed tools + execution mode (§14)

  // ── HOW ──────────────────────────────────────────────────────
  runtime?: RuntimeDirective;                   // profile + policy set refs/overrides (§8)
  routing?: RoutingHint;                        // preferred provider/model (governed; may be overridden/denied)
  scheduling?: SchedulingDirective;             // sync|async|deferred|recurring, priority (§13)
  streaming?: StreamingDirective;               // want stream? transport? granularity?

  // ── CROSS-CUTTING ────────────────────────────────────────────
  security?: SecurityDirective;                 // data classification, tool restrictions (§11)
  compliance?: ComplianceDirective;             // residency, retention, redaction, legal hold (§11)
  cost?: CostDirective;                         // max cost ceiling, budget ref, chargeback tag (§17)
  tracing: TraceContext;                        // traceId, spanId, parentSpanId (§12) — REQUIRED
  cancellation?: CancellationToken;             // cooperative cancel (signal id)

  metadata?: Record<string, JsonValue>;         // free-form, never interpreted by the core
}

/** §2.1 — Parts: the extensibility primitive. New modality = new kind. */
type Part =
  | TextPart | JsonPart | ImagePart | AudioPart | VideoPart | DocumentPart
  | ToolCallPart | ToolResultPart | CitationPart | ReasoningPart
  | EmbeddingPart | BinaryPart | { kind: string; [k: string]: JsonValue }; // open variant → future kinds

interface PartBase { kind: string; role?: "system"|"developer"|"user"|"assistant"|"tool"; id?: string; }
interface TextPart      extends PartBase { kind: "text"; text: string; language?: string; }
interface JsonPart      extends PartBase { kind: "json"; json: JsonValue; schemaRef?: string; }
interface ImagePart     extends PartBase { kind: "image"; ref: MediaRef; detail?: "low"|"high"; }
interface AudioPart     extends PartBase { kind: "audio"; ref: MediaRef; durationMs?: number; }
interface VideoPart     extends PartBase { kind: "video"; ref: MediaRef; durationMs?: number; }
interface DocumentPart  extends PartBase { kind: "document"; ref: MediaRef; mime: string; pages?: number; }
interface ToolCallPart  extends PartBase { kind: "tool_call"; toolCallId: string; name: string; arguments: JsonValue; }
interface ToolResultPart extends PartBase{ kind: "tool_result"; toolCallId: string; result: JsonValue; error?: ErrorInfo; }
interface CitationPart  extends PartBase { kind: "citation"; sourceId: string; span?: [number,number]; score?: number; }
interface ReasoningPart extends PartBase { kind: "reasoning"; text?: string; redacted?: boolean; }
interface EmbeddingPart extends PartBase { kind: "embedding"; vector?: number[]; dims?: number; ref?: string; }
```
**Design notes.** `input` being `Part[]` is what makes vision/audio/video/documents/tool-turns first-class *without a new contract*. `tracing` is **required** so no invocation escapes the execution tree. `routing` is a *hint*: governance (§9) and negotiation (§5) may override or reject it — callers can never force an unapproved provider.

---

## §3. AI Response Contract

```ts
interface AIResponse {
  readonly contractVersion: "2.0";
  readonly requestId: string;
  status: "succeeded" | "failed" | "partial" | "blocked" | "scheduled" | "cancelled";

  output: Part[];                     // same Part union as input → symmetric, multimodal
  artifacts?: Artifact[];             // durable produced objects (files, reports) by reference
  toolCalls?: ToolCallPart[];         // when the model requests tool execution (agent loop, §14)
  structured?: JsonValue;             // when capability declares an output schema (validated §7/§11)

  events?: DomainEventDraft[];        // business events the capability wants emitted (§11-events)
  warnings?: Warning[];               // non-fatal (truncation, low-confidence, fallback used)
  confidence?: number;                // 0..1 when the capability produces a graded result
  safety?: SafetyReport;              // input/output verdicts, redactions, blocked reasons (§11)

  usage: Usage;                       // tokens/audio-sec/images/tool-invocations per modality
  cost: CostReport;                   // estimated (pre) + actual (post), currency, owner (§17)
  timing: TimingReport;               // queuedMs, latencyMs, ttfbMs (stream), providerMs

  resolution: ResolutionReport;       // which provider/model/prompt-version/profile/policies ran
  providerMetadata?: Record<string, JsonValue>; // opaque passthrough (never interpreted)
  execution: ExecutionReport;         // retries, failover chain used, steps, child requestIds (§12)

  error?: ErrorInfo;                  // typed, code-based (never provider-raw)
  stream?: StreamHandle;              // present when streaming; see §3.1
}

/** §3.1 — Streaming is the SAME contract, delivered incrementally. */
type AIStreamEvent =
  | { type: "start"; requestId: string; resolution: ResolutionReport }
  | { type: "delta"; part: Partial<Part>; index: number }     // token/audio/frame chunk
  | { type: "tool_call"; call: ToolCallPart }
  | { type: "step"; step: StepReport }                          // agent/multi-step progress
  | { type: "warning"; warning: Warning }
  | { type: "usage"; usage: Usage }
  | { type: "final"; response: AIResponse }                     // terminal, full response
  | { type: "error"; error: ErrorInfo };
```
**Design notes.** A streamed run and a buffered run return the **same `AIResponse`** shape (streaming just emits `AIStreamEvent`s culminating in `{type:"final"}`). `resolution` + `execution` make every run fully explainable/auditable. `error` is always a platform-typed `ErrorInfo`, never a provider's raw error (provider isolation, §5).

---

## §4. Capability Contract

The single most important separation in v2: **Contract (code, immutable) vs Configuration (DB, governed).**

```ts
/** IMMUTABLE, code-owned. Defines what the capability IS and what it NEEDS. */
interface CapabilityContract {
  readonly key: string;                       // e.g. "meeting_intelligence"
  readonly version: string;                   // contract semver; multiple may be active
  name: string; description: string; category: string;
  businessOwner: string;                      // accountable team/person

  inputSchema: SchemaRef;                     // JSON-Schema for allowed input parts/variables
  outputSchema?: SchemaRef;                   // JSON-Schema for structured output (enables validation §11)
  inputModalities: Modality[];                // ["text"] | ["text","audio"] | ...
  outputModality: Modality | "multi";

  executionClass: "sync" | "async" | "streaming" | "batch";
  requires: ProviderRequirement;             // {json?, tools?, vision?, audio?, streaming?, minContextTokens?, reasoning?}
  dependsOn?: string[];                        // capabilities this one may invoke (agents/composition)

  businessCriticality: "experimental"|"standard"|"important"|"critical";
  priorityClass: "low"|"normal"|"high"|"realtime";
  expectedLatency: "instant"|"fast"|"normal"|"slow"|"batch";
  expectedCostClass: "trivial"|"low"|"medium"|"high";
  defaultRetryPolicy: RetryPolicyRef;
  dataSensitivity: "public"|"internal"|"confidential"|"restricted"; // drives safety/compliance defaults
  lifecycle: "experimental"|"ga"|"deprecated"|"retired";
  requiredPermissions: PermissionRequirement; // who may invoke (§9)
}

/** MUTABLE, DB-owned, governed & inheritable. Defines HOW it runs HERE. */
interface CapabilityConfiguration {
  capabilityKey: string;
  scope: ConfigScope;                          // PLATFORM default | workspace override
  enabled: boolean;
  provider?: string; model?: string;           // resolved subject to negotiation (§5)
  promptKey?: string;                          // structured prompt (§7)
  runtimeProfile?: string;                     // sampling (§8)
  policySet?: PolicySetRef;                     // execution/reasoning/perf/cost/safety (§8)
  keyOwnership?: KeyOwnershipRef;               // platform vs BYO (§10)
  failover?: FailoverChain;                     // ordered provider/model fallbacks (§5, §18)
  lock: LockLevel;                              // inheritance constraint (§9)
}
```
**Design notes.** A business module references a capability by **key**; it never sees configuration. Because `requires` is declared on the contract, the platform can *guarantee* (via §5 negotiation) that whatever provider config an admin picks can actually satisfy the capability — or refuse the config at write-time. Two contract versions can run side-by-side (safe capability evolution).

---

## §5. Provider Contract

```ts
interface ProviderPort {
  readonly key: string;                        // "openai", "anthropic", "bedrock", future
  describe(): ProviderDescriptor;              // static self-description (capabilities, auth style, modalities)
  listModels(): Promise<ModelDescriptor[]>;    // dynamic model discovery (§6)
  negotiate(req: ResolvedRequirement): Negotiation; // CAN I satisfy this? → {ok, model, gaps[]}
  invoke(call: ProviderCall): Promise<ProviderResult>;      // buffered
  stream?(call: ProviderCall): AsyncIterable<ProviderStreamEvent>; // if supported
  estimateCost(call: ProviderCall): CostEstimate;           // pre-execution (§17)
  health(): Promise<ProviderHealth>;           // liveness, latency, error/ratelimit posture (§18)
  rateLimits(): RateLimitDescriptor;           // declared limits for scheduler (§13)
}

interface ProviderDescriptor {
  displayName: string;
  adapterProtocol: string;                     // "openai_chat" | "anthropic_messages" | "gemini" | ...
  supports: {
    modalitiesIn: Modality[]; modalitiesOut: Modality[];
    json: boolean; tools: boolean; streaming: boolean; embeddings: boolean;
    reasoning: boolean; vision: boolean; audio: boolean; batch: boolean;
  };
  authStyle: "bearer"|"api_key_header"|"sigv4"|"oauth"|"none";
  regions?: string[];                          // data-residency (§ compliance)
}
```
**Design notes.** `negotiate()` is the antidote to silent mis-routing (gate Critical #2): resolution asks each candidate provider whether it can meet the capability's `requires`; a provider that can't is skipped or the config is rejected. `describe()`/`listModels()` make **provider & model capabilities discoverable**. **No provider-specific type escapes this port** — the core sees only `ProviderCall`/`ProviderResult` (part-based), never a vendor payload.

---

## §6. Model Contract

```ts
interface ModelDescriptor {
  readonly providerKey: string;
  readonly key: string;                        // "claude-sonnet-5", "gpt-...", provider-native id
  aliasOf?: string;                            // stable alias → underlying versioned model (deprecation safety)
  displayName: string; family?: string;
  contextWindowTokens: number; maxOutputTokens?: number;
  modalitiesIn: Modality[]; modalitiesOut: Modality[];
  supports: { json: boolean; tools: boolean; streaming: boolean; reasoning: boolean; vision: boolean; audio: boolean; embeddings: boolean; };
  latencyClass: "instant"|"fast"|"normal"|"slow";
  costClass: "trivial"|"low"|"medium"|"high";
  pricing?: ModelPricing;                      // input/output/other per-unit → cost engine (§17)
  lifecycle: "preview"|"ga"|"deprecated"|"retired";
  availability: "available"|"limited"|"unavailable";
  knowledgeCutoff?: string;
}
```
**Design notes.** `aliasOf` decouples capability config ("use the fast Claude") from provider churn (the underlying dated model changes) — deprecations become alias remaps, not config edits everywhere. `pricing` + `supports` are the data the resolver and cost engine consume; they are **discovered**, not hardcoded.

---

## §7. Prompt Contract

```ts
interface PromptDefinition {
  readonly key: string; category: string; feature: string; owner: string;
  lock: LockLevel;
}
interface PromptVersion {
  promptKey: string; version: number;
  status: "draft"|"testing"|"published"|"archived";

  system?: PromptSegment;                      // platform/system instructions (trusted)
  developer?: PromptSegment;                   // capability-author instructions (trusted)
  userTemplate: PromptSegment;                 // user-facing template (variables interpolated SAFELY, §11)
  fewShot?: Example[];                         // structured examples (input parts → output parts)

  variables: VariableSpec[];                   // name, type, required, schema, source, injectionClass
  inputSchemaRef?: SchemaRef; outputSchemaRef?: SchemaRef;
  safety?: PromptSafetyRules;                  // allow/deny, redaction, jailbreak guards (§11)
  modelHints?: ModelHint[];                    // tuned-for models; resolver warns on mismatch

  metadata: PromptMeta;                        // createdBy/updatedBy/approvedBy/notes/timestamps
  analytics?: PromptAnalyticsRef;              // win-rate, failure-rate, cost/latency by version (§18)
}
```
**Design notes.** Prompts are **structured**, with explicit trust boundaries: `system`/`developer` are trusted; `userTemplate` variables carry an `injectionClass` and are **escaped/segmented** by the safety layer (gate Critical #5), never naively concatenated. `outputSchemaRef` enables deterministic output validation. Versioning/approval/rollback/testing/comparison are first-class states, and **analytics per version** enable A/B and health (§18). Resolution order is unchanged and non-regressive: **workspace override → platform published → code fallback → caller-verbatim**.

---

## §8. Runtime Contract (six independent axes)

Runtime is **not one profile**. It is one sampling profile plus five orthogonal policy types, each independently governed, inheritable, and lockable.

```ts
interface RuntimeDirective { profile?: string; policySet?: PolicySetRef; overrides?: RuntimeOverrides; }

interface RuntimeProfile   { key: string; params: SamplingParams; }             // temperature/topP/topK/maxTokens/json...
interface ExecutionPolicy  { mode: "sync"|"async"|"stream"|"batch"; timeoutMs: number; maxSteps?: number; concurrency?: number; }
interface ReasoningPolicy  { effort: "none"|"low"|"medium"|"high"; verbosity?: "terse"|"normal"|"detailed"; toolBudget?: number; maxToolLoops?: number; }
interface PerformancePolicy{ latencySloMs?: number; failover: "off"|"model"|"provider"|"both"; cacheTtlSeconds?: number; }
interface CostPolicy       { maxCostPerCall?: Money; modelTierCeiling?: CostClass; budgetRef?: string; }
interface SafetyPolicy     { injectionDefense: "off"|"standard"|"strict"; piiRedaction: PiiMode; contentFilters: FilterSet; toolAllowlist?: string[]; }

interface PolicySet { key: string; execution: ExecutionPolicy; reasoning?: ReasoningPolicy; performance?: PerformancePolicy; cost?: CostPolicy; safety: SafetyPolicy; }
```
**Design notes.** Separating these lets an enterprise say "high reasoning **and** low cost ceiling **and** strict safety **and** async" independently — impossible with one profile enum. Each axis is a governed object (§9) with its own lock.

---

## §9. Governance Contract

Replaces the single `lockLevel` with a full **object × verb × role × scope** matrix; lock/inheritance become *constraints layered on top*.

```ts
type GovernedObjectType = "provider"|"model"|"prompt"|"prompt_version"|"profile"|"policy_set"
  |"capability_config"|"key_ownership"|"budget"|"tool"|"memory_scope"|"retriever";
type Verb = "view"|"edit"|"override"|"test"|"publish"|"rollback"|"approve"|"clone"|"export"|"import"|"reset"|"lock"|"delegate";
type Role = "superadmin"|"platform_operator"|"workspace_admin"|"workspace_editor"|"workspace_viewer"|"delegated";
type Scope = "PLATFORM" | { workspaceId: string };

interface Grant { role: Role|{ delegatedTo: ActorRef }; object: GovernedObjectType; objectKey?: string; verbs: Verb[]; scope: Scope; conditions?: PolicyCondition[]; }

interface LockConstraint { objectType: GovernedObjectType; objectKey: string; level: LockLevel; scope: Scope; }
type LockLevel = "global_locked"        // platform value wins; no workspace override
               | "workspace_customizable"
               | "workspace_locked";     // a specific workspace pinned by platform

interface ApprovalRule { objectType: GovernedObjectType; requiredVerb: "publish"|"override"; approvers: ApproverSpec; separationOfDuties: boolean; } // author ≠ approver
```
**Design notes.** This expresses "workspace admin may **test** but not **publish** a prompt," "may **override** model but not **provider**," delegation, and separation-of-duties — none possible under the single enum (gate). **Resolution enforces locks; APIs enforce grants** (defense in depth). Every change is audited (§12). Tenant scoping (`scope`) is mandatory on every governed object, closing gate Critical #6's isolation gap.

---

## §10. Key Ownership Contract

```ts
interface KeyOwnership {
  scope: Scope;                                // PLATFORM or workspace
  provider: string;
  mode: "platform_managed" | "workspace_byo";  // who supplies the key
  keyRef: KeyRef;                              // INDIRECTION — never the secret itself
  billingOwner: "platform" | "workspace";      // who PAYS for usage on this key
  costOwner: Scope;                            // who the spend is attributed to (chargeback, §17)
  rotation?: { policy: "manual"|"scheduled"; intervalDays?: number; lastRotatedAt?: string; };
  status: "active"|"disabled"|"expired"|"invalid";
}
interface KeyRef { manager: "env"|"aws_secrets"|"gcp_secret_manager"|"vault"|"kms"; ref: string; version?: string; } // resolved ONLY inside adapters
```
**Design notes.** Directly closes gate Critical #4. A workspace can **BYO key** (its own OpenAI account, its own bill) or use a **platform-managed** key with `billingOwner:"workspace"` for chargeback. Secrets are always **references** resolved inside adapters via a secret manager — never stored in DB/config/env-as-final-home, never returned, never logged. `failover` (§5) may reference multiple ownerships (e.g., platform key as backup to BYO).

---

## §11. Safety Contract

A mandatory pipeline every invocation traverses (input side and output side).

```ts
interface SafetyPipeline {
  input: [
    "classify_sensitivity",        // derive dataSensitivity if unset
    "detect_pii",                  // find + tag PII spans
    "prompt_injection_scan",       // untrusted parts vs trusted system/developer
    "variable_isolation",          // escape/segment user variables (no instruction bleed)
    "policy_gate"                  // tool allowlist, provider allowlist, residency
  ];
  output: [
    "schema_validate",             // structured output vs outputSchema (§7)
    "content_safety_filter",       // toxicity/unsafe categories
    "pii_redaction",               // per compliance mode
    "citation_grounding_check",    // RAG answers cite allowed sources (§16)
    "tool_result_sanitization"     // untrusted tool output cannot inject next turn
  ];
}
interface SafetyReport { inputVerdict: Verdict; outputVerdict: Verdict; redactions: Redaction[]; blocked?: { stage: string; reason: string }; }
interface ComplianceDirective { residency?: string[]; retention?: RetentionSpec; legalHold?: boolean; redactionMode: PiiMode; auditRequired?: boolean; }
```
**Design notes.** Closes gate Critical #5. The core insight: **trust boundaries are explicit** — `system`/`developer` prompt segments are trusted; everything in `input`, `variables`, `retrieval` results, and `tool_result` is **untrusted** and isolated before it can influence instructions. Output is validated against the capability's schema and grounded against allowed sources. Safety **fails closed** in `enforced` mode (§1.5).

---

## §12. Observability Contract

```ts
interface TraceContext { traceId: string; spanId: string; parentSpanId?: string; baggage?: Record<string,string>; } // W3C-style
interface ExecutionContext { rootRequestId?: string; parentRequestId?: string; workflowId?: string; stepId?: string; userJourneyId?: string; }
interface ExecutionReport {
  retries: number; failoverPath?: FailoverHop[]; steps?: StepReport[];
  childRequestIds?: string[];            // execution TREE (agents, composition, multi-pass)
  sourceModule: string;                  // which business module invoked it
  trigger?: Trigger;                     // the business event (§11-events)
}
interface Trigger { eventType: string; entityRef?: EntityRef; occurredAt: string; } // "meeting.ended", "task.completed", "dashboard.opened"
```
**Design notes.** Closes gate Critical (#10/#11 Important). `traceId`+`parentSpanId` make an agent's fan-out a **single traceable tree**; `sourceModule`+`trigger` answer *why* an AI request exists (cost attribution, debugging, the adaptive loop). This binds the AI platform to the product's existing event bus without coupling to it.

---

## §13. Scheduling Contract

```ts
interface SchedulingDirective {
  mode: "immediate"|"background"|"queued"|"deferred"|"recurring";
  runAt?: string; cron?: string;               // deferred / recurring
  priority: "low"|"normal"|"high"|"realtime";
  concurrencyKey?: string;                     // serialize per key (e.g. per workspace)
  maxConcurrency?: number;
  retry?: RetryPolicy;                          // attempts, backoff, retryOn[]
  deadLetter?: { enabled: boolean; sink?: string };
  timeoutMs?: number;
  dedupeWindowSeconds?: number;                 // with idempotencyKey
}
interface RetryPolicy { maxAttempts: number; backoff: "fixed"|"exponential"; baseMs: number; retryOn: ErrorClass[]; idempotentOnly: boolean; }
```
**Design notes.** Long/multi-step/agent work becomes **queued jobs** with priority, concurrency control, DLQ, and **idempotency-aware** retry (no double-bill). Sync stays sync. Cancellation (`AIRequest.cancellation`) is cooperative across queue + provider stream.

---

## §14. Tool Contract

```ts
interface ToolDefinition {
  readonly key: string; name: string; description: string;
  inputSchema: SchemaRef; outputSchema: SchemaRef;
  sideEffects: "none"|"read"|"write"|"external";
  requiredPermissions: PermissionRequirement;  // governed (§9)
  safetyClass: "safe"|"guarded"|"dangerous";   // drives approval/allowlist
  idempotent: boolean; timeoutMs?: number;
  scope: Scope;                                 // platform tool vs workspace tool
}
interface ToolPort { describe(): ToolDefinition; invoke(call: ToolInvocation, ctx: ToolContext): Promise<ToolOutcome>; }
interface ToolDirective { allow?: string[]; deny?: string[]; mode: "off"|"auto"|"required"; maxLoops?: number; approval?: "none"|"human_in_loop"; }
```
**Design notes.** Tools are governed, permissioned, schema-typed, and safety-classed. Agent loops run under `ExecutionPolicy.maxSteps`/`ToolDirective.maxLoops`. `sideEffects`/`safetyClass` + `approval:"human_in_loop"` make destructive actions gated. Tool results re-enter as untrusted `tool_result` parts (§11).

---

## §15. Memory Contract

```ts
type MemoryKind = "working"|"episodic"|"semantic"|"profile"|"summary"; // conversation | events | facts | entity-prefs | rollups
interface MemoryScope { kind: MemoryKind; scope: Scope; subjectRef?: EntityRef; retention: RetentionSpec; isolation: "workspace"|"user"|"capability"; }
interface MemoryPort {
  read(q: MemoryQuery, ctx: TenantContext): Promise<MemoryRecord[]>;
  write(rec: MemoryWrite, ctx: TenantContext): Promise<void>;
  forget(sel: MemorySelector, ctx: TenantContext): Promise<void>; // GDPR / retention
}
interface MemoryDirective { read?: MemoryScope[]; write?: MemoryWriteSpec[]; }
```
**Design notes.** Memory is a **port with tenant-scoped isolation and retention/forget** (GDPR-aligned). Capabilities opt in via `AIRequest.memory`. No global mutable memory; every record is workspace/user/capability-scoped. This is the interface agents/personalization will build on — designed now so it never forces a contract break.

---

## §16. Retrieval Contract

```ts
interface RetrieverPort {
  describe(): RetrieverDescriptor;             // sources, modalities, filters
  retrieve(q: RetrievalQuery, ctx: TenantContext): Promise<RetrievedChunk[]>;
}
interface RetrievalDirective { sources: string[]; topK?: number; filters?: JsonValue; rerank?: boolean; minScore?: number; citationsRequired?: boolean; }
interface RetrievedChunk { sourceId: string; text?: string; parts?: Part[]; score: number; metadata: JsonValue; } // becomes untrusted input + citations
```
**Design notes.** RAG is a first-class, tenant-scoped port. Retrieved content enters as **untrusted parts** (safety §11) and produces `CitationPart`s; output grounding is verified. Sources (wiki, tasks, meeting digests, external) are configured/governed like any other object.

---

## §17. Cost Contract

```ts
interface CostEngine {
  estimate(req: ResolvedRequest): CostEstimate;   // BEFORE execution (token/modality estimate × pricing)
  record(res: AIResponse): CostActual;            // AFTER execution
  budgetCheck(scope: Scope, estimate: CostEstimate): BudgetDecision; // fail-CLOSED when enforced
  forecast(scope: Scope, horizon: string): CostForecast;
  chargeback(scope: Scope, period: Period): ChargebackReport;
}
interface Budget { scope: Scope; period: "daily"|"monthly"; limit: Money; hardLimit: boolean; alertThresholds: number[]; costOwner: Scope; }
interface CostReport { estimated: Money; actual?: Money; currency: string; owner: Scope; pricingSource: string; }
```
**Design notes.** Closes gate Critical #7. **Cost is estimated pre-execution** from discovered model `pricing` (§6) and enforced against budgets **before** spend (`budgetCheck` fails closed when `hardLimit`). Actuals recorded post-run enable forecasts, per-workspace/feature ROI, and **chargeback** to the `costOwner` (works with BYO vs platform keys, §10).

---

## §18. Health Contract

```ts
interface HealthContract {
  provider(key: string): ProviderHealth;   // success%, p50/p95, error taxonomy, ratelimit hits, availability
  model(providerKey: string, key: string): ModelHealth; // deprecation, drift, cost/1k trend, availability
  capability(key: string): CapabilityHealth; // volume, failure%, budget burn, prompt-version win-rate, SLO attainment
  prompt(key: string, version: number): PromptHealth;   // win/failure/latency/cost by version
  cost(scope: Scope): CostHealth;           // spend vs budget, throttle events, forecast variance
  platform(): PlatformHealth;               // aggregate SLOs, incidents, queue depth, DLQ size, alerts
}
```
**Design notes.** Health is a **contract**, not a page — the AI Studio and AI Health dashboard (future) are consumers. Fed by §12 telemetry + provider `health()`; drives §5/§18 failover and kill-switches.

---

## §19. Migration Strategy (compatibility, non-regressive)

1. **Compatibility adapter (v1→v2):** the existing `generateText({prompt}) → string` becomes a thin shim that constructs an `AIRequest` (`input:[TextPart]`, `capability:"legacy.generate_text"`) and unwraps `AIResponse.output[0].text`. Legacy callers are byte-compatible; the Phase 1 feature flag still governs on/off.
2. **Dual contract period:** v1 shim and v2 `invoke()` coexist. New/migrated capabilities call `invoke()` directly.
3. **Per-capability cutover:** migrate one capability at a time, each behind the canary flag, each with an **output-parity test** vs its legacy behavior before flip.
4. **Provider adapters upgraded to the Port (§5):** existing text adapters gain `describe()/negotiate()/health()`; behavior unchanged for text.
5. **Governance/cost/safety enter in `permissive` mode first** (observe, don't block), then switch to `enforced` per §1.5 once validated.
6. **Rollback:** flag off (global/canary); v2 objects are additive; dropping them reverts to v1 shim; no destructive change to existing tables.
7. **Legacy removal LAST:** only after every capability is migrated and regression-signed-off.

**Non-negotiable:** no big-bang; every step compiles, deploys, preserves behavior, and is reversible.

---

## §20. Final Architecture Gate (self-review)

**Re-testing Contract v2 against the eight Criticals and the ten non-negotiable principles:**

| Requirement | Met? | Evidence |
|---|---|---|
| Adding providers/models never breaks contract | ✅ | §1.4 additive-only; §5 port; §6 discovery/alias |
| Vision/audio/video/docs without breaking | ✅ | §2.1 Part union (open variant) |
| Tools/agents/memory/retrieval/planning without breaking | ✅ | §14/§15/§16 ports; §13 steps; §4 `dependsOn` |
| Streaming/embeddings/classification/search | ✅ | §3.1 stream events; `EmbeddingPart`; capability `executionClass` |
| One execution contract for every capability | ✅ | §2/§3 uniform envelope |
| No provider logic leaks outside adapters | ✅ | §5 port; typed `ErrorInfo`; opaque `providerMetadata` |
| Fully multi-tenant | ✅ | §1.5 invariant; `scope` on every governed object |
| Superadmin governance + workspace overrides + locking/inheritance | ✅ | §9 matrix + §4 config scope + LockLevel |
| Per-workspace keys / who-pays | ✅ | §10 KeyOwnership (mode + billingOwner + costOwner) |
| Provider/model capability discovery (no mis-route) | ✅ | §5 `negotiate()` + §4 `requires` |
| Prompt injection + output validation | ✅ | §11 pipeline + trust boundaries + §7 schemas |
| Tenant isolation of AI config/logs + fail-closed | ✅ | §9 scope + §1.5 enforced mode |
| Cost estimated **before** execution; budgets enforceable | ✅ | §17 `estimate()`/`budgetCheck()` fail-closed |
| Backward compatible / no regressions / compat adapters | ✅ | §19 v1 shim + flag + per-capability parity |

**Residual risks (Important, not Critical — do NOT block the gate; schedule during implementation):**
- Concrete JSON-Schema definitions for each capability's I/O (`SchemaRef` targets) — authored per capability during migration.
- External HTTP/SSE facade for Flutter/Electron/integrations — a *transport* over this contract; specified as a delivery concern, not a contract change.
- Semantic cache design and DLQ sink selection — implementation choices within §13/§8 `cacheTtl`.
- W3C trace-context propagation into the existing event bus — an integration detail of §12.

None of the residuals require a contract change (they are populated *within* existing extension points), which is itself the proof that the contract is stable.

### VERDICT: **APPROVED**

All eight Critical findings are resolved **structurally** (by shape, not by patch), and every non-negotiable principle is satisfied with an additive-only evolution path. Implementation can now proceed **mechanically**, capability-by-capability, under §19 — starting, when Phase 2 is authorized, with `meeting_intelligence` on the canary flag against an output-parity test.

---

### Appendix — Shared type stubs (design notation only)
```ts
type JsonValue = null|boolean|number|string|JsonValue[]|{[k:string]:JsonValue};
type Modality = "text"|"image"|"audio"|"video"|"document"|"embedding"|string; // open
interface MediaRef { store: "inline"|"blob"|"s3"|"r2"|"url"; ref: string; mime?: string; bytes?: number; }
interface Money { amount: number; currency: string; }
interface ErrorInfo { code: string; class: ErrorClass; message: string; retryable: boolean; providerCode?: string; }
type ErrorClass = "validation"|"auth"|"permission"|"policy_blocked"|"budget_exceeded"|"safety_blocked"|"provider_unavailable"|"rate_limited"|"timeout"|"internal";
interface Usage { inputTokens?: number; outputTokens?: number; audioSeconds?: number; images?: number; toolCalls?: number; }
type SchemaRef = { ref: string; version?: string };  // points to a registered JSON-Schema
type PiiMode = "off"|"tag"|"redact"|"block";
```

*End of Contract v2. This is a design/specification document only. No code, schema, API, or UI was created or modified. Phase 2 is not started.*
