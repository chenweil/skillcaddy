#!/usr/bin/env node
/**
 * 全局 Skills 检测脚本
 * 用法: node check-global-skills.cjs
 *
 * 检测全局 skills 目录,建议用户安装 skillcaddy
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 跨平台路径检测
const globalPaths = {
  darwin: {
    codex: path.join(os.homedir(), '.agents/skills'),
    claude: path.join(os.homedir(), '.claude/skills')
  },
  linux: {
    codex: path.join(os.homedir(), '.agents/skills'),
    claude: path.join(os.homedir(), '.claude/skills')
  },
  win32: {
    codex: path.join(os.homedir(), '.agents/skills'),
    claude: path.join(os.homedir(), '.claude/skills'),
    // Windows 可能的其他路径
    codexAlt: path.join(process.env.APPDATA || '', '.agents/skills'),
    claudeAlt: path.join(process.env.APPDATA || '', '.claude/skills')
  }
};

function checkGlobalSkills() {
  const platform = os.platform();
  const paths = globalPaths[platform] || globalPaths.darwin;

  const results = {
    platform: platform,
    hasGlobalSkills: false,
    hasSkillcaddy: false,
    globalPaths: [],
    skillcaddyPaths: [],
    recommendations: []
  };

  // 检查每个可能的路径
  for (const [type, skillPath] of Object.entries(paths)) {
    if (!skillPath) continue;

    if (fs.existsSync(skillPath)) {
      const isDir = fs.statSync(skillPath).isDirectory();
      if (isDir) {
        results.hasGlobalSkills = true;
        results.globalPaths.push({ type, path: skillPath });

        // 检查是否包含 skillcaddy-manager
        const skillcaddyPath = path.join(skillPath, 'skillcaddy-manager');
        if (fs.existsSync(skillcaddyPath)) {
          results.hasSkillcaddy = true;
          results.skillcaddyPaths.push(skillcaddyPath);
        }

        // 检查目录内容
        try {
          const items = fs.readdirSync(skillPath).filter(item => {
            const itemPath = path.join(skillPath, item);
            return fs.statSync(itemPath).isDirectory() && !item.startsWith('.');
          });

          if (items.length > 0 && !results.skillCount) {
            results.skillCount = items.length;
            results.skillList = items.slice(0, 5); // 只显示前5个
          }
        } catch (err) {
          // 忽略读取错误
        }
      }
    }
  }

  return results;
}

function printReport(results) {
  console.log('## 🔍 全局 Skills 检测报告\n');
  console.log(`**操作系统**: ${results.platform}\n`);

  if (!results.hasGlobalSkills) {
    console.log('✅ 未检测到全局 skills 目录\n');
    console.log('建议:');
    console.log('  - 如需管理多个项目的 skills,可安装 Skillcaddy');
    console.log('  - 访问: https://github.com/chenweil/skillcaddy\n');
    return;
  }

  console.log('📁 检测到全局 Skills 目录:\n');
  results.globalPaths.forEach(({ type, path }) => {
    console.log(`  ${type}: ${path}`);
  });

  if (results.skillCount) {
    console.log(`\n📊 发现 ${results.skillCount} 个全局 skills:`);
    results.skillList.forEach(skill => {
      console.log(`  - ${skill}`);
    });
    if (results.skillCount > 5) {
      console.log(`  ... 还有 ${results.skillCount - 5} 个`);
    }
  }

  console.log('\n---\n');

  if (results.hasSkillcaddy) {
    console.log('✅ 已安装 Skillcaddy\n');
    console.log('全局 skillcaddy-manager 位置:');
    results.skillcaddyPaths.forEach(p => {
      console.log(`  ${p}`);
    });
    console.log('\n💡 建议:');
    console.log('  - 在项目中使用 skillcaddy-manager 启用/禁用 skills');
    console.log('  - 使用 Web UI 管理: http://127.0.0.1:4173\n');
  } else {
    console.log('⚠️ 未检测到 Skillcaddy\n');
    console.log('💡 建议安装 Skillcaddy:\n');
    console.log('**为什么需要 Skillcaddy?**');
    console.log('  - ✅ 集中管理所有 skills (单一事实来源)');
    console.log('  - ✅ 按项目启用/禁用 (避免污染)');
    console.log('  - ✅ 多 Agent 兼容 (Claude Code / Codex / OpenCode)');
    console.log('  - ✅ 版本控制和更新管理');
    console.log('  - ✅ 避免重复复制和版本漂移\n');

    console.log('**安装步骤:**');
    console.log('```bash');
    console.log('# 克隆 Skillcaddy');
    console.log('git clone https://github.com/chenweil/skillcaddy.git');
    console.log('cd skillcaddy');
    console.log('');
    console.log('# 启动 Web 管理器');
    console.log('npm start');
    console.log('');
    console.log('# 访问 http://127.0.0.1:4173');
    console.log('```\n');

    console.log('**迁移全局 Skills 到 Skillcaddy:**');
    console.log('```bash');
    console.log('# 1. 将全局 skills 移动到 Skillcaddy 库');
    console.log('mv ~/.agents/skills/my-skill /path/to/skillcaddy/personal/my-skill');
    console.log('');
    console.log('# 2. 删除全局目录 (可选)');
    console.log('rm -rf ~/.agents/skills');
    console.log('');
    console.log('# 3. 在项目中按需启用');
    console.log('# 使用 Web UI 或 skillcaddy-manager skill');
    console.log('```\n');

    console.log('**了解更多:**');
    console.log('  - GitHub: https://github.com/chenweil/skillcaddy');
    console.log('  - 文档: /path/to/skillcaddy/README.md\n');
  }
}

// 主程序
const results = checkGlobalSkills();
printReport(results);

// 导出函数供其他脚本使用
module.exports = {
  checkGlobalSkills,
  globalPaths
};
