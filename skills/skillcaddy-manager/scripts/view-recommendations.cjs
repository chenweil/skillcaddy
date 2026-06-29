#!/usr/bin/env node
/**
 * 查看推荐 skills 列表
 * 用法: node view-recommendations.js [command] [args]
 *
 * Commands:
 *   workflows          - 查看核心工作流推荐
 *   scenario <name>    - 查看特定场景推荐
 *   category <name>    - 查看特定分类
 *   platforms          - 查看平台列表
 *   all                - 查看所有内容
 */

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'references', 'featured-skills.json');
const platformsPath = path.join(__dirname, '..', 'references', 'skill-platforms.json');

function loadJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err.message);
    return null;
  }
}

function printEssentialWorkflows(workflows) {
  console.log('\n## 🎯 核心工作流推荐\n');
  console.log('开发流程黄金组合 (少而精):\n');

  for (const [key, workflow] of Object.entries(workflows)) {
    console.log(`### ${workflow.label}`);
    console.log(`${workflow.description}\n`);

    workflow.collections.forEach((col, idx) => {
      const typeIcon = col.type === 'workflow-suite' ? '📦' : '🔧';
      const priorityLabel = col.priority === 1 ? '【必装】' : '【必装】';

      console.log(`${idx + 1}. ${typeIcon} **${col.name}** ${priorityLabel}`);

      if (col.setupSkill) {
        console.log(`   ⚡ Setup: ${col.setupSkill} (一键配置)`);
      }

      console.log(`   📋 包含:`);
      col.includes.forEach(item => {
        console.log(`      - ${item}`);
      });

      console.log(`   🔧 安装: ${col.installCommand}`);

      if (col.installs) {
        console.log(`   📊 安装量: ${col.installs}`);
      }
      console.log('');
    });

    console.log(`💡 ${workflow.whyThisCombo}\n`);
    console.log('---\n');
  }
}

function printScenarioRecommendation(scenarios, scenarioName) {
  const scenario = scenarios[scenarioName];
  if (!scenario) {
    console.error(`Scenario "${scenarioName}" not found.`);
    console.log('Available scenarios:', Object.keys(scenarios).join(', '));
    return;
  }

  console.log(`\n## 🎯 ${scenario.label}\n`);
  console.log(`${scenario.description}\n`);

  if (scenario.recommend) {
    console.log('**推荐安装:**\n');

    if (scenario.recommend.primary) {
      console.log('核心推荐:');
      scenario.recommend.primary.forEach((id, idx) => {
        console.log(`  ${idx + 1}. ${id}`);
      });
    }

    if (scenario.recommend.optional) {
      console.log('\n可选推荐:');
      scenario.recommend.optional.forEach((id, idx) => {
        console.log(`  ${idx + 1}. ${id}`);
      });
    }

    if (scenario.recommend.why) {
      console.log(`\n💡 ${scenario.recommend.why}`);
    }
  }

  if (scenario.setupSteps) {
    console.log('\n**安装步骤:**');
    scenario.setupSteps.forEach(step => {
      console.log(`  ${step}`);
    });
  }
  console.log('');
}

function printCollections(collections, category = null, priority = null) {
  const categories = category ? { [category]: collections[category] } : collections;

  for (const [catName, catData] of Object.entries(categories)) {
    if (!catData || !catData.collections) continue;

    console.log(`\n## ${catData.label}`);
    console.log(`${catData.description}\n`);

    const filtered = priority
      ? catData.collections.filter(c => c.priority === priority)
      : catData.collections;

    filtered.forEach(col => {
      const priorityIcon = {
        essential: '🔥',
        recommended: '⭐',
        optional: '📦'
      }[col.priority] || '•';

      const suiteBadge = col.isSuite ? ' [套件]' : '';
      console.log(`${priorityIcon} **${col.name}**${suiteBadge} (${col.priority})`);

      if (col.setupSkill) {
        console.log(`   ⚡ Setup: ${col.setupSkill}`);
      }

      console.log(`   Repo: ${col.repo}`);
      console.log(`   Skills: ${col.skills.join(', ')}`);
      console.log(`   Reason: ${col.reason}`);

      if (col.installs) {
        console.log(`   Installs: ${col.installs}`);
      }

      if (col.setupGuide) {
        console.log(`   📝 Guide: ${col.setupGuide}`);
      }
      console.log('');
    });
  }
}

function printPlatforms(platforms) {
  console.log('\n## 🌐 Skills 平台\n');
  platforms.platforms.forEach(p => {
    console.log(`**${p.name}** (${p.url})`);
    console.log(`  ${p.description}`);
    console.log(`  适合: ${p.bestFor}`);
    console.log('');
  });
}

function printStrategy(strategy) {
  console.log('\n## 📋 推荐策略\n');
  console.log(`**原则**: ${strategy.principle}`);
  console.log(`**最多推荐**: ${strategy.maxRecommendations} 个库\n`);
  console.log('要点:');
  strategy.notes.forEach(note => {
    console.log(`  - ${note}`);
  });
}

// 主程序
const args = process.argv.slice(2);
const command = args[0];
const subCommand = args[1];

const data = loadJSON(dataPath);
const platforms = loadJSON(platformsPath);

if (!data) {
  console.error('Failed to load featured-skills.json');
  process.exit(1);
}

console.log('# Skillcaddy Recommendations');
console.log(`Version: ${data.version}`);
console.log(`Last Updated: ${data.lastUpdated}`);

// 显示推荐策略
if (data.recommendationStrategy) {
  printStrategy(data.recommendationStrategy);
}

switch (command) {
  case 'workflows':
    if (data.essentialWorkflows) {
      printEssentialWorkflows(data.essentialWorkflows);
    }
    break;

  case 'scenario':
    if (subCommand && data.scenarios) {
      printScenarioRecommendation(data.scenarios, subCommand);
    } else {
      console.log('\n可用场景:');
      Object.keys(data.scenarios || {}).forEach(key => {
        const s = data.scenarios[key];
        console.log(`  - ${key}: ${s.label}`);
      });
    }
    break;

  case 'category':
    if (subCommand && data.featured) {
      printCollections(data.featured, subCommand);
    } else {
      console.log('\n可用分类:');
      Object.keys(data.featured || {}).forEach(key => {
        const c = data.featured[key];
        console.log(`  - ${key}: ${c.label}`);
      });
    }
    break;

  case 'platforms':
    printPlatforms(platforms);
    break;

  case 'all':
    if (data.essentialWorkflows) {
      printEssentialWorkflows(data.essentialWorkflows);
    }
    if (data.featured) {
      printCollections(data.featured);
    }
    printPlatforms(platforms);
    break;

  default:
    // 默认显示核心工作流
    if (data.essentialWorkflows) {
      printEssentialWorkflows(data.essentialWorkflows);
    }

    console.log('\n---\n');
    console.log('Usage:');
    console.log('  node view-recommendations.cjs workflows          - 核心工作流');
    console.log('  node view-recommendations.cjs scenario new-project - 特定场景');
    console.log('  node view-recommendations.cjs category development - 特定分类');
    console.log('  node view-recommendations.cjs platforms          - 平台列表');
    console.log('  node view-recommendations.cjs all                - 查看所有');
    break;
}
