export type CaseStatus = 'collecting' | 'reviewing' | 'needs_correction' | 'ready' | 'awaiting_approval' | 'notice_sent' | 'review_failed'
export type DocumentType = 'passport' | 'bank_statement' | 'application' | 'unknown'
export interface MaterialFields {
  documentType: DocumentType
  applicantName?: string
  passportNumber?: string
  expiryDate?: string
  issuedDate?: string
  balance?: number
}
export interface VisaMaterial {
  id: string
  caseId: string
  name: string
  mimeType: string
  sha256: string
  uploadedAt: string
  fields: MaterialFields
  active: boolean
  supersededBy?: string
  supersededAt?: string
  parseError?: string
  recognition?: MaterialRecognition
}
export interface DocumentLine { text: string; bbox?: [number, number, number, number]; confidence?: number }
export interface DocumentPage { pageNumber: number; method: 'pdf_text' | 'ocr'; text: string; lines: DocumentLine[]; width: number; height: number; previewBase64?: string; confidence?: number }
export interface FieldSource { pageNumber: number; excerpt: string; bbox?: [number, number, number, number]; confidence?: number }
export interface DocumentExtraction { pages: DocumentPage[]; fields: MaterialFields; fieldSources: Partial<Record<keyof MaterialFields, FieldSource>>; warnings: string[]; engine: string }
export interface MaterialRecognition {
  status: 'queued' | 'running' | 'needs_confirmation' | 'confirmed' | 'failed'
  stage: string
  engine?: string
  warnings?: string[]
  pageCount?: number
  error?: string
  confirmedAt?: string
  confirmationNote?: string
}
export interface Evidence {
  id: string
  caseId: string
  materialId?: string
  source: string
  location: string
  excerpt: string
  sha256: string
  createdAt: string
  pageNumber?: number
  bbox?: [number, number, number, number]
  method?: 'pdf_text' | 'ocr' | 'human_confirmation'
}
export interface ReviewCheck {
  id: string
  code: string
  label: string
  status: 'pass' | 'fail' | 'needs_review'
  message: string
  evidenceIds: string[]
  ruleId: string
  ruleVersion: string
}
export interface ReviewTask {
  id: string
  caseId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: string
  progress: number
  rulePackId?: string
  materialIds: string[]
  createdAt: string
  updatedAt: string
  error?: string
}
export interface Approval {
  id: string
  caseId: string
  taskId: string
  type: 'send_correction_notice'
  status: 'pending' | 'approved' | 'rejected'
  deliveryStatus: 'not_sent' | 'sending' | 'sent' | 'uncertain'
  recipient: string
  frozenContent: string
  contentHash: string
  toolCallId: string
  checkpoint: { taskId: string; node: 'correction_notice'; evidenceIds: string[]; rulePackId: string }
  receipt?: { id: string; channel: 'local_demo_outbox'; sentAt: string; contentHash: string }
  createdAt: string
  decidedAt?: string
}
export interface TraceEvent {
  id: string
  caseId: string
  taskId?: string
  type: string
  data: Record<string, unknown>
  createdAt: string
}
export interface RulePack {
  id: string
  name: string
  version: string
  visaType: string
  effectiveFrom: string
  scope: 'demo'
  applicabilityBasis: 'submission_date'
  requiredDocuments: Exclude<DocumentType, 'unknown'>[]
  passportValidityMonths: number
  bankStatementMaxAgeDays: number
  description: string
}
export interface CaseSummary {
  id: string
  demoLabel?: string
  applicantName: string
  visaType: string
  submissionDate: string
  customerEmail?: string
  status: CaseStatus
  rulePackId?: string
  latestTaskId?: string
  materialCount: number
  issueCount: number
  createdAt: string
  updatedAt: string
}
export interface CaseDetail extends CaseSummary {
  materials: VisaMaterial[]
  checks: ReviewCheck[]
  evidence: Evidence[]
  tasks: ReviewTask[]
  approvals: Approval[]
  traces: TraceEvent[]
}
export interface VisaFlowEvent {
  type: 'case_updated' | 'review_progress' | 'review_complete' | 'review_failed' | 'approval_updated' | 'material_progress'
  caseId: string
  taskId?: string
  stage?: string
  progress?: number
  materialId?: string
}
export interface CreateCaseInput {
  applicantName: string
  visaType: string
  submissionDate: string
  customerEmail?: string
}
export interface UploadMaterialInput { name: string; mimeType: string; contentBase64: string }
export interface ServiceOptions {
  dataDir: string
  onEvent?: (event: VisaFlowEvent) => void
  /** Tests can disable automatic workers to simulate process crashes. */
  autoRunTasks?: boolean
  /** Additional read/tool processes must not claim another live process crashed. */
  recoverOnStart?: boolean
  documentExtractor?: (input: UploadMaterialInput, options: { cacheDir: string; signal: AbortSignal; onProgress: (stage: string) => void }) => Promise<DocumentExtraction>
}
