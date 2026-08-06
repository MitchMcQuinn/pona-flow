import { useEffect, useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import {
  addEntityWhereFilter,
  addEntityWhereGroup,
  defaultWhereGroup,
  patchEntityWhere,
  patchRootWhereGroup,
  removeEntityWhereItem,
  setEntityWhereOperator,
  updateEntityWhereFilter
} from "../../../state/builder/pathWhereHelpers";
import { updateNode, updateRelationship } from "../../../state/builder/queryHelpers";
import type {
  GraphNodeLabel,
  NodePattern,
  RelationshipPattern,
  WhereComparisonOperator,
  WhereFilter,
  WhereGroup,
  WhereItem
} from "../../../state/builder/types";
import {
  isWhereFilter,
  isWhereGroup,
  WHERE_COMPARISON_OPERATORS,
  whereFilterUsesValuePicker
} from "../../../state/builder/types";
import {
  fetchWherePropertyKeysForEntity,
  fetchWherePropertyValuesForEntity
} from "./wherePropertyOptions";
import connector from "../../../services/connector";
import { SegmentToggle } from "../SegmentToggle";
import { extractExactParameterRef } from "../../../state/builder/parameterRefs";
import { isAttributiveLabelParameter } from "../../../state/builder/normalizeField";
import { validateSchemaDefaultValue } from "../../../state/builder/schemaRules";
import { schemaConstraintMap } from "../../../state/builder/updateInstanceGuard";
import type { SchematicProperties } from "../../../state/builder/types";

const ADD_PARAMETER_VALUE = "__add_parameter_value__";

interface PathWhereCardProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  clauseLabel: GraphNodeLabel;
  entityRole: "node" | "relationship";
  attributiveLabel: string;
  entity: NodePattern | RelationshipPattern;
}

function FilterRow({
  clauseLabel,
  entityRole,
  attributiveLabel,
  filter,
  itemPath,
  root,
  onRootChange
}: {
  clauseLabel: GraphNodeLabel;
  entityRole: "node" | "relationship";
  attributiveLabel: string;
  filter: WhereFilter;
  itemPath: number[];
  root: WhereGroup;
  onRootChange: (next: WhereGroup | undefined) => void;
}) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [keys, setKeys] = useState<string[]>([]);
  const [values, setValues] = useState<string[]>([]);
  const [constraints, setConstraints] = useState<Map<string, SchematicProperties>>(new Map());
  const initialParamName = extractExactParameterRef(String(filter.value ?? ""));
  const [parameterMode, setParameterMode] = useState(Boolean(initialParamName));
  const [parameterInput, setParameterInput] = useState(initialParamName ? `$${initialParamName}` : "");
  const [parameterError, setParameterError] = useState<string | null>(null);
  const needsValue = filter.operator !== "IS NULL" && filter.operator !== "IS NOT NULL";
  // A parameterized attributive_label has no concrete schema to read property keys
  // and values from, so the constrained pickers are replaced with free-text inputs
  // that accept either a literal or a $parameter.
  const attributiveLabelIsParameter = isAttributiveLabelParameter(attributiveLabel);
  const useValuePicker =
    needsValue && !attributiveLabelIsParameter && whereFilterUsesValuePicker(filter.operator);
  // RUD WHERE filters: a property value may be a literal (from the picker) or a
  // $parameter. PathWhereCard is only rendered in read/update/delete, so the
  // "+ Parameter" option is always offered here regardless of clause label.
  const allowParameterInPicker = true;

  useEffect(() => {
    const name = extractExactParameterRef(String(filter.value ?? ""));
    if (name) {
      setParameterMode(true);
      setParameterInput(`$${name}`);
      setParameterError(null);
    } else {
      setParameterMode(false);
      setParameterError(null);
    }
  }, [filter.value]);

  useEffect(() => {
    if (!spaceId || !attributiveLabel.trim()) {
      setKeys([]);
      return;
    }
    let cancelled = false;
    fetchWherePropertyKeysForEntity({
      spaceId,
      matchClauseLabel: clauseLabel,
      entityRole,
      attributiveLabel
    }).then((rows) => {
      if (!cancelled) setKeys(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, clauseLabel, entityRole, attributiveLabel]);

  useEffect(() => {
    if (!useValuePicker || !spaceId || !filter.property_key.trim()) {
      setValues([]);
      return;
    }
    let cancelled = false;
    fetchWherePropertyValuesForEntity({
      spaceId,
      matchClauseLabel: clauseLabel,
      entityRole,
      attributiveLabel,
      propertyKey: filter.property_key
    }).then((rows) => {
      if (!cancelled) setValues(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, clauseLabel, entityRole, attributiveLabel, filter.property_key, useValuePicker]);

  // Schema constraints power inline value-type validation on INSTANCE filters.
  useEffect(() => {
    if (clauseLabel !== "INSTANCE" || !spaceId || attributiveLabelIsParameter || !attributiveLabel.trim()) {
      setConstraints(new Map());
      return;
    }
    let cancelled = false;
    connector
      .fetchSchemaDefinition({ spaceId, attributiveLabel })
      .then((def) => {
        if (!cancelled) setConstraints(schemaConstraintMap(def));
      })
      .catch(() => {
        if (!cancelled) setConstraints(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [clauseLabel, spaceId, attributiveLabel, attributiveLabelIsParameter]);

  // Filters may use partial-match operators, so validate the value_type only (skip
  // string format) to avoid false positives on legitimate CONTAINS/STARTS WITH fragments.
  const filterConstraint = constraints.get((filter.property_key || "").trim());
  const rawFilterValue = String(filter.value ?? "");
  const filterValueCheck =
    needsValue &&
    !parameterMode &&
    filterConstraint &&
    rawFilterValue.trim() &&
    !extractExactParameterRef(rawFilterValue.trim())
      ? validateSchemaDefaultValue(filterConstraint.value_type, undefined, rawFilterValue)
      : null;

  const patchFilter = (patch: Partial<WhereFilter>) => {
    const next = updateEntityWhereFilter(root, itemPath, patch);
    onRootChange(next);
  };

  const remove = () => {
    const next = removeEntityWhereItem(root, itemPath);
    onRootChange(next);
  };

  function commitParameterReference(raw: string): boolean {
    const name = extractExactParameterRef(raw);
    if (!name) {
      setParameterError('Enter exactly one parameter reference (for example "$count").');
      return false;
    }
    setParameterError(null);
    patchFilter({ value: `$${name}` });
    return true;
  }

  return (
    <div className="builderItemRow">
      <div className="builderRow">
        <div className="builderField">
          <label>property</label>
          {attributiveLabelIsParameter ? (
            <input
              className="builderMono"
              type="text"
              value={filter.property_key}
              placeholder="property or $param"
              onChange={(e) => patchFilter({ property_key: e.target.value })}
            />
          ) : (
            <select
              value={filter.property_key}
              onChange={(e) => patchFilter({ property_key: e.target.value, value: "" })}
            >
              <option value="">(select property)</option>
              {keys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="builderField">
          <label>operator</label>
          <select
            value={filter.operator}
            onChange={(e) =>
              patchFilter({ operator: e.target.value as WhereComparisonOperator })
            }
          >
            {WHERE_COMPARISON_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </div>
        {needsValue ? (
          <div className="builderField">
            <label>
              value
              {filterValueCheck && !filterValueCheck.valid ? (
                <span className="builderCheckMsg duplicate"> {filterValueCheck.message}</span>
              ) : null}
            </label>
            {useValuePicker ? (
              <>
                <select
                  value={parameterMode ? ADD_PARAMETER_VALUE : filter.value ?? ""}
                  disabled={!filter.property_key}
                  onChange={(e) => {
                    if (e.target.value === ADD_PARAMETER_VALUE) {
                      setParameterMode(true);
                      setParameterError(null);
                      setParameterInput((prev) => prev || "$");
                      return;
                    }
                    setParameterMode(false);
                    setParameterError(null);
                    patchFilter({ value: e.target.value });
                  }}
                >
                  <option value="">(select value)</option>
                  {allowParameterInPicker ? <option value={ADD_PARAMETER_VALUE}>+ Parameter</option> : null}
                  {values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                {parameterMode ? (
                  <>
                    <input
                      className="builderMono"
                      type="text"
                      value={parameterInput}
                      disabled={!filter.property_key}
                      placeholder="$param"
                      onChange={(e) => {
                        const raw = e.target.value;
                        setParameterInput(raw);
                        if (extractExactParameterRef(raw)) {
                          commitParameterReference(raw);
                        }
                      }}
                      onBlur={() => {
                        commitParameterReference(parameterInput);
                      }}
                    />
                    {parameterError ? <span className="builderCheckMsg duplicate">{parameterError}</span> : null}
                  </>
                ) : null}
              </>
            ) : (
              <input
                className="builderMono"
                type="text"
                value={filter.value ?? ""}
                disabled={!filter.property_key}
                placeholder={attributiveLabelIsParameter ? "value or $param" : "value"}
                onChange={(e) => patchFilter({ value: e.target.value })}
              />
            )}
          </div>
        ) : null}
      </div>
      <div className="builderRowActions">
        <button type="button" className="builderTinyBtn builderDanger" onClick={remove}>
          Remove filter
        </button>
      </div>
    </div>
  );
}

function GroupEditor({
  group,
  path,
  clauseLabel,
  entityRole,
  attributiveLabel,
  root,
  onRootChange
}: {
  group: WhereGroup;
  path: number[];
  clauseLabel: GraphNodeLabel;
  entityRole: "node" | "relationship";
  attributiveLabel: string;
  root: WhereGroup;
  onRootChange: (next: WhereGroup | undefined) => void;
}) {
  const fullPath = (suffix: number[]) => [...path, ...suffix];

  const updateThisGroup = (next: WhereGroup) => {
    onRootChange(patchRootWhereGroup(root, path, next));
  };

  const addFilter = () => {
    const next = addEntityWhereFilter(group, []);
    updateThisGroup(next);
  };

  const addGroup = () => {
    const next = addEntityWhereGroup(group, []);
    updateThisGroup(next);
  };

  const removeThisGroup = () => {
    if (path.length === 0) {
      onRootChange(undefined);
      return;
    }
    const next = removeEntityWhereItem(root, path);
    onRootChange(next);
  };

  return (
    <div className={path.length ? "builderCard nested" : ""}>
      <div className="builderHeadRow">
        <div className="builderInline">
          <button type="button" className="builderTinyBtn builderAddBtn" onClick={addFilter}>
            + filter
          </button>
          <button type="button" className="builderTinyBtn builderAddBtn" onClick={addGroup}>
            + group
          </button>
          {path.length > 0 ? (
            <button type="button" className="builderTinyBtn builderDanger" onClick={removeThisGroup}>
              Remove group
            </button>
          ) : null}
        </div>
      </div>

      <div className="builderRow">
        <div className="builderField builderSegmentField">
          <label id={`builder-where-combine-${path.join("-") || "root"}`}>combine</label>
          <SegmentToggle
            labelledBy={`builder-where-combine-${path.join("-") || "root"}`}
            value={group.operator}
            options={[
              { value: "AND", label: "AND" },
              { value: "OR", label: "OR" }
            ]}
            onChange={(operator) => {
              const next = setEntityWhereOperator(group, [], operator);
              updateThisGroup(next);
            }}
          />
        </div>
      </div>

      {group.items.length === 0 ? <p className="builderCheckMsg">No filters in this group.</p> : null}

      {group.items.map((item: WhereItem, index) => {
        const itemPath = fullPath([index]);
        if (isWhereGroup(item)) {
          return (
            <GroupEditor
              key={index}
              group={item}
              path={itemPath}
              clauseLabel={clauseLabel}
              entityRole={entityRole}
              attributiveLabel={attributiveLabel}
              root={root}
              onRootChange={onRootChange}
            />
          );
        }
        if (isWhereFilter(item)) {
          return (
            <FilterRow
              key={index}
              clauseLabel={clauseLabel}
              entityRole={entityRole}
              attributiveLabel={attributiveLabel}
              filter={item}
              itemPath={itemPath}
              root={root}
              onRootChange={onRootChange}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

export function PathWhereCard({
  clauseIndex,
  patternIndex,
  pathIndex,
  clauseLabel,
  entityRole,
  attributiveLabel,
  entity
}: PathWhereCardProps) {
  const { patchQuery } = useBuilder();
  const root = entity.where ?? defaultWhereGroup();

  function saveWhere(next: WhereGroup | undefined) {
    const patch = patchEntityWhere(next);
    if (entityRole === "node") {
      patchQuery(updateNode(clauseIndex, patternIndex, pathIndex, patch));
    } else {
      patchQuery(updateRelationship(clauseIndex, patternIndex, pathIndex, patch));
    }
  }

  if (!attributiveLabel.trim()) return null;

  return (
    <div className="builderCard nested">
      <div className="builderHeadRow">
        <label className="matchPaneTitle">WHERE</label>
      </div>
      <GroupEditor
        group={root}
        path={[]}
        clauseLabel={clauseLabel}
        entityRole={entityRole}
        attributiveLabel={attributiveLabel}
        root={root}
        onRootChange={saveWhere}
      />
    </div>
  );
}
