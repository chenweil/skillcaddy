# 技术方案文档驱动的多 Agent 流程：原件库 skill 匹配调查

调查对象：`github/`（原件库，30 个来源仓库；2026-09-23 14:23:33 CST 实测 `ls -d github/*/ | wc -l` → 30）。
调查日期：2026-08-22。

## Question

用户描述了一条自己的工作流：复杂任务先写技术方案文档，文档同时承担两个职责——让人确认方向，
以及作为后续多个 Agent 之间传递上下文、事后验收的依据。

问题有三个层次：

1. 这条流程的完整形态是什么？哪些是显式步骤，哪些是隐含前提？
2. 原件库现有的 skill 里，哪些命中或部分命中其中某个环节？缺口在哪？
3. 如果现在就照这条流程跑，能不能用现有 skill 拼出来？拼不上的地方是什么？

---

## 一、文字描述的流程

### 1.1 原文

> 我复杂一点的会先写技术方案文档，主要是：
>
> 1. 人看看文档确保大方向有没有问题
> 2. Fable 写文档，文档里面写清楚技术细节和如何验证，后续 Opus 执行
> 3. 作为后续验收的依据，Opus 实施完，在新会话让 Fable 按照文档去验收一下
> 4. 一些重要文档会留档，但会保持更新
> 5. 有时候会在 ChatGPT 网页版用 GPT-6 Pro 访问 Repo 写技术方案文档，下载下来让 Fable 去审查再让 Opus 执行
>
> 简单来说，重点不是用 plan mode，但是用一个文档让人可以确认方向，以及后续多 Agent 协作传递上下文是很有价值的

### 1.2 拆出的环节

按原文顺序，这条流程有五个动作，加两条隐含前提。

| # | 动作 | 谁执行 | 输入 | 输出 |
| --- | --- | --- | --- | --- |
| A | 写技术方案文档 | Fable | 仓库现状 + 需求 | 技术方案文档 |
| B | 人审方向 | 人 | 技术方案文档 | 批准 / 改方向 |
| C | 执行 | Opus | 已批准的技术方案文档 | 实现 |
| D | 按文档验收 | Fable（新会话） | 技术方案文档 + 实现 | 验收结论 |
| E | 留档并保持更新 | — | 技术方案文档 + 实现演进 | 与实现一致的文档 |
| F | 外部模型起草，二次审查 | ChatGPT → Fable | 外部草稿 | 受信的技术方案文档 |

两条隐含前提，原文以"简单来说"一句点出：

- **文档是上下文的载体，不是计划的一次性展示。** 原文明确说"重点不是用 plan mode"。plan mode 的
  plan 在批准后即失效，这里的文档要一路活到验收（D）并持续更新（E）。
- **文档的价值由"谁写的 / 谁执行的 / 谁验收的"分离而产生。** A 与 D 都由 Fable 做但刻意放在
  新会话，C 与 A/D 由不同模型做。文档在这里替代的是跨会话、跨模型的上下文传递，不是任务清单。

### 1.3 与"普通 plan mode"的区别

| | plan mode | 本流程 |
| --- | --- | --- |
| 产物寿命 | 批准后即弃 | 活到验收，且随实现持续更新 |
| 人审的作用 | 批准执行 | 确认大方向（原文："确保大方向有没有问题"） |
| 文档读者 | 执行者一次 | 人、执行 Agent、验收 Agent |
| 模型角色 | 同一会话内换挡 | A/C/D 分给不同模型，D 强制新会话 |

这一栏是后面判断"匹配"的标尺：一个 skill 哪怕会写计划、会验收，如果产物寿命只到批准，
那它只是 plan mode 的近亲，不算命中。

---

## 二、当前 skill 库的匹配情况

### 2.1 调查范围与方法

- 枚举 `github/` 下 30 个来源仓库，剔除 `.git`、`node_modules`、i18n 副本后得到 **319 个
  `SKILL.md`**（原始计数 324，i18n 副本 5 个；2026-09-23 14:23:33 CST 实测
  `find github -name SKILL.md -not -path '*/.git/*' | grep -v '/skills/i18n/' | wc -l` → 319）。
- **抽样复核**：原样本 271 → 现样本 319，新增 48 个 SKILL.md 主要落在 i18n 之外的中文/通用技能
  区；第 2 章列出的具体技能（`write-tech-spec`、`implement-specs`、`validate-changes-match-specs`、
  `write-feature-docs` 等）全部在原样本内，**数字更正不改变第 3 章结论**。
- 全量扫描每个 skill 的 frontmatter `description`，再对语义相关者读正文；本报告的每条结论
  都标注了是否读到正文。
- 一个来源的重复副本（如 `planning-with-files` 在 `.agents/`、`.cursor/`、`.claude/` 等目录下的
  同名 SKILL）只按一个 skill 计。

判定分三档：

- **命中**：该 skill 的正文就在做这件事，且产物形态与环节要求一致。
- **部分**：只覆盖环节的一部分，或产物形态只在特定条件下成立。
- **不像**：关键词重合但职责不同，列出来是为了防止误配。

### 2.2 环节 A / C / E：写技术方案文档

这是整条库里匹配最好的一段，核心答案都在 `common-skills` 一个仓库里。

#### 命中：`common-skills/.agents/skills/write-tech-spec`

（已读正文）

原文 description：*"Write a TECH.md spec for a significant Warp feature after researching the
current codebase and implementation constraints. Use when the user asks for a technical spec,
implementation plan, or architecture doc tied to a product spec."*

命中的理由很具体：

- **必含"如何验证"。** 结构要求里 *Testing and validation* 是必选章节，且原文说明
  *"This section is where validation lives"*——验收要验什么，在写文档时就落下了。
- **明确写了给谁看。** Overview：*"makes the work easier for agents to execute and reviewers
  to evaluate"*。执行 Agent 与评审者都是预设读者。
- **代码引用钉到 commit。** 要求 `git rev-parse HEAD` 取 SHA，文件引用做成
  `blob/<sha>/...#Lx-Ly` 链接。这直接支撑环节 D——验收时能核对"文档说改的是哪一段"。
- **篇幅按复杂度伸缩。** 单文件小改动可跳过；跨模块 ~80–150 行；架构级更长。对应原文的
  "复杂一点的"。
- **并行化是一等公民。** *Parallelization* 章节要求显式评估是否拆子 Agent，包括每个 agent 的
  工作目录/worktree、分支与 PR 策略、边界与同步方式；不拆时也要说明为什么不拆。这是环节 C
  的执行面。

限制：绑死在 Warp 的 `specs/<id>/TECH.md` 目录约定和 Linear ticket id 上，不带 figma/PRD 链；
这些是约定，不是能力限制，可替换。

#### 命中：`common-skills/.agents/skills/spec-driven-implementation`

（已读正文）

这是流程编排者而不是单点 skill。它的"何时需要文档"判据与本流程的触发条件一致：

- 需要：产品/架构有歧义、约 1k+ LOC、跨栈深改、回归代价高、**"agent quality will improve
  materially from clearer inputs"**。
- 不需要：小 bug 修复、简单重构、无歧义的窄 UI 改动。

它同时管环节 E：实现偏离文档时*"update the spec rather than leaving it stale"*，且 spec 与代码
改动进同一个 PR，*"The checked-in specs should describe the feature that actually ships"*。

#### 命中：`mattpocock/skills/in-progress/implement-spec`

（已读正文）

环节 C 的另一种形态，适用于需要并行实施的场景。它的关键设计与本流程同向：

> Communication to and from subagents should be sparse. Communicate primarily through
> **context pointers**: to the spec, tickets, research notes, and previous commits. Don't
> duplicate information already available via pointers.

即：文档就是 pointer，不在 agent 间复述内容。这与"文档当上下文载体"是同一件事的两种说法。

实施被建模为 ticket 的**任务图**（有 blocking 关系，存在 ready frontier），实现 agent 各自在
独立 worktree/分支上跑，完成后由 merger agent 合入，frontier 变化时再拉起新的实现 agent。

#### 部分：`mattpocock/skills/engineering/to-spec`

（已读正文，标注 in-progress）

从当前对话直接合成 spec，*"no interview, just synthesis of what you've already discussed"*。
适合需求已在讨论中成型、不想再访谈的场景。

结构与环节 A 对得上：Problem Statement / Solution / User Stories / Implementation Decisions /
Testing Decisions / Out of Scope / Further Notes。

两处偏差，见 2.6 岔路节。

#### 部分：`ClaudeSkills/skills/Geek-skills-product-manager`

（仅 description）

grill-me-to-doc 模式：先读仓库证据，每轮只问一个决策，给推荐答案与理由，记录决策与未决项，
产出结构化 PRODUCT-DOC；**文档完成且用户批准前硬停止，任何时候都不写实现代码**。

命中环节 B 的"先问清楚再动手"，但产出是产品文档，不是技术方案。可与 `write-product-spec` /
`write-tech-spec` 的 PRODUCT.md → TECH.md 两级串起来。

#### 部分：`ClaudeSkills/skills/Geek-skills-solution-architect`

（仅 description）

架构设计、评审、技术选型、演进规划。含"评审现有架构"，但没有起草→移交→按文验收的链。

#### 部分：`ClaudeSkills/skills/Geek-skills-deep-research`、`mattpocock/…/research`、
`common-skills/…/research`

（research 两者已读正文）

不写技术方案，但给写方案供料，且都被设计成不污染主上下文：

- `mattpocock/research`：后台 agent 查一手来源，把结论写成单个 Markdown 落库，每条论断带出处。
- `common-skills/research`：把"产出答案比答案本身更吵"的调查派给子 agent，主会话只拿蒸馏结果。
  原文明确"anything where you need the raw material for your next step 不要委派"——即：要动文件
  时自己读，只要结论时派出去。

#### 部分：`common-skills/.agents/skills/readout`

（已读正文）

把调查固化成"几周后不带原上下文也能读"的自包含 HTML 文档，落在 `~/.readouts` 并有索引页。
有价值的是它的**作用域收敛**纪律：开跑前先问 2–4 个问题定方向和受众，再写 10–20 行只含指针
的 brief，然后派单个 child agent 去做。这是环节 A 前置访谈的可复用模式。

### 2.3 环节 B：人审方向

#### 部分：`common-skills/.agents/skills/write-feature-docs`

（已读正文）——库内唯一显式要求"无人不可运行"的 skill。

> Requires an interactive session with the engineer present - it confirms a content design
> plan, then an outline, before drafting, and cannot run unattended.

且原文解释了为什么必须是两次、必须按顺序：

> Steps 3 and 4 are **two separate confirmations, in that order.** ... Presenting them
> together would show the engineer an outline built on an audience they have not agreed to
> yet, and they would anchor on the concrete outline instead of reconsidering the question
> above it.

这段正是人审的方法论：**先确认"给谁看、属于哪一类"，再确认"里面放什么"**，否则人对具体大纲
anchoring，不再回头质疑上一层。技术方案文档可以直接搬这个闸门。

注意它的限定：必须有人在场是为了确认哪些内容可公开、哪些要留在内部，不是架构审查。

#### 部分：`mattpocock/skills/engineering/wayfinder`

（已读正文，标注 in-progress）

面向"一次会话装不下"的工作，把决策做成 issue tracker 上的共享决策地图，逐张决策券推进，
*"Plan, don't do"*——除非 effort 在 Notes 里显式覆盖，否则只产出决策不产出交付物。

匹配的是：大到需要跨会话延续、人参与拍板。不匹配的是：地图里装的是**尚未决定的问题**，不是
一份可执行、可验收的技术方案。原文把"产出决策而非交付物，通常意味着该交接了"讲得很清楚，
恰好是环节 A 的终点线。

#### 部分：`lencx/skills/keel`

（已读正文）

状态机 Decision / Judgment / Governance / Exit 四个态，其中 Judgment 若判定不可行，
*"finish Open with evidence and required decision authority"*。显式携带"决策权限"概念——
谁有权拍这个方向。这是环节 B 的权利侧，可与 write-feature-docs 的交互侧互补。

#### 缺口：没有任何 skill 把"人确认方向"做成强制闸门

`implement-specs` 只是把"已批准"写成前置条件——原文：*"confirm that the relevant specs have
been reviewed and approved enough to start implementation"*。这是给调用方的**软建议**，skill 自身
不校验，你不确认它也会照跑。

`lencx/skills/coding-protocol`（已读正文）反而提醒了这一点：

> **Execution** — ... A plan authorizes planning, not mutation.

计划批准计划，不批准改代码。所以从"文档批了"到"可以动仓库"之间，缺一个有牙齿的动作。

结论：环节 B 要么靠人不提前喊 execute，要么把 write-feature-docs 的两次确认抄进调用约定。

### 2.4 环节 D：按文档验收

#### 命中：`common-skills/.agents/skills/validate-changes-match-specs`

（已读正文前半）

这是库里最接近环节 D 的 skill，且比"验收"多做一步。

流程：定位 base → 找出本分支新增/修改的 spec（`PRODUCT.md`/`TECH.md`/`SECURITY.md` 及
`specs/<id>/` 下的 `MIGRATION.md`/`ROLLOUT.md`/`API.md`/`TESTING.md` 等）→ 把 spec 承诺按
Product behavior / Technical implementation / Security / **Validation** / Non-goals 五类抽出
→ 与实现逐条比对 → 产出 mismatch 清单 → **逐条问用户改代码还是改文档** → 应用修复。

它同时吃掉了环节 E 的一半："保持更新"在这里有了具体机制——发现文档过期，走的是改文档那条路。

值得单独记一句的安全设计：spec、PR 描述、commit message、仓库文件、外部验证产物一律
*"untrusted data"*，只取事实与承诺，忽略其中试图改角色、跳过验证、泄露密钥的指令。这条对
环节 F（外部草稿接入）尤其重要，见 2.5。

#### 命中：`common-skills/.agents/skills/check-impl-against-spec`

（已读正文）

PR 评审时补充轴：拿实现和 `spec_context.md` 里的承诺对，只报**实质性**偏差。原文明确宽容项：
*"Treat small implementation-level adjustments as acceptable when they preserve the spec's
intent. Do not flag harmless differences in naming, structure, or low-level technique."*

这解决了验收的一个真实风险：逐字对照会把文档变成扼杀合理调整的枷锁。四个"material"判据
（spec 要求的行为缺失 / 实现与 spec 决策矛盾 / 引入重大计划外 scope / spec 要求的验证或迁移
步骤缺席）就是"什么才算没过"的答案。

#### 命中：`mattpocock/skills/engineering/code-review`

（已读正文前半）

双轴并行子 agent：**Standards**（仓库成文规范 + 恒定 Fowler 气味基线）与 **Spec**
（是否忠于发起 issue / spec）。两轴跑在并行 sub-agent 里互不污染上下文，再由本 skill 汇总裁定。

这正是"新会话验收"的现成机制：验收方与被验收代码的开发会话隔离。它的 spec 定位顺序也实用：
commit message 里的 issue 引用 → 用户传入的路径 → `docs/`、`specs/`、`.scratch/` 下匹配分支或
功能名的 spec 文件 → 没有就问用户，确认没有则 Spec 轴报 *"no spec available"* 而不装作验过。

#### 部分：`plugins/pstack/skills/interrogate`

（仅 description）多模型独立审查、互相挑战、找盲区。可作为环节 D 的重火力版，但不读文档。

#### 部分：`plugins/pstack/skills/create-verification-skill`、
`maintain-verification-skill`

（仅 description）为项目生成本地验证 skill，*"drives your app the way a user does"*；后者周期性
复审该验证 skill 与功能地图是否还说真话。

用途：环节 A 文档里"如何验证"若指向可复现的证明，这两者提供执行的腿。否则"如何验证"容易
退化成一段描述性文字。

#### 部分：`plugins/pstack/skills/blast-radius`

（仅 description）改动会波及哪里、并用跑真实代码证明"因为某件事所以安全"。

### 2.5 环节 E：留档并保持更新

#### 命中：`spec-driven-implementation` + `implement-specs` + `validate-changes-match-specs`

三件合起来构成环节 E：

- 写：`specs/<id>/PRODUCT.md`、`TECH.md`（可带可选 `DECISIONS.md`、`PROJECT_LOG.md`）。
- 同步：`implement-specs` 要求 spec 与代码改动同 PR；实现偏离时改 spec 而非留着发霉。
- 校准：`validate-changes-match-specs` 事后逐条对照，过期项走"改文档"分支。

`write-tech-spec` 的 *Keep the spec current* 一节把这些收紧成一条例会规则：

> Update `TECH.md` in the same PR when module boundaries, implementation sequencing, risks,
> validation strategy, or rollout assumptions change. The checked-in spec should describe the
> implementation that actually ships.

#### 部分：`ClaudeSkills/llm-wiki`

（已读正文前半）

常驻的、互相链接的代码库 wiki，落 `.llm-wiki/`，"Humans curate and direct; the LLM handles all
bookkeeping"。有明确的**模式探测**：没有 `.llm-wiki/` 走 Full Build，有则走 Update（diff 后刷新）。

这是库里最接近"留档且持续更新"的通用设施，可承担"重要文档留档"那一层；技术方案文档是个案，
wiki 是长期记忆，两者层次不同、互补。

#### 部分：`planning-with-files`

（已读正文）

`task_plan.md` / `findings.md` / `progress.md` 持久在盘上当"working memory on disk"，hook 每轮
注入，会话中断可恢复；支持 `.planning/<id>/` 多任务并存，`PLAN_ID` 钉住任务归属。

不像的地方它自己说清楚了：

> They are complementary stages, not alternatives. Plan mode is where you design and approve
> the approach before execution. planning-with-files persists the live execution state (phase
> status, findings, errors, progress) on disk while the work runs

即：它存的是**执行状态**（phase 状态、发现、错误、进度），不是让人确认方向、事后按它验收的
方案本身。会话接力的能力可用，别把它当环节 A 的产物。

#### 部分：`plugins/pstack/skills/show-me-your-work`

（仅 description）TSV 决策日志，一行一决策（做了什么、为什么、证据、结果），默认本地，
审阅者需要时提交。可为环节 E 提供"文档之外"的决策痕迹。

#### 缺口：没有任何 skill 负责"外部草稿接入"（环节 F 前半）

库里没有一个 skill 的输入概念是"一份别人/别家模型写的文档"。相关但不对位的：

- `common-skills/…/write-tech-spec` 内部的 *Research before writing*：先读产品 spec、看代码、
  定位文件/类型/数据流/归属边界，*"Do not guess about current architecture when the code can
  be inspected directly"*。能力上有，但它假设文档是**自己写的**，没有草稿输入位。
- `common-skills/…/research`（两种）：可把草稿里的论断逐条回溯一手来源。要你自己派活。
- `anydoc/skills/convert-documents-to-markdown`、`ClaudeSkills/…/mineru-pdf-parser`（仅
  description）：解决"下载下来的文档"怎么变成可读文本，不管内容可信度。
- `plugins/pstack/skills/why`（仅 description）：从长期文档/源码/工单/可观测性证据里挖"为什么".
  方向相反——它是从证据推理由，不是审一份现成理由。

`validate-changes-match-specs` 的 untrusted-data 指令说明库里已经有"文档内容不可信"的意识，
但它只拿这份意识防注入，没有用来审"外部草稿说的对不对"。

### 2.6 两处需要主动选边的岔路

#### 岔路一：技术方案里放不放代码引用

两个候选给出相反的答案，都对，但别混。

| | `write-tech-spec` | `to-spec` |
| --- | --- | --- |
| 代码引用 | 要求 commit-pinned 行级链接 | **明令禁止**：*"Do NOT include specific file paths or code snippets. They may end up being outdated very quickly."* |
| 何时对 | 文档要当验收依据（环节 D 要对"改了哪"） | 传递决策，代码随时变 |

对本流程，D 是核心环节，选前者。若选后者，D 只能验行为不能验落点。

#### 岔路二：方法论默认单 Agent

`ClaudeSkills/skills/Geek-skills-keqian-method`（仅 description）是本库里最对味的"中文文档驱动
（SDD）+ 质量门禁"方法论，但第一原则是：

> **不盲目使用 multi-agent。单 agent 做到极致，再考虑编排。** 何时用并行 SubAgent（例外情况）：
> 任务间明确无依赖关系。

它默认的是极致单 Agent，与本流程"不同模型分任写/执行/验收"的前提相反。它的概率乘 Iron Law
（每个环节可验证、可修复、可迭代；每个 action 对应一个 eval）与本流程同向，可取其质量部分，
别取其编排默认值。

---

## 三、拼接过程

### 3.1 结论先行

照 1.2 的六个环节，现有 skill 能拼出 **A、C、D、E 四段**；**B（人审方向）拼不出强制闸门**，
只能借交互范式；**F（外部草稿接入）基本空白**。另外有一条**贯穿性缺口**：库里没有"文档作者 /
实施者 / 验收者"这层模型角色语义——A 与 D 都该是 Fable、D 必须新会话、C 给 Opus，这层分配
skill 一个都不管。

### 3.2 四段拼接

按依赖顺序，四段都是单仓库内自洽的，`common-skills` 一段全包：

```
A  ──►  B  ──►  C  ──►  D  ──►  E
       (缝)          (可拼)      (半条循环回 A/D)
```

| 环节 | 选用的 skill | 落点 | 拼装时要注意 |
| --- | --- | --- | --- |
| A 写方案 | `common-skills/…/write-tech-spec` | `specs/<id>/TECH.md` | 目录约定从 `specs/<linear-id>/` 换成自有约定；复杂度过低时它会自己建议跳过，别强行产出文档 |
| B 人审 | 借 `common-skills/…/write-feature-docs` 的两次确认 | 非 skill，是调用约定 | 必须是两次且有序：先确认"方向/属于哪一类"，再确认"里面放什么"；合并会让人anchoring |
| C 执行 | `common-skills/…/implement-specs`；并行时换 `mattpocock/…/implement-spec` | 分支 + PR | 两者别同时上——`implement-spec` 要求只传指针不传内容，与"把文档塞给每个 agent"的直觉冲突 |
| D 验收 | `common-skills/…/validate-changes-match-specs` 主审，`mattpocock/…/code-review` 双轴兜底，`check-impl-against-spec` 裁 PR | 新会话 | `validate` 会逐条问"改代码还是改文档"，这是环节 E 的入口，不是终点 |
| E 留档 | `spec-driven-implementation` 的同步规则 + `llm-wiki` 的 Update 模式 | spec 同 PR 更新；`.llm-wiki/` | spec 是案卷、wiki 是长期记忆，别把个案方案写进 wiki |

### 3.3 三处缝的成因

**缝一：B 没有闸门。** 原因是 skill 的通用形态是"自主完成一件事"，而 B 的本质是**拒绝继续**。
库里唯二带有拒绝语义的是 `write-feature-docs`（无人在场则无法起草公开内容）和 `coding-protocol`
（计划不授权 mutation），但前者拒绝的理由是保密边界，后者是通用协议——两者都不是为"文档方向
确认"设计的。所以拼出来的流程在 B 点是默认放行的，只能由调用方把"未确认不进入 C"写成规则。

**缝二：模型角色语义不存在。** 库里的分工维度是**任务**（research / review / implement），不是
**文档生命周期位置**（author / implementer / verifier）。能借到的是"在不同地方跑"的机制：
`code-review` 的并行 sub-agent、`research`/`readout` 的 child agent、`planning-with-files` 的跨
会话持久文件。所以"A 与 D 都让 Fable 做但必须在不同会话"必须由宿主保证；skill 只能告诉你
"这一格跑什么"，不能保证"不是同一个会话"。

**缝三：F 的输入端是空的。** 整个库的文档类 skill 都假设文档由自己产生。`write-tech-spec`
甚至把"自己研究后写"写进了 *Research before writing*。要接外部草稿，实际可行的是把它当输入
重跑一次 `write-tech-spec`——它的研究纪律天然会拿草稿里的每条论断对仓库，只是没有"草稿"这个
形式参数。`validate-changes-match-specs` 的 untrusted-data 意识和 `research` 的溯源能力可以
手工拼成审查步，但那是流程约定，不是现成 skill。

### 3.4 最小可跑组合

```
write-tech-spec  ──(人两次确认)──►  implement-specs  ──►  validate-changes-match-specs
        specs/<id>/TECH.md        同分支实现 + 同 PR 更新 spec      逐条 mismatch：改代码｜改文档
```

四个 skill 全在 `github/common-skills/.agents/skills/` 下，一处 `specs/<id>/TECH.md` 落地，D
直接接住 E（保持更新），不需要额外设施。需要并行实施时，C 换 `mattpocock/…/implement-spec`；
需要更强验收时，D 加 `mattpocock/…/code-review` 的双轴子 agent。

拼不上的部分， minimal 组合里是这样处理的：B 由人在两步之间显式确认（不确认就不进 C）；
F 人工把下载的草稿转成 Markdown 后作为 `write-tech-spec` 的输入重跑，由它的研究纪律完成校验。

### 3.5 如果要把这条流程固化成一个 skill

缺口收敛成三件可增量做的事，按性价比排：

1. **加一个方向确认闸门**：把 `write-feature-docs` 的两次有序确认抽成通用前置，未确认不放行到
   实施。这是唯一影响"流程是否真的成立"的一条。
2. **补一个文档角色 skill**：输入是外部草稿 + 仓库，输出是经审的技术方案文档。链条上缺的就是
   这一格；材料都是现成的（`write-tech-spec` 的研究纪律 + `research` 的溯源 + `validate` 的
   untrusted-data 意识）。
3. **把文档生命周期位置变成显式参数**：author / implementer / verifier 三个角色，让每个环节能
   声明"这一格由哪个模型、在哪个会话里跑"。这是让流程可重复而不靠人记的关键。

第 1 条无 skill 可替；第 2、3 条都可以从 2.5 列出的材料里搭。

---

## 附录：本报告涉及的 skill 与路径

口径说明：附录只收录与本流程环节相关的技能，不追求全量覆盖；已退役技能（如 `scan-new-specs`，
见 `common-skills/.../write-feature-docs/SKILL.md` 第 445 行）不再列入。

路径相对 `github/`。

| Skill | 路径 | 判定 |
| --- | --- | --- |
| write-tech-spec | `common-skills/.agents/skills/write-tech-spec/SKILL.md` | 命中 A |
| spec-driven-implementation | `common-skills/.agents/skills/spec-driven-implementation/SKILL.md` | 命中 A / E |
| implement-specs | `common-skills/.agents/skills/implement-specs/SKILL.md` | 命中 C |
| validate-changes-match-specs | `common-skills/.agents/skills/validate-changes-match-specs/SKILL.md` | 命中 D / E |
| check-impl-against-spec | `common-skills/.agents/skills/check-impl-against-spec/SKILL.md` | 命中 D |
| write-product-spec | `common-skills/.agents/skills/write-product-spec/SKILL.md` | 部分 A |
| write-feature-docs | `common-skills/.agents/skills/write-feature-docs/SKILL.md` | 部分 B |
| research | `common-skills/.agents/skills/research/SKILL.md` | 部分 A 供料 / F |
| readout | `common-skills/.agents/skills/readout/SKILL.md` | 部分 A 前置 |
| to-spec | `mattpocock/skills/in-progress/to-spec/SKILL.md` | 部分 A |
| implement-spec | `mattpocock/skills/in-progress/implement-spec/SKILL.md` | 命中 C（并行形态） |
| code-review | `mattpocock/skills/engineering/code-review/SKILL.md` | 命中 D |
| wayfinder | `mattpocock/skills/engineering/wayfinder/SKILL.md` | 部分 B |
| research | `mattpocock/skills/engineering/research/SKILL.md` | 部分 A 供料 / F |
| keel | `lencx/skills/keel/SKILL.md` | 部分 B（决策权限） |
| coding-protocol | `lencx/skills/coding-protocol/SKILL.md` | 部分 B（闸门语义） |
| llm-wiki | `ClaudeSkills/llm-wiki/SKILL.md` | 部分 E |
| planning-with-files | `planning-with-files/skills/planning-with-files/SKILL.md` | 部分 E（执行状态） |
| keqian-method | `ClaudeSkills/skills/Geek-skills-keqian-method/SKILL.md` | 部分 E（方法论，编排默认相反） |
| product-manager | `ClaudeSkills/skills/Geek-skills-product-manager/SKILL.md` | 部分 A / B |
| solution-architect | `ClaudeSkills/skills/Geek-skills-solution-architect/SKILL.md` | 部分 A |
| deep-research | `ClaudeSkills/skills/Geek-skills-deep-research/SKILL.md` | 部分 A 供料 |
| interrogate | `plugins/pstack/skills/interrogate/SKILL.md` | 部分 D |
| create-verification-skill | `plugins/pstack/skills/create-verification-skill/SKILL.md` | 部分 D |
| maintain-verification-skill | `plugins/pstack/skills/maintain-verification-skill/SKILL.md` | 部分 D |
| blast-radius | `plugins/pstack/skills/blast-radius/SKILL.md` | 部分 D |
| show-me-your-work | `plugins/pstack/skills/show-me-your-work/SKILL.md` | 部分 E |
| convert-documents-to-markdown | `anydoc/skills/convert-documents-to-markdown/SKILL.md` | 部分 F（仅格式） |
| mineru-pdf-parser | `ClaudeSkills/skills/Geek-skills-mineru-pdf-parser/SKILL.md` | 部分 F（仅格式） |
| why | `plugins/pstack/skills/why/SKILL.md` | 部分 F（方向相反） |

标注"仅 description"的条目只读了 frontmatter 的 description，未读正文（表中已用"(仅 description)"
标注对应条目，本句仅作读阅口径说明，并非异常标记）。
