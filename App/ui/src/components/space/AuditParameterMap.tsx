function formatAuditParam(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function AuditParameterMap({ map }: { map: Record<string, unknown> | null }) {
  const entries = map
    ? Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
    : [];
  return (
    <div className="auditParamMap" data-testid="audit-parameter-map">
      <span className="auditParamMapLabel">parameter map</span>
      {entries.length === 0 ? (
        <span className="muted">—</span>
      ) : (
        <dl>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{formatAuditParam(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
