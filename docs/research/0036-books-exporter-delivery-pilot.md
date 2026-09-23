# 真实任务试跑：books-exporter #14 的交付验收

日期：2026-09-23。目的：验证既有 skill 能否拼接需求覆盖、最终改动审查、整改复验和整体交付判断；本次没有编写新 skill。

## 结论

现有 `coding-protocol`、`code-review`、`tdd` 加项目验收入口，能够跑通一个已有实现的收尾任务。此次在 48 项测试已通过的情况下发现并修复两个真实协议缺陷，修复后 49 项测试和真实 macOS 读取/导出验证通过。

仍需显式补接：任务/版本选择、需求到证据映射、未提交修复的审查范围、finding 复现与撤回、整体验收和 tracker 状态分离。

这是“已有实现→审查→修复→验收”的一次成功试跑，不证明从零 grilling/拆票、多票合并、并行开发或自动关闭 issue 的流程已验证。现在可以先固化项目流程规则；若封装 skill，应只封装上述交接职责，不复制开发/测试/审查能力。

## 任务选择与固定点

- 对象：[Issue #14 — Implement the Rust Machine JSON Protocol and doctor preflight](https://github.com/chenweil/apple-books-export/issues/14)。本次成功读取时为 open、ready-for-agent，无评论，无依赖。
- 没有选择 Speech #24–#29：其前置任务仍未完成，而且 #23 已有多个开发分支；不能把 ready-for-agent 标签单独当作可开工证明。
- 用户提供目录 `/Users/chenweilong/books-exporter` 实际为 `appkit@5791c3d49614277130cb68d8d9c3b53ff88ba7cd`，干净；#14 明确属于 main，不能在 appkit 上直接判定。
- 本地 main、origin/main 与 GitHub commits/main 本次查询均为 `439eb41f009b704dc2ebacee2e95f40335955e6e`。
- 隔离副本：`/private/tmp/books-exporter-delivery-pilot-14`，从本地仓克隆 main；没有切换或修改原工作区。副本 origin 是本地仓，不是 GitHub。
- 历史审查基线：`bcb42504120050024c29ab2ba461beb812e93168`，首个协议实现前的规划提交。
- 历史审查命令：`git diff bcb4250...439eb41`；范围也含 #15/#16/#18 等已存在工作，只审 #14 相关职责，不将它们自动判作范围膨胀。
- 修复复审：`git diff HEAD -- src/main.rs src/machine.rs tests/machine_cli.rs`。此处明确检查实际未提交改动，不能沿用仅到 HEAD 的历史差异。

## 需求覆盖与证据

#14 是具体交付 ticket，其上位依据是 `docs/plans/2026-08-07-headless-mainline-appkit-cutover-spec.md` 与 ADR 0005。只核验其负责的 Rust 协议切片，不宣布整个 AppKit Cutover 已完成。

| #14 承诺 | 本次证据 | 判定 |
| --- | --- | --- |
| list/annotations 的版本化 JSON、规范化 DTO、asset_id | machine_cli 集成测试；真实书库读取和标注读取 | 通过 |
| export 的结构化 receipt、默认行为、覆盖保护 | fixture 合同测试；真实数据临时导出和第二次拒绝覆盖 | 通过 |
| doctor 数据库/运行架构预检 | fixture 缺失、不可读、权限拒绝测试；真实 macOS aarch64 doctor | 通过，本次主体具备读取权限 |
| 成功 stdout、错误 stderr JSON、非零错误退出 | 原测试加参数错误回归；修复前参数错误复现为非 JSON | 修复后通过 |
| 稳定错误码与隐藏 SQLite 细节 | 错误码测试；schema 破坏用例不泄露表名、SQL 和原始错误 | 修复后通过 |
| schema/binary 兼容 | 现有常量测试、协议文档及 Skill 预检 | 局部证据；没有在不兼容硬件上运行 |
| 人类 list/export 兼容 | 原集成测试；新增人类参数错误和帮助成功断言 | 通过 |
| 本地数据边界 | 源码调用路径检查，机器 list/read/export 未发现网络调用 | 静态证据；未做网络系统调用拦截 |
| cargo test on main | 隔离的 main 固定点初始 48 项；修复工作区 49 项 | 均通过，修复尚未合入 main |
| 面向 TUI/Skill/AppKit 的协议文档 | 上位 spec、ADR 0005、仓库 Agent Data Skill 文档 | 存在且覆盖首期契约 |

真实 smoke 不等于真实 TCC 拒绝场景。拒绝分支由现有 fixture/沙箱测试覆盖，未切换系统 Full Disk Access 设置。未来 AppKit 的权限主体也不由本次 CLI smoke 代替。

## Standards

独立 reviewer 初审两个 P2：

1. `src/main.rs` 的 `Cli::parse()` 在参数错误时提前退出，使机器调用绕过 JSON 错误通道，违反 ADR 0005。
2. `src/machine.rs` 将原始数据库错误透传到 JSON，暴露表名/查询细节，违反 CONTEXT 中机器边界约定。

修复后 reviewer 检查实际工作区差异：两项均解决，没有新的可操作问题。reviewer 未运行测试，运行证据由主执行者独立提供。

## Spec

独立 reviewer 初审参数错误问题，以及一项待验证的 FDA 误报候选。

- 参数错误已通过二进制和失败测试复现，修复后满足结构化错误要求。
- FDA 候选声称将 `.sqlite` 路径替换为目录会误报权限不足。但回归候选在原实现就通过，实际得到 `DATABASE_UNREADABLE`。该 finding 被撤回；试探性数据库改动和用例也已撤回，不计入修复成果。
- reviewer 对修复后的工作区复审，无新增 Spec 阻塞问题。
- `UNSUPPORTED_SCHEMA_VERSION` 的版本拒绝职责由上位 spec 明确归于消费者；没有凭空为生产者新增请求版本参数。

双轴计数：Standards 初审 2 项，最终 0 未解决；Spec 初审 2 项候选，其中 1 项修复、1 项撤回，最终 0 已确认未解决。两轴重复发现同一参数问题，去重后实际修复 2 个缺陷。

## 修复和验证

修改三个文件：`src/main.rs`、`src/machine.rs`、`tests/machine_cli.rs`。

1. 先新增 CLI 公共入口测试：参数缺值、非法序号、未知选项必须输出 JSON；帮助保持成功，人类错误保持原入口。先失败，再将解析改为 `try_parse_from`，复验通过。
2. 扩展已有 schema 损坏测试：禁止表名、SQL 和原始 SQLite 文案出现在机器错误。先失败，再规范化数据库错误消息，复验通过。
3. 没有新增错误码、schema 版本、数据库访问策略或功能范围。

| 检查 | 结果 |
| --- | --- |
| 初始 `cargo test --all-targets --locked --offline` | 48 passed |
| 参数错误新增测试，修复前 | failed，证明能检测缺陷 |
| 数据库错误扩展测试，修复前 | failed，证明能检测缺陷 |
| 最终 `cargo test --all-targets --locked --offline` | 49 passed：30 library + 1 main + 18 integration |
| `cargo check --all-targets --locked --offline` | exit 0 |
| `cargo build --release --locked --offline` | exit 0 |
| `cargo fmt --all -- --check` | exit 0 |
| `bash tests/headless_mainline.sh` | passed |
| `bash skills/apple-books-export-rust/tests/contract.sh` | passed，含 runtime validator |
| `git diff --check` | exit 0 |

Skill contract 首次运行时因 release binary 尚未构建而失败；完成要求的构建后重新执行通过。它是执行顺序前置，不是产品 bug。

### 真实 macOS smoke

在最终源码构建的 release binary 上执行：doctor → list → 选取有标注的 asset_id → annotations → 指定临时目录 export → 重复 export 验证覆盖保护。

- doctor 返回 macOS/aarch64 ready。
- list 返回 70 本书；选定条目读取到 1 条标注。
- 导出产生 1 个非空文件，检查文件位于指定临时目录内。
- 重复导出返回 `OUTPUT_FILE_EXISTS`、非零退出，stdout 为空。
- 临时目录由测试上下文自动清理；报告与证据不保存书名、asset_id、标注正文或导出内容。
- binary SHA-256：`0bb4fa4482ab35f9911606c5f4565efca0143dc50d2407fc59b7367271662bd1`。

## 拼接过程验证了什么

| 交接点 | 本次实际补接 | 应由谁负责 |
| --- | --- | --- |
| 找到可执行任务 | issue 状态 + 依赖 + 工作区 + 分支匹配 | 项目流程/编排 |
| 确定权威需求 | ticket + 上位 spec + ADR；已有需求不重复 grilling | 项目流程/编排 |
| 覆盖核对 | 上表逐项对应测试、源码或真实证据 | 项目流程/编排 |
| 独立审查 | code-review 两轴；同一问题不重复计数 | 现有 code-review |
| 发现不等于事实 | 每条 finding 复现；失败候选明确撤回 | diagnosis/TDD + 编排 |
| 最终修复被审到 | 单独审 HEAD 后未提交差异 | review 调用约定 |
| 真实验收 | 构建最终 binary，再跑实际数据入口 | 项目验收流程 |
| 完成状态 | 本地通过、main 合入、tracker 关闭分别记录 | 项目流程/编排 |

无需新增一套 PRODUCT/TECH 文档体系。本次既有 issue + spec + ADR 足够。固定模型品牌也没有成为必要条件。

## 交付边界和下一步

- 原 books-exporter appkit 工作区仍干净，原有 main 和 Speech 工作区未修改。
- 修复保存在临时隔离副本，另附持久补丁；没有 commit、push、PR、GitHub 评论或关票。
- #14 不能因本次本地通过就写成“main 已修复/issue 已验收关闭”。实际合入后还需在最终提交上核对，并由任务状态更新动作完成记录。
- 上位 Cutover spec 的 TUI、AppKit、签名、公证和其他平台验收不属于本次完成范围。
- 从零需求澄清、出票、跨票集成和 tracker 关闭仍未试跑，因此本报告不建议立刻宣称整个开发流水线已完整验证。
- 推荐先把本次证明必要的交接规则写成薄的项目约定；第二次用多票功能检验需求覆盖/集成环节，再决定是否抽为复用 skill。

## 可复核产物

- [修复补丁](0036-delivery-pilot-evidence/issue14-fixes.patch)，适用基线 `439eb41`。
- [验证摘要](0036-delivery-pilot-evidence/verification-summary.json)。
- [真实运行摘要](0036-delivery-pilot-evidence/live-smoke-summary.json)。
- [最终测试日志](0036-delivery-pilot-evidence/final-tests.log)。
- 目录内同时保留两个缺陷的 red/green 日志、被撤回候选的原始通过日志、构建和 check 日志。
- 补丁 SHA-256：`132f1622430d760442b10b88eb973f49676f3ce151cef260c6fa78a2df8d2c4d`。

GitHub issue 状态与 main SHA 来自本次成功的只读 API 查询。后续一次保存 issue JSON 的尝试遇到网络错误；未将空文件作为证据，也未推断 tracker 状态发生变化。
