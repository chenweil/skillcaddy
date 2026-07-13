# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.13.1] - 2026-07-13

### Fixed
- TUI 紧凑表格：当 skill 名过长时正确截断，确保状态标签（可添加/已启用）始终可见。
- TUI 已启用 skill 列表统一使用紧凑表格样式，与搜索结果保持一致。

## [0.13.0] - 2026-07-13

### Added
- **TUI 批量生成中文 note**：新增菜单选项 10，交互式流程为仅有英文 `description`、缺少中文 `note` 的 skill 补全中文介绍，支持分批（5/10/全部）处理与跳过。
- **TUI 库浏览分页**：库详情改为紧凑表格展示，支持 `n`/`p` 翻页、`a` 一键加入该库。
- 新增 `lib/tuiLayout.js`：TUI 展示排版与紧凑表格格式化（叶子模块，无 store 依赖）。
- 新增 `skills/skillcaddy-manager/scripts/translate-skill-notes.cjs`：批量中文 note 生成辅助脚本，支持 `list` / `apply`（默认 dry-run，需 `--yes` 才写入），保护已有 note 并校验 manifest 来源。
- `skills/skillcaddy-manager/SKILL.md` 补充 Batch Chinese Note Generation 用法与规则。

### Changed
- TUI 中 skill 介绍优先使用 metadata `note`，回退到 `description`，最后回退到路径（`.import-rules.json` 为 `lib/tuiLayout.js` 新增导入规则）。
- `.import-rules.json` 新增 `lib/tuiLayout.js` 导入规则。
- README / README_CN 补充 TUI 分页与批量中文 note 说明。

## [0.12.0] - 2026-07-02

### Added
- **TUI 终端管理器**：`npm run tui -- /path/to/project` 启动交互式终端界面，无需浏览器即可管理 skills。
  - 查看已启用 skill（Agents + Claude Code 双列展示）
  - 浏览/搜索 skill 库，支持关键词搜索和来源过滤
  - 启用 skill 到 Agents 并自动同步 Claude Code
  - 清理已启用的项目 skill
  - 同步 Claude Code skills
  - 编辑 skill metadata（备注、tags、一键加入开关）
  - 查看项目诊断建议（advice）
  - 刷新项目状态、切换项目
  - 更新 GitHub skill 库（调用 `pull-github.sh`）
- 新增 `scripts/tui.js`：TUI 主入口，实现完整的交互式菜单导航。
- 新增 `lib/tuiActions.js`：TUI 核心操作逻辑，复用 Web 管理器相同的数据层和动作。
- 新增 `test/tuiActions.test.js`：TUI 操作逻辑测试覆盖。

### Changed
- README / README_CN 补充 TUI 启动方式和功能说明。
- `.import-rules.json` 新增 `lib/tuiActions.js` 导入规则。

## [0.11.0] - 2026-07-01

### Added
- 新增 `npm run install:manager`：将仓库自带的 `skills/skillcaddy-manager` 以受控软链接安装到 `~/.agents/skills/skillcaddy-manager`，方便 AI Agent 在任意项目中发现 Skillcaddy 管理能力。
- 新增 `npm run check:manager`：检查全局 `skillcaddy-manager` 是否已安装、是否断链或是否指向其它位置。
- 新增 `lib/managerInstall.js`：封装 manager skill 安装与检查逻辑。

### Changed
- **Metadata 存储位置重构**：`skillcaddy.json` 从每个 skill 目录内迁移到集中存储目录 `.skillcaddy/metadata/<source>/<relative-path>/skillcaddy.json`，不再污染上游 SKILL.md，gitignore 更友好。
- `readSkillMetadata()` 现在优先读取 sidecar metadata，回退到 legacy（skill 目录内）并标记 `metadataStorage: 'legacy'`。
- `updateSkillMetadata()` 统一写入 sidecar 位置。
- `lib/sourcePolicy.js` 新增 `resolveAllowedSkillSource()`：返回来源目录与相对路径信息，供 sidecar 路径计算使用。
- README / README_CN 补充首次安装 `skillcaddy-manager` 的 bootstrap 说明，并明确不会覆盖已有非受控目标。

## [0.10.0] - 2026-06-30

### Added
- 历史项目列表支持单独移除：每个项目 chip 右侧新增 `×` 删除按钮，hover 时显示移除提示。
- 项目路径输入框新增 placeholder 示例和字段提示文案"请输入项目路径添加"，引导用户操作。

### Changed
- 重构项目历史 chip 样式：改用 grid 布局分离路径按钮与删除按钮，增强交互独立性。
- 删除按钮 hover 状态：深色背景 + 白色图标，视觉反馈更明确。
- 禁用项目（当前已加载）的路径按钮改为灰色不可点击样式，避免混淆。

## [0.7.0] - 2026-06-29

### Added
- 新增 `skillcaddy.json` skill 管理元数据：支持为每个 skill 保存人可读 `note` 和 `tags`，不污染上游 `SKILL.md`。
- `/api/state` 现在会返回每个 skill 的 `note`、`tags`、`autoEnable`、`metadataPath`、`hasMetadata`。
- 新增 `POST /api/skill-metadata`，用于安全写入 skill 目录内的 `skillcaddy.json`。
- Web UI 新增 tag tabs 过滤、tag pill 展示、备注展示、内联编辑表单、单 skill 是否参与库级一键加入开关，以及库级一键清理 Agents / Claude Code 已启用 skills。
- `skillcaddy-manager` 增加 metadata 自动维护规则，指导 Agent 根据 `SKILL.md` 内容生成或更新 `skillcaddy.json`。

### Changed
- 导入边界规则新增 `lib/sourcePolicy.js` 和 `lib/skillMetadata.js`，复用来源边界检查，避免 metadata 写入绕过 Skillcaddy 来源目录。

## [0.6.0] - 2026-06-29

### Added
- Web 管理器支持通过 `?projectPath=<encoded-project-path>` 直接打开指定项目，并在切换项目后同步 URL。
- 项目路径输入区新增本地历史项目记录和"添加项目"入口，方便在多个项目之间切换。
- Skill 原件库的每个库标题旁新增 `+` 批量启用入口，可一次启用该库内尚未启用且非 archived 的 skills。
- `skillcaddy-manager` skill 新增"打开 Web 管理器"工作流，指导 Agent 使用 URL 传递项目路径。

### Changed
- Web 管理器默认固定使用 `http://127.0.0.1:4173`；仅在端口冲突或显式指定时通过 `PORT=<other-port>` 临时覆盖。
- 首页统计文案统一为 `Agents 启用`、`Claude Code 启用`。
- 禁用按钮和不可操作控件的鼠标样式改为 `not-allowed`，避免误导成加载状态。
- README / README_CN 补充固定端口、项目路径 URL 传参、历史项目和批量启用说明。

## [0.5.0] - 2026-06-29

### Added
- 导入依赖规则系统：`.import-rules.json` 配置 + `scripts/check-imports.js` 检查脚本，强制模块依赖分层
- 全局技能检测：自动扫描 `~/.agents/skills` 和 `~/.claude/skills`，返回 `global` 数组
- 技能建议系统：`buildSkillAdvice()` 提供"重复名 / 未启用推荐 / 已启用但来源变化"等管理建议
- 导入检查测试：`test/check-imports.test.js` 覆盖规则解析、glob 匹配、违规检测

### Changed
- `npm test` 现在包含导入检查（`npm run lint:imports`），破坏性变更：不合规导入会导致测试失败
- `lib/skillStore.js`：
  - `getState()` 返回值新增 `global` 和 `advice` 字段
  - 新增 `scanGlobalSkills()`：扫描用户级全局技能目录
  - 新增 `scanSkillLinks(skillsDir)`：提取公共软链接扫描逻辑，供项目级与全局级复用
  - 新增 `buildSkillAdvice(rootDir, { skills, enabled, global })`：生成管理建议
- `public/app.js`：适配新的 `global` / `advice` 字段（UI 准备）
- `skills/skillcaddy-manager/SKILL.md`：增补导入规则、全局技能、建议系统的使用说明

## [0.4.1] - 2026-06-28

### Changed
- README 双语化
  - 新增 `README.md`（English，canonical），顶部加 `[English](README.md) · [中文](README_CN.md)` 语言切换
  - 中文版迁到 `README_CN.md`，顶部同步加语言切换链接
  - 两份内容 1:1 对应；ASCII 架构图、命令、表格结构保留
- 新增 "Why Skillcaddy?" / "为什么是 Skillcaddy？" 段（双语）：痛点列表（5 条多项目 / 多 Agent 场景）+ 能力清单（6 条：单一事实来源 / 零项目污染 / 多 Agent 友好 / 独立管理 / 安全默认 / 便于贡献）+ 收尾点题（个人 / 团队 / 作者三类读者）；放置在标题下方、Installation 之前

## [0.4.0] - 2026-06-28

### Added
- 新源 `skills/`：仓库自带的 skill 视作 `source: 'local'`、`id: 'local/<name>'`，与 `official/github/personal/archived` 一同被扫描
- 新 skill `skills/skillcaddy-manager/`：教 Agent 如何使用 Skillcaddy 自身
  - `SKILL.md`：列出 / 启用 / 禁用 / 同步 / 更新 / 健康检查 / 冲突检测的工作流；强制 dry-run 摘要 + 多种确认门（重复名 / 别名占用 / 非 symlink 占用 / GitHub 本地脏 / 动 archived / 删中央原件）
  - `agents/openai.yaml`：interface 元数据，`allow_implicit_invocation: true`
- 新工具脚本 `scripts/pull-github.sh` + `npm run pull:github`：批量 fast-forward pull `github/` 下所有仓库，脏工作树跳过，失败汇总退出码
- 测试新增 `scans repository-provided root skills`：覆盖 `skills/<name>/` 扫描 + 启用路径

### Changed
- `lib/skillStore.js`：
  - `ensureSourceFolders` 同时创建 `skills/`
  - `scanSkills` 增加 `scanRepositorySkills`，先扫仓库自带再扫外部源
  - `scanSourceFolder(rootDir, sourceFolder, source = sourceFolder)` 增加可选第三参支持自定义 source label（向后兼容：默认仍等于目录名）
  - `assertInsideSources` 接受 `skills/`，错误信息更新为"来源目录或仓库 skills 目录内"

## [0.3.0] - 2026-06-28

### Added
- 新模块 `lib/projectPath.js`：集中 `projectPath` 校验
  - `normalizeProjectPath(value)`：拒绝系统目录（`/`、`/Applications`、`/Library`、`/System`、`/bin`、`/etc`、`/opt`、`/private`、`/sbin`、`/tmp`、`/usr`、`/var`）、用户主目录 `$HOME`、以及 `$HOME` 的祖先目录；`path.resolve` 后返回
  - `requirePath(value, label)`：从 `claudeStore.js` 抽出的非空 + 类型校验，供 `projectPath.js` 与 `skillStore.js` 复用
- 新模块 `lib/projectActions.js`：`enableProjectSkill(rootDir, input)` 包装 `enableSkill`，启用后 best-effort 调用 `syncClaudeSkills`，结果合并为 `{ ...enableResult, claudeSync: { ok: true, ... } | { ok: false, error } }`，Claude 同步失败不会抛出
- 测试新增 `project enable syncs Claude skills best-effort`：覆盖 `enableProjectSkill` 正常路径（claude 同步成功 + agents 启用都生效）

### Changed
- `lib/claudeStore.js`、`lib/skillStore.js`：所有接受 `projectPath` 的入口（`syncClaudeSkills` / `getClaudeStatus` / `unlinkClaudeSkill` / `getAgentsSkillsDir` / `getClaudeSkillsPath` / `scanEnabledSkills` / `getState`）改为先调用 `normalizeProjectPath`，删除 `claudeStore.js` 内本地 `requirePath`
- `server.js`：`/api/enable` 路由从 `enableSkill` 切到 `enableProjectSkill`，响应体新增 `claudeSync` 字段（向后兼容，原有字段保留）
- `public/app.js`：新增 `enableMessage(name, result)`，根据 `claudeSync` 给出三种 UI 文案——默认"已启用 X"；`claudeSync.ok=true` 时"已启用 X，并同步 Claude Code"；`claudeSync.ok=false` 时"已启用 X；Claude Code 自动同步失败：<error>"

### Security
- `projectPath` 服务端校验前置到 `normalizeProjectPath`，早于任何文件系统操作；不合法路径直接拒绝（防止误把 `/`、`/Users` 等作为目标执行 symlink / readdir）

## [0.2.1] - 2026-06-27

### Fixed
- Skill 原件库分组标题箭头 `▾` 与文字水平对齐：把 `.chevron` 移进 `<h3>` 内部，h3 改为 flex 容器（`align-items: center` + `gap: 8px`），箭头自身改为 `inline-flex` + `height: 1em`，按字形而非行盒做垂直居中，修复此前箭头视觉上偏低的问题
- 箭头加 `aria-hidden="true"`，避免屏幕阅读器重复读出

### Changed
- `app.js`：`groupElement.querySelector('h3')` 改为 `groupElement.querySelector('h3 .title')`，标题文本写入新增的 `.title` span，避免 `textContent` 把箭头字符冲掉

## [0.2.0] - 2026-06-27

### Changed
- 品牌重命名：标题、`<h1>`、启动日志从 "AI Skills Manager" 改为 "Skillcaddy"
- `.claude/skills` 不再是 `.agents/skills` 的目录级软链接，改为真实目录 + 每个 skill 一条独立软链接
  - agents 列禁用某个 skill 不再连带清除 Claude Code 列的同条目（断链显示而非消失）
  - Claude Code 列清理某个 skill 不再连带影响 agents 列
  - 旧版 layout（`.claude/skills -> ../.agents/skills`）会在下次 `syncClaudeSkills()` 时自动迁移
- Claude Code 列卡片去掉"查看"按钮与对应的 SKILL.md 预览面板，操作只剩"清理"
- 删除顶部"原件 / 已启用 / 可用"汇总栏（信息冗余）
- agents skill 卡片从 grid 垂直布局改为 flex 横向布局，与 Claude Code 列对齐
- agents skill 名在是软链接时前缀 `🔗` 图标，按钮文字"禁用"→"清理"
- 启用 / 清理按钮统一使用 `secondary danger`（白底红字）样式
- 两列条目按 alias 字母序排序（agents 在 `lib/skillStore.js`；Claude 在 `lib/claudeStore.js`）
- 启动日志 `Skillcaddy: http://127.0.0.1:4173`

### Added
- 标题处版本号徽章（`/api/version` 端点 + 启动时缓存 `package.json`）
- agents 列、Claude Code 列、Skill 原件库面板标题加 `count` 计数徽章
- `.gitignore` 排除 `.agents/`、`.claude/`（防止本机状态入库）
- 字体 / 颜色 token 化（`styles.css` 顶部 CSS 变量）
- 4 个新测试：per-skill 软链接布局、agents/Claude 列表独立性、旧版 layout 自动迁移、两列按字母排序

### Removed
- Claude Code 状态行（"软链接 /path -> /target · N 个 skill"）——诊断信息泄露路径
- `/api/read-claude-skill` 端点、`lib/claudeStore.js` 的 `readClaudeSkill`、前端 `readClaudeSkill` 函数、`<section id="claudeSkillContent">` 节点、相关 CSS（`.skill-content` / `.content-head` / `.skill-content pre`）
- `agentsUi.js` 旧版 grid 布局、`.enabled-head` CSS、text badge `link`/`file`

## [0.1.0] - 2026-06-27

### Added
- 初始版本
- 本地 skill 原件库扫描（official / github / personal / archived 四个来源）
- 按项目软链接启用 skill 到 `.agents/skills/<alias>`
- 可选同步 Claude Code 入口（创建 `.claude/skills` 指向 `.agents/skills`）
- 一键启用 / 禁用 agents skills
- 一键加入 / 清理 Claude Code skills
- 单个 Claude skill 读取、禁用
- Web UI（`public/`）展示原件库、已启用列表、Claude skill 状态
- 基础测试覆盖（`node --test test/*.test.js`）
