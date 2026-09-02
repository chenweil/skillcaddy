#!/usr/bin/env node
// #34 步骤 3。比对各侧事实，产出可直接贴回 issue 的 Markdown 报告。
//
// 分级是这份报告的核心，不是装饰：
//   FAIL       —— 破坏导入侧校验或内容语义。必须让 #35 处理。
//   DIAGNOSTIC —— 平台常量差异，已知且无害。记录但不阻断。
//
// 判定规则来自地图既有事实：checksumDirectory 不计 mtime/mode/owner/xattr
// （见 #25），所以这些项的差异不会让导入侧校验失败；而路径串、内容哈希、
// 条目类型、软链 target 会。

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');

async function load(name) {
  try {
    return JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

function indexByPath(facts) {
  const map = new Map();
  for (const entry of facts.entries) map.set(entry.path, entry);
  return map;
}

// 路径的 unicode 规范化差异会让条目看起来“丢失 + 新增”，实际上是同一个
// 文件换了存盘形式。单独识别它，否则报告会把真正的丢失埋在噪音里。
function pairUnicodeRenames(missing, added) {
  const renames = [];
  const remainingMissing = [];
  const addedByNFC = new Map();
  for (const item of added) addedByNFC.set(item.path.normalize('NFC'), item);

  for (const item of missing) {
    const key = item.path.normalize('NFC');
    const match = addedByNFC.get(key);
    if (match && match.path !== item.path) {
      renames.push({
        from: item.path,
        to: match.path,
        fromForm: item.path === item.path.normalize('NFC') ? 'NFC' : 'NFD',
        toForm: match.path === match.path.normalize('NFC') ? 'NFC' : 'NFD'
      });
      addedByNFC.delete(key);
    } else {
      remainingMissing.push(item);
    }
  }

  return { renames, missing: remainingMissing, added: [...addedByNFC.values()] };
}

// checksumDirectory 计入的字段。这些不一致 = 导入侧校验必然失败。
const CHECKSUM_BEARING = ['type', 'sha256', 'target'];
// 平台常量差异，checksumDirectory 不计。
const DIAGNOSTIC_ONLY = ['mode', 'uid', 'gid', 'nlink', 'mtime', 'xattrs', 'size'];
// #34 点名要验的项。它们不进哈希，但 issue 要求「逐项结果」，
// 所以不能只给聚合计数，必须逐条列出。
const SPEC_ITEMIZED_FIELDS = ['mode', 'uid', 'gid', 'xattrs'];

function execBits(mode) {
  return Number.parseInt(mode, 8) & 0o111;
}

function compare(baseline, candidate) {
  const left = indexByPath(baseline);
  const right = indexByPath(candidate);

  const missing = [];
  const added = [];
  const failures = [];
  const diagnostics = [];
  const execBitLosses = [];

  for (const [entryPath, entry] of left) {
    if (!right.has(entryPath)) {
      missing.push({ path: entryPath, type: entry.type });
      continue;
    }
    const other = right.get(entryPath);

    for (const field of CHECKSUM_BEARING) {
      if (entry[field] === undefined && other[field] === undefined) continue;
      if (JSON.stringify(entry[field]) !== JSON.stringify(other[field])) {
        failures.push({ path: entryPath, field, from: entry[field], to: other[field] });
      }
    }
    for (const field of DIAGNOSTIC_ONLY) {
      if (entry[field] === undefined && other[field] === undefined) continue;
      if (JSON.stringify(entry[field]) !== JSON.stringify(other[field])) {
        diagnostics.push({ path: entryPath, field, from: entry[field], to: other[field] });
      }
    }

    // 可执行 mode 是 #34 单独点名的一项。丢执行位会让 skill 里的脚本直接不能跑，
    // 后果远重于一般 mode 偏移，不能埋在聚合表里。
    if (entry.type === 'file' && execBits(entry.mode) !== 0 && execBits(other.mode) === 0) {
      execBitLosses.push({ path: entryPath, from: entry.mode, to: other.mode });
    }
  }

  for (const entryPath of right.keys()) {
    if (!left.has(entryPath)) added.push({ path: entryPath, type: right.get(entryPath).type });
  }

  const paired = pairUnicodeRenames(missing, added);

  return {
    missing: paired.missing,
    added: paired.added,
    unicodeRenames: paired.renames,
    failures,
    diagnostics,
    execBitLosses
  };
}

function envRow(facts) {
  if (!facts) return '| — | 未采集 | | | | |';
  const e = facts.environment;
  const osLabel = e.osVersion ? `${e.osVersion}（${e.platform} ${e.release}）` : `${e.platform} ${e.release}`;
  return `| ${facts.label} | ${osLabel} ${e.arch} | ${e.tar} | ${e.nodeVersion} | uid=${e.uid} umask=${e.umask} | ${facts.entryCount} |`;
}

function renderDelta(title, delta, baselineLabel, candidateLabel) {
  const lines = [];
  const hardFailure = delta.failures.length > 0 ||
    delta.missing.length > 0 ||
    delta.added.length > 0 ||
    delta.unicodeRenames.length > 0;
  const verdict = hardFailure ? 'FAIL' : 'PASS';

  lines.push(`### ${title}`);
  lines.push('');
  lines.push(`结论：**${verdict}**（基线 \`${baselineLabel}\` → 对照 \`${candidateLabel}\`）`);
  lines.push('');

  if (delta.unicodeRenames.length > 0) {
    lines.push(`**路径 unicode 规范化改变 ${delta.unicodeRenames.length} 项**（同一文件，存盘形式不同）。`);
    lines.push('`checksumDirectory` 把路径串计入哈希，所以这一项足以让整树校验和不等。');
    lines.push('');
    lines.push('| 基线路径 | 形式 | 对照路径 | 形式 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of delta.unicodeRenames.slice(0, 20)) {
      lines.push(`| \`${item.from}\` | ${item.fromForm} | \`${item.to}\` | ${item.toForm} |`);
    }
    if (delta.unicodeRenames.length > 20) {
      lines.push(`| … | | 另有 ${delta.unicodeRenames.length - 20} 项 | |`);
    }
    lines.push('');
  }

  if (delta.missing.length > 0) {
    lines.push(`条目丢失 ${delta.missing.length} 项：`);
    lines.push('');
    for (const item of delta.missing.slice(0, 40)) lines.push(`- \`${item.path}\` (${item.type})`);
    if (delta.missing.length > 40) lines.push(`- ……另有 ${delta.missing.length - 40} 项`);
    lines.push('');
  }

  if (delta.added.length > 0) {
    lines.push(`意外多出 ${delta.added.length} 项：`);
    lines.push('');
    for (const item of delta.added.slice(0, 40)) lines.push(`- \`${item.path}\` (${item.type})`);
    if (delta.added.length > 40) lines.push(`- ……另有 ${delta.added.length - 40} 项`);
    lines.push('');
  }

  if (delta.failures.length > 0) {
    lines.push(`校验相关差异 ${delta.failures.length} 项（会让导入侧 integrity 校验失败）：`);
    lines.push('');
    lines.push('| 路径 | 字段 | 基线 | 对照 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of delta.failures.slice(0, 40)) {
      lines.push(`| \`${item.path}\` | ${item.field} | \`${JSON.stringify(item.from)}\` | \`${JSON.stringify(item.to)}\` |`);
    }
    if (delta.failures.length > 40) lines.push(`| … | 另有 ${delta.failures.length - 40} 项 | | |`);
    lines.push('');
  }

  if (delta.execBitLosses.length > 0) {
    lines.push(`**可执行位丢失 ${delta.execBitLosses.length} 项**。不进 \`checksumDirectory\`，`);
    lines.push('但 #34 单独点名了可执行 mode，且它直接决定 skill 里的脚本能不能跑。');
    lines.push('');
    lines.push('| 路径 | 基线 mode | 对照 mode |');
    lines.push('| --- | --- | --- |');
    for (const item of delta.execBitLosses.slice(0, 40)) {
      lines.push(`| \`${item.path}\` | ${item.from} | ${item.to} |`);
    }
    if (delta.execBitLosses.length > 40) {
      lines.push(`| … | 另有 ${delta.execBitLosses.length - 40} 项 | |`);
    }
    lines.push('');
  }

  if (delta.diagnostics.length > 0) {
    // #34 点名的项（mode / owner / group / xattr）逐条列；issue 要求「逐项结果」。
    const itemized = delta.diagnostics.filter((item) => SPEC_ITEMIZED_FIELDS.includes(item.field));
    const aggregated = delta.diagnostics.filter((item) => !SPEC_ITEMIZED_FIELDS.includes(item.field));

    if (itemized.length > 0) {
      lines.push(`#34 点名项的逐条差异（mode / owner / group / xattr，共 ${itemized.length} 条）。`);
      lines.push('这些不进 `checksumDirectory`，不阻断导入，但属于验收口径待定项。');
      lines.push('');
      lines.push('| 路径 | 字段 | 基线 | 对照 |');
      lines.push('| --- | --- | --- | --- |');
      for (const item of itemized.slice(0, 60)) {
        lines.push(`| \`${item.path}\` | ${item.field} | \`${JSON.stringify(item.from)}\` | \`${JSON.stringify(item.to)}\` |`);
      }
      if (itemized.length > 60) lines.push(`| … | 另有 ${itemized.length - 60} 条 | | |`);
      lines.push('');
    }

    if (aggregated.length > 0) {
      // 按字段聚合：mtime / size / nlink 这类差异通常横扫整棵树，逐条列出没有信息量。
      const byField = new Map();
      for (const item of aggregated) {
        if (!byField.has(item.field)) byField.set(item.field, []);
        byField.get(item.field).push(item);
      }
      lines.push('其余诊断性差异（按字段聚合）：');
      lines.push('');
      lines.push('| 字段 | 条目数 | 示例 |');
      lines.push('| --- | ---: | --- |');
      for (const [field, items] of byField) {
        const sample = items[0];
        lines.push(`| ${field} | ${items.length} | \`${sample.path}\`: \`${JSON.stringify(sample.from)}\` → \`${JSON.stringify(sample.to)}\` |`);
      }
      lines.push('');
    }
  }

  if (verdict === 'PASS' && delta.diagnostics.length === 0) {
    lines.push('逐项完全一致。');
    lines.push('');
  }

  return lines.join('\n');
}

const source = await load('facts-macos-source.json');
const roundtrip = await load('facts-macos-roundtrip.json');
const roundtripXattrs = await load('facts-macos-roundtrip-xattrs.json');
const linuxPlain = await load('facts-linux-plain.json');
const linuxHardened = await load('facts-linux-hardened.json');
const linuxXattrs = await load('facts-linux-xattrs.json');

// xattr 镜像是单独一条链（打包时不加 --no-xattrs），不与主镜像同表比校验和。
const MAIN_CHAIN = [source, roundtrip, linuxPlain, linuxHardened];
const XATTR_CHAIN = [roundtripXattrs, linuxXattrs];

if (!source) {
  process.stderr.write(`未找到 ${dir}/facts-macos-source.json。先在 macOS 上运行 pack-macos.sh。\n`);
  process.exit(2);
}

const out = [];
out.push('# #34 保真度实测结果：macOS library image 在 Linux GNU tar 下');
out.push('');
out.push('由 `docs/research/0034-fidelity/` 的脚本生成。');
out.push('');

out.push('## 环境');
out.push('');
out.push('| 采集点 | OS | tar | Node | 身份 | 条目数 |');
out.push('| --- | --- | --- | --- | --- | ---: |');
for (const facts of [...MAIN_CHAIN, ...XATTR_CHAIN]) {
  if (facts) out.push(envRow(facts));
}
out.push('');

out.push('## 整树校验和');
out.push('');
out.push('这是决定性指标。`checksumDirectory` 是导入侧真正的校验闸门，');
out.push('它不计 mtime、mode、owner、xattr（见 #25），只计路径串、条目类型、');
out.push('文件内容与软链 target。');
out.push('');
out.push('| 采集点 | checksumDirectory |');
out.push('| --- | --- |');
for (const facts of MAIN_CHAIN) {
  if (facts) out.push(`| ${facts.label} | \`${facts.treeChecksum}\` |`);
}
out.push('');

const checksums = MAIN_CHAIN.filter(Boolean).map((f) => f.treeChecksum);
const allEqual = checksums.every((value) => value === checksums[0]);
out.push(allEqual
  ? `已采集的 ${checksums.length} 侧校验和一致。逐源 sha256 严格校验的方案在这些侧之间成立。`
  : `**已采集的 ${checksums.length} 侧校验和不一致。** 这直接威胁地图「逐源 sha256 严格校验，任一不匹配则整体失败」的前提，必须在 #35 处理。`);
if (checksums.length < MAIN_CHAIN.length) {
  out.push('');
  out.push(`注意：主链共 ${MAIN_CHAIN.length} 侧，只采到 ${checksums.length} 侧，结论仅覆盖已采集部分。`);
}
out.push('');

out.push('## 逐项比对');
out.push('');

if (roundtrip) {
  out.push(renderDelta('macOS 原地回环（分离 tar 自身的问题）', compare(source, roundtrip), source.label, roundtrip.label));
}
if (linuxPlain) {
  out.push(renderDelta('macOS → Linux GNU tar，无 flag', compare(source, linuxPlain), source.label, linuxPlain.label));
}
if (linuxHardened) {
  out.push(renderDelta('macOS → Linux GNU tar，#33 硬化 flag', compare(source, linuxHardened), source.label, linuxHardened.label));
}
if (linuxPlain && linuxHardened) {
  out.push(renderDelta('硬化 flag 的代价（plain → hardened）', compare(linuxPlain, linuxHardened), linuxPlain.label, linuxHardened.label));
}

// xattr 链单独一节。#34 点名要验 xattr 落地，而主镜像带 --no-xattrs，
// 只能用保留 xattr 的变体镜像回答。
out.push('## xattr 落地');
out.push('');
if (roundtripXattrs || linuxXattrs) {
  out.push('主镜像打包时加了 `--no-xattrs`，xattr 在进归档前就被剔掉，');
  out.push('拿它下「xattr 不跟 tar 存活」的结论是同义反复。这一节用');
  out.push('`library-image-xattrs.tar`（只去 AppleDouble、保留 xattr）重测。');
  out.push('');
  if (roundtripXattrs) {
    out.push(renderDelta('macOS 回环（xattr 镜像，-p 恢复）', compare(source, roundtripXattrs), source.label, roundtripXattrs.label));
  }
  if (linuxXattrs) {
    out.push(renderDelta('macOS → Linux GNU tar（xattr 镜像，--xattrs 恢复）', compare(source, linuxXattrs), source.label, linuxXattrs.label));
  }
} else {
  out.push('未采到 xattr 变体镜像的事实（`facts-*-xattrs.json` 缺失）。');
  out.push('#34 点名的 xattr 落地行为属于**未验证**，不要当作已结论。');
  out.push('');
}

out.push('## 待 #35 决策');
out.push('');
out.push('- 上表中任何 FAIL 项，是保证口径还是实现缺陷；');
out.push('- 诊断性差异里哪些要写进验收、哪些只作记录；');
out.push('- 若 owner/mode 在 root 与非 root 下不同，首版是否限定导入身份。');
out.push('');

process.stdout.write(`${out.join('\n')}\n`);
