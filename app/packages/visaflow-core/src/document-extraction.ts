import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DocumentExtraction, DocumentPage, FieldSource, MaterialFields, UploadMaterialInput } from './types.ts'
import { validDate } from './rules.ts'

/** Same worker in Bun/Node CLI and the bundled Electron main process. */
export async function extractDocument(input: UploadMaterialInput, options: { cacheDir: string; signal: AbortSignal; onProgress: (stage: string) => void }): Promise<DocumentExtraction> {
  if (options.signal.aborted) throw new Error('材料识别已中止')
  const directory = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const worker = join(directory, 'document-worker.cjs')
  if (!existsSync(worker)) throw new Error('材料识别组件未构建，请重新运行启动脚本并加 -Rebuild。')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '', received = 0, result: { pages: DocumentPage[]; engine: string } | undefined, failure = '', settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timeout); options.signal.removeEventListener('abort', abort)
      if (error) { child.kill(); reject(error) }
      else if (result) resolve(structureDocument(result.pages, input.name, result.engine))
      else reject(new Error(failure || '识别进程未返回完整结果，请重试或更换清晰材料。'))
    }
    const abort = () => finish(new Error('材料识别已中止'))
    const timeout = setTimeout(() => finish(new Error('识别超过 180 秒，请拆分 PDF 或上传更清晰的图片。')), 180_000)
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) { abort(); return }
    child.on('error', () => finish(new Error('无法启动本地识别进程，请检查运行环境。')))
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      received += Buffer.byteLength(chunk, 'utf8')
      if (received > 32 * 1024 * 1024) { finish(new Error('识别结果过大，请拆分材料。')); return }
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        try {
          const message = JSON.parse(line)
          if (message.type === 'progress') options.onProgress(String(message.stage))
          if (message.type === 'result') result = message.result
          if (message.type === 'error') failure = String(message.message)
        } catch { /* Ignore library diagnostics, never treat them as document data. */ }
      }
    })
    child.stderr.on('data', () => { /* Native diagnostics may contain document data; do not persist them. */ })
    child.on('close', code => finish(code === 0 ? undefined : new Error(failure || '材料无法识别：文件损坏、加密或格式不受支持。')))
    child.stdin.end(JSON.stringify({ ...input, cacheDir: options.cacheDir }))
  })
}

function isoDate(value: string): string | undefined {
  let candidate = value.trim().replace(/[./年]/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/\s+/g, ' ')
  const numeric = candidate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (numeric) candidate = `${numeric[1]}-${numeric[2]!.padStart(2, '0')}-${numeric[3]!.padStart(2, '0')}`
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const words = candidate.toUpperCase().match(/^(\d{1,2})[ -]([A-Z]{3})[ -](\d{4})$/)
  if (words && months.includes(words[2]!)) candidate = `${words[3]}-${String(months.indexOf(words[2]!) + 1).padStart(2, '0')}-${words[1]!.padStart(2, '0')}`
  return validDate(candidate) ? candidate : undefined
}

export function mrzCheckDigit(text: string): string {
  const weights = [7, 3, 1]
  return String([...text].reduce((sum, char, index) => sum + (char === '<' ? 0 : /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 55) * weights[index % 3]!, 0) % 10)
}

/** Extract only explicit labels or checksum-verified TD3 MRZ, never case metadata. */
export function structureDocument(pages: DocumentPage[], name: string, engine: string): DocumentExtraction {
  const fields: MaterialFields = { documentType: 'unknown' }
  const fieldSources: DocumentExtraction['fieldSources'] = {}
  const warnings: string[] = []
  const all = pages.flatMap(page => page.lines.map(line => ({ ...line, pageNumber: page.pageNumber })))
  const text = pages.map(p => p.text).join('\n')
  const set = (key: keyof MaterialFields, value: string | number, source: FieldSource) => {
    if (fields[key] != null && fields[key] !== value) { warnings.push(`${key} 在不同位置出现不同值，请核对原文。`); return }
    Object.assign(fields, { [key]: value }); fieldSources[key] = source
  }
  const labels: [keyof MaterialFields, RegExp][] = [
    ['applicantName', /^(?:applicantName|full\s*name|name|姓名|申请人姓名)\s*[:：=]\s*(.+)$/i],
    ['passportNumber', /^(?:passportNumber|passportId|passport\s*(?:no\.?|number)|护照号(?:码)?|证件号(?:码)?)\s*[:：=]?\s+(.+)$/i],
    ['expiryDate', /^(?:expiryDate|date\s*of\s*expiry|expiry\s*date|expires|到期日期|有效期(?:至)?)\s*[:：=]?\s+(.+)$/i],
    ['issuedDate', /^(?:issuedDate|date\s*of\s*issue|issue\s*date|出具日期|签发日期)\s*[:：=]?\s+(.+)$/i],
    ['balance', /^(?:balance|余额)\s*[:：=]\s*(.+)$/i],
  ]
  for (const line of all) {
    for (const [key, regex] of labels) {
      // Insert a space after ':' so both compact key:value and OCR labels work.
      const match = line.text.normalize('NFKC').replace(/[:=]\s*/g, ': ').match(regex)
      if (!match) continue
      const raw = match[1]!.trim()
      const source: FieldSource = { pageNumber: line.pageNumber, excerpt: line.text, ...(line.bbox ? { bbox: line.bbox } : {}), ...(line.confidence != null ? { confidence: line.confidence } : {}) }
      if (key === 'expiryDate' || key === 'issuedDate') {
        const date = isoDate(raw)
        if (date) set(key, date, source); else warnings.push(`${key} 日期格式无法可靠识别：请人工核对。`)
      } else if (key === 'balance') {
        const balance = Number(raw.replace(/,/g, ''))
        if (Number.isFinite(balance)) set(key, balance, source)
      } else if (key === 'passportNumber') {
        const passport = raw.replace(/\s/g, '').toUpperCase()
        if (/^[A-Z0-9]{6,12}$/.test(passport)) set(key, passport, source)
        else warnings.push('护照号码格式不明确，请人工核对。')
      } else set(key, raw, source)
    }
  }
  // Many passports split the family name and given names into separate labeled rows.
  if (!fields.applicantName) {
    const family = all.find(line => /^(?:surname|family\s*name|姓)\s*[:：=]\s*\S+/i.test(line.text))
    const given = all.find(line => /^(?:given\s*names?|名)\s*[:：=]\s*\S+/i.test(line.text))
    if (family && given && family.pageNumber === given.pageNumber) {
      const surname = family.text.replace(/^[^:：=]+[:：=]\s*/, '').trim()
      const names = given.text.replace(/^[^:：=]+[:：=]\s*/, '').trim()
      set('applicantName', `${surname} ${names}`, { pageNumber: family.pageNumber, excerpt: `${family.text}\n${given.text}`, ...(family.bbox ? { bbox: family.bbox } : {}) })
    }
  }
  // TD3 passports have two 44-character lines. OCR substitutions are never silently corrected.
  for (let index = 0; index < all.length - 1; index++) {
    const first = all[index]!, second = all[index + 1]!
    const a = first.text.replace(/\s/g, '').toUpperCase(), b = second.text.replace(/\s/g, '').toUpperCase()
    if (first.pageNumber !== second.pageNumber || !/^P[<A-Z][A-Z<]{3}[A-Z<]{39}$/.test(a) || !/^[A-Z0-9<]{44}$/.test(b)) continue
    fields.documentType = 'passport'
    if (mrzCheckDigit(b.slice(0, 9)) !== b[9] || mrzCheckDigit(b.slice(13, 19)) !== b[19] || mrzCheckDigit(b.slice(21, 27)) !== b[27] || mrzCheckDigit(b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43)) !== b[43]) {
      warnings.push('护照机读码校验未通过，未采用其中的字段，请人工核对。'); continue
    }
    const source = { pageNumber: first.pageNumber, excerpt: `${first.text}\n${second.text}`, ...(second.bbox ? { bbox: second.bbox } : {}), ...(second.confidence != null ? { confidence: second.confidence } : {}) }
    set('passportNumber', b.slice(0, 9).replace(/</g, ''), source)
    set('applicantName', a.slice(5).replace(/<+/g, ' ').trim(), { ...source, ...(first.bbox ? { bbox: first.bbox } : {}) })
    // Expiry dates use the nearest 100-year window around the current year; user confirmation is mandatory.
    const year = Number(b.slice(21, 23)), current = new Date().getUTCFullYear()
    let fullYear = Math.floor(current / 100) * 100 + year
    if (fullYear < current - 50) fullYear += 100
    if (fullYear > current + 50) fullYear -= 100
    const expiry = `${fullYear}-${b.slice(23, 25)}-${b.slice(25, 27)}`
    if (validDate(expiry)) set('expiryDate', expiry, source)
  }
  if (fields.documentType === 'unknown') fields.documentType = /passport|护照/i.test(name + '\n' + text) ? 'passport' : /bank.statement|银行流水/i.test(name + '\n' + text) ? 'bank_statement' : /application|申请表/i.test(name + '\n' + text) ? 'application' : 'unknown'
  for (const page of pages) if (page.method === 'ocr' && (page.confidence ?? 0) < 80) warnings.push(`第 ${page.pageNumber} 页识别置信度较低，请对照原图确认。`)
  if (!fields.applicantName || !fields.passportNumber) warnings.push('姓名或护照号码未完整提取，请对照原文补充。')
  if (!text.trim()) throw new Error('未识别到可读文字，请上传清晰材料。')
  return { pages, fields, fieldSources, warnings: [...new Set(warnings)], engine }
}
