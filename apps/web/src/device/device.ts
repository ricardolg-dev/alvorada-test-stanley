// Pure device logic: a per-device outbox, receipts and conflicts behind
// closures. Network, randomness and rendering are injected or left to the
// caller, so this module stays deterministic and free of UI code.

import type {
  ConflictResult,
  Note,
  Operation,
  OperationResult,
} from '../api-client/contract';

/** Returns `byteLength` random bytes. Injected so tests are deterministic. */
export type RandomSource = (byteLength: number) => Uint8Array;

/**
 * Both calls reject on a network error, a timeout or a non-2xx answer.
 */
export interface Transport {
  postOperations: (operations: Operation[]) => Promise<OperationResult[]>;
  getNotes: () => Promise<Note[]>;
}

/** One request and what came back; `discarded` marks a lost response. */
export type DeviceEvent =
  | {
      kind: 'send' | 'resend';
      request: Operation[];
      response: OperationResult[] | null;
      error: string | null;
      discarded: boolean;
    }
  | {
      kind: 'pull';
      request: null;
      response: Note[] | null;
      error: string | null;
      discarded: false;
    };

export interface DeviceOptions {
  prefix: string;
  transport: Transport;
  random: RandomSource;
  onEvent?: (event: DeviceEvent) => void;
}

export interface OutboxEntry {
  readonly op: Operation;
  readonly frozen: boolean;
}

export interface Receipt {
  readonly seq: number;
  readonly op: Operation;
  readonly result: OperationResult;
  readonly resend: boolean;
}

export interface DeviceState {
  readonly online: boolean;
  readonly loseNextResponse: boolean;
  readonly busy: boolean;
  readonly canRetry: boolean;
  readonly message: string;
  readonly error: string | null;
  /** The note as the device last saw it, keyed by `note_id`. */
  readonly seen: ReadonlyMap<string, Note>;
  /** Pending operations keyed by `note_id`, in the order they were created. */
  readonly outbox: ReadonlyMap<string, OutboxEntry>;
  readonly conflicts: ReadonlyMap<string, ConflictResult>;
  /** Newest first. */
  readonly receipts: readonly Receipt[];
}

export type RefusalReason =
  | 'busy'
  | 'offline'
  | 'frozen'
  | 'conflict'
  | 'unknown_note'
  | 'nothing_to_retry'
  | 'no_conflict'
  | 'unknown_receipt';

export type ActionResult = { ok: true } | { ok: false; reason: RefusalReason };

export type CreateResult =
  { ok: true; noteId: string } | { ok: false; reason: RefusalReason };

export type Resolution =
  { mode: 'discard' } | { mode: 'mine' } | { mode: 'text'; text: string };

export interface Device {
  getState: () => DeviceState;
  subscribe: (listener: () => void) => () => void;
  setOnline: (online: boolean) => Promise<ActionResult>;
  setLoseNextResponse: (value: boolean) => void;
  createNote: (text: string) => Promise<CreateResult>;
  editNote: (noteId: string, text: string) => Promise<ActionResult>;
  pull: () => Promise<ActionResult>;
  retry: () => Promise<ActionResult>;
  resend: (seq: number) => Promise<ActionResult>;
  resolve: (noteId: string, resolution: Resolution) => Promise<ActionResult>;
  reset: () => void;
}

type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'failed'; error: string }
  | { kind: 'stale' };

const OP_ID_BYTES = 8;
const NOTE_ID_BYTES = 4;
const NOTE_ID_ATTEMPTS = 1000;

const REFUSED_BUSY = { ok: false, reason: 'busy' } as const;
const OK: ActionResult = { ok: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNote(value: unknown): value is Note {
  return (
    isRecord(value) &&
    typeof value.note_id === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.text === 'string'
  );
}

function isOperationResult(value: unknown): value is OperationResult {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case 'created':
    case 'updated':
      return typeof value.op_id === 'string' && isNote(value.note);
    case 'conflito':
      return (
        typeof value.op_id === 'string' &&
        typeof value.note_id === 'string' &&
        (value.reason === 'revision_mismatch'
          ? isNote(value.server)
          : value.reason === 'note_not_found' && value.server === null) &&
        isRecord(value.proposal) &&
        typeof value.proposal.base_revision === 'number' &&
        typeof value.proposal.text === 'string'
      );
    case 'id_reutilizado':
      return typeof value.op_id === 'string';
    case 'invalid':
      return (
        typeof value.reason === 'string' &&
        (value.op_id === undefined || typeof value.op_id === 'string')
      );
    default:
      return false;
  }
}

/** Results are applied by position, so count and `op_id`s must line up. */
function answersRequest(
  value: unknown,
  request: readonly Operation[],
): value is OperationResult[] {
  return (
    Array.isArray(value) &&
    value.length === request.length &&
    value.every(
      (item: unknown, index) =>
        isOperationResult(item) && item.op_id === request[index]?.op_id,
    )
  );
}

function isNoteList(value: unknown): value is Note[] {
  return Array.isArray(value) && value.every(isNote);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function frozenMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const copy = new Map(source);
  const refuse = (): never => {
    throw new TypeError('A device snapshot is read-only');
  };
  Object.defineProperties(copy, {
    set: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
  });
  return Object.freeze(copy);
}

function describeError(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  if (typeof cause === 'string' && cause !== '') return cause;
  return 'The request failed.';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function createDevice(options: DeviceOptions): Device {
  const { prefix, transport, random, onEvent } = options;

  let online = true;
  let loseNext = false;
  let busy = false;
  let message = '';
  let error: string | null = null;
  let receiptSeq = 0;
  // Bumped by reset: a response that left before it belongs to a past epoch.
  let epoch = 0;
  const seen = new Map<string, Note>();
  const outbox = new Map<string, OutboxEntry>();
  const conflicts = new Map<string, ConflictResult>();
  let receipts: readonly Receipt[] = [];

  const listeners = new Set<() => void>();

  function build(): DeviceState {
    return Object.freeze({
      online,
      loseNextResponse: loseNext,
      busy,
      canRetry: [...outbox.values()].some((entry) => entry.frozen),
      message,
      error,
      seen: frozenMap(seen),
      outbox: frozenMap(outbox),
      conflicts: frozenMap(conflicts),
      receipts: receipts,
    });
  }

  let snapshot = build();

  function commit(): void {
    snapshot = build();
    for (const listener of [...listeners]) listener();
  }

  function emit(event: DeviceEvent): void {
    onEvent?.(event);
  }

  function randomBytes(length: number): Uint8Array {
    const bytes = random(length);
    if (bytes.length < length) {
      throw new RangeError('The random source returned too few bytes');
    }
    return bytes.slice(0, length);
  }

  function newOpId(): string {
    return `${prefix}-${hex(randomBytes(OP_ID_BYTES))}`;
  }

  function holdsNote(noteId: string): boolean {
    return seen.has(noteId) || outbox.has(noteId) || conflicts.has(noteId);
  }

  function newNoteId(): string {
    for (let attempt = 0; attempt < NOTE_ID_ATTEMPTS; attempt += 1) {
      const id = `CLM-${hex(randomBytes(NOTE_ID_BYTES)).toUpperCase()}`;
      if (!holdsNote(id)) return id;
    }
    throw new RangeError('The random source kept returning ids already held');
  }

  function pending(op: Operation, frozen: boolean): OutboxEntry {
    return deepFreeze({ op: { ...op }, frozen });
  }

  /** Keeps the seen revision from moving back (a retried receipt can be old). */
  function remember(note: Note): void {
    const known = seen.get(note.note_id);
    if (known === undefined || note.revision >= known.revision) {
      seen.set(note.note_id, deepFreeze({ ...note }));
    }
  }

  function takeReceipt(op: Operation, result: OperationResult): void {
    receiptSeq += 1;
    receipts = [
      deepFreeze({
        seq: receiptSeq,
        op: { ...op },
        result: structuredClone(result),
        resend: false,
      }),
      ...receipts,
    ];
    // Invalid and reused ids also end the operation: it can never succeed.
    if (outbox.get(op.note_id)?.op.op_id === op.op_id) {
      outbox.delete(op.note_id);
    }
    if (result.status === 'created' || result.status === 'updated') {
      remember(result.note);
    } else if (result.status === 'conflito') {
      conflicts.set(op.note_id, deepFreeze(structuredClone(result)));
      if (result.server === null) seen.delete(op.note_id);
      else remember(result.server);
    }
  }

  async function exchange<T>(
    call: () => Promise<unknown>,
    accept: (value: unknown) => value is T,
  ): Promise<Outcome<T>> {
    const startedIn = epoch;
    let outcome: Outcome<T>;
    try {
      const value = await call();
      outcome = accept(value)
        ? { kind: 'ok', value }
        : { kind: 'failed', error: 'The answer did not match the request.' };
    } catch (cause) {
      outcome = { kind: 'failed', error: describeError(cause) };
    }
    if (epoch !== startedIn) return { kind: 'stale' };
    busy = false;
    return outcome;
  }

  function beginRequest(): void {
    busy = true;
    error = null;
    commit();
  }

  /** The one send path: create, edit, resolve, going online and retry. */
  async function send(): Promise<void> {
    const lose = loseNext;
    loseNext = false;
    for (const [noteId, entry] of outbox) {
      if (!entry.frozen) outbox.set(noteId, pending(entry.op, true));
    }
    const request = [...outbox.values()].map((entry) =>
      structuredClone(entry.op),
    );
    beginRequest();

    const outcome = await exchange(
      () => transport.postOperations(structuredClone(request)),
      (value): value is OperationResult[] => answersRequest(value, request),
    );
    if (outcome.kind === 'stale') return;

    if (outcome.kind === 'failed') {
      error = outcome.error;
      message = `The request failed, so ${plural(request.length, 'operation')} stay frozen. Retry sends them unchanged.`;
      commit();
      emit({
        kind: 'send',
        request,
        response: null,
        error: outcome.error,
        discarded: false,
      });
      return;
    }

    if (lose) {
      message = `The server processed ${plural(request.length, 'operation')}, but the response was lost. They stay frozen until you retry.`;
      commit();
      emit({
        kind: 'send',
        request,
        response: outcome.value,
        error: null,
        discarded: true,
      });
      return;
    }

    outcome.value.forEach((result, index) => {
      const op = request[index];
      if (op !== undefined) takeReceipt(op, result);
    });
    const conflicting = outcome.value.filter(
      (result) => result.status === 'conflito',
    ).length;
    message =
      `Sent ${plural(request.length, 'operation')}.` +
      (conflicting > 0
        ? ` ${plural(conflicting, 'conflict')} need a decision.`
        : '');
    commit();
    emit({
      kind: 'send',
      request,
      response: outcome.value,
      error: null,
      discarded: false,
    });
  }

  /** After a local change: send when online, otherwise just publish it. */
  async function flush(): Promise<void> {
    if (online && outbox.size > 0) await send();
    else commit();
  }

  function setLocal(text: string): void {
    message = text;
    error = null;
  }

  const device: Device = {
    getState: () => snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setOnline: async (value) => {
      if (busy) return REFUSED_BUSY;
      if (value === online) return OK;
      online = value;
      setLocal(
        value
          ? 'Online.'
          : 'Offline. Edits stay pending until the device is back online.',
      );
      await flush();
      return OK;
    },

    setLoseNextResponse: (value) => {
      if (value === loseNext) return;
      loseNext = value;
      commit();
    },

    createNote: async (text) => {
      if (busy) return REFUSED_BUSY;
      const noteId = newNoteId();
      outbox.set(
        noteId,
        pending(
          { op_id: newOpId(), note_id: noteId, base_revision: 0, text },
          false,
        ),
      );
      setLocal(`Created ${noteId} on this device.`);
      await flush();
      return { ok: true, noteId };
    },

    editNote: async (noteId, text) => {
      if (busy) return REFUSED_BUSY;
      if (conflicts.has(noteId)) return { ok: false, reason: 'conflict' };
      const entry = outbox.get(noteId);
      if (entry?.frozen) return { ok: false, reason: 'frozen' };
      if (entry) {
        // Replacing the text keeps the op_id and the place in the outbox.
        outbox.set(noteId, pending({ ...entry.op, text }, false));
        setLocal(
          `${entry.op.op_id} is still unsent and now holds the new text.`,
        );
      } else {
        const known = seen.get(noteId);
        if (known === undefined) return { ok: false, reason: 'unknown_note' };
        const op = {
          op_id: newOpId(),
          note_id: noteId,
          base_revision: known.revision,
          text,
        };
        outbox.set(noteId, pending(op, false));
        setLocal(
          `New pending operation ${op.op_id} on base revision ${op.base_revision}.`,
        );
      }
      await flush();
      return OK;
    },

    pull: async () => {
      if (busy) return REFUSED_BUSY;
      if (!online) return { ok: false, reason: 'offline' };
      beginRequest();
      const outcome = await exchange(
        () => transport.getNotes(),
        (value): value is Note[] => isNoteList(value),
      );
      if (outcome.kind === 'stale') return OK;
      if (outcome.kind === 'failed') {
        error = outcome.error;
        commit();
        emit({
          kind: 'pull',
          request: null,
          response: null,
          error: outcome.error,
          discarded: false,
        });
        return OK;
      }
      // A pull shows the server as it is now: it may lower a seen revision,
      // but it never deletes a note, clears a conflict or rebases an operation.
      for (const note of outcome.value)
        seen.set(note.note_id, deepFreeze({ ...note }));
      message = outcome.value.length
        ? `Pulled ${plural(outcome.value.length, 'note')}. Pending operations keep their base revision.`
        : 'The server has no notes yet.';
      commit();
      emit({
        kind: 'pull',
        request: null,
        response: structuredClone(outcome.value),
        error: null,
        discarded: false,
      });
      return OK;
    },

    retry: async () => {
      if (busy) return REFUSED_BUSY;
      if (![...outbox.values()].some((entry) => entry.frozen)) {
        return { ok: false, reason: 'nothing_to_retry' };
      }
      if (!online) return { ok: false, reason: 'offline' };
      await send();
      return OK;
    },

    resend: async (seq) => {
      if (busy) return REFUSED_BUSY;
      if (!online) return { ok: false, reason: 'offline' };
      const original = receipts.find((receipt) => receipt.seq === seq);
      if (original === undefined)
        return { ok: false, reason: 'unknown_receipt' };
      const request = [structuredClone(original.op)];
      beginRequest();
      const outcome = await exchange(
        () => transport.postOperations(structuredClone(request)),
        (value): value is OperationResult[] => answersRequest(value, request),
      );
      if (outcome.kind === 'stale') return OK;
      if (outcome.kind === 'failed') {
        error = outcome.error;
        commit();
        emit({
          kind: 'resend',
          request,
          response: null,
          error: outcome.error,
          discarded: false,
        });
        return OK;
      }
      const result = outcome.value[0];
      if (result === undefined) return OK;
      receiptSeq += 1;
      receipts = [
        deepFreeze({
          seq: receiptSeq,
          op: { ...original.op },
          result: structuredClone(result),
          resend: true,
        }),
        ...receipts,
      ];
      // A resent receipt is only displayed: seen, outbox and conflicts stay.
      message =
        JSON.stringify(result) === JSON.stringify(original.result)
          ? `Resent ${original.op.op_id}: the server returned the original receipt and applied nothing.`
          : `Resent ${original.op.op_id}: the answer differs from the original receipt.`;
      commit();
      emit({
        kind: 'resend',
        request,
        response: outcome.value,
        error: null,
        discarded: false,
      });
      return OK;
    },

    resolve: async (noteId, resolution) => {
      if (busy) return REFUSED_BUSY;
      const conflict = conflicts.get(noteId);
      if (conflict === undefined) return { ok: false, reason: 'no_conflict' };
      conflicts.delete(noteId);
      if (resolution.mode === 'discard') {
        setLocal(`Discarded the proposal for ${noteId}.`);
        commit();
        return OK;
      }
      const text =
        resolution.mode === 'mine' ? conflict.proposal.text : resolution.text;
      // The base is the one the conflict reported, even if a pull moved `seen`.
      const base = conflict.server === null ? 0 : conflict.server.revision;
      const op = {
        op_id: newOpId(),
        note_id: noteId,
        base_revision: base,
        text,
      };
      outbox.set(noteId, pending(op, false));
      setLocal(`Resolution ${op.op_id} is pending on base revision ${base}.`);
      await flush();
      return OK;
    },

    reset: () => {
      epoch += 1;
      online = true;
      loseNext = false;
      busy = false;
      message = '';
      error = null;
      receiptSeq = 0;
      seen.clear();
      outbox.clear();
      conflicts.clear();
      receipts = [];
      commit();
    },
  };

  return device;
}
