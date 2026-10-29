/**
 * Console form fields follow the caller-supplied webhook parameter list:
 * baked-in values drop out, and each remaining parameter sets name, type, and required.
 */
import assert from "node:assert/strict";

const {
  callerFacingWebhookParameters,
  formFieldsFromWebhookParameters,
  moduleFormFieldsFromWebhookParameters,
  nextFormPage,
  webhookParameterPages
} = await import("../App/ui/src/consoles/webhookFields.ts");
const { parseModuleFormFields, serializeModuleFormFields } = await import(
  "../App/ui/src/consoles/modules/formFields.ts"
);

const parameters = [
  { name: "ship_to", is_required: true, value_type: "string", format: "email" },
  { name: "qty", is_required: false, value_type: "integer" },
  { name: "rush", is_required: true, value_type: "boolean" },
  { name: "lane", is_required: true, value_type: "radio", options: ["Ground", "Air"] },
  { name: "tags", is_required: true, value_type: "checkbox", options: ["Cold", "Fragile"] },
  { name: "flag", is_required: true, value_type: "checkbox" },
  { name: "payload", is_required: false, value_type: "array" },
  { name: "note", is_required: false, value_type: "string", format: "any" },
  { name: "minted_id", is_required: true, value_type: "string", auto_generate: true },
  { name: "owner", is_required: true, value_type: "string" },
  { name: "owner", is_required: false, value_type: "number" },
  { name: "  ", is_required: true, value_type: "string" },
  { name: "bad name", is_required: true, value_type: "string" }
];

const facing = callerFacingWebhookParameters(parameters, {
  owner: "Ada",
  qty: "",
  rush: false,
  empty_list: [],
  zero: 0
});

assert.deepEqual(
  facing.map((parameter) => parameter.name),
  ["ship_to", "qty", "lane", "tags", "flag", "payload", "note", "bad name"]
);

let nextId = 0;
const formFields = formFieldsFromWebhookParameters(facing, () => `f${++nextId}`);

assert.deepEqual(
  formFields.map((field) => ({
    id: field.id,
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    placeholder: field.placeholder,
    page: field.page
  })),
  [
    {
      id: "f1",
      name: "ship_to",
      label: "Ship to",
      type: "text",
      required: true,
      options: "",
      placeholder: "email",
      page: 0
    },
    {
      id: "f2",
      name: "qty",
      label: "Qty",
      type: "number",
      required: false,
      options: "",
      placeholder: "",
      page: 0
    },
    {
      id: "f3",
      name: "lane",
      label: "Lane",
      type: "select",
      required: true,
      options: "Ground, Air",
      placeholder: "",
      page: 0
    },
    {
      id: "f4",
      name: "tags",
      label: "Tags",
      type: "checkbox",
      required: true,
      options: "Cold, Fragile",
      placeholder: "",
      page: 0
    },
    {
      id: "f5",
      name: "flag",
      label: "Flag",
      type: "checkbox",
      required: false,
      options: "",
      placeholder: "",
      page: 0
    },
    {
      id: "f6",
      name: "payload",
      label: "Payload",
      type: "textarea",
      required: false,
      options: "",
      placeholder: "JSON",
      page: 0
    },
    {
      id: "f7",
      name: "note",
      label: "Note",
      type: "text",
      required: false,
      options: "",
      placeholder: "",
      page: 0
    },
    {
      id: "f8",
      name: "badname",
      label: "Badname",
      type: "text",
      required: true,
      options: "",
      placeholder: "",
      page: 0
    }
  ]
);

const moduleFields = moduleFormFieldsFromWebhookParameters([
  { name: "rush", is_required: true, value_type: "boolean" },
  { name: "lane", is_required: false, value_type: "radio", options: ["Ground", "Air, sea"] },
  { name: "qty", is_required: true, value_type: "number" }
]);

assert.equal(moduleFields[0].type, "radio");
assert.deepEqual(moduleFields[0].options, ["true", "false"]);
assert.equal(moduleFields[0].required, true);
assert.equal(moduleFields[1].type, "radio");
assert.deepEqual(moduleFields[1].options, ["Ground", "Air, sea"]);
assert.equal(moduleFields[2].type, "number");
assert.equal(moduleFields[2].required, true);

const booleanField = formFieldsFromWebhookParameters(
  [{ name: "rush", is_required: true, value_type: "boolean" }],
  () => "bool"
)[0];
assert.equal(booleanField.type, "select");
assert.equal(booleanField.required, true);
assert.equal(booleanField.options, "true, false");
assert.equal(booleanField.page, 0);

const pages = webhookParameterPages(
  [
    [
      { name: "note", is_required: false, value_type: "string" },
      { name: "owner", is_required: true, value_type: "string" }
    ],
    [{ name: "qty", is_required: false, value_type: "integer" }],
    [{ name: "approved", is_required: true, value_type: "boolean" }],
    [{ name: "memo", is_required: false, value_type: "string" }]
  ],
  {},
  []
);
assert.deepEqual(
  pages.map((page) => page.map((parameter) => parameter.name)),
  [
    ["note", "owner", "qty"],
    ["approved", "memo"]
  ]
);

const singlePause = webhookParameterPages(
  [
    [{ name: "note", is_required: false, value_type: "string" }],
    [{ name: "owner", is_required: true, value_type: "string" }]
  ],
  { hidden: "baked" },
  ["owner"]
);
assert.deepEqual(
  singlePause.map((page) => page.map((parameter) => parameter.name)),
  [["note"]]
);

assert.deepEqual(nextFormPage({ plannedNames: [["owner"], ["approved"]], cursor: 0, pendingNames: ["approved"] }), {
  cursor: 1,
  usePending: false
});
assert.deepEqual(nextFormPage({ plannedNames: [["owner"], ["approved"]], cursor: 0, pendingNames: ["owner"] }), {
  cursor: 0,
  usePending: false
});
assert.deepEqual(nextFormPage({ plannedNames: [["owner"], ["approved"]], cursor: 0, pendingNames: ["extra"] }), {
  cursor: 0,
  usePending: true
});

const roundTrip = parseModuleFormFields(serializeModuleFormFields(moduleFields));
assert.equal(roundTrip.error, null);
assert.deepEqual(roundTrip.fields, moduleFields);

console.log("console-form-webhook-fields: ok");
