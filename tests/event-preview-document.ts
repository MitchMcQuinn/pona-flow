import assert from "node:assert/strict";
import { eventPreviewFrom } from "../App/ui/src/chat/eventPreviewDocument.ts";

const fromNote = eventPreviewFrom(
  {
    name: "Weeknight 6pm Eastern Overdue Sweep",
    type: "time",
    timezone: "America/New_York",
    sequences: ["OP_CHECK_OVERDUE_WORK_ORDERS"]
  },
  {
    note: "Automated schedule running every Monday through Friday at 6:00 PM Eastern.",
    pins: [{ target: "cron", note: "Scheduled for 6:00 PM Eastern Monday through Friday." }]
  }
);
assert.equal(fromNote.event_package?.timezone, "America/New_York");
assert.equal(fromNote.event_package?.groups?.[0]?.is_time, "18:00");
assert.deepEqual(fromNote.event_package?.groups?.[0]?.is_weekday, [1, 2, 3, 4, 5]);
assert.deepEqual(fromNote.sequences, ["OP_CHECK_OVERDUE_WORK_ORDERS"]);

const fromCron = eventPreviewFrom({
  name: "Sweep",
  type: "time",
  event_package: { timezone: "America/New_York", cron: "0 18 * * 1-5" }
});
assert.equal(fromCron.event_package?.groups?.[0]?.is_time, "18:00");
assert.deepEqual(fromCron.event_package?.groups?.[0]?.is_weekday, [1, 2, 3, 4, 5]);

const fromFields = eventPreviewFrom(
  {
    name: "Sweep",
    type: "time",
    event_package: {
      timezone: "America/New_York",
      groups: [{ is_time: "6:00 PM", weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"] }]
    }
  },
  { note: "Ignore this 9:00 AM mention." }
);
assert.equal(fromFields.event_package?.groups?.[0]?.is_time, "18:00");
assert.deepEqual(fromFields.event_package?.groups?.[0]?.is_weekday, [1, 2, 3, 4, 5]);

const external = eventPreviewFrom(
  {
    name: "Badge in",
    type: "external",
    sequences: ["assign-nurse"],
    external_package: { filters: [{ path: "event", operator: "equals", value: "badge-in" }] }
  },
  { note: "Runs at 6:00 PM Monday through Friday." }
);
assert.equal(external.event_package?.groups?.length ?? 0, 0);
assert.equal(external.external_package?.filters?.[0]?.value, "badge-in");

console.log("event preview document ok");
