import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface PickerOption {
  value: string;
  label: string;
}

// Once a data-driven dropdown grows beyond this many options we surface an inline
// search box so users can filter graph/SQLite results in real time.
const SEARCH_FILTER_THRESHOLD = 7;
const MENU_MAX_HEIGHT = 260;
const MENU_GAP = 4;

export interface PickerCreateAction {
  label: string;
  onClick: () => void;
}

interface PickerProps {
  value: string;
  placeholder: string;
  options: PickerOption[];
  onSelect: (value: string) => void;
  createLabel?: string;
  onCreate?: () => void;
  /** Additional create-style actions rendered above the option list. */
  createActions?: PickerCreateAction[];
  disabled?: boolean;
  title?: string;
  emptyHint?: string;
}

// Slick toggle/menu picker mirroring the legacy paramPicker (toggle button +
// dropdown with an optional create action and a selectable list).
export function Picker({
  value,
  placeholder,
  options,
  onSelect,
  createLabel,
  onCreate,
  createActions,
  disabled = false,
  title,
  emptyHint
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!open) return;

    function positionMenu() {
      const toggle = toggleRef.current;
      if (!toggle) return;
      const rect = toggle.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP;
      const spaceAbove = rect.top - MENU_GAP;
      const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(80, Math.min(MENU_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow));

      setMenuStyle({
        position: "fixed",
        left: rect.left,
        width: rect.width,
        maxHeight,
        zIndex: 1000,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + MENU_GAP }
          : { top: rect.bottom + MENU_GAP })
      });
    }

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Reset the filter whenever the menu closes so it reopens clean, and focus the
  // search box when it opens.
  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const display = selected ? selected.label : value || placeholder;
  const isPlaceholder = !value;

  const showSearch = options.length > SEARCH_FILTER_THRESHOLD;
  const filteredOptions = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return options;
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(term) || opt.value.toLowerCase().includes(term)
    );
  }, [options, search]);

  const actions: PickerCreateAction[] = [
    ...(createLabel && onCreate ? [{ label: createLabel, onClick: onCreate }] : []),
    ...(createActions ?? [])
  ];

  const menu = open ? (
    <div
      ref={menuRef}
      className="builderPickerMenu builderPickerMenuFloating"
      data-testid="builder-picker-menu"
      style={menuStyle}
    >
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
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="builderPickerCreate"
          onClick={() => {
            setOpen(false);
            action.onClick();
          }}
        >
          {action.label}
        </button>
      ))}
      <ul className="builderPickerList">
        {filteredOptions.map((opt) => (
          <li key={opt.value}>
            <button
              type="button"
              className={"builderPickerItem" + (opt.value === value ? " is-selected" : "")}
              onClick={() => {
                setOpen(false);
                onSelect(opt.value);
              }}
            >
              {opt.label}
            </button>
          </li>
        ))}
        {filteredOptions.length === 0 && (options.length > 0 || emptyHint) ? (
          <li className="builderPickerEmpty">
            {options.length === 0 ? emptyHint : "No matches."}
          </li>
        ) : null}
      </ul>
    </div>
  ) : null;

  return (
    <div className="builderPicker" ref={rootRef}>
      <button
        ref={toggleRef}
        type="button"
        className="builderPickerToggle"
        data-testid="builder-picker-toggle"
        disabled={disabled}
        title={title}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
      >
        <span className={isPlaceholder ? "builderPickerPlaceholder" : ""}>{display}</span>
        <span className="builderPickerCaret" aria-hidden>
          ▾
        </span>
      </button>

      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
