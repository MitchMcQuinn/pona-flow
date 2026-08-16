import { useBuilder } from "../../../state/builder/BuilderContext";
import { setSchemaVectorized } from "../../../state/builder/queryHelpers";
import { Toggle } from "../Toggle";

interface VectorizedFieldProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  checked: boolean;
  disabled?: boolean;
}

/**
 * SCHEMA-level opt-in to vector search, above the property list.
 *
 * Only types marked here are reindexed, so a space can embed the handful of records worth
 * searching semantically without paying an embedding round trip for every INSTANCE it stores.
 */
export function VectorizedField({
  clauseIndex,
  patternIndex,
  pathIndex,
  checked,
  disabled = false
}: VectorizedFieldProps) {
  const { patchQuery } = useBuilder();
  return (
    <div className="builderRowFlags">
      <Toggle
        checked={checked}
        onChange={(value) =>
          patchQuery(setSchemaVectorized(clauseIndex, patternIndex, pathIndex, value))
        }
        label="is_vectorized"
        labelFirst
        disabled={disabled}
      />
      <span className="muted">
        Include these records in semantic search. Mark the properties to embed with
        <code> is_embedded</code>, then reindex from the space&apos;s Embeddings settings.
      </span>
    </div>
  );
}
