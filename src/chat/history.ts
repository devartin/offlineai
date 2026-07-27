/**
 * Conversation persistence.
 *
 * The database layer, its migrations and its repositories were built and tested
 * some time ago — and then nothing ever called them. Every conversation lived
 * in React state and vanished on restart, which is a strange thing for an app
 * whose entire proposition is that your data stays on your device: it stayed on
 * the device right up until you closed the app.
 *
 * This module is the bridge. It is deliberately a set of plain functions over
 * an injected `Repositories` rather than a hook or a store, for two reasons:
 * the chat screen already owns the transcript as render state and does not need
 * a second source of truth for it, and pure functions taking a repository can
 * be tested against a real SQLite engine with no React in the way.
 *
 * Nothing here throws into the UI. A failed write costs the user their history,
 * which is bad, but a failed write that also kills the turn in progress is
 * worse — so persistence failures are swallowed and the conversation continues
 * in memory.
 */

import type { Message, Repositories } from '../db';
import type { ToolRun } from '../inference/engine';

/**
 * What the transcript renders.
 *
 * Distinct from `ChatMessage`, the wire format sent to the model, and from
 * `Message`, the row shape. Those three drift apart deliberately: the model
 * never sees tool-run rendering, and the database never sees `streaming`.
 */
export interface Bubble {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  /**
   * How long the reasoning took, in milliseconds.
   *
   * Measured during the turn because it cannot be recovered afterwards — the
   * trace records what was thought, never how long it took — and rendered as
   * "Thought for 12 seconds" on the collapsed panel.
   */
  reasoningMs: number | null;
  toolRuns: ToolRun[];
  streaming: boolean;
}

/** Longest title kept. Beyond this the list turns into a wall of text. */
const TITLE_LIMIT = 48;

/**
 * Names a conversation from its opening message.
 *
 * Asking a model to summarise its own conversation costs a whole generation on
 * a phone that is already thermally constrained, and gets it wrong often enough
 * to be irritating. The first line of what the user actually typed is a better
 * title than most generated ones and costs nothing.
 */
export function titleFor(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0].trim();
  if (firstLine.length === 0) return 'New conversation';
  if (firstLine.length <= TITLE_LIMIT) return firstLine;

  // Cut on a word boundary when there is one reasonably close to the limit,
  // so titles do not end mid-word.
  const clipped = firstLine.slice(0, TITLE_LIMIT);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > TITLE_LIMIT * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}

/** Rebuilds a transcript from stored rows. */
export function bubblesFromMessages(messages: Message[]): Bubble[] {
  return (
    messages
      // Tool rows are part of the model's context, not the user's transcript —
      // tool activity is rendered from the assistant bubble that caused it.
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        reasoning: message.reasoning,
        reasoningMs: message.reasoningMs,
        toolRuns: toolRunsFrom(message),
        streaming: false,
      }))
  );
}

/**
 * Recovers tool runs from a stored message.
 *
 * `toolCalls` holds what the model asked for; the results were rendered into
 * the transcript at the time and are not stored separately, so a reopened
 * conversation shows which tools ran but not what they each returned. That is a
 * deliberate trade — storing every tool result would mean storing arbitrary
 * amounts of document text alongside every message.
 */
function toolRunsFrom(message: Message): ToolRun[] {
  if (!message.toolCalls) return [];
  return message.toolCalls.map((call) => ({
    name: call.name,
    args: call.arguments,
    ok: true,
    rendered: '',
  }));
}

/**
 * Records the user's turn, creating the conversation on first use.
 *
 * Returns the conversation id so the caller can hold it for the rest of the
 * session, or the id it was given when storage is unavailable — which is the
 * normal state in a browser preview, and must not stop the turn.
 */
export async function persistUserTurn(
  repos: Repositories | null,
  conversationId: string | null,
  prompt: string,
  modelId: string | null,
): Promise<string | null> {
  if (!repos) return conversationId;

  try {
    const now = Date.now();
    let id = conversationId;

    if (id === null) {
      const conversation = await repos.conversations.create({
        id: `c_${now}`,
        title: titleFor(prompt),
        modelId,
        now,
      });
      id = conversation.id;
    } else {
      await repos.conversations.touch(id, now);
    }

    await repos.messages.append({
      id: `m_${now}_u`,
      conversationId: id,
      role: 'user',
      content: prompt,
      reasoning: null,
      reasoningMs: null,
      toolCalls: null,
      toolCallId: null,
      createdAt: now,
    });

    return id;
  } catch {
    // Losing history is survivable; losing the turn is not.
    return conversationId;
  }
}

/** Records the assistant's finished reply. */
export async function persistAssistantTurn(
  repos: Repositories | null,
  conversationId: string | null,
  bubble: Bubble,
): Promise<void> {
  if (!repos || conversationId === null) return;

  try {
    const now = Date.now();
    await repos.messages.append({
      id: bubble.id,
      conversationId,
      role: 'assistant',
      content: bubble.content,
      reasoning: bubble.reasoning,
      reasoningMs: bubble.reasoningMs,
      toolCalls:
        bubble.toolRuns.length > 0
          ? bubble.toolRuns.map((run, index) => ({
              id: `${bubble.id}_t${index}`,
              name: run.name,
              arguments: JSON.stringify(run.args ?? {}),
            }))
          : null,
      toolCallId: null,
      createdAt: now,
    });
    await repos.conversations.touch(conversationId, now);
  } catch {
    // See above.
  }
}

/**
 * Removes a message and everything after it.
 *
 * Two callers, and both need the same guarantee — that what leaves the screen
 * also leaves storage, or reopening the conversation resurrects it. Regenerate
 * drops the rejected answer; editing a question drops the question and every
 * reply that was conditioned on it.
 */
export async function dropFrom(
  repos: Repositories | null,
  conversationId: string | null,
  messageId: string,
): Promise<void> {
  if (!repos || conversationId === null) return;

  try {
    const stored = await repos.messages.list(conversationId);
    const target = stored.find((message) => message.id === messageId);
    if (target) await repos.messages.removeFrom(conversationId, target.createdAt);
  } catch {
    // See above.
  }
}

/** Reopens a stored conversation. */
export async function loadConversation(
  repos: Repositories | null,
  conversationId: string,
): Promise<Bubble[]> {
  if (!repos) return [];
  try {
    return bubblesFromMessages(await repos.messages.list(conversationId));
  } catch {
    return [];
  }
}
