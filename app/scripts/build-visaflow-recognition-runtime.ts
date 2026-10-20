import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Keep the OCR subprocess self-contained: electron-builder excludes generic node_modules. */
export function buildVisaFlowRecognitionRuntime(): void {
  const root = resolve(import.meta.dir, '..')
  const runtime = join(root, 'apps/electron/dist/recognition')
  const installed = new Map<string, string>()
  let count = 0
  function copy(name: string, requester: string, destinationModules: string, optional = false): void {
    // Bun treats node-fetch as a builtin; walk Node's package directories explicitly.
    const search: string[] = []
    for (let directory = requester; ; directory = dirname(directory)) {
      search.push(join(directory, 'node_modules'))
      if (dirname(directory) === directory) break
    }
    const sourcePath = search.map(directory => join(directory, name)).find(directory => existsSync(join(directory, 'package.json')))
    if (!sourcePath) { if (optional) return; throw new Error(`识别运行时缺少依赖 ${name}，请重新安装依赖。`) }
    const source = realpathSync(sourcePath)
    const destination = join(destinationModules, name)
    const previous = installed.get(destination)
    if (previous === source) return
    if (previous) throw new Error(`识别运行时依赖版本冲突：${name}`)
    installed.set(destination, source)
    mkdirSync(destination, { recursive: true })
    cpSync(source, destination, { recursive: true, filter: input => input === source || !input.slice(source.length + 1).split(/[\\/]/).includes('node_modules') })
    count++
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, source, join(destination, 'node_modules'))
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (!(dependency in (manifest.dependencies ?? {}))) copy(dependency, source, join(destination, 'node_modules'), true)
    }
  }
  for (const name of ['tesseract.js', '@tesseract.js-data/eng', '@tesseract.js-data/chi_sim', 'pdfjs-dist', '@napi-rs/canvas', 'sharp']) copy(name, join(root, 'packages/visaflow-core'), join(runtime, 'node_modules'))
  console.log(`Prepared local PDF/OCR runtime (${count} packages, including models and licenses).`)
}
if (import.meta.main) buildVisaFlowRecognitionRuntime()
