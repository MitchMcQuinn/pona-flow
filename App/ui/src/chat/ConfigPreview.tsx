import { Component, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { newQuery, type Operation } from "@pona-flow/authoring";
import { BuilderPanel } from "../components/builder/BuilderPanel";
import { EventBuilder } from "../components/events/EventBuilder";
import { eventPreviewFrom } from "./eventPreviewDocument";
import type { QueryObject } from "../state/builder/types";
import type { SequenceSummary } from "../state/types";
import { Markdown } from "./Markdown";
import type { ChatBatchItem, WalkthroughPin } from "./types";

const queryOperations: readonly Operation[] = ["read", "create", "update", "delete"];

interface ConfigPreviewProps {
  spaceId: string;
  item: ChatBatchItem;
  sequences: SequenceSummary[];
}

/** Read-only config for one proposed change, with notes sitting on the fields they describe. */
export function ConfigPreview({ spaceId, item, sequences }: ConfigPreviewProps) {
  const pins = item.pins ?? [];
  return (
    <AnnotatedConfig note={item.note} pins={pins}>
      <PreviewBoundary resetKey={`${item.kind}:${item.summary}`}>
        <KindPreview spaceId={spaceId} item={item} sequences={sequences} />
      </PreviewBoundary>
    </AnnotatedConfig>
  );
}

export function ConsoleConfigPreview({
  name,
  document,
  sequences = [],
  triggerKind = "",
  triggerEventId = ""
}: {
  name: string;
  document: Record<string, unknown>;
  sequences?: SequenceSummary[];
  triggerKind?: string;
  triggerEventId?: string;
}) {
  const modules = consoleModules(document);
  const labels = new Map(sequences.map((sequence) => [sequence.id, sequence.label]));
  const sequenceLabel = (id: string) => labels.get(id) || id;
  return (
    <div className="panel configPanel previewLocked">
      <div className="panel__body">
        <h1>create a console</h1>
        <ConfigField target="name" label="name" value={name} />
        {triggerKind ? <ConfigField target="trigger" label="trigger" value={triggerKind} /> : null}
        {triggerEventId ? (
          <ConfigField target="trigger_event" label="trigger event" value={triggerEventId} />
        ) : null}
        {modules.length === 0 ? <p className="muted">This console has no modules yet.</p> : null}
        {modules.map((module) => (
          <section key={module.id} className="builderCard" data-pin-target={module.id}>
            <h2>{module.title || module.type}</h2>
            <ConfigField target={`${module.id}-type`} label="type" value={module.type} />
            {module.dataSequenceId ? (
              <ConfigField target={`${module.id}-data`} label="data" value={sequenceLabel(module.dataSequenceId)} />
            ) : null}
            {module.actionSequenceId ? (
              <ConfigField
                target={`${module.id}-action`}
                label="action"
                value={sequenceLabel(module.actionSequenceId)}
              />
            ) : null}
            {module.fields ? <ConfigField target={`${module.id}-fields`} label="fields" value={module.fields} /> : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function KindPreview({ spaceId, item, sequences }: ConfigPreviewProps) {
  const payload = item.payload || {};
  if (item.kind === "upsert_event") {
    return (
      <EventConfig
        spaceId={spaceId}
        payload={payload}
        sequences={sequences}
        note={item.note}
        pins={item.pins}
      />
    );
  }
  if (item.kind === "upsert_query") {
    return <QueryConfig spaceId={spaceId} payload={payload} />;
  }
  if (item.kind === "upsert_schema") {
    return <SchemaConfig payload={payload} />;
  }
  if (item.kind === "upsert_console") {
    const document = asObject(payload.document) ?? {};
    return (
      <ConsoleConfigPreview
        name={text(payload.name) || item.summary}
        document={document}
        sequences={sequences}
        triggerKind={text(payload.trigger_kind)}
        triggerEventId={text(payload.trigger_event_id)}
      />
    );
  }
  if (item.kind === "create_space") {
    return (
      <ConfigPanel title="create a space">
        <ConfigField target="name" label="name" value={text(payload.name)} />
        <ConfigField target="description" label="description" value={text(payload.description)} />
        {text(payload.endpoint) ? <ConfigField target="endpoint" label="endpoint" value={text(payload.endpoint)} /> : null}
      </ConfigPanel>
    );
  }
  return <RecordConfig title={item.summary || item.kind} record={previewRecord(item)} />;
}

function EventConfig({
  spaceId,
  payload,
  sequences,
  note,
  pins
}: {
  spaceId: string;
  payload: Record<string, unknown>;
  sequences: SequenceSummary[];
  note?: string;
  pins?: WalkthroughPin[];
}) {
  const preview = useMemo(() => eventPreviewFrom(payload, { note, pins }), [payload, note, pins]);
  const withProposed = useMemo(() => {
    const ids = [...(preview.sequences ?? []), ...(preview.recovery_sequences ?? [])];
    return sequenceStubs(ids, sequences);
  }, [preview, sequences]);
  return (
    <EventBuilder
      spaceId={spaceId}
      sequences={withProposed}
      eventId={null}
      defaultTimezone={null}
      onSaved={() => undefined}
      onDeleted={() => undefined}
      consoles={[]}
      preview={preview}
    />
  );
}

export function QueryConfig({ spaceId, payload }: { spaceId: string; payload: Record<string, unknown> }) {
  const config = structuredQuery(payload);
  if (config) {
    const query = queryDocument(config);
    const name = text(payload.name) || query.name;
    const description = text(payload.description);
    return (
      <BuilderPanel
        spaceId={spaceId}
        createSequenceMode={text(payload.kind) === "sequence"}
        preview={{ query, name, description: description || undefined }}
      />
    );
  }
  const cypher = stringList(payload.cypher);
  const sequence = text(payload.kind) === "sequence";
  return (
    <ConfigPanel title={sequence ? "create a sequence" : "create a step"}>
      <ConfigField target="name" label="name" value={text(payload.name)} />
      <ConfigField target="operation" label="operation" value={text(payload.operation)} />
      {text(payload.description) ? (
        <ConfigField target="description" label="description" value={text(payload.description)} />
      ) : null}
      {cypher.length ? <ConfigField target="cypher" label="cypher" value={cypher.join("\n\n")} multiline /> : null}
    </ConfigPanel>
  );
}

function SchemaConfig({ payload }: { payload: Record<string, unknown> }) {
  const properties = Array.isArray(payload.properties) ? payload.properties : [];
  return (
    <ConfigPanel title="create a schema">
      <ConfigField target="attributive_label" label="attributive label" value={text(payload.attributive_label)} />
      {properties.map((entry) => {
        const property = asObject(entry) ?? {};
        const nested = asObject(property.property_schema) ?? property;
        const name = text(nested.name) || text(nested.key);
        if (!name) return null;
        const flags = ["is_required", "is_key", "is_label", "is_indexed", "is_embedded"].filter(
          (flag) => nested[flag] === true
        );
        const detail = [text(nested.value_type) || "string", ...flags.map((flag) => flag.replace("is_", ""))].join(
          " · "
        );
        return <ConfigField key={name} target={name} label={name} value={detail} />;
      })}
    </ConfigPanel>
  );
}

function RecordConfig({ title, record }: { title: string; record: Record<string, unknown> }) {
  const rows = Object.entries(record).filter(([, value]) => value != null && value !== "");
  return (
    <ConfigPanel title={title}>
      {rows.length === 0 ? <p className="muted">No configuration on this item.</p> : null}
      {rows.map(([key, value]) => (
        <ConfigField key={key} target={key} label={key.replace(/_/g, " ")} value={fieldValue(value)} multiline />
      ))}
    </ConfigPanel>
  );
}

function ConfigPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel configPanel previewLocked">
      <div className="panel__body">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function ConfigField({
  target,
  label,
  value,
  multiline = false
}: {
  target: string;
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="builderField" data-pin-target={target}>
      <label>{label}</label>
      {multiline ? <textarea readOnly rows={Math.min(8, value.split("\n").length + 1)} value={value} /> : <input readOnly value={value} />}
    </div>
  );
}

function AnnotatedConfig({
  note,
  pins,
  children
}: {
  note?: string;
  pins: WalkthroughPin[];
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Array<{ key: string; note: string; element: HTMLElement }>>([]);
  const [unplaced, setUnplaced] = useState<WalkthroughPin[]>([]);
  const signature = useRef("");
  const hosts = useRef<HTMLElement[]>([]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const place = () => {
      const nextPlaced: Array<{ key: string; note: string; element: HTMLElement }> = [];
      const nextUnplaced: WalkthroughPin[] = [];
      pins.forEach((pin, index) => {
        if (!pin.note) return;
        const node = root.querySelector(`[data-pin-target="${cssEscape(pin.target)}"]`);
        const host = pinHost(node);
        if (host) nextPlaced.push({ key: `${pin.target}-${index}`, note: pin.note, element: host });
        else nextUnplaced.push(pin);
      });
      const nextSignature = [
        ...nextPlaced.map((pin) => pin.key),
        "||",
        ...nextUnplaced.map((pin) => pin.target)
      ].join("\n");
      const detached = hosts.current.some((node) => !node.isConnected);
      if (!detached && nextSignature === signature.current) return;
      signature.current = nextSignature;
      hosts.current = nextPlaced.map((pin) => pin.element);
      setPlaced(nextPlaced);
      setUnplaced(nextUnplaced);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pins]);

  return (
    <div ref={rootRef} className="proposalConfig">
      {note ? (
        <div className="proposalAnnotation">
          <Markdown text={note} />
        </div>
      ) : null}
      {unplaced.map((pin) => (
        <div key={pin.target} className="proposalAnnotation">
          <p className="proposalAnnotationTarget">{pin.target}</p>
          <Markdown text={pin.note} />
        </div>
      ))}
      {children}
      {placed.map((pin) =>
        createPortal(
          <div className="proposalAnnotation">
            <Markdown text={pin.note} />
          </div>,
          pin.element
        )
      )}
    </div>
  );
}

function pinHost(node: Element | null): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") {
    return node.parentElement instanceof HTMLElement ? node.parentElement : node;
  }
  return node;
}

function cssEscape(value: string): string {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

function structuredQuery(payload: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [asObject(payload.builder_config), asObject(payload.query), payload];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.match || candidate.return || candidate.set || candidate.delete) return candidate;
  }
  return null;
}

export function sequenceStubs(ids: string[], existing: SequenceSummary[]): SequenceSummary[] {
  const known = new Set(existing.map((sequence) => sequence.id));
  const extras: SequenceSummary[] = [];
  for (const id of ids) {
    if (!id || known.has(id)) continue;
    known.add(id);
    extras.push({
      id,
      label: id,
      kind: "sequence",
      attributiveLabel: "",
      runtimeEnabled: true,
      suspended: false,
      orphaned: false,
      groupTitle: null,
      sortOrder: null,
      description: "",
      singleStep: true
    });
  }
  return extras.length ? [...existing, ...extras] : existing;
}

function queryDocument(document: Record<string, unknown>): QueryObject {
  const operation: Operation = queryOperations.includes(document.operation as Operation)
    ? (document.operation as Operation)
    : "read";
  const query = newQuery(operation);
  if (typeof document.name === "string") query.name = document.name;
  if (typeof document.id === "string" && document.id) query.id = document.id;
  if (Array.isArray(document.parameters)) query.parameters = document.parameters as QueryObject["parameters"];
  if (Array.isArray(document.match) && document.match.length) query.match = document.match as QueryObject["match"];
  if (document.return && typeof document.return === "object" && !Array.isArray(document.return)) {
    query.return = document.return as QueryObject["return"];
  }
  if (Array.isArray(document.set)) query.set = document.set as QueryObject["set"];
  if (document.delete && typeof document.delete === "object" && !Array.isArray(document.delete)) {
    query.delete = document.delete as QueryObject["delete"];
  }
  return query;
}

function consoleModules(document: Record<string, unknown>): Array<{
  id: string;
  type: string;
  title: string;
  dataSequenceId: string;
  actionSequenceId: string;
  fields: string;
}> {
  const nested = asObject(document.document) ?? document;
  const views = Array.isArray(nested.views) ? nested.views : [];
  const modules: Array<{
    id: string;
    type: string;
    title: string;
    dataSequenceId: string;
    actionSequenceId: string;
    fields: string;
  }> = [];
  views.forEach((view, viewIndex) => {
    const record = asObject(view);
    if (!record) return;
    if (record.kind === "form") {
      modules.push({
        id: text(record.id) || `form-${viewIndex}`,
        type: "form",
        title: text(record.name) || "Form",
        dataSequenceId: text(record.dataSequenceId),
        actionSequenceId: text(record.actionSequenceId),
        fields: formFieldSummary(record.fields)
      });
      return;
    }
    const list = Array.isArray(record.modules) ? record.modules : [];
    list.forEach((entry, index) => {
      const module = asObject(entry);
      if (!module) return;
      const config = asObject(module.config);
      modules.push({
        id: text(module.id) || `module-${viewIndex}-${index}`,
        type: text(module.type) || "module",
        title: text(module.title),
        dataSequenceId: text(module.dataSequenceId),
        actionSequenceId: text(module.actionSequenceId),
        fields: formFieldSummary(config?.fields)
      });
    });
  });
  return modules;
}

function formFieldSummary(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const field = asObject(entry);
      if (!field) return "";
      return text(field.label) || text(field.name);
    })
    .filter(Boolean)
    .join(", ");
}

function previewRecord(item: ChatBatchItem): Record<string, unknown> {
  const preview = asObject(item.preview);
  if (preview) return preview;
  const payload = item.payload || {};
  const brief: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "id" || key === "document" || key === "builder_config") continue;
    brief[key] = value;
  }
  return brief;
}

function fieldValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string" || typeof entry === "number") return String(entry);
        const record = asObject(entry);
        if (!record) return "";
        return text(record.name) || text(record.attributive_label) || text(record.id);
      })
      .filter(Boolean)
      .join(", ");
  }
  const record = asObject(value);
  if (!record) return "";
  return Object.entries(record)
    .map(([key, entry]) => {
      const shown = fieldValue(entry);
      return shown ? `${key}: ${shown}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry)).filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

class PreviewBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || "This configuration could not be shown." };
  }

  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) return <p className="errorText">{this.state.error}</p>;
    return this.props.children;
  }
}
