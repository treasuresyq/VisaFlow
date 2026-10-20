import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { VisaFlowService } from './service.ts'

test('stdio MCP tools execute real scoped review and cannot grant their own approval', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'visaflow-mcp-test-'))
  const service = new VisaFlowService({ dataDir, autoRunTasks: false })
  service.seedDemoCases()
  const cases = service.listCases()
  const target = cases.find(value => service.getCase(value.id).traces.some(event => event.data.fixture === 'missing'))!
  const other = cases.find(value => value.id !== target.id)!
  service.close()
  Bun.gc(true)
  const client = new Client({ name: 'visaflow-mcp-test', version: '0.1.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['run', fileURLToPath(new URL('./mcp.ts', import.meta.url))], env: { VISAFLOW_DATA_DIR: dataDir, VISAFLOW_CASE_ID: target.id } })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(7)
    expect(listed.tools.some(tool => /approve|decide|send_notice/.test(tool.name))).toBe(false)
    const wrongScope = await client.callTool({ name: 'list_materials', arguments: { caseId: other.id } })
    expect(wrongScope.isError).toBe(true)
    const reviewed = await client.callTool({ name: 'run_material_review', arguments: { caseId: target.id } })
    expect(reviewed.isError).not.toBe(true)
    const firstBlock = (reviewed.content as { type: string; text?: string }[])[0]
    expect(JSON.parse(firstBlock!.text!).status).toBe('needs_correction')
    const pending = await client.callTool({ name: 'request_correction_notice', arguments: { caseId: target.id } })
    const pendingBlock = (pending.content as { type: string; text?: string }[])[0]
    expect(JSON.parse(pendingBlock!.text!).status).toBe('pending')
    const check = new VisaFlowService({ dataDir, autoRunTasks: false, recoverOnStart: false })
    expect(check.getOutbox(target.id)).toHaveLength(0)
    expect(check.getCase(target.id).approvals).toHaveLength(1)
    check.close()
  } finally {
    await client.close()
    await transport.close()
    Bun.gc(true)
    const targetPath = resolve(dataDir)
    if (targetPath.startsWith(resolve(tmpdir()) + sep) && targetPath.includes('visaflow-mcp-test-')) rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 15000)
