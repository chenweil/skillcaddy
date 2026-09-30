#!/usr/bin/env python3
"""
Role-contract check for specs/<id>/ROLE.md.

Thin shell over lib/specGate.js (decideRoleContract), so the decision a
developer gets locally is the same one the test suite and any CI job assert.
The logic lives in the repo because personal/ is git-ignored: a CI clone cannot
see this file at all, so it must not be where the rule is defined.

Scope limit: this verifies the *declared* contract. A table filled in
dishonestly passes. It catches the common accident — copying a role block and
forgetting to change the session — not proof that a real session boundary
exists.

Exit codes:
    0  OK        - all three positions declared; verifier session differs
    1  VIOLATION - missing, malformed, or the session rule is broken
    2  USAGE     - wrong invocation (also: gate module not found)

Usage:
    python3 check-roles.py specs/<id>/ROLE.md
    python3 check-roles.py --quiet specs/<id>/ROLE.md   # only the exit code

The script never edits the file. It only reports.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def find_repo_root(start: Path):
    """Locate the checkout that owns lib/specGate.js.

    Search order: upward from the document, then the script's own location,
    then the current working directory. The middle case matters because a role
    file can legitimately live outside the repository.
    """
    candidates = [start, *start.parents]
    here = Path(__file__).resolve().parent
    candidates += [here, *here.parents, Path.cwd(), *Path.cwd().parents]
    for candidate in candidates:
        if (candidate / "lib" / "specGate.js").is_file():
            return candidate
    return None


def decide(root: Path, text):
    """Ask the JS module for the verdict. Returns (code, reason)."""
    module = root / "lib" / "specGate.js"
    helper = (
        "const { decideRoleContract } = await import(process.env.SPEC_GATE_MODULE);"
        "const fs = await import('node:fs');"
        "const t = fs.readFileSync(0, 'utf8');"
        "const r = decideRoleContract(t);"
        "process.stdout.write(JSON.stringify({ code: r.code, reason: r.reason }));"
    )
    env = dict(**os.environ, SPEC_GATE_MODULE=str(module))

    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", helper],
            input=text, capture_output=True, text=True, env=env
        )
    except FileNotFoundError:
        raise RuntimeError("找不到 node 可执行文件，无法调用 lib/specGate.js")

    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        tail = detail[-1] if detail else "unknown error"
        raise RuntimeError(f"调用 lib/specGate.js 失败：{tail}")

    payload = json.loads(result.stdout)
    return payload["code"], payload["reason"]


def main(argv):
    args = [a for a in argv[1:] if a != "--quiet"]
    quiet = "--quiet" in argv[1:]

    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(args[0])
    if not path.is_file():
        code, reason = 1, "VIOLATION: ROLE.md 不存在。角色边界无法核验，不得开始实施。"
    else:
        root = find_repo_root(path.resolve().parent)
        if root is None:
            print("USAGE: 找不到 lib/specGate.js，无法判定角色契约。"
                  "请在本仓库内运行，或确认 lib/specGate.js 存在。", file=sys.stderr)
            return 2
        try:
            code, reason = decide(root, path.read_text(encoding="utf-8"))
        except RuntimeError as exc:
            print(f"USAGE: {exc}", file=sys.stderr)
            return 2

    if not quiet or code != 0:
        print(reason, file=sys.stdout if code == 0 else sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
