import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import { useDebouncedCheck } from "../hooks/useDebouncedCheck";

interface GraphIdFieldProps {
  checkKey: string;
  idValue: string;
  onChange: (value: string) => void;
}

export function GraphIdField({ checkKey, idValue, onChange }: GraphIdFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";

  useDebouncedCheck(
    checkKey,
    Boolean(spaceId && idValue.trim()),
    `${spaceId}|${idValue}`,
    async () => {
      const exists = await connector.checkGraphIdExists({ spaceId, id: idValue.trim() });
      return exists
        ? { status: "duplicate", message: "id already exists in graph" }
        : { status: "ok", message: "available" };
    }
  );

  const check = state.checks[checkKey];

  async function generate() {
    const id = await connector.generateQueryId();
    onChange(id);
  }

  return (
    <div className="builderField">
      <label>graph id (required for create)</label>
      <div className="builderInputWithAction">
        <input className="builderMono" value={idValue} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="builderTinyBtn" onClick={generate}>
          Generate
        </button>
      </div>
      {check && check.status !== "idle" ? (
        <span className={`builderCheckMsg ${check.status}`}>
          {check.status === "checking" ? "checking…" : check.message}
        </span>
      ) : null}
    </div>
  );
}
