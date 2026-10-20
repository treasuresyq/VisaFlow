import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { DocumentExtraction, MaterialFields, VisaMaterial } from '../../../../../packages/visaflow-core/src/types'

type RecognitionDetail = { material: VisaMaterial; extraction?: DocumentExtraction; text: string }
export default function MaterialRecognitionDialog({ caseId, materialId, call, onClose, onSaved }: {
  caseId: string; materialId: string
  call: <T>(action: string, payload?: unknown) => Promise<T>
  onClose: () => void; onSaved: () => Promise<void>
}) {
  const [detail, setDetail] = useState<RecognitionDetail | null>(null)
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [pageNumber, setPageNumber] = useState(1)
  const [note, setNote] = useState('')
  const [highlight, setHighlight] = useState<[number, number, number, number] | undefined>()
  const [fields, setFields] = useState({ documentType: 'unknown', applicantName: '', passportNumber: '', expiryDate: '', issuedDate: '', balance: '' })
  useEffect(() => {
    let active = true
    call<RecognitionDetail>('getMaterialRecognition', { caseId, materialId }).then(result => {
      if (!active) return
      setDetail(result)
      const values = result.material.fields
      setFields({ documentType: values.documentType, applicantName: values.applicantName ?? '', passportNumber: values.passportNumber ?? '', expiryDate: values.expiryDate ?? '', issuedDate: values.issuedDate ?? '', balance: values.balance == null ? '' : String(values.balance) })
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [caseId, materialId, call])
  const page = detail?.extraction?.pages.find(item => item.pageNumber === pageNumber)
  const editable = detail?.material.active !== false && detail?.material.recognition?.status === 'needs_confirmation'
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const confirmed: MaterialFields = { documentType: fields.documentType as MaterialFields['documentType'] }
      for (const key of ['applicantName', 'passportNumber', 'expiryDate', 'issuedDate'] as const) if (fields[key].trim()) confirmed[key] = fields[key].trim()
      if (fields.balance.trim()) confirmed.balance = Number(fields.balance)
      await call('confirmMaterialFields', { caseId, materialId, fields: confirmed, note })
      await onSaved(); onClose()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  return <div className="vf-modal-backdrop"><section className="vf-modal vf-recognition-modal" role="dialog" aria-modal="true" aria-labelledby="vf-recognition-title">
    <header className="vf-recognition-heading"><div><div className="vf-eyebrow">DOCUMENT RECOGNITION</div><h2 id="vf-recognition-title">{editable ? '核对识别字段' : '识别原文与字段'}</h2><p>{detail?.material.name} · 本地识别 · 证据保留原始文件校验值</p></div><button className="vf-icon-button" aria-label="关闭识别窗口" onClick={onClose} disabled={saving}><X size={18} /></button></header>
    {error && <div className="vf-error" role="alert">{error}</div>}
    {!detail ? <div className="vf-loading"><Loader2 className="vf-spin" size={18} />读取材料…</div> : <div className="vf-recognition-columns">
      <div className="vf-recognition-source"><div className="vf-recognition-page-picker"><strong>原始页面与识别文字</strong><select aria-label="识别页码" value={pageNumber} onChange={event => { setPageNumber(Number(event.target.value)); setHighlight(undefined) }}>{detail.extraction?.pages.map(item => <option key={item.pageNumber} value={item.pageNumber}>第 {item.pageNumber} 页 · {item.method === 'ocr' ? 'OCR' : '文字层提取'}</option>)}</select></div>
        {page?.previewBase64 && <svg className="vf-recognition-preview" role="img" aria-label={`材料第 ${pageNumber} 页`} viewBox={`0 0 ${page.width} ${page.height}`}><image href={`data:image/png;base64,${page.previewBase64}`} width={page.width} height={page.height} />{highlight && <rect x={highlight[0]} y={highlight[1]} width={Math.max(1, highlight[2] - highlight[0])} height={Math.max(1, highlight[3] - highlight[1])} fill="#eebf2b44" stroke="#d4910a" strokeWidth={Math.max(2, page.width / 400)} />}</svg>}
        <details open><summary>第 {pageNumber} 页原文</summary><pre>{page?.text || detail.text || detail.material.recognition?.error || '暂无可读取的文字'}</pre></details>
        <small>SHA256：{detail.material.sha256}</small>
      </div>
      <form onSubmit={submit} className="vf-recognition-fields"><h3>{editable ? '确认后用于材料核验' : '已保存的材料字段'}</h3>
        {(detail.material.recognition?.warnings ?? []).map((warning, index) => <div className="vf-recognition-warning" key={index}>{warning}</div>)}
        <label>材料类型<select disabled={!editable || saving} aria-label="识别材料类型" value={fields.documentType} onChange={event => setFields({ ...fields, documentType: event.target.value })}><option value="unknown">请选择材料类型</option><option value="passport">护照</option><option value="bank_statement">银行流水</option><option value="application">申请表</option></select></label>
        {([['applicantName', '姓名'], ['passportNumber', '护照号码'], ['expiryDate', '到期日期'], ['issuedDate', '出具日期'], ['balance', '余额']] as const).map(([key, label]) => {
          const source = detail.extraction?.fieldSources[key]
          return <label key={key}>{label}<input aria-label={`识别${label}`} disabled={!editable || saving} type={key === 'expiryDate' || key === 'issuedDate' ? 'date' : key === 'balance' ? 'number' : 'text'} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} />{source && <button type="button" className="vf-source-link" onClick={() => { setPageNumber(source.pageNumber); setHighlight(source.bbox) }}>第 {source.pageNumber} 页依据：{source.excerpt.slice(0, 100)}</button>}</label>
        })}
        {editable ? <><label>核对说明<textarea aria-label="识别核对说明" required maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="记录对照原图的依据、修正内容或尚缺的字段" /></label><p>缺失字段可以保留为空，后续规则核验会提示。确认将生成新材料版本，保留原识别结果。</p><button className="vf-button primary" disabled={saving || fields.documentType === 'unknown'}>{saving ? <Loader2 className="vf-spin" size={14} /> : null}确认字段并保存</button></> : <p>{detail.material.recognition?.confirmationNote || detail.material.recognition?.error}</p>}
      </form>
    </div>}
  </section></div>
}
