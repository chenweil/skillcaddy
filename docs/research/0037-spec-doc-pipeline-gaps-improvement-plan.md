# 技术方案文档驱动流程的缺口改进方案

日期：2026-09-23。目的：针对 `0035-spec-doc-multi-agent-pipeline.md` 已确认的缺口（B 阶段强制方向审查关卡、F 阶段外部草稿摄入、横切缺口“文档生命周期角色语义”）给出可评估、可验证的设计方案；本次没有编写新 skill，也没有修改任何被调查文档。

## 结论

0035 的方向性结论成立：现有原件库能拼出 A、C、D、E 四段，B 只能借用交互范式而没有强制关卡，F 的输入端为空，横切缺少文档生命周期角色语义。但缺口要补的不是更多技能匹配，而是三处少量新语义。

1. **方向确认关卡（B，最高优先级）**。库内没有任何技能把它做成可拒绝的关卡；`implement-specs` 只要求“approved enough”，是软前置。唯一可借的范式是 `write-feature-docs` 的两次有序确认（先方向、后内容，合并会导致锚定）。这一条无 skill 可替，也是唯一决定“流程是否真的成立”的一条。
2. **文档角色技能（F）**。输入是外部模型草稿（不可信）+ 仓库当前状态，输出是经审技术方案文档。`write-tech-spec` 把“先自行研究再写”硬编码进流程，没有“草稿”形式参数；文档类技能普遍假设文档自行产生。
3. **文档生命周期位置成为显式参数（横切）**。作者 / 实施者 / 验证者三个位置显式传入，而不是隐含的会话假设。原件库的分工维度是任务，不是文档生命周期位置。

范围限定：本方案不引入多模型维度。不按 0035 采用模型 A/C/D 拆分，也不采用“强制新会话进行模型角色分配”；角色改为显式参数，与模型品牌解耦（0036 第 110 行已记录“固定模型品牌也没有成为必要条件”）。

此外，0035 自身有两处事实性错误和若干覆盖缺口需要修订后，才能作为决策依据，详见下文“Spec”末节。

## 调查对象与固定点

- 被改进对象：`docs/research/0035-spec-doc-multi-agent-pipeline.md`，504 行，SHA-256 `a3bb7c119cd878053557efe90e9d6f2f2d9b2405d1686b790386782739feb072`，本次核实时未变更。该文件当前未被版本控制跟踪。
- 排版模板：`docs/research/0036-books-exporter-delivery-pilot.md`（130 行，中文）。本文件沿用其章节顺序与头部写法。
- 基线时间戳：2026-09-23 11:37:54 CST。工作区 HEAD `ac479fd`；`git status --short` 恰好三个未跟踪项：`docs/research/0035-spec-doc-multi-agent-pipeline.md`、`docs/research/0036-books-exporter-delivery-pilot.md`、`docs/research/0036-delivery-pilot-evidence/`。
- 原件库规模（易变；验证需记录时间戳）：`ls -d github/*/ | wc -l` 为 **30**；`find github -name SKILL.md -not -path '*/.git/*' | wc -l` 为 **324**；排除 i18n 副本后为 **319**，命令为 `find github -name SKILL.md -not -path '*/.git/*' | grep -v '/skills/i18n/' | wc -l`。
- i18n 副本口径：仅存在于 `github/planning-with-files/skills/i18n/planning-with-files-{ar,de,es,zh,zht}/SKILL.md` 共 5 个，语言码是目录名后缀，因此 324 − 5 = 319。宽口径与“语言前缀型”正则均不可替代此路径过滤。
- 关键技能行号固定点（相对 `github/`，行号以本次核实为准）：
  - `common-skills/.agents/skills/implement-specs/SKILL.md` 第 3、12、24 行：前置条件仅“confirm that the relevant specs have been reviewed and approved enough to start implementation”，无强制闸门实现。
  - `common-skills/.agents/skills/write-tech-spec/SKILL.md` 第 30、32 行（*Research before writing*，硬编码“先自行研究”）；第 33、40–41 行（commit-pinned `blob/<sha>/…#Lx-Ly` 引用与示例）；第 44 行（*Testing and validation*）；第 85–87 行（*Keep the spec current*，批准后的 spec 随实施一起更新）。
  - `common-skills/.agents/skills/write-feature-docs/SKILL.md` 第 22 行（两次有序确认与锚定论证）；第 39、41 行（保密边界，须人工在场）；第 443、445、447、449–454 行（*Interactive only*；“`scan-new-specs` is retired”；不得重新加入无人值守路径，须停下并报告）。

追记（2026-09-23）：0035 已按本方案“对 0035 自身的修订建议”R1–R4 修订，与本文档同批纳入版本控制（R5 随之完成）。修订前快照：504 行、SHA-256 `a3bb7c119cd878053557efe90e9d6f2f2d9b2405d1686b790386782739feb072`（2026-09-23 11:37:54 CST）。本文所引 0035 行号与该校验和均指修订前快照；修订后的新行数与新校验和以 0035 修订后文件头部/结尾的记录为准（不重测，不覆写本文其他内容）。

## 需求覆盖与证据

下表把 0035 的每条缺口映射到本方案的对应处置，并标注判定。0035 行号指其自身文件行号。

| 0035 断言 / 缺口 | 本方案对应 | 判定 |
| --- | --- | --- |
| 3.3 缝一：B 没有闸门，流程在 B 处默认通过 | 增量 ①（方向确认关卡） | 覆盖 |
| 3.3 缝二：模型角色语义不存在，分工维度是任务而非文档生命周期位置 | 增量 ③（角色显式参数） | 覆盖 |
| 3.3 缝三：F 输入端为空，文档类技能假设文档自行产生 | 增量 ②（文档角色技能） | 覆盖 |
| 1.3 验收：必须同时满足 D（批准后仍存活）与 E（持续更新） | 增量 ①③ 的存活规则，依据 `write-tech-spec` 第 85–87 行 | 覆盖 |
| 保留 commit 固定的行级代码引用 | 增量 ② 的输入/输出契约，依据 `write-tech-spec` 第 33、40–41 行 | 覆盖 |
| 第 3 行“29 个来源仓库” | 修订建议 R1 | 需修订，实测 30 |
| 第 71–72 行“271 个 SKILL.md” | 修订建议 R2 | 需修订，实测 319 |
| 第 504 行“标记为‘仅 description’的条目” | 修订建议 R3 | 需修订，表中无该标记 |
| 附录第 467–502 行覆盖范围 | 修订建议 R4 | 需修订，含已退役技能与遗漏项 |
| 排除多模型维度 | 全案 | 显式排除，不涉及 |

0035 的两个数字错误方向一致（都少算），但 29→30 是口径问题，271→319 是样本范围问题，后者会连带影响第 2 章抽样能否支撑第 3 章结论，因此 R2 必须在方案被引用前完成。

## Standards

本方案与增量设计须满足以下标准。

1. 每个阶段可验证、可修复、可迭代，每个动作都有一个评估（吸收 `Geek-skills-keqian-method` 的质量门禁原则；不采用其“单 agent 优先”的编排默认值）。
2. B 的关卡必须是拒绝语义，不是提示。正面范本来自 `write-feature-docs` 第 449–454 行：不得重新加入无人值守路径，须停下并报告该技能需要人工在场。
3. 批准后的文档必须存活并持续更新，即 `write-tech-spec` 第 85–87 行的 *Keep the spec current*：已批准的 spec 可随实施同 PR 发布，checked-in spec 应描述实际交付的实现。
4. 代码引用必须 commit 固定（`write-tech-spec` 第 33、40–41 行）。这与 `to-spec` 的“不包含文件路径/代码片段”规则不同，本方案保留前者，不混用。
5. 外部草稿是不可信输入。审查步骤沿用 `validate-changes-match-specs` 的不可信数据意识与 `research` 的溯源要求。
6. 三次确认不合并。`write-feature-docs` 第 22 行的锚定论证：先展示具体大纲会让工程师锚定在大纲上，而不再重新考虑其上位问题。

## Spec

### 增量 ① 方向确认关卡（B）

- 触发点：`specs/<id>/TECH.md` 草稿完成，进入实施之前。
- 缺口证据：`implement-specs` 第 24 行只有软前置条件；`write-feature-docs` 第 39、41 行的保密边界与 `coding-protocol` 的“计划授权的是规划，不是变更”都是拒绝语义，但不是为方向确认设计的。
- 设计：关卡必须是独立、可记录、可拒绝的一步，且先确认方向、再确认内容，两次不合并。关卡结果写回 `TECH.md`，作为批准状态的显式记录，使 D 阶段能核验“批准后文档仍存活”。
- 验收：能构造“方向被拒”的用例，流程必须停止并报告，不得自动续跑。判定依据对照 `write-feature-docs` 第 449–454 行。

### 增量 ② 文档角色技能（F）

- 输入：外部模型草稿（不可信）+ 仓库当前状态。
- 输出：经审技术方案文档，落盘到 `specs/<id>/TECH.md`。
- 缺口证据：`write-tech-spec` 第 30、32 行把“先自行读产品 spec / 检查代码、不要猜架构”硬编码进流程，没有“草稿”形式参数。
- 复用：commit 固定引用格式（第 33、40–41 行）、*Testing and validation*（第 44 行，validation 属于 TECH.md，PRODUCT.md 刻意不设 Validation 节）、*Keep the spec current*（第 85–87 行）。
- 审查步骤：草稿是候选不是权威，必须与仓库实际状态逐条对账；不因草稿存在而跳过研究，也不把草稿的断言直接升格为文档结论。

### 增量 ③ 文档生命周期角色显式参数（横切）

- 三个位置：作者、实施者、验证者。
- 缺口证据：0035 第 3.3 节缝二已确认，原件库按任务而非文档生命周期位置分工。
- 设计：角色是显式参数，不是隐含会话假设；角色决定权限边界——作者不自我批准方向，实施者不改方向，验证者对照文档而非对话进行验收。D 阶段必须新会话（沿用 0035 第 3.2 节已定做法）。
- 与 0035 的差异：0035 用“强制新会话进行模型角色分配”；本方案改为显式参数，与模型品牌解耦。

### 对 0035 自身的修订建议

- **R1**：第 3 行“29 个来源仓库”改为 30（`ls -d github/*/ | wc -l`）。
- **R2**：第 71–72 行“271 个 `SKILL.md`”改为 319，并附复现命令与时间戳；同时重新确认第 2 章抽样能否支撑第 3 章结论。
- **R3**：第 504 行“标记为‘仅 description’的条目”需删除，或在表中补上对应标记；当前表中无此类条目。
- **R4**：附录覆盖范围需重新定义。`scan-new-specs` 已退役（`write-feature-docs` 第 445 行），不应作为缺口列出；`common-skills` 下 `write-pr-description`、`review-pr` 未收录；另有 16 个常见技能未入附录（`brandalf`、`complain`、`council`、`create-pr`、`cross-critique`、`diagnose-ci-failures`、`fix-errors`、`migrate-to-factory`、`pr-walkthrough`、`reproduce-bug-report`、`resolve-merge-conflicts`、`respond-to-pr-comments-in-blocklist`、`saga`、`skill-doctor`、`suggestion-box`、`update-skill`）。要么补齐，要么明确写出“只收录与流程相关技能”的抽样口径。
- **R5**：0035 当前未被版本控制跟踪，建议纳入版本控制，否则其校验和与行号固定点无法被后续复核。

## 修复和验证

本方案尚未实施。下表给出实施前必须能够复现的检查，以及每一项的验证方法。

| 检查 | 本次实测 / 预期方法 |
| --- | --- |
| 仓库目录数 | `ls -d github/*/ \| wc -l` → 30（2026-09-23 11:37:54 CST） |
| `SKILL.md` 计数（排除 i18n） | `find github -name SKILL.md -not -path '*/.git/*' \| grep -v '/skills/i18n/' \| wc -l` → 319（同上时间戳） |
| 0035 固定点 | 504 行；SHA-256 `a3bb7c11…feb072`（同上时间戳，未变更） |
| 技能行号复核 | `write-feature-docs` 第 445 行；`write-tech-spec` 第 33、85–87 行；`implement-specs` 第 24 行，grep 命中一致 |
| B 关卡可拒绝性 | 构造“方向被拒”用例，流程必须停止并报告，不得自动续跑（预期，依据 `write-feature-docs` 第 449–454 行） |
| 草稿对账 | 草稿每条断言与仓库实际状态逐条判定，不成立项必须标记（预期） |
| 角色权限矩阵 | 同一文档在作者 / 实施者 / 验证者三种角色下的可执行动作可枚举（预期） |
| 文档存活 | 批准后 `TECH.md` 随实施提交更新，D 阶段可核验（预期，依据 `write-tech-spec` 第 85–87 行） |

数量类数字均为易变值，验证时必须记录时间戳。

## 拼接过程验证了什么

| 交接点 | 0035 缺口 | 本方案处理 |
| --- | --- | --- |
| A 写技术方案文档 | 可拼出，无缺口 | 不改动 |
| A → B 方向审查 | 缝一，无闸门 | 增量 ① |
| B → C 实施 | 软前置条件 | 增量 ① 的批准状态记录 |
| C → D 对照验收 | 可拼出，无缺口 | 增量 ③ 的验证者角色 |
| D → E 归档更新 | 可拼出，无缺口 | 增量 ③ 的角色参数，依据 `write-tech-spec` 第 85–87 行 |
| F 外部草稿摄入 | 缝三，输入端为空 | 增量 ② |
| 横切：文档生命周期角色 | 缝二，语义不存在 | 增量 ③ |

本方案只补上述交接职责，不复制 `write-tech-spec` / `implement-specs` / `code-review` 已有的写作、实施、审查能力。

## 交付边界和下一步

- 本次只产出一份方案文档并写入 `docs/research/`。没有修改代码，没有修改被调查文档（含 0035），没有触碰其他文件。
- 没有 commit、push、PR、GitHub 评论或关票。
- 三项增量均未实施，也未做原型验证；上表“预期”项在实施前不构成已验证结论。
- 建议顺序：先做增量 ①（唯一决定流程是否成立，且无 skill 可替），再做 R2 数字修订（否则 0035 不能作为决策依据），随后评估增量 ② 与 ③。
- 用户的既有边界保持不变：先评估、核实，再动手实施。

## 可复核产物

- 被改进对象：[0035-spec-doc-multi-agent-pipeline.md](0035-spec-doc-multi-agent-pipeline.md)，504 行，SHA-256 `a3bb7c119cd878053557efe90e9d6f2f2d9b2405d1686b790386782739feb072`。
- 排版模板：[0036-books-exporter-delivery-pilot.md](0036-books-exporter-delivery-pilot.md)，130 行。
- 基线：HEAD `ac479fd`；`git status --short` 三个未跟踪项（见“调查对象与固定点”）；核实时点 2026-09-23 11:37:54 CST。
- 计数命令与结果：目录 30 / 原始 324 / 排除 i18n 后 319。
- 关键技能行号：`common-skills/.agents/skills/write-tech-spec/SKILL.md` 第 30、32、33、40–41、44、85–87 行；`common-skills/.agents/skills/write-feature-docs/SKILL.md` 第 22、39、41、443、445、447、449–454 行；`common-skills/.agents/skills/implement-specs/SKILL.md` 第 3、12、24 行。
- i18n 副本路径：`github/planning-with-files/skills/i18n/planning-with-files-{ar,de,es,zh,zht}/SKILL.md`。
