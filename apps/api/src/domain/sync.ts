import {
  operationSchema,
  type ConflictResult,
  type InvalidResult,
  type Note,
  type Operation,
  type OperationResult,
  type StoredResult,
} from './model';
import type { SyncStore } from './store';

/**
 * Decides one valid operation against the current note. Pure: it reads
 * nothing but its arguments and returns the result plus the note to write,
 * if any.
 */
export function decideOperation(
  note: Note | undefined,
  op: Operation,
): { result: StoredResult; nextNote?: Note } {
  const proposal = { base_revision: op.base_revision, text: op.text };

  if (note === undefined) {
    if (op.base_revision === 0) {
      const created: Note = { note_id: op.note_id, revision: 1, text: op.text };
      return {
        result: { op_id: op.op_id, status: 'created', note: { ...created } },
        nextNote: created,
      };
    }
    return {
      result: conflict(op, 'note_not_found', null, proposal),
    };
  }

  if (op.base_revision !== note.revision) {
    return {
      result: conflict(op, 'revision_mismatch', { ...note }, proposal),
    };
  }

  const updated: Note = {
    note_id: note.note_id,
    revision: note.revision + 1,
    text: op.text,
  };
  return {
    result: { op_id: op.op_id, status: 'updated', note: { ...updated } },
    nextNote: updated,
  };
}

function conflict(
  op: Operation,
  reason: ConflictResult['reason'],
  server: Note | null,
  proposal: ConflictResult['proposal'],
): ConflictResult {
  return {
    op_id: op.op_id,
    status: 'conflito',
    reason,
    note_id: op.note_id,
    server,
    proposal,
  };
}

function invalid(item: unknown, reason: string): InvalidResult {
  if (
    typeof item === 'object' &&
    item !== null &&
    !Array.isArray(item) &&
    Object.hasOwn(item, 'op_id')
  ) {
    const opId = (item as Record<string, unknown>)['op_id'];
    if (typeof opId === 'string') {
      return { op_id: opId, status: 'invalid', reason };
    }
  }
  return { status: 'invalid', reason };
}

function processOne(store: SyncStore, item: unknown): OperationResult {
  // Validity first: an invalid operation is never looked up and never stored.
  const parsed = operationSchema.safeParse(item);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      )
      .join('; ');
    return invalid(item, reason);
  }
  const op = parsed.data;

  const receipt = store.receipts.get(op.op_id);
  if (receipt !== undefined) {
    const same =
      receipt.content.note_id === op.note_id &&
      receipt.content.base_revision === op.base_revision &&
      receipt.content.text === op.text;
    // A replay returns the original receipt; different content stores nothing.
    return same
      ? structuredClone(receipt.result)
      : { op_id: op.op_id, status: 'id_reutilizado' };
  }

  const { result, nextNote } = decideOperation(store.notes.get(op.note_id), op);
  if (nextNote !== undefined) {
    store.notes.set(op.note_id, nextNote);
  }
  store.receipts.set(op.op_id, {
    content: {
      note_id: op.note_id,
      base_revision: op.base_revision,
      text: op.text,
    },
    result: structuredClone(result),
  });
  return result;
}

/**
 * Processes a batch in order and synchronously, with one result per item.
 * Nothing is awaited between reading a note and writing it.
 */
export function processOperations(
  store: SyncStore,
  items: readonly unknown[],
): OperationResult[] {
  return items.map((item) => processOne(store, item));
}

/** The current notes, sorted by `note_id` in code-unit order. */
export function listNotes(store: SyncStore): Note[] {
  return [...store.notes.values()]
    .sort((a, b) =>
      a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : 0,
    )
    .map((note) => ({ ...note }));
}

export function getNote(store: SyncStore, noteId: string): Note | undefined {
  const note = store.notes.get(noteId);
  return note === undefined ? undefined : { ...note };
}

export function countReceipts(store: SyncStore): number {
  return store.receipts.size;
}
