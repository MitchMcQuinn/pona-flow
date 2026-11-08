import { useEffect, useRef, useState, type FormEvent } from "react";
import { isChatAuthoringKind, preflightChatItems, previewChatIntent } from "@pona-flow/authoring";
import { AgentFace } from "./AgentFace";
import { ConsoleHost } from "../consoles/ConsoleHost";
import { SpaceConfigPanel, type SpaceConfigPanelProps } from "../components/space/SpaceConfigPanel";
import { runSequenceExecution } from "../services/api";
import type { EventSummary, SequenceSummary } from "../state/types";
import { ConfigPreview } from "./ConfigPreview";
import { acceptBlockingProblems, inputProblemBlocksAccept } from "./followUp";
import { EphemeralConsole } from "./EphemeralConsole";
import { Markdown } from "./Markdown";
import { isInsightKind, type InsightView } from "./insight";
import type { ChatBatchItem, ChatStackItem } from "./types";
import { Walkthrough } from "./Walkthrough";

const GRAPH_NAMES_NOTE =
  "These names are already in the graph this space connects to. The catalog can be empty and still share that graph with earlier work, so this plan will not create a second copy.";

function graphNamesTaken(problems: string[]): boolean {
  return problems.some((problem) => problem.includes("already taken") || problem.includes("already a step"));
}

function previewAlready(item: ChatStackItem): string[] {
  const preview = item.payload.preview;
  if (!preview || typeof preview !== "object") return [];
  const already = (preview as { already?: unknown }).already;
  if (!Array.isArray(already)) return [];
  return already.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

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
  onConfirmPlan: () => void;
  acceptBlocked?: string | null;
  onCredentialSecret?: (name: string, value: string) => void;
  settings?: Omit<SpaceConfigPanelProps, "initialTab" | "showClose"> | null;
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
  onConfirmPlan,
  acceptBlocked = null,
  onCredentialSecret,
  settings = null,
  onRecord,
  onPatch
}: CanvasStackProps) {
  const canvasItems = items.filter((item) => !isInsightKind(item.kind));
  const active =
    canvasItems.find((item) => item.id === activeId) ?? canvasItems[canvasItems.length - 1] ?? null;
  const showFace = !insight && !active;

  return (
    <section className={showFace ? "panel canvasStack canvasStackFace" : "panel canvasStack"} aria-label="canvas">
      {canvasItems.length > 0 ? (
        <div className="canvasTabs" role="tablist">
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
      ) : null}
      <div className="panel__body canvasBody screenFade" key={insight?.kind ?? active?.id ?? "face"}>
        {insight ? (
          <div className="canvasInsight">
            <div className="canvasInsightBar">
              <button type="button" className="canvasInsightClose" aria-label="close" onClick={onCloseInsight}>
                ×
              </button>
            </div>
            {insight.kind === "reasoning" ? (
              <ReasoningView rounds={insight.rounds} />
            ) : (
              <ReadsView entry={insight.entry} />
            )}
          </div>
        ) : showFace ? (
          <AgentFace />
        ) : (
          <>
            {active && spaceId ? (
              <CanvasItem
                spaceId={spaceId}
                item={active}
                sequences={sequences}
                events={events}
                batchBusy={batchBusy}
                onAccept={onAccept}
                onReject={onReject}
                onConfirmPlan={onConfirmPlan}
                acceptBlocked={acceptBlocked}
                onCredentialSecret={onCredentialSecret}
                settings={settings}
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
  onConfirmPlan,
  acceptBlocked,
  onCredentialSecret,
  settings,
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
  onConfirmPlan: () => void;
  acceptBlocked: string | null;
  onCredentialSecret?: (name: string, value: string) => void;
  settings: Omit<SpaceConfigPanelProps, "initialTab" | "showClose"> | null;
  onRecord: CanvasStackProps["onRecord"];
  onPatch: CanvasStackProps["onPatch"];
}) {
  if (item.kind === "saved_console") {
    const consoleId = String(item.payload.console_id || "");
    if (!consoleId) return <p className="muted">this console has no id.</p>;
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
  if (item.kind === "plan") {
    return (
      <PlanBrief
        spaceId={spaceId}
        item={item}
        sequences={sequences}
        batchBusy={batchBusy}
        onConfirm={onConfirmPlan}
        onAccept={onAccept}
        onReject={onReject}
        acceptBlocked={acceptBlocked}
        onCredentialSecret={onCredentialSecret}
      />
    );
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
        acceptBlocked={acceptBlocked}
        onCredentialSecret={onCredentialSecret}
      />
    );
  }
  if (item.kind === "settings") {
    if (!settings) return <p className="muted">open a space before changing its settings.</p>;
    const tab = String(item.payload.tab || "settings");
    return (
      <SpaceConfigPanel
        {...settings}
        initialTab={isSettingsTab(tab) ? tab : "settings"}
        showClose={false}
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

function planProposalItems(item: ChatStackItem): ChatBatchItem[] {
  const batchStatus = typeof item.payload.batch_status === "string" ? item.payload.batch_status : "";
  const source = batchStatus
    ? item.payload.items
    : (item.payload.preview as { items?: unknown } | undefined)?.items;
  return Array.isArray(source) ? (source as ChatBatchItem[]) : [];
}

function useProposalPreflight(spaceId: string | null, items: ChatBatchItem[]) {
  const [problems, setProblems] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const signature = JSON.stringify(items);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const current = itemsRef.current;
    if (!spaceId || current.length === 0) {
      setProblems([]);
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    preflightChatItems(spaceId, current)
      .then((found) => {
        if (!cancelled) setProblems(found);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProblems([error instanceof Error ? error.message : "Could not check this proposal."]);
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, signature]);
  return { problems, checking };
}

function PlanBrief({
  spaceId,
  item,
  sequences,
  batchBusy,
  onConfirm,
  onAccept,
  onReject,
  acceptBlocked,
  onCredentialSecret
}: {
  spaceId: string;
  item: ChatStackItem;
  sequences: SequenceSummary[];
  batchBusy: boolean;
  onConfirm: () => void;
  onAccept: () => void;
  onReject: () => void;
  acceptBlocked: string | null;
  onCredentialSecret?: (name: string, value: string) => void;
}) {
  const brief = (item.payload.brief || {}) as Record<string, unknown>;
  const ontology = (brief.ontology || {}) as { types?: Array<Record<string, unknown>>; links?: Array<Record<string, unknown>> };
  const inputs = Array.isArray(brief.inputs) ? (brief.inputs as Array<Record<string, unknown>>) : [];
  const outputs = Array.isArray(brief.outputs) ? (brief.outputs as Array<Record<string, unknown>>) : [];
  const operations = Array.isArray(brief.operations) ? (brief.operations as Array<Record<string, unknown>>) : [];
  const screens = Array.isArray(brief.screens) ? (brief.screens as Array<Record<string, unknown>>) : [];
  const assumptions = Array.isArray(brief.assumptions) ? (brief.assumptions as Array<Record<string, unknown>>) : [];
  const blocking = Array.isArray(item.payload.blocking)
    ? item.payload.blocking.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const already = previewAlready(item);
  const batchStatus = typeof item.payload.batch_status === "string" ? item.payload.batch_status : "";
  const ready = item.payload.ready === true && item.payload.status !== "confirmed" && !batchStatus;
  const proposalCheck = useProposalPreflight(spaceId, ready || batchStatus ? planProposalItems(item) : []);
  const reconstruction = (brief.reconstruction || {}) as { because?: string };
  const [tab, setTab] = useState<"plan" | "proposal">(batchStatus === "pending" ? "proposal" : "plan");
  useEffect(() => {
    setTab(batchStatus === "pending" ? "proposal" : "plan");
  }, [item.id]);
  useEffect(() => {
    if (batchStatus === "pending") setTab("proposal");
  }, [batchStatus]);
  return (
    <div className="canvasProposal">
      <div className="planViewTabs" role="tablist" aria-label="plan">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "plan"}
          className={tab === "plan" ? "active" : undefined}
          onClick={() => setTab("plan")}
        >
          plan
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "proposal"}
          className={tab === "proposal" ? "active" : undefined}
          onClick={() => setTab("proposal")}
        >
          proposal
        </button>
      </div>
      {tab === "plan" ? (
        <>
          <h2>plan</h2>
          <p>{String(brief.routine || "The routine is not set yet.")}</p>
          {reconstruction.because ? <p className="muted">{reconstruction.because}</p> : null}
          <h3>records</h3>
          <ul className="proposalList">
            {(ontology.types || []).map((entry) => (
              <li key={String(entry.label)} className="proposalItem">
                <span>{String(entry.label)}</span>
              </li>
            ))}
            {(ontology.links || []).map((entry) => (
              <li key={`${entry.from}-${entry.to}`} className="proposalItem">
                <span>
                  {String(entry.from)} → {String(entry.to)}
                </span>
                {entry.infers ? <p className="muted">{String(entry.infers)}</p> : null}
              </li>
            ))}
          </ul>
          {operations.length > 0 ? (
            <>
              <h3>operations</h3>
              <ul className="proposalList">
                {operations.map((entry) => (
                  <li key={`${entry.operation}-${entry.type}`} className="proposalItem">
                    <span>
                      {String(entry.operation)} {String(entry.type)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {screens.length > 0 ? (
            <>
              <h3>screens</h3>
              <ul className="proposalList">
                {screens.map((entry) => (
                  <li key={String(entry.name)} className="proposalItem">
                    <span>{String(entry.name)}</span>
                    {Array.isArray(entry.views)
                      ? (entry.views as Array<Record<string, unknown>>).map((view) => (
                          <p key={`${view.name}-${view.module}`} className="muted">
                            {String(view.name || view.subject)} · {String(view.module)}
                          </p>
                        ))
                      : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3>inputs</h3>
          <ul className="proposalList">
            {inputs.map((entry) => (
              <li key={String(entry.name)} className="proposalItem">
                <span>
                  {String(entry.name)} · {String(entry.source)}
                </span>
              </li>
            ))}
          </ul>
          <h3>sequences</h3>
          <ul className="proposalList">
            {outputs.map((entry) => (
              <li key={String(entry.name)} className="proposalItem">
                <span>{String(entry.name)}</span>
              </li>
            ))}
          </ul>
          {assumptions.length > 0 ? (
            <>
              <h3>assumptions</h3>
              <ul className="proposalList">
                {assumptions.map((entry) => (
                  <li key={String(entry.id)} className="proposalItem">
                    <span>{String(entry.adds)}</span>
                    {entry.because ? <p className="muted">{String(entry.because)}</p> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {already.length > 0 ? (
            <>
              <h3>already in this space</h3>
              <ul className="proposalList">
                {already.map((entry, index) => (
                  <li key={`${entry}-${index}`} className="proposalItem">
                    <span>{entry}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {blocking.length > 0 ? (
            <>
              <h3>still open</h3>
              <ul className="proposalList">
                {blocking.map((entry) => (
                  <li key={entry} className="proposalItem">
                    <span>{entry}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <>
          {already.length > 0 ? (
            <p className="muted">Already in this space, so this proposal leaves them as they are.</p>
          ) : null}
          <ProposalList
          spaceId={spaceId}
          item={proposalView(item)}
          sequences={sequences}
          batchBusy={batchBusy}
          onAccept={onAccept}
          onReject={onReject}
          acceptBlocked={acceptBlocked}
          onCredentialSecret={onCredentialSecret}
          proposalCheck={proposalCheck}
          embedded
        />
        </>
      )}
      {ready && proposalCheck.checking ? <p className="muted">Checking this proposal…</p> : null}
      {ready && graphNamesTaken(proposalCheck.problems) ? (
        <p className="muted">{GRAPH_NAMES_NOTE}</p>
      ) : null}
      {ready
        ? proposalCheck.problems.map((problem) => (
            <p key={problem} className="builderCheckMsg error">
              {problem}
            </p>
          ))
        : null}
      {ready ? (
        <button
          type="button"
          className="btnPrimary"
          disabled={batchBusy || proposalCheck.checking || proposalCheck.problems.length > 0}
          onClick={onConfirm}
        >
          {batchBusy ? "confirming…" : "confirm plan"}
        </button>
      ) : null}
    </div>
  );
}

function proposalView(item: ChatStackItem): ChatStackItem {
  const batchStatus = typeof item.payload.batch_status === "string" ? item.payload.batch_status : "";
  if (batchStatus) {
    return {
      ...item,
      payload: {
        status: batchStatus,
        items: item.payload.items,
        problems: item.payload.problems,
        result: item.payload.result,
        inputs: item.payload.inputs
      }
    };
  }
  const preview = (item.payload.preview || {}) as {
    items?: ChatBatchItem[];
    error?: string;
    problems?: string[];
  };
  const problems = [
    ...(typeof preview.error === "string" && preview.error ? [preview.error] : []),
    ...(Array.isArray(preview.problems) ? preview.problems.filter((problem): problem is string => typeof problem === "string") : [])
  ];
  return {
    ...item,
    payload: {
      status: "draft",
      items: Array.isArray(preview.items) ? preview.items : [],
      problems
    }
  };
}

function ProposalList({
  spaceId,
  item,
  sequences,
  batchBusy,
  onAccept,
  onReject,
  acceptBlocked,
  onCredentialSecret,
  proposalCheck = null,
  embedded = false
}: {
  spaceId: string;
  item: ChatStackItem;
  sequences: SequenceSummary[];
  batchBusy: boolean;
  onAccept: () => void;
  onReject: () => void;
  acceptBlocked: string | null;
  onCredentialSecret?: (name: string, value: string) => void;
  proposalCheck?: { problems: string[]; checking: boolean } | null;
  embedded?: boolean;
}) {
  const status = String(item.payload.status || "pending");
  const proposalItems = Array.isArray(item.payload.items) ? (item.payload.items as ChatBatchItem[]) : [];
  const problems = Array.isArray(item.payload.problems)
    ? item.payload.problems.filter((problem): problem is string => typeof problem === "string" && problem.length > 0)
    : [];
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const ownCheck = useProposalPreflight(spaceId, proposalCheck ? [] : proposalItems);
  const check = proposalCheck ?? ownCheck;
  const compileError = proposalItems.map(intentProblem).find((problem): problem is string => Boolean(problem)) ?? null;
  const showPreflight = status === "pending" || proposalCheck == null;
  const blocked = compileError || acceptBlocked || (showPreflight ? check.problems[0] || (check.checking ? "Checking this proposal…" : null) : null);
  return (
    <div className="canvasProposal">
      {embedded ? null : <h2>proposed changes</h2>}
      <p className="muted">{status}</p>
      {embedded && proposalItems.length === 0 ? (
        <p className="muted">The configuration fills in as the plan takes shape.</p>
      ) : null}
      <ul className="proposalList">
        {proposalItems.map((proposal, index) => {
          const open = openIndex === index;
          const problem = intentProblem(proposal);
          return (
            <li key={`${proposal.kind}-${index}`} className="proposalItem">
              <button
                type="button"
                className="proposalToggle"
                aria-expanded={open}
                onClick={() => setOpenIndex(open ? null : index)}
              >
                <span>{proposal.summary || proposal.kind}</span>
                <span className="proposalKind">{open ? "hide" : "show"} configuration</span>
              </button>
              {problem ? <p className="builderCheckMsg error">{problem}</p> : null}
              {open ? (
                <ConfigPreview
                  spaceId={spaceId}
                  item={proposal}
                  sequences={sequences}
                  secret={secrets[String(proposal.payload?.name || "")] || ""}
                  onSecret={(value) => {
                    const name = String(proposal.payload?.name || "");
                    setSecrets((current) => ({ ...current, [name]: value }));
                    if (name) onCredentialSecret?.(name, value);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {status !== "pending" && item.payload.result ? (
        <p className="muted">{resultSentence(item.payload.result)}</p>
      ) : null}
      {status === "pending" && proposalItems.some((entry) => entry.kind === "create_space") ? (
        <p className="muted">
          this instance already has its workspace, so this change cannot be applied.
        </p>
      ) : null}
      {status !== "pending" && item.payload.result ? <AgentKeyNotice result={item.payload.result} /> : null}
      {problems.map((problem) => (
        <p key={problem} className={inputProblemBlocksAccept(problem) ? "builderCheckMsg error" : "muted"}>
          {problem}
        </p>
      ))}
      {showPreflight && check.checking ? <p className="muted">Checking this proposal…</p> : null}
      {showPreflight && graphNamesTaken(check.problems) ? <p className="muted">{GRAPH_NAMES_NOTE}</p> : null}
      {showPreflight
        ? check.problems.map((problem) => (
            <p key={problem} className="builderCheckMsg error">
              {problem}
            </p>
          ))
        : null}
      {status === "pending" ? (
        <div className="buttonRow">
          <button
            type="button"
            className="btnPrimary"
            disabled={
              batchBusy ||
              Boolean(blocked) ||
              acceptBlockingProblems(problems).length > 0 ||
              proposalItems.some((entry) => entry.kind === "create_space")
            }
            onClick={onAccept}
          >
            accept
          </button>
          <button type="button" disabled={batchBusy} onClick={onReject}>
            reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

const SETTINGS_TABS = [
  "settings",
  "chat",
  "users",
  "agents",
  "credentials",
  "embeddings",
  "templates",
  "audit",
  "account",
  "update"
] as const;

function isSettingsTab(tab: string): tab is (typeof SETTINGS_TABS)[number] {
  return (SETTINGS_TABS as readonly string[]).includes(tab);
}

function intentProblem(item: ChatBatchItem): string | null {
  if (!isChatAuthoringKind(item.kind)) return null;
  try {
    previewChatIntent(item);
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : "this configuration cannot be opened in the builder";
  }
}

function AgentKeyNotice({ result }: { result: unknown }) {
  if (!result || typeof result !== "object" || !("applied" in result)) return null;
  const applied = (result as { applied?: unknown }).applied;
  if (!Array.isArray(applied)) return null;
  const tokens = applied.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("token" in entry)) return [];
    const token = (entry as { token?: unknown }).token;
    return typeof token === "string" && token ? [token] : [];
  });
  if (tokens.length === 0) return null;
  return (
    <div className="canvasField">
      <p>agent key, shown once. copy it before you leave this proposal.</p>
      {tokens.map((token) => (
        <code key={token}>{token}</code>
      ))}
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
    ? `${record.failed.summary || record.failed.kind || "a change"} failed: ${record.failed.error || "unknown error"}`
    : "";
  const skipped = Array.isArray(record.not_applied)
    ? record.not_applied.map((entry) => entry.summary || entry.kind).filter(Boolean)
    : [];
  return [`${applied} applied.`, failed, skipped.length ? `not applied: ${skipped.join(", ")}.` : ""]
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
        read-only {kind}. changes are proposed in chat. there is no save button here.
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
        title: "run",
        payload: { sequence_id: sequenceId, result }
      });
      if (result.status === "pending") {
        await onRecord({
          kind: "hitl",
          title: "input needed",
          payload: {
            sequence_id: sequenceId,
            state_id: result.state_id,
            step_id: result.step_id,
            parameters: result.parameters
          }
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="canvasHitl" onSubmit={submit}>
      <h2>input needed</h2>
      {parameters.length === 0 ? <p className="muted">this run is waiting, but listed no fields.</p> : null}
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
        {submitted ? "submitted" : "submit"}
      </button>
    </form>
  );
}

function ReasoningView({ rounds }: { rounds: unknown[] }) {
  if (rounds.length === 0) return <p className="muted">no reasoning yet.</p>;
  return (
    <div className="canvasReasoning">
      {rounds.map((round, index) => {
        const entry = round as {
          round?: number;
          role?: string;
          thought?: string;
          text?: string;
          tools?: string[];
        };
        return (
          <section key={`${entry.round ?? index}`}>
            <h2>
              round {entry.round ?? index + 1}
              {entry.role ? ` · ${entry.role}` : ""}
            </h2>
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
  if (!entry) return <p className="muted">no reads yet.</p>;
  return (
    <div className="canvasReads">
      <h2>{entry.name || "read"}</h2>
      <h3>arguments</h3>
      <pre>{JSON.stringify(entry.arguments ?? {}, null, 2)}</pre>
      <h3>result</h3>
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
