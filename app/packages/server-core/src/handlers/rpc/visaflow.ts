import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { CONFIG_DIR, getWorkspaces, addWorkspace } from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { VisaFlowService } from '../../../../visaflow-core/src/index'

function object(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid VisaFlow request')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${field}`)
  return value.trim()
}

export function registerVisaFlowHandlers(server: RpcServer, deps: HandlerDeps): void {
  const dataDir = process.env.VISAFLOW_DATA_DIR || join(CONFIG_DIR, 'visaflow')
  const service = new VisaFlowService({
    dataDir,
    onEvent: (event) => server.push(RPC_CHANNELS.visaflow.EVENT, { to: 'all' }, event),
  })

  server.handle(RPC_CHANNELS.visaflow.CALL, async (_ctx, action: unknown, raw: unknown) => {
    const payload = object(raw)
    switch (action) {
      case 'bootstrap':
        return { cases: service.listCases(), rulePacks: service.getRulePacks() }
      case 'listCases': return service.listCases()
      case 'getCase': return service.getCase(text(payload.caseId, 'caseId'))
      case 'getRulePacks': return service.getRulePacks()
      case 'exportTrace': return service.exportTrace(text(payload.caseId, 'caseId'))
      case 'getRawMaterial': return service.getRawMaterial(text(payload.caseId, 'caseId'), text(payload.materialId, 'materialId'))
      case 'getMaterialRecognition': return service.getMaterialRecognition(text(payload.caseId, 'caseId'), text(payload.materialId, 'materialId'))
      case 'retryMaterialRecognition': return service.retryMaterialRecognition(text(payload.caseId, 'caseId'), text(payload.materialId, 'materialId'))
      case 'confirmMaterialFields': return service.confirmMaterialFields(text(payload.caseId, 'caseId'), text(payload.materialId, 'materialId'), object(payload.fields) as unknown as import('../../../../visaflow-core/src/types').MaterialFields, text(payload.note, '核对说明'))
      case 'getOutbox': return service.getOutbox(text(payload.caseId, 'caseId'))
      case 'createCase':
        return service.createCase({
          applicantName: text(payload.applicantName, 'applicantName'),
          visaType: text(payload.visaType, 'visaType'),
          submissionDate: text(payload.submissionDate, 'submissionDate'),
          customerEmail: typeof payload.customerEmail === 'string' ? payload.customerEmail : undefined,
        })
      case 'addMaterial':
        return service.addMaterial(text(payload.caseId, 'caseId'), {
          name: text(payload.name, 'name'),
          mimeType: text(payload.mimeType, 'mimeType'),
          contentBase64: text(payload.contentBase64, 'contentBase64'),
        })
      case 'startReview': return service.startReview(text(payload.caseId, 'caseId'))
      case 'requestNotice': return service.requestNotice(text(payload.caseId, 'caseId'))
      case 'decideApproval':
        if (typeof payload.approved !== 'boolean') throw new Error('Missing approval decision')
        return service.decideApproval(text(payload.approvalId, 'approvalId'), payload.approved)
      case 'seedDemoCases': return service.seedDemoCases()
      case 'prepareAgentReview': {
        const caseData = service.getCase(text(payload.caseId, 'caseId'))
        const workspacePath = join(dataDir, 'agent-workspaces', caseData.id)
        mkdirSync(workspacePath, { recursive: true })
        const workspace = getWorkspaces().find(w => w.rootPath === workspacePath)
          ?? addWorkspace({ name: `VisaFlow · ${caseData.applicantName}`, rootPath: workspacePath })
        const sourceDir = join(workspacePath, 'sources', 'visaflow-tools')
        const skillDir = join(workspacePath, 'skills', 'visaflow-review')
        mkdirSync(sourceDir, { recursive: true })
        mkdirSync(skillDir, { recursive: true })
        const mcpEntry = process.env.VISAFLOW_MCP_ENTRY || join(process.cwd(), 'packages', 'visaflow-core', 'src', 'mcp.ts')
        writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
          id: `visaflow-tools-${caseData.id}`, name: 'VisaFlow 案件工具', slug: 'visaflow-tools',
          enabled: true, provider: 'visaflow', type: 'mcp', icon: '🛂',
          tagline: '仅当前案件的材料、规则与证据；审批决定由人工界面完成。',
          mcp: { transport: 'stdio', command: process.env.CRAFT_BUN || 'bun', args: [mcpEntry],
            env: { VISAFLOW_DATA_DIR: dataDir, VISAFLOW_CASE_ID: caseData.id } },
        }, null, 2), 'utf8')
        writeFileSync(join(sourceDir, 'guide.md'), '# VisaFlow 案件工具\n\n工具固定绑定当前案件。先查询演示规则和检查报告，再按证据编号核对材料。不得把演示规则当作官方签证政策。只能申请审批，不能自行批准或对外发送。\n', 'utf8')
        writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: visaflow-review\ndescription: 核对当前签证演示案件的材料、规则与证据，生成可追溯的复核说明。\n---\n\n先读取当前案件和适用规则，再读取核验报告。每个判断引用证据编号；缺失或冲突要明确标出。不得自行生成缺失字段，不得批准通知或正式提交。最终输出：已核验事实、问题与证据、待人工确认事项。\n', 'utf8')
        const session = await deps.sessionManager.createSession(workspace.id, {
          name: `VisaFlow · ${caseData.applicantName}`,
          permissionMode: 'safe',
          enabledSourceSlugs: ['visaflow-tools'],
        })
        const prompt = [
          '你是 VisaFlow 签证材料复核助手。以下规则为演示规则，不能当成官方签证政策。',
          '使用已启用的 visaflow-tools 读取当前案件、规则和证据；只复核当前案件，必须引用证据编号。不得编造缺失材料、不得对外发送或正式提交。',
          '把结论整理为：已验证事实、冲突或缺口、待人工确认事项。规则工具的结果优先于你的猜测。',
          JSON.stringify(caseData, null, 2),
        ].join('\n\n')
        return { sessionId: session.id, workspaceId: workspace.id, prompt }
      }
      default: throw new Error(`Unsupported VisaFlow action: ${String(action)}`)
    }
  })
}
