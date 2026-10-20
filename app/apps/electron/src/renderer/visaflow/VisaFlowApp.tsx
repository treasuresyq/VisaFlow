import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent } from 'react'
import {
  ArrowUpRight, Check, CheckCircle2, ChevronRight, ClipboardCheck,
  FileSearch, FileText, FolderOpen, Layers3, ListChecks, Loader2, MessageSquare,
  Plus, RefreshCw, Search, Send, ShieldCheck, Upload, X, AlertTriangle, Link2,
} from 'lucide-react'
import type { CaseDetail, CaseSummary, RulePack } from '../../../../../packages/visaflow-core/src/types'
import './VisaFlowApp.css'
import MaterialRecognitionDialog from './MaterialRecognitionDialog'

type View = 'cases' | 'materials' | 'rules' | 'approvals' | 'trace'
type DetailTab = 'materials' | 'checks' | 'trace'
type Bridge = {
  visaFlowCall: <T = unknown>(action: string, payload?: unknown) => Promise<T>
  onVisaFlowEvent?: (callback: (event: { caseId?: string; type: string }) => void) => () => void
  switchWorkspace?: (workspaceId: string) => Promise<void>
}
type Bootstrap = { cases: CaseSummary[]; rulePacks: RulePack[] }

const STATUS: Record<string, { label: string; tone: string }> = {
  collecting: { label: '待核验', tone: 'neutral' },
  reviewing: { label: '核验中', tone: 'info' },
  needs_correction: { label: '待补正', tone: 'warn' },
  ready: { label: '核验完成', tone: 'good' },
  awaiting_approval: { label: '待审批', tone: 'warn' },
  notice_sent: { label: '通知已入本地发件箱', tone: 'good' },
  review_failed: { label: '执行失败', tone: 'bad' },
  pending: { label: '待审批', tone: 'warn' },
  approved: { label: '已批准', tone: 'good' },
  rejected: { label: '已拒绝', tone: 'bad' },
  pass: { label: '通过', tone: 'good' },
  fail: { label: '需补正', tone: 'warn' },
  needs_review: { label: '需人工复核', tone: 'warn' },
}
const VIEWS: { id: View; label: string; icon: typeof FolderOpen }[] = [
  { id: 'cases', label: '案件工作台', icon: FolderOpen },
  { id: 'materials', label: '材料核验', icon: FileSearch },
  { id: 'rules', label: '规则版本', icon: ShieldCheck },
  { id: 'approvals', label: '人工审批', icon: ClipboardCheck },
  { id: 'trace', label: '执行记录', icon: ListChecks },
]
const TRACE_LABELS: Record<string, string> = {
  case_created: '案件已创建', material_added: '材料已保存', material_uploaded: '材料已保存',
  review_started: '核验任务启动', review_queued: '核验任务受理', rule_selected: '规则版本已选定',
  tool_result: '工具取证完成', review_completed: '核验任务完成', review_failed: '核验任务失败',
  approval_requested: '补正通知等待审批', approval_decided: '人工审批完成',
  approval_approved: '人工审批通过', approval_rejected: '人工审批拒绝', notice_sent: '通知已写入本地发件箱',
}

function api(): Bridge {
  const bridge = window.electronAPI as unknown as Bridge
  if (typeof bridge?.visaFlowCall !== 'function') throw new Error('VisaFlow 服务未连接，请通过项目启动脚本打开应用。')
  return bridge
}
function call<T>(action: string, payload?: unknown): Promise<T> { return api().visaFlowCall<T>(action, payload) }
function date(value?: string): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
function shortId(value: string): string { return value.length > 16 ? value.slice(0, 8) + '…' + value.slice(-4) : value }
function status(value: string) { const item = STATUS[value] ?? { label: value, tone: 'neutral' }; return <span className={`vf-status ${item.tone}`}><span className="vf-dot" style={{ background: 'currentColor', width: 4, height: 4 }} />{item.label}</span> }
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export default function VisaFlowApp({ onOpenAssistant }: { onOpenAssistant?: (sessionId?: string, prompt?: string) => void }) {
  const [view, setView] = useState<View>('cases')
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [rulePacks, setRulePacks] = useState<RulePack[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CaseDetail | null>(null)
  const [allDetails, setAllDetails] = useState<CaseDetail[]>([])
  const [detailTab, setDetailTab] = useState<DetailTab>('materials')
  const [expandedMaterialId, setExpandedMaterialId] = useState<string | null>(null)
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const [recognitionMaterialId, setRecognitionMaterialId] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [form, setForm] = useState({ applicantName: '', submissionDate: new Date().toISOString().slice(0, 10), customerEmail: '' })
  const fileInput = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(selectedId)
  const viewRef = useRef(view)
  selectedRef.current = selectedId
  viewRef.current = view

  const load = useCallback(async (preferredId?: string) => {
    const data = await call<Bootstrap>('bootstrap')
    setCases(data.cases)
    setRulePacks(data.rulePacks)
    const id = preferredId ?? selectedRef.current ?? data.cases[0]?.id
    if (id && data.cases.some(c => c.id === id)) {
      setSelectedId(id)
      const item = await call<CaseDetail>('getCase', { caseId: id })
      if (preferredId || selectedRef.current === id || !selectedRef.current) setDetail(item)
    } else { setDetail(null); setSelectedId(null) }
    if (viewRef.current === 'approvals' || viewRef.current === 'trace') {
      const records = await Promise.all(data.cases.map(c => call<CaseDetail>('getCase', { caseId: c.id })))
      setAllDetails(records)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    load().catch(e => { if (mounted) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (mounted) setLoading(false) })
    let timer: ReturnType<typeof setTimeout> | undefined
    let cleanup: (() => void) | undefined
    try {
      cleanup = api().onVisaFlowEvent?.(() => {
        clearTimeout(timer)
        timer = setTimeout(() => { if (mounted) load().catch(e => setError(e instanceof Error ? e.message : String(e))) }, 100)
      })
    } catch { /* Initial load reports transport errors. */ }
    return () => { mounted = false; clearTimeout(timer); cleanup?.() }
  }, [load])

  useEffect(() => {
    if (view !== 'approvals' && view !== 'trace') return
    let active = true
    Promise.all(cases.map(c => call<CaseDetail>('getCase', { caseId: c.id })))
      .then(records => { if (active) setAllDetails(records) })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)) })
    return () => { active = false }
  }, [view, cases])
  const recognitionRunning = detail?.materials.some(material => material.active !== false && ['queued', 'running'].includes(material.recognition?.status ?? ''))
  const recognitionPending = detail?.materials.some(material => material.active !== false && ['queued', 'running', 'needs_confirmation'].includes(material.recognition?.status ?? ''))
  useEffect(() => {
    if (!recognitionRunning) return
    const timer = setInterval(() => { void load().catch(() => {}) }, 2000)
    return () => clearInterval(timer)
  }, [recognitionRunning, load])

  const selectCase = async (id: string) => {
    setSelectedId(id); selectedRef.current = id; setDetailLoading(true); setEvidenceId(null)
    try { const item = await call<CaseDetail>('getCase', { caseId: id }); if (selectedRef.current === id) setDetail(item) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setDetailLoading(false) }
  }

  const run = async <T,>(key: string, action: string, payload?: unknown, message?: string): Promise<T | undefined> => {
    if (busy) return
    setBusy(key); setError(''); setNotice('')
    try {
      const result = await call<T>(action, payload)
      await load(action === 'createCase' ? (result as CaseSummary).id : undefined)
      if (message) setNotice(message)
      return result
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined }
    finally { setBusy('') }
  }

  const upload = async (files: FileList | File[]) => {
    if (!selectedId || busy) return
    setBusy('upload'); setError(''); setNotice('')
    try {
      const items = Array.from(files)
      if (!items.length) return
      for (const file of items) {
        if (!/\.(json|txt|md|pdf|png|jpe?g)$/i.test(file.name)) throw new Error(`暂不支持 ${file.name}。请上传 PDF、PNG、JPG、JSON、TXT 或 Markdown。`)
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 超过 8 MB，请先拆分材料。`)
        await call('addMaterial', { caseId: selectedId, name: file.name, mimeType: file.type || (file.name.endsWith('.json') ? 'application/json' : 'text/plain'), contentBase64: await readBase64(file) })
      }
      await load(); setNotice(`${items.length} 份材料已保存。PDF 和图片将后台识别，请确认识别字段后开始核验。`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); await load().catch(() => {}) }
    finally { setBusy('') }
  }

  const createCase = async (event: FormEvent) => {
    event.preventDefault()
    const result = await run<CaseSummary>('create', 'createCase', { ...form, visaType: 'demo-tourist' }, '案件已创建，请添加材料。')
    if (result) { setCreating(false); setView('cases'); setDetailTab('materials'); setForm({ applicantName: '', submissionDate: new Date().toISOString().slice(0, 10), customerEmail: '' }) }
  }

  const prepareAssistant = async () => {
    if (!detail || busy) return
    setBusy('assistant'); setError('')
    try {
      const prepared = await call<{ sessionId: string; workspaceId: string; prompt: string }>('prepareAgentReview', { caseId: detail.id })
      await api().switchWorkspace?.(prepared.workspaceId)
      // Leave execution to the assistant UI so a provider can be configured before sending.
      setNotice('AI 复核会话已创建。打开助手后选择该案件；配置模型后可开始复核。')
      onOpenAssistant?.(prepared.sessionId, prepared.prompt)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const approvals = allDetails.flatMap(c => c.approvals.map(a => ({ ...a, applicantName: c.applicantName })))
  const traces = allDetails.flatMap(c => c.traces.map(t => ({ ...t, caseId: c.id, applicantName: c.applicantName }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const visibleCases = cases.filter(c => (filter === 'all' || (filter === 'needs_correction' ? c.status === 'needs_correction' || c.status === 'review_failed' : c.status === filter)) && `${c.applicantName} ${c.demoLabel ?? ''} ${c.id}`.toLowerCase().includes(query.toLowerCase()))
  const pending = cases.filter(c => c.status === 'awaiting_approval').length
  const activeTask = detail?.tasks.findLast(t => t.status === 'queued' || t.status === 'running')
  const lastTask = detail?.tasks.at(-1)
  const selectedEvidence = detail?.evidence.find(e => e.id === evidenceId)
  const passCount = detail?.checks.filter(c => c.status === 'pass').length ?? 0
  const currentRule = rulePacks.find(r => r.id === detail?.rulePackId)

  return <div className="vf-app">
    <aside className="vf-sidebar">
      <div className="vf-brand"><div className="vf-mark"><Layers3 size={19} strokeWidth={1.6} /></div><div className="vf-brand-text"><strong>VisaFlow</strong><small>VISA OPERATIONS</small></div></div>
      <div className="vf-workspace"><FolderOpen size={17} /><div><strong>签证材料工作空间</strong><small>案件 · 规则 · 证据</small></div></div>
      <div className="vf-nav-caption">WORKSPACE</div>
      <nav className="vf-nav">{VIEWS.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><item.icon size={16} strokeWidth={1.6} /><span>{item.label}</span>{item.id === 'approvals' && pending > 0 && <small className="vf-nav-count">{pending}</small>}</button>)}</nav>
      <div className="vf-sidebar-footer">{onOpenAssistant && <button className="vf-assistant" onClick={() => onOpenAssistant()}><MessageSquare size={13} />打开 Agent 助手<ArrowUpRight size={12} /></button>}<div className="vf-local"><span className="vf-dot" />本地工作空间 · 数据持久化</div></div>
    </aside>
    <div className="vf-shell">
      <header className="vf-topbar"><div className="vf-breadcrumb"><span>VisaFlow</span><ChevronRight size={11} /><strong>{VIEWS.find(v => v.id === view)?.label}</strong></div><div className="vf-top-actions"><span className="vf-demo-pill">场景演示规则</span><button className="vf-icon-button" aria-label="刷新数据" disabled={!!busy} onClick={() => { setLoading(true); load().catch(e => setError(String(e))).finally(() => setLoading(false)) }}><RefreshCw size={13} className={loading ? 'vf-spin' : ''} /></button><span className="vf-avatar">VF</span></div></header>
      <main className="vf-content">
        <div className="vf-heading"><div><div className="vf-eyebrow">MATERIAL VERIFICATION WORKSPACE</div><h1>{view === 'cases' ? '案件工作台' : view === 'materials' ? '材料与核验' : view === 'rules' ? '规则与适用版本' : view === 'approvals' ? '人工审批' : '执行与证据记录'}</h1><p>{view === 'cases' ? '从材料收集到问题定位，让每一次核验都有据可查。' : view === 'materials' ? '查看原始字段、运行核验，并追溯每条结论的材料来源。' : view === 'rules' ? '按正式提交日期选择版本，核验结果记录所用规则。' : view === 'approvals' ? '核对冻结内容，批准后写入本地通知发件箱。' : '查看任务、工具证据与人工决策的完整执行过程。'}</p></div><div className="vf-actions"><button className="vf-button" disabled={!!busy} onClick={() => run('seed', 'seedDemoCases', undefined, '示例案件已准备好：正常、缺件、过期与字段冲突。')}><PlayIcon busy={busy === 'seed'} />载入示例</button><button className="vf-button primary" onClick={() => setCreating(true)}><Plus size={13} />新建案件</button></div></div>
        {error && <div className="vf-error"><AlertTriangle size={15} /><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={13} /></button></div>}
        {notice && <div className="vf-toast"><CheckCircle2 size={14} />{notice}<button className="vf-button ghost small" style={{ marginLeft: 'auto' }} onClick={() => setNotice('')} aria-label="关闭提示"><X size={11} /></button></div>}
        {loading && !cases.length ? <div className="vf-loading"><Loader2 size={17} className="vf-spin" />正在读取本地案件…</div> : <>
          {(view === 'cases' || view === 'materials') && <>
            <div className="vf-metrics"><Metric label="全部案件" value={cases.length} note="当前工作空间" icon={FolderOpen} /><Metric label="待补正" value={cases.filter(c => c.status === 'needs_correction').length} note="材料缺口或字段异常" icon={FileSearch} /><Metric label="待人工审批" value={pending} note="敏感操作需批准" icon={ClipboardCheck} /><Metric label="核验完成" value={cases.filter(c => c.status === 'ready' || c.status === 'notice_sent').length} note="结果与证据已保存" icon={ShieldCheck} /></div>
            <div className="vf-workarea"><div className="vf-main-column"><section className="vf-section"><div className="vf-section-toolbar"><div className="vf-section-title">案件列表 <small>{cases.length} 个案件</small></div><div className="vf-search"><Search size={13} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索申请人或案件编号" aria-label="搜索案件" /></div></div><div className="vf-filters">{[{ key: 'all', label: '全部' }, { key: 'collecting', label: '待核验' }, { key: 'needs_correction', label: '待补正' }, { key: 'ready', label: '已完成' }].map(f => <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
              {!visibleCases.length ? <Empty title={cases.length ? '没有匹配的案件' : '准备你的第一个案件'} text={cases.length ? '试试其他搜索词或状态。' : '创建案件并上传材料，或载入可核验的场景样例。'} /> : <div className="vf-table-wrap"><table className="vf-table"><thead><tr><th>申请人 / 案件</th><th>提交日期</th><th>材料</th><th>状态</th><th /></tr></thead><tbody>{visibleCases.map(c => <tr key={c.id} className={`clickable ${selectedId === c.id ? 'selected' : ''}`} onClick={() => selectCase(c.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') selectCase(c.id) }}><td><div className="vf-case-name"><span className="vf-case-initial">{c.applicantName.slice(0, 1)}</span><div><div className="vf-case-title">{c.demoLabel ?? c.applicantName}</div><div className="vf-case-id">{c.demoLabel ? c.applicantName : shortId(c.id)}</div></div></div></td><td className="vf-muted">{c.submissionDate}</td><td className="vf-muted">{c.materialCount} 份</td><td>{status(c.status)}</td><td><ChevronRight size={12} className="vf-muted" /></td></tr>)}</tbody></table></div>}</section><div className="vf-page-note"><ShieldCheck size={13} /><span>示例规则用于验证流程与工程能力。正式办理前，请由执行人员核对官方要求。</span></div></div>
              <aside className="vf-detail">{detailLoading ? <div className="vf-loading"><Loader2 className="vf-spin" size={16} />读取案件…</div> : !detail ? <Empty title="选择一个案件" text="材料、核验结果与执行记录会显示在这里。" /> : <>
                <div className="vf-detail-head"><div className="vf-detail-head-top"><span className="vf-detail-label">CASE DETAIL</span>{status(detail.status)}</div><h2>{detail.demoLabel ?? detail.applicantName}</h2><div className="vf-detail-meta"><span>{detail.demoLabel ? detail.applicantName : shortId(detail.id)}</span><span>提交于 {detail.submissionDate}</span></div></div>
                <div className="vf-detail-tabs">{[{ id: 'materials' as const, label: '材料' }, { id: 'checks' as const, label: '核验结果' }, { id: 'trace' as const, label: '执行记录' }].map(t => <button key={t.id} className={detailTab === t.id ? 'active' : ''} onClick={() => { setDetailTab(t.id); setEvidenceId(null) }}>{t.label}{t.id === 'checks' && detail.checks.length > 0 ? ` · ${detail.checks.length}` : ''}</button>)}</div>
                <div className="vf-detail-body">
                  {detailTab === 'materials' && <><div className="vf-detail-summary"><div><label>签证类型</label><strong>旅游签证 · 演示</strong></div><div><label>所用规则</label><strong>{currentRule?.version ?? '核验时选择'}</strong></div><div><label>当前有效材料</label><strong>{detail.materials.filter(m => m.active !== false).length} 份</strong></div><div><label>待处理问题</label><strong>{detail.issueCount} 项</strong></div></div><hr className="vf-divider" /><h3 className="vf-mini-heading">材料清单 <small>点击查看提取字段</small></h3>{detail.materials.map(m => <div key={m.id}><button className="vf-material vf-material-button" onClick={() => setExpandedMaterialId(expandedMaterialId === m.id ? null : m.id)}><span className="vf-material-icon"><FileText size={14} /></span><div className="vf-material-content"><div className="vf-material-name" title={m.name}>{m.name}</div><div className="vf-material-meta">{({ passport: '护照', bank_statement: '银行流水', application: '申请表', unknown: '未识别' })[m.fields.documentType]} · {date(m.uploadedAt)}</div>{m.active === false && <div className="vf-material-meta" style={{ color: '#b49d81' }}>已被补正替代 · 保留历史证据</div>}{m.parseError && <div className="vf-material-meta" style={{ color: '#bc6a54' }}>{m.parseError}</div>}</div><ChevronRight size={12} color="#9aaa9d" /></button>{m.recognition && <div className="vf-ocr-state">{['queued', 'running'].includes(m.recognition.status) && <Loader2 size={12} className="vf-spin" />}<span>{m.recognition.stage}</span>{['needs_confirmation', 'confirmed'].includes(m.recognition.status) && <button className="vf-button small" onClick={() => setRecognitionMaterialId(m.id)}>{m.recognition.status === 'needs_confirmation' ? '核对识别字段' : '查看识别原文'}</button>}{m.active !== false && m.recognition.status === 'failed' && <button className="vf-button small" disabled={!!busy} onClick={() => run('retry', 'retryMaterialRecognition', { caseId: detail.id, materialId: m.id })}>重试识别</button>}</div>}{expandedMaterialId === m.id && <div className="vf-evidence" style={{ marginTop: -3 }}><h4>提取字段</h4><dl>{Object.entries(m.fields).map(([key, value]) => <div key={key} style={{ display: 'contents' }}><dt>{({ documentType: '材料类型', applicantName: '申请人', passportNumber: '护照号', expiryDate: '到期日期', issuedDate: '开具日期', balance: '余额' } as Record<string, string>)[key] ?? key}</dt><dd>{String(value)}</dd></div>)}<dt>内容哈希</dt><dd>{m.sha256}</dd>{m.supersededBy && <><dt>替代材料</dt><dd>{m.supersededBy}</dd></>}</dl></div>}</div>)}
                    <input type="file" multiple accept=".json,.txt,.md,.pdf,.png,.jpg,.jpeg" ref={fileInput} style={{ display: 'none' }} onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) upload(e.target.files); e.target.value = '' }} />
                    <div className={`vf-upload ${dragging ? 'drag' : ''}`} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click() }} onClick={() => !busy && fileInput.current?.click()} onDragOver={(e: DragEvent) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files) }}>{busy === 'upload' ? <Loader2 size={18} className="vf-spin" /> : <Upload size={18} />}<strong>{busy === 'upload' ? '正在保存材料…' : '点击上传或拖放材料到这里'}</strong><span>PDF / PNG / JPG / JSON / TXT / Markdown · 最大 8 MB，PDF 最多 8 页</span></div>
                    <div className="vf-review-callout"><h3 className="vf-mini-heading" style={{ marginBottom: 0 }}><ShieldCheck size={12} />按规则进行材料核验</h3><p>{activeTask ? `${activeTask.stage} · ${activeTask.progress}%` : '检查材料覆盖、护照有效期、日期与跨材料字段一致性。'}</p>{activeTask && <progress value={activeTask.progress} max={100} style={{ width: '100%', marginTop: 10, accentColor: '#198674' }} />}</div>
                    <button className="vf-button primary full" disabled={!!busy || !!activeTask || !!recognitionPending || !detail.materials.length} onClick={async () => { const result = await run('review', 'startReview', { caseId: detail.id }); if (result) setDetailTab('checks') }}>{activeTask || busy === 'review' ? <Loader2 size={13} className="vf-spin" /> : <FileSearch size={13} />}{activeTask ? '核验进行中' : detail.checks.length ? '重新核验材料' : '开始材料核验'}</button>
                  </>}
                  {detailTab === 'checks' && <>{!detail.checks.length ? <Empty title={activeTask ? '正在核验材料' : '还没有核验结果'} text={activeTask ? `${activeTask.stage} · ${activeTask.progress}%` : '添加材料后运行核验，结果将附带证据引用。'} /> : <><div className="vf-report-meta"><span>{currentRule?.name ?? detail.rulePackId}</span><span>{currentRule?.version}</span></div><div className="vf-report-summary">已完成 {detail.checks.length} 项检查，{passCount} 项通过，{detail.checks.length - passCount} 项需要处理。点击下方证据编号查看材料原文与位置。</div>{detail.checks.map(check => <div className="vf-check" key={check.id}><div className="vf-check-head">{check.status === 'pass' ? <CheckCircle2 size={14} className="pass" /> : <AlertTriangle size={14} className="fail" />}<strong>{check.label}</strong><span style={{ marginLeft: 'auto' }}>{status(check.status)}</span></div><p>{check.message}</p><div className="vf-evidence-links">{check.evidenceIds.map(id => <button key={id} onClick={() => setEvidenceId(evidenceId === id ? null : id)}><Link2 size={9} />{shortId(id)}</button>)}</div></div>)}</>}
                    {lastTask?.error && <div className="vf-error" style={{ marginTop: 12 }}>{lastTask.error}</div>}
                    {selectedEvidence && <div className="vf-evidence"><h4>证据详情</h4><dl><dt>证据编号</dt><dd>{selectedEvidence.id}</dd><dt>来源</dt><dd>{selectedEvidence.source}</dd><dt>位置</dt><dd>{selectedEvidence.location}</dd><dt>内容哈希</dt><dd>{selectedEvidence.sha256}</dd></dl><blockquote>{selectedEvidence.excerpt}</blockquote></div>}
                    {detail.checks.length > 0 && <><hr className="vf-divider" />{onOpenAssistant && <button className="vf-button full" disabled={!!busy || !!activeTask || !!recognitionPending} style={{ marginBottom: 8 }} onClick={prepareAssistant}><MessageSquare size={12} />在 Agent 助手中复核</button>}{detail.issueCount > 0 && <><button className="vf-button full" disabled={!!busy || !!activeTask || !!recognitionPending} onClick={async () => { const result = await run('notice', 'requestNotice', { caseId: detail.id }, '补正通知已冻结，等待人工审批。'); if (result) setView('approvals') }}><Send size={12} />生成补正通知并申请审批</button><div className="vf-page-note">批准后仅写入本地发件箱，不会向真实客户发送。</div></>}</>}
                  </>}
                  {detailTab === 'trace' && <TraceTimeline records={detail.traces} />}
                </div>
              </>}</aside>
            </div>
          </>}
          {view === 'rules' && <><div className="vf-rule-grid">{rulePacks.map(rule => <section className="vf-rule-card" key={rule.id}><div className="vf-rule-card-header"><div className="vf-rule-card-icon"><ShieldCheck size={19} /></div><div><h3>{rule.name}</h3><p>{rule.id}</p></div><span style={{ marginLeft: 'auto' }} className="vf-status good">{rule.version}</span></div><dl><dt>生效日期</dt><dd>{rule.effectiveFrom}</dd><dt>适用依据</dt><dd>正式提交日期</dd><dt>规则范围</dt><dd>旅游签证 · 场景演示</dd><dt>护照有效期</dt><dd>提交日起至少 {rule.passportValidityMonths} 个月</dd><dt>银行证明时效</dt><dd>{rule.bankStatementMaxAgeDays} 天以内</dd></dl><div className="vf-rule-list">{rule.requiredDocuments.map(doc => <span key={doc}><Check size={11} />必需材料：{({ passport: '护照', bank_statement: '银行流水', application: '申请表' })[doc]}</span>)}</div></section>)}</div><div className="vf-page-note"><ShieldCheck size={14} />以上为项目演示 Rule Pack，不构成使领馆正式办理要求。每次核验都保留所选版本。</div></>}
          {view === 'approvals' && <>{!approvals.length ? <section className="vf-section"><Empty title="当前没有审批单" text="先在案件核验结果中生成补正通知，系统会冻结收件人与内容。" /></section> : approvals.map(a => <section className="vf-approval-card" key={a.id}><div className="vf-approval-head"><h3>{a.applicantName} · 补正通知</h3>{status(a.status)}</div><div className="vf-page-note" style={{ marginTop: 7 }}>收件人：{a.recipient} · {shortId(a.id)}</div><div className="vf-approval-content">{a.frozenContent}</div><div className="vf-approval-footer"><span>{date(a.createdAt)} · 本地通知演示</span><div className="vf-actions">{a.status === 'pending' ? <><button className="vf-button danger small" disabled={!!busy} onClick={() => run(`reject:${a.id}`, 'decideApproval', { approvalId: a.id, approved: false }, '审批已拒绝，通知不会执行。')}><X size={11} />拒绝</button><button className="vf-button primary small" disabled={!!busy} onClick={() => run(`approve:${a.id}`, 'decideApproval', { approvalId: a.id, approved: true }, '审批已通过，通知已写入本地发件箱。')}><Check size={11} />批准</button></> : <span className="vf-muted">{a.deliveryStatus === 'sent' ? `本地回执：${a.receipt?.id ? shortId(a.receipt.id) : '已保存'}` : a.deliveryStatus === 'uncertain' ? '结果存疑，需人工核实' : '未执行发送'}</span>}</div></div><details style={{ fontSize: 9, color: '#a0afa3', marginTop: 12 }}><summary>查看冻结内容哈希</summary><p style={{ overflowWrap: 'anywhere' }}>{a.contentHash}</p></details></section>)}</>}
          {view === 'trace' && <section className="vf-section"><div className="vf-section-toolbar"><div className="vf-section-title">执行记录 <small>{traces.length} 条</small></div><span className="vf-muted" style={{ fontSize: 10 }}>保留任务、材料与审批依据</span></div><div style={{ padding: '22px 24px' }}>{traces.length ? <TraceTimeline records={traces} showApplicant /> : <Empty title="还没有执行记录" text="创建案件或运行核验后，过程会在这里留下记录。" />}</div></section>}
        </>}
      </main>
    </div>
    {recognitionMaterialId && detail && <MaterialRecognitionDialog caseId={detail.id} materialId={recognitionMaterialId} call={call} onClose={() => setRecognitionMaterialId(null)} onSaved={async () => { await load(); setNotice('识别字段已确认，原始材料和识别结果已保留，可以开始核验。') }} />}
    {creating && <div className="vf-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setCreating(false) }}><form className="vf-modal" onSubmit={createCase}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2>新建核验案件</h2><button type="button" className="vf-icon-button" onClick={() => setCreating(false)} aria-label="关闭新建案件"><X size={14} /></button></div><p>建立案件范围，再上传申请材料。核验将按正式提交日期选择适用的演示规则。</p><label htmlFor="vf-applicant">申请人姓名</label><input id="vf-applicant" required maxLength={80} value={form.applicantName} onChange={e => setForm({ ...form, applicantName: e.target.value })} placeholder="例如：张三" autoFocus /><div className="vf-modal-grid"><div><label>签证类型</label><select aria-label="签证类型" value="demo-tourist" disabled><option value="demo-tourist">旅游签证 · 演示</option></select></div><div><label htmlFor="vf-date">正式提交日期</label><input id="vf-date" required type="date" value={form.submissionDate} onChange={e => setForm({ ...form, submissionDate: e.target.value })} /></div></div><label htmlFor="vf-email">通知收件人（可选）</label><input id="vf-email" type="email" value={form.customerEmail} onChange={e => setForm({ ...form, customerEmail: e.target.value })} placeholder="仅用于本地通知演示" /><div className="vf-modal-footer"><button type="button" className="vf-button" onClick={() => setCreating(false)}>取消</button><button type="submit" className="vf-button primary" disabled={!!busy}>{busy === 'create' && <Loader2 size={12} className="vf-spin" />}创建案件</button></div></form></div>}
  </div>
}

function Metric({ label, value, note, icon: Icon }: { label: string; value: number; note: string; icon: typeof FolderOpen }) {
  return <section className="vf-metric"><div className="vf-metric-top"><span>{label}</span><Icon className="vf-metric-icon" size={15} strokeWidth={1.5} /></div><div className="vf-metric-value">{String(value).padStart(2, '0')}</div><div className="vf-metric-note">{note}</div></section>
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="vf-empty"><FileText size={26} strokeWidth={1.2} /><strong>{title}</strong><span>{text}</span></div> }
function PlayIcon({ busy }: { busy: boolean }) { return busy ? <Loader2 size={12} className="vf-spin" /> : <Layers3 size={12} /> }
function TraceTimeline({ records, showApplicant = false }: { records: CaseDetail['traces'] & { applicantName?: string }[]; showApplicant?: boolean }) {
  if (!records.length) return <Empty title="还没有执行记录" text="操作与核验过程会自动保存在这里。" />
  return <ol className="vf-timeline">{[...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => <li key={record.id}><time>{date(record.createdAt)}</time><strong>{TRACE_LABELS[record.type] ?? record.type}{showApplicant && record.applicantName ? ` · ${record.applicantName}` : ''}</strong><details><summary style={{ fontSize: 10, color: '#829789', cursor: 'pointer' }}>查看记录详情</summary><pre style={{ fontSize: 9, color: '#829789', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 8 }}>{JSON.stringify(record.data, null, 2)}</pre></details></li>)}</ol>
}
