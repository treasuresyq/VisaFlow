# VisaFlow 变更记录

## 2026-10-19 · PDF 与护照图片识别

- 接入 PDF.js 文字提取与页面渲染、Tesseract.js 本地中英文 OCR，支持 PDF、PNG、JPG、JPEG。
- 新增持久化识别状态、后台任务、失败重试、超时与服务重启恢复。
- 增加字段提取、护照机读码校验、原文页码及区域坐标；保存不确定性和缺失字段。
- 桌面增加页面预览、字段依据定位与人工确认；确认生成新的材料版本，保留原识别结果与文件哈希。
- 识别中及待确认材料无法直接核验；新确认结果使旧核验和待审批通知失效。
- 提供合成 PDF、图片、扫描件以及真实解析/OCR 与流程回归测试。

## 2026-10-13 · 桌面业务工作流与公开仓库准备

### 业务核心

- 新增 `packages/visaflow-core`，实现案件、材料、规则、核验任务、证据、审批与本地发件箱的领域类型和 SQLite 持久化服务。
- 加入 JSON、TXT、Markdown 字段解析，材料版本替换、日期校验、姓名及证件号一致性检查。
- 按计划提交日期选择示例 Rule Pack，提供正常、缺材料、证件过期、跨材料冲突四类合成样例。
- 核验任务先持久化受理，再在后台运行；保存冻结材料快照、证据引用与 Trace。
- 补正通知冻结内容、收件人、工具调用及检查点；条件更新和唯一约束控制审批与本地回执的重复执行。

### 桌面界面与业务入口

- 新增 `apps/electron/src/renderer/visaflow` 案件工作台，包含材料上传、核验结果、证据查看、人工审批和执行记录。
- 新增 `packages/server-core/src/handlers/rpc/visaflow.ts`，通过 `visaflow:call` 处理业务操作、`visaflow:event` 推送进度和状态变化。
- 统一桌面窗口、菜单、欢迎页与模型配置的 VisaFlow 产品展示。
- 新增根目录 Windows 启动与测试脚本，按相对目录组织依赖准备、构建、运行数据与日志。

### MCP 与模型复核

- 新增案件范围绑定的 stdio MCP 工具，查询规则、材料与证据，执行核验、读取结果和准备待审批补正通知。
- 增加案件专属模型会话、工具配置与复核草稿入口。
- 区分执行核验与读取已有报告，读取结果明确返回当前核验状态、任务编号和下一步提示。
- 材料变更后历史任务保留，但旧结果不作为当前已完成报告返回。

### 验证与文档

- 新增核心服务测试、MCP 测试与真实 stdio 工具边界回归。
- 新增 CLI 样例回放，检查四类核验结果及可解析的证据引用。
- 记录桌面上传、核验、审批、防重与重新启动后的持久化验证。
- 提供演示指南、验证记录、合成材料与桌面截图。
- 加入根目录忽略规则，保留源码与测试，排除本机运行配置、数据库、依赖、构建输出和测试输出。

源码路径在应用源码目录内解析。具体行为与验证范围见 [README](README.md)、[验证记录](VALIDATION.md)和[工具边界验证](TOOL_BOUNDARY_VALIDATION.md)。

## 修改文件声明

以下已有文件已在 VisaFlow 版本中修改；源码文件头保留对应修改提示，原有许可证与归属通知保留在 LICENSE 和 NOTICE 中。

| 文件（相对 `app/`） | 修改内容 |
| --- | --- |
| `README.md` | VisaFlow 产品及运行说明 |
| `package.json`、`bun.lock` | 业务脚本、工作区依赖及锁文件 |
| `apps/electron/package.json`、`apps/electron/electron-builder.yml` | 桌面配置、品牌、应用标识 |
| `apps/electron/src/main/index.ts`、`logger.ts`、`menu.ts` | 桌面业务入口、运行日志及菜单 |
| `apps/electron/src/renderer/main.tsx`、`index.html` | 业务页面及默认入口 |
| `apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx` | 模型连接展示 |
| `apps/electron/src/renderer/components/app-shell/input/model-picker-helpers.ts`、`__tests__/model-picker-helpers.test.ts` | 模型选择行为及验证 |
| `apps/electron/src/renderer/components/workspace/AddWorkspaceStep_ConnectRemote.tsx` | 工作区连接展示 |
| `apps/electron/src/renderer/hooks/useNotifications.ts`、`lib/provider-icons.ts`、`pages/settings/AiSettingsPage.tsx` | 通知、图标及模型设置展示 |
| `apps/electron/src/shared/types.ts`、`src/transport/channel-map.ts` | VisaFlow 调用及事件契约 |
| `packages/server-core/src/handlers/rpc/index.ts` | 注册业务 RPC |
| `packages/shared/src/i18n/setupI18n.ts` | 产品显示与翻译 |
| `packages/shared/src/protocol/channels.ts`、`events.ts`、`routing.ts` | 业务通道、事件及路由 |
| `packages/shared/src/workspaces/storage.ts` | 工作区配置支持 |

新增的 `packages/visaflow-core`、业务 RPC 与桌面 VisaFlow 页面记录在以上功能变更中。公开仓库的源码目录统一为 `app/`；根启动器、测试脚本与示例路径同步调整。
