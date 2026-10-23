import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDefaultLibraryRoot,
  isCheckoutRoot,
  normalizeRoots,
  resolveLibraryRoot,
  resolveRoots
} from '../lib/roots.js';
import { resolveAllowedSkillSource } from '../lib/sourcePolicy.js';
import { ensureSourceFolders, getState, scanSkills } from '../lib/skillStore.js';
import { readSkillMetadata, updateSkillMetadata } from '../lib/skillMetadata.js';
import { makeTempDir } from './testHelpers.js';

async function writeSkill(root, relative, name) {
  const skillPath = path.join(root, relative);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`
  );
  return skillPath;
}

test('defaults the library root to the user-level library directory', () => {
  assert.equal(getDefaultLibraryRoot('/home/tester'), path.join('/home/tester', '.skillcaddy', 'library'));
});

test('detects a git checkout as a code root', async () => {
  const checkout = await makeTempDir('skillcaddy-checkout-');
  const plain = await makeTempDir('skillcaddy-plain-');

  assert.equal(isCheckoutRoot(checkout), false);
  await mkdir(path.join(checkout, '.git'), { recursive: true });
  assert.equal(isCheckoutRoot(checkout), true);
  assert.equal(isCheckoutRoot(plain), false);
});

test('resolves the library root by explicit option, env, checkout, then the default', async () => {
  const checkout = await makeTempDir('skillcaddy-checkout-');
  await mkdir(path.join(checkout, '.git'), { recursive: true });

  assert.equal(
    resolveLibraryRoot({ codeRoot: checkout, libraryRoot: '/explicit/library' }),
    path.resolve('/explicit/library')
  );
  assert.equal(
    resolveLibraryRoot({ codeRoot: checkout, env: { SKILLCADDY_ROOT: '/env/library' } }),
    path.resolve('/env/library')
  );
  // checkout 形态：原件库继续留在 checkout 里，既有用户不会看到 skill 凭空消失
  assert.equal(
    resolveLibraryRoot({ codeRoot: checkout, env: {} }),
    path.resolve(checkout)
  );
  // 发行形态（npm/npx）：代码根不是 checkout，原件库落到用户级目录
  assert.equal(
    resolveLibraryRoot({ codeRoot: '/opt/pkg', env: {} }),
    getDefaultLibraryRoot()
  );
});

test('resolveRoots keeps both roots addressable', () => {
  const roots = resolveRoots({ codeRoot: '/opt/pkg', libraryRoot: '/srv/library', env: {} });
  assert.deepEqual(roots, { codeRoot: path.resolve('/opt/pkg'), libraryRoot: path.resolve('/srv/library') });
});

test('normalizeRoots keeps the legacy single-root call shape working', () => {
  assert.deepEqual(normalizeRoots('/tmp/library'), {
    libraryRoot: path.resolve('/tmp/library'),
    codeRoot: path.resolve('/tmp/library')
  });
  assert.deepEqual(normalizeRoots({ libraryRoot: '/tmp/library' }), {
    libraryRoot: path.resolve('/tmp/library'),
    codeRoot: path.resolve('/tmp/library')
  });
  assert.deepEqual(normalizeRoots({ libraryRoot: '/tmp/library', codeRoot: '/opt/pkg' }), {
    libraryRoot: path.resolve('/tmp/library'),
    codeRoot: path.resolve('/opt/pkg')
  });
});

test('source policy accepts library buckets and the repository skills bucket separately', () => {
  const roots = { libraryRoot: '/srv/library', codeRoot: '/opt/pkg' };

  assert.equal(resolveAllowedSkillSource(roots, '/srv/library/github/acme/skills/review').sourceFolder, 'github');
  assert.equal(resolveAllowedSkillSource(roots, '/opt/pkg/skills/skillcaddy-manager').sourceFolder, 'skills');
  // 原件库根下的 skills 桶不是合法来源；仓库自带 skills 只能来自代码根
  assert.equal(resolveAllowedSkillSource(roots, '/srv/library/skills/skillcaddy-manager'), null);
  assert.equal(resolveAllowedSkillSource(roots, '/elsewhere/skills/skillcaddy-manager'), null);
});

test('scanning keeps library buckets and repository skills in their own roots', async () => {
  const libraryRoot = await makeTempDir('skillcaddy-library-');
  const codeRoot = await makeTempDir('skillcaddy-code-');

  await writeSkill(libraryRoot, 'github/acme/skills/review', 'review');
  await writeSkill(codeRoot, 'skills/bundled', 'bundled');

  const roots = { libraryRoot, codeRoot };
  const ids = (await scanSkills(roots)).map((skill) => skill.id);
  assert.deepEqual(ids.sort(), ['github/acme/skills/review', 'local/bundled'].sort());
});

test('sidecar metadata for a repository skill is stored under the library root', async () => {
  const libraryRoot = await makeTempDir('skillcaddy-library-');
  const codeRoot = await makeTempDir('skillcaddy-code-');
  const skillPath = await writeSkill(codeRoot, 'skills/bundled', 'bundled');

  const roots = { libraryRoot, codeRoot };
  await ensureSourceFolders(roots);

  const result = await updateSkillMetadata(roots, { skillPath, note: '来自仓库' });
  assert.equal(result.metadataPath, path.join(libraryRoot, '.skillcaddy', 'metadata', 'skills', 'bundled', 'skillcaddy.json'));
  assert.equal(
    JSON.parse(await readFile(result.metadataPath, 'utf8')).note,
    '来自仓库'
  );

  const metadata = await readSkillMetadata(roots, skillPath);
  assert.equal(metadata.note, '来自仓库');
  assert.equal(metadata.hasMetadata, true);
});

test('getState reports both roots and reads the library from the library root', async () => {
  const libraryRoot = await makeTempDir('skillcaddy-library-');
  const codeRoot = await makeTempDir('skillcaddy-code-');
  const projectPath = await makeTempDir('skillcaddy-project-');

  await writeSkill(libraryRoot, 'github/acme/skills/review', 'review');
  await writeSkill(codeRoot, 'skills/bundled', 'bundled');

  const state = await getState({ libraryRoot, codeRoot }, projectPath);
  assert.equal(state.rootDir, libraryRoot);
  assert.equal(state.libraryRoot, libraryRoot);
  assert.equal(state.codeRoot, codeRoot);
  assert.deepEqual(state.skills.map((skill) => skill.id).sort(), ['github/acme/skills/review', 'local/bundled']);
});
