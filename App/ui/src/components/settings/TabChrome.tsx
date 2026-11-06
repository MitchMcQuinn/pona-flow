import { useEffect, useState, type FormEvent } from "react";
import { fetchInstanceBranding, saveInstanceBranding } from "../../services/api";
import { applyInstanceIcon, applyInstanceTitle } from "../../services/tabChrome";

export function TabChromeSettings() {
  const [appName, setAppName] = useState("");
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState("");
  const [previewKey, setPreviewKey] = useState("0");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInstanceBranding()
      .then((chrome) => {
        if (cancelled) return;
        setAppName(chrome.app_name);
        setLabel(chrome.icon_label);
        setSaved(chrome.icon_label);
        applyInstanceTitle(chrome.app_name);
        applyInstanceIcon(chrome.icon_label);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "failed to load the tab icon");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const chrome = await saveInstanceBranding(label.trim());
      const cacheKey = String(Date.now());
      setLabel(chrome.icon_label);
      setSaved(chrome.icon_label);
      setAppName(chrome.app_name);
      setPreviewKey(cacheKey);
      applyInstanceTitle(chrome.app_name);
      applyInstanceIcon(chrome.icon_label, cacheKey);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "failed to save the tab icon");
    } finally {
      setSaving(false);
    }
  }

  const title = appName.trim() || "pona flow";
  const src = `/favicon.svg?v=${encodeURIComponent(`${previewKey}:${saved}`)}`;

  return (
    <form className="spaceResetCard" onSubmit={save}>
      <h3>browser tab</h3>
      <p className="muted">the tab title is the app name.</p>
      <p className="tabChromeTitle" data-testid="tab-chrome-title">
        {loading ? "…" : title}
      </p>
      {error ? <p className="builderCheckMsg error">{error}</p> : null}
      <div className="tabChromeRow">
        <img className="tabChromePreview" alt="" src={src} />
        <div className="builderField">
          <label htmlFor="tab-icon-label">label</label>
          <input
            id="tab-icon-label"
            data-testid="tab-icon-label"
            value={label}
            maxLength={8}
            autoComplete="off"
            disabled={loading || saving}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
      </div>
      <p className="muted">
        up to 8 characters. saving a label draws it in the rainbow instead of the wave.
      </p>
      <button
        type="submit"
        className="btnPrimary"
        data-testid="tab-icon-save"
        disabled={loading || saving || label.trim() === saved}
      >
        {saving ? "saving..." : "save"}
      </button>
    </form>
  );
}
