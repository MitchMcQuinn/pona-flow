import { useMemo, useState } from "react";
import composer from "../../services/composer";
import { useBuilder } from "../../state/builder/BuilderContext";
import { composePreview, normalizeForCompose } from "../../state/builder/selectors";
import { formatPreviewSqlBlock } from "../../utils/formatSqlForPreview";

export function LivePreview({
  createSequenceMode = false,
  sequenceName = "",
  sequenceGroupTitle = ""
}: {
  createSequenceMode?: boolean;
  sequenceName?: string;
  sequenceGroupTitle?: string;
} = {}) {
  const { state } = useBuilder();
  const preview = useMemo(() => composePreview(state), [state]);
  const [open, setOpen] = useState(false);

  const sequenceSql = useMemo(() => {
    if (!createSequenceMode) return null;
    const query = normalizeForCompose(state.query);
    return composer.composeSequenceCatalogUpsertSql({
      id: query.id,
      name: sequenceName,
      cypher: preview.composed.cypher,
      parameters: composer.queryParametersForQueriesCatalog(query),
      groupTitle: sequenceGroupTitle
    });
  }, [createSequenceMode, sequenceName, sequenceGroupTitle, preview.composed.cypher, state.query]);

  return (
    <div className="builderStepParams" data-testid="builder-query-preview">
      <button
        type="button"
        className={"builderStepParamsToggle" + (open ? " is-open" : "")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Query preview</span>
        <span className="builderStepParamsChevron" aria-hidden>
          ▸
        </span>
      </button>

      {open ? (
        <div className="builderStepParamsBody">
          <div className="builderPreviewGrid">
            <div className="builderPreviewBlock">
              <label className="builderField">Composed Cypher</label>
              <pre className="builderMono builderPreviewPre">{preview.cypher || "(empty)"}</pre>
            </div>
            <div className="builderPreviewBlock">
              <label className="builderField">Composed SQLite</label>
              {sequenceSql || preview.sqliteBlocks.length > 0 ? (
                <div className="builderPreviewSqliteStack">
                  {sequenceSql ? (
                    <pre className="builderMono builderPreviewPre builderPreviewPreBlue">
                      {formatPreviewSqlBlock(
                        `-- catalog data.db: queries table\n${sequenceSql}`
                      )}
                    </pre>
                  ) : null}
                  {preview.sqliteBlocks.map((block, index) => (
                    <pre
                      key={index}
                      className={
                        "builderMono builderPreviewPre" +
                        (block.kind === "queries"
                          ? " builderPreviewPreBlue"
                          : block.kind === "spaces"
                            ? " builderPreviewPreBlueGreen"
                            : block.kind === "entities"
                              ? " builderPreviewPreGreen"
                              : "")
                      }
                    >
                      {block.text}
                    </pre>
                  ))}
                </div>
              ) : (
                <pre className="builderMono builderPreviewPre">(none)</pre>
              )}
            </div>
            <div className="builderPreviewBlock">
              <label className="builderField">CRUD package</label>
              <pre className="builderMono builderPreviewPre">{preview.crudJson}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
