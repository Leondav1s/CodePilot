/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, bold, italic, links, inline code properly.
 * Markdown tables are upgraded to native Feishu table components.
 */
export function buildCardContent(text: string): string {
  const elements = buildCardElements(text);
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements,
    },
  });
}

type TableAlign = 'left' | 'center' | 'right';

interface ParsedTable {
  headers: string[];
  aligns: TableAlign[];
  rows: string[][];
}

function splitMarkdownRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;

  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  cells.push(current.trim());
  return cells;
}

function parseSeparatorAlign(cell: string): TableAlign {
  const trimmed = cell.trim();
  const starts = trimmed.startsWith(':');
  const ends = trimmed.endsWith(':');
  if (starts && ends) return 'center';
  if (ends) return 'right';
  return 'left';
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|');
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(trimmed);
}

function normalizeRowWidth(row: string[], width: number): string[] {
  if (row.length >= width) return row.slice(0, width);
  return [...row, ...Array.from({ length: width - row.length }, () => '')];
}

function parseMarkdownTable(blockLines: string[]): ParsedTable | null {
  if (blockLines.length < 2) return null;
  const headers = splitMarkdownRow(blockLines[0]);
  const separator = splitMarkdownRow(blockLines[1]);
  if (headers.length === 0 || headers.length !== separator.length) return null;

  const aligns = separator.map(parseSeparatorAlign);
  const rows = blockLines
    .slice(2)
    .map((line) => normalizeRowWidth(splitMarkdownRow(line), headers.length));

  return {
    headers: normalizeRowWidth(headers, headers.length),
    aligns: normalizeRowWidth(aligns, headers.length) as TableAlign[],
    rows,
  };
}

function buildTableElement(table: ParsedTable, index: number): Record<string, unknown> {
  const columns = table.headers.map((header, colIndex) => ({
    name: `col_${index}_${colIndex}`,
    display_name: header || `列${colIndex + 1}`,
    data_type: 'lark_md',
    horizontal_align: table.aligns[colIndex] || 'left',
    vertical_align: 'top',
  }));

  const rows = table.rows.map((row) =>
    Object.fromEntries(
      columns.map((column, colIndex) => [column.name, row[colIndex] || ''])
    )
  );

  return {
    tag: 'table',
    page_size: Math.min(Math.max(rows.length, 1), 10),
    columns,
    rows,
  };
}

function buildMarkdownElement(text: string): Record<string, unknown> | null {
  const content = text.trim();
  if (!content) return null;
  return {
    tag: 'markdown',
    content,
  };
}

function buildCardElements(text: string): Record<string, unknown>[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const elements: Record<string, unknown>[] = [];
  const markdownBuffer: string[] = [];
  let inCodeBlock = false;
  let tableIndex = 0;

  const flushMarkdown = () => {
    const element = buildMarkdownElement(markdownBuffer.join('\n'));
    markdownBuffer.length = 0;
    if (element) {
      elements.push(element);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      markdownBuffer.push(line);
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (
      !inCodeBlock &&
      i + 1 < lines.length &&
      isMarkdownTableRow(line) &&
      isMarkdownTableSeparator(lines[i + 1])
    ) {
      const blockLines: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isMarkdownTableRow(lines[j])) {
        blockLines.push(lines[j]);
        j += 1;
      }

      const parsed = parseMarkdownTable(blockLines);
      if (parsed) {
        flushMarkdown();
        elements.push(buildTableElement(parsed, tableIndex));
        tableIndex += 1;
        i = j - 1;
        continue;
      }
    }

    markdownBuffer.push(line);
  }

  flushMarkdown();

  if (elements.length === 0) {
    const fallback = buildMarkdownElement(normalized);
    return fallback ? [fallback] : [{ tag: 'markdown', content: ' ' }];
  }

  return elements;
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
