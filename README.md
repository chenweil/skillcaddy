# Skillcaddy

本地 AI Skills 中央库 + 按项目软链接启用。一个 `AISkills` 目录装下所有 skill 源，按需 symlink 到任意项目。

## 安装

```bash
git clone https://github.com/chenweil/skillcaddy.git
cd skillcaddy
npm start
```

需要 Node.js >= 20。打开控制台输出的本地地址，在页面里填写目标项目路径，启用/禁用 skill。

## 架构示意

```
┌─────────────────────────────────────────────────────────────────┐
│                     Skillcaddy (中央库)                          │
│  ~/AISkills/                                                    │
│  ├── official/      ─┬─ my-skill/SKILL.md                       │
│  ├── github/        ─┤                                          │
│  ├── personal/      ─┴─ another-skill/SKILL.md                  │
│  └── archived/                                                   │
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
├── lib/           # 管理器代码
├── public/        # Web UI
├── server.js
└── test/
```

四个 skill 源目录已加入 `.gitignore`，克隆下来是空壳，按下面"添加 skill"的方式填充。

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

管理器启动时会自动扫描四个源目录，无需重启服务即可在 UI 中看到新增 skill。

## 启用 / 禁用

**启用**：在项目 `.agents/skills/` 下创建软链接，指向中央库中的 skill 原件。

```text
<project>/.agents/skills/<alias> -> <skillcaddy>/<source>/<skill>
```

**同步 Claude**：为 Claude Code 创建 `.claude/skills/` 入口，每个 skill 软链接指向 `.agents/skills/`。

```text
<project>/.claude/skills/<alias> -> ../../.agents/skills/<alias>
```

**禁用**：删除软链接，不删原件。

**为什么是两层软链接？**
- `.agents/skills` 是 Agent Skills 标准，Codex / OpenCode / Pi 都能识别
- `.claude/skills` 让 Claude Code 也能使用，且支持单独管理（部分启用/禁用）
- 一次启用，多 Agent 共享；禁用不影响原件，安全可靠

## 测试

```bash
npm test
```
