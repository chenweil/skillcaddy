/**
 * Spec-pipeline gate decisions.
 *
 * These two functions are the single source of truth for whether a tech spec
 * may enter implementation, and for whether the declared role contract holds.
 *
 * Why this lives in lib/ rather than inside the check scripts: the source
 * directory `personal/` is git-ignored, so anything a CI job needs to verify
 * must not depend on it. The Python scripts under personal/spec-pipeline/ are
 * thin shells that call this module, so the gate logic cannot drift between
 * what a developer runs locally and what CI enforces.
 *
 * Both functions are pure: they take file content and return a decision. They
 * never read or write the filesystem themselves, which is what makes them
 * testable from fixtures (see test/specGate.test.js).
 */

/** Words that mean the direction line records a real decision. */
const PASS_WORDS = ['通过', 'approved', 'approve', 'pass'];
const REJECT_WORDS = ['拒绝', '驳回', 'rejected', 'reject', 'denied', 'deny'];

/**
 * `通过 / 拒绝` left unfilled is a template, not a decision. Treating it as
 * approved would let a copied-through approval block pass the gate.
 */
const PLACEHOLDER_RE = /通过\s*\/\s*拒绝|approved\s*\/\s*rejected/i;

/** A real decision carries a when. The template's own <…> marker does not count. */
const TIME_RE = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|20\d{2}/;

// JS has no named groups, so the verdict is captured as group 1.
const DIRECTION_RE = /^\s*[-*]?\s*(?:方向确认|方向|Direction)\s*[:：]\s*(.*)$/i;
const APPROVAL_HEADING_RE = /^#{1,6}\s*Approval\b/i;
const HEADING_RE = /^#{1,6}\s+\S/;

const KNOWN_ROLES = ['author', 'implementer', 'verifier'];

/** Values that look filled but assert nothing. */
const PLACEHOLDERS = new Set([
  '', '-', '--', '—', '——', 'n/a', 'na', 'tbd', 'todo',
  '?', '??', '（无）', '(无)', '无', '待定', '未开始填写', 'x', 'xx'
]);

const BOUNDARY_RE = /verifier\s*(?:不得|不能|不可)\s*(?:与|和)\s*author\s*(?:同|相同)/i;

function isFilled(value) {
  return !PLACEHOLDERS.has(String(value ?? '').trim().replace(/^\*+|\*+$/g, '').trim().toLowerCase());
}

/**
 * Locate the direction verdict inside `## Approval`.
 *
 * Scanning stops at the next heading on purpose: a document must not be able
 * to pass by parking a "方向确认：通过" line in a later section.
 *
 * @returns {{verdict: string|null, line: string|null, sectionFound: boolean}}
 */
export function readDirectionVerdict(text) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (APPROVAL_HEADING_RE.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return { verdict: null, line: null, sectionFound: false };

  for (const line of lines.slice(start)) {
    if (HEADING_RE.test(line.trim())) break;
    const match = DIRECTION_RE.exec(line);
    if (match) {
      return { verdict: match[1].trim(), line, sectionFound: true };
    }
  }
  return { verdict: null, line: null, sectionFound: true };
}

/**
 * Decide whether a TECH.md is approved to enter implementation.
 *
 * @param {string|null} text File content, or null when the file is absent.
 * @returns {{code: 0|1, reason: string, kind: string}}
 */
export function decideApproval(text) {
  const blocked = (kind, reason) => ({ code: 1, reason: `BLOCKED: ${reason}`, kind });

  if (text === null || text === undefined) {
    return blocked('missing', 'TECH.md 不存在。方向尚未确认，不得进入实施。');
  }

  const { verdict, line, sectionFound } = readDirectionVerdict(text);

  if (verdict === null) {
    if (!sectionFound) {
      return blocked('no-approval-section',
        'TECH.md 缺少 `## Approval` 段。批准状态是显式记录，没有它一律按未批准处理。请先运行 spec-direction-gate。');
    }
    return blocked('no-verdict',
      '`## Approval` 段存在，但里面没有方向确认结论。\n'
      + '  需要形如「- 方向确认：通过（时间：…，确认人：…）」的一行。'
      + '空的 Approval 段等同于未批准——这正是 spec-draft-intake 产出的状态。');
  }

  if (PLACEHOLDER_RE.test(verdict)) {
    return blocked('template',
      `方向确认仍是未填写的模板：${line.trim()}\n`
      + '  `通过 / 拒绝` 两个候选都留着，说明结论没写。请补上实际决定、时间与确认人。');
  }

  if (!TIME_RE.test(verdict) && !TIME_RE.test(line ?? '')) {
    return blocked('no-timestamp',
      `方向确认缺少时间戳：${line.trim()}\n`
      + '  批准记录必须可核验到「谁在什么时候批准了方向」。');
  }

  const lower = verdict.toLowerCase();
  const mentioned = (words) => words.some((w) => verdict.includes(w) || lower.includes(w));

  if (mentioned(REJECT_WORDS)) {
    return blocked('rejected',
      `方向确认被拒绝：${line.trim()}\n`
      + '  按流程停止。修改草稿后须从方向确认重新开始，不得直接进入实施。');
  }

  if (!mentioned(PASS_WORDS)) {
    return blocked('undecidable',
      `无法判定方向确认结论：${line.trim()}\n  既没有「通过」也没有「拒绝」，按未批准处理。`);
  }

  return { code: 0, reason: 'APPROVED: 方向已确认，可以进入实施。', kind: 'approved' };
}

/**
 * Parse the role table out of a ROLE.md body.
 *
 * @returns {{roles: Record<string, {who: string, session: string}>, order: string[]}}
 */
export function extractRoles(text) {
  const roles = {};
  const order = [];
  let inTable = false;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      inTable = true;
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^[-: ]*$/.test(c))) continue; // |---|---| separator
      const key = cells[0].replace(/^\*+|\*+$/g, '').trim().toLowerCase();
      for (const role of KNOWN_ROLES) {
        if (key.includes(role)) {
          if (!(role in roles)) order.push(role);
          roles[role] = {
            who: cells[1] ?? '',
            session: cells[2] ?? ''
          };
          break;
        }
      }
    } else if (inTable && line) {
      break;
    }
  }

  return { roles, order };
}

/**
 * Decide whether a declared role contract holds.
 *
 * Scope limit, stated plainly because it is easy to overread: this checks the
 * *declared* contract. A table filled in dishonestly passes. It catches the
 * common accident — copying a role block and forgetting to change the session —
 * not the absence of a real session boundary.
 *
 * @param {string|null} text File content, or null when the file is absent.
 * @returns {{code: 0|1, reason: string, kind: string, problems: string[]}}
 */
export function decideRoleContract(text) {
  const violation = (kind, reason, problems = []) => ({
    code: 1, reason: `VIOLATION: ${reason}`, kind, problems
  });

  if (text === null || text === undefined) {
    return violation('missing', 'ROLE.md 不存在。角色边界无法核验，不得开始实施。');
  }

  const { roles } = extractRoles(text);

  if (Object.keys(roles).length === 0) {
    return violation('no-table',
      'ROLE.md 里没有角色表。\n  需要一张表，至少三行：author / implementer / verifier，每行含「谁 / 会话 / 状态」。');
  }

  const missing = KNOWN_ROLES.filter((role) => !(role in roles));
  if (missing.length > 0) {
    return violation('missing-role',
      `角色表缺少位置：${missing.join(', ')}。\n  三个位置都要显式声明，不能靠默认。`);
  }

  const problems = [];
  for (const role of KNOWN_ROLES) {
    if (!isFilled(roles[role].who)) problems.push(`  - ${role} 的人未填写`);
    if (!isFilled(roles[role].session)) {
      problems.push(`  - ${role} 的会话标识未填写（占位符 \`${roles[role].session.trim()}\` 不算）`);
    }
  }

  const authorSession = roles.author.session.trim();
  const verifierSession = roles.verifier.session.trim();

  if (isFilled(authorSession) && isFilled(verifierSession)
      && authorSession.toLowerCase() === verifierSession.toLowerCase()) {
    problems.push(
      `  - verifier 与 author 同为会话 \`${authorSession}\`\n`
      + '    author 带着自己的权衡上下文验收自己的实现，等于用出题人的答案判卷。验收必须换新会话。'
    );
  }

  if (!BOUNDARY_RE.test(text)) {
    problems.push('  - `## Boundaries` 里没有写明「verifier 不得与 author 同会话」');
  }

  if (problems.length > 0) {
    return violation('boundary', `角色契约不满足边界要求：\n${problems.join('\n')}`, problems);
  }

  return {
    code: 0,
    reason: `OK: 三个位置均已声明，verifier 会话 \`${verifierSession}\` 与 author \`${authorSession}\` 不同。边界可核验。`,
    kind: 'ok',
    problems: []
  };
}
