import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRepositories,
  migrate,
  packEmbedding,
  unpackEmbedding,
  type Repositories,
  type SqlDatabase,
} from './index';

/**
 * Adapts Node's synchronous SQLite to the async interface `expo-sqlite`
 * satisfies.
 *
 * This is why `SqlDatabase` exists as a structural interface rather than a
 * direct `expo-sqlite` import: the schema, the migrations, the foreign keys and
 * the ON CONFLICT clauses are all exercised against a real SQLite engine here,
 * so persistence bugs surface on a laptop instead of on a phone.
 */
function openTestDatabase(): SqlDatabase {
  const db = new DatabaseSync(':memory:');

  return {
    async execAsync(source) {
      db.exec(source);
    },
    async runAsync(source, params = []) {
      const result = db.prepare(source).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    async getAllAsync<T>(source: string, params: unknown[] = []) {
      return db.prepare(source).all(...(params as never[])) as T[];
    },
    async getFirstAsync<T>(source: string, params: unknown[] = []) {
      return (db.prepare(source).get(...(params as never[])) ?? null) as T | null;
    },
  };
}

const NOW = 1_753_600_000_000;

let db: SqlDatabase;
let repos: Repositories;

beforeEach(async () => {
  db = openTestDatabase();
  await migrate(db);
  repos = createRepositories(db);
});

describe('migrations', () => {
  it('creates every table the app depends on', async () => {
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = tables.map((row) => row.name);

    for (const table of [
      'conversations',
      'messages',
      'tool_audit',
      'consent_grants',
      'documents',
      'chunks',
      'memories',
      'installed_models',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('is idempotent across launches', async () => {
    // `migrate` runs on every app start, so a second call must be a no-op
    // rather than a CREATE TABLE conflict.
    await expect(migrate(db)).resolves.toBeGreaterThan(0);
    await expect(migrate(db)).resolves.toBeGreaterThan(0);
  });

  it('records how many migrations have run', async () => {
    const applied = await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(applied);
  });
});

describe('conversations and messages', () => {
  beforeEach(async () => {
    await repos.conversations.create({
      id: 'c1',
      title: 'Maths',
      modelId: 'qwen3-4b-instruct',
      now: NOW,
    });
  });

  it('round-trips a conversation', async () => {
    expect(await repos.conversations.get('c1')).toMatchObject({
      id: 'c1',
      title: 'Maths',
      modelId: 'qwen3-4b-instruct',
      archived: false,
    });
  });

  it('round-trips tool calls through JSON', async () => {
    await repos.messages.append({
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      content: '1,433.44',
      reasoning: null,
      reasoningMs: null,
      toolCalls: [
        { id: 't1', name: 'compute.evaluate', arguments: { expression: '17% of 8432' } },
      ],
      toolCallId: null,
      createdAt: NOW,
    });

    const [message] = await repos.messages.list('c1');
    expect(message.toolCalls).toEqual([
      { id: 't1', name: 'compute.evaluate', arguments: { expression: '17% of 8432' } },
    ]);
  });

  it('survives a corrupt tool_calls column without losing the conversation', async () => {
    // A malformed column should cost one message its annotation, never the
    // whole transcript's ability to load.
    await db.runAsync(
      `INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at)
       VALUES ('m_bad', 'c1', 'assistant', 'hi', '{not json', ?)`,
      [NOW],
    );

    const messages = await repos.messages.list('c1');
    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls).toBeNull();
  });

  it('orders messages chronologically', async () => {
    for (const [id, at] of [
      ['m3', NOW + 300],
      ['m1', NOW + 100],
      ['m2', NOW + 200],
    ] as const) {
      await repos.messages.append({
        id,
        conversationId: 'c1',
        role: 'user',
        content: id,
        reasoning: null,
        reasoningMs: null,
        toolCalls: null,
        toolCallId: null,
        createdAt: at,
      });
    }

    expect((await repos.messages.list('c1')).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('touches the conversation when a message arrives', async () => {
    await repos.messages.append({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'hello',
      reasoning: null,
      reasoningMs: null,
      toolCalls: null,
      toolCallId: null,
      createdAt: NOW + 5000,
    });

    // Sorting the conversation list by recency depends on this.
    expect((await repos.conversations.get('c1'))?.updatedAt).toBe(NOW + 5000);
  });

  it('truncates from a point for regeneration', async () => {
    for (const [id, at] of [
      ['m1', NOW + 100],
      ['m2', NOW + 200],
      ['m3', NOW + 300],
    ] as const) {
      await repos.messages.append({
        id,
        conversationId: 'c1',
        role: 'user',
        content: id,
        reasoning: null,
        reasoningMs: null,
        toolCalls: null,
        toolCallId: null,
        createdAt: at,
      });
    }

    await repos.messages.removeFrom('c1', NOW + 200);
    expect((await repos.messages.list('c1')).map((m) => m.id)).toEqual(['m1']);
  });

  it('cascades messages when a conversation is deleted', async () => {
    await repos.messages.append({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'hello',
      reasoning: null,
      reasoningMs: null,
      toolCalls: null,
      toolCallId: null,
      createdAt: NOW,
    });

    await repos.conversations.remove('c1');
    // Orphaned messages would leak the very content the user asked to delete.
    expect(await repos.messages.list('c1')).toHaveLength(0);
  });

  it('hides archived conversations unless asked for them', async () => {
    await repos.conversations.archive('c1', NOW + 10);
    expect(await repos.conversations.list()).toHaveLength(0);
    expect(await repos.conversations.list({ includeArchived: true })).toHaveLength(1);
  });
});

describe('consent grants', () => {
  it('upserts rather than duplicating a scope', async () => {
    await repos.consent.set('read:calendar', 'always', NOW);
    await repos.consent.set('read:calendar', 'never', NOW + 1);

    expect(await repos.consent.all()).toEqual({ 'read:calendar': 'never' });
  });

  it('revokes to never rather than deleting rows', async () => {
    // Deleting a grant would revert it to "ask", quietly re-prompting instead of
    // honouring an explicit revocation.
    await repos.consent.set('read:calendar', 'always', NOW);
    await repos.consent.set('execute:compute', 'always', NOW);
    await repos.consent.revokeAll(NOW + 10);

    expect(await repos.consent.all()).toEqual({
      'read:calendar': 'never',
      'execute:compute': 'never',
    });
  });
});

describe('tool audit', () => {
  it('records denials as well as successes', async () => {
    for (const [id, name, outcome] of [
      ['a1', 'compute.evaluate', 'ok'],
      ['a2', 'calendar.create', 'denied'],
      ['a3', 'docs.search', 'error'],
    ] as const) {
      await repos.audit.record({
        id,
        conversationId: 'c1',
        toolName: name,
        args: { q: 1 },
        outcome,
        durationMs: 5,
        at: NOW,
      });
    }

    const entries = await repos.audit.recent();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.outcome).sort()).toEqual(['denied', 'error', 'ok']);
  });

  it('never throws on arguments that cannot be serialised', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    // An audit write failing would mean an unlogged tool call, which is worse
    // than an ugly string.
    await expect(
      repos.audit.record({
        id: 'a1',
        conversationId: null,
        toolName: 'x.y',
        args: cyclic,
        outcome: 'ok',
        durationMs: 1,
        at: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns the most recent first', async () => {
    for (const [id, at] of [
      ['a1', NOW + 100],
      ['a2', NOW + 300],
      ['a3', NOW + 200],
    ] as const) {
      await repos.audit.record({
        id,
        conversationId: null,
        toolName: 't',
        args: {},
        outcome: 'ok',
        durationMs: 1,
        at,
      });
    }

    expect((await repos.audit.recent()).map((e) => e.id)).toEqual(['a2', 'a3', 'a1']);
  });
});

describe('embeddings', () => {
  async function seedDocument(): Promise<void> {
    await repos.documents.add({
      id: 'd1',
      title: 'Notes',
      sourceUri: null,
      mimeType: 'text/plain',
      byteSize: 100,
      addedAt: NOW,
      chunkCount: 0,
    });
  }

  it('round-trips a vector through a BLOB unchanged', () => {
    const original = new Float32Array([0.1, -0.2, 0.3, 0]);
    const restored = unpackEmbedding(packEmbedding(original));
    expect(Array.from(restored!)).toEqual(Array.from(original));
  });

  it('rejects a blob that is not a whole number of floats', () => {
    expect(unpackEmbedding(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(unpackEmbedding(new Uint8Array([]))).toBeNull();
    expect(unpackEmbedding(null)).toBeNull();
  });

  it('survives a real SQLite BLOB round-trip', async () => {
    await seedDocument();
    await repos.documents.addChunks([
      {
        id: 'k1',
        documentId: 'd1',
        ordinal: 0,
        text: 'hello',
        page: null,
        embedding: new Float32Array([0.5, -0.25, 0.125]),
      },
    ]);

    const [chunk] = await repos.documents.allEmbedded();
    expect(Array.from(chunk.embedding!)).toEqual([0.5, -0.25, 0.125]);
  });

  it('updates the document chunk count when chunks are added', async () => {
    await seedDocument();
    await repos.documents.addChunks([
      { id: 'k1', documentId: 'd1', ordinal: 0, text: 'a', page: null, embedding: null },
      { id: 'k2', documentId: 'd1', ordinal: 1, text: 'b', page: null, embedding: null },
    ]);

    expect((await repos.documents.list())[0].chunkCount).toBe(2);
  });

  it('excludes chunks with no embedding from search', async () => {
    await seedDocument();
    await repos.documents.addChunks([
      { id: 'k1', documentId: 'd1', ordinal: 0, text: 'a', page: null, embedding: null },
      {
        id: 'k2',
        documentId: 'd1',
        ordinal: 1,
        text: 'b',
        page: null,
        embedding: new Float32Array([1, 0]),
      },
    ]);

    expect((await repos.documents.allEmbedded()).map((c) => c.id)).toEqual(['k2']);
  });

  it('cascades chunks when a document is deleted', async () => {
    await seedDocument();
    await repos.documents.addChunks([
      {
        id: 'k1',
        documentId: 'd1',
        ordinal: 0,
        text: 'a',
        page: null,
        embedding: new Float32Array([1]),
      },
    ]);

    await repos.documents.remove('d1');
    expect(await repos.documents.allEmbedded()).toHaveLength(0);
  });
});

describe('installed models', () => {
  const model = {
    id: 'qwen3-4b-instruct',
    catalogId: 'qwen3-4b-instruct',
    name: 'Qwen3 4B Instruct',
    path: 'file:///models/qwen3/weights.gguf',
    mmprojPath: null,
    sizeBytes: 2_500_000_000,
    capabilities: '{"supportsTools":true}',
    installedAt: NOW,
  };

  it('upserts on reinstall rather than failing', async () => {
    await repos.models.add(model);
    // Re-downloading an existing model must update it, not throw a primary-key
    // conflict that leaves the user stuck.
    await repos.models.add({ ...model, sizeBytes: 2_600_000_000, installedAt: NOW + 1 });

    expect((await repos.models.get(model.id))?.sizeBytes).toBe(2_600_000_000);
    expect(await repos.models.list()).toHaveLength(1);
  });

  it('totals storage across installed models', async () => {
    await repos.models.add(model);
    await repos.models.add({ ...model, id: 'gemma-3-270m-it', sizeBytes: 292_000_000 });

    expect(await repos.models.totalBytes()).toBe(2_792_000_000);
  });

  it('reports zero storage when nothing is installed', async () => {
    // SUM over no rows is NULL in SQL; returning null here would render as
    // "NaN GB" in the storage screen.
    expect(await repos.models.totalBytes()).toBe(0);
  });

  it('preserves the serialised capability record verbatim', async () => {
    await repos.models.add(model);
    const stored = await repos.models.get(model.id);
    expect(JSON.parse(stored!.capabilities)).toEqual({ supportsTools: true });
  });
});
