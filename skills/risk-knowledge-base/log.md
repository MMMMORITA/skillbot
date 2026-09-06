# log.md — 变更日志（append-only）

> orientation 时读最近若干条，了解最新动作。新记录追加在**末尾**。

- [2026-08-12] 初始化 risk-knowledge-base 知识库。按新权威设计（飞书 docx K2WUdXSlXowyadx1l28mJHVuyTe）建 10 类目目录（4 已填充 + 6 预留空占位）。导入 13 篇：风控总览 4（PIPO 指标口径/CheckPoint/3DS2.0/国际支付账号体系）、业务场景 3（电商/TikTok Live/Local Service）、风险类型 5（TTS ROW V4/V3、外链 D1xBdC=EU TTS 黑标V4、直播黑白标签与FP分析、黑白标优化）、规则与策略 1（智能规则优化）。每篇加 frontmatter（含 metrics/business_lines/summary/source_url）+ 4 摘要节 + 完整原文正文（PIPO SQL 不切块）。生成 SKILL.md/SCHEMA.md/index.md/manifest.json。
- [2026-08-12] 勘误：源索引清单中「风险类型-外链(无标题)」docx D1xBdCDDnoq2lyxLXnjmpPycyvV 实为「EU TTS Payment Risk 黑标V4」（EU/UK 电商黑标），非旧设计假设的“直播裸链接/内容极少”，正文完整。已按实际标题与业务线（电商）归档。
- [2026-08-12] 重命名：skill 名由建设期临时名 `fengkong-kb` 统一改回 `risk-knowledge-base`（目录、SKILL.md name、prompt.py 引用、DESIGN.md/CHANGES.md 记录一并同步）。内容不变。
- [2026-08-20] v2 增补（轨道 A 呈现最小改动，参考飞书 docx IkqqdGZpmoaxW5xJcMum9wq9ytd）：新增元层文件 `_global/constraints.md`（问题类型判断 + 可信规则 + 输出纪律）；SKILL.md orientation 增加「先读 constraints.md」，「检索流程」升级为「检索与作答流程」并加入固定输出纪律（结论+证据+下一步+口径说明、统一引用格式、防照抄/防假权威）；index.md 收录 `_global`。暂不落地 v2 的五类加工层（flows/concepts/data_sources/templates）与 frontmatter 三字段，另行立项。
