#!/usr/bin/env python3
"""
Direction-confirmation gate check for specs/<id>/TECH.md.

Thin shell over lib/specGate.js (decideApproval), so the decision a developer
gets locally is the same one the test suite and any CI job assert. The logic
lives in the repo because personal/ is git-ignored: a CI clone cannot see
this file at all, so it must not be where the rule is defined.

Exit codes:
    0  APPROVED  - an `## Approval` section exists and direction is 通过
    1  BLOCKED   - missing, malformed, or not approved. Do not start implementing.
    2  USAGE     - wrong invocation (also: gate module not found)

Usage:
    python3 check-approval.py specs/<id>/TECH.md
    python3 check-approval.py --quiet specs/<id>/TECH.md   # only the exit code

The script never edits the document. It only reports.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def find_repo_root(start: Path):
    """Locate the checkout that owns lib/specGate.js.

    Search order: upward from the document, then the script's own location,
    then the current working directory. The middle case matters because a spec
    can legitimately live outside the repository; without it, every such
    invocation would fail looking for /some/where/lib/specGate.js instead of
    reporting a real verdict.
    """
    candidates = [start, *start.parents]
    here = Path(__file__).resolve().parent
    candidates += [here, *here.parents, Path.cwd(), *Path.cwd().parents]
    for candidate in candidates:
        if (candidate / "lib" / "specGate.js").is_file():
            return candidate
    return None


def decide(root: Path, text):
    """Ask the JS module for the verdict. Returns (code, reason).

    The document content is piped over stdin rather than passed as an argv
    entry: paths with spaces or newlines would otherwise need escaping, and
    argv offsets differ between `node -e` invocation styles.
    """
    module = root / "lib" / "specGate.js"
    helper = (
        "const { decideApproval } = await import(process.env.SPEC_GATE_MODULE);"
        "const fs = await import('node:fs');"
        "const t = fs.readFileSync(0, 'utf8');"
        "const r = decideApproval(t);"
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
        code, reason = 1, "BLOCKED: TECH.md 不存在。方向尚未确认，不得进入实施。"
    else:
        root = find_repo_root(path.resolve().parent)
        if root is None:
            print("USAGE: 找不到 lib/specGate.js，无法判定批准状态。"
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
