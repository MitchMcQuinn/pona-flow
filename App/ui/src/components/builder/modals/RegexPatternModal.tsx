import { useEffect, useState } from "react";
import regexValidator from "../../../services/regexValidator";
import { useBuilder } from "../../../state/builder/BuilderContext";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface RegexRow {
  name: string;
  regex: string | null;
}

interface RegexPatternModalProps {
  onClose: () => void;
}

export function RegexPatternModal({ onClose }: RegexPatternModalProps) {
  const { dispatch } = useBuilder();
  const [rows, setRows] = useState<RegexRow[]>([]);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function refresh() {
    fetch("/api/regex")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load patterns (${res.status})`);
        return (await res.json()) as { patterns?: RegexRow[] };
      })
      .then((data) => {
        const next = (data.patterns || []).map((r) => ({
          name: String(r.name || ""),
          regex: r.regex
        }));
        setRows(next);
        regexValidator.setPatterns(next);
        dispatch({ type: "SET_REGEX_PATTERNS", patterns: next });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load patterns");
      });
  }

  useEffect(refresh, []);

  async function save() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    try {
      new RegExp(pattern);
    } catch (e) {
      setError(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/regex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), regex: pattern })
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(data.error || data.detail || `Save failed (${res.status})`);
      }
      setName("");
      setPattern("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalBackdrop onClick={onClose}>
      <div className="builderModalPanel" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Regex patterns</h3>

        <div className="builderField">
          <label>existing patterns</label>
          <select size={6} style={{ width: "100%" }}>
            {rows.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} — {r.regex}
              </option>
            ))}
          </select>
        </div>

        <div className="builderRow">
          <div className="builderField">
            <label>name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="builderField">
            <label>pattern</label>
            <input className="builderMono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </div>
        </div>

        {error ? <p className="builderCheckMsg error">{error}</p> : null}

        <div className="builderModalActions">
          <button type="button" className="builderTinyBtn" onClick={onClose}>
            Close
          </button>
          <button type="button" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Add pattern"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
