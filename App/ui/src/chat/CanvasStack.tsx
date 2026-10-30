import { useState, type FormEvent } from "react";
import { ConsoleHost } from "../consoles/ConsoleHost";
import { runSequenceExecution } from "../services/api";
import type { EventSummary, SequenceSummary } from "../state/types";
import { ConfigPreview } from "./ConfigPreview";
import { EphemeralConsole } from "./EphemeralConsole";
import { Markdown } from "./Markdown";
import { isInsightKind, type InsightView } from "./insight";
import type { ChatBatchItem, ChatStackItem } from "./types";
import { Walkthrough } from "./Walkthrough";

interface CanvasStackProps {
  spaceId: string | null;
  items: ChatStackItem[];
  activeId: string | null;
  sequences: SequenceSummary[];
  events: EventSummary[];
  batchBusy: boolean;
  insight: InsightView | null;
  onCloseInsight: () => void;
  onSelect: (id: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onRecord: (item: {
    kind: ChatStackItem["kind"];
    title: string;
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  onPatch: (itemId: string, payload: Record<string, unknown>) => Promise<void>;
}

export function CanvasStack({
  spaceId,
  items,
  activeId,
  sequences,
  events,
  batchBusy,
  insight,
  onCloseInsight,
  onSelect,
  onAccept,
  onReject,
  onRecord,
  onPatch
}: CanvasStackProps) {
  const canvasItems = items.filter((item) => !isInsightKind(item.kind));
  const active =
    canvasItems.find((item) => item.id === activeId) ?? canvasItems[canvasItems.length - 1] ?? null;

  return (
    <section className="panel canvasStack" aria-label="Canvas">
      <div className="canvasTabs" role="tablist">
        {canvasItems.length === 0 ? <span className="muted">Canvas</span> : null}
        {canvasItems.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active?.id}
            className={item.id === active?.id ? "active" : undefined}
            onClick={() => {
              onCloseInsight();
              onSelect(item.id);
            }}
          >
            {item.title || item.kind}
          </button>
        ))}
      </div>
      <div className="panel__body canvasBody">
        {insight ? (
          <div className="canvasInsight">
            <div className="canvasInsightBar">
              <button type="button" className="canvasInsightClose" aria-label="Close" onClick={onCloseInsight}>
                ×
              </button>
            </div>
            {insight.kind === "reasoning" ? (
              <ReasoningView rounds={insight.rounds} />
            ) : (
              <ReadsView entry={insight.entry} />
            )}
          </div>
        ) : (
          <>
            {!active ? (
              <p className="muted">
                Ask the chat to open a console, or accept a change to review it here.
              </p>
            ) : null}
            {active && spaceId ? (
              <CanvasItem
                spaceId={spaceId}
                item={active}
                sequences={sequences}
                events={events}
                batchBusy={batchBusy}
                onAccept={onAccept}
                onReject={onReject}
                onRecord={onRecord}
                onPatch={onPatch}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function CanvasItem({
  spaceId,
  item,
  sequences,
  events,
  batchBusy,
  onAccept,
  onReject,
  onRecord,
  onPatch
}: {
  spaceId: string;
  item: ChatStackItem;
  sequences: SequenceSummary[];
  events: EventSummary[];
  batchBusy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRecord: CanvasStackProps["onRecord"];
  onPatch: CanvasStackProps["onPatch"];
}) {
  if (item.kind === "saved_console") {
    const consoleId = String(item.payload.console_id || "");
    if (!consoleId) return <p className="muted">This console has no id.</p>;
    return (
      <ConsoleHost
        spaceId={spaceId}
        consoleId={consoleId}
        mode="live"
        fluid
        sequences={sequences}
        events={events}
        externalRefreshToken={0}
      />
    );
  }
  if (item.kind === "ephemeral_console") {
    return <EphemeralConsole spaceId={spaceId} item={item} sequences={sequences} />;
  }
  if (item.kind === "proposal") {
    return (
      <ProposalList
        spaceId={spaceId}
        item={item}
        sequences={sequences}
        batchBusy={batchBusy}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
  }
  if (item.kind === "hitl") {
    return <HitlForm spaceId={spaceId} item={item} onRecord={onRecord} onPatch={onPatch} />;
  }
  if (item.kind === "builder") {
    return <ReadOnlyBuilder item={item} />;
  }
  if (item.kind === "walkthrough") {
    return <Walkthrough spaceId={spaceId} item={item} sequences={sequences} />;
  }
  return <pre className="canvasLog">{JSON.stringify(item.payload, null, 2)}</pre>;
}

function ProposalList({
  spaceId,
  item,
  sequences,
  batchBusy,
  onAccept,
  onReject
}: {
  spaceId: string;
  item: ChatStackItem;
  sequences: SequenceSummary[];
  batchBusy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const status = String(item.payload.status || "pending");
  const proposalItems = Array.isArray(item.payload.items) ? (item.payload.items as ChatBatchItem[]) : [];
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className="canvasProposal">
      <h2>Proposed changes</h2>
      <p className="muted">{status}</p>
      <ul className="proposalList">
        {proposalItems.map((proposal, index) => {
          const open = openIndex === index;
          return (
            <li key={`${proposal.kind}-${index}`} className="proposalItem">
              <button
                type="button"
                className="proposalToggle"
                aria-expanded={open}
                onClick={() => setOpenIndex(open ? null : index)}
              >
                <span>{proposal.summary || proposal.kind}</span>
                <span className="proposalKind">{open ? "Hide" : "Show"} configuration</span>
              </button>
              {open ? <ConfigPreview spaceId={spaceId} item={proposal} sequences={sequences} /> : null}
            </li>
          );
        })}
      </ul>
      {status !== "pending" && item.payload.result ? (
        <p className="muted">{resultSentence(item.payload.result)}</p>
      ) : null}
      {status === "pending" ? (
        <div className="buttonRow">
          <button type="button" className="btnPrimary" disabled={batchBusy} onClick={onAccept}>
            Accept
          </button>
          <button type="button" disabled={batchBusy} onClick={onReject}>
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

function resultSentence(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as {
    failed?: { summary?: string; kind?: string; error?: string } | null;
    applied?: unknown[];
    not_applied?: Array<{ summary?: string; kind?: string }>;
  };
  const applied = Array.isArray(record.applied) ? record.applied.length : 0;
  const failed = record.failed
    ? `${record.failed.summary || record.failed.kind || "A change"} failed: ${record.failed.error || "unknown error"}`
    : "";
  const skipped = Array.isArray(record.not_applied)
    ? record.not_applied.map((entry) => entry.summary || entry.kind).filter(Boolean)
    : [];
  return [`${applied} applied.`, failed, skipped.length ? `Not applied: ${skipped.join(", ")}.` : ""]
    .filter(Boolean)
    .join(" ");
}

function ReadOnlyBuilder({ item }: { item: ChatStackItem }) {
  const snapshot = item.payload.snapshot;
  const kind = String(item.payload.builder_kind || "builder");
  return (
    <div className="canvasBuilder">
      <h2>{item.title}</h2>
      <p className="muted">
        Read-only {kind}. Changes are proposed in chat. There is no save button here.
      </p>
      <pre>{JSON.stringify(snapshot, null, 2)}</pre>
    </div>
  );
}

function HitlForm({
  spaceId,
  item,
  onRecord,
  onPatch
}: {
  spaceId: string;
  item: ChatStackItem;
  onRecord: CanvasStackProps["onRecord"];
  onPatch: CanvasStackProps["onPatch"];
}) {
  const parameters = Array.isArray(item.payload.parameters) ? item.payload.parameters : [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitted = item.payload.submitted === true;
  const stateId = String(item.payload.state_id || "");
  const sequenceId = String(item.payload.sequence_id || "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stateId || submitted) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runSequenceExecution(spaceId, stateId, values);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      await onPatch(item.id, { ...item.payload, submitted: true });
      await onRecord({
        kind: "run_log",
        title: "Run",
        payload: { sequence_id: sequenceId, result }
      });
      if (result.status === "pending") {
        await onRecord({
          kind: "hitl",
          title: "Input needed",
          payload: {
            sequence_id: sequenceId,
            state_id: result.state_id,
            step_id: result.step_id,
            parameters: result.parameters
          }
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="canvasHitl" onSubmit={submit}>
      <h2>Input needed</h2>
      {parameters.length === 0 ? <p className="muted">This run is waiting, but listed no fields.</p> : null}
      {parameters.map((parameter, index) => {
        const name = parameterName(parameter, index);
        return (
          <label key={name} className="canvasField">
            <span>{name}</span>
            <input
              value={values[name] || ""}
              disabled={submitted}
              onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
            />
          </label>
        );
      })}
      {error ? <p className="errorText">{error}</p> : null}
      <button type="submit" className="btnPrimary" disabled={busy || submitted || !stateId}>
        {submitted ? "Submitted" : "Submit"}
      </button>
    </form>
  );
}

function ReasoningView({ rounds }: { rounds: unknown[] }) {
  if (rounds.length === 0) return <p className="muted">No reasoning yet.</p>;
  return (
    <div className="canvasReasoning">
      {rounds.map((round, index) => {
        const entry = round as { round?: number; thought?: string; text?: string; tools?: string[] };
        return (
          <section key={`${entry.round ?? index}`}>
            <h2>Round {entry.round ?? index + 1}</h2>
            {entry.thought ? <Markdown text={entry.thought} /> : null}
            {entry.text ? <Markdown text={entry.text} /> : null}
            {entry.tools && entry.tools.length > 0 ? (
              <p className="muted">{entry.tools.join(", ")}</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ReadsView({
  entry
}: {
  entry: { name?: string; arguments?: unknown; result?: unknown } | null;
}) {
  if (!entry) return <p className="muted">No reads yet.</p>;
  return (
    <div className="canvasReads">
      <h2>{entry.name || "Read"}</h2>
      <h3>Arguments</h3>
      <pre>{JSON.stringify(entry.arguments ?? {}, null, 2)}</pre>
      <h3>Result</h3>
      <pre>{typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result, null, 2)}</pre>
    </div>
  );
}

function parameterName(parameter: unknown, index: number): string {
  if (typeof parameter === "string") return parameter;
  if (parameter && typeof parameter === "object" && "name" in parameter) {
    return String((parameter as { name?: unknown }).name || `field_${index}`);
  }
  return `field_${index}`;
}
