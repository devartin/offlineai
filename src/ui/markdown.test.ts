/**
 * Tests for the markdown parser.
 *
 * This is the one piece of the redesign that cannot be checked by looking at
 * the screen, because reaching it needs a loaded model. It is also the piece
 * most likely to be subtly wrong: the inline grammar has seven alternatives
 * whose precedence decides whether a stray asterisk in prose italicises the
 * rest of a paragraph, and the block scanner has to treat a half-arrived code
 * fence as valid rather than as an error.
 *
 * The streaming cases matter most. Everything a model emits arrives a token at
 * a time, so every intermediate prefix of a response is a string this parser
 * will be handed — and a prefix that parses to nothing makes the answer appear
 * to vanish and come back.
 */

import { describe, expect, it } from 'vitest';
// Imported from the parser module rather than from `markdown.tsx`: that file
// pulls in `react-native`, whose Flow-annotated source the test runner cannot
// parse. The split is what makes this suite possible at all.
import { parseMarkdown, type Block, type Span } from './markdown-parse';

/** Flattens a block's spans back to text, for assertions about structure. */
function textOf(block: Block): string {
  if ('spans' in block) return block.spans.map((span) => span.text).join('');
  if (block.kind === 'code') return block.text;
  return '';
}

function spansOf(source: string): Span[] {
  const [block] = parseMarkdown(source);
  if (!block || !('spans' in block)) throw new Error('expected a block with spans');
  return block.spans;
}

describe('paragraphs and inline spans', () => {
  it('parses a plain paragraph', () => {
    const blocks = parseMarkdown('Hello there.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(textOf(blocks[0])).toBe('Hello there.');
  });

  it('splits paragraphs on a blank line', () => {
    const blocks = parseMarkdown('First.\n\nSecond.');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
    expect(textOf(blocks[1])).toBe('Second.');
  });

  it('marks bold, italic and code spans', () => {
    const spans = spansOf('plain **bold** and *italic* and `code`');
    expect(spans.find((s) => s.text === 'bold')?.bold).toBe(true);
    expect(spans.find((s) => s.text === 'italic')?.italic).toBe(true);
    expect(spans.find((s) => s.text === 'code')?.code).toBe(true);
  });

  it('nests emphasis inside strong', () => {
    const spans = spansOf('**bold with *stress* inside**');
    const stressed = spans.find((s) => s.text === 'stress');
    expect(stressed?.bold).toBe(true);
    expect(stressed?.italic).toBe(true);
  });

  it('extracts links', () => {
    const spans = spansOf('see [the docs](https://example.com/a) now');
    const link = spans.find((s) => s.href);
    expect(link?.href).toBe('https://example.com/a');
    expect(link?.text).toBe('the docs');
  });

  it('does not re-interpret markdown inside a code span', () => {
    const spans = spansOf('use `**not bold**` here');
    const code = spans.find((s) => s.code);
    expect(code?.text).toBe('**not bold**');
    expect(spans.some((s) => s.bold)).toBe(false);
  });

  it('leaves a lone asterisk alone', () => {
    // The failure this guards against: a single `*` in prose italicising every
    // word after it, which is what a greedy emphasis rule does.
    const spans = spansOf('2 * 3 is six and the rest is plain');
    expect(spans.some((s) => s.italic)).toBe(false);
    expect(spans.map((s) => s.text).join('')).toBe('2 * 3 is six and the rest is plain');
  });

  it('leaves underscores inside identifiers alone', () => {
    const spans = spansOf('call some_long_name now');
    expect(spans.some((s) => s.italic)).toBe(false);
    expect(spans.map((s) => s.text).join('')).toBe('call some_long_name now');
  });
});

describe('headings', () => {
  it('parses the three rendered levels', () => {
    const blocks = parseMarkdown('# One\n\n## Two\n\n### Three');
    expect(blocks.map((b) => b.kind === 'heading' && b.level)).toEqual([1, 2, 3]);
  });

  it('clamps deeper headings to level three', () => {
    const [block] = parseMarkdown('##### Deep');
    expect(block.kind === 'heading' && block.level).toBe(3);
    expect(textOf(block)).toBe('Deep');
  });

  it('does not treat a hash without a space as a heading', () => {
    const [block] = parseMarkdown('#hashtag');
    expect(block.kind).toBe('paragraph');
  });
});

describe('code blocks', () => {
  it('captures a fenced block and its language', () => {
    const [block] = parseMarkdown('```ts\nconst a = 1;\n```');
    expect(block.kind).toBe('code');
    expect(block.kind === 'code' && block.language).toBe('ts');
    expect(textOf(block)).toBe('const a = 1;');
    expect(block.kind === 'code' && block.closed).toBe(true);
  });

  it('keeps an unterminated fence as a block in progress', () => {
    // The normal mid-stream state. Dropping it would make the answer flicker
    // out and back as the closing fence arrives.
    const [block] = parseMarkdown('```python\nprint("hi")');
    expect(block.kind).toBe('code');
    expect(block.kind === 'code' && block.closed).toBe(false);
    expect(textOf(block)).toBe('print("hi")');
  });

  it('does not interpret markdown inside a fence', () => {
    const [block] = parseMarkdown('```\n# not a heading\n- not a list\n```');
    expect(block.kind).toBe('code');
    expect(textOf(block)).toBe('# not a heading\n- not a list');
  });

  it('reports no language when the fence is bare', () => {
    const [block] = parseMarkdown('```\nx\n```');
    expect(block.kind === 'code' && block.language).toBeNull();
  });
});

describe('lists', () => {
  it('parses a bullet list into one block', () => {
    const [block] = parseMarkdown('- one\n- two\n- three');
    expect(block.kind).toBe('list');
    expect(block.kind === 'list' && block.items).toHaveLength(3);
    expect(block.kind === 'list' && block.items[0].marker).toBe('•');
  });

  it('keeps ordered markers as written', () => {
    const [block] = parseMarkdown('1. first\n2. second');
    expect(block.kind === 'list' && block.items.map((i) => i.marker)).toEqual([
      '1.',
      '2.',
    ]);
  });

  it('indents nested items by one level and no further', () => {
    const [block] = parseMarkdown('- top\n  - nested\n      - deeper');
    expect(block.kind === 'list' && block.items.map((i) => i.depth)).toEqual([0, 1, 1]);
  });

  it('folds a wrapped continuation line into the item above it', () => {
    // Models wrap long bullets constantly; treating the wrap as a new paragraph
    // breaks the list in half.
    const blocks = parseMarkdown('- a long item\n  that wrapped\n- second');
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.kind === 'list' && block.items).toHaveLength(2);
    expect(
      block.kind === 'list' && block.items[0].spans.map((s) => s.text).join(''),
    ).toBe('a long item that wrapped');
  });

  it('closes the list when a paragraph follows', () => {
    const blocks = parseMarkdown('- one\n\nAfterwards.');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph']);
  });

  it('applies inline formatting inside items', () => {
    const [block] = parseMarkdown('- **bold** item');
    expect(block.kind === 'list' && block.items[0].spans[0].bold).toBe(true);
  });
});

describe('quotes, rules and tables', () => {
  it('joins consecutive quote lines into one block', () => {
    const blocks = parseMarkdown('> first line\n> second line');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('quote');
    expect(textOf(blocks[0])).toBe('first line\nsecond line');
  });

  it('parses a thematic break', () => {
    const blocks = parseMarkdown('above\n\n---\n\nbelow');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'rule', 'paragraph']);
  });

  it('parses a pipe table with its header', () => {
    const [block] = parseMarkdown(
      '| Name | Size |\n| --- | --- |\n| Qwen3 | 2.3 GB |\n| Gemma | 278 MB |',
    );
    expect(block.kind).toBe('table');
    if (block.kind !== 'table') throw new Error('expected a table');
    expect(block.header.map((cell) => cell[0]?.text)).toEqual(['Name', 'Size']);
    expect(block.rows).toHaveLength(2);
    expect(block.rows[1].map((cell) => cell[0]?.text)).toEqual(['Gemma', '278 MB']);
  });

  it('treats a pipe line with no divider as prose', () => {
    const [block] = parseMarkdown('a | b | c');
    expect(block.kind).toBe('paragraph');
  });

  it('handles alignment markers in the divider', () => {
    const [block] = parseMarkdown('| L | R |\n|:---|---:|\n| 1 | 2 |');
    expect(block.kind).toBe('table');
  });
});

describe('streaming prefixes', () => {
  /**
   * Every prefix of a response is a string this parser will see. None of them
   * may throw, and none may parse to nothing once there is visible text — a
   * prefix that yields zero blocks is a message that disappears mid-answer.
   */
  const RESPONSE = [
    "Here's the breakdown:",
    '',
    '## Costs',
    '',
    '- **Rent** — 1,200/month',
    '- Utilities — around 180',
    '',
    '| Item | Amount |',
    '| --- | --- |',
    '| Rent | 1200 |',
    '',
    '```js',
    'const total = 1380;',
    '```',
    '',
    '> That is 46% of take-home.',
  ].join('\n');

  it('never throws on any prefix', () => {
    for (let i = 1; i <= RESPONSE.length; i++) {
      expect(() => parseMarkdown(RESPONSE.slice(0, i))).not.toThrow();
    }
  });

  it('always yields at least one block once there is visible text', () => {
    for (let i = 1; i <= RESPONSE.length; i++) {
      const prefix = RESPONSE.slice(0, i);
      if (prefix.trim().length === 0) continue;
      expect(parseMarkdown(prefix).length).toBeGreaterThan(0);
    }
  });

  it('parses the finished response into the expected block sequence', () => {
    expect(parseMarkdown(RESPONSE).map((b) => b.kind)).toEqual([
      'paragraph',
      'heading',
      'list',
      'table',
      'code',
      'quote',
    ]);
  });
});

describe('degenerate input', () => {
  it('returns nothing for an empty string', () => {
    expect(parseMarkdown('')).toEqual([]);
  });

  it('returns nothing for whitespace only', () => {
    expect(parseMarkdown('   \n\n  \n')).toEqual([]);
  });

  it('drops empty spans rather than rendering blank text nodes', () => {
    // An empty code span. The parser must not emit a zero-length text node for
    // it, because RN renders those as a stray line-height gap.
    const spans = spansOf('before `` after');
    expect(spans.every((s) => s.text.length > 0)).toBe(true);
    expect(spans.map((s) => s.text).join('')).toBe('before  after');
  });

  it('treats a run of asterisks as a thematic break, not empty emphasis', () => {
    // `****` is a valid rule in CommonMark. Worth pinning: the obvious reading
    // is "empty bold", and getting it wrong would put a stray blank paragraph
    // in the middle of a response.
    expect(parseMarkdown('****').map((b) => b.kind)).toEqual(['rule']);
  });
});
