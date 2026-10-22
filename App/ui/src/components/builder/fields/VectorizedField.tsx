import { useBuilder } from "../../../state/builder/BuilderContext";
import { setSchemaVectorized } from "../../../state/builder/queryHelpers";
import { FieldTip } from "../FieldTip";
import { Toggle } from "../Toggle";
import { useSpaceEmbeddingsEnabled } from "./useSpaceEmbeddingsEnabled";

interface VectorizedFieldProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  checked: boolean;
  disabled?: boolean;
}

const HINT =
  "Include these records in semantic search. Mark the properties to embed with is_embedded, then reindex from the space's Embeddings settings.";

/**
 * SCHEMA-level opt-in to vector search, above the property list.
 *
 * Hidden unless this space has embeddings turned on. Only types marked here are reindexed,
 * so a space can embed the handful of records worth searching semantically without paying an
 * embedding round trip for every INSTANCE it stores.
 */
export function VectorizedField({
  clauseIndex,
  patternIndex,
  pathIndex,
  checked,
  disabled = false
}: VectorizedFieldProps) {
  const { patchQuery } = useBuilder();
  const embeddingsEnabled = useSpaceEmbeddingsEnabled();
  if (!embeddingsEnabled) return null;

  return (
    <div className="builderRowFlags">
      <Toggle
        checked={checked}
        onChange={(value) =>
          patchQuery(setSchemaVectorized(clauseIndex, patternIndex, pathIndex, value))
        }
        label="vectorized"
        labelFirst
        disabled={disabled}
        labelAdornment={<FieldTip text={HINT} />}
      />
    </div>
  );
}
