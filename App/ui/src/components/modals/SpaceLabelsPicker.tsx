import { useEffect, useMemo, useRef, useState } from "react";
import "../builder/builder.css";

const SEARCH_FILTER_THRESHOLD = 7;

interface SpaceLabelsPickerProps {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  loading?: boolean;
}

export function SpaceLabelsPicker({
  options,
  selected,
  onChange,
  disabled = false,
  loading = false
}: SpaceLabelsPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  const showSearch = options.length > SEARCH_FILTER_THRESHOLD;
  const filteredOptions = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return options;
    return options.filter((label) => label.toLowerCase().includes(term));
  }, [options, search]);

  function toggle(label: string) {
    if (selectedSet.has(label)) {
      onChange(selected.filter((entry) => entry !== label));
      return;
    }
    onChange([...selected, label].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  }

  const display = loading
    ? "Loading shared sequences…"
    : selected.length
      ? `${selected.length} shared sequence${selected.length === 1 ? "" : "s"} selected`
      : "(select shared sequences)";
  const isPlaceholder = !loading && selected.length === 0;

  return (
    <div className="builderPicker" ref={rootRef}>
      <button
        type="button"
        className="builderPickerToggle"
        disabled={disabled || loading}
        onClick={() => {
          if (!disabled && !loading) setOpen((value) => !value);
        }}
      >
        <span className={isPlaceholder ? "builderPickerPlaceholder" : ""}>{display}</span>
        <span className="builderPickerCaret" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div className="builderPickerMenu">
          {showSearch ? (
            <div className="builderPickerSearch">
              <input
                ref={searchRef}
                type="text"
                className="builderPickerSearchInput"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
            </div>
          ) : null}
          <ul className="builderPickerList">
            {filteredOptions.map((label) => (
              <li key={label}>
                <label
                  className={
                    "builderPickerItem" + (selectedSet.has(label) ? " is-selected" : "")
                  }
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={selectedSet.has(label)}
                    onChange={() => toggle(label)}
                  />
                  <span>{label}</span>
                </label>
              </li>
            ))}
            {!loading && filteredOptions.length === 0 ? (
              <li className="builderPickerEmpty">No shared sequences yet.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
