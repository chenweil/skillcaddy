#!/usr/bin/env node
/**
 * Skillcaddy 版本管理脚本
 * 用法:
 *   node version-manager.cjs check      - 检查版本
 *   node version-manager.cjs sync       - 同步版本号
 *   node version-manager.cjs changelog  - 查看更新日志
 */

const fs = require('fs');
const path = require('path');

// 从 skill 目录向上找到项目根目录
const skillDir = __dirname; // skills/skillcaddy-manager/scripts
const skillcaddyRoot = path.resolve(skillDir, '..', '..', '..'); // 回到 skillcaddy 根目录

const dataPath = path.join(skillDir, '..', 'references', 'featured-skills.json');
const packagePath = path.join(skillcaddyRoot, 'package.json');

console.log('');

function loadJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err.message);
    return null;
  }
}

function checkVersion() {
  const data = loadJSON(dataPath);
  const pkg = loadJSON(packagePath);

  if (!data || !pkg) {
    console.error('Failed to load version information');
    process.exit(1);
  }

  console.log('## 📦 Skillcaddy 版本信息\n');
  console.log(`**Skillcaddy 版本**: ${pkg.version}`);
  console.log(`**推荐数据版本**: ${data.version}`);
  console.log(`**最后更新**: ${data.lastUpdated}\n`);

  if (data.version !== pkg.version) {
    console.log('⚠️ 版本不匹配!');
    console.log(`  推荐数据版本: ${data.version}`);
    console.log(`  当前项目版本: ${pkg.version}`);
    console.log('\n建议运行: node version-manager.cjs sync\n');
  } else {
    console.log('✅ 版本同步\n');
  }
}

function showChangelog() {
  const data = loadJSON(dataPath);

  if (!data || !data.changelog) {
    console.error('No changelog available');
    return;
  }

  console.log('## 📋 更新日志\n');

  data.changelog.forEach(entry => {
    console.log(`### Version ${entry.version} (${entry.date})`);
    entry.changes.forEach(change => {
      console.log(`  - ${change}`);
    });
    console.log('');
  });
}

function syncVersion() {
  const pkg = loadJSON(packagePath);
  const data = loadJSON(dataPath);

  if (!pkg || !data) {
    console.error('Failed to load files');
    process.exit(1);
  }

  console.log('## 🔄 同步版本\n');
  console.log(`当前项目版本: ${pkg.version}`);
  console.log(`推荐数据版本: ${data.version}\n`);

  if (data.version === pkg.version) {
    console.log('✅ 版本已同步,无需更新\n');
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  // 同步版本号
  data.version = pkg.version;
  data.lastUpdated = today;

  // 添加 changelog 条目
  const newChange = {
    version: pkg.version,
    date: today,
    changes: [
      `同步至 Skillcaddy v${pkg.version}`,
      "更新推荐数据和配置"
    ]
  };

  if (!data.changelog) {
    data.changelog = [];
  }
  data.changelog.unshift(newChange);

  // 保存文件
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  console.log('✅ 版本已同步\n');
  console.log('记得提交更改:');
  console.log('  git add references/featured-skills.json');
  console.log(`  git commit -m "chore: sync recommendations to v${pkg.version}"`);
}

// 主程序
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'check':
    checkVersion();
    break;

  case 'sync':
    syncVersion();
    break;

  case 'changelog':
    showChangelog();
    break;

  default:
    console.log('Usage:');
    console.log('  node version-manager.cjs check      - 检查版本同步');
    console.log('  node version-manager.cjs sync       - 同步版本号');
    console.log('  node version-manager.cjs changelog  - 查看更新日志');
    break;
}
