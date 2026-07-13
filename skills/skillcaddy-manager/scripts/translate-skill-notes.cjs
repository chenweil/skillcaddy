#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 4173;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_NOTE_LENGTH = 500;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;

function parseArgs(argv) {
  const opts = {
    command: '',
    file: '',
    port: DEFAULT_PORT,
    project: '.',
    yes: false,
    forceRewrite: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === 'list' || arg === 'apply') opts.command = arg;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--force-rewrite') opts.forceRewrite = true;
    else if (arg.startsWith('--port=')) opts.port = parsePort(arg.slice('--port='.length));
    else if (arg === '--port') opts.port = parsePort(argv[++index]);
    else if (arg.startsWith('--project=')) opts.project = arg.slice('--project='.length);
    else if (arg === '--project') opts.project = argv[++index] || '.';
    else if (!arg.startsWith('--') && !opts.file) opts.file = arg;
    else throw new Error(`未知参数: ${arg}`);
  }

  return opts;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`无效端口: ${value}`);
  return port;
}

async function fetchState(port, project) {
  const url = `http://127.0.0.1:${port}/api/state?projectPath=${encodeURIComponent(path.resolve(project))}`;
  return requestJson(url);
}

async function postMetadata(port, payload) {
  return requestJson(`http://127.0.0.1:${port}/api/skill-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${options.method || 'GET'} ${url} 返回了无效 JSON`);
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `${options.method || 'GET'} ${url} failed: ${res.status}`);
  }
  return body;
}

function needsTranslation(skill) {
  if (skill.source === 'archived') return false;
  if (String(skill.note || '').trim()) return false;

  const description = String(skill.description || '').trim();
  if (!hasMeaningfulText(description)) return false;
  return !isMostlyChinese(description);
}

function hasMeaningfulText(value) {
  return (String(value).match(/[A-Za-z\u3400-\u9fff]/gu) || []).length >= 3;
}

function isMostlyChinese(value) {
  const text = String(value);
  const chinese = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return chinese >= 4 && chinese >= latin;
}

function createTranslationManifest(state) {
  return {
    schemaVersion: 1,
    libraryRoot: path.resolve(state.rootDir),
    entries: (state.skills || [])
      .filter(needsTranslation)
      .map((skill) => ({
        id: skill.id,
        source: skill.source,
        collection: skill.collection,
        name: skill.name,
        description: skill.description,
        note: ''
      }))
  };
}

function parseManifest(raw) {
  const manifest = JSON.parse(raw);
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('manifest 必须是带 libraryRoot 和 entries 的对象');
  if (manifest.schemaVersion !== 1) throw new Error('manifest schemaVersion 必须是 1');
  if (!manifest.libraryRoot || typeof manifest.libraryRoot !== 'string') throw new Error('manifest 缺少 libraryRoot');
  if (!Array.isArray(manifest.entries)) throw new Error('manifest entries 必须是数组');
  return manifest;
}

function preflightManifest(manifest, state, options = {}) {
  const errors = [];
  const changes = [];
  const unchanged = [];
  const seenIds = new Set();
  const expectedRoot = path.resolve(state.rootDir);

  if (path.resolve(manifest.libraryRoot) !== expectedRoot) {
    errors.push(`libraryRoot 不匹配: manifest=${path.resolve(manifest.libraryRoot)} server=${expectedRoot}`);
  }

  const byId = new Map((state.skills || []).map((skill) => [skill.id, skill]));
  manifest.entries.forEach((entry, index) => {
    const label = entry?.id || `entries[${index}]`;
    try {
      const normalized = normalizeEntry(entry, label);
      if (seenIds.has(normalized.id)) throw new Error('id 重复');
      seenIds.add(normalized.id);

      const skill = byId.get(normalized.id);
      if (!skill) throw new Error('找不到对应 skill');
      const currentNote = String(skill.note || '').trim();
      if (currentNote && currentNote !== normalized.note && !options.forceRewrite) {
        throw new Error('已有 note，默认拒绝覆盖；确需重写时使用 --force-rewrite');
      }

      const payload = {
        skillPath: skill.path,
        note: normalized.note,
        tags: normalized.tags ?? skill.tags ?? [],
        autoEnable: normalized.autoEnable ?? skill.autoEnable ?? true
      };
      if (metadataMatches(skill, payload)) unchanged.push(normalized.id);
      else changes.push({ id: normalized.id, skill, payload });
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  });

  if (errors.length > 0) {
    const error = new Error(`预检失败:\n- ${errors.join('\n- ')}`);
    error.errors = errors;
    throw error;
  }

  return { libraryRoot: expectedRoot, changes, unchanged };
}

function normalizeEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('条目必须是对象');
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) throw new Error('id 不能为空');
  if (typeof entry.note !== 'string') throw new Error('note 必须是字符串');
  const note = entry.note.trim();
  if (!note) throw new Error('note 不能为空');
  if (note.length > MAX_NOTE_LENGTH) throw new Error(`note 不能超过 ${MAX_NOTE_LENGTH} 个字符`);

  return {
    id,
    note,
    tags: entry.tags === undefined ? undefined : normalizeTags(entry.tags),
    autoEnable: entry.autoEnable === undefined ? undefined : normalizeAutoEnable(entry.autoEnable, label)
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error('tags 必须是字符串数组');
  const normalized = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new Error('tags 只能包含字符串');
    const value = tag.trim();
    if (!value) continue;
    if (value.length > MAX_TAG_LENGTH) throw new Error(`tag 不能超过 ${MAX_TAG_LENGTH} 个字符: ${value}`);
    if (!normalized.includes(value)) normalized.push(value);
  }
  if (normalized.length > MAX_TAGS) throw new Error(`tags 不能超过 ${MAX_TAGS} 个`);
  return normalized;
}

function normalizeAutoEnable(value) {
  if (typeof value !== 'boolean') throw new Error('autoEnable 必须是布尔值');
  return value;
}

function metadataMatches(skill, payload) {
  return String(skill.note || '').trim() === payload.note
    && Boolean(skill.autoEnable ?? true) === payload.autoEnable
    && JSON.stringify(skill.tags || []) === JSON.stringify(payload.tags);
}

async function executePlan(plan, options = {}) {
  if (!options.yes) return { dryRun: true, updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;
  for (const change of plan.changes) {
    try {
      await (options.postMetadata || postMetadata)(options.port, change.payload);
      process.stderr.write(`✓ ${change.id}\n`);
      updated += 1;
    } catch (error) {
      process.stderr.write(`✗ ${change.id}: ${error.message}\n`);
      failed += 1;
    }
  }
  return { dryRun: false, updated, failed };
}

function printPlan(plan) {
  process.stderr.write(`目标库: ${plan.libraryRoot}\n`);
  process.stderr.write(`计划更新: ${plan.changes.length}，无需更新: ${plan.unchanged.length}\n`);
  plan.changes.forEach((change) => process.stderr.write(`- ${change.id}\n`));
}

async function listCommand(opts) {
  const state = await fetchState(opts.port, opts.project);
  const manifest = createTranslationManifest(state);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`待翻译: ${manifest.entries.length} 个 skill\n`);
}

async function applyCommand(opts) {
  if (!opts.file) throw new Error('apply 需要 manifest 文件路径');
  const manifest = parseManifest(fs.readFileSync(path.resolve(opts.file), 'utf8'));
  const state = await fetchState(opts.port, opts.project);
  const plan = preflightManifest(manifest, state, { forceRewrite: opts.forceRewrite });
  printPlan(plan);

  const result = await executePlan(plan, {
    yes: opts.yes,
    port: opts.port
  });
  if (result.dryRun) {
    process.stderr.write('仅完成预检，未写入；确认后加 --yes 执行。\n');
  } else {
    process.stderr.write(`完成: 成功 ${result.updated}，失败 ${result.failed}\n`);
  }
  return result.failed > 0 ? 1 : 0;
}

function printUsage() {
  process.stderr.write('用法:\n');
  process.stderr.write('  node skills/skillcaddy-manager/scripts/translate-skill-notes.cjs list [--port=4173] [--project=.]\n');
  process.stderr.write('  node skills/skillcaddy-manager/scripts/translate-skill-notes.cjs apply <manifest.json> [--yes] [--force-rewrite]\n');
}

async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    if (opts.command === 'list') await listCommand(opts);
    else if (opts.command === 'apply') return applyCommand(opts);
    else {
      printUsage();
      return 2;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`错误: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  createTranslationManifest,
  executePlan,
  isMostlyChinese,
  main,
  needsTranslation,
  parseArgs,
  parseManifest,
  preflightManifest
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
