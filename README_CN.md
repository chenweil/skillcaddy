# Skillcaddy

[English](README.md) · [中文](README_CN.md)

本地 AI Skills 中央库 + 按项目软链接启用。一个 `AISkills` 目录装下所有 skill 源，按需 symlink 到任意项目。

![](public/skillcaddy_CN.png)

## 为什么是 Skillcaddy？

如果你在多个项目里同时用 Claude Code / Codex / OpenCode / Pi，迟早会遇到这些场景：

- 同一个 skill 散落在三个 repo 里，各自略微漂移
- 新开项目就要把 skill 复制一遍，分不清哪个版本才是最新
- 上游 skill 更新了，本地副本却落后几周
- 需要 Claude Code 专属入口，同时还要保留 agents 列表干净
- archived 的 skill 不小心又被启用了——因为没人设门禁

Skillcaddy 用一个 AISkills 目录作单一事实来源，用按项目的 symlink 作投递机制，把这些问题一次性解决。

- **单一事实来源** — `~/AISkills/` 汇总 `official / github / personal / archived / skills`
- **零项目污染** — 启用靠 symlink 落到 `.agents/skills/`，绝不复制
- **天生多 Agent 友好** — 一个 symlink 同时被 Claude Code / Codex / OpenCode / Pi 走各自标准路径识别
- **独立管理启用 / 禁用** — agents 列与 Claude Code 列各自跟踪
- **安全默认** — 禁用只删 symlink；`archived/` 必须显式点名才启用
- **便于贡献** — 新 skill 放在 `skills/<name>/`，配 `SKILL.md` + `agents/openai.yaml`，随本仓库发布

不管你是独自维护多个 repo 的个人开发者、想统一 skill 资产的小团队，还是想发布可复用 skill 的作者——契约都一样：skill 属于你的库，不属于任何单一项目。

## 安装

```bash
git clone https://github.com/chenweil/skillcaddy.git
cd skillcaddy
npm start
```

需要 Node.js >= 20。Web 管理器默认固定使用 `http://127.0.0.1:4173`。在页面里填写目标项目路径，启用/禁用 skill。如果该端口临时被占用，可以用 `PORT=<其他端口> npm start` 临时覆盖。

### 终端 UI（TUI）

启动交互式终端管理器：

```bash
npm run tui -- /path/to/project
# 或显式指定原件库根目录
npm run tui -- --root ~/AISkills /path/to/project
```

TUI 提供完整的键盘驱动界面，无需浏览器：

- **查看已启用 skill** — Agents 和 Claude Code 双列并排展示
- **浏览/搜索 skill 库** — 关键词搜索、来源过滤、库级钻取
- **启用 skill** — 创建 `.agents/skills/` 软链接并自动同步 Claude Code
- **清理已启用 skill** — 仅删除项目软链接，原件安全
- **同步 Claude Code** — 一键同步 `.claude/skills/` 与 `.agents/skills/`
- **编辑 metadata** — 内联编辑备注、tags、一键加入开关
- **查看诊断建议** — 检测重复名、断链、来源漂移等问题
- **刷新项目** — 重载状态、切换项目路径
- **更新 GitHub 源** — 批量 fast-forward pull `github/` 仓库

菜单导航使用数字键（1-9）选择操作，`/关键词` 搜索，`b` 返回，`q` 退出。适合终端快速操作或无头环境使用。

如果希望 AI Agent 在任意项目里都能使用仓库自带的 `skillcaddy-manager`，首次安装后执行一次：

```bash
npm run install:manager
npm run check:manager
```

这会创建受 Skillcaddy 管理的全局软链接：`~/.agents/skills/skillcaddy-manager` 指向本仓库的 `skills/skillcaddy-manager`。如果目标位置已经存在文件、目录，或指向其它位置的软链接，命令会停止，不会覆盖。

也可以通过 URL 直接传递项目路径：

```text
http://127.0.0.1:4173/?projectPath=<encoded-project-path>
```

页面会立即加载该项目，把最近使用的项目路径保存在浏览器本地历史中，并支持通过库标题旁的 `+` 一次启用该库内可用的全部 skills。如果误点启用了整个库，可以用库标题旁的 `×` 同时清理该库在 Agents 和 Claude Code 中的启用入口。

## Skill 元数据

`SKILL.md` 仍然是给 Agent 使用的契约。面向人的备注和分类由 Skillcaddy 存到 `.skillcaddy/metadata/.../skillcaddy.json`，避免污染外部原件库：

```json
{
  "note": "适合在代码修改前后做执行协议检查，避免漏测和误改。",
  "tags": ["Developer Tools", "Quality", "Workflow"],
  "autoEnable": true
}
```

Web UI 会兼容读取旧的 `<skill-dir>/skillcaddy.json`，但新的编辑会写到本地 sidecar 元数据存储。Tags 会显示为过滤 tab 和 pill 标签，备注会显示在每个 skill 卡片上。把 `autoEnable` 设为 `false` 后，废弃或有风险的 skill 会被库级一键加入跳过，但仍可单独手动启用。这样既不污染上游原件库，也能让大型本地 skill 库更容易浏览。

## 平台兼容性

| 平台 | 状态 | 备注 |
|------|------|------|
| macOS | ✅ 完全支持 | 原生目录符号链接 |
| Linux | ✅ 完全支持 | 原生目录符号链接 |
| Windows | ⚠️ 需额外配置 | 详见下方说明 |

### Windows 前置条件

Skillcaddy 通过 Node.js 的 `fs.symlink(..., 'dir')` 创建目录符号链接。在 Windows 上这一调用需要满足下列条件之一，否则会抛出 `EPERM`：

1. **开启"开发人员模式"**（推荐）
   - 设置 → 隐私和安全 → 开发者选项 → **开发人员模式**
   - 适用于 Windows 10 创意者更新（1703）及以上
2. **以管理员身份运行**
   - 用管理员终端执行 `npm start`

### Windows 已知限制

- `readlink` 返回的目标路径可能带有 `\\?\` 前缀或反斜杠，可能影响"别名重复指向"检测（`enableSkill` 中的 `existingTarget !== resolvedSkillPath` 判断）。
- NTFS 默认大小写不敏感，但代码按大小写敏感比较别名（一般不影响日常使用，但同义大小写的别名会被视为两个 skill）。
- 没有针对 Windows 的路径规整、junction fallback 或复制降级。

### 计划中的兼容改进（未实现）

为了让 Windows 用户开箱即用，后续会引入以下策略，但**当前版本均未实现**：

- **平台分支**：检测到 `process.platform === 'win32'` 时优先使用 junction（`fs.symlink(target, path, 'junction')`），junction 不需要开发者模式。
- **失败降级**：捕获 `EPERM` 后递归复制 skill 内容到 `.agents/skills/`，并在 `disableSkill` 中改为删除真实目录。
- **路径规整**：`resolveLinkTarget` 去掉 `\\?\` 前缀、统一分隔符、Windows 下做大小写不敏感比较。
- **README Windows 段**：补充 PowerShell 命令、磁盘格式要求（NTFS）、junction 与 symlink 的取舍说明。

## 架构示意

```
┌─────────────────────────────────────────────────────────────────┐
│                     Skillcaddy (中央库)                          │
│  ~/AISkills/                                                    │
│  ├── official/      ─┬─ my-skill/SKILL.md                       │
│  ├── github/        ─┤                                          │
│  ├── personal/      ─┴─ another-skill/SKILL.md                  │
│  ├── archived/                                                   │
│  └── skills/         ← 仓库自带（随本项目发布，source: local）   │
└─────────────────────────────────────────────────────────────────┘
                              │
              启用时创建软链接 (symlink)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         项目目录                                 │
│  ~/projects/my-app/                                             │
│  ├── .agents/skills/                                            │
│  │   ├── my-skill ──────────────► ~/AISkills/official/my-skill  │
│  │   └── another-skill ─────────► ~/AISkills/personal/...       │
│  └── .claude/skills/                                            │
│  │   ├── my-skill ──► ../../.agents/skills/my-skill             │
│  │   └── another-skill ─► ../../.agents/skills/another-skill    │
│  └── .opencode/skills/  (可选)                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
        各 Agent 自动发现并加载 skills 目录
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Agent          │ 项目级 Skills 路径          │ 用户级路径       │
│─────────────────────────────────────────────────────────────────│
│  Claude Code    │ .claude/skills/             │ ~/.claude/skills │
│  OpenCode       │ .opencode/skills/           │ ~/.config/...    │
│                 │ .claude/skills/             │ ~/.claude/skills │
│                 │ .agents/skills/             │ ~/.agents/skills │
│  Codex          │ .agents/skills/             │ ~/.agents/skills │
│  Pi             │ .pi/skills/                 │ ~/.pi/agent/...  │
│                 │ .agents/skills/             │ ~/.agents/skills │
└─────────────────────────────────────────────────────────────────┘
```

**核心设计**：
- `.agents/skills` 是跨 Agent 标准路径，所有 Agent 都能识别
- `.claude/skills` 为 Claude Code 专用，但通过二次软链接指向 `.agents/skills`
- 一次启用，多 Agent 共享；禁用时只删软链接，原件安全

## 目录约定

```text
skillcaddy/
├── official/      # 官方/上游 skill（ignored，本地自行填充）
├── github/        # 从 GitHub 克隆来的 skill（ignored）
├── personal/      # 个人原创 skill（ignored）
├── archived/      # 停用的 skill（ignored）
├── skills/        # 仓库自带的 skill（随本项目发布；本仓库内有 skillcaddy-manager）
├── lib/           # 管理器代码
├── public/        # Web UI
├── scripts/       # 维护脚本（如 pull-github.sh）
├── server.js
└── test/
```

四个外部 skill 源目录（`official/github/personal/archived`）已加入 `.gitignore`，克隆下来是空壳，按下面"添加 skill"的方式填充。`skills/` 是仓库自带的源，与本项目一同发布，不在 `.gitignore` 内。

每个 skill 是一个子目录，建议包含 `SKILL.md`（描述何时使用 / 如何使用）：

```text
official/
└── my-skill/
    └── SKILL.md
```

## 添加 skill

直接放（最简单）：

```bash
mkdir -p official/my-skill
# 把文件写进 official/my-skill/
```

从 GitHub 克隆：

```bash
git clone https://github.com/some/repo.git github/some-skill
```

随本仓库发布（仅在贡献 Skillcaddy 本身时使用）：

```text
skills/<skill-name>/
├── SKILL.md
└── agents/
    └── openai.yaml   # Codex / OpenCode 元数据（可选）
```

`skills/` 下的 skill 在扫描时会被标记为 `source: 'local'`、`id: 'local/<name>'`，行为与其他源完全一致——可被启用到任意项目的 `.agents/skills/`。

管理器启动时会自动扫描所有源目录（`official / github / personal / archived / skills`），无需重启服务即可在 UI 中看到新增 skill。

## 更新 GitHub 源

批量 fast-forward pull 所有 `github/` 子仓库（脏工作树会自动跳过，不会冲掉本地修改）：

```bash
npm run pull:github
```

## 本项目自带的 skills

### skillcaddy-manager

让 Agent（尤其是 Codex）知道如何正确使用 Skillcaddy 本身：

- 列出当前可用的 skill（含来源 / 集合 / 别名 / 路径）
- 启用 / 禁用某个 skill，或对一个 source / collection 批量操作
- 同步 Claude Code 入口
- 更新 GitHub 源的本地克隆
- 健康检查（断链、别名冲突、archvied 误启用）
- 检测冲突并要求用户确认

**安全规则**：永远只操作项目内的 `.agents/skills` symlink；不删中央原件；不动 `archived/` 除非显式点名；任何状态变更前先给 dry-run 摘要。

**触发方式**：`agents/openai.yaml` 设置了 `allow_implicit_invocation: true`，Agent 看到相关请求时会自动加载。

## 启用 / 禁用

**启用**：在项目 `.agents/skills/` 下创建软链接，指向中央库中的 skill 原件。

```text
<project>/.agents/skills/<alias> -> <skillcaddy>/<source>/<skill>
```

**同步 Claude**：为 Claude Code 创建 `.claude/skills/` 入口，每个 skill 软链接指向 `.agents/skills/`。

```text
<project>/.claude/skills/<alias> -> ../../.agents/skills/<alias>
```

**禁用**：删除软链接,不删原件。

**为什么是两层软链接？**
- `.agents/skills` 是 Agent Skills 标准,Codex / OpenCode / Pi 都能识别
- `.claude/skills` 让 Claude Code 也能使用,且支持单独管理（部分启用/禁用）
- 一次启用,多 Agent 共享；禁用不影响原件,安全可靠

## 推荐系统

Skillcaddy 内置推荐系统,帮助用户发现和选择合适的 skills。

### 快速查看推荐

```bash
node skills/skillcaddy-manager/scripts/view-recommendations.cjs onboarding
node skills/skillcaddy-manager/scripts/view-recommendations.cjs scenario new-project
```

### 推荐原则

- **先分析再推荐**: 先看当前库、当前项目和已有 skill
- **平台优先**: 空库时先推荐发现平台,不要固定推某个库
- **场景分流**: mattpocock + lencx 只用于明确开发场景,不是空白默认态
- **冲突检测**: 自动检测功能重叠的库 (如 mattpocock vs superpowers)
- **全局检测**: 检测全局 skills 目录,建议统一管理

### 空库默认推荐

当用户库里还没有任何 skill 时,默认推荐是:

1. 先看平台入口: `skillsmp`、`skills.sh`
2. 再判断当前需求属于开发、写作、研究还是设计
3. 场景明确后再选 starter 库

### 开发场景 starter

**开发流程黄金组合:**

1. **mattpocock/skills** (工作流套件)
   - Setup: `setup-matt-pocock-skills` 一键配置
   - 包含: TDD、领域建模、调试、实现、质询

2. **lencx/skills** (项目把控)
   - coding-protocol: 防止 AI 误改
   - keel: 架构治理

### 相关脚本

```bash
node skills/skillcaddy-manager/scripts/check-conflicts.cjs superpowers
node skills/skillcaddy-manager/scripts/check-global-skills.cjs
node skills/skillcaddy-manager/scripts/version-manager.cjs check
```

详细文档请查看 [references/RECOMMENDATION_GUIDE.md](references/RECOMMENDATION_GUIDE.md)。


## 测试

```bash
npm test
```

## 链接
[Linux Do](https://linux.do/)
[浅谈 AI 编程](https://mp.weixin.qq.com/s/f-NIkyxIuA8vjAUDp1bh5w)
[深度思考：架构腐朽 & Loop Engineering](https://mp.weixin.qq.com/s/wINKSDQCroWBvf29h567zA)
