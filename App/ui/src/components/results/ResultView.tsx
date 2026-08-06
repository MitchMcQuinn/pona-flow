import { useState } from "react";
import type { RunResult } from "../../state/builder/types";
import { GraphView } from "./GraphView";
import "./results.css";

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function TableView({ result }: { result: RunResult }) {
  const columns = result.columns ?? [];
  const rows = result.rows ?? [];
  if (rows.length === 0) return <p className="resultEmpty">No rows returned.</p>;
  return (
    <div className="resultTableWrap">
      <table className="resultTable">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{formatCell(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryView({ result }: { result: RunResult }) {
  const summary = result.summary ?? {};
  const counters = (summary.counters as Record<string, unknown>) ?? {};
  const entries = Object.entries(counters);
  const hasChanges = entries.some(([, v]) => Number(v) > 0);

  if (!hasChanges) {
    return (
      <div className="resultSummary">
        <p className="resultEmpty">No results to display.</p>
      </div>
    );
  }

  return (
    <div className="resultSummary">
      <p>Operation completed.</p>
      <table className="resultTable">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{formatCell(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatResponseBody(result: RunResult): string {
  const body = (result.response ?? "").trim();
  if (body) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  if (result.error) return result.error;
  return "No response body returned.";
}

function ResponseView({ result }: { result: RunResult }) {
  const succeeded = result.ok !== false && !result.error;
  const statusLabel =
    typeof result.status === "number" && result.status > 0
      ? `HTTP ${result.status}`
      : result.error
        ? "No response (network error)"
        : "No status";

  return (
    <div className="resultResponse" data-testid="result-response">
      <div className={`resultResponseStatus ${succeeded ? "ok" : "error"}`}>
        <span className="resultResponseBadge">{succeeded ? "Success" : "Failed"}</span>
        <span className="resultResponseStatusText">{statusLabel}</span>
      </div>
      <pre className="resultResponseBody">{formatResponseBody(result)}</pre>
    </div>
  );
}

export function ResultView({
  result,
  onClickNode,
  onClickRelationship,
  affectedNodeIds = null,
  affectedRelationshipIds = null
}: {
  result: RunResult;
  onClickNode?: (nodeId: string) => void;
  /** Click handler for POINTS_TO relationships in the result graph (jump to update-STEP flow). */
  onClickRelationship?: (relId: string) => void;
  /** STEP node ids to paint red (schema drift on the backing operation) + out-of-sync instances. */
  affectedNodeIds?: Set<string> | null;
  /** Relationship ids to paint red (out-of-sync INSTANCE relationships, is_current=false). */
  affectedRelationshipIds?: Set<string> | null;
}) {
  const hasGraph = (result.graph?.nodes.length ?? 0) > 0;
  const hasRows = (result.rows?.length ?? 0) > 0;
  const [mode, setMode] = useState<"graph" | "table">(hasGraph ? "graph" : "table");

  if (result.kind === "summary") {
    return <SummaryView result={result} />;
  }

  if (result.kind === "response") {
    return <ResponseView result={result} />;
  }

  return (
    <div className="resultView">
      {hasGraph && hasRows ? (
        <div className="resultToggle">
          <button
            type="button"
            className={mode === "graph" ? "active" : ""}
            data-testid="result-toggle-graph"
            onClick={() => setMode("graph")}
          >
            Graph
          </button>
          <button
            type="button"
            className={mode === "table" ? "active" : ""}
            data-testid="result-toggle-table"
            onClick={() => setMode("table")}
          >
            Table
          </button>
        </div>
      ) : null}

      {hasGraph && (mode === "graph" || !hasRows) ? (
        <GraphView
          graph={result.graph!}
          onClickNode={onClickNode}
          onClickRelationship={onClickRelationship}
          affectedNodeIds={affectedNodeIds}
          affectedRelationshipIds={affectedRelationshipIds}
        />
      ) : (
        <div data-testid="result-table">
          <TableView result={result} />
        </div>
      )}
    </div>
  );
}
