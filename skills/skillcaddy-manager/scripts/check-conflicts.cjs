#!/usr/bin/env node
/**
 * 冲突检测示例
 * 用法: node check-conflicts.cjs <collection-id>
 */

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'references', 'featured-skills.json');

function loadJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err.message);
    return null;
  }
}

function findCollectionById(data, id) {
  for (const [catName, catData] of Object.entries(data.featured || {})) {
    const found = catData.collections.find(c => c.id === id);
    if (found) return found;
  }
  return null;
}

function checkConflicts(data, installedIds, tryingToInstallId) {
  const conflicts = data.conflicts || {};
  const tryingCollection = findCollectionById(data, tryingToInstallId);

  const results = [];

  // 检查 collection 自身的 conflictWith 标记
  if (tryingCollection && tryingCollection.conflictWith) {
    for (const conflictId of tryingCollection.conflictWith) {
      if (installedIds.includes(conflictId)) {
        const conflictCollection = findCollectionById(data, conflictId);
        results.push({
          type: 'collection-conflict',
          existing: conflictId,
          existingName: conflictCollection?.name || conflictId,
          conflicting: tryingToInstallId,
          conflictingName: tryingCollection.name,
          reason: '两者功能重叠,都是开发工作流套件',
          recommendation: `保留 ${conflictCollection?.name || conflictId},或先禁用后再启用 ${tryingCollection.name}`
        });
      }
    }
  }

  // 检查全局 conflicts 配置
  for (const [conflictId, conflict] of Object.entries(conflicts)) {
    if (conflict.collections) {
      const hasExisting = conflict.collections.some(c => installedIds.includes(c));
      const hasTrying = conflict.collections.includes(tryingToInstallId);

      if (hasExisting && hasTrying) {
        const existing = conflict.collections.find(c => installedIds.includes(c));
        results.push({
          type: 'global-conflict',
          existing,
          conflicting: tryingToInstallId,
          reason: conflict.reason,
          recommendation: conflict.recommendation
        });
      }
    }
  }

  return results;
}

// 主程序
const args = process.argv.slice(2);
const toInstall = args[0];

if (!toInstall) {
  console.log('Usage: node check-conflicts.cjs <collection-id>');
  console.log('Example: node check-conflicts.cjs superpowers');
  process.exit(1);
}

const data = loadJSON(dataPath);
if (!data) {
  console.error('Failed to load featured-skills.json');
  process.exit(1);
}

// 模拟已安装的库 (实际应从 API 获取)
const installed = ['mattpocock']; // 假设已安装 mattpocock

console.log('检查冲突...');
console.log(`已安装: ${installed.join(', ') || '无'}`);
console.log(`准备安装: ${toInstall}\n`);

const conflicts = checkConflicts(data, installed, toInstall);

if (conflicts.length === 0) {
  console.log('✅ 无冲突,可以安全安装');
} else {
  console.log('⚠️ 检测到冲突!\n');

  conflicts.forEach((conflict, idx) => {
    console.log(`冲突 ${idx + 1}:`);
    console.log(`  已安装: ${conflict.existingName || conflict.existing}`);
    console.log(`  尝试安装: ${conflict.conflictingName || conflict.conflicting}`);
    console.log(`  原因: ${conflict.reason}`);
    console.log(`  建议: ${conflict.recommendation}`);
    console.log('');
  });

  console.log('---');
  console.log('建议:');
  console.log('  1. 保留现有库,不安装新库');
  console.log('  2. 或先禁用现有库,再启用新库');
}
