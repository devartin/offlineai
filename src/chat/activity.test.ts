import { describe, expect, it } from 'vitest';
import {
  anchorSpacerHeight,
  describeTool,
  formatThinkingDuration,
  reasoningTail,
} from './activity';

describe('describeTool', () => {
  it('gives every registered tool a present and past tense label', () => {
    // Exactly the names registered in app-state. If one is renamed there
    // without being renamed here, this is where the transcript's wording
    // silently regressing to the generic fallback gets caught.
    const registered = [
      'compute.evaluate',
      'docs.search',
      'docs.read',
      'memory.remember',
      'memory.recall',
    ];

    for (const name of registered) {
      const presentation = describeTool(name);
      expect(presentation.kind).not.toBe('generic');
      expect(presentation.running).not.toBe(presentation.done);
      expect(presentation.running.length).toBeGreaterThan(0);
      expect(presentation.done.length).toBeGreaterThan(0);
    }
  });

  it('assigns tools to the family their icon is drawn from', () => {
    expect(describeTool('compute.evaluate').kind).toBe('compute');
    expect(describeTool('docs.search').kind).toBe('documents');
    expect(describeTool('docs.read').kind).toBe('documents');
    expect(describeTool('memory.recall').kind).toBe('memory');
  });

  it('derives a readable label for a tool it has never heard of', () => {
    // The registry is open — a tool added later must degrade to something a
    // user can read, not to an error or a raw identifier.
    expect(describeTool('calendar.query')).toEqual({
      running: 'Running calendar query',
      done: 'Used calendar query',
      kind: 'generic',
    });
  });

  it('survives a degenerate name without producing empty wording', () => {
    expect(describeTool('').running).toBe('Running a tool');
    expect(describeTool('...').done).toBe('Used a tool');
  });
});

describe('formatThinkingDuration', () => {
  it('says "a moment" rather than a meaningless zero', () => {
    expect(formatThinkingDuration(0)).toBe('Thought for a moment');
    expect(formatThinkingDuration(999)).toBe('Thought for a moment');
  });

  it('singularises one second', () => {
    expect(formatThinkingDuration(1000)).toBe('Thought for 1 second');
    expect(formatThinkingDuration(2000)).toBe('Thought for 2 seconds');
  });

  it('rolls over into minutes', () => {
    expect(formatThinkingDuration(60_000)).toBe('Thought for 1 minute');
    expect(formatThinkingDuration(65_000)).toBe('Thought for 1 minute 5 seconds');
    expect(formatThinkingDuration(125_000)).toBe('Thought for 2 minutes 5 seconds');
  });

  it('never renders NaN into the transcript', () => {
    expect(formatThinkingDuration(Number.NaN)).toBe('Thought for a moment');
    expect(formatThinkingDuration(Number.POSITIVE_INFINITY)).toBe(
      'Thought for a moment',
    );
  });
});

describe('reasoningTail', () => {
  it('returns a short trace unchanged apart from flattening', () => {
    expect(reasoningTail('Let me\n  check that.')).toBe('Let me check that.');
  });

  it('keeps the end of a long trace, not the beginning', () => {
    // The point of the live ticker is to show where the model has got to. A
    // stable first line would read as a hang.
    const trace = `${'a '.repeat(200)}the final clause`;
    expect(reasoningTail(trace)).toContain('the final clause');
  });

  it('respects the character budget', () => {
    const trace = 'x'.repeat(500);
    expect(reasoningTail(trace, 40).length).toBeLessThanOrEqual(40);
  });

  it('opens at a word boundary rather than mid-word', () => {
    const trace = `${'word '.repeat(60)}end`;
    const tail = reasoningTail(trace, 50);
    expect(tail.startsWith('word') || tail.startsWith('end')).toBe(true);
  });

  it('is empty for an empty trace, so the ticker renders nothing', () => {
    expect(reasoningTail('')).toBe('');
    expect(reasoningTail('   \n  ')).toBe('');
  });
});

describe('anchorSpacerHeight', () => {
  it('fills the viewport below a short turn', () => {
    // 800 tall, a 100pt turn, 12pt of breathing room above it.
    expect(anchorSpacerHeight(800, 100, 12)).toBe(688);
  });

  it('collapses to zero once the turn outgrows the viewport', () => {
    // Past this point the transcript scrolls normally, with no state change
    // for the caller to coordinate.
    expect(anchorSpacerHeight(800, 900, 12)).toBe(0);
    expect(anchorSpacerHeight(800, 800, 12)).toBe(0);
  });

  it('shrinks exactly as fast as the turn grows', () => {
    // This is the property the pinned question depends on: total content
    // height must not change while the answer streams, or the scroll offset
    // moves and the question drifts.
    const viewport = 800;
    for (const turn of [40, 120, 300, 600]) {
      expect(anchorSpacerHeight(viewport, turn) + turn).toBe(viewport - 12);
    }
  });

  it('refuses to emit NaN when a measurement has not arrived yet', () => {
    // onLayout has not fired on first paint, so both inputs can be absent.
    expect(anchorSpacerHeight(Number.NaN, 100)).toBe(0);
    expect(anchorSpacerHeight(800, Number.NaN)).toBe(0);
  });
});
