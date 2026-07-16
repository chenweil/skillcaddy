#!/usr/bin/env node
/**
 * Print comparable collection profiles for agent review.
 * The script preserves the historical command name but does not decide conflicts.
 *
 * Usage:
 *   node check-conflicts.cjs <collection-id>
 *   node check-conflicts.cjs <collection-id> --against <id,id,...>
 */

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'references', 'featured-skills.json');

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const args = [...argv];
  const collectionId = args.shift() || '';
  let against = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--against') {
      against = String(args[index + 1] || '').split(',').filter(Boolean);
      index += 1;
    } else if (arg.startsWith('--against=')) {
      against = arg.slice('--against='.length).split(',').filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { collectionId, against };
}

function getCollections(data) {
  return Object.values(data.featured || {})
    .flatMap(category => category.collections || []);
}

function summarizeCollection(collection) {
  return {
    id: collection.id,
    name: collection.name || collection.id,
    description: collection.description || collection.reason || collection.note || '',
    tags: collection.tags || [],
    capabilities: collection.skills || collection.includes || []
  };
}

function buildComparison(collections, candidateId, againstIds = []) {
  const byId = new Map(collections.map(collection => [collection.id, collection]));
  const candidate = byId.get(candidateId);
  if (!candidate) throw new Error(`Unknown collection: ${candidateId}`);

  const targetIds = againstIds.length > 0
    ? againstIds
    : collections.map(collection => collection.id).filter(id => id !== candidateId);

  const comparisons = targetIds
    .filter(id => id !== candidateId)
    .map(id => {
      const collection = byId.get(id);
      if (!collection) throw new Error(`Unknown comparison collection: ${id}`);
      return summarizeCollection(collection);
    });

  return {
    candidate: summarizeCollection(candidate),
    comparisons
  };
}

function printProfile(label, collection) {
  console.log(`## ${label}: ${collection.id}`);
  console.log(`名称: ${collection.name}`);
  console.log(`描述: ${collection.description || '无'}`);
  console.log(`标签: ${collection.tags.join(', ') || '无'}`);
  console.log(`能力: ${collection.capabilities.join(', ') || '无'}\n`);
}

function printReport(result) {
  console.log('# Skillcaddy 能力重叠审查素材\n');
  printProfile('候选库', result.candidate);
  for (const comparison of result.comparisons) {
    printProfile('对照库', comparison);
  }
  console.log('请根据名称、描述、标签和能力清单判断它们是互补、重复还是信息不足。');
  console.log('本脚本不包含固定库名规则，也不自动给出冲突结论。');
}

if (require.main === module) {
  try {
    const { collectionId, against } = parseArgs(process.argv.slice(2));
    if (!collectionId) {
      console.error('Usage: node check-conflicts.cjs <collection-id> [--against <id,id,...>]');
      process.exitCode = 1;
    } else {
      const data = loadJSON(dataPath);
      printReport(buildComparison(getCollections(data), collectionId, against));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  buildComparison,
  getCollections,
  parseArgs,
  summarizeCollection
};
