export type AuditOutcome = 'ok' | 'error' | 'denied';

/**
 * One tool invocation, as shown in the user-visible audit log.
 *
 * Every attempt is recorded, including denials — "what did it try to do" is
 * the question this log exists to answer.
 */
export interface AuditEntry {
  id: string;
  toolName: string;
  /** Exactly what the model asked for, before validation. */
  args: unknown;
  outcome: AuditOutcome;
  durationMs: number;
  /** Epoch milliseconds. Formatting is a presentation concern. */
  at: number;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, 'id'>): AuditEntry;
  entries(): readonly AuditEntry[];
}

export function createInMemoryAuditLog(): AuditLog {
  const entries: AuditEntry[] = [];
  let counter = 0;

  return {
    record(entry) {
      const recorded: AuditEntry = { ...entry, id: `audit-${++counter}` };
      entries.push(recorded);
      return recorded;
    },
    entries: () => entries,
  };
}
