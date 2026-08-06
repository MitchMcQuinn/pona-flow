import { useEffect, useState } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  addOrderBy,
  removeOrderBy,
  setLimit,
  setSkip,
  updateOrderBy
} from "../../state/builder/queryHelpers";
import { extractExactParameterRef } from "../../state/builder/parameterRefs";
import { OrderByProjectionRow } from "./OrderByProjectionRow";
import type { LiteralOrParameter } from "../../state/builder/types";

function literalValue(ref: LiteralOrParameter | undefined): string {
  if (ref && "value" in ref) return String(ref.value);
  if (ref && "parameter" in ref) return `$${ref.parameter}`;
  return "";
}

function parseLiteralOrParameter(raw: string): LiteralOrParameter {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const paramName = extractExactParameterRef(trimmed);
  if (paramName) return { parameter: paramName };
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return { value: num };
}

function sameLiteralOrParameter(a: LiteralOrParameter, b: LiteralOrParameter | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

interface PaginationFieldProps {
  label: string;
  value: LiteralOrParameter | undefined;
  onChange: (next: LiteralOrParameter) => void;
}

// Number/parameter input with local text state so a parameter can be typed
// character-by-character (e.g. "$" then "$l" then "$limit") without the controlled
// value snapping back on each keystroke.
function PaginationField({ label, value, onChange }: PaginationFieldProps) {
  const [text, setText] = useState(() => literalValue(value));

  // Adopt the external value only when it represents something different from what
  // the local text already parses to (e.g. loading a saved query), so in-progress
  // parameter typing is preserved.
  useEffect(() => {
    if (!sameLiteralOrParameter(parseLiteralOrParameter(text), value)) {
      setText(literalValue(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value ?? null)]);

  return (
    <div className="builderField">
      <label>{label}</label>
      <input
        className="builderMono"
        placeholder="0 or $param"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseLiteralOrParameter(e.target.value));
        }}
      />
    </div>
  );
}

interface OrderPaginationSectionProps {
  /** When true, omit outer section chrome (used inside advanced options accordion). */
  nested?: boolean;
}

export function OrderPaginationSection({ nested = false }: OrderPaginationSectionProps) {
  const { state, patchQuery } = useBuilder();
  const { query } = state;
  const orderBy = query.order_by ?? [];
  // Read INSTANCE binds ORDER BY keys to selected match nodes/relationships and
  // graph property keys (with parameter support), mirroring the RETURN projection
  // and node/relationship filter pickers. Other flows keep the free-text expression.
  const useBoundOrderBy = query.operation === "read" && query.match[0]?.label === "INSTANCE";

  const content = (
    <>
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Order &amp; pagination</h3>
        <button
          type="button"
          className="builderTinyBtn builderAddBtn"
          onClick={() => patchQuery(addOrderBy())}
        >
          + order by
        </button>
      </div>

      {orderBy.map((item, index) =>
        useBoundOrderBy ? (
          <OrderByProjectionRow key={index} index={index} item={item} />
        ) : (
          <div className="builderRow" key={index}>
            <div className="builderField">
              <label>expression</label>
              <input
                className="builderMono"
                placeholder="n.name"
                value={item.expression}
                onChange={(e) => patchQuery(updateOrderBy(index, { expression: e.target.value }))}
              />
            </div>
            <div className="builderField">
              <label>direction</label>
              <select
                value={item.direction}
                onChange={(e) =>
                  patchQuery(updateOrderBy(index, { direction: e.target.value as "ASC" | "DESC" }))
                }
              >
                <option value="ASC">ASC</option>
                <option value="DESC">DESC</option>
              </select>
            </div>
            <button
              type="button"
              className="builderTinyBtn builderDanger"
              onClick={() => patchQuery(removeOrderBy(index))}
            >
              Remove
            </button>
          </div>
        )
      )}

      <div className="builderRow">
        <PaginationField
          label="SKIP"
          value={query.skip}
          onChange={(next) => patchQuery(setSkip(next))}
        />
        <PaginationField
          label="LIMIT"
          value={query.limit}
          onChange={(next) => patchQuery(setLimit(next))}
        />
      </div>
    </>
  );

  if (nested) {
    return <div className="builderNestedSection">{content}</div>;
  }

  return <section className="builderSection">{content}</section>;
}
