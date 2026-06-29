import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
const INTERNAL_RE = /^\.\.?\//;

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchRule(targetFile, rulePattern) {
  if (rulePattern === '*') return true;
  return globToRegex(rulePattern).test(targetFile);
}

function isNodeImport(specifier) {
  return specifier.startsWith('node:');
}

function toRel(absPath, base) {
  return path.relative(base, absPath);
}

function parseImports(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const imports = [];
  let match;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

function findLineNumber(filePath, specifier) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(specifier)) return i + 1;
  }
  return 0;
}

function findFiles(cwd, pattern) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relPath = toRel(fullPath, cwd);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        walk(fullPath);
      } else if (matchRule(relPath, pattern)) {
        results.push(relPath);
      }
    }
  }
  walk(cwd);
  return results;
}

function resolveSpecifier(sourceFileRel, specifier) {
  const dir = path.dirname(sourceFileRel);
  return path.normalize(path.join(dir, specifier));
}

export function loadConfig(configPath) {
  const content = readFileSync(configPath, 'utf-8');
  return JSON.parse(content);
}

export function loadRules(configPath) {
  return loadConfig(configPath).rules;
}

export function checkImports(rules, cwd = rootDir, options = {}) {
  const violations = [];
  violations.push(...checkRuleCoverage(rules, cwd, options.requireRulesFor || []));

  for (const rule of rules) {
    const files = findFiles(cwd, rule.from);
    for (const relPath of files) {
      const filePath = path.join(cwd, relPath);
      const imports = parseImports(filePath);

      for (const specifier of imports) {
        if (isNodeImport(specifier)) continue;
        if (!INTERNAL_RE.test(specifier)) continue;

        if (rule.allow === true) continue;

        const resolvedRel = resolveSpecifier(relPath, specifier);

        const allowed = rule.allow.some(allowedPattern =>
          matchRule(resolvedRel, allowedPattern)
        );

        if (!allowed) {
          violations.push({
            file: relPath,
            line: findLineNumber(filePath, specifier),
            specifier,
            resolved: resolvedRel,
            ruleFrom: rule.from
          });
        }
      }
    }
  }

  return violations;
}

function checkRuleCoverage(rules, cwd, requiredPatterns) {
  const violations = [];
  for (const pattern of requiredPatterns) {
    const files = findFiles(cwd, pattern);
    for (const file of files) {
      const covered = rules.some((rule) => matchRule(file, rule.from));
      if (!covered) {
        violations.push({
          type: 'missing-rule',
          file,
          ruleFrom: pattern
        });
      }
    }
  }
  return violations;
}

function formatViolations(violations) {
  if (violations.length === 0) {
    console.log('✅ All import rules pass.');
    return;
  }
  console.log(`❌ Found ${violations.length} import violation(s):\n`);
  for (const v of violations) {
    if (v.type === 'missing-rule') {
      console.log(`  ${v.file}`);
      console.log(`    missing rule for required pattern: ${v.ruleFrom}`);
      console.log();
      continue;
    }
    console.log(`  ${v.file}:${v.line}`);
    console.log(`    import → ${v.specifier}`);
    console.log(`    resolve → ${v.resolved}`);
    console.log(`    violates rule from: ${v.ruleFrom}`);
    console.log();
  }
}

function main() {
  const configPath = path.join(rootDir, '.import-rules.json');
  const config = loadConfig(configPath);
  const violations = checkImports(config.rules, rootDir, {
    requireRulesFor: config.requireRulesFor || []
  });
  formatViolations(violations);
  process.exit(violations.length > 0 ? 1 : 0);
}

if (process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('/scripts/check-imports.js'))) {
  main();
}
