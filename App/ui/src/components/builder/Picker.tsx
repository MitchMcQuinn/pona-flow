import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { TouchHint } from "./TouchHint";

export interface PickerOption {
  value: string;
  label: string;
}

// Once a data-driven dropdown grows beyond this many options we surface an inline
// search box so users can filter graph/SQLite results in real time.
const SEARCH_FILTER_THRESHOLD = 7;
const MENU_MAX_HEIGHT = 260;
const MENU_GAP = 6;
const VIEWPORT_PAD = 12;
const CONTENT_MENU_MIN = 220;
const CONTENT_MENU_MAX = 420;

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
  id?: string;
  ariaLabel?: string;
  className?: string;
  toggleClassName?: string;
  /** Left is the field default; title controls put the caret after the label. */
  caret?: "start" | "end";
  /** stretch matches the toggle; content hugs the longest option (space selector). */
  menuFit?: "stretch" | "content";
  toggleTestId?: string;
  menuTestId?: string;
  dataTour?: string;
}

function sameMenuStyle(a: CSSProperties, b: CSSProperties): boolean {
  return (
    a.left === b.left &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight &&
    a.top === b.top &&
    a.bottom === b.bottom
  );
}

function positionFloatingMenu(
  toggle: HTMLElement,
  menu: HTMLElement | null,
  menuFit: "stretch" | "content"
): CSSProperties {
  const rect = toggle.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const measured = menu?.scrollWidth ?? rect.width;
  const preferred =
    menuFit === "content"
      ? Math.min(CONTENT_MENU_MAX, Math.max(CONTENT_MENU_MIN, rect.width, measured))
      : rect.width;
  const width = Math.max(80, Math.min(preferred, vw - VIEWPORT_PAD * 2));

  let left = rect.left;
  if (left + width > vw - VIEWPORT_PAD) left = vw - VIEWPORT_PAD - width;
  if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;

  const menuHeight = menu?.offsetHeight ?? 160;
  const spaceBelow = vh - rect.bottom - MENU_GAP - VIEWPORT_PAD;
  const spaceAbove = rect.top - MENU_GAP - VIEWPORT_PAD;
  const openUp = spaceBelow < Math.min(menuHeight, 140) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(80, Math.min(MENU_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow));

  return {
    position: "fixed",
    left,
    width,
    maxHeight,
    zIndex: 1100,
    ...(openUp
      ? { bottom: vh - rect.top + MENU_GAP, top: "auto" }
      : { top: rect.bottom + MENU_GAP, bottom: "auto" })
  };
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
  emptyHint,
  id,
  ariaLabel,
  className,
  toggleClassName,
  caret = "start",
  menuFit = "stretch",
  toggleTestId = "builder-picker-toggle",
  menuTestId = "builder-picker-menu",
  dataTour
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
      const next = positionFloatingMenu(toggle, menuRef.current, menuFit);
      setMenuStyle((prev) => (sameMenuStyle(prev, next) ? prev : next));
    }

    positionMenu();
    const raf = requestAnimationFrame(positionMenu);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, menuFit, options, search]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
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

  const caretMark = (
    <span className="builderPickerCaret" aria-hidden>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3.2 6.1 8 11 12.8 6.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );

  const menu = open ? (
    <div
      ref={menuRef}
      className={`builderPickerMenu builderPickerMenuFloating${menuFit === "content" ? " builderPickerMenuHug" : ""}`}
      data-testid={menuTestId}
      role="listbox"
      aria-label={ariaLabel || title}
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
              role="option"
              aria-selected={opt.value === value}
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

  const rootClass = ["builderPicker", className].filter(Boolean).join(" ");
  const buttonClass = [
    "builderPickerToggle",
    caret === "end" ? "caretEnd" : "",
    toggleClassName
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass} ref={rootRef}>
      <button
        ref={toggleRef}
        id={id}
        type="button"
        className={buttonClass}
        data-testid={toggleTestId}
        data-tour={dataTour}
        disabled={disabled}
        title={title}
        value={value}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
      >
        {caret === "start" ? caretMark : null}
        <span className={isPlaceholder ? "builderPickerPlaceholder" : ""}>{display}</span>
        {caret === "end" ? caretMark : null}
      </button>

      <TouchHint text={title} />
      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
