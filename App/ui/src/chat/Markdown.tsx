import { Fragment, type ReactNode } from "react";

/** Agent prose: headings, lists, emphasis, code, and links. Text is never inserted as HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;
  return <div className="markdown">{blocks}</div>;
}

function parseBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = headingTag(heading[1].length);
      nodes.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      index += 1;
      continue;
    }
    if (line.trim() === "---") {
      nodes.push(<hr key={key++} />);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*]\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ul key={key++}>
          {items.map((item, itemKey) => (
            <li key={itemKey}>{inline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ol key={key++}>
          {items.map((item, itemKey) => (
            <li key={itemKey}>{inline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      nodes.push(<blockquote key={key++}>{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && isParagraphLine(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    nodes.push(
      <p key={key++}>
        {paragraph.map((part, partKey) => (
          <Fragment key={partKey}>
            {partKey > 0 ? <br /> : null}
            {inline(part)}
          </Fragment>
        ))}
      </p>
    );
  }
  return nodes;
}

function headingTag(level: number): "h2" | "h3" | "h4" {
  if (level <= 1) return "h2";
  if (level === 2) return "h3";
  return "h4";
}

function isParagraphLine(line: string): boolean {
  return (
    line.trim() !== "" &&
    !line.startsWith("```") &&
    !/^(#{1,3})\s+/.test(line) &&
    !/^[-*]\s+/.test(line) &&
    !/^\d+\.\s+/.test(line) &&
    !line.startsWith(">") &&
    line.trim() !== "---"
  );
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    if (token.startsWith("`")) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      if (link && href) {
        nodes.push(
          <a key={key++} href={href} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    last = at + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  return null;
}
