/**
 * Application wiring.
 *
 * Every subsystem built so far is independent and testable in isolation; this
 * is the one place they are connected. Keeping the composition here means the
 * kernel never learns about SQLite, the engine never learns about React, and
 * the screens never learn about any of it.
 *
 * It also owns the consent prompt. The kernel's `ConsentBroker` is defined in
 * terms of an async `prompt()` that resolves to an answer — deliberately
 * UI-agnostic — and this file is where that promise is bridged to a real sheet
 * the user can see and tap.
 */

import * as Device from 'expo-device';
import * as SQLite from 'expo-sqlite';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import {
  createRepositories,
  migrate,
  type InstalledModel,
  type Repositories,
  type SqlDatabase,
} from './db';
import { createEngine, type Engine } from './inference/engine';
import type { DeviceProfile } from './models/fit';
import { createKnowledgeIndex, type KnowledgeIndex } from './knowledge';
import { computeTool } from './tools/builtin/compute';
import { createDocsTools } from './tools/builtin/docs';
import { createMemoryTools } from './tools/builtin/memory';
import { createInMemoryAuditLog, type AuditLog } from './tools/kernel/audit';
import {
  createConsentBroker,
  createInMemoryConsentStore,
  type ConsentStore,
  type GrantState,
  type PromptAnswer,
  type PromptRequest,
} from './tools/kernel/consent';
import { createDispatcher, type Dispatcher } from './tools/kernel/dispatch';
import { createRegistry, type ToolRegistry } from './tools/kernel/registry';

const DATABASE_NAME = 'offlineai.db';

/** A consent request waiting on the user, surfaced to the confirmation sheet. */
export interface PendingConsent extends PromptRequest {
  resolve: (answer: PromptAnswer) => void;
}

export interface AppContextValue {
  ready: boolean;
  /** Non-null when startup failed; the UI shows this instead of the app. */
  startupError: string | null;
  engine: Engine;
  repos: Repositories | null;
  registry: ToolRegistry;
  dispatcher: Dispatcher | null;
  device: DeviceProfile;
  /** Document index, available once startup completes. */
  knowledge: KnowledgeIndex | null;
  installedModels: InstalledModel[];
  refreshInstalledModels: () => Promise<void>;
  pendingConsent: PendingConsent | null;
  /** Called by the confirmation sheet with the user's choice. */
  answerConsent: (answer: PromptAnswer) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/**
 * A consent store over the `consent_grants` table.
 *
 * Grants are cached in memory because `get` is synchronous by contract — the
 * broker cannot await a read mid-decision. Writes go through to SQLite, so the
 * cache is only ever a read-through view of durable state.
 */
function createDurableConsentStore(
  repos: Repositories,
  initial: Record<string, GrantState>,
): ConsentStore {
  const cache = new Map<string, GrantState>(Object.entries(initial));

  return {
    get: (scope) => cache.get(scope) ?? 'ask',
    set: (scope, state) => {
      cache.set(scope, state);
      // Fire-and-forget: a failed write costs a re-prompt next launch, which is
      // the safe direction to fail in.
      void repos.consent.set(scope, state, Date.now());
    },
  };
}

/** An audit log that writes through to SQLite while staying synchronous. */
function createDurableAuditLog(repos: Repositories): AuditLog {
  const memory = createInMemoryAuditLog();

  return {
    record(entry) {
      const recorded = memory.record(entry);
      void repos.audit.record({
        id: recorded.id,
        conversationId: null,
        toolName: recorded.toolName,
        args: recorded.args,
        outcome: recorded.outcome,
        durationMs: recorded.durationMs,
        at: recorded.at,
      });
      return recorded;
    },
    entries: memory.entries,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repositories | null>(null);
  const [dispatcher, setDispatcher] = useState<Dispatcher | null>(null);
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const [pendingConsent, setPendingConsent] = useState<PendingConsent | null>(null);
  const [index, setIndex] = useState<KnowledgeIndex | null>(null);

  // The engine and registry outlive any render and must never be rebuilt — a
  // second engine would mean two loaded models and an immediate OOM kill.
  const engine = useMemo(() => createEngine(), []);
  const registry = useMemo(() => {
    const created = createRegistry();
    // Tools with no native dependency are registered eagerly. Anything needing
    // a permission-gated OS API is registered later, once the user has actually
    // granted it, so a denied permission never leaves a broken tool advertised
    // to the model.
    created.register(computeTool);
    return created;
  }, []);

  const device = useMemo<DeviceProfile>(
    () => ({
      totalMemoryBytes: Device.totalMemory ?? 4 * 1024 ** 3,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    }),
    [],
  );

  /**
   * Holds the resolver for the in-flight consent prompt.
   *
   * A ref rather than state because the broker's promise must be settled
   * exactly once, and reading it from a stale closure would strand the turn.
   */
  const consentResolver = useRef<((answer: PromptAnswer) => void) | null>(null);

  /**
   * Bridges the kernel's async consent contract to the confirmation sheet.
   *
   * Defined once and shared by both the durable and in-memory paths, so a
   * storage failure cannot accidentally ship a different consent flow.
   */
  const askUser = useCallback(
    (request: PromptRequest) =>
      new Promise<PromptAnswer>((resolve) => {
        consentResolver.current = resolve;
        setPendingConsent({ ...request, resolve });
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const db = (await SQLite.openDatabaseAsync(
          DATABASE_NAME,
        )) as unknown as SqlDatabase;
        await migrate(db);
        if (cancelled) return;

        const repositories = createRepositories(db);
        const grants = await repositories.consent.all();
        if (cancelled) return;

        const store = createDurableConsentStore(repositories, grants);
        const audit = createDurableAuditLog(repositories);

        const consent = createConsentBroker({ store, prompt: askUser });

        // Memory and documents need the database, so they are registered here
        // rather than in the eager block above. `embed` is bound lazily to
        // whichever model is loaded at call time — both subsystems degrade
        // (memory to lexical scoring, search to empty) rather than failing when
        // none is.
        const embed = (text: string) => engine.embed(text);

        const knowledge = createKnowledgeIndex({
          documents: repositories.documents,
          embed,
        });

        for (const tool of [
          ...createMemoryTools({ repository: repositories.memories, embed }),
          ...createDocsTools({ index: knowledge }),
        ]) {
          registry.register(tool);
        }
        setIndex(knowledge);

        const models = await repositories.models.list();
        if (cancelled) return;

        setRepos(repositories);
        setDispatcher(createDispatcher({ registry, consent, audit }));
        setInstalledModels(models);
        setReady(true);
      } catch (cause) {
        // Storage failing is serious but not fatal. Chat, the model catalog,
        // fit prediction and the compute tool all work without it, so the app
        // comes up degraded with an explanation rather than showing a dead
        // error screen. This is also what makes a browser preview possible,
        // where SQLite may be unavailable entirely.
        if (!cancelled) {
          setStartupError(cause instanceof Error ? cause.message : String(cause));

          // Consent still runs, backed by memory instead of SQLite. Grants
          // simply do not survive a restart. Degrading to "allow everything"
          // because storage failed would turn a storage bug into a privacy
          // breach, which is never an acceptable trade.
          setDispatcher(
            createDispatcher({
              registry,
              consent: createConsentBroker({
                store: createInMemoryConsentStore(),
                prompt: askUser,
              }),
              audit: createInMemoryAuditLog(),
            }),
          );
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [registry, engine]);

  /**
   * Evicts the model when the app leaves the foreground.
   *
   * This is the single most important lifecycle behaviour in the app. iOS
   * jetsam kills whichever backgrounded process holds the most memory, and a
   * loaded 4B model makes this app that process every time. Releasing the
   * context on background — after saving the KV cache — is what stops the app
   * being killed while the user reads a text message.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        void engine.evict();
      } else if (next === 'active') {
        void engine.restore();
      }
    });
    return () => subscription.remove();
  }, [engine]);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      startupError,
      engine,
      repos,
      registry,
      dispatcher,
      device,
      knowledge: index,
      installedModels,
      pendingConsent,

      async refreshInstalledModels() {
        if (repos) setInstalledModels(await repos.models.list());
      },

      answerConsent(answer) {
        consentResolver.current?.(answer);
        consentResolver.current = null;
        setPendingConsent(null);
      },
    }),
    [
      ready,
      startupError,
      engine,
      repos,
      registry,
      dispatcher,
      device,
      index,
      installedModels,
      pendingConsent,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
