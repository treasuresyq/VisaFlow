import type { CreateCaseInput, MaterialFields } from './types.ts'

export interface DemoFixture { key: string; label: string; case: CreateCaseInput; materials: { name: string; fields: MaterialFields }[]; expected: 'ready' | 'needs_correction' }
const passport: MaterialFields = { documentType: 'passport', applicantName: '演示申请人', passportNumber: 'DEMO123456', expiryDate: '2028-08-31' }
const bank: MaterialFields = { documentType: 'bank_statement', applicantName: '演示申请人', passportNumber: 'DEMO123456', issuedDate: '2026-10-05', balance: 80000 }
const application: MaterialFields = { documentType: 'application', applicantName: '演示申请人', passportNumber: 'DEMO123456' }
export const DEMO_FIXTURES: readonly DemoFixture[] = [
  { key: 'valid', label: '材料齐全', case: { applicantName: '演示申请人', visaType: 'demo-tourist', submissionDate: '2026-10-12' }, expected: 'ready', materials: [{ name: '护照.json', fields: passport }, { name: '银行流水.json', fields: bank }, { name: '申请表.json', fields: application }] },
  { key: 'missing', label: '缺少银行流水', case: { applicantName: '演示申请人', visaType: 'demo-tourist', submissionDate: '2026-10-12' }, expected: 'needs_correction', materials: [{ name: '护照.json', fields: passport }, { name: '申请表.json', fields: application }] },
  { key: 'expired', label: '护照与材料过期', case: { applicantName: '演示申请人', visaType: 'demo-tourist', submissionDate: '2026-10-12' }, expected: 'needs_correction', materials: [{ name: '护照.json', fields: { ...passport, expiryDate: '2026-11-01' } }, { name: '银行流水.json', fields: { ...bank, issuedDate: '2026-09-01' } }, { name: '申请表.json', fields: application }] },
  { key: 'conflict', label: '跨材料字段冲突', case: { applicantName: '演示申请人', visaType: 'demo-tourist', submissionDate: '2026-10-12' }, expected: 'needs_correction', materials: [{ name: '护照.json', fields: passport }, { name: '银行流水.json', fields: bank }, { name: '申请表.json', fields: { ...application, applicantName: '另一个演示姓名', passportNumber: 'DEMO999999' } }] },
]
