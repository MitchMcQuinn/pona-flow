import type { RolePermissions } from "../../services/api";
import type { SequenceSummary } from "../../state/types";

export const OPERATIONS = ["create", "read", "update", "delete"] as const;
export const ELEMENTS = ["STEP", "SCHEMA", "INSTANCE"] as const;

export function emptyPermissions(): RolePermissions {
  return { flows: [], sequences: { all: false, ids: [] }, manageSpace: false };
}

function flowKey(op: string, el: string): string {
  return `${op}:${el}`;
}

interface PermissionMatrixProps {
  value: RolePermissions;
  sequences: SequenceSummary[];
  disabled?: boolean;
  onChange: (next: RolePermissions) => void;
}

/**
 * Editor for a permission object: the 12-cell flow matrix (operation x element), the
 * manage-space capability, and which sequences may be run. Shared by the role editor and
 * the per-member override editor.
 */
export function PermissionMatrix({ value, sequences, disabled, onChange }: PermissionMatrixProps) {
  const runnableSequences = sequences.filter((s) => s.kind === "sequence");

  function toggleFlow(op: string, el: string) {
    const key = flowKey(op, el);
    const has = value.flows.includes(key);
    const flows = has ? value.flows.filter((f) => f !== key) : [...value.flows, key];
    onChange({ ...value, flows });
  }

  function toggleSequenceAll() {
    onChange({ ...value, sequences: { ...value.sequences, all: !value.sequences.all } });
  }

  function toggleSequence(id: string) {
    const has = value.sequences.ids.includes(id);
    const ids = has
      ? value.sequences.ids.filter((s) => s !== id)
      : [...value.sequences.ids, id];
    onChange({ ...value, sequences: { ...value.sequences, ids } });
  }

  return (
    <div className="rbacMatrix">
      <h4>Flows</h4>
      <table className="rbacFlowTable">
        <thead>
          <tr>
            <th />
            {ELEMENTS.map((el) => (
              <th key={el}>{el}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {OPERATIONS.map((op) => (
            <tr key={op}>
              <th>{op}</th>
              {ELEMENTS.map((el) => (
                <td key={el}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={value.flows.includes(flowKey(op, el))}
                    onChange={() => toggleFlow(op, el)}
                    aria-label={`${op} ${el}`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <label className="rbacCheckRow">
        <input
          type="checkbox"
          disabled={disabled}
          checked={value.manageSpace}
          onChange={() => onChange({ ...value, manageSpace: !value.manageSpace })}
        />
        Manage space (settings, events, members & roles)
      </label>

      <h4>Sequences</h4>
      <label className="rbacCheckRow">
        <input
          type="checkbox"
          disabled={disabled}
          checked={value.sequences.all}
          onChange={toggleSequenceAll}
        />
        Run all sequences
      </label>
      {!value.sequences.all ? (
        <div className="rbacSequenceList">
          {runnableSequences.length === 0 ? (
            <p className="muted">No sequences in this space yet.</p>
          ) : (
            runnableSequences.map((s) => (
              <label key={s.id} className="rbacCheckRow">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={value.sequences.ids.includes(s.id)}
                  onChange={() => toggleSequence(s.id)}
                />
                {s.label}
              </label>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
