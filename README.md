# Skillcaddy

本地 AI Skills 中央库 + 按项目软链接启用。一个 `AISkills` 目录装下所有 skill 源，按需 symlink 到任意项目。

## 安装

```bash
git clone https://github.com/chenweil/skillcaddy.git
cd skillcaddy
npm start
```

需要 Node.js >= 20。打开控制台输出的本地地址，在页面里填写目标项目路径，启用/禁用 skill。

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

启用时创建软链接：

```text
<project>/.agents/skills/<alias> -> <skillcaddy>/<source>/<skill>
```

可选同步 Claude 入口，会创建：

```text
<project>/.claude/skills -> ../.agents/skills
```

禁用时只删除 `.agents/skills` 下的软链接，不删原件（库内文件不动），不删项目内其他内容。

## 测试

```bash
npm test
```
