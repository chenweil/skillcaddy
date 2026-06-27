# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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