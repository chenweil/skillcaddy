import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Skillcaddy 的两个根目录。
 *
 * - code root（代码根）：运行中的代码所在目录。clone 出来的仓库、npm 包目录、
 *   Homebrew Cellar 目录都属于这一类。它提供 package.json、server.js、
 *   scripts/、skills/、collection-metadata/ 这些"随发行形态一起走"的内容。
 * - library root（原件库根）：原件库所在目录。它承载 official/github/personal/
 *   archived 四个 source bucket，以及 .skillcaddy/sources 与 .skillcaddy/metadata。
 *
 * 两者解耦之前，原件库只能跟着代码走：`npx skillcaddy` 之类的临时安装形态会把
 * 1GB 级原件库落在 npm 缓存目录里，缓存一清就没了。解耦之后原件库有一个稳定的、
 * 与安装形态无关的位置。
 */

/** 覆盖原件库根的环境变量。历史脚本（pull-github.sh 等）已经在用这个名字。 */
export const LIBRARY_ROOT_ENV = 'SKILLCADDY_ROOT';

/**
 * 默认原件库根：`~/.skillcaddy/library`。
 *
 * 刻意不直接用 `~/.skillcaddy`：原件库内部结构固定为
 * `<libraryRoot>/{official,github,personal,archived}` 与
 * `<libraryRoot>/.skillcaddy/{sources,metadata}`，与 library image 的成员定义
 * （ADR-0011）保持一致，这样导出的镜像可以被另一台机器原样导入。
 */
export function getDefaultLibraryRoot(homeDir = homedir()) {
  return path.join(homeDir, '.skillcaddy', 'library');
}

/**
 * 是否是 git checkout。clone 出来的仓库与 git worktree 都会带 `.git`
 * （worktree 是文件，clone 是目录），npm 包目录与发行 tarball 都不会带。
 */
export function isCheckoutRoot(codeRoot) {
  if (!codeRoot) return false;
  return existsSync(path.join(codeRoot, '.git'));
}

/**
 * 解析原件库根。优先级：
 *
 * 1. 显式传入的 libraryRoot（CLI 参数、调用方决策）；
 * 2. `SKILLCADDY_ROOT` 环境变量；
 * 3. 代码根是 git checkout —— 原件库继续留在 checkout 里，保持既有行为不变；
 * 4. `~/.skillcaddy/library`。
 *
 * 第 3 条是兼容既有 clone 用户的关键：他们已经装好的原件库不会因为这次重构
 * 而"凭空消失"。
 */
export function resolveLibraryRoot({ codeRoot, libraryRoot, env = process.env } = {}) {
  if (libraryRoot) return path.resolve(libraryRoot);

  const fromEnv = env?.[LIBRARY_ROOT_ENV];
  if (fromEnv) return path.resolve(fromEnv);

  if (codeRoot && isCheckoutRoot(codeRoot)) return path.resolve(codeRoot);

  return getDefaultLibraryRoot();
}

/**
 * 同时解析两个根。`codeRoot` 缺省为当前工作目录。
 */
export function resolveRoots({ codeRoot, libraryRoot, env = process.env } = {}) {
  const resolvedCodeRoot = path.resolve(codeRoot || process.cwd());
  return {
    codeRoot: resolvedCodeRoot,
    libraryRoot: resolveLibraryRoot({ codeRoot: resolvedCodeRoot, libraryRoot, env })
  };
}

/**
 * 归一化"两个根"的入参。
 *
 * 接受两种形态：
 * - 对象 `{ libraryRoot, codeRoot }` —— 当前形态；
 * - 字符串 —— 历史单根形态，等价于 `{ libraryRoot: str, codeRoot: str }`。
 *
 * 单根形态存在的意义是让"原件库与代码同目录"这种既有调用点继续成立：
 * 解耦之后它们仍然是合法的双根组合，只是两个根指向同一个目录。
 */
export function normalizeRoots(input, fallback = {}) {
  if (typeof input === 'string') {
    const libraryRoot = path.resolve(input);
    return {
      libraryRoot,
      codeRoot: path.resolve(fallback.codeRoot || libraryRoot)
    };
  }

  const libraryRoot = path.resolve(input?.libraryRoot || fallback.libraryRoot || process.cwd());
  const codeRoot = path.resolve(input?.codeRoot || fallback.codeRoot || libraryRoot);

  return { libraryRoot, codeRoot };
}
