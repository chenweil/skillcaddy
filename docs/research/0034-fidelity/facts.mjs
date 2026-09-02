#!/usr/bin/env node
// #34 保真度事实采集器。在打包侧与解包侧各跑一次，输出可比对的 JSON。
//
// 采集两类事实：
//   1. per-entry：路径、类型、mode、size、内容 sha256、软链 target、uid/gid、
//      nlink、mtime、xattr 名称与值摘要、文件名 unicode 规范化形式；
//   2. 整树：复用仓库自己的 checksumDirectory —— 这是导入侧真正的校验闸门，
//      因此它是否相等才是本次测试的决定性结论，而不是任何单项 mode 差异。
//
// xattr 记名称也记值摘要：#34 点名要验 xattr 的落地行为，只记名称会漏掉
// 「同名异值」。值本身可能很大，所以只存 sha256 前 16 位。

import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

/**
 * xattr 名称列表。macOS 与 Linux 的工具完全不同，且都可能未安装；
 * 缺工具时标 `unavailable` 而不是假装没有 xattr —— 两者结论不同。
 */
async function readXattrNames(target) {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('xattr', [target]);
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      return error?.code === 'ENOENT' ? 'unavailable' : [];
    }
  }
  try {
    // -m '' 匹配所有命名空间（默认只列 user.*，会漏掉 system.* / security.*）
    const { stdout } = await run('getfattr', ['-h', '-m', '', '--absolute-names', target]);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0]);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'unavailable';
    return [];
  }
}

/**
 * 单个 xattr 值的十六进制字节。读不到时返回 `unreadable` 而不是空串：
 * 「值为空」与「读不到值」是两个不同结论。
 */
async function readXattrHex(target, name) {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('xattr', ['-s', '-p', '-x', name, target]);
      return stdout.replace(/\s+/g, '').toLowerCase();
    } catch {
      return 'unreadable';
    }
  }
  try {
    const { stdout } = await run('getfattr', ['-h', '--absolute-names', '-e', 'hex', '-n', name, target]);
    const match = /=0x([0-9a-fA-F]*)/.exec(stdout);
    return match ? match[1].toLowerCase() : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * xattr 名称 + 值摘要。工具缺失时整体标 `unavailable`，
 * 逐条读不到值时该条标 `unreadable`，两者都不与「没有 xattr」混淆。
 */
async function readXattrs(target) {
  const names = await readXattrNames(target);
  if (names === 'unavailable') return 'unavailable';

  const records = [];
  for (const name of names) {
    const hex = await readXattrHex(target, name);
    records.push({
      name,
      value: hex === 'unreadable'
        ? 'unreadable'
        : createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 16)
    });
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

async function sha256File(target) {
  const hash = createHash('sha256');
  hash.update(await readFile(target));
  return hash.digest('hex');
}

function classify(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isSocket()) return 'socket';
  if (stats.isBlockDevice()) return 'block';
  if (stats.isCharacterDevice()) return 'character';
  return 'unknown';
}

async function collectEntries(root) {
  const entries = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, dirent.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stats = await lstat(absolute);
      const type = classify(stats);

      const entry = {
        path: relative,
        type,
        // symlink 的 lstat mode 在 macOS 是 0755、Linux 是 0777，属平台常量差异，
        // 报告侧按 diagnostic 处理，不算保真度失败。
        mode: (stats.mode & 0o7777).toString(8).padStart(4, '0'),
        uid: stats.uid,
        gid: stats.gid,
        nlink: stats.nlink,
        mtime: Math.floor(stats.mtimeMs / 1000),
        xattrs: await readXattrs(absolute)
      };

      // 文件名的 unicode 规范化形式。macOS 历史上以 NFD 存盘，
      // 一旦跨平台后变成 NFC，路径串就变了，checksumDirectory 会直接不等。
      const nfc = relative.normalize('NFC');
      const nfd = relative.normalize('NFD');
      if (nfc !== nfd) {
        entry.unicode = { isNFC: relative === nfc, isNFD: relative === nfd };
      }

      if (type === 'file') {
        entry.size = stats.size;
        entry.sha256 = await sha256File(absolute);
      } else if (type === 'symlink') {
        entry.target = await readlink(absolute);
      } else if (type === 'directory') {
        queue.push(absolute);
      }

      entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function tarVersion() {
  try {
    const { stdout } = await run('tar', ['--version']);
    return stdout.split('\n')[0].trim();
  } catch {
    return 'unavailable';
  }
}

/**
 * 发行版级别的 OS 版本。#34 要求记录「OS 与架构版本」，而 `os.release()`
 * 在 Linux 只给内核版本（`6.8.0-xx`），拿不到 Ubuntu 24.04 这类发行版标识。
 */
async function osVersion() {
  if (process.platform === 'darwin') {
    try {
      const [name, version] = await Promise.all([
        run('sw_vers', ['-productName']),
        run('sw_vers', ['-productVersion'])
      ]);
      return `${name.stdout.trim()} ${version.stdout.trim()}`;
    } catch {
      return os.release();
    }
  }
  try {
    const text = await readFile('/etc/os-release', 'utf8');
    const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text);
    if (match) return match[1];
  } catch {
    // 没有 /etc/os-release 时退回内核版本
  }
  return os.release();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root && path.resolve(args.root);
  const out = args.out && path.resolve(args.out);
  const repo = args.repo && path.resolve(args.repo);

  if (!root || !out || !repo) {
    process.stderr.write('usage: facts.mjs --root <dir> --out <file.json> --repo <skillcaddy-root> [--label <name>]\n');
    process.exit(2);
  }

  // 复用仓库自己的实现，而不是重新写一遍哈希：
  // 重写的版本一旦与生产实现有任何偏差，这次测试就失去意义。
  const { checksumDirectory } = await import(path.join(repo, 'lib', 'sourceTree.js'));

  const entries = await collectEntries(root);

  let treeChecksum;
  try {
    treeChecksum = await checksumDirectory(root);
  } catch (error) {
    treeChecksum = `ERROR: ${error.message}`;
  }

  const facts = {
    label: args.label || 'unlabeled',
    capturedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      osVersion: await osVersion(),
      release: os.release(),
      arch: process.arch,
      nodeVersion: process.version,
      tar: await tarVersion(),
      umask: process.umask().toString(8).padStart(4, '0'),
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null
    },
    treeChecksum,
    entryCount: entries.length,
    entries
  };

  await writeFile(out, `${JSON.stringify(facts, null, 2)}\n`);
  process.stdout.write(`${args.label || 'facts'}: ${entries.length} entries, checksum ${treeChecksum}\n`);
}

await main();
