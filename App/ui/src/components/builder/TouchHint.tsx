/**
 * Touch screens never show `title=` tooltips, so where a tooltip carries real meaning
 * (why a field is locked, what a mode does) this renders the same text inline. Hidden on
 * devices that can hover, where the tooltip still works.
 */
export function TouchHint({ text }: { text?: string | null }) {
  if (!text) return null;
  return <span className="builderHint builderHintTouchOnly">{text}</span>;
}
