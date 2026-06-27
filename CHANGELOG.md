# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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