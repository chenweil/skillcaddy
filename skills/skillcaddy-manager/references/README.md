# Skillcaddy References

本目录存放 Skillcaddy 的参考数据和推荐配置,供 skillcaddy-manager 使用。

## 文件说明

### `featured-skills.json`

**推荐 skills 库列表**,按分类组织:

#### 📂 分类结构

- **开发类** (`development`) - 编程语言、代码质量、测试、调试
  - `lencx/skills` - 核心流程协议 (必装)
  - `mattpocock/skills` - TypeScript 工程实践 (必装)
  - `superpowers` - AI 协作提效 (必装)
  - `vercel-labs/agent-skills` - React 最佳实践
  - `samber/cc-skills-golang` - Go 语言规范

- **前端开发** (`frontend`) - UI 生成、组件库
  - `json-render` - JSON 驱动多框架 UI 生成
  - `anthropics/skills` - 前端设计、测试
  - `shadcn/ui` - 现代化组件库

- **办公效率** (`office`) - PPT、PDF、文档处理
  - `guizang-ppt-skill` - 网页 PPT 生成
  - `halt-catch-fire/skills` - 视频渲染、Python 执行

- **画图与可视化** (`diagram`) - Canvas、图表
  - `obsidian-skills` - Canvas 编辑、数据库视图

- **工具类** (`tools`) - 自动化、搜索、部署
  - `vercel-labs/skills` - 技能发现工具
  - `browser-act/skills` - 浏览器自动化

结构说明:
```json
{
  "version": 2,
  "collections": {
    "development": {
      "label": "开发类",
      "collections": [
        {
          "id": "唯一标识",
          "name": "显示名称",
          "source": "github | official | personal",
          "repo": "Git 仓库地址",
          "skills": ["skill1", "skill2"],
          "tags": ["分类标签"],
          "reason": "推荐理由",
          "priority": "essential | recommended | optional",
          "installs": "安装数量(可选)"
        }
      ]
    }
  },
  "scenarios": {
    "typescript": {
      "label": "TypeScript 项目",
      "collections": ["lencx-core", "mattpocock"],
      "skills": ["coding-protocol", "tdd"]
    }
  }
}
```

### `skill-platforms.json`

**外部 Skills 平台参考**,列出主要的 skill 分发平台。

当前收录:
- **SkillsMP** (https://skillsmp.com) — 多平台 AI Skills 市场
- **Skills.sh** (https://www.skills.sh) — AI Agent Skills 平台

## 使用方式

### skillcaddy-manager 自动读取

```bash
# 当用户问"推荐一些库"时,读取 featured-skills.json
curl http://127.0.0.1:4173/api/recommendations

# 返回基于当前项目的推荐
{
  "essential": [...],
  "recommended": [...],
  "basedOnProject": "typescript"
}
```

### 手动添加推荐库

编辑 `featured-skills.json`,添加新的条目:

```json
{
  "id": "my-favorite-lib",
  "name": "awesome-skills",
  "source": "github",
  "repo": "https://github.com/user/awesome-skills",
  "skills": ["skill-a", "skill-b"],
  "tags": ["Productivity"],
  "reason": "提升效率的好工具",
  "priority": "recommended"
}
```

### 从平台发现新 skills

1. 访问 `skill-platforms.json` 中列出的平台
2. 发现感兴趣的 skill
3. 克隆到 Skillcaddy 库:
   ```bash
   cd /path/to/skillcaddy
   git clone <skill-repo> github/<collection-name>
   ```

## 维护指南

### 更新推荐

当发现新的优质 skill 库时:
1. 在 `featured-skills.json` 中添加条目
2. 设置合适的 `priority`
3. 添加到相关 `scenarios`

### 更新平台列表

当发现新的 skill 平台时:
1. 在 `skill-platforms.json` 中添加条目
2. 填写平台特点和状态

### 版本控制

每次更新文件时:
- 更新 `lastUpdated` 字段
- 如有结构变化,递增 `version`

## 贡献

欢迎提交 PR 添加更多推荐 skills 和平台!

## 相关链接

- [Skillcaddy 主仓库](../)
- [skillcaddy-manager skill](../skills/skillcaddy-manager/)
- [SkillsMP](https://skillsmp.com)
- [Skills.sh](https://www.skills.sh)
