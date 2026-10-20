# VisaFlow domain workflow

This package implements VisaFlow's visa-material workflow. It stores cases, uploaded material bytes, extracted fields, review tasks, evidence references, approval checkpoints, frozen notices, local delivery receipts and audit events in SQLite. Rule verification and approval can run independently of a model connection.

## Demonstration boundaries

- The Rule Packs are **invented engineering fixtures**, not any country's visa rules. The selected policy depends on the planned submission date. The October fixture changes bank-statement recency from 30 to 14 days.
- JSON, TXT and Markdown parsing is implemented. Text PDFs use PDF.js; scanned PDF pages and PNG/JPG images use local Tesseract.js with installed English and simplified Chinese models. PDF/image fields require human confirmation before rule review. Each file is limited to 8 MB and each PDF to 8 pages.
- A approved notice goes to a **local SQLite outbox only**. There is no external email, customer contact or visa submission. This makes a visible, repeatable approval demonstration without sending messages to real people.
- Field/date/policy checks are deterministic tools. The VisaFlow Agent can inspect and explain the results using a configured model connection.

## Public API

`new VisaFlowService({ dataDir, onEvent })` is compatible with the Electron main process and the standalone server. `startReview(caseId)` persists the task and returns `{ accepted: true, taskId }` before the worker starts. Its events include `review_progress`, `review_complete`, `review_failed`, `case_updated` and `approval_updated`.

The UI can rehydrate with `getCase(caseId)` after reconnecting. A native RPC adapter can wrap the service without coupling the domain package to Electron.

The other calls are `listCases()`, `createCase(input)`, `addMaterial(caseId, input)`, `getRulePacks()`, `seedDemoCases()`, `requestNotice(caseId)`, `decideApproval(id, approved)`, `getRawMaterial(caseId, materialId)`, `getOutbox(caseId)` and `exportTrace(caseId)`.

For PDF/image upload, `addMaterial` persists the original bytes and returns a material with `recognition.status=queued`. A durable background worker advances through `running` to `needs_confirmation` or `failed`, emitting `material_progress`. Interrupted work resumes after restart. `getMaterialRecognition` returns scoped page previews, raw text, field-source coordinates and warnings. `confirmMaterialFields` creates a new confirmed material version and invalidates prior review results/pending notices; the original bytes, extracted fields and evidence remain available. `retryMaterialRecognition` queues a failed active material. These confirmation methods are available only through the business interface, not the Agent tools.

The OCR worker is a separate local process with a 180-second timeout, serialized per service and terminated when the service closes. No document bytes are uploaded to external OCR services. Missing/uncertain fields are shown for manual review; invalid passport MRZ check digits never supply inferred fields.

## VisaFlow Agent tools

`src/mcp.ts` exposes seven stdio MCP tools backed by the same SQLite database: `list_cases`, `get_rule_pack`, `list_materials`, `read_evidence`, `run_material_review`, `get_review_result`, and `request_correction_notice`. A source configuration example is in `docs/mcp-source-config.example.json`; configure its runtime, source and data paths. Set `VISAFLOW_CASE_ID` to bind a session's Tool Context to one case.

The Agent can inspect rules and evidence, execute deterministic review, and prepare a frozen pending notice. **It has no approval or delivery tool.** Human approval stays in the desktop domain workflow. Model-provider configuration is still required for conversational Agent execution, while the core dashboard and CLI work without it.

## Replay and verification

From this package directory:

```powershell
bun test src/service.test.ts src/mcp.test.ts
bun run src/cli.ts replay --data-dir C:\path\to\isolated-demo-data
bun run src/cli.ts cases --data-dir C:\path\to\isolated-demo-data
```

The four seeded cases cover normal materials, a missing document, expired documents and cross-document field conflicts. The replay verifies both outcomes and resolvable evidence references.

## Recovery and approval

Queued tasks survive a restart. Interrupted read-only checks can restart from their persisted material snapshot. Pending approvals survive independently of the model's in-memory permission callback. A pending notice is frozen with a content digest, task ID, tool-call ID and evidence checkpoint. Adding material invalidates pending approvals, so an outdated notice cannot be sent accidentally.

Approval uses a conditional update from `pending`; delivery uses a conditional update from `approved + not_sent`. The local outbox has a unique approval ID and is committed in the same transaction as the receipt and task state. Repeated approval cannot create a second local receipt. This property applies to the local demo channel; an eventual external channel would need idempotency or explicit handling of uncertain outcomes.

A corrected material supersedes the earlier active version of the same known document type. The old bytes and references remain available for historical tasks and audit; subsequent tasks use only active materials. A notice request reuses an existing pending/approved approval for the same review task, so repeating the prepare-and-approve sequence cannot produce another local receipt without a new review.

## Review execution versus report reads

`run_material_review` executes checks and can create a new review task. Use it for a first review, changed materials, or an explicitly requested retry/recheck. It is not declared idempotent: repeating it after a completed review creates a new task and may invalidate a pending notice.

`get_review_result` only reads saved state; it never starts, resumes or reruns checks. In addition to the existing case status, findings and evidence, it returns:

| reviewState | Meaning | nextAction |
| --- | --- | --- |
| `not_reviewed` | No current report; this includes invalidation after material changes | `run_material_review` |
| `in_progress` | The current task is queued or running | `wait_for_review` |
| `failed` | The current task failed | `retry_review` |
| `completed` | A saved report is available; its checks may still fail | `null` |

The response also includes the current `taskId` (or `null`) and a message explaining the state. Non-completed states return no final checks or report evidence. Empty findings before completion must not be treated as approval.

The real stdio test `src/tool-boundaries.test.ts` verifies that reads do not create or execute tasks, repeated completed reads preserve persisted data, and updated materials do not expose a stale report. These are tool-contract tests, not an evaluation of a model's tool-selection accuracy. Reconnect the MCP source to load changed tool descriptions in an existing Agent session.

