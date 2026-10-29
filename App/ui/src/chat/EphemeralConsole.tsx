import { useEffect, useMemo } from "react";
import { ConsoleFrame } from "../consoles/ConsoleFrame";
import { LiveViewCanvas } from "../consoles/components/LiveViewCanvas";
import { FormViewPanel } from "../consoles/components/FormViewPanel";
import { hydrateConsole } from "../consoles/docStore";
import { bindModuleSequences, consoleFromApi } from "../consoles/normalize";
import { SequenceOptionsProvider } from "../consoles/sequenceOptions";
import type { SequenceSummary } from "../state/types";
import type { ChatStackItem } from "./types";

export function EphemeralConsole({
  spaceId,
  item,
  sequences
}: {
  spaceId: string;
  item: ChatStackItem;
  sequences: SequenceSummary[];
}) {
  const record = useMemo(() => {
    const loaded = consoleFromApi({
      id: item.id,
      name: String(item.payload.name || item.title || "Console"),
      document: (item.payload.document || {}) as { views?: unknown; activeViewId?: string }
    });
    return {
      ...loaded,
      views: loaded.views.map((view) =>
        view.kind === "live"
          ? { ...view, modules: view.modules.map((module) => bindModuleSequences(module, sequences)) }
          : view
      )
    };
  }, [item, sequences]);
  useEffect(() => {
    hydrateConsole(record);
    return () => hydrateConsole(null);
  }, [record]);
  const view = record.views.find((entry) => entry.id === record.activeViewId) ?? record.views[0];
  const options = sequences.map((sequence) => ({
    value: sequence.id,
    label: sequence.label
  }));
  if (!view) return <p className="muted">This console has no view.</p>;
  return (
    <ConsoleFrame className="consoleEmbedded">
      <SequenceOptionsProvider options={options}>
        {view.kind === "form" ? (
          <FormViewPanel dashboardId={record.id} view={view} refreshToken={0} />
        ) : (
          <LiveViewCanvas
            spaceId={spaceId}
            dashboardId={record.id}
            view={view}
            editing={false}
            refreshToken={0}
            onConsoleRefresh={() => undefined}
            onAddRequest={() => undefined}
            fluid
          />
        )}
      </SequenceOptionsProvider>
    </ConsoleFrame>
  );
}
