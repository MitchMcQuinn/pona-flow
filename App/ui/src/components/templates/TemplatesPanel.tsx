import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyTemplateImport,
  exportTemplate,
  fetchEvents,
  fetchSequences,
  fetchTemplateSchemas,
  getTemplateImportStatus,
  previewTemplateImport,
  type TemplateConflict,
  type TemplateCredentialNeeded,
  type TemplateDocument,
  type TemplateImportResult,
  type TemplateSchemaOption,
  type TemplateSelection,
  type TemplateSummary
} from "../../services/api";
import type { EventSummary, SequenceSummary } from "../../state/types";

interface TemplatesPanelProps {
  spaceId: string | null;
}

function templateIdOf(template: TemplateDocument | null): string {
  return template && typeof template.template_id === "string" ? template.template_id : "";
}

function toggleInSet(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

const SUMMARY_ROWS: Array<{ key: keyof TemplateSummary; label: string }> = [
  { key: "sequences", label: "Sequences" },
  { key: "operations", label: "Queries" },
  { key: "steps", label: "Steps" },
  { key: "schemas", label: "Schemas" },
  { key: "instances", label: "Instances" },
  { key: "relationships", label: "Relationships" },
  { key: "regex", label: "Regex formats" },
  { key: "events", label: "Events / schedules" },
  { key: "credential_slots", label: "Credential slots" }
];

export function TemplatesPanel({ spaceId }: TemplatesPanelProps) {
  // Selection source lists.
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [operations, setOperations] = useState<SequenceSummary[]>([]);
  const [schemas, setSchemas] = useState<TemplateSchemaOption[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selected ids/labels.
  const [selSequences, setSelSequences] = useState<Set<string>>(new Set());
  const [selOperations, setSelOperations] = useState<Set<string>>(new Set());
  const [selSchemas, setSelSchemas] = useState<Set<string>>(new Set());
  const [selInstances, setSelInstances] = useState<Set<string>>(new Set());
  const [selEvents, setSelEvents] = useState<Set<string>>(new Set());

  // Resolve / export state.
  const [resolving, setResolving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<TemplateDocument | null>(null);

  // Import state.
  const [template, setTemplate] = useState<TemplateDocument | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [conflicts, setConflicts] = useState<TemplateConflict[]>([]);
  const [credentialsNeeded, setCredentialsNeeded] = useState<TemplateCredentialNeeded[]>([]);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<TemplateImportResult | null>(null);
  const [priorRun, setPriorRun] = useState<TemplateImportResult | null>(null);

  const loadSelectionSources = useCallback(async () => {
    if (!spaceId) return;
    setLoadError(null);
    try {
      const [allQueries, schemaList, eventList] = await Promise.all([
        fetchSequences(),
        fetchTemplateSchemas(spaceId),
        fetchEvents(spaceId)
      ]);
      setSequences(allQueries.filter((q) => q.kind === "sequence"));
      setOperations(allQueries.filter((q) => q.kind === "operation"));
      setSchemas(schemaList);
      setEvents(eventList);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : "Failed to load selection lists");
    }
  }, [spaceId]);

  // Reset everything when the active space changes.
  useEffect(() => {
    setSelSequences(new Set());
    setSelOperations(new Set());
    setSelSchemas(new Set());
    setSelInstances(new Set());
    setSelEvents(new Set());
    setResolved(null);
    setExportError(null);
    setTemplate(null);
    setFileName("");
    setConflicts([]);
    setCredentialsNeeded([]);
    setRenames({});
    setImportError(null);
    setResult(null);
    setPriorRun(null);
    void loadSelectionSources();
  }, [spaceId, loadSelectionSources]);

  const selection: TemplateSelection = useMemo(
    () => ({
      sequences: Array.from(selSequences),
      operations: Array.from(selOperations),
      schemas: Array.from(selSchemas),
      instances: Array.from(selInstances).filter((label) => selSchemas.has(label)),
      events: Array.from(selEvents)
    }),
    [selSequences, selOperations, selSchemas, selInstances, selEvents]
  );

  const hasSelection =
    selection.sequences.length > 0 ||
    selection.operations.length > 0 ||
    selection.schemas.length > 0 ||
    selection.events.length > 0;

  // A selection change invalidates a previously resolved document.
  function invalidateResolved() {
    setResolved(null);
  }

  async function handleResolve() {
    if (!spaceId || !hasSelection) return;
    setResolving(true);
    setExportError(null);
    try {
      const doc = await exportTemplate(spaceId, selection);
      setResolved(doc);
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : "Failed to resolve selection");
    } finally {
      setResolving(false);
    }
  }

  function handleDownload() {
    if (!resolved) return;
    const blob = new Blob([JSON.stringify(resolved, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${spaceId}-template.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !spaceId) return;
    setImportError(null);
    setResult(null);
    setConflicts([]);
    setCredentialsNeeded([]);
    setRenames({});
    setPriorRun(null);
    setFileName(file.name);
    let parsed: TemplateDocument;
    try {
      parsed = JSON.parse(await file.text()) as TemplateDocument;
    } catch {
      setImportError("Selected file is not valid JSON.");
      setTemplate(null);
      return;
    }
    setTemplate(parsed);
    setPreviewing(true);
    try {
      const preview = await previewTemplateImport(spaceId, parsed);
      setConflicts(preview.conflicts);
      setCredentialsNeeded(preview.credentials_needed);
      const seeded: Record<string, string> = {};
      for (const conflict of preview.conflicts) seeded[conflict.id] = conflict.suggested_name;
      setRenames(seeded);
      const tid = templateIdOf(parsed);
      if (tid) {
        const status = await getTemplateImportStatus(spaceId, tid);
        if (status && status.status !== "complete") setPriorRun(status);
      }
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : "Failed to inspect template");
    } finally {
      setPreviewing(false);
    }
  }

  const unresolved = useMemo(
    () => conflicts.some((c) => !(renames[c.id] || "").trim()),
    [conflicts, renames]
  );

  async function handleImport() {
    if (!spaceId || !template) return;
    setImporting(true);
    setImportError(null);
    setResult(null);
    try {
      const remaps = conflicts.map((c) => ({
        kind: c.kind,
        original_name: c.original_name,
        new_name: (renames[c.id] || "").trim()
      }));
      const outcome = await applyTemplateImport(spaceId, template, remaps);
      setResult(outcome);
      setPriorRun(null);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : "Failed to import template");
    } finally {
      setImporting(false);
    }
  }

  if (!spaceId) {
    return <p className="muted">Select a space to manage its templates.</p>;
  }

  const summary = resolved?.summary;

  return (
    <div className="spaceConfigSection templatesPanel">
      <div className="rbacHeaderRow">
        <h3>Export</h3>
      </div>
      <p className="muted rbacSectionHint">
        Pick the sequences, operations, schemas, and events you want to share. Everything they
        depend on (nested queries, STEP graph, connected schemas, regex formats,
        and credential slots) is pulled in automatically when you resolve the selection.
      </p>
      {loadError ? <p className="errorText">{loadError}</p> : null}
      {exportError ? <p className="errorText">{exportError}</p> : null}

      <div className="templateSelectionGroups">
        <section className="templateSelectionGroup" data-testid="template-select-sequences">
          <h4 className="navSectionHeader">Sequences</h4>
          {sequences.length === 0 ? (
            <p className="muted">No sequences in this space.</p>
          ) : (
            <ul className="templateSelectionList">
              {sequences.map((seq) => (
                <li key={seq.id} className="templateSelectionRow">
                  <label className="templateOption">
                    <input
                      type="checkbox"
                      checked={selSequences.has(seq.id)}
                      onChange={() => {
                        setSelSequences((prev) => toggleInSet(prev, seq.id));
                        invalidateResolved();
                      }}
                    />
                    <span>{seq.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="templateSelectionGroup" data-testid="template-select-operations">
          <h4 className="navSectionHeader">Queries</h4>
          {operations.length === 0 ? (
            <p className="muted">No standalone queries in this space.</p>
          ) : (
            <ul className="templateSelectionList">
              {operations.map((op) => (
                <li key={op.id} className="templateSelectionRow">
                  <label className="templateOption">
                    <input
                      type="checkbox"
                      checked={selOperations.has(op.id)}
                      onChange={() => {
                        setSelOperations((prev) => toggleInSet(prev, op.id));
                        invalidateResolved();
                      }}
                    />
                    <span>{op.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="templateSelectionGroup" data-testid="template-select-schemas">
          <h4 className="navSectionHeader">Schemas</h4>
          {schemas.length === 0 ? (
            <p className="muted">No schemas in this space.</p>
          ) : (
            <ul className="templateSelectionList">
              {schemas.map((schema) => {
                const label = schema.attributive_label;
                const selected = selSchemas.has(label);
                return (
                  <li key={schema.id} className="templateSelectionRow templateSchemaRow">
                    <label className="templateOption">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          setSelSchemas((prev) => toggleInSet(prev, label));
                          if (selected) {
                            setSelInstances((prev) => {
                              const next = new Set(prev);
                              next.delete(label);
                              return next;
                            });
                          }
                          invalidateResolved();
                        }}
                      />
                      <span>{label}</span>
                    </label>
                    {selected ? (
                      <label className="templateOption templateInstanceToggle">
                        <input
                          type="checkbox"
                          checked={selInstances.has(label)}
                          onChange={() => {
                            setSelInstances((prev) => toggleInSet(prev, label));
                            invalidateResolved();
                          }}
                        />
                        <span>include instances</span>
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="templateSelectionGroup" data-testid="template-select-events">
          <h4 className="navSectionHeader">Events / schedules</h4>
          {events.length === 0 ? (
            <p className="muted">No events in this space.</p>
          ) : (
            <ul className="templateSelectionList">
              {events.map((event) => (
                <li key={event.id} className="templateSelectionRow">
                  <label className="templateOption">
                    <input
                      type="checkbox"
                      checked={selEvents.has(event.id)}
                      onChange={() => {
                        setSelEvents((prev) => toggleInSet(prev, event.id));
                        invalidateResolved();
                      }}
                    />
                    <span>{event.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {summary ? (
        <div className="templateSummary" data-testid="template-export-summary">
          <h4 className="navSectionHeader">Resolved selection</h4>
          <ul className="templateSummaryList">
            {SUMMARY_ROWS.map((row) => (
              <li key={row.key} className="templateSummaryRow">
                <span className="templateSummaryLabel">{row.label}</span>
                <span className="templateSummaryCount">{summary[row.key] ?? 0}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="buttonRow">
        <button
          type="button"
          className="btnSecondary"
          data-testid="template-resolve-btn"
          disabled={!hasSelection || resolving}
          onClick={handleResolve}
        >
          {resolving ? "Resolving..." : "Resolve selection"}
        </button>
        <button
          type="button"
          className="btnPrimary"
          data-testid="template-export-btn"
          disabled={!resolved}
          onClick={handleDownload}
        >
          Download template
        </button>
      </div>

      <div className="rbacHeaderRow templatesImportHeader">
        <h3>Import</h3>
      </div>
      <p className="muted rbacSectionHint">
        Load a template file. Any names that would clash with this space are listed below so
        you can rename them before importing. The import is idempotent and can be re-run safely
        if it is interrupted.
      </p>
      <div className="builderFormFieldset">
        <div className="builderRow">
          <div className="builderField">
            <label>template file</label>
            <input
              type="file"
              accept="application/json,.json"
              data-testid="template-import-file"
              onChange={handleFile}
            />
          </div>
        </div>
        {fileName ? <p className="muted">Loaded {fileName}</p> : null}
      </div>

      {previewing ? <p className="muted">Checking for conflicts...</p> : null}
      {importError ? <p className="errorText">{importError}</p> : null}

      {priorRun ? (
        <p className="builderCheckMsg">
          A previous import of this template was interrupted ({priorRun.applied}/
          {priorRun.total} applied, status {priorRun.status}). Importing again resumes it.
        </p>
      ) : null}

      {template && conflicts.length > 0 ? (
        <div className="templateConflicts">
          <h3 className="navSectionHeader">Resolve name conflicts</h3>
          <ul className="templateConflictList">
            {conflicts.map((conflict) => (
              <li key={conflict.id} className="templateConflictRow">
                <span className="templateConflictName">
                  {conflict.original_name}
                  <span className="rbacSubId">{conflict.scope}</span>
                </span>
                <input
                  type="text"
                  value={renames[conflict.id] ?? ""}
                  data-testid={`template-rename-${conflict.id}`}
                  onChange={(e) =>
                    setRenames((prev) => ({ ...prev, [conflict.id]: e.target.value }))
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {template && !previewing && conflicts.length === 0 ? (
        <p className="muted">No conflicts detected. Ready to import.</p>
      ) : null}

      {result ? (
        <p className="builderCheckMsg" data-testid="template-import-result">
          Imported {result.applied}/{result.total} statements (status {result.status}
          {result.resumed ? ", resumed" : ""}).
        </p>
      ) : null}

      {result && credentialsNeeded.length > 0 ? (
        <div className="templateCredentials" data-testid="template-credentials-needed">
          <h3 className="navSectionHeader">Configure credentials</h3>
          <p className="muted rbacSectionHint">
            This template references the credential slots below. Their values are never exported;
            populate them in the space's Credentials settings before running the imported flows.
          </p>
          <ul className="templateCredentialList">
            {credentialsNeeded.map((cred) => (
              <li key={cred.name} className="templateCredentialRow">
                <span className="templateCredentialName">{cred.name}</span>
                {cred.description ? (
                  <span className="rbacSubId">{cred.description}</span>
                ) : null}
                <span className={cred.configured ? "templateCredOk" : "templateCredMissing"}>
                  {cred.configured ? "configured" : "needs value"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="buttonRow">
        <button
          type="button"
          className="btnPrimary"
          data-testid="template-import-btn"
          disabled={!template || previewing || importing || unresolved}
          onClick={handleImport}
        >
          {importing ? "Importing..." : "Import template"}
        </button>
      </div>
    </div>
  );
}
