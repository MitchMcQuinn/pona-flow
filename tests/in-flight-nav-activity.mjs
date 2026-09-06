/**
 * Nav activity icon matches the catalog sequence that owns the run, not a
 * longer chain that happens to include the same STEP, and not leftover HITL.
 *
 * Run: ``npx tsx tests/in-flight-nav-activity.mjs`` from the repo root.
 */
import assert from "node:assert/strict";
import { navActivitySequenceIds } from "../App/ui/src/state/inFlight.ts";

const waitSeq = "ID_WAIT_30_SECONDS";
const parentSeq = "ID_SEND_TO_DISCORD_AFTER_30";

const ids = navActivitySequenceIds([
  { sequence_id: waitSeq, status: "waiting" },
  { sequence_id: parentSeq, status: "pending" },
  { sequence_id: waitSeq, status: "waiting" }
]);

assert.deepEqual(ids, [waitSeq], "waiting child lights up; pending parent that shares the STEP does not");

assert.deepEqual(
  navActivitySequenceIds([{ sequence_id: parentSeq, status: "pending" }]),
  [],
  "leftover HITL pending does not linger as a nav spinner"
);

assert.deepEqual(
  navActivitySequenceIds([{ sequence_id: parentSeq, status: "active" }]),
  [parentSeq],
  "an actually running parent still shows the spinner"
);

assert.deepEqual(
  navActivitySequenceIds([{ sequence_id: "", status: "waiting" }]),
  [],
  "blank sequence_id does not match every nav item"
);

console.log("in-flight nav activity: ok");
