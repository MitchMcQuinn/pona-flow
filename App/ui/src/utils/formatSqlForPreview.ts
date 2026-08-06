/** Pretty-print composer SQLite for the builder live preview (display only). */

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'") {
      if (inString && input[i + 1] === "'") {
        buf += "''";
        i++;
        continue;
      }
      inString = !inString;
      buf += ch;
      continue;
    }
    if (!inString) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}

function formatCommaList(items: string[], indent: string): string[] {
  return items.map((item, index) => {
    const trimmed = item.trim();
    const comma = index < items.length - 1 ? "," : "";
    return `${indent}${trimmed}${comma}`;
  });
}

function formatOnConflictClause(clause: string): string {
  const match = clause.match(/^ON CONFLICT\(id\) DO UPDATE SET\s+(.+?)\s*;?$/is);
  if (!match) return clause.trim();
  const assignments = splitTopLevelCommas(match[1]);
  return [
    "ON CONFLICT(id) DO UPDATE SET",
    ...formatCommaList(assignments, "  ")
  ].join("\n");
}

function formatInsertStatement(sql: string): string | null {
  const match = sql.match(/^INSERT INTO (\S+)\s*\((.+)\)\s*VALUES\s*\((.+)\)\s*;?$/is);
  if (!match) return null;
  const columns = splitTopLevelCommas(match[2]);
  const values = splitTopLevelCommas(match[3]);
  return [
    `INSERT INTO ${match[1]} (`,
    ...formatCommaList(columns, "  "),
    ") VALUES (",
    ...formatCommaList(values, "  "),
    ")"
  ].join("\n");
}

function formatUpdateStatement(sql: string): string | null {
  const match = sql.match(/^UPDATE (\S+)\s+SET\s+(.+?)\s+WHERE\s+(.+?)\s*;?$/is);
  if (!match) return null;
  const assignments = splitTopLevelCommas(match[2]);
  return [
    `UPDATE ${match[1]} SET`,
    ...formatCommaList(assignments, "  "),
    `WHERE ${match[3].trim()}`
  ].join("\n");
}

function formatDeleteStatement(sql: string): string | null {
  const match = sql.match(/^DELETE FROM (\S+)\s+WHERE\s+(.+?)\s*;?$/is);
  if (!match) return null;
  return [`DELETE FROM ${match[1]}`, `WHERE ${match[2].trim()}`].join("\n");
}

function ensureSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

export function formatSqlForPreview(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, " ");
  if (!normalized) return sql;

  const onConflictIdx = normalized.search(/ ON CONFLICT\(/i);
  let main = normalized;
  let onConflict = "";
  if (onConflictIdx >= 0) {
    main = normalized.slice(0, onConflictIdx).trim();
    onConflict = normalized.slice(onConflictIdx + 1).trim();
  }

  const formattedMain =
    formatInsertStatement(main) ??
    formatUpdateStatement(main) ??
    formatDeleteStatement(main) ??
    main;

  let result = formattedMain;
  if (onConflict) {
    result += `\n${formatOnConflictClause(onConflict)}`;
  }
  return ensureSemicolon(result);
}

/** Format SQL in a preview block that may start with a `--` comment line. */
export function formatPreviewSqlBlock(text: string): string {
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx < 0) return formatSqlForPreview(text);
  const header = text.slice(0, newlineIdx + 1);
  const sql = text.slice(newlineIdx + 1);
  return header + formatSqlForPreview(sql);
}
