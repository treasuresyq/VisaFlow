import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { VisaFlowService } from './service.ts'
import { DEMO_FIXTURES } from './fixtures.ts'
import { addMonths, selectRulePack } from './rules.ts'
import type { VisaFlowEvent } from './types.ts'

const opened: VisaFlowService[] = []
const directories: string[] = []
function setup(autoRunTasks = false, onEvent?: (event: VisaFlowEvent) => void): { service: VisaFlowService; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'visaflow-test-'))
  const service = new VisaFlowService({ dataDir, autoRunTasks, onEvent })
  opened.push(service); directories.push(dataDir)
  return { service, dataDir }
}
function reopen(dataDir: string): VisaFlowService {
  const service = new VisaFlowService({ dataDir, autoRunTasks: false })
  opened.push(service); return service
}
function stop(service: VisaFlowService): void {
  service.close(); opened.splice(opened.indexOf(service), 1)
}
afterEach(() => {
  for (const service of opened.splice(0)) service.close()
  // Bun's node:sqlite shim releases transient statements on collection.
  // Without this Windows may retain a file handle after DatabaseSync.close().
  Bun.gc(true)
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('visaflow-test-')) throw new Error('Unexpected cleanup path')
    rmSync(target, { recursive: true, force: true })
  }
})
function completedFixture(service: VisaFlowService, key: string) {
  service.seedDemoCases()
  const summary = service.listCases().find(value => service.getCase(value.id).traces.some(event => event.data.fixture === key))!
  service.runReview(summary.latestTaskId!)
  return service.getCase(summary.id)
}

describe('VisaFlow deterministic review', () => {
  test('all four fixtures produce expected outcomes with resolvable evidence references', () => {
    const { service } = setup()
    service.seedDemoCases()
    for (const summary of service.listCases()) service.runReview(summary.latestTaskId!)
    const cases = service.listCases().map(value => service.getCase(value.id))
    expect(cases).toHaveLength(4)
    for (const fixture of DEMO_FIXTURES) {
      const detail = cases.find(value => value.traces.some(event => event.data.fixture === fixture.key))!
      expect(detail.status).toBe(fixture.expected)
      expect(detail.rulePackId).toBe('demo-tourist-2026-10')
      for (const check of detail.checks) {
        expect(check.evidenceIds.length).toBeGreaterThan(0)
        expect(check.evidenceIds.every(evidenceId => detail.evidence.some(evidence => evidence.id === evidenceId))).toBe(true)
      }
    }
    const expired = cases.find(value => value.traces.some(event => event.data.fixture === 'expired'))!
    expect(expired.checks.filter(check => check.status === 'fail').map(check => check.code.split(':')[0])).toEqual(['passport_validity', 'bank_recency'])
    const conflict = cases.find(value => value.traces.some(event => event.data.fixture === 'conflict'))!
    expect(conflict.checks.find(check => check.code === 'name_consistency')?.status).toBe('fail')
    expect(conflict.checks.find(check => check.code === 'passport_consistency')?.status).toBe('fail')
  })

  test('chooses policy by business submission date, validates calendar dates and month end', () => {
    expect(selectRulePack('demo-tourist', '2026-09-30').version).toBe('2026.09')
    expect(selectRulePack('demo-tourist', '2026-10-01').version).toBe('2026.10')
    expect(() => selectRulePack('demo-tourist', '2026-02-30')).toThrow()
    expect(() => selectRulePack('foreign-policy', '2026-10-12')).toThrow()
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28')
  })

  test('persists acceptance before worker executes and recovers queued task after restart', () => {
    const { service, dataDir } = setup()
    const created = service.createCase({ applicantName: '示例', visaType: 'demo-tourist', submissionDate: '2026-10-12' })
    const response = service.startReview(created.id)
    expect(response.accepted).toBe(true)
    expect(service.getCase(created.id).tasks[0]?.status).toBe('queued')
    expect(service.startReview(created.id).taskId).toBe(response.taskId)
    stop(service)
    const recovered = reopen(dataDir)
    recovered.runReview(response.taskId)
    expect(recovered.getCase(created.id).status).toBe('needs_correction')
    expect(recovered.getCase(created.id).checks.filter(check => check.code.startsWith('required:') && check.status === 'fail')).toHaveLength(3)
  })

  test('pushes real progress events and completed persisted result after first acceptance', async () => {
    const events: VisaFlowEvent[] = []
    const { service } = setup(true, event => events.push(event))
    const created = service.createCase({ applicantName: '示例', visaType: 'demo-tourist', submissionDate: '2026-10-12' })
    const response = service.startReview(created.id)
    expect(service.getCase(created.id).tasks[0]?.status).toBe('queued')
    await new Promise(resolve => setTimeout(resolve, 180))
    expect(events.some(event => event.type === 'review_complete' && event.taskId === response.taskId)).toBe(true)
    expect(service.getCase(created.id).tasks[0]?.status).toBe('completed')
  })

  test('corrupt PDF fails recognition without inventing facts and cross-case raw access is rejected', async () => {
    const { service } = setup()
    const first = service.createCase({ applicantName: '甲', visaType: 'demo-tourist', submissionDate: '2026-10-12' })
    const second = service.createCase({ applicantName: '乙', visaType: 'demo-tourist', submissionDate: '2026-10-12' })
    const material = service.addMaterial(first.id, { name: 'passport.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7 unsupported demo').toString('base64') })
    expect(material.parseError).toContain('OCR')
    expect(() => service.startReview(first.id)).toThrow('人工确认')
    await service.runMaterialRecognition(material.id)
    expect(service.getCase(first.id).materials[0]?.recognition?.status).toBe('failed')
    expect(() => service.getRawMaterial(second.id, material.id)).toThrow('材料不属于当前案件')
    service.runReview(service.startReview(first.id).taskId)
    expect(service.getCase(first.id).checks.some(check => check.status === 'needs_review' && check.code.startsWith('parse:'))).toBe(true)
  })
})

describe('durable approval and local outbox', () => {
  test('pending approval survives restart, frozen content stays identical, repeated approve creates exactly one local receipt', () => {
    const { service, dataDir } = setup()
    const detail = completedFixture(service, 'missing')
    const pending = service.requestNotice(detail.id)
    expect(pending.deliveryStatus).toBe('not_sent')
    expect(service.getOutbox(detail.id)).toHaveLength(0)
    expect(service.requestNotice(detail.id).id).toBe(pending.id)
    stop(service)
    const recovered = reopen(dataDir)
    expect(recovered.getCase(detail.id).approvals[0]?.frozenContent).toBe(pending.frozenContent)
    const sent = recovered.decideApproval(pending.id, true)
    expect(sent.status).toBe('approved')
    expect(sent.deliveryStatus).toBe('sent')
    expect(sent.receipt?.channel).toBe('local_demo_outbox')
    expect(sent.contentHash).toBe(pending.contentHash)
    expect(recovered.decideApproval(pending.id, true).receipt?.id).toBe(sent.receipt?.id)
    expect(recovered.getOutbox(detail.id)).toHaveLength(1)
    expect(recovered.getOutbox(detail.id)[0]?.content).toBe(pending.frozenContent)
    expect(recovered.decideApproval(pending.id, false).status).toBe('approved')
    const requestedAgain = recovered.requestNotice(detail.id)
    expect(requestedAgain.id).toBe(pending.id)
    expect(recovered.decideApproval(requestedAgain.id, true).receipt?.id).toBe(sent.receipt?.id)
    expect(recovered.getOutbox(detail.id)).toHaveLength(1)
  })

  test('reject and material changes never deliver stale notifications', () => {
    const { service } = setup()
    const detail = completedFixture(service, 'missing')
    const first = service.requestNotice(detail.id)
    expect(service.decideApproval(first.id, false).status).toBe('rejected')
    expect(service.decideApproval(first.id, true).status).toBe('rejected')
    expect(service.getOutbox(detail.id)).toHaveLength(0)
    const second = service.requestNotice(detail.id)
    service.addMaterial(detail.id, { name: '银行流水.json', mimeType: 'application/json', contentBase64: Buffer.from(JSON.stringify({ documentType: 'bank_statement', applicantName: '演示申请人', passportNumber: 'DEMO123456', issuedDate: '2026-10-05' })).toString('base64') })
    expect(service.decideApproval(second.id, true).status).toBe('rejected')
    service.runReview(service.startReview(detail.id).taskId)
    expect(service.getCase(detail.id).status).toBe('ready')
    expect(service.getOutbox(detail.id)).toHaveLength(0)
  })

  test('idempotent seeding and exported JSONL preserve policy and evidence audit fields', () => {
    const { service } = setup()
    const detail = completedFixture(service, 'conflict')
    expect(service.seedDemoCases()).toHaveLength(4)
    const records = service.exportTrace(detail.id).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0].type).toBe('visaflow_trace_manifest')
    const review = records.find(item => item.type === 'review_completed')
    expect(review.data.modelRequired).toBe(false)
    expect(review.data.checks.some((check: { code: string }) => check.code === 'passport_consistency')).toBe(true)
  })

  test('corrected application supersedes conflicting material while retaining the original task evidence', () => {
    const { service } = setup()
    const conflicted = completedFixture(service, 'conflict')
    const previousApplication = conflicted.materials.find(material => material.fields.documentType === 'application')!
    const pending = service.requestNotice(conflicted.id)
    const corrected = service.addMaterial(conflicted.id, { name: '申请表-补正.json', mimeType: 'application/json', contentBase64: Buffer.from(JSON.stringify({ documentType: 'application', applicantName: '演示申请人', passportNumber: 'DEMO123456' })).toString('base64') })
    const task = service.startReview(conflicted.id)
    service.runReview(task.taskId)
    const result = service.getCase(conflicted.id)
    expect(result.status).toBe('ready')
    expect(result.materials.find(material => material.id === previousApplication.id)?.active).toBe(false)
    expect(result.materials.find(material => material.id === previousApplication.id)?.supersededBy).toBe(corrected.id)
    expect(result.tasks[0]?.materialIds).not.toContain(previousApplication.id)
    expect(result.tasks[0]?.materialIds).toContain(corrected.id)
    expect(result.evidence.some(item => item.materialId === previousApplication.id)).toBe(true)
    expect(service.getRawMaterial(conflicted.id, previousApplication.id).text).toContain('DEMO999999')
    expect(service.decideApproval(pending.id, true).status).toBe('rejected')
    expect(service.getOutbox(conflicted.id)).toHaveLength(0)
  })
})
