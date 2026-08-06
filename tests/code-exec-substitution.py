"""
Diagnostic test for code-step input handling (Engine/server/execution.py).

Covers:
- $param substitution into code as language-appropriate literals (repr for Python,
  JSON for JavaScript) — values are injected as data and cannot break out of the
  expression position;
- unknown $tokens and $secret.* references are left untouched by param substitution;
- input validation caps: max JSON depth, max array length, max encoded size;
- error sanitization (host paths scrubbed, length capped).

No Docker, no network, no Neo4j needed.

Run: ``.venv/bin/python tests/code-exec-substitution.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import execution  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def main() -> None:
    # --- literal encoding ---------------------------------------------------------
    check(
        "python string literal is quoted",
        execution._encode_code_literal("a'b\nc", "python") == repr("a'b\nc"),
    )
    check(
        "python booleans use True/False",
        execution._encode_code_literal(True, "python") == "True",
    )
    check(
        "python None literal",
        execution._encode_code_literal(None, "python") == "None",
    )
    check(
        "javascript booleans use true/false",
        execution._encode_code_literal(True, "javascript") == "true",
    )
    check(
        "javascript null literal",
        execution._encode_code_literal(None, "javascript") == "null",
    )
    check(
        "javascript string is JSON-escaped",
        execution._encode_code_literal('a"b', "javascript") == '"a\\"b"',
    )

    # --- substitution -------------------------------------------------------------
    resolved = {"amount": 42, "name": "O'Brien", "flag": True, "items": [1, 2]}

    code, err = execution._substitute_code_params(
        "total = $amount + 1\nwho = $name\nok = $flag\nxs = $items", resolved, "python"
    )
    check("python substitution has no error", err is None)
    check("python number substituted", "total = 42 + 1" in code)
    check("python string quoted (injection-safe)", 'who = "O\'Brien"' in code)
    check("python boolean True", "ok = True" in code)
    check("python list literal", "xs = [1, 2]" in code)

    code, err = execution._substitute_code_params(
        "const t = $amount; const w = $name; const f = $flag;", resolved, "javascript"
    )
    check("javascript substitution has no error", err is None)
    check("javascript number substituted", "const t = 42;" in code)
    check("javascript string quoted", 'const w = "O\'Brien";' in code)
    check("javascript boolean true", "const f = true;" in code)

    code, err = execution._substitute_code_params(
        "x = $unknown_token\nkey = '$secret.API_KEY'", {"amount": 1}, "python"
    )
    check("unknown $token left untouched", "$unknown_token" in code and err is None)
    check("$secret.* untouched by param substitution", "$secret.API_KEY" in code)

    # A string value that *looks* like code stays a quoted literal.
    evil = {"v": "__import__('os').system('id')"}
    code, err = execution._substitute_code_params("x = $v", evil, "python")
    check(
        "malicious string value stays a string literal",
        code == "x = " + repr(evil["v"]) and err is None,
    )

    # --- input validation caps ------------------------------------------------------
    deep: object = "leaf"
    for _ in range(40):
        deep = [deep]
    check(
        "depth cap rejects deeply nested values",
        execution._validate_json_shape(deep) is not None,
    )
    check(
        "array length cap rejects huge arrays",
        execution._validate_json_shape(list(range(10_001))) is not None,
    )
    check(
        "normal values pass shape validation",
        execution._validate_json_shape({"a": [1, 2, {"b": "c"}]}) is None,
    )

    _, err = execution._substitute_code_params("x = $big", {"big": "y" * (65 * 1024)}, "python")
    check("size cap rejects oversized parameter values", err is not None and "$big" in err)

    _, err = execution._substitute_code_params("x = $deep", {"deep": deep}, "python")
    check("depth cap enforced during substitution", err is not None and "$deep" in err)

    # --- error sanitization ---------------------------------------------------------
    sanitized = execution._sanitize_code_error(
        'File "/Users/someone/app/Engine/server/secret_module.py", line 3\nboom'
    )
    check("host paths scrubbed from errors", "/Users/" not in sanitized)
    check(
        "long errors truncated",
        len(execution._sanitize_code_error("x" * 10_000)) < 2100,
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All code-exec substitution checks passed.")


if __name__ == "__main__":
    main()
