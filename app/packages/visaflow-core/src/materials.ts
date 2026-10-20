import { createHash } from 'node:crypto'
import type { DocumentType, MaterialFields, UploadMaterialInput } from './types.ts'

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const kinds = new Set<DocumentType>(['passport', 'bank_statement', 'application', 'unknown'])
export const isRecognitionMaterial = (input: UploadMaterialInput): boolean => /\.(pdf|png|jpe?g)$/i.test(input.name)

export function parseMaterial(input: UploadMaterialInput): { text: string; sha256: string; fields: MaterialFields; parseError?: string } {
  if (!input.name?.trim()) throw new Error('材料文件名不能为空')
  const normalized = input.contentBase64.replace(/\s/g, '')
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('材料内容不是有效的 Base64')
  }
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.length > 8 * 1024 * 1024) throw new Error('演示材料最大 8 MB')
  const sha256 = hash(bytes)
  if (isRecognitionMaterial(input)) return { text: '', sha256, fields: { documentType: 'unknown' }, parseError: 'PDF / OCR 识别任务排队中，识别字段需要人工确认。' }
  if (!/\.(json|txt|md)$/i.test(input.name) && !/^(application\/json|text\/)/i.test(input.mimeType)) {
    return { text: '', sha256, fields: { documentType: 'unknown' }, parseError: '材料格式不受支持。请上传 JSON、TXT、Markdown、PDF、PNG、JPG 或 JPEG。' }
  }
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  let raw: Record<string, unknown>
  try {
    if (/\.json$/i.test(input.name) || input.mimeType === 'application/json' || text.trim().startsWith('{')) {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('材料 JSON 必须是一个字段对象')
      raw = parsed as Record<string, unknown>
    } else {
      raw = {}
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([\w\u4e00-\u9fff]+)\s*[:：=]\s*(.*?)\s*$/)
        if (match?.[1] && match[2] != null) raw[match[1]] = match[2]
      }
    }
  } catch (error) {
    return { text, sha256, fields: { documentType: 'unknown' }, parseError: error instanceof Error ? error.message : '材料解析失败' }
  }
  const read = (...keys: string[]): string | undefined => {
    const key = keys.find(name => raw[name] != null)
    if (!key) return undefined
    const value = raw[key]
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || undefined : undefined
  }
  const declared = read('documentType', '材料类型')
  const aliases: Record<string, DocumentType> = { 护照: 'passport', 银行流水: 'bank_statement', 申请表: 'application' }
  let documentType = declared && kinds.has(declared as DocumentType) ? declared as DocumentType : aliases[declared ?? '']
  if (!documentType) {
    documentType = /passport|护照/i.test(input.name) ? 'passport' : /bank|银行|流水/i.test(input.name) ? 'bank_statement' : /application|申请/i.test(input.name) ? 'application' : 'unknown'
  }
  const balanceRaw = read('balance', '余额')
  const fields: MaterialFields = {
    documentType,
    applicantName: read('applicantName', 'name', '姓名'),
    passportNumber: read('passportNumber', 'passportId', '证件号', '护照号'),
    expiryDate: read('expiryDate', '到期日期', '有效期'),
    issuedDate: read('issuedDate', '出具日期'),
    ...(balanceRaw && Number.isFinite(Number(balanceRaw)) ? { balance: Number(balanceRaw) } : {}),
  }
  return { text, sha256, fields, ...(documentType === 'unknown' ? { parseError: '无法识别材料类型，请提供 documentType 字段或规范文件名' } : {}) }
}
