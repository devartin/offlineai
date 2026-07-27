/**
 * Durable state.
 *
 * Everything the app remembers lives here: conversations, the tool audit
 * trail, consent grants, the document index and installed models. Nothing in
 * this file talks to the network, and nothing leaves the device.
 *
 * The module depends on a structural `SqlDatabase` interface rather than
 * importing `expo-sqlite` directly. `SQLiteDatabase` satisfies it as-is, and
 * the indirection means every repository below is exercised in Node against a
 * fake — persistence bugs are found on a laptop, not on a phone.
 */

/**
 * The subset of `expo-sqlite`'s async surface this module uses.
 * Structurally satisfied by `SQLiteDatabase`, so no adapter is needed.
 */
export interface SqlDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params?: unknown[]): Promise<{ changes: number }>;
  getAllAsync<T>(source: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params?: unknown[]): Promise<T | null>;
}

/**
 * Ordered, append-only migrations.
 *
 * Never edit a shipped entry — add a new one. `user_version` records how many
 * have run, so editing history silently skips work on existing installs.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — conversations and messages
  `
  CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT    NOT NULL,
    model_id    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content         TEXT    NOT NULL,
    -- Collapsed <think> trace, kept separate so it can be hidden without
    -- destroying it and without polluting what is re-sent to the model.
    reasoning       TEXT,
    tool_calls      TEXT,
    tool_call_id    TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX messages_by_conversation ON messages(conversation_id, created_at);
  `,

  // 2 — tool kernel durability
  `
  CREATE TABLE tool_audit (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT,
    tool_name       TEXT    NOT NULL,
    args            TEXT    NOT NULL,
    outcome         TEXT    NOT NULL CHECK (outcome IN ('ok','error','denied')),
    duration_ms     INTEGER NOT NULL,
    at              INTEGER NOT NULL
  );

  CREATE INDEX tool_audit_recent ON tool_audit(at DESC);

  CREATE TABLE consent_grants (
    scope      TEXT PRIMARY KEY,
    state      TEXT    NOT NULL CHECK (state IN ('ask','always','never')),
    updated_at INTEGER NOT NULL
  );
  `,

  // 3 — knowledge index and long-term memory
  `
  CREATE TABLE documents (
    id          TEXT PRIMARY KEY,
    title       TEXT    NOT NULL,
    source_uri  TEXT,
    mime_type   TEXT,
    byte_size   INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE chunks (
    id          TEXT PRIMARY KEY,
    document_id TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    text        TEXT    NOT NULL,
    page        INTEGER,
    -- Float32Array, little-endian. Brute-force cosine over these is single-digit
    -- milliseconds at realistic personal-corpus sizes, which is why there is no
    -- vector extension here.
    embedding   BLOB
  );

  CREATE INDEX chunks_by_document ON chunks(document_id, ordinal);

  CREATE TABLE memories (
    id         TEXT PRIMARY KEY,
    content    TEXT    NOT NULL,
    source     TEXT,
    embedding  BLOB,
    created_at INTEGER NOT NULL
  );
  `,

  // 4 — installed models
  `
  CREATE TABLE installed_models (
    id           TEXT PRIMARY KEY,
    catalog_id   TEXT,
    name         TEXT    NOT NULL,
    path         TEXT    NOT NULL,
    mmproj_path  TEXT,
    size_bytes   INTEGER NOT NULL,
    -- Serialised ModelCapabilities, stamped once at install time so the UI
    -- never has to re-open a GGUF to decide what to render.
    capabilities TEXT    NOT NULL,
    installed_at INTEGER NOT NULL
  );
  `,
];

/**
 * Brings a database up to the current schema.
 *
 * Safe to call on every launch. Each migration runs inside its own transaction
 * so a failure halfway through leaves the previous version intact rather than a
 * half-applied schema.
 */
export async function migrate(db: SqlDatabase): Promise<number> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    await db.execAsync(
      `BEGIN; ${MIGRATIONS[version]} PRAGMA user_version = ${version + 1}; COMMIT;`,
    );
  }
  return MIGRATIONS.length;
}

// ---------------------------------------------------------------------------
// Embedding storage
// ---------------------------------------------------------------------------

/**
 * Packs an embedding for BLOB storage.
 *
 * `Uint8Array` is what both `expo-sqlite` and `node:sqlite` accept for a BLOB
 * parameter; the underlying bytes are the Float32Array's own buffer, so this
 * is a view rather than a copy.
 */
export function packEmbedding(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Unpacks a stored embedding.
 *
 * The bytes are copied because SQLite may reuse its row buffer, and because an
 * arbitrary BLOB offset is not guaranteed to be 4-byte aligned — constructing a
 * Float32Array directly over an unaligned buffer throws.
 */
export function unpackEmbedding(
  blob: Uint8Array | ArrayBuffer | null,
): Float32Array | null {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  return new Float32Array(bytes.slice().buffer);
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface StoredToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface Conversation {
  id: string;
  title: string;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  toolCalls: StoredToolCall[] | null;
  toolCallId: string | null;
  createdAt: number;
}

export interface Document {
  id: string;
  title: string;
  sourceUri: string | null;
  mimeType: string | null;
  byteSize: number;
  addedAt: number;
  chunkCount: number;
}

export interface Chunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  page: number | null;
  embedding: Float32Array | null;
}

export interface Memory {
  id: string;
  content: string;
  source: string | null;
  embedding: Float32Array | null;
  createdAt: number;
}

export interface InstalledModel {
  id: string;
  catalogId: string | null;
  name: string;
  path: string;
  mmprojPath: string | null;
  sizeBytes: number;
  /** Serialised `ModelCapabilities`. Parsed by the caller that knows the shape. */
  capabilities: string;
  installedAt: number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  title: string;
  model_id: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  text: string;
  page: number | null;
  embedding: Uint8Array | null;
}

interface InstalledModelRow {
  id: string;
  catalog_id: string | null;
  name: string;
  path: string;
  mmproj_path: string | null;
  size_bytes: number;
  capabilities: string;
  installed_at: number;
}

/**
 * Parses a persisted tool_calls column.
 *
 * Returns null rather than throwing on malformed JSON: a corrupt column should
 * cost one message its call annotation, never the whole conversation's ability
 * to load.
 */
function parseToolCalls(raw: string | null): StoredToolCall[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredToolCall[]) : null;
  } catch {
    return null;
  }
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    toolCalls: parseToolCalls(row.tool_calls),
    toolCallId: row.tool_call_id,
    createdAt: row.created_at,
  };
}

function toChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    text: row.text,
    page: row.page,
    embedding: unpackEmbedding(row.embedding),
  };
}

function toInstalledModel(row: InstalledModelRow): InstalledModel {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    name: row.name,
    path: row.path,
    mmprojPath: row.mmproj_path,
    sizeBytes: row.size_bytes,
    capabilities: row.capabilities,
    installedAt: row.installed_at,
  };
}

/** Stringifies anything, including cyclic values, without throwing. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface ConversationRepository {
  create(input: {
    id: string;
    title: string;
    modelId: string | null;
    now: number;
  }): Promise<Conversation>;
  list(options?: { includeArchived?: boolean }): Promise<Conversation[]>;
  get(id: string): Promise<Conversation | null>;
  rename(id: string, title: string, now: number): Promise<void>;
  setModel(id: string, modelId: string, now: number): Promise<void>;
  touch(id: string, now: number): Promise<void>;
  archive(id: string, now: number): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface MessageRepository {
  append(message: Message): Promise<void>;
  list(conversationId: string): Promise<Message[]>;
  updateContent(id: string, content: string, reasoning: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes a message and everything after it — the regenerate path. */
  removeFrom(conversationId: string, createdAt: number): Promise<void>;
}

export interface AuditRecord {
  id: string;
  conversationId: string | null;
  toolName: string;
  args: string;
  outcome: string;
  durationMs: number;
  at: number;
}

export interface AuditRepository {
  record(entry: {
    id: string;
    conversationId: string | null;
    toolName: string;
    args: unknown;
    outcome: 'ok' | 'error' | 'denied';
    durationMs: number;
    at: number;
  }): Promise<void>;
  recent(limit?: number): Promise<AuditRecord[]>;
  clear(): Promise<void>;
}

export interface ConsentRepository {
  all(): Promise<Record<string, 'ask' | 'always' | 'never'>>;
  set(scope: string, state: 'ask' | 'always' | 'never', now: number): Promise<void>;
  revokeAll(now: number): Promise<void>;
}

export interface DocumentRepository {
  add(document: Document): Promise<void>;
  list(): Promise<Document[]>;
  remove(id: string): Promise<void>;
  addChunks(chunks: Chunk[]): Promise<void>;
  /** Every chunk with an embedding. Brute-force cosine runs over this. */
  allEmbedded(): Promise<Chunk[]>;
  chunk(id: string): Promise<Chunk | null>;
  chunksFor(documentId: string): Promise<Chunk[]>;
}

export interface MemoryRepository {
  add(memory: Memory): Promise<void>;
  all(): Promise<Memory[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface InstalledModelRepository {
  add(model: InstalledModel): Promise<void>;
  list(): Promise<InstalledModel[]>;
  get(id: string): Promise<InstalledModel | null>;
  remove(id: string): Promise<void>;
  totalBytes(): Promise<number>;
}

export interface Repositories {
  conversations: ConversationRepository;
  messages: MessageRepository;
  audit: AuditRepository;
  consent: ConsentRepository;
  documents: DocumentRepository;
  memories: MemoryRepository;
  models: InstalledModelRepository;
}

/**
 * Builds every repository over one database handle.
 *
 * Repositories are plain closures rather than classes — there is no inheritance
 * or lifecycle here, and closures keep each statement adjacent to the method
 * that owns it.
 */
export function createRepositories(db: SqlDatabase): Repositories {
  const conversations: ConversationRepository = {
    async create({ id, title, modelId, now }) {
      await db.runAsync(
        `INSERT INTO conversations (id, title, model_id, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [id, title, modelId, now, now],
      );
      return { id, title, modelId, createdAt: now, updatedAt: now, archived: false };
    },

    async list(options = {}) {
      const rows = await db.getAllAsync<ConversationRow>(
        `SELECT * FROM conversations
         ${options.includeArchived ? '' : 'WHERE archived = 0'}
         ORDER BY updated_at DESC`,
      );
      return rows.map(toConversation);
    },

    async get(id) {
      const row = await db.getFirstAsync<ConversationRow>(
        'SELECT * FROM conversations WHERE id = ?',
        [id],
      );
      return row ? toConversation(row) : null;
    },

    async rename(id, title, now) {
      await db.runAsync(
        'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?',
        [title, now, id],
      );
    },

    async setModel(id, modelId, now) {
      await db.runAsync(
        'UPDATE conversations SET model_id = ?, updated_at = ? WHERE id = ?',
        [modelId, now, id],
      );
    },

    async touch(id, now) {
      await db.runAsync('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, id]);
    },

    async archive(id, now) {
      await db.runAsync(
        'UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?',
        [now, id],
      );
    },

    async remove(id) {
      await db.runAsync('DELETE FROM conversations WHERE id = ?', [id]);
    },
  };

  const messages: MessageRepository = {
    async append(message) {
      await db.runAsync(
        `INSERT INTO messages
           (id, conversation_id, role, content, reasoning, tool_calls, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.reasoning,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.toolCallId,
          message.createdAt,
        ],
      );
      await conversations.touch(message.conversationId, message.createdAt);
    },

    async list(conversationId) {
      const rows = await db.getAllAsync<MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
        [conversationId],
      );
      return rows.map(toMessage);
    },

    async updateContent(id, content, reasoning) {
      await db.runAsync('UPDATE messages SET content = ?, reasoning = ? WHERE id = ?', [
        content,
        reasoning,
        id,
      ]);
    },

    async remove(id) {
      await db.runAsync('DELETE FROM messages WHERE id = ?', [id]);
    },

    async removeFrom(conversationId, createdAt) {
      await db.runAsync(
        'DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?',
        [conversationId, createdAt],
      );
    },
  };

  const audit: AuditRepository = {
    async record(entry) {
      await db.runAsync(
        `INSERT INTO tool_audit
           (id, conversation_id, tool_name, args, outcome, duration_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.conversationId,
          entry.toolName,
          // Stringified defensively: the model can produce anything, including
          // values with cycles, and an audit write must never throw.
          safeStringify(entry.args),
          entry.outcome,
          entry.durationMs,
          entry.at,
        ],
      );
    },

    async recent(limit = 200) {
      const rows = await db.getAllAsync<{
        id: string;
        conversation_id: string | null;
        tool_name: string;
        args: string;
        outcome: string;
        duration_ms: number;
        at: number;
      }>('SELECT * FROM tool_audit ORDER BY at DESC LIMIT ?', [limit]);

      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        toolName: row.tool_name,
        args: row.args,
        outcome: row.outcome,
        durationMs: row.duration_ms,
        at: row.at,
      }));
    },

    async clear() {
      await db.runAsync('DELETE FROM tool_audit');
    },
  };

  const consent: ConsentRepository = {
    async all() {
      const rows = await db.getAllAsync<{
        scope: string;
        state: 'ask' | 'always' | 'never';
      }>('SELECT scope, state FROM consent_grants');
      return Object.fromEntries(rows.map((row) => [row.scope, row.state]));
    },

    async set(scope, state, now) {
      await db.runAsync(
        `INSERT INTO consent_grants (scope, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           state = excluded.state, updated_at = excluded.updated_at`,
        [scope, state, now],
      );
    },

    async revokeAll(now) {
      // Revoking sets every known scope to 'never' rather than deleting rows: a
      // deleted grant reverts to "ask", which would quietly re-prompt instead of
      // honouring an explicit revocation.
      await db.runAsync('UPDATE consent_grants SET state = ?, updated_at = ?', [
        'never',
        now,
      ]);
    },
  };

  const documents: DocumentRepository = {
    async add(document) {
      await db.runAsync(
        `INSERT INTO documents
           (id, title, source_uri, mime_type, byte_size, added_at, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          document.id,
          document.title,
          document.sourceUri,
          document.mimeType,
          document.byteSize,
          document.addedAt,
          document.chunkCount,
        ],
      );
    },

    async list() {
      const rows = await db.getAllAsync<{
        id: string;
        title: string;
        source_uri: string | null;
        mime_type: string | null;
        byte_size: number;
        added_at: number;
        chunk_count: number;
      }>('SELECT * FROM documents ORDER BY added_at DESC');

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        sourceUri: row.source_uri,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        addedAt: row.added_at,
        chunkCount: row.chunk_count,
      }));
    },

    async remove(id) {
      await db.runAsync('DELETE FROM documents WHERE id = ?', [id]);
    },

    async addChunks(chunks) {
      for (const chunk of chunks) {
        await db.runAsync(
          `INSERT INTO chunks (id, document_id, ordinal, text, page, embedding)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            chunk.id,
            chunk.documentId,
            chunk.ordinal,
            chunk.text,
            chunk.page,
            chunk.embedding ? packEmbedding(chunk.embedding) : null,
          ],
        );
      }

      const documentId = chunks[0]?.documentId;
      if (documentId) {
        await db.runAsync(
          `UPDATE documents SET chunk_count =
             (SELECT COUNT(*) FROM chunks WHERE document_id = ?) WHERE id = ?`,
          [documentId, documentId],
        );
      }
    },

    async allEmbedded() {
      const rows = await db.getAllAsync<ChunkRow>(
        'SELECT * FROM chunks WHERE embedding IS NOT NULL',
      );
      return rows.map(toChunk);
    },

    async chunk(id) {
      const row = await db.getFirstAsync<ChunkRow>('SELECT * FROM chunks WHERE id = ?', [
        id,
      ]);
      return row ? toChunk(row) : null;
    },

    async chunksFor(documentId) {
      const rows = await db.getAllAsync<ChunkRow>(
        'SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal ASC',
        [documentId],
      );
      return rows.map(toChunk);
    },
  };

  const memories: MemoryRepository = {
    async add(memory) {
      await db.runAsync(
        `INSERT INTO memories (id, content, source, embedding, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          memory.id,
          memory.content,
          memory.source,
          memory.embedding ? packEmbedding(memory.embedding) : null,
          memory.createdAt,
        ],
      );
    },

    async all() {
      const rows = await db.getAllAsync<{
        id: string;
        content: string;
        source: string | null;
        embedding: Uint8Array | null;
        created_at: number;
      }>('SELECT * FROM memories ORDER BY created_at DESC');

      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        source: row.source,
        embedding: unpackEmbedding(row.embedding),
        createdAt: row.created_at,
      }));
    },

    async remove(id) {
      await db.runAsync('DELETE FROM memories WHERE id = ?', [id]);
    },

    async clear() {
      await db.runAsync('DELETE FROM memories');
    },
  };

  const models: InstalledModelRepository = {
    async add(model) {
      await db.runAsync(
        `INSERT INTO installed_models
           (id, catalog_id, name, path, mmproj_path, size_bytes, capabilities, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path         = excluded.path,
           mmproj_path  = excluded.mmproj_path,
           size_bytes   = excluded.size_bytes,
           capabilities = excluded.capabilities,
           installed_at = excluded.installed_at`,
        [
          model.id,
          model.catalogId,
          model.name,
          model.path,
          model.mmprojPath,
          model.sizeBytes,
          model.capabilities,
          model.installedAt,
        ],
      );
    },

    async list() {
      const rows = await db.getAllAsync<InstalledModelRow>(
        'SELECT * FROM installed_models ORDER BY installed_at DESC',
      );
      return rows.map(toInstalledModel);
    },

    async get(id) {
      const row = await db.getFirstAsync<InstalledModelRow>(
        'SELECT * FROM installed_models WHERE id = ?',
        [id],
      );
      return row ? toInstalledModel(row) : null;
    },

    async remove(id) {
      await db.runAsync('DELETE FROM installed_models WHERE id = ?', [id]);
    },

    async totalBytes() {
      const row = await db.getFirstAsync<{ total: number | null }>(
        'SELECT SUM(size_bytes) AS total FROM installed_models',
      );
      return row?.total ?? 0;
    },
  };

  return { conversations, messages, audit, consent, documents, memories, models };
}
