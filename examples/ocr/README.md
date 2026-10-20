# PDF 与图片识别演示材料

这些文件全部是合成工程样例，不是真实护照或银行材料。

1. 新建案件：姓名 `ANNA ERIKSSON`，正式提交日期 `2026-10-19`。
2. 从下列文件中任选一份上传：
   - `passport-text.pdf`：带文字层，直接提取文字。
   - `passport-photo.png` 或 `passport-photo.jpg`：本地 OCR 图片识别。
   - `passport-scan.pdf`：只有图片的 PDF，逐页渲染后 OCR。
3. 等待识别完成，点击“核对识别字段”，对照原页面核实姓名、护照号码与到期日期。点击字段下方依据可在页面定位原文。
4. 填写核对说明，确认并保存字段。
5. 上传 `bank_statement.json` 和 `application.json`，开始材料核验。该合成样例的七项规则检查应全部通过。

识别失败会保留明确错误并允许重试；待识别、待确认的材料不能直接进入核验。每份材料最大 8 MB，每份 PDF 最多 8 页。识别模型随依赖安装，处理材料时不需要云服务密钥。

样例生成脚本：在 `app/` 运行 `bun scripts/generate-visaflow-ocr-samples.ts`。
