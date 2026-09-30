import test from 'node:test';
import assert from 'node:assert/strict';
import { decideApproval, decideRoleContract, readDirectionVerdict } from '../lib/specGate.js';

/*
 * These fixtures mirror the cases that were verified by hand when the two
 * check scripts were first written. They live in test/ rather than reading
 * personal/spec-pipeline/ because that directory is git-ignored: a CI job
 * that cloned this repo would not find the scripts at all. The scripts are
 * thin shells over lib/specGate.js, so what these tests exercise is exactly
 * what the scripts decide.
 *
 * Every case asserts the decision *and* the kind, because several distinct
 * failures share exit code 1. A test that only checked the code would pass
 * even if the module reported "缺少 ## Approval 段" for a document that has
 * the section — which is the bug this suite was written to pin down.
 */

const APPROVED = '# TECH\n\n## Approval\n\n- 方向确认：通过（时间：2026-09-30 15:40 CST，确认人：along）\n';

test('approval: an approved direction passes', () => {
  const result = decideApproval(APPROVED);
  assert.equal(result.code, 0);
  assert.equal(result.kind, 'approved');
});

test('approval: a missing document is blocked', () => {
  const result = decideApproval(null);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'missing');
});

test('approval: a document without an Approval section is blocked', () => {
  const result = decideApproval('# TECH\n\n## Proposed changes\n\nSomething.\n');
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'no-approval-section');
});

test('approval: an empty Approval section is blocked and says so precisely', () => {
  // The distinction that the original script got wrong: the section exists,
  // so telling the reader to add it is misleading.
  for (const text of ['# T\n\n## Approval\n', '# T\n\n## Approval\n\n（无内容）\n']) {
    const result = decideApproval(text);
    assert.equal(result.code, 1);
    assert.equal(result.kind, 'no-verdict');
    assert.match(result.reason, /Approval` 段存在/);
  }
});

test('approval: an unfilled "通过 / 拒绝" template is blocked', () => {
  const text = '# T\n\n## Approval\n\n- 方向确认：通过 / 拒绝（时间：YYYY-MM-DD HH:MM CST，确认人：__）\n';
  const result = decideApproval(text);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'template');
});

test('approval: a rejected direction is blocked', () => {
  const text = '# T\n\n## Approval\n\n- 方向确认：拒绝（时间：2026-09-30 15:40 CST，确认人：along）\n';
  const result = decideApproval(text);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'rejected');
});

test('approval: passing without a timestamp is blocked', () => {
  const result = decideApproval('# T\n\n## Approval\n\n- 方向确认：通过\n');
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'no-timestamp');
});

test('approval: a verdict parked in a later section does not count', () => {
  const text = '# T\n\n## Approval\n\n- 说明：见下\n\n## Notes\n\n- 方向确认：通过（时间：2026-09-30 15:40 CST，确认人：along）\n';
  const result = decideApproval(text);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'no-verdict');
});

test('approval: "通过" in another section is not mistaken for a verdict', () => {
  // A draft produced by spec-draft-intake carries a Source draft section; the
  // word 通过 there must not be read as an approval.
  const text = '# T\n\n## Source draft\n\n- 对账：通过（时间：2026-09-30 15:50 CST）\n';
  const result = decideApproval(text);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'no-approval-section');
});

test('approval: an English verdict line is understood', () => {
  const result = decideApproval('# T\n\n## Approval\n\n- Direction: approved (2026-09-30, along)\n');
  assert.equal(result.code, 0);
});

test('approval: an English rejection is understood', () => {
  const result = decideApproval('# T\n\n## Approval\n\n- Direction: rejected (2026-09-30, along)\n');
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'rejected');
});

test('approval: an unrecognised verdict is treated as unapproved', () => {
  const result = decideApproval('# T\n\n## Approval\n\n- 方向确认：也许吧（2026-09-30）\n');
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'undecidable');
});

test('approval: readDirectionVerdict reports whether the section existed', () => {
  assert.deepEqual(readDirectionVerdict('# T\n\n## Approval\n').sectionFound, true);
  assert.deepEqual(readDirectionVerdict('# T\n\n## X\n').sectionFound, false);
});

/* ------------------------------------------------------------------ */
/* Role contract                                                       */
/* ------------------------------------------------------------------ */

const ROLE_TABLE = [
  '# Roles',
  '',
  '| 位置 | 谁 | 会话 | 状态 |',
  '| --- | --- | --- | --- |',
  '| author | along | s-001 | 进行中 |',
  '| implementer | opus | s-002 | 未开始 |',
  '| verifier | fable | s-003 | 未开始 |',
  '',
  '## Boundaries',
  '',
  '- verifier 不得与 author 同会话。验收依据是 `TECH.md`,不是对话。',
  ''
].join('\n');

test('roles: a complete contract with distinct sessions passes', () => {
  const result = decideRoleContract(ROLE_TABLE);
  assert.equal(result.code, 0);
  assert.equal(result.kind, 'ok');
});

test('roles: a missing document is a violation', () => {
  const result = decideRoleContract(null);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'missing');
});

test('roles: a verifier sharing the author session is rejected', () => {
  const text = ROLE_TABLE.replace('| verifier | fable | s-003 |', '| verifier | fable | s-001 |');
  const result = decideRoleContract(text);
  assert.equal(result.code, 1);
  assert.ok(result.problems.some((p) => p.includes('同为会话')), `problems: ${JSON.stringify(result.problems)}`);
});

test('roles: a placeholder session is not a session', () => {
  const text = ROLE_TABLE.replace('| verifier | fable | s-003 |', '| verifier | fable | TBD |');
  const result = decideRoleContract(text);
  assert.equal(result.code, 1);
  assert.ok(result.problems.some((p) => p.includes('会话标识未填写')), `problems: ${JSON.stringify(result.problems)}`);
});

test('roles: all three positions must be declared', () => {
  const text = ROLE_TABLE.split('\n').filter((l) => !l.startsWith('| verifier')).join('\n');
  const result = decideRoleContract(text);
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'missing-role');
});

test('roles: the boundary rule must be written down', () => {
  const text = ROLE_TABLE.replace('- verifier 不得与 author 同会话。验收依据是 `TECH.md`,不是对话。', '- 其他说明。');
  const result = decideRoleContract(text);
  assert.equal(result.code, 1);
  assert.ok(result.problems.some((p) => p.includes('没有写明')), `problems: ${JSON.stringify(result.problems)}`);
});

test('roles: a document with no table at all is a violation', () => {
  const result = decideRoleContract('# Roles\n\n还没有表。\n');
  assert.equal(result.code, 1);
  assert.equal(result.kind, 'no-table');
});

// Guards against the script rejecting everything: these three shapes are all
// legitimate and must pass. A suite containing only violation cases proves
// nothing about discrimination.
test('roles: English column headers are accepted', () => {
  const text = ROLE_TABLE
    .replace('| 位置 | 谁 | 会话 | 状态 |', '| Role | Who | Session | Status |')
    .replace('| --- | --- | --- | --- |', '| --- | --- | --- | --- |');
  assert.equal(decideRoleContract(text).code, 0);
});

test('roles: bilingual role labels are accepted', () => {
  const text = ROLE_TABLE
    .replace('| author |', '| 作者 / author |')
    .replace('| implementer |', '| 实施者 / implementer |')
    .replace('| verifier |', '| 验证者 / verifier |');
  assert.equal(decideRoleContract(text).code, 0);
});

test('roles: alternative boundary wording is accepted', () => {
  const text = ROLE_TABLE.replace('verifier 不得与 author 同会话', 'verifier 不能和 author 相同');
  assert.equal(decideRoleContract(text).code, 0);
});

test('the two gates are independent: an approved spec can still lack a role contract', () => {
  // If these were one combined gate, approving a spec would imply a role
  // contract exists, and the implementer could skip declaring roles.
  assert.equal(decideApproval(APPROVED).code, 0);
  assert.equal(decideRoleContract(null).code, 1);
});
