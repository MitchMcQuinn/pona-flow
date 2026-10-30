/**
 * After a console is accepted, the hidden follow-up asks the agent to check its modules.
 *
 * Run from App/ui: `npx tsx ../../tests/chat-follow-up.mjs`
 */
import assert from "node:assert/strict";
import { followUpPrompt } from "../App/ui/src/chat/followUp.ts";

const base = {
  ok: true,
  validation_errors: [],
  failed: null,
  not_applied: [],
  created_space_id: null
};

const plain = followUpPrompt({
  ...base,
  applied: [{ kind: "upsert_schema", summary: "Person schema" }]
});
assert.match(plain, /Do not call a tool/);
assert.doesNotMatch(plain, /check_console_modules/);

const saved = followUpPrompt({
  ...base,
  applied: [{ kind: "upsert_console", summary: "Floor", id: "CON_floor" }]
});
assert.match(saved, /check_console_modules/);
assert.match(saved, /CON_floor/);
assert.match(saved, /open_console/);

const modeled = followUpPrompt({
  ...base,
  applied: [{ kind: "upsert_event", summary: "Badge-in" }],
  inputs: [{ name: "badge-in", source: "simulated", lands_as: "simulated_event" }]
});
assert.match(modeled, /badge-in \(simulated → simulated_event\)/);
assert.match(modeled, /simulated or set from the console/);
assert.match(modeled, /Do not call a tool/);

console.log("ok");
