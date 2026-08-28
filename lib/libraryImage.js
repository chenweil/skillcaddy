import { SourceAcquisitionError } from './sourceAcquisitionError.js';

// 默认限制。形状与 `DEFAULT_ARCHIVE_LIMITS`（`lib/sourceArchive.js`）一致，
// `maxDepth` 提高到 40 以容忍 tar 内更深嵌套，同时保持失败语义闭环。
export const DEFAULT_LIBRARY_IMAGE_LIMITS = Object.freeze({
  maxExpandedBytes: 500 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxDepth: 40
});

// 仅允许这两类条目在 staging 内存在；其余全部视为拒绝条件。
export const LIBRARY_IMAGE_ENTRY_TYPES = new Set(['file', 'directory']);

// 系统 tar 在不同实现上对同一文件类型有不同名词；
// 任何条目被识别为以下任一类型时立即拒绝，避免 special 文件、symlink-first、hardlink escape。
export const LIBRARY_IMAGE_DENIED_ENTRY_TYPES = new Set([
  'symlink',
  'hardlink',
  'fifo',
  'block',
  'character',
  'socket',
  'contiguous',
  'unknown'
]);

// 由 Issue #33 的研究产出填充；常量空时模块必须 fail closed。
// 一旦研究落地（macOS bsdtar + Linux GNU tar 的 flag 兼容性），该常量由独立 commit 写入。
// 测试 `test/libraryImage.test.js` 保证该常量在 ship 前非空。
export const LIBRARY_IMAGE_REQUIRED_TAR_FLAGS = Object.freeze([]);

function requireLoadedFlagPolicy() {
  if (LIBRARY_IMAGE_REQUIRED_TAR_FLAGS.length === 0) {
    throw new SourceAcquisitionError(
      'source-safety',
      'library image extraction is locked: tar flag policy not loaded. Populate LIBRARY_IMAGE_REQUIRED_TAR_FLAGS from Issue #33 research before shipping.'
    );
  }
}

/**
 * 读取 library image 的条目清单。约束见 spec（`docs/adr/` 待撰、Issue #33 spec 草稿）。
 * 当前为 fail-closed stub；待 flag allowlist 由 #33 研究落地后接入 spawn -t 调用。
 *
 * @param {string} filePath tar 路径
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS> }} [overrides]
 * @returns {Promise<{ entries: Array<{path: string, type: string, size: number, mode: number}>, totalBytes: number }>}
 */
export async function inspectLibraryImage(filePath, overrides = {}) {
  // `filePath` 与 `overrides` 入参形状在 T2 之后再使用；T1 仅校验契约。
  void filePath;
  void overrides;
  requireLoadedFlagPolicy();
}

/**
 * 把 library image 解到 `stagingRoot`，失败时保证原子清理。
 * 当前为 fail-closed stub；待 flag allowlist 由 #33 研究落地后接入 spawn -xf 调用与 pre/post 校验。
 *
 * @param {string} filePath
 * @param {string} stagingRoot
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS>, tarPath?: string }} [overrides]
 * @returns {Promise<Array<{ absPath: string, type: string }>>}
 */
export async function extractLibraryImage(filePath, stagingRoot, overrides = {}) {
  void filePath;
  void stagingRoot;
  void overrides;
  requireLoadedFlagPolicy();
}
