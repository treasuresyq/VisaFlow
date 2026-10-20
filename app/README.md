<!-- Modified for VisaFlow: desktop workflow, product configuration and integration updates. See CHANGES.md at the repository root. -->
# VisaFlow

VisaFlow 是签证材料审查与流程编排应用，提供案件管理、材料核验、证据追溯、AI 复核、人工审批和执行记录。

## 业务流程

案件创建 → 材料上传 → 规则选版 → 材料与字段核验 → 风险补正 → 人工审批 → 结果与回执归档。

每次核验都记录使用的规则版本、材料快照和证据引用。补正材料可以替代旧版本，历史材料和历史任务结果仍可追溯。通知内容与收件人在审批前冻结，批准后由工作流执行。

## 桌面界面

- 案件工作台：创建案件、筛选状态、查看材料覆盖和待处理问题。
- 材料核验：上传 PDF、PNG/JPG、JSON/TXT/Markdown，查看提取字段、检查结果和证据位置。
- 材料识别：文字 PDF 直接提取，扫描页与图片使用本地 OCR；对照页图与原文确认字段，原识别结果持续保留。
- 规则版本：按提交日期选择适用 Rule Pack。
- 人工审批：查看冻结通知、批准或拒绝，追踪本地回执。
- 执行记录：查看任务、工具证据和人工决策的事件链。
- Agent 复核：案件专属会话与 MCP 工具，模型连接可配置。

## 技术结构

Electron、React、TypeScript、WebSocket RPC、SQLite、MCP。

`packages/visaflow-core` 包含案件模型、材料解析、规则核验、证据、审批和回放。桌面前端发起业务操作，后端持久化任务后返回受理确认，再通过事件推送进度；页面读取持久化结果进行展示。

## 启动与验证

交付目录的 `启动VisaFlow.cmd` 用于打开桌面应用。`Start-VisaFlow.ps1 -Rebuild` 重新构建源码。`Test-VisaFlow.ps1` 运行业务、协议检查与样例回放。

从源码目录运行：

```powershell
bun install
bun run visaflow:test
bun run visaflow:replay
bun run visaflow:start
```

当前包含正常、缺材料、过期、字段冲突四类样例和两版演示 Rule Pack。通知渠道为本地发件箱，AI 会话使用用户配置的模型服务。

详细演示步骤和验证记录见交付目录的 `DEMO_GUIDE.md` 与 `VALIDATION.md`。
