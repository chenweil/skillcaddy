# Skillcaddy References 总结

## 📁 目录结构

```
references/
├── featured-skills.json        # 推荐数据 (9.9K)
├── skill-platforms.json        # 平台参考 (1.7K)
├── README.md                   # 目录说明 (3.6K)
├── RECOMMENDATION_GUIDE.md     # 推荐策略指南 (15K) ⭐
├── view-recommendations.cjs    # 查看脚本 (6.9K)
├── check-conflicts.cjs         # 冲突检测 (3.6K)
├── check-global-skills.cjs     # 全局检测 (5.3K)
├── version-manager.cjs         # 版本管理 (3.5K)
└── SUMMARY.md                  # 本文件
```

## 🎯 核心功能

### 1. 推荐策略 (少而精)
- 一次最多推荐 **3 个库**
- 开发流程黄金组合: **mattpocock + lencx**
- 优先推荐有 setup 脚本的套件

### 2. 冲突检测
- **mattpocock ⚔️ superpowers** (二选一)
- 监测已安装库,避免冲突推荐

### 3. 全局 Skills 检测
- 检测 `~/.agents/skills` 和 `~/.claude/skills`
- 跨平台支持 (macOS/Linux/Windows)
- 建议安装 Skillcaddy 统一管理

### 4. 版本管理
- 版本号与 Skillcaddy 主项目同步
- 自动同步: `node skills/skillcaddy-manager/scripts/version-manager.cjs sync`

## 🚀 常用命令

```bash
# 空库引导
node skills/skillcaddy-manager/scripts/view-recommendations.cjs onboarding

# 查看核心工作流推荐
node skills/skillcaddy-manager/scripts/view-recommendations.cjs workflows

# 查看场景推荐
node skills/skillcaddy-manager/scripts/view-recommendations.cjs scenario new-project

# 检测冲突
node skills/skillcaddy-manager/scripts/check-conflicts.cjs superpowers

# 检测全局 Skills
node skills/skillcaddy-manager/scripts/check-global-skills.cjs

# 检查版本同步
node skills/skillcaddy-manager/scripts/version-manager.cjs check

# 同步版本号
node skills/skillcaddy-manager/scripts/version-manager.cjs sync

# 查看更新日志
node skills/skillcaddy-manager/scripts/version-manager.cjs changelog
```

## 📋 记住的关键点

### ✅ 推荐原则
1. 少而精,不超过 3 个
2. 空库先推平台入口,不要默认推具体库
3. 明确开发项目时再推荐 mattpocock + lencx
4. 已有库时优先补短板
5. 检测冲突并提醒用户

### ✅ 冲突处理
- mattpocock vs superpowers (二选一)
- 检测已安装库,避免冲突
- 给出明确建议

### ✅ 全局检测
- 检测全局 skills 目录
- 建议安装 Skillcaddy
- 提供迁移方案

### ✅ 版本同步
- 版本号与主项目一致
- 自动同步功能
- changelog 记录

## 🌐 Skills 平台

### SkillsMP (https://skillsmp.com)
- 海量收录,中文界面,语义搜索
- 适合: 想"广撒网"找技能的人

### Skills.sh (https://www.skills.sh)
- 24 小时热度排行
- 适合: 想看当前热门技能

## 📊 数据版本

**当前版本**: 0.8.0
**最后更新**: 2026-06-29

---

更多详情请查看:
- [RECOMMENDATION_GUIDE.md](./RECOMMENDATION_GUIDE.md) - 完整推荐策略
- [README.md](./README.md) - 目录说明
