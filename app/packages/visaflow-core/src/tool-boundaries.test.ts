import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { VisaFlowService } from './service.ts'
import type { CaseDetail, CaseStatus, Evidence, ReviewCheck } from './types.ts'

type ReviewResult = {
  caseId: string
  status: CaseStatus
  rulePackId?: string
  reviewState: 'not_reviewed' | 'in_progress' | 'completed' | 'failed'
  nextAction: 'run_material_review' | 'wait_for_review' | 'retry_review' | null
  taskId: string | null
  checks: ReviewCheck[]
  evidence: Evidence[]
}

const persistedCounts = (value: CaseDetail) => ({
  tasks: value.tasks.length,
  traces: value.traces.length,
  approvals: value.approvals.length,
})

test('stdio result reads preserve queued work, completed reports and material invalidation', async () => {
  const tempPrefix = join(tmpdir(), 'visaflow-tool-boundaries-test-')
  const dataDir = mkdtempSync(tempPrefix)
  const observer = new VisaFlowService({ dataDir, autoRunTasks: false, recoverOnStart: false })
  const client = new Client({ name: 'visaflow-tool-boundaries-test', version: '0.1.0' })
  let transport: StdioClientTransport | undefined

  try {
    const target = observer.createCase({ applicantName: 'Review Boundary', visaType: 'demo-tourist', submissionDate: '2026-10-20' })
    const other = observer.createCase({ applicantName: 'Other Case', visaType: 'demo-tourist', submissionDate: '2026-10-20' })
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['run', fileURLToPath(new URL('./mcp.ts', import.meta.url))],
      env: { VISAFLOW_DATA_DIR: dataDir, VISAFLOW_CASE_ID: target.id },
    })
    await client.connect(transport)

    const readResult = async (): Promise<ReviewResult> => {
      const response = await client.callTool({ name: 'get_review_result', arguments: { caseId: target.id } })
      expect(response.isError).not.toBe(true)
      const block = (response.content as { type: string; text?: string }[]).find(value => value.type === 'text')
      expect(block?.text).toBeString()
      return JSON.parse(block!.text!) as ReviewResult
    }

    const freshSnapshot = observer.getCase(target.id)
    const fresh = await readResult()
    expect(fresh).toMatchObject({
      caseId: target.id, status: 'collecting', reviewState: 'not_reviewed',
      nextAction: 'run_material_review', taskId: null, checks: [], evidence: [],
    })
    expect(observer.getCase(target.id)).toEqual(freshSnapshot)
    expect(observer.getCase(target.id).tasks).toHaveLength(0)

    const wrongScope = await client.callTool({ name: 'get_review_result', arguments: { caseId: other.id } })
    expect(wrongScope.isError).toBe(true)
    expect(observer.getCase(other.id).tasks).toHaveLength(0)

    // Queue work after the MCP process connects: a read must neither recover nor execute it.
    const accepted = observer.startReview(target.id)
    const queuedSnapshot = observer.getCase(target.id)
    expect(queuedSnapshot.tasks).toHaveLength(1)
    expect(queuedSnapshot.tasks[0]!.status).toBe('queued')
    const queued = await readResult()
    expect(queued).toMatchObject({
      caseId: target.id, status: 'reviewing', reviewState: 'in_progress',
      nextAction: 'wait_for_review', taskId: accepted.taskId, checks: [], evidence: [],
    })
    expect(observer.getCase(target.id)).toEqual(queuedSnapshot)

    const runResponse = await client.callTool({ name: 'run_material_review', arguments: { caseId: target.id } })
    expect(runResponse.isError).not.toBe(true)
    const runBlock = (runResponse.content as { type: string; text?: string }[]).find(value => value.type === 'text')
    expect(runBlock?.text).toBeString()
    expect(JSON.parse(runBlock!.text!)).toMatchObject({ taskId: accepted.taskId, status: 'needs_correction' })

    const completedSnapshot = observer.getCase(target.id)
    expect(completedSnapshot.tasks).toHaveLength(1)
    expect(completedSnapshot.tasks[0]).toMatchObject({ id: accepted.taskId, status: 'completed' })
    const beforeCompletedReads = persistedCounts(completedSnapshot)
    const completed = await readResult()
    expect(completed).toMatchObject({
      caseId: target.id, status: 'needs_correction', reviewState: 'completed',
      nextAction: null, taskId: accepted.taskId, rulePackId: completedSnapshot.rulePackId,
    })
    expect(completed.checks).toEqual(completedSnapshot.checks)
    expect(completed.checks.filter(check => check.status === 'fail').map(check => check.code)).toEqual(
      expect.arrayContaining(['required:passport', 'required:bank_statement', 'required:application']),
    )
    expect(completed.evidence.length).toBeGreaterThan(0)
    const evidenceById = new Map(completed.evidence.map(item => [item.id, item]))
    for (const check of completed.checks) {
      expect(check.evidenceIds.length).toBeGreaterThan(0)
      for (const evidenceId of check.evidenceIds) expect(evidenceById.has(evidenceId)).toBe(true)
    }
    const referencedIds = new Set(completed.checks.flatMap(check => check.evidenceIds))
    for (const evidence of completed.evidence) {
      const stored = completedSnapshot.evidence.find(item => item.id === evidence.id)
      expect(stored).toBeDefined()
      expect(evidence).toEqual({ ...stored!, excerpt: stored!.excerpt.slice(0, 500) })
      expect(evidence.caseId).toBe(target.id)
      expect(referencedIds.has(evidence.id)).toBe(true)
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(await readResult()).toEqual(completed)
    expect(persistedCounts(observer.getCase(target.id))).toEqual(beforeCompletedReads)
    expect(observer.getCase(target.id)).toEqual(completedSnapshot)

    observer.addMaterial(target.id, {
      name: 'passport.json', mimeType: 'application/json',
      contentBase64: Buffer.from(JSON.stringify({
        documentType: 'passport', applicantName: target.applicantName,
        passportNumber: 'BOUNDARY123', expiryDate: '2028-10-20',
      })).toString('base64'),
    })
    const changedSnapshot = observer.getCase(target.id)
    expect(changedSnapshot.tasks).toHaveLength(1)
    expect(changedSnapshot.tasks[0]).toMatchObject({ id: accepted.taskId, status: 'completed' })
    expect(changedSnapshot.evidence.length).toBeGreaterThan(completedSnapshot.evidence.length)
    const invalidated = await readResult()
    expect(invalidated).toMatchObject({
      caseId: target.id, status: 'collecting', reviewState: 'not_reviewed',
      nextAction: 'run_material_review', taskId: null, checks: [], evidence: [],
    })
    expect(observer.getCase(target.id)).toEqual(changedSnapshot)
    expect(persistedCounts(observer.getCase(target.id))).toEqual(persistedCounts(changedSnapshot))
  } finally {
    try {
      await client.close()
      await transport?.close()
    } finally {
      observer.close()
      Bun.gc(true)
      const targetPath = resolve(dataDir)
      if (!targetPath.startsWith(resolve(tmpdir()) + sep) || !targetPath.startsWith(resolve(tempPrefix))) {
        throw new Error('Refusing to clean up outside the test temporary directory prefix')
      }
      rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
}, 15000)
