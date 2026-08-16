import { useEffect, useState } from "react";
import {
  isVectorSearchAllLabels,
  isVectorSearchEnabled,
  normalizeVectorK,
  vectorKParameterName,
  vectorTextParameterName,
  VECTOR_SEARCH_DEFAULT_K,
  VECTOR_SEARCH_MAX_K
} from "@pona-flow/composer";
import { extractExactParameterRef } from "@pona-flow/authoring";
import { useBuilder } from "../../state/builder/BuilderContext";
import { setVectorSearch } from "../../state/builder/queryHelpers";
import connector from "../../services/connector";
import { fetchEmbeddingsConfig } from "../../services/api";
import { Toggle } from "./Toggle";
import type { LiteralOrParameter } from "../../state/builder/types";

function kFieldText(ref: LiteralOrParameter): string {
  if (ref && "value" in ref) return String(ref.value);
  if (ref && "parameter" in ref) return `$${ref.parameter}`;
  return "";
}

function parseKField(raw: string): LiteralOrParameter {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const paramName = extractExactParameterRef(trimmed);
  if (paramName) return { parameter: paramName };
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return { value: num };
}

function sameK(a: LiteralOrParameter, b: LiteralOrParameter): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Local text state so a parameter can be typed character-by-character ("$" then "$t"
// then "$topK") without the controlled value snapping back on each keystroke — the
// same reason OrderPaginationSection's PaginationField keeps its own text.
function KField({
  value,
  onChange
}: {
  value: LiteralOrParameter;
  onChange: (next: LiteralOrParameter) => void;
}) {
  const [text, setText] = useState(() => kFieldText(value));

  useEffect(() => {
    if (!sameK(parseKField(text), value)) setText(kFieldText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value ?? null)]);

  return (
    <div className="builderField">
      <label htmlFor="vector-search-k">k (top results)</label>
      <input
        id="vector-search-k"
        data-testid="vector-search-k"
        className="builderMono"
        placeholder={`1-${VECTOR_SEARCH_MAX_K} or $param`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseKField(e.target.value));
        }}
      />
    </div>
  );
}

/**
 * READ INSTANCE nearest-neighbour search controls.
 *
 * Lives between Match and Return. When on, the composer emits a vector-index CALL
 * instead of MATCH; conflicting RETURN / ORDER BY / LIMIT / hop controls are hidden
 * by their parent sections.
 */
export function VectorSearchSection() {
  const { state, patchQuery } = useBuilder();
  const { query, spaceId } = state;
  const enabled = isVectorSearchEnabled(query);
  const allLabels = isVectorSearchAllLabels(query);
  const text = query.vector_search?.text ?? "";
  const textParameter = vectorTextParameterName(query);
  const kParameter = vectorKParameterName(query);
  const attributiveLabel = String(
    query.match[0]?.patterns?.[0]?.path?.find((el) => el.kind === "node")?.node
      ?.attributive_label ?? ""
  ).trim();

  const [embeddingsEnabled, setEmbeddingsEnabled] = useState<boolean | null>(null);
  const [schemaVectorized, setSchemaVectorized] = useState<boolean | null>(null);

  useEffect(() => {
    if (!spaceId || !enabled) {
      setEmbeddingsEnabled(null);
      return;
    }
    let cancelled = false;
    fetchEmbeddingsConfig(spaceId)
      .then((cfg) => {
        if (!cancelled) setEmbeddingsEnabled(cfg.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setEmbeddingsEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, enabled]);

  useEffect(() => {
    // A broad search ignores the selected label, so its is_vectorized state is moot.
    if (!spaceId || !enabled || allLabels || !attributiveLabel || attributiveLabel.startsWith("$")) {
      setSchemaVectorized(null);
      return;
    }
    let cancelled = false;
    connector
      .fetchSchemaDefinition({ spaceId, attributiveLabel })
      .then((def) => {
        if (!cancelled) setSchemaVectorized(def.is_vectorized === true);
      })
      .catch(() => {
        if (!cancelled) setSchemaVectorized(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, enabled, allLabels, attributiveLabel]);

  const hints: string[] = [];
  if (enabled && embeddingsEnabled === false) {
    hints.push("Vector search is not enabled for this space (Embeddings settings).");
  }
  if (enabled && schemaVectorized === false) {
    hints.push(
      attributiveLabel
        ? `${attributiveLabel} is not marked is_vectorized — reindex will skip it.`
        : "Select an attributive_label that is marked is_vectorized."
    );
  }
  if (enabled && allLabels) {
    hints.push(
      attributiveLabel
        ? `Searching every vectorized type — the selected ${attributiveLabel} is ignored.`
        : "Searching every vectorized type."
    );
  }
  if (enabled && (textParameter || kParameter)) {
    const named = [textParameter && `$${textParameter}`, kParameter && `$${kParameter}`]
      .filter(Boolean)
      .join(" and ");
    hints.push(
      `${named} ${textParameter && kParameter ? "are" : "is"} supplied at run time, so this ` +
        "cannot be run from the builder — save it and drive it from a sequence."
    );
  }
  if (enabled) {
    hints.push(
      "Tight WHERE filters can return fewer than k hits (post-filter on the vector index)."
    );
  }

  return (
    <section className="builderSection" data-testid="vector-search-section">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Vector search</h3>
        <Toggle
          checked={enabled}
          onChange={(value) =>
            patchQuery(
              setVectorSearch({
                enabled: value,
                text: query.vector_search?.text ?? "",
                k: query.vector_search?.k ?? VECTOR_SEARCH_DEFAULT_K
              })
            )
          }
          label="vector_search"
          labelFirst
          id="vector-search-toggle"
        />
      </div>

      {enabled ? (
        <div className="builderFormTransition">
          <div className="builderField">
            <label htmlFor="vector-search-text">Search text</label>
            <textarea
              id="vector-search-text"
              data-testid="vector-search-text"
              rows={3}
              value={text}
              placeholder="Describe what to find… or $param"
              onChange={(e) => patchQuery(setVectorSearch({ text: e.target.value }))}
            />
          </div>
          <div className="builderField">
            <Toggle
              checked={allLabels}
              onChange={(value) => patchQuery(setVectorSearch({ all_labels: value }))}
              label="Search all types"
              labelFirst
              id="vector-search-all-labels-toggle"
            />
          </div>
          <KField
            value={normalizeVectorK(query.vector_search?.k)}
            onChange={(next) => patchQuery(setVectorSearch({ k: next }))}
          />
          {hints.length ? (
            <p className="builderCheckMsg muted" data-testid="vector-search-hint">
              {hints.join(" ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
