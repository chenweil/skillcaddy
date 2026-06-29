# Skillcaddy 推荐策略指南

## 核心原则

### 1. 先分析再推荐
- **先看库里已有些什么,再决定推荐什么**
- 空库先给平台入口
- 已有库先判断能力分布和缺口

### 2. 少而精
- **一次最多推荐 3 个库**
- 避免选择困难,聚焦核心需求
- 优先推荐组合型 skill 库

### 3. 优先推荐工作流组合
- 有 `setup-*` 脚本的优先推荐
- 说明是一整套工作流,不是单个 skill
- 提供清晰的安装步骤

### 4. 冲突检测与提醒
- **mattpocock 和 superpowers 功能重叠,二选一**
- 监测用户已安装的库,避免推荐冲突
- 给出明确的替代方案建议

### 5. 全局 Skills 检测
- **检测 ~/.agents/skills 和 ~/.claude/skills**
- **检测 Windows 全局路径**
- **建议用户安装 Skillcaddy 统一管理**

### 6. 开发流程黄金组合

```
mattpocock/skills (开发流程) + lencx/skills (项目把控)
```

**mattpocock 负责执行:**
- TDD 测试驱动开发
- 领域建模
- 系统化调试
- 方案实现
- 方案质询

**lencx 负责把控:**
- coding-protocol: 防止 AI 误改的风险控制
- keel: 架构治理和系统边界管理

**冲突说明:**
- ⚠️ **mattpocock 和 superpowers 不要一起使用**
- 两者都是开发工作流套件,功能重叠
- 推荐 mattpocock (更完整,有 setup 脚本)

---

## 全局 Skills 检测

### 检测时机
1. 用户首次使用推荐功能时
2. 用户询问如何管理 skills 时
3. 用户想了解 skills 管理最佳实践时

### 检测路径

**macOS / Linux:**
```bash
~/.agents/skills        # Codex 全局 skills
~/.claude/skills        # Claude Code 全局 skills
```

**Windows:**
```bash
%USERPROFILE%\.agents\skills
%USERPROFILE%\.claude\skills
%APPDATA%\.agents\skills   # 备用路径
%APPDATA%\.claude\skills   # 备用路径
```

### 检测逻辑

```javascript
const globalPaths = {
  darwin: {
    codex: '~/.agents/skills',
    claude: '~/.claude/skills'
  },
  linux: {
    codex: '~/.agents/skills',
    claude: '~/.claude/skills'
  },
  win32: {
    codex: path.join(os.homedir(), '.agents/skills'),
    claude: path.join(os.homedir(), '.claude/skills'),
    codexAlt: path.join(process.env.APPDATA, '.agents/skills'),
    claudeAlt: path.join(process.env.APPDATA, '.claude/skills')
  }
};
```

### 推荐文案

#### 场景 1: 检测到全局 Skills,但未安装 Skillcaddy

```markdown
## 🔍 全局 Skills 检测

检测到您使用全局 Skills 目录:
- `~/.agents/skills` (3 个 skills)
- `~/.claude/skills` (2 个 skills)

⚠️ **建议安装 Skillcaddy 统一管理**

**为什么需要 Skillcaddy?**
- ✅ 集中管理所有 skills (单一事实来源)
- ✅ 按项目启用/禁用 (避免污染)
- ✅ 多 Agent 兼容 (Claude Code / Codex / OpenCode)
- ✅ 版本控制和更新管理
- ✅ 避免重复复制和版本漂移

**安装步骤:**
\`\`\`bash
# 克隆 Skillcaddy
git clone https://github.com/chenweil/skillcaddy.git
cd skillcaddy
npm start

# 访问 http://127.0.0.1:4173
\`\`\`

**迁移现有 Skills:**
\`\`\`bash
# 将全局 skills 移动到 Skillcaddy
mv ~/.agents/skills/my-skill /path/to/skillcaddy/personal/my-skill

# 在项目中按需启用 (Web UI 或 skillcaddy-manager)
\`\`\`
```

#### 场景 2: 已安装 Skillcaddy

```markdown
## ✅ 检测到 Skillcaddy

全局 skillcaddy-manager 位置:
- `~/.agents/skills/skillcaddy-manager`
- `~/.claude/skills/skillcaddy-manager`

💡 **使用建议:**
- 在项目中使用 `skillcaddy-manager` 启用/禁用 skills
- 使用 Web UI 管理: http://127.0.0.1:4173
- 查看推荐: `node skills/skillcaddy-manager/scripts/view-recommendations.cjs workflows`
```

#### 场景 3: 未检测到全局 Skills

```markdown
## ✅ 未检测到全局 Skills

当前系统未设置全局 skills 目录,这是好的实践!

💡 **建议:**
- 使用 Skillcaddy 集中管理 skills
- 避免全局污染,按项目启用
- 访问: https://github.com/chenweil/skillcaddy
```

---

## 推荐流程

### 完整推荐流程图

```
1. 检测全局 Skills
   ↓
2. 判断是否安装 Skillcaddy
   ├─ 是 → 继续推荐流程
   └─ 否 → 建议安装 Skillcaddy
            ↓
3. 检测已安装的 collections
   ↓
4. 检查冲突
   ├─ 有冲突 → 提醒并给出建议
   └─ 无冲突 → 继续推荐
               ↓
5. 根据场景推荐
   ↓
6. 提供安装步骤
```

### 推荐优先级

1. **最高优先级**: 检测全局 Skills,建议安装 Skillcaddy
2. **次优先级**: 检测冲突,避免重复安装
3. **常规推荐**: 根据场景推荐合适的 skills

---

## 冲突检测逻辑

### 检测时机
1. 用户询问推荐时
2. 用户准备启用某个 skill 时
3. 检测到已安装冲突库时

### 冲突配置

```json
{
  "conflicts": {
    "mattpocock-vs-superpowers": {
      "collections": ["mattpocock-workflow", "superpowers-workflow"],
      "reason": "两者都是开发工作流套件,功能重叠",
      "recommendation": "推荐 mattpocock (更完整,有 setup 脚本),二选一"
    }
  }
}
```

### 冲突提醒文案

```markdown
⚠️ 检测到冲突

您已安装: **mattpocock/skills**
正在尝试安装: **superpowers**

这两个库功能重叠,都是开发工作流套件,不建议同时使用。

建议:
- 保留 mattpocock (更完整,有 setup 脚本)
- 如需切换,先禁用 mattpocock 再启用 superpowers
```

---

## 推荐场景示例

### 场景 1: 新项目启动 (未安装任何 skill)

**推荐:**
```markdown
🎯 建议安装开发流程黄金组合:

1. **mattpocock/skills** (工作流套件) 【必装】
   - ⚡ Setup: setup-matt-pocock-skills (一键配置)
   - 📋 包含:
     - tdd - 测试驱动开发
     - domain-modeling - 领域建模
     - diagnosing-bugs - 系统化调试
     - implement - 实现执行
     - grill-me - 方案质询
   - 🔧 安装: 启用 setup-matt-pocock-skills 自动配置

2. **lencx/skills** (项目把控) 【必装】
   - 📋 包含:
     - coding-protocol - 防止 AI 误改
     - keel - 架构治理
   - 🔧 安装: 启用 coding-protocol + keel

💡 mattpocock 建立完整开发工作流,lencx 做质量把控,覆盖开发全流程。

⚠️ 注意: mattpocock 和 superpowers 功能重叠,不要一起使用。
```

### 场景 2: 已安装 mattpocock,想了解其他推荐

**推荐:**
```markdown
✅ 已检测到您安装了 **mattpocock/skills** (工作流套件)

🎯 建议补充:

**lencx/skills** (项目把控)
- 📋 包含:
  - coding-protocol - 防止 AI 误改
  - keel - 架构治理
- 🔧 安装: 启用 coding-protocol + keel

💡 配合 mattpocock 做质量把控,形成完整开发流程。

⚠️ 注意: superpowers 与 mattpocock 功能重叠,不建议安装。
```

### 场景 3: 已安装 superpowers,想了解其他推荐

**推荐:**
```markdown
✅ 已检测到您安装了 **superpowers** (工作流套件)

🎯 建议补充:

**lencx/skills** (项目把控)
- 📋 包含:
  - coding-protocol - 防止 AI 误改
  - keel - 架构治理
- 🔧 安装: 启用 coding-protocol + keel

💡 配合 superpowers 做质量把控。

💡 如需更完整的工作流,可切换到 mattpocock (有 setup 脚本):
  1. 先禁用 superpowers
  2. 启用 setup-matt-pocock-skills
```

### 场景 4: 尝试同时安装 mattpocock 和 superpowers

**提醒:**
```markdown
⚠️ 检测到冲突

您已安装: **mattpocock/skills**
正在尝试安装: **superpowers**

这两个库功能重叠,都是开发工作流套件,不建议同时使用:
- mattpocock: TDD, 调试, 实现, 质询, 领域建模
- superpowers: TDD, 调试, 头脑风暴, 验证完成

建议:
- ✅ 保留 mattpocock (更完整,有 setup 脚本)
- ❌ 不安装 superpowers

如需切换到 superpowers:
  1. 先禁用 mattpocock
  2. 再启用 superpowers
```

---

## 组合型 Skill 库识别

### 标记方式

在 `featured-skills.json` 中:
```json
{
  "id": "mattpocock",
  "isSuite": true,
  "setupSkill": "setup-matt-pocock-skills",
  "conflictWith": ["superpowers"],  // 冲突标记
  "setupGuide": "先启用 setup-matt-pocock-skills,它会自动配置整个工作流环境"
}
```

### 推荐时说明

```markdown
**mattpocock/skills** 是一个工作流套件,包含多个 skill。

安装方式:
- 一键配置: 启用 setup-matt-pocock-skills
- 包含: tdd, domain-modeling, diagnosing-bugs, implement, grill-me

建议先运行 setup 脚本,它会自动配置整个工作流环境。

⚠️ 注意: 此套件与 superpowers 功能重叠,二选一。
```

---

## 推荐文案模板

### 模板 1: 开发项目 (无冲突)

```markdown
## 🎯 推荐安装 (开发流程黄金组合)

### 1. mattpocock/skills (工作流套件) 【必装】
- **安装方式**: 启用 setup-matt-pocock-skills 自动配置
- **包含**: TDD、领域建模、调试、实现、质询
- **用途**: 建立完整开发工作流

### 2. lencx/skills (项目把控) 【必装】
- **安装方式**: 启用 coding-protocol + keel
- **包含**: 风险控制、架构治理
- **用途**: 防止 AI 误改,管理架构边界

💡 这两个库配合使用,覆盖开发全流程。

⚠️ 注意: mattpocock 和 superpowers 功能重叠,不要一起使用。
```

### 模板 2: 已有冲突库

```markdown
## 🎯 推荐安装

⚠️ 检测到您已安装 **mattpocock/skills**

建议补充:
**lencx/skills** (项目把控)
- coding-protocol: 防止 AI 误改
- keel: 架构治理

⚠️ 不建议安装: superpowers (与 mattpocock 功能重叠)
```

---

## 记住这些要点

### ✅ DO
- 优先推荐有 setup 脚本的组合库
- 说明是"套件"还是"单个 skill"
- 开发项目推荐 mattpocock + lencx 黄金组合
- 一次不超过 3 个推荐
- **检测冲突并提醒用户**
- **明确说明哪些库不能一起使用**

### ❌ DON'T
- 不要一次推荐太多
- 不要只列名字不说明用途
- 不要忽略 setup 脚本的重要性
- 不要推荐重复功能的库
- **不要让用户同时安装冲突的库**

---

## 冲突检测实现

### skillcaddy-manager 应该:

1. **读取 conflicts 配置**
```javascript
const conflicts = data.conflicts;
```

2. **检测用户已安装的库**
```javascript
const installed = await getInstalledCollections(projectPath);
```

3. **检查冲突**
```javascript
function checkConflicts(installed, tryingToInstall) {
  for (const [conflictId, conflict] of Object.entries(conflicts)) {
    if (conflict.collections.includes(tryingToInstall) &&
        conflict.collections.some(c => installed.includes(c))) {
      return {
        hasConflict: true,
        existing: conflict.collections.find(c => installed.includes(c)),
        conflicting: tryingToInstall,
        reason: conflict.reason,
        recommendation: conflict.recommendation
      };
    }
  }
  return { hasConflict: false };
}
```

4. **显示警告**
```javascript
if (conflict.hasConflict) {
  console.warn(`⚠️ 检测到冲突`);
  console.warn(`您已安装: ${conflict.existing}`);
  console.warn(`正在尝试安装: ${conflicting}`);
  console.warn(conflict.reason);
  console.warn(conflict.recommendation);
}
```

---

## 数据结构

### conflicts 配置

```json
{
  "conflicts": {
    "mattpocock-vs-superpowers": {
      "collections": ["mattpocock-workflow", "superpowers-workflow"],
      "reason": "两者都是开发工作流套件,功能重叠",
      "skills": {
        "mattpocock": ["tdd", "diagnosing-bugs", "implement"],
        "superpowers": ["test-driven-development", "systematic-debugging"]
      },
      "recommendation": "推荐 mattpocock (更完整,有 setup 脚本),二选一",
      "advice": "检测到您已安装 {existing},建议不要同时安装 {conflicting},避免工作流冲突"
    }
  }
}
```

### collection 的 conflictWith 标记

```json
{
  "id": "mattpocock",
  "conflictWith": ["superpowers"]
}
```

---

## 相关文件

- `featured-skills.json` - 推荐数据和冲突配置
- `skill-platforms.json` - 平台列表
- `view-recommendations.cjs` - 查看脚本
- 本文档 - 推荐策略指南

## 推荐场景示例

### 场景 1: 新项目启动

**推荐:**
```markdown
🎯 建议安装开发流程黄金组合:

1. **mattpocock/skills** (工作流套件)
   - 通过 setup-matt-pocock-skills 一键配置
   - 包含: TDD、领域建模、调试、实现、质询

2. **lencx/skills** (质量把控)
   - coding-protocol: 防止 AI 误改
   - keel: 架构治理

安装步骤:
1. 启用 setup-matt-pocock-skills (自动配置工作流)
2. 启用 coding-protocol + keel
3. 开始开发
```

### 场景 2: TypeScript/React 项目

**推荐:** 同上 (黄金组合适用所有开发项目)

### 场景 3: Go 项目

**推荐:**
```markdown
🎯 建议安装:

1. **lencx/skills** (必装)
   - 项目质量把控

2. **samber/cc-skills-golang** (可选)
   - Go 语言规范全套
```

### 场景 4: 项目维护

**推荐:**
```markdown
🎯 建议安装:

**lencx/skills** (质量把控)
- coding-protocol: 风险控制
- keel: 架构治理
```

---

## 组合型 Skill 库识别

### 标记方式

在 `featured-skills.json` 中:
```json
{
  "id": "mattpocock",
  "isSuite": true,
  "setupSkill": "setup-matt-pocock-skills",
  "setupGuide": "先启用 setup-matt-pocock-skills,它会自动配置整个工作流环境"
}
```

### 推荐时说明

```markdown
**mattpocock/skills** 是一个工作流套件,包含多个 skill。

安装方式:
- 一键配置: 启用 setup-matt-pocock-skills
- 包含: tdd, domain-modeling, diagnosing-bugs, implement, grill-me

建议先运行 setup 脚本,它会自动配置整个工作流环境。
```

---

## 推荐文案模板

### 模板 1: 开发项目

```markdown
## 🎯 推荐安装 (开发流程黄金组合)

### 1. mattpocock/skills (工作流套件)
- **安装方式**: 启用 setup-matt-pocock-skills 自动配置
- **包含**: TDD、领域建模、调试、实现、质询
- **用途**: 建立完整开发工作流

### 2. lencx/skills (项目把控)
- **安装方式**: 启用 coding-protocol + keel
- **包含**: 风险控制、架构治理
- **用途**: 防止 AI 误改,管理架构边界

💡 这两个库配合使用,覆盖开发全流程。
```

### 模板 2: 只推荐核心

```markdown
## 🎯 核心推荐

开发流程建议安装:
1. **mattpocock/skills** - 开发工作流套件
2. **lencx/skills** - 项目质量把控

安装后即可覆盖: TDD、调试、风险控制、架构治理。
```

---

## 记住这些要点

### ✅ DO
- 优先推荐有 setup 脚本的组合库
- 说明是"套件"还是"单个 skill"
- 开发项目推荐 mattpocock + lencx 黄金组合
- 一次不超过 3 个推荐

### ❌ DON'T
- 不要一次推荐太多
- 不要只列名字不说明用途
- 不要忽略 setup 脚本的重要性
- 不要推荐重复功能的库

---

## 数据结构

### isSuite 标记

```json
{
  "isSuite": true,          // 是否为组合型
  "setupSkill": "setup-xxx", // setup 脚本 skill
  "includes": ["skill1", "skill2"]  // 包含的 skills
}
```

### 场景推荐

```json
{
  "scenarios": {
    "new-project": {
      "recommend": {
        "primary": ["mattpocock-workflow", "lencx-control"],
        "why": "mattpocock 建立工作流,lencx 做把控"
      },
      "setupSteps": [
        "1. 启用 setup-matt-pocock-skills",
        "2. 启用 coding-protocol + keel",
        "3. 开始开发"
      ]
    }
  }
}
```

---

## 相关文件

- `featured-skills.json` - 推荐数据
- `skill-platforms.json` - 平台列表
- `view-recommendations.cjs` - 查看脚本
