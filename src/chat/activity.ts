/**
 * How a turn's activity is described to the user.
 *
 * Everything here is a pure function over plain data, with no imports at all,
 * which is deliberate on two counts. It keeps the wording — the actual words a
 * user reads while waiting — in one auditable place rather than scattered
 * through JSX, and it makes that wording testable, since a module that imports
 * `react-native` cannot be loaded by the test runner.
 *
 * The reference app's real insight about waiting states is that a label naming
 * the *specific* thing happening ("Searching your documents") buys far more
 * patience than a generic one ("Working…"), and that the label must change
 * tense once the step is finished, because a permanent present participle reads
 * as a stuck process.
 */

/**
 * The family a tool belongs to.
 *
 * The UI maps this to an icon. It exists so this module can stay free of any
 * dependency on the icon set while still driving the icon choice.
 */
export type ToolKind = 'compute' | 'documents' | 'memory' | 'generic';

export interface ToolPresentation {
  /** Present participle, shown while the tool is in flight. */
  running: string;
  /** Past tense, shown once it has returned. */
  done: string;
  kind: ToolKind;
}

/**
 * Human wording for each built-in tool.
 *
 * Keyed by the tool's registered name. An unknown name falls through to a
 * derived label rather than an error — the registry is open, and a tool added
 * later should degrade to something readable instead of breaking the
 * transcript.
 */
const PRESENTATIONS: Record<string, ToolPresentation> = {
  'compute.evaluate': { running: 'Calculating', done: 'Calculated', kind: 'compute' },
  'docs.search': {
    running: 'Searching your documents',
    done: 'Searched your documents',
    kind: 'documents',
  },
  'docs.read': {
    running: 'Reading a document',
    done: 'Read a document',
    kind: 'documents',
  },
  'memory.remember': {
    running: 'Saving to memory',
    done: 'Saved to memory',
    kind: 'memory',
  },
  'memory.recall': {
    running: 'Checking memory',
    done: 'Checked memory',
    kind: 'memory',
  },
};

/**
 * Describes a tool for the transcript.
 *
 * The fallback turns `family.verb` into "Running family verb" by splitting on
 * the dot and separators, which reads acceptably for any name following the
 * kernel's own convention and harmlessly for one that does not.
 */
export function describeTool(name: string): ToolPresentation {
  const known = PRESENTATIONS[name];
  if (known) return known;

  const readable = name.replace(/[._-]+/g, ' ').trim() || 'a tool';
  return { running: `Running ${readable}`, done: `Used ${readable}`, kind: 'generic' };
}

/**
 * How long the model spent thinking, in words.
 *
 * Sub-second traces get "a moment" rather than "0 seconds": the number is both
 * meaningless at that resolution and faintly absurd, and the phrase carries the
 * only information the user actually wanted — that it did not take long.
 */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return 'Thought for a moment';

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `Thought for ${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minutePart = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (seconds === 0) return `Thought for ${minutePart}`;
  return `Thought for ${minutePart} ${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * The tail of a reasoning trace, as one line.
 *
 * Shown live beneath the "Thinking" label while the model reasons. The *tail*
 * rather than the head because reasoning is written forwards: the most recent
 * sentence is the one that tells the user where the model has got to, and a
 * frozen first line reads as a hang.
 *
 * Newlines collapse to spaces because this renders on a single clipped row —
 * without that, a trace whose next token is a line break appears to stop.
 */
export function reasoningTail(text: string, maxChars = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;

  const tail = flat.slice(flat.length - maxChars);
  // Resume at a word boundary so the line never opens mid-word, which reads as
  // corruption rather than as a continuation. Only a boundary near the start
  // counts — otherwise a long unbroken token would eat most of the line.
  const space = tail.indexOf(' ');
  return space > 0 && space < 24 ? tail.slice(space + 1) : tail;
}

/**
 * Height of the spacer that pins a just-asked question to the top of the
 * screen while its answer streams in below.
 *
 * This is the single most recognisable motion in the reference app, and it is
 * not a scroll animation — it is arithmetic. Padding the transcript with
 * `viewport − turn` means scrolling to the very bottom places the top of the
 * newest turn exactly at the top of the viewport. As the answer streams the
 * turn grows, this shrinks by the same amount, total content height does not
 * change, and the scroll offset therefore does not move: the question appears
 * to hold still while text fills the space beneath it. Once the answer outgrows
 * the viewport the spacer is zero and ordinary bottom-following resumes, with
 * no state transition to get wrong.
 *
 * @param viewportHeight Height of the scrollable area.
 * @param turnHeight     Measured height of the newest question-and-answer pair.
 * @param reservedTop    Breathing room left above the question.
 */
export function anchorSpacerHeight(
  viewportHeight: number,
  turnHeight: number,
  reservedTop = 12,
): number {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(turnHeight)) return 0;
  return Math.max(0, viewportHeight - turnHeight - reservedTop);
}
