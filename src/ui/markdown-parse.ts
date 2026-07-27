/**
 * The markdown parser.
 *
 * Deliberately separate from the renderer in `markdown.tsx`, and with zero
 * imports. `markdown.tsx` transitively pulls in `react-native`, which ships
 * Flow-annotated source that the test runner's parser refuses — so a parser
 * living beside the components is a parser that cannot be tested. Since this is
 * the piece most likely to be subtly wrong, and the piece hardest to check by
 * looking at the screen, that trade is backwards.
 *
 * Language models emit markdown. Rendering it as plain text — which is what
 * this app did before — puts literal `**asterisks**`, `# hashes` and unstyled
 * ``` fences in front of the user, and nothing destroys the credibility of an
 * assistant faster.
 *
 * Written by hand rather than pulled from a package because a *streaming*
 * renderer has requirements a general CommonMark parser does not:
 *
 *   - An unterminated ``` fence must render as a *code block in progress*, not
 *     swallow the rest of the response. Half a fenced block is the normal state
 *     of a streaming reply, not an error.
 *   - Parsing runs on every flush of the token buffer, so it has to be a single
 *     linear pass with no backtracking.
 *
 * Scope is what models actually produce: ATX headings, fenced and inline code,
 * bullet and ordered lists with one level of nesting, blockquotes, pipe tables,
 * thematic breaks, and bold/italic/link spans. No reference links, no raw HTML,
 * no footnotes.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export interface ListItem {
  spans: Span[];
  /** 0 for top level, 1 for one indent. Deeper nesting is clamped to 1. */
  depth: number;
  /** The rendered bullet or number. */
  marker: string;
}

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'code'; language: string | null; text: string; closed: boolean }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] };

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * One pass of the inline grammar.
 *
 * Alternation order *is* the precedence: code spans win outright so their
 * contents are never re-interpreted, links come next so a bracketed label
 * containing an asterisk stays intact, then strong, then emphasis. Emphasis
 * excludes its own delimiter and newlines from the inner match, which is what
 * stops a single stray `*` in prose from italicising the remainder of a
 * paragraph — and the lookarounds on `_` are what keep `some_long_name` intact.
 */
const INLINE =
  /(`+)([\s\S]*?)\1|\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/;

export function parseInline(input: string): Span[] {
  const spans: Span[] = [];
  let rest = input;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      spans.push({ text: rest });
      break;
    }

    if (match.index > 0) {
      spans.push({ text: rest.slice(0, match.index) });
    }

    const [, , codeText, linkLabel, linkHref, strongA, strongB, emA, emB] = match;

    if (codeText !== undefined) {
      // Backtick-delimited spans are literal. A single leading and trailing
      // space is stripped, which is how CommonMark lets you write `` ` ``.
      spans.push({ text: codeText.replace(/^ (.*) $/, '$1'), code: true });
    } else if (linkHref !== undefined) {
      spans.push({ text: linkLabel || linkHref, href: linkHref });
    } else if (strongA !== undefined || strongB !== undefined) {
      for (const span of parseInline(strongA ?? strongB)) {
        spans.push({ ...span, bold: true });
      }
    } else if (emA !== undefined || emB !== undefined) {
      for (const span of parseInline(emA ?? emB)) {
        spans.push({ ...span, italic: true });
      }
    }

    rest = rest.slice(match.index + match[0].length);
  }

  return spans.filter((span) => span.text.length > 0);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const FENCE = /^\s*```\s*([A-Za-z0-9+#._-]*)\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Turns a markdown string into blocks.
 *
 * Runs on every streaming flush, so it is a single forward pass: each line is
 * examined once and either opens a block, extends the open one, or closes it.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: ListItem[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push({ kind: 'quote', spans: parseInline(quote.join('\n')) });
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ kind: 'list', items: list });
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const language = fence[1] || null;
      const body: string[] = [];
      let closed = false;
      i++;
      for (; i < lines.length; i++) {
        if (/^\s*```/.test(lines[i])) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      // An unclosed fence is the normal mid-stream state, so it still produces
      // a block. Dropping it would make the answer appear to vanish and come
      // back as the closing fence arrives.
      blocks.push({ kind: 'code', language, text: body.join('\n'), closed });
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      // Models reach for `####` freely; rendering six distinct sizes in a chat
      // transcript is noise, so anything past three collapses to the third.
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, spans: parseInline(heading[2]) });
      continue;
    }

    // A table needs its divider to be recognised, so it is detected by looking
    // one line ahead rather than by state.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      flushAll();
      const header = splitRow(line).map(parseInline);
      const rows: Span[][][] = [];
      i += 2;
      for (; i < lines.length && lines[i].includes('|'); i++) {
        rows.push(splitRow(lines[i]).map(parseInline));
      }
      i--;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const quoteMatch = QUOTE.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const indent = (bullet ?? ordered!)[1].length;
      const depth = indent >= 2 ? 1 : 0;
      const content = bullet ? bullet[2] : ordered![3];
      const marker = bullet ? '•' : `${ordered![2]}.`;
      list ??= [];
      list.push({ spans: parseInline(content), depth, marker });
      continue;
    }

    // An indented plain line directly under a list item is that item's
    // continuation, not a new paragraph — models wrap long bullets constantly.
    if (list && /^\s+\S/.test(line)) {
      const last = list[list.length - 1];
      last.spans = [...last.spans, { text: ' ' }, ...parseInline(line.trim())];
      continue;
    }

    flushQuote();
    flushList();
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}
