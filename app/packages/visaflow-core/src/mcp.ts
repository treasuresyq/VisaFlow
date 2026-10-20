#!/usr/bin/env bun
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { VisaFlowService } from './service.ts'
import { selectRulePack } from './rules.ts'

const configuredPath = process.env.VISAFLOW_DATA_DIR
if (!configuredPath) throw new Error('VISAFLOW_DATA_DIR must name the existing VisaFlow data directory')
const pinnedCase = process.env.VISAFLOW_CASE_ID
const service = new VisaFlowService({ dataDir: resolve(configuredPath), recoverOnStart: false })
const server = new McpServer({ name: 'visaflow-tools', version: '0.1.0' })
const scoped = (caseId: string): string => {
  if (pinnedCase && caseId !== pinnedCase) throw new Error('Tool Context 禁止访问其他案件')
  service.getCase(caseId)
  return caseId
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const execute = (fn: () => unknown) => {
  try { return result(fn()) }
  catch (error) { return { ...result({ error: error instanceof Error ? error.message : String(error) }), isError: true } }
}
const readOnly = { readOnlyHint: true, destructiveHint: false }

server.registerTool('list_cases', {
  description: 'List available VisaFlow demo cases. A pinned Tool Context can see only its current case.',
  inputSchema: {}, annotations: readOnly,
}, () => execute(() => service.listCases().filter(value => !pinnedCase || value.id === pinnedCase)))

server.registerTool('get_rule_pack', {
  description: 'Resolve the fictional demo Rule Pack by the current case visa type and planned submission date. Do not present it as actual immigration policy.',
  inputSchema: { caseId: z.string() }, annotations: readOnly,
}, ({ caseId }) => execute(() => {
  const value = service.getCase(scoped(caseId))
  return selectRulePack(value.visaType, value.submissionDate)
}))

server.registerTool('list_materials', {
  description: 'Read material fields, PDF/OCR recognition status and SHA256 references within the current case. Only human-confirmed PDF/OCR fields may enter rule verification; pending, failed or missing fields are not verified facts. Human field confirmation remains in the desktop interface.',
  inputSchema: { caseId: z.string() }, annotations: readOnly,
}, ({ caseId }) => execute(() => service.getCase(scoped(caseId)).materials))

server.registerTool('read_evidence', {
  description: 'Read an original evidence slice using its stored reference. Offset/limit keeps large tool results out of the model context.',
  inputSchema: { caseId: z.string(), evidenceId: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(8000).optional() }, annotations: readOnly,
}, ({ caseId, evidenceId, offset = 0, limit = 4000 }) => execute(() => {
  const evidence = service.getCase(scoped(caseId)).evidence.find(value => value.id === evidenceId)
  if (!evidence) throw new Error('Evidence does not belong to the current case')
  return { ...evidence, excerpt: evidence.excerpt.slice(offset, offset + limit), offset, totalCharacters: evidence.excerpt.length, hasMore: offset + limit < evidence.excerpt.length }
}))

server.registerTool('run_material_review', {
  description: 'EXECUTE a material review for the current case: check document coverage, dates, applicant names and passport numbers, and persist the resulting task and findings. Use for a first review, changed materials, or an explicitly requested retry/recheck. Example: "I uploaded new materials; check whether they meet the rules." Do NOT use merely to view or explain an existing report: use get_review_result for that. An active task is reused; otherwise this call creates a new review task and can invalidate a pending notice. Returns taskId, task state, case status and checks; execution completed does not mean all checks passed. Does not approve notices, contact customers or submit any visa application.',
  inputSchema: { caseId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, ({ caseId }) => execute(() => {
  const accepted = service.startReview(scoped(caseId))
  service.runReview(accepted.taskId)
  const value = service.getCase(caseId)
  return { ...accepted, status: value.status, task: value.tasks.find(task => task.id === accepted.taskId), checks: value.checks }
}))

server.registerTool('get_review_result', {
  description: 'READ the saved review result for the current case without starting or rerunning a review. Use to view findings, explain an existing issue, or check progress. Example: "The review is finished; why was my bank statement flagged?" Returns reviewState, nextAction, taskId, case status, checks and short evidence cards. If reviewState is not_reviewed, there is no current report: use run_material_review when review is requested. If in_progress, wait for the existing task; if failed, explain the failure and retry only when requested. Empty checks in these states do NOT mean materials passed. A completed review may still contain failed or needs-review checks. Use read_evidence for original data; never invent missing fields.',
  inputSchema: { caseId: z.string() }, annotations: { ...readOnly, idempotentHint: true },
}, ({ caseId }) => execute(() => {
  const value = service.getCase(scoped(caseId))
  const task = value.tasks.find(item => item.id === value.latestTaskId)
  const reviewState = !task ? 'not_reviewed'
    : task.status === 'completed' ? 'completed'
    : task.status === 'failed' ? 'failed' : 'in_progress'
  const nextAction = reviewState === 'not_reviewed' ? 'run_material_review'
    : reviewState === 'in_progress' ? 'wait_for_review'
    : reviewState === 'failed' ? 'retry_review' : null
  const message = {
    not_reviewed: '当前材料尚未完成核验，空检查列表不表示通过；需要核验时调用执行工具。',
    in_progress: '核验任务尚未结束，请等待已有任务；此时没有最终核验结论。',
    failed: '上一轮核验执行失败，不能将其当作通过；用户要求重试时再执行核验。',
    completed: '读取的是已有报告；核验完成不代表全部通过，请逐项查看检查结果与证据。',
  }[reviewState]
  const checks = reviewState === 'completed' ? value.checks : []
  const needed = new Set(checks.flatMap(check => check.evidenceIds))
  return {
    caseId, status: value.status, rulePackId: value.rulePackId,
    reviewState, nextAction, taskId: task?.id ?? null, message, checks,
    evidence: value.evidence.filter(item => needed.has(item.id)).map(item => ({ ...item, excerpt: item.excerpt.slice(0, 500) })),
  }
}))

server.registerTool('request_correction_notice', {
  description: 'Freeze a correction notice and create a persisted pending approval. The model cannot approve it. A human must approve in the VisaFlow UI. Delivery is local-demo-only.',
  inputSchema: { caseId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ caseId }) => execute(() => service.requestNotice(scoped(caseId))))

// No approve or send tool is exposed to the Agent: permission cannot be self-granted.
process.on('SIGINT', () => { service.close(); process.exit(0) })
process.on('SIGTERM', () => { service.close(); process.exit(0) })
await server.connect(new StdioServerTransport())
