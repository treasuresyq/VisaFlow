// VisaFlow local document worker. No document bytes are sent to a remote service.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const runtimeRequire = fs.existsSync(path.join(__dirname, 'recognition/node_modules'))
  ? createRequire(path.join(__dirname, 'recognition/runtime.cjs')) : require;
const sharp = runtimeRequire('sharp');
const canvasModule = runtimeRequire('@napi-rs/canvas');
for (const key of ['DOMMatrix', 'ImageData', 'Path2D']) if (!globalThis[key]) globalThis[key] = canvasModule[key];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let worker;
async function ocr(png) {
  send({ type: 'progress', stage: '本地 OCR 识别中' });
  if (!worker) {
    const { createWorker } = runtimeRequire('tesseract.js');
    const languages = [runtimeRequire('@tesseract.js-data/eng'), runtimeRequire('@tesseract.js-data/chi_sim')];
    const langPath = path.join(input.cacheDir, 'languages');
    fs.mkdirSync(langPath, { recursive: true });
    for (let index = 0; index < languages.length; index++) {
      const language = index === 0 ? 'eng' : 'chi_sim';
      const source = path.join(languages[index].langPath, language + '.traineddata.gz');
      const target = path.join(langPath, language + '.traineddata.gz');
      if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) {
        const temporary = target + '.' + process.pid + '.tmp';
        fs.copyFileSync(source, temporary);
        fs.renameSync(temporary, target);
      }
    }
    worker = await createWorker('eng+chi_sim', 1, {
      langPath, cachePath: input.cacheDir, cacheMethod: 'none',
      workerPath: runtimeRequire.resolve('tesseract.js/src/worker-script/node/index.js'),
      errorHandler: () => {},
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
  }
  const { data } = await worker.recognize(png, {}, { blocks: true });
  const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => (paragraph.lines || []).map(line => ({ text: line.text.trim(), bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1], confidence: line.confidence })))).filter(line => line.text);
  return { text: data.text, lines: lines.length ? lines : data.text.split(/\r?\n/).filter(Boolean).map(text => ({ text })), confidence: data.confidence };
}
function pdfLines(items, viewport) {
  const lines = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const height = Math.max(1, Math.abs(item.height * viewport.scale));
    const box = [x, baseline - height, x + item.width * viewport.scale, baseline];
    let line = lines.find(line => Math.abs(line.bbox[3] - baseline) < Math.max(3, height * 0.35));
    if (!line) { line = { text: '', bbox: box, parts: [] }; lines.push(line); }
    line.parts.push({ text: item.str, x });
    line.bbox = [Math.min(line.bbox[0], box[0]), Math.min(line.bbox[1], box[1]), Math.max(line.bbox[2], box[2]), Math.max(line.bbox[3], box[3])];
  }
  return lines.sort((a, b) => a.bbox[1] - b.bbox[1]).map(line => ({ text: line.parts.sort((a, b) => a.x - b.x).map(part => part.text).join(' '), bbox: line.bbox }));
}
let input;
async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 12 * 1024 * 1024) throw new Error('材料超过识别容量，请拆分上传。'); chunks.push(chunk); }
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const bytes = Buffer.from(input.contentBase64, 'base64');
  const pages = [];
  fs.mkdirSync(input.cacheDir, { recursive: true });
  if (/\.pdf$/i.test(input.name)) {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF 文件头无效，请检查文件格式。');
    send({ type: 'progress', stage: '读取 PDF 页面与文字层' });
    const pdfjs = await import(pathToFileURL(runtimeRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
    const pdfRoot = path.dirname(runtimeRequire.resolve('pdfjs-dist/package.json'));
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfRoot, 'legacy/build/pdf.worker.mjs')).href;
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, standardFontDataUrl: path.join(pdfRoot, 'standard_fonts').replaceAll('\\', '/') + '/', cMapUrl: path.join(pdfRoot, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true });
    let doc;
    try {
      doc = await task.promise;
      if (doc.numPages > 8) throw new Error('单份 PDF 最多识别 8 页，请先拆分材料。');
      let totalText = 0;
      for (let number = 1; number <= doc.numPages; number++) {
        send({ type: 'progress', stage: `处理 PDF 第 ${number} / ${doc.numPages} 页` });
        const page = await doc.getPage(number);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2.5, Math.sqrt(4_000_000 / (natural.width * natural.height)));
        const viewport = page.getViewport({ scale });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 1 || viewport.height < 1) throw new Error('PDF 页面尺寸无效。');
        const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
        const png = canvas.toBuffer('image/png');
        const content = await page.getTextContent();
        let lines = pdfLines(content.items, viewport);
        let text = lines.map(line => line.text).join('\n');
        let method = 'pdf_text', confidence;
        if (text.replace(/\s/g, '').length < 20) {
          const recognized = await ocr(png);
          text = recognized.text; lines = recognized.lines; confidence = recognized.confidence; method = 'ocr';
        }
        totalText += text.length;
        if (totalText > 120_000) throw new Error('材料文字量超过限制，请按材料类型拆分 PDF。');
        pages.push({ pageNumber: number, method, text, lines, width: canvas.width, height: canvas.height, previewBase64: png.toString('base64'), ...(confidence != null ? { confidence } : {}) });
        canvas.width = 1; canvas.height = 1; page.cleanup();
      }
    } finally { if (doc) await doc.destroy(); else await task.destroy(); }
  } else {
    const signatureMatches = /\.png$/i.test(input.name) ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : /\.jpe?g$/i.test(input.name) && bytes[0] === 255 && bytes[1] === 216;
    if (!signatureMatches) throw new Error('图片内容与文件扩展名不一致，仅支持 PNG / JPG / JPEG。');
    send({ type: 'progress', stage: '校正图片方向并准备 OCR' });
    const { data: png, info } = await sharp(bytes, { limitInputPixels: 24_000_000 }).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const recognized = await ocr(png);
    pages.push({ pageNumber: 1, method: 'ocr', ...recognized, width: info.width, height: info.height, previewBase64: png.toString('base64') });
  }
  send({ type: 'result', result: { pages, engine: 'PDF.js / Tesseract.js 6 (本地 eng+chi_sim)' } });
}
main().catch(error => {
  const message = error?.name === 'PasswordException' ? 'PDF 已加密，请解密后重新上传。' : error?.message || '材料识别失败，请检查文件。';
  send({ type: 'error', message }); process.exitCode = 1;
}).finally(async () => { if (worker) await worker.terminate(); });
