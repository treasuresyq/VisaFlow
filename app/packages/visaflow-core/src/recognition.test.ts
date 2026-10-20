import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { VisaFlowService } from './service.ts'
import { extractDocument, mrzCheckDigit, structureDocument } from './document-extraction.ts'
import type { DocumentExtraction, DocumentPage, ServiceOptions } from './types.ts'

const folders: string[] = [], services: VisaFlowService[] = []
afterEach(async () => { for (const service of services.splice(0)) service.close(); Bun.gc(true); for (const folder of folders.splice(0)) { for (let attempt = 0; attempt < 5; attempt++) { try { rmSync(folder, { recursive: true, force: true }); break } catch (error) { if (attempt === 4) throw error; Bun.gc(true); await Bun.sleep(100) } } } })
function setup(extractor?: ServiceOptions['documentExtractor']) {
  const dataDir = mkdtempSync(join(tmpdir(), 'visaflow-recognition-')); folders.push(dataDir)
  const service = new VisaFlowService({ dataDir, autoRunTasks: false, documentExtractor: extractor }); services.push(service)
  const record = service.createCase({ applicantName: 'ANNA ERIKSSON', visaType: 'demo-tourist', submissionDate: '2026-10-19' })
  return { service, dataDir, caseId: record.id }
}
const page = (text: string): DocumentPage => ({ pageNumber: 1, method: 'pdf_text', text, lines: text.split('\n').map((text, index) => ({ text, bbox: [10, index * 25, 500, index * 25 + 20] })), width: 600, height: 800 })
const passportText = 'PASSPORT - SYNTHETIC DEMO\nName: ANNA ERIKSSON\nPassport No: X12345678\nDate of expiry: 2032-12-31'
const extraction: DocumentExtraction = structureDocument([page(passportText)], 'passport.pdf', 'test-extractor')

export function textPdf(lines: string[]): Buffer {
  const commands = `BT /F1 16 Tf 40 740 Td ${lines.map((line, index) => `${index ? '0 -32 Td ' : ''}(${line.replace(/[()\\]/g, value => '\\' + value)}) Tj`).join('\n')} ET`
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
  ])
}
function pdfObjects(objects: (string | Buffer)[]): Buffer {
  const pieces: Buffer[] = [Buffer.from('%PDF-1.4\n')], offsets = [0]
  let size = pieces[0]!.length
  objects.forEach((object, index) => { offsets.push(size); const piece = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); pieces.push(piece); size += piece.length })
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`
  return Buffer.concat([...pieces, Buffer.from(xref)])
}
export function passportImage(): Buffer {
  const canvas = createCanvas(1800, 700), context = canvas.getContext('2d')
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'black'; context.font = '42px Arial'
  passportText.split('\n').forEach((text, index) => context.fillText(text, 65, 90 + index * 110))
  context.font = '24px Arial'; context.fillText('SYNTHETIC SAMPLE - NOT A TRAVEL DOCUMENT', 65, 630)
  return canvas.toBuffer('image/png')
}

export function scannedPassportPdf(): Buffer {
  const canvas = createCanvas(1800, 700), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = 'black'; ctx.font = '42px Arial'
  passportText.split('\n').forEach((text, index) => ctx.fillText(text, 65, 90 + index * 110))
  const jpeg = canvas.toBuffer('image/jpeg')
  const commands = 'q 560 0 0 218 25 490 cm /Image1 Do Q'
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image1 4 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1800 /Height 700 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
    `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`,
  ])
}

test('explicit PDF fields and valid MRZ preserve page and source; corrupt checksums do not supply facts', () => {
  expect(extraction.fields).toEqual({ documentType: 'passport', applicantName: 'ANNA ERIKSSON', passportNumber: 'X12345678', expiryDate: '2032-12-31' })
  expect(extraction.fieldSources.passportNumber?.pageNumber).toBe(1)
  expect(extraction.fieldSources.passportNumber?.bbox).toHaveLength(4)
  const first = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'.padEnd(44, '<').slice(0, 44)
  const number = 'L898902C3', birth = '740812', expiry = '321231', personal = '<<<<<<<<<<<<<<'
  const prefix = number + mrzCheckDigit(number) + 'UTO' + birth + mrzCheckDigit(birth) + 'F' + expiry + mrzCheckDigit(expiry) + personal + mrzCheckDigit(personal)
  const second = prefix + mrzCheckDigit(prefix.slice(0, 10) + prefix.slice(13, 20) + prefix.slice(21, 43))
  const valid = structureDocument([page(first + '\n' + second)], 'image.png', 'OCR')
  expect(valid.fields.passportNumber).toBe(number)
  expect(valid.fields.expiryDate).toBe('2032-12-31')
  const invalid = structureDocument([page(first + '\n' + second.slice(0, 9) + (second[9] === '0' ? '1' : '0') + second.slice(10))], 'image.png', 'OCR')
  expect(invalid.fields.passportNumber).toBeUndefined()
  expect(invalid.warnings.join('')).toContain('校验未通过')
})

test('recognition is durable and cannot pass review until a human confirms a new version', async () => {
  const { service, caseId } = setup(async () => extraction)
  const material = service.addMaterial(caseId, { name: 'passport.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-test').toString('base64') })
  expect(material.recognition?.status).toBe('queued')
  expect(() => service.startReview(caseId)).toThrow('人工确认')
  await service.runMaterialRecognition(material.id)
  expect(service.getCase(caseId).materials[0]?.recognition?.status).toBe('needs_confirmation')
  expect(() => service.startReview(caseId)).toThrow('人工确认')
  expect(() => service.getMaterialRecognition('other-case', material.id)).toThrow()
  const other = service.createCase({ applicantName: 'OTHER', visaType: 'demo-tourist', submissionDate: '2026-10-19' })
  expect(() => service.getMaterialRecognition(other.id, material.id)).toThrow('不属于')
  expect(() => service.confirmMaterialFields(caseId, material.id, extraction.fields, '')).toThrow('核对说明')
  const confirmed = service.confirmMaterialFields(caseId, material.id, extraction.fields, '已逐项核对第 1 页原文')
  expect(confirmed.id).not.toBe(material.id)
  expect(confirmed.sha256).toBe(material.sha256)
  expect(confirmed.recognition?.status).toBe('confirmed')
  expect(service.getCase(caseId).materials.find(item => item.id === material.id)?.active).toBe(false)
  expect(service.getMaterialRecognition(caseId, material.id).extraction?.fields).toEqual(extraction.fields)
  expect(() => service.confirmMaterialFields(caseId, material.id, extraction.fields, 'duplicate')).toThrow('状态不能确认')
  const evidence = service.getCase(caseId).evidence.find(item => item.materialId === confirmed.id && item.location === '字段 /passportNumber')
  expect(evidence?.pageNumber).toBe(1); expect(evidence?.bbox).toHaveLength(4)
  expect(evidence?.excerpt).toContain('Passport No: X12345678')
  const task = service.startReview(caseId); service.runReview(task.taskId)
  expect(service.getCase(caseId).checks.find(check => check.code.startsWith('passport_validity'))?.status).toBe('pass')
  expect(service.getCase(caseId).checks.find(check => check.code === 'required:bank_statement')?.status).toBe('fail')
})

test('failed recognition is visible, restart resumes queued work, and a retry cannot invent fields', async () => {
  const { service, dataDir, caseId } = setup(async () => { throw new Error('PDF 已加密') })
  const material = service.addMaterial(caseId, { name: 'passport.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-test').toString('base64') })
  service.close(); services.splice(services.indexOf(service), 1)
  const resumed = new VisaFlowService({ dataDir, autoRunTasks: false, documentExtractor: async () => { throw new Error('PDF 已加密') } }); services.push(resumed)
  expect(resumed.getCase(caseId).materials[0]?.recognition?.status).toBe('queued')
  await resumed.runMaterialRecognition(material.id)
  const failed = resumed.getCase(caseId).materials[0]!
  expect(failed.recognition?.status).toBe('failed'); expect(failed.fields.passportNumber).toBeUndefined()
  expect(() => resumed.confirmMaterialFields(caseId, material.id, extraction.fields, 'not allowed')).toThrow('状态不能确认')
  expect(resumed.retryMaterialRecognition(caseId, material.id).recognition?.status).toBe('queued')
})

test('closing a running recognizer aborts it and the next service recovers the persisted job', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const { service, dataDir, caseId } = setup(async (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }); started()
  }))
  const material = service.addMaterial(caseId, { name: 'passport.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-test').toString('base64') })
  const running = service.runMaterialRecognition(material.id)
  await ready
  expect(service.getCase(caseId).materials[0]?.recognition?.status).toBe('running')
  service.close(); services.splice(services.indexOf(service), 1); await running
  const resumed = new VisaFlowService({ dataDir, autoRunTasks: false, documentExtractor: async () => extraction }); services.push(resumed)
  expect(resumed.getCase(caseId).materials[0]?.recognition?.status).toBe('queued')
  await resumed.runMaterialRecognition(material.id)
  expect(resumed.getCase(caseId).materials[0]?.recognition?.status).toBe('needs_confirmation')
  expect(resumed.getCase(caseId).materials[0]?.id).toBe(material.id)
})

test('real PDF text extraction provides page previews and source text without OCR', async () => {
  const { dataDir } = setup()
  const bytes = textPdf(passportText.split('\n'))
  const result = await extractDocument({ name: 'passport.pdf', mimeType: 'application/pdf', contentBase64: bytes.toString('base64') }, { cacheDir: join(dataDir, 'cache'), signal: new AbortController().signal, onProgress: () => {} })
  expect(result.pages[0]?.method).toBe('pdf_text')
  expect(result.fields.passportNumber).toBe('X12345678')
  expect(result.fields.applicantName).toBe('ANNA ERIKSSON')
  expect(result.pages[0]?.previewBase64?.length).toBeGreaterThan(100)
}, 60_000)

test('real PNG OCR uses installed local models and extracts passport fields', async () => {
  const { dataDir } = setup()
  const result = await extractDocument({ name: 'passport.png', mimeType: 'image/png', contentBase64: passportImage().toString('base64') }, { cacheDir: join(dataDir, 'cache'), signal: new AbortController().signal, onProgress: () => {} })
  expect(result.pages[0]?.method).toBe('ocr')
  expect(result.fields.passportNumber).toBe('X12345678')
  expect(result.fields.applicantName).toBe('ANNA ERIKSSON')
  expect(result.fields.expiryDate).toBe('2032-12-31')
  expect(result.fieldSources.passportNumber?.pageNumber).toBe(1)
}, 120_000)

test('real scanned PDF renders its image page and falls back to OCR', async () => {
  const { dataDir } = setup()
  const result = await extractDocument({ name: 'passport-scan.pdf', mimeType: 'application/pdf', contentBase64: scannedPassportPdf().toString('base64') }, { cacheDir: join(dataDir, 'cache'), signal: new AbortController().signal, onProgress: () => {} })
  expect(result.pages[0]?.method).toBe('ocr')
  expect(result.fields.passportNumber).toBe('X12345678')
  expect(result.fields.expiryDate).toBe('2032-12-31')
}, 120_000)

test('worker cancellation and image signature errors return failure without synthesized fields', async () => {
  const { dataDir } = setup()
  const controller = new AbortController(); controller.abort()
  await expect(extractDocument({ name: 'passport.png', mimeType: 'image/png', contentBase64: passportImage().toString('base64') }, { cacheDir: join(dataDir, 'cache'), signal: controller.signal, onProgress: () => {} })).rejects.toThrow('中止')
  await expect(extractDocument({ name: 'passport.png', mimeType: 'image/png', contentBase64: Buffer.from('not an image').toString('base64') }, { cacheDir: join(dataDir, 'cache'), signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow('扩展名不一致')
}, 60_000)
