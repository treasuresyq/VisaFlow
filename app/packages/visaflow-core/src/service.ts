import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEMO_RULE_PACKS, addMonths, daysBetween, selectRulePack, validDate } from './rules.ts'
import { DEMO_FIXTURES } from './fixtures.ts'
import { hash, isRecognitionMaterial, parseMaterial } from './materials.ts'
import { extractDocument } from './document-extraction.ts'
import type { Approval, CaseDetail, CaseSummary, CreateCaseInput, DocumentExtraction, Evidence, MaterialFields, ReviewCheck, ReviewTask, RulePack, ServiceOptions, TraceEvent, UploadMaterialInput, VisaFlowEvent, VisaMaterial } from './types.ts'

type Row = { data: string }
type JsonTable = 'cases' | 'materials' | 'evidence' | 'tasks' | 'approvals' | 'traces' | 'checks'
type StoredMaterial = VisaMaterial & { rawText: string; rawBase64: string; extraction?: DocumentExtraction }
const now = (): string => new Date().toISOString()
const id = (kind: string): string => `${kind}_${randomUUID()}`
const labels = { passport: '护照', bank_statement: '银行流水', application: '申请表' } as const
const normalizeName = (name: string): string => name.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
const normalizePassport = (value: string): string => value.replace(/[\s-]/g, '').toUpperCase()

/**
 * VisaFlow's domain workflow. The model may explain results, but field/date,
 * scope and permission gates execute here, independently of model prose.
 * SQLite is shared by the desktop and headless runtime through node:sqlite.
 */
export class VisaFlowService {
  private db: DatabaseSync
  private eventCallback?: ServiceOptions['onEvent']
  private autoRun: boolean
  private closed = false
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private documentExtractor: NonNullable<ServiceOptions['documentExtractor']>
  private cacheDir: string
  private recognitionChain = Promise.resolve()
  private recognitionControllers = new Set<AbortController>()

  constructor(options: ServiceOptions) {
    mkdirSync(options.dataDir, { recursive: true })
    this.db = new DatabaseSync(join(options.dataDir, 'visaflow.sqlite'))
    this.eventCallback = options.onEvent
    this.autoRun = options.autoRunTasks !== false
    this.cacheDir = join(options.dataDir, 'ocr-cache')
    this.documentExtractor = options.documentExtractor ?? extractDocument
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), material_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), status TEXT NOT NULL, delivery_status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, approval_id TEXT UNIQUE NOT NULL REFERENCES approvals(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS materials_case ON materials(case_id);
      CREATE INDEX IF NOT EXISTS evidence_case ON evidence(case_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS checks_task ON checks(task_id);
      CREATE INDEX IF NOT EXISTS approvals_state ON approvals(status,delivery_status);
      CREATE UNIQUE INDEX IF NOT EXISTS approvals_active_task ON approvals(json_extract(data,'$.taskId')) WHERE status IN ('pending','approved');
      CREATE INDEX IF NOT EXISTS traces_case ON traces(case_id);
    `)
    if (options.recoverOnStart !== false) this.recover()
    if (options.recoverOnStart !== false) {
      for (const material of this.rows<StoredMaterial>('SELECT data FROM materials')) {
        if (material.recognition?.status === 'running') {
          material.recognition = { status: 'queued', stage: '服务重启后重新识别' }
          this.saveMaterial(material)
        }
        if (material.recognition?.status === 'queued') this.scheduleRecognition(material.id)
      }
    }
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const controller of this.recognitionControllers) controller.abort()
    this.db.close()
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private read<T>(table: JsonTable, key: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key) as Row | undefined
    return row ? JSON.parse(row.data) as T : undefined
  }

  private rows<T>(sql: string, ...params: string[]): T[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map(row => JSON.parse(row.data) as T)
  }

  private caseRecord(caseId: string): CaseSummary {
    const value = this.read<CaseSummary>('cases', caseId)
    if (!value) throw new Error('案件不存在')
    return value
  }

  private updateCase(value: CaseSummary): void {
    value.updatedAt = now()
    this.db.prepare('UPDATE cases SET data=? WHERE id=?').run(JSON.stringify(value), value.id)
  }

  private updateTask(value: ReviewTask): void {
    value.updatedAt = now()
    this.db.prepare('UPDATE tasks SET status=?,data=? WHERE id=?').run(value.status, JSON.stringify(value), value.id)
  }

  private trace(caseId: string, type: string, data: Record<string, unknown>, taskId?: string): TraceEvent {
    const event: TraceEvent = { id: id('trace'), caseId, type, data, createdAt: now(), ...(taskId ? { taskId } : {}) }
    this.db.prepare('INSERT INTO traces(id,case_id,data) VALUES(?,?,?)').run(event.id, caseId, JSON.stringify(event))
    return event
  }

  private emit(event: VisaFlowEvent): void {
    // A disconnected UI must never roll back committed domain data.
    try { this.eventCallback?.(event) } catch { /* renderer can rehydrate via getCase */ }
  }

  private schedule(taskId: string): void {
    if (!this.autoRun || this.closed) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.closed) this.runReview(taskId)
    }, 80)
    this.timers.add(timer)
  }

  getRulePacks(): RulePack[] { return structuredClone([...DEMO_RULE_PACKS]) }

  listCases(): CaseSummary[] {
    return this.rows<CaseSummary>('SELECT data FROM cases ORDER BY rowid DESC').map(value => this.summary(value))
  }

  private summary(value: CaseSummary): CaseSummary {
    const materialCount = Number((this.db.prepare('SELECT COUNT(*) AS n FROM materials WHERE case_id=?').get(value.id) as { n: number }).n)
    const checks = value.latestTaskId ? this.rows<ReviewCheck>('SELECT data FROM checks WHERE task_id=?', value.latestTaskId) : []
    return { ...value, materialCount, issueCount: checks.filter(check => check.status !== 'pass').length }
  }

  getCase(caseId: string): CaseDetail {
    const value = this.summary(this.caseRecord(caseId))
    const materials = this.rows<StoredMaterial>('SELECT data FROM materials WHERE case_id=? ORDER BY rowid', caseId)
      .map(({ rawText: _text, rawBase64: _bytes, extraction: _extraction, ...material }) => material)
    return {
      ...value, materials,
      checks: value.latestTaskId ? this.rows<ReviewCheck>('SELECT data FROM checks WHERE task_id=? ORDER BY rowid', value.latestTaskId) : [],
      evidence: this.rows<Evidence>('SELECT data FROM evidence WHERE case_id=? ORDER BY rowid', caseId),
      tasks: this.rows<ReviewTask>('SELECT data FROM tasks WHERE case_id=? ORDER BY rowid DESC', caseId),
      approvals: this.rows<Approval>('SELECT data FROM approvals WHERE case_id=? ORDER BY rowid DESC', caseId),
      traces: this.rows<TraceEvent>('SELECT data FROM traces WHERE case_id=? ORDER BY rowid', caseId),
    }
  }

  createCase(input: CreateCaseInput): CaseSummary {
    if (!input.applicantName?.trim() || input.applicantName.length > 120) throw new Error('请填写有效的申请人姓名')
    if (!validDate(input.submissionDate)) throw new Error('提交日期必须是有效的 YYYY-MM-DD 日期')
    if (input.visaType !== 'demo-tourist') throw new Error('当前仅开放 demo-tourist 演示类型')
    const value: CaseSummary = {
      id: id('case'), applicantName: input.applicantName.trim(), visaType: input.visaType,
      submissionDate: input.submissionDate, ...(input.customerEmail?.trim() ? { customerEmail: input.customerEmail.trim() } : {}),
      status: 'collecting', materialCount: 0, issueCount: 0, createdAt: now(), updatedAt: now(),
    }
    this.transaction(() => {
      this.db.prepare('INSERT INTO cases(id,data) VALUES(?,?)').run(value.id, JSON.stringify(value))
      this.trace(value.id, 'case_created', { visaType: value.visaType, submissionDate: value.submissionDate, demo: true })
    })
    this.emit({ type: 'case_updated', caseId: value.id })
    return value
  }

  private invalidatePendingApprovals(caseId: string, reason: string): void {
    for (const approval of this.rows<Approval>("SELECT data FROM approvals WHERE case_id=? AND status='pending'", caseId)) {
      approval.status = 'rejected'; approval.decidedAt = now()
      this.db.prepare("UPDATE approvals SET status='rejected',data=? WHERE id=? AND status='pending'").run(JSON.stringify(approval), approval.id)
      this.trace(caseId, 'approval_invalidated', { approvalId: approval.id, reason }, approval.taskId)
    }
  }

  addMaterial(caseId: string, input: UploadMaterialInput): VisaMaterial {
    const value = this.caseRecord(caseId)
    if (value.status === 'reviewing') throw new Error('核验过程中不能修改材料，请等待本次核验结束')
    const parsed = parseMaterial(input)
    const existingMaterials = this.rows<StoredMaterial>('SELECT data FROM materials WHERE case_id=?', caseId)
    const duplicate = existingMaterials.find(material => material.active !== false && material.sha256 === parsed.sha256 && material.name === input.name)
    if (duplicate) { const { rawText: _text, rawBase64: _bytes, extraction: _extraction, ...material } = duplicate; return material }
    const material: StoredMaterial = {
      id: id('material'), caseId, name: input.name.trim(), mimeType: input.mimeType || 'application/octet-stream',
      sha256: parsed.sha256, uploadedAt: now(), fields: parsed.fields, active: true,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}), rawText: parsed.text, rawBase64: input.contentBase64,
      ...(isRecognitionMaterial(input) ? { recognition: { status: 'queued' as const, stage: '等待本地 PDF / OCR 识别' } } : {}),
    }
    this.transaction(() => {
      this.db.prepare('INSERT INTO materials(id,case_id,data) VALUES(?,?,?)').run(material.id, caseId, JSON.stringify(material))
      // A corrected version replaces the earlier active document of this type.
      // Its bytes and evidence remain immutable for prior task snapshots/audit.
      if (material.fields.documentType !== 'unknown') {
        for (const previous of existingMaterials.filter(item => item.active !== false && item.fields.documentType === material.fields.documentType)) {
          previous.active = false; previous.supersededBy = material.id; previous.supersededAt = material.uploadedAt
          this.db.prepare('UPDATE materials SET data=? WHERE id=?').run(JSON.stringify(previous), previous.id)
          this.trace(caseId, 'material_superseded', { previousMaterialId: previous.id, currentMaterialId: material.id, documentType: material.fields.documentType, previousSha256: previous.sha256, currentSha256: material.sha256 })
        }
      }
      this.invalidatePendingApprovals(caseId, '材料发生变化，原核验通知需重新生成')
      this.addEvidence(caseId, material.id, material.name, '文件全文', parsed.text || '原始二进制材料已保存；当前解析器未提取字段', parsed.sha256)
      for (const [field, content] of Object.entries(material.fields)) {
        if (content != null && field !== 'documentType') this.addEvidence(caseId, material.id, material.name, `字段 /${field}`, `${field}: ${String(content)}`, parsed.sha256)
      }
      value.status = 'collecting'; value.latestTaskId = undefined; value.rulePackId = undefined
      this.updateCase(value)
      this.trace(caseId, 'material_uploaded', { materialId: material.id, name: material.name, sha256: material.sha256, fields: material.fields, parseError: material.parseError ?? null })
    })
    this.emit({ type: 'case_updated', caseId })
    if (material.recognition) this.scheduleRecognition(material.id)
    const { rawText: _text, rawBase64: _bytes, extraction: _extraction, ...publicMaterial } = material
    return publicMaterial
  }

  private saveMaterial(material: StoredMaterial): void {
    this.db.prepare('UPDATE materials SET data=? WHERE id=?').run(JSON.stringify(material), material.id)
  }

  private scheduleRecognition(materialId: string): void {
    if (!this.autoRun || this.closed) return
    this.recognitionChain = this.recognitionChain.then(async () => { if (!this.closed) await this.runMaterialRecognition(materialId) }).catch(() => {})
  }

  async runMaterialRecognition(materialId: string): Promise<void> {
    const material = this.read<StoredMaterial>('materials', materialId)
    if (!material || material.recognition?.status !== 'queued' || this.closed) return
    material.recognition = { status: 'running', stage: '正在读取材料' }
    const claimed = this.db.prepare("UPDATE materials SET data=? WHERE id=? AND json_extract(data,'$.recognition.status')='queued'").run(JSON.stringify(material), material.id)
    if (Number(claimed.changes) !== 1) return
    const controller = new AbortController()
    this.recognitionControllers.add(controller)
    const progress = (stage: string) => {
      if (this.closed) return
      material.recognition!.stage = stage
      this.saveMaterial(material)
      this.emit({ type: 'material_progress', caseId: material.caseId, materialId: material.id, stage })
    }
    progress('正在读取材料')
    try {
      const result = await this.documentExtractor({ name: material.name, mimeType: material.mimeType, contentBase64: material.rawBase64 }, { cacheDir: this.cacheDir, signal: controller.signal, onProgress: progress })
      if (this.closed) return
      material.extraction = result; material.rawText = result.pages.map(page => `--- 第 ${page.pageNumber} 页 ---\n${page.text}`).join('\n\n')
      material.fields = result.fields
      material.parseError = '识别字段尚未人工确认，不能作为已核验材料。'
      material.recognition = { status: 'needs_confirmation', stage: '识别完成，等待确认字段', engine: result.engine, pageCount: result.pages.length, warnings: result.warnings }
      this.transaction(() => {
        this.saveMaterial(material)
        for (const page of result.pages) {
          const evidence = this.addEvidence(material.caseId, material.id, material.name, `识别原文 / 第 ${page.pageNumber} 页`, page.text, material.sha256)
          evidence.pageNumber = page.pageNumber; evidence.method = page.method
          this.db.prepare('UPDATE evidence SET data=? WHERE id=?').run(JSON.stringify(evidence), evidence.id)
        }
        this.trace(material.caseId, 'material_recognized', { materialId: material.id, pageCount: result.pages.length, engine: result.engine, requiresConfirmation: true })
      })
    } catch (error) {
      if (this.closed) return
      const message = error instanceof Error ? error.message : '材料识别失败'
      material.fields = { documentType: 'unknown' }
      material.parseError = message
      material.recognition = { status: 'failed', stage: '识别失败', error: message }
      this.transaction(() => { this.saveMaterial(material); this.trace(material.caseId, 'material_recognition_failed', { materialId: material.id, error: message }) })
    } finally {
      this.recognitionControllers.delete(controller)
      if (!this.closed) this.emit({ type: 'material_progress', caseId: material.caseId, materialId: material.id, stage: material.recognition?.stage })
    }
  }

  getMaterialRecognition(caseId: string, materialId: string): { material: VisaMaterial; extraction?: DocumentExtraction; text: string } {
    this.caseRecord(caseId)
    const material = this.read<StoredMaterial>('materials', materialId)
    if (!material || material.caseId !== caseId) throw new Error('材料不属于当前案件')
    const { rawText, rawBase64: _bytes, extraction, ...publicMaterial } = material
    return { material: publicMaterial, text: rawText, ...(extraction ? { extraction } : {}) }
  }

  retryMaterialRecognition(caseId: string, materialId: string): VisaMaterial {
    const value = this.caseRecord(caseId)
    if (value.status === 'reviewing') throw new Error('核验进行中，暂不能重新识别')
    const material = this.read<StoredMaterial>('materials', materialId)
    if (!material || material.caseId !== caseId) throw new Error('材料不属于当前案件')
    if (!material.active || material.recognition?.status !== 'failed') throw new Error('仅可重试未替换且识别失败的材料')
    material.recognition = { status: 'queued', stage: '等待重新识别' }; material.parseError = '等待 PDF / OCR 重新识别'
    this.saveMaterial(material); this.scheduleRecognition(material.id)
    this.emit({ type: 'case_updated', caseId })
    const { rawText: _text, rawBase64: _bytes, extraction: _extraction, ...publicMaterial } = material
    return publicMaterial
  }

  confirmMaterialFields(caseId: string, materialId: string, fields: MaterialFields, note: string): VisaMaterial {
    const value = this.caseRecord(caseId)
    if (value.status === 'reviewing') throw new Error('核验进行中，暂不能确认或修改材料')
    const original = this.read<StoredMaterial>('materials', materialId)
    if (!original || original.caseId !== caseId) throw new Error('材料不属于当前案件')
    if (!original.active || original.recognition?.status !== 'needs_confirmation') throw new Error('材料当前状态不能确认，请刷新后重试')
    if (!note?.trim() || note.length > 1000) throw new Error('请填写 1–1000 字的核对说明')
    if (!fields || !['passport', 'application', 'bank_statement'].includes(fields.documentType)) throw new Error('请选择有效的材料类型')
    const sanitized: MaterialFields = { documentType: fields.documentType }
    for (const field of ['applicantName', 'passportNumber', 'expiryDate', 'issuedDate'] as const) {
      const content = fields[field]
      if (content !== undefined && (typeof content !== 'string' || content.length > 120)) throw new Error('材料字段格式无效')
      if (content?.trim()) sanitized[field] = content.trim()
    }
    if (fields.balance !== undefined) { if (typeof fields.balance !== 'number' || !Number.isFinite(fields.balance) || fields.balance < 0) throw new Error('余额必须是非负数'); sanitized.balance = fields.balance }
    for (const field of ['expiryDate', 'issuedDate'] as const) if (sanitized[field] && !validDate(sanitized[field])) throw new Error('日期必须是有效的 YYYY-MM-DD')
    if (sanitized.passportNumber && !/^[A-Z0-9]{6,12}$/i.test(sanitized.passportNumber)) throw new Error('请核对护照号码，仅允许 6–12 位字母数字')
    if (sanitized.passportNumber) sanitized.passportNumber = sanitized.passportNumber.toUpperCase()
    const confirmed: StoredMaterial = { ...original, id: id('material'), uploadedAt: now(), fields: sanitized, recognition: { ...original.recognition, status: 'confirmed', stage: '字段已人工确认', confirmedAt: now(), confirmationNote: note.trim() } }
    delete confirmed.parseError
    this.transaction(() => {
      const current = this.read<StoredMaterial>('materials', original.id)
      if (!current?.active || current.recognition?.status !== 'needs_confirmation') throw new Error('材料已被其他操作确认，请刷新后重试')
      this.db.prepare('INSERT INTO materials(id,case_id,data) VALUES(?,?,?)').run(confirmed.id, caseId, JSON.stringify(confirmed))
      for (const previous of this.rows<StoredMaterial>('SELECT data FROM materials WHERE case_id=?', caseId).filter(item => item.active !== false && item.id !== confirmed.id && (item.id === original.id || item.fields.documentType === sanitized.documentType))) {
        previous.active = false; previous.supersededBy = confirmed.id; previous.supersededAt = now(); this.saveMaterial(previous)
      }
      for (const [field, content] of Object.entries(sanitized)) {
        if (content == null || field === 'documentType') continue
        const source = original.extraction?.fieldSources[field as keyof MaterialFields]
        const evidence = this.addEvidence(caseId, confirmed.id, confirmed.name, `字段 /${field}`, `${field}: ${content}\n${source ? `第 ${source.pageNumber} 页识别原文：${source.excerpt}` : '人工补录字段'}\n人工核对：${note.trim()}`, confirmed.sha256)
        evidence.method = 'human_confirmation'; if (source) { evidence.pageNumber = source.pageNumber; evidence.bbox = source.bbox }
        this.db.prepare('UPDATE evidence SET data=? WHERE id=?').run(JSON.stringify(evidence), evidence.id)
      }
      this.invalidatePendingApprovals(caseId, '识别材料字段已确认或修改，需重新核验')
      value.status = 'collecting'; value.latestTaskId = undefined; value.rulePackId = undefined; this.updateCase(value)
      this.trace(caseId, 'material_fields_confirmed', { originalMaterialId: original.id, materialId: confirmed.id, fields: sanitized, note: note.trim(), sha256: confirmed.sha256 })
    })
    this.emit({ type: 'case_updated', caseId })
    const { rawText: _text, rawBase64: _bytes, extraction: _extraction, ...publicMaterial } = confirmed
    return publicMaterial
  }

  private addEvidence(caseId: string, materialId: string | undefined, source: string, location: string, excerpt: string, digest?: string): Evidence {
    const value: Evidence = { id: id('ev'), caseId, ...(materialId ? { materialId } : {}), source, location, excerpt, sha256: digest ?? hash(excerpt), createdAt: now() }
    this.db.prepare('INSERT INTO evidence(id,case_id,material_id,data) VALUES(?,?,?,?)').run(value.id, caseId, materialId ?? null, JSON.stringify(value))
    return value
  }

  /** Scope check precedes evidence access; a foreign case cannot read a material by guessing its ID. */
  getRawMaterial(caseId: string, materialId: string): { material: VisaMaterial; text: string } {
    this.caseRecord(caseId)
    const material = this.read<StoredMaterial>('materials', materialId)
    if (!material || material.caseId !== caseId) throw new Error('材料不属于当前案件')
    const { rawText, rawBase64: _bytes, extraction: _extraction, ...publicMaterial } = material
    return { material: publicMaterial, text: rawText }
  }

  startReview(caseId: string): { accepted: true; taskId: string } {
    const value = this.caseRecord(caseId)
    const recognitionPending = this.rows<StoredMaterial>('SELECT data FROM materials WHERE case_id=?', caseId).some(material => material.active !== false && material.recognition && ['queued', 'running', 'needs_confirmation'].includes(material.recognition.status))
    if (recognitionPending) throw new Error('请先等待 PDF / OCR 完成，并人工确认识别字段后再核验。')
    if (value.latestTaskId) {
      const previous = this.read<ReviewTask>('tasks', value.latestTaskId)
      if (previous && (previous.status === 'queued' || previous.status === 'running')) return { accepted: true, taskId: previous.id }
    }
    const materials = this.rows<StoredMaterial>('SELECT data FROM materials WHERE case_id=? ORDER BY rowid', caseId).filter(material => material.active !== false)
    const task: ReviewTask = { id: id('task'), caseId, status: 'queued', stage: '等待核验', progress: 0, materialIds: materials.map(material => material.id), createdAt: now(), updatedAt: now() }
    this.transaction(() => {
      this.invalidatePendingApprovals(caseId, '启动新的核验任务')
      this.db.prepare('INSERT INTO tasks(id,case_id,status,data) VALUES(?,?,?,?)').run(task.id, caseId, task.status, JSON.stringify(task))
      value.status = 'reviewing'; value.latestTaskId = task.id
      this.updateCase(value)
      this.trace(caseId, 'review_accepted', { taskId: task.id, materialIds: task.materialIds, transport: 'durable_domain_task' }, task.id)
    })
    this.emit({ type: 'review_progress', caseId, taskId: task.id, stage: task.stage, progress: 0 })
    this.schedule(task.id)
    return { accepted: true, taskId: task.id }
  }

  /** Public for CLI replay and explicit recovery workers; atomic CAS also permits multiple service instances. */
  runReview(taskId: string): void {
    const task = this.read<ReviewTask>('tasks', taskId)
    if (!task || task.status !== 'queued') return
    task.status = 'running'; task.stage = '选择适用规则与材料快照'; task.progress = 20
    const claimed = this.db.prepare("UPDATE tasks SET status='running',data=? WHERE id=? AND status='queued'").run(JSON.stringify(task), taskId)
    if (Number(claimed.changes) !== 1) return
    this.emit({ type: 'review_progress', caseId: task.caseId, taskId, stage: task.stage, progress: task.progress })
    try {
      const value = this.caseRecord(task.caseId)
      const rule = selectRulePack(value.visaType, value.submissionDate)
      const materials = task.materialIds.map(materialId => this.read<StoredMaterial>('materials', materialId)).filter((material): material is StoredMaterial => Boolean(material))
      if (materials.length !== task.materialIds.length || materials.some(material => material.caseId !== value.id)) throw new Error('核验材料快照不完整或存在案件范围冲突')
      task.rulePackId = rule.id; task.progress = 55; task.stage = '执行材料覆盖、日期和字段核验'
      this.updateTask(task)
      this.emit({ type: 'review_progress', caseId: task.caseId, taskId, stage: task.stage, progress: task.progress })
      this.transaction(() => {
        const ruleEvidence = this.addEvidence(value.id, undefined, rule.name, `Rule Pack ${rule.version}`, `${rule.description}\n生效时间 ${rule.effectiveFrom}；依据提交日期 ${value.submissionDate}；护照 ${rule.passportValidityMonths} 个月；银行材料 ${rule.bankStatementMaxAgeDays} 天。`)
        const manifest = this.addEvidence(value.id, undefined, '本次核验材料快照', `任务 ${task.id}`, JSON.stringify(materials.map(material => ({ id: material.id, name: material.name, type: material.fields.documentType, sha256: material.sha256 }))))
        const evidence = this.rows<Evidence>('SELECT data FROM evidence WHERE case_id=? ORDER BY rowid', value.id)
        const checks = this.checkMaterials(value, materials, rule, evidence, ruleEvidence.id, manifest.id)
        for (const check of checks) this.db.prepare('INSERT INTO checks(id,case_id,task_id,data) VALUES(?,?,?,?)').run(check.id, value.id, task.id, JSON.stringify(check))
        task.status = 'completed'; task.stage = '核验完成'; task.progress = 100
        value.rulePackId = rule.id; value.status = checks.some(check => check.status !== 'pass') ? 'needs_correction' : 'ready'
        this.updateTask(task); this.updateCase(value)
        this.trace(value.id, 'rule_pack_selected', { rulePackId: rule.id, ruleVersion: rule.version, submissionDate: value.submissionDate, applicabilityBasis: rule.applicabilityBasis }, task.id)
        this.trace(value.id, 'review_completed', { status: value.status, checks, modelRequired: false, implementation: 'deterministic_domain_tools' }, task.id)
      })
      this.emit({ type: 'review_complete', caseId: task.caseId, taskId, stage: '核验完成', progress: 100 })
    } catch (error) {
      task.status = 'failed'; task.stage = '核验失败'; task.error = error instanceof Error ? error.message : String(error)
      this.transaction(() => {
        this.updateTask(task)
        const value = this.caseRecord(task.caseId); value.status = 'review_failed'; this.updateCase(value)
        this.trace(task.caseId, 'review_failed', { error: task.error }, taskId)
      })
      this.emit({ type: 'review_failed', caseId: task.caseId, taskId, stage: task.stage, progress: task.progress })
    }
  }

  private checkMaterials(value: CaseSummary, materials: StoredMaterial[], rule: RulePack, evidence: Evidence[], ruleEvidence: string, manifestEvidence: string): ReviewCheck[] {
    const checks: ReviewCheck[] = []
    const refs = (material: StoredMaterial, field: keyof MaterialFields): string[] => evidence.filter(item => item.materialId === material.id && item.location === `字段 /${field}`).map(item => item.id)
    const add = (code: string, label: string, status: ReviewCheck['status'], message: string, evidenceIds: string[]): void => {
      checks.push({ id: id('check'), code, label, status, message, evidenceIds: [...new Set([...evidenceIds, ruleEvidence])], ruleId: code.split(':')[0]!, ruleVersion: rule.version })
    }
    for (const kind of rule.requiredDocuments) {
      const found = materials.filter(material => material.fields.documentType === kind && !material.parseError)
      add(`required:${kind}`, `${labels[kind]}覆盖`, found.length ? 'pass' : 'fail', found.length ? `已提供 ${found.length} 份${labels[kind]}` : `缺少可核验的${labels[kind]}`, [manifestEvidence])
    }
    for (const material of materials) {
      if (material.parseError) add(`parse:${material.id}`, '材料解析', 'needs_review', `${material.name}：${material.parseError}`, [manifestEvidence])
      if (material.fields.documentType === 'passport' && !material.parseError) {
        const expiry = material.fields.expiryDate
        const minimum = addMonths(value.submissionDate, rule.passportValidityMonths)
        add(`passport_validity:${material.id}`, '护照有效期', validDate(expiry) ? expiry >= minimum ? 'pass' : 'fail' : 'needs_review', validDate(expiry) ? `护照到期 ${expiry}；演示规则要求不早于 ${minimum}` : '护照缺少有效到期日期，需补录或人工核验', [...refs(material, 'expiryDate'), manifestEvidence])
      }
      if (material.fields.documentType === 'bank_statement' && !material.parseError) {
        const issued = material.fields.issuedDate
        const age = validDate(issued) ? daysBetween(issued, value.submissionDate) : NaN
        add(`bank_recency:${material.id}`, '银行材料时效', Number.isFinite(age) ? age >= 0 && age <= rule.bankStatementMaxAgeDays ? 'pass' : 'fail' : 'needs_review', Number.isFinite(age) ? `出具 ${issued}，距提交日期 ${age} 天；演示规则允许 0–${rule.bankStatementMaxAgeDays} 天` : '银行材料缺少有效出具日期，需人工确认', [...refs(material, 'issuedDate'), manifestEvidence])
      }
    }
    const extracted = materials.filter(material => !material.parseError && material.fields.documentType !== 'unknown')
    const nameMissing = extracted.filter(material => !material.fields.applicantName)
    const conflictingNames = extracted.filter(material => material.fields.applicantName && normalizeName(material.fields.applicantName) !== normalizeName(value.applicantName))
    add('name_consistency', '姓名一致性', conflictingNames.length ? 'fail' : nameMissing.length ? 'needs_review' : 'pass', conflictingNames.length ? `姓名与案件不一致：${conflictingNames.map(material => `${material.name} = ${material.fields.applicantName}`).join('；')}` : nameMissing.length ? `${nameMissing.map(material => material.name).join('、')}缺少姓名字段` : '材料姓名与案件申请人一致', [...extracted.flatMap(material => refs(material, 'applicantName')), manifestEvidence])
    const passportValues = new Set(extracted.flatMap(material => material.fields.passportNumber ? [normalizePassport(material.fields.passportNumber)] : []))
    const passportMissing = extracted.filter(material => !material.fields.passportNumber)
    add('passport_consistency', '证件号一致性', passportValues.size > 1 ? 'fail' : passportMissing.length || !passportValues.size ? 'needs_review' : 'pass', passportValues.size > 1 ? `跨材料证件号冲突：${[...passportValues].join(' / ')}` : passportMissing.length || !passportValues.size ? '部分材料缺少证件号，不能确认跨材料一致性' : '跨材料证件号一致', [...extracted.flatMap(material => refs(material, 'passportNumber')), manifestEvidence])
    return checks
  }

  requestNotice(caseId: string): Approval {
    const value = this.getCase(caseId)
    const task = value.tasks.find(item => item.id === value.latestTaskId)
    if (!task || task.status !== 'completed' || !task.rulePackId) throw new Error('请先完成本次材料核验')
    const issues = value.checks.filter(check => check.status !== 'pass')
    if (!issues.length) throw new Error('当前材料没有待补正问题，无需生成补正通知')
    const existing = value.approvals.find(approval => approval.taskId === task.id && (approval.status === 'pending' || approval.status === 'approved'))
    if (existing) return existing
    const frozenContent = `【VisaFlow 演示补正通知】\n申请人：${value.applicantName}\n案件：${value.id}\n计划提交日期：${value.submissionDate}\n规则：${task.rulePackId}（仅演示）\n需处理的问题：\n${issues.map((check, index) => `${index + 1}. ${check.message} [${check.evidenceIds.join(', ')}]`).join('\n')}\n本通知仅在本地演示收件箱中发送，不对外联系客户。`
    const approval: Approval = {
      id: id('approval'), caseId, taskId: task.id, type: 'send_correction_notice', status: 'pending', deliveryStatus: 'not_sent',
      recipient: value.customerEmail ?? '演示客户（本地收件箱）', frozenContent, contentHash: hash(frozenContent), toolCallId: id('tool'),
      checkpoint: { taskId: task.id, node: 'correction_notice', evidenceIds: [...new Set(issues.flatMap(check => check.evidenceIds))], rulePackId: task.rulePackId }, createdAt: now(),
    }
    const created = this.transaction(() => {
      const concurrent = this.rows<Approval>("SELECT data FROM approvals WHERE case_id=? AND status IN ('pending','approved')", caseId).find(item => item.taskId === task.id)
      if (concurrent) return concurrent
      this.db.prepare('INSERT INTO approvals(id,case_id,status,delivery_status,data) VALUES(?,?,?,?,?)').run(approval.id, caseId, approval.status, approval.deliveryStatus, JSON.stringify(approval))
      const record = this.caseRecord(caseId); record.status = 'awaiting_approval'; this.updateCase(record)
      this.trace(caseId, 'sensitive_action_paused', { approvalId: approval.id, toolCallId: approval.toolCallId, contentHash: approval.contentHash, recipient: approval.recipient, checkpoint: approval.checkpoint }, task.id)
      return approval
    })
    this.emit({ type: 'approval_updated', caseId })
    return created
  }

  decideApproval(approvalId: string, approved: boolean): Approval {
    let approval = this.read<Approval>('approvals', approvalId)
    if (!approval) throw new Error('审批单不存在')
    if (approval.status === 'pending') {
      const wanted: Approval = { ...approval, status: approved ? 'approved' : 'rejected', decidedAt: now() }
      this.transaction(() => {
        const changed = this.db.prepare("UPDATE approvals SET status=?,data=? WHERE id=? AND status='pending'").run(wanted.status, JSON.stringify(wanted), approvalId)
        if (Number(changed.changes) === 1) {
          this.trace(wanted.caseId, 'approval_decided', { approvalId, approved, contentHash: wanted.contentHash }, wanted.taskId)
          if (!approved) { const record = this.caseRecord(wanted.caseId); record.status = 'needs_correction'; this.updateCase(record) }
        }
      })
    }
    approval = this.read<Approval>('approvals', approvalId)!
    if (approval.status === 'approved' && approval.deliveryStatus === 'not_sent') this.deliverLocalNotice(approvalId)
    const result = this.read<Approval>('approvals', approvalId)!
    this.emit({ type: 'approval_updated', caseId: result.caseId })
    return result
  }

  private deliverLocalNotice(approvalId: string): void {
    this.transaction(() => {
      const approval = this.read<Approval>('approvals', approvalId)
      if (!approval || approval.status !== 'approved' || approval.deliveryStatus !== 'not_sent') return
      if (hash(approval.frozenContent) !== approval.contentHash) throw new Error('冻结通知内容校验失败，停止发送')
      approval.deliveryStatus = 'sending'
      const claimed = this.db.prepare("UPDATE approvals SET delivery_status='sending',data=? WHERE id=? AND status='approved' AND delivery_status='not_sent'").run(JSON.stringify(approval), approvalId)
      if (Number(claimed.changes) !== 1) return
      const receipt: NonNullable<Approval['receipt']> = { id: id('receipt'), channel: 'local_demo_outbox', sentAt: now(), contentHash: approval.contentHash }
      this.db.prepare('INSERT INTO outbox(id,approval_id,data) VALUES(?,?,?)').run(receipt.id, approvalId, JSON.stringify({ ...receipt, approvalId, caseId: approval.caseId, recipient: approval.recipient, content: approval.frozenContent }))
      approval.receipt = receipt; approval.deliveryStatus = 'sent'
      this.db.prepare("UPDATE approvals SET delivery_status='sent',data=? WHERE id=? AND delivery_status='sending'").run(JSON.stringify(approval), approvalId)
      const record = this.caseRecord(approval.caseId); record.status = 'notice_sent'; this.updateCase(record)
      this.trace(approval.caseId, 'notice_sent_local', { approvalId, receipt, contentHash: approval.contentHash, localOnly: true }, approval.taskId)
    })
  }

  private recover(): void {
    const tasks = this.rows<ReviewTask>("SELECT data FROM tasks WHERE status IN ('queued','running')")
    for (const task of tasks) {
      if (task.status === 'running') this.transaction(() => { task.status = 'queued'; task.stage = '重启后重新执行可重复核验'; this.updateTask(task); this.trace(task.caseId, 'review_recovered', { taskId: task.id }, task.id) })
      this.schedule(task.id)
    }
    for (const approval of this.rows<Approval>("SELECT data FROM approvals WHERE status='approved' AND delivery_status='not_sent'")) this.deliverLocalNotice(approval.id)
    for (const approval of this.rows<Approval>("SELECT data FROM approvals WHERE delivery_status='sending'")) {
      this.transaction(() => {
        approval.deliveryStatus = 'uncertain'
        this.db.prepare("UPDATE approvals SET delivery_status='uncertain',data=? WHERE id=? AND delivery_status='sending'").run(JSON.stringify(approval), approval.id)
        this.trace(approval.caseId, 'delivery_uncertain', { approvalId: approval.id, action: 'manual_check_required', autoResend: false }, approval.taskId)
      })
    }
  }

  seedDemoCases(): CaseSummary[] {
    for (const fixture of DEMO_FIXTURES) {
      const key = `fixture:${fixture.key}`
      const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined
      if (existing) {
        const record = this.read<CaseSummary>('cases', existing.value)
        if (record) { if (record.demoLabel !== fixture.label) { record.demoLabel = fixture.label; this.updateCase(record) }; continue }
      }
      const value = this.createCase(fixture.case)
      value.demoLabel = fixture.label; this.updateCase(value)
      for (const material of fixture.materials) this.addMaterial(value.id, { name: material.name, mimeType: 'application/json', contentBase64: Buffer.from(JSON.stringify(material.fields, null, 2)).toString('base64') })
      this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, value.id)
      this.trace(value.id, 'demo_fixture_seeded', { fixture: fixture.key, label: fixture.label, expected: fixture.expected })
      this.startReview(value.id)
    }
    return this.listCases()
  }

  exportTrace(caseId: string): string {
    const detail = this.getCase(caseId)
    return [{ type: 'visaflow_trace_manifest', caseId, demo: true, rulePackId: detail.rulePackId, exportedAt: now() }, ...detail.traces].map(event => JSON.stringify(event)).join('\n') + '\n'
  }

  getOutbox(caseId: string): Record<string, unknown>[] {
    this.caseRecord(caseId)
    return (this.db.prepare('SELECT data FROM outbox ORDER BY rowid').all() as Row[]).map(row => JSON.parse(row.data) as Record<string, unknown>).filter(item => item.caseId === caseId)
  }
}
