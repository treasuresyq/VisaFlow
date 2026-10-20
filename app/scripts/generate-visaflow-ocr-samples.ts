import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// These deliberately plain synthetic documents are not travel documents.
const directory = resolve(import.meta.dir, '../../examples/ocr')
mkdirSync(directory, { recursive: true })
const lines = ['PASSPORT - SYNTHETIC DEMO', 'Name: ANNA ERIKSSON', 'Passport No: X12345678', 'Date of expiry: 2032-12-31', 'SYNTHETIC SAMPLE - NOT A TRAVEL DOCUMENT']
function pdf(objects: (string | Buffer)[]): Buffer {
  const pieces = [Buffer.from('%PDF-1.4\n')], offsets = [0]
  let length = pieces[0]!.length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const piece = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')])
    pieces.push(piece); length += piece.length
  }
  return Buffer.concat([...pieces, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`)])
}
const commands = 'BT /F1 16 Tf 40 740 Td ' + lines.map((text, index) => `${index ? '0 -32 Td ' : ''}(${text}) Tj`).join('\n') + ' ET'
writeFileSync(resolve(directory, 'passport-text.pdf'), pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`]))
const canvas = createCanvas(1800, 800), context = canvas.getContext('2d')
context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'black'; context.font = '42px Arial'
lines.forEach((text, index) => context.fillText(text, 65, 90 + index * 110))
writeFileSync(resolve(directory, 'passport-photo.png'), canvas.toBuffer('image/png'))
const jpeg = canvas.toBuffer('image/jpeg')
writeFileSync(resolve(directory, 'passport-photo.jpg'), jpeg)
const imageCommands = 'q 560 0 0 249 25 440 cm /Image1 Do Q'
writeFileSync(resolve(directory, 'passport-scan.pdf'), pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image1 4 0 R >> >> /Contents 5 0 R >>', Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1800 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]), `<< /Length ${imageCommands.length} >>\nstream\n${imageCommands}\nendstream`]))
for (const type of ['bank_statement', 'application']) writeFileSync(resolve(directory, type + '.json'), JSON.stringify({ documentType: type, applicantName: 'ANNA ERIKSSON', passportNumber: 'X12345678', ...(type === 'bank_statement' ? { issuedDate: '2026-10-15', balance: 80000 } : {}) }, null, 2))
console.log('Created synthetic PDF, PNG, JPG and scanned PDF samples in examples/ocr.')
