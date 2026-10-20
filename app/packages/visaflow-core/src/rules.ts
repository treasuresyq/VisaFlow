import type { RulePack } from './types.ts'

/** Deliberately invented fixture policy. This is never represented as a country's visa policy. */
export const DEMO_RULE_PACKS: readonly RulePack[] = [
  {
    id: 'demo-tourist-2026-09', name: '演示旅游签证材料规则', version: '2026.09',
    visaType: 'demo-tourist', effectiveFrom: '2026-01-01', scope: 'demo',
    applicabilityBasis: 'submission_date', requiredDocuments: ['passport', 'bank_statement', 'application'],
    passportValidityMonths: 6, bankStatementMaxAgeDays: 30,
    description: '仅用于工程演示的虚构规则；护照有效期及银行材料时效不代表任何国家的实际要求。',
  },
  {
    id: 'demo-tourist-2026-10', name: '演示旅游签证材料规则', version: '2026.10',
    visaType: 'demo-tourist', effectiveFrom: '2026-10-01', scope: 'demo',
    applicabilityBasis: 'submission_date', requiredDocuments: ['passport', 'bank_statement', 'application'],
    passportValidityMonths: 6, bankStatementMaxAgeDays: 14,
    description: '仅用于工程演示的虚构规则；10 月版本把银行材料时效从 30 天改为 14 天，依据计划提交日期选版。',
  },
]

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function selectRulePack(visaType: string, submissionDate: string): RulePack {
  if (!validDate(submissionDate)) throw new Error('提交日期必须是有效的 YYYY-MM-DD 日期')
  const applicable = DEMO_RULE_PACKS.filter(rule => rule.visaType === visaType && rule.effectiveFrom <= submissionDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
  if (!applicable[0]) throw new Error('当前签证类型与提交日期没有适用的演示规则，请人工确认规则范围')
  return structuredClone(applicable[0])
}

export function addMonths(date: string, months: number): string {
  const original = new Date(`${date}T00:00:00Z`)
  const day = original.getUTCDate()
  original.setUTCDate(1)
  original.setUTCMonth(original.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth() + 1, 0)).getUTCDate()
  original.setUTCDate(Math.min(day, lastDay))
  return original.toISOString().slice(0, 10)
}

export function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000
}
