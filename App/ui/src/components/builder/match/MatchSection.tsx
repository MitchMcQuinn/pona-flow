import { useBuilder } from "../../../state/builder/BuilderContext";
import { isEntityConfigUpdate } from "@pona-flow/authoring";
import { useCreateInstanceGuard } from "../hooks/useCreateInstanceGuard";
import { useCreateInstanceSchemaSync } from "../hooks/useCreateInstanceSchemaSync";
import { Pattern } from "./Pattern";
import { MatchGraph } from "./MatchGraph";
import { ElementConfig } from "./ElementConfig";
import { MatchBuilderLayout } from "./MatchBuilderLayout";

export function MatchSection() {
  const { state } = useBuilder();
  const { query } = state;

  // Heal create-INSTANCE schema drift on open: surface added properties, strip deleted ones.
  useCreateInstanceSchemaSync();
  // Lazy safety net: re-validate an open create-INSTANCE operation against the live schema.
  useCreateInstanceGuard();

  const clause = query.match[0];
  const clauseIndex = 0;
  if (!clause) return null;

  // Update STEP / SCHEMA edit a single entity's config payload (SQLite-only). That flow
  // keeps the legacy single-pattern card stack rather than the editable graph canvas.
  const entityConfigUpdate = isEntityConfigUpdate(query.operation, clause.label);

  return (
    <section className="builderBlock">
      {entityConfigUpdate ? (
        clause.patterns.map((pattern, patternIndex) => (
          <Pattern
            key={patternIndex}
            clauseIndex={clauseIndex}
            patternIndex={patternIndex}
            pattern={pattern}
            label={clause.label}
            operation={query.operation}
            canRemove={false}
          />
        ))
      ) : (
        <MatchBuilderLayout
          graph={
            <MatchGraph
              clauseIndex={clauseIndex}
              label={clause.label}
              operation={query.operation}
              editable
            />
          }
          config={
            <ElementConfig
              clauseIndex={clauseIndex}
              label={clause.label}
              operation={query.operation}
            />
          }
        />
      )}
    </section>
  );
}
