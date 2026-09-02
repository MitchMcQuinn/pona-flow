/**
 * Sandbox harness (JavaScript) — runs inside the disposable container.
 *
 * Reads {"code": "..."} as JSON from stdin, executes the code, and writes a result
 * envelope to stdout after a sentinel delimiter:
 *
 *   __PONA_FLOW_RESULT__{"ok": ..., "result": ..., "stdout": ..., "error": ...}
 *
 * Result selection (the engine wraps anything non-object as {"result": <value>}):
 *   1. a global `result` value (a returned Promise is awaited), when JSON-serializable
 *   2. otherwise the whole captured console output parsed as JSON, when it parses
 *   3. otherwise the last non-empty output line parsed as JSON, when it parses
 *   4. otherwise the raw output text (string)
 *
 * This file provides NO security: isolation comes entirely from the container
 * profile (no network, non-root, read-only fs, cgroup limits, seccomp).
 */

"use strict";

const fs = require("fs");

const SENTINEL = "__PONA_FLOW_RESULT__";
const MAX_STDOUT = 1024 * 1024;

function jsonable(value) {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function pickResult(stdoutText) {
  if (typeof globalThis.result !== "undefined" && jsonable(globalThis.result)) {
    return globalThis.result;
  }
  const text = stdoutText.trim();
  if (text) {
    try {
      return JSON.parse(text);
    } catch {}
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length) {
      try {
        return JSON.parse(lines[lines.length - 1].trim());
      } catch {}
    }
  }
  return stdoutText;
}

async function main() {
  let request = {};
  try {
    request = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {}
  const code = String(request.code || "");

  let captured = "";
  const capture = (...args) => {
    captured +=
      args
        .map((a) => (typeof a === "string" ? a : (() => {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })()))
        .join(" ") + "\n";
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;

  let ok = true;
  let error = null;
  try {
    // Indirect eval runs in global scope, so `var result = ...` (or
    // `result = ...`) in user code lands on globalThis for pickResult.
    const evaluated = (0, eval)(code);
    if (evaluated && typeof evaluated.then === "function") {
      await evaluated;
    }
    if (
      globalThis.result &&
      typeof globalThis.result.then === "function"
    ) {
      globalThis.result = await globalThis.result;
    }
  } catch (err) {
    ok = false;
    error = err && err.stack ? String(err.stack).split("\n").slice(0, 8).join("\n") : String(err);
  }

  const truncated = captured.length > MAX_STDOUT;
  // Scrub user-printed sentinels so the envelope parse cannot be confused/forged.
  let stdoutText = captured.slice(0, MAX_STDOUT).split(SENTINEL).join("__SENTINEL__");

  const envelope = {
    ok,
    result: ok ? pickResult(stdoutText) : null,
    stdout: stdoutText.slice(-8192),
    error: error ? error.split(SENTINEL).join("__SENTINEL__") : null,
    truncated,
  };
  // Exit only after the envelope has fully flushed through the stdout pipe:
  // process.exit() discards buffered writes, which truncates large envelopes.
  process.stdout.write("\n" + SENTINEL + JSON.stringify(envelope), () =>
    process.exit(0)
  );
}

main().catch((err) => {
  process.stdout.write(
    "\n" +
      SENTINEL +
      JSON.stringify({ ok: false, result: null, stdout: "", error: String(err), truncated: false }),
    () => process.exit(0)
  );
});
