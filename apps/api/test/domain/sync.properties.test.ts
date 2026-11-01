import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Note, OperationResult } from '../../src/domain/model';
import {
  countReceipts,
  listNotes,
  processOperations,
} from '../../src/domain/sync';
import { createInMemoryStore } from '../../src/infrastructure/in-memory-store';

/** Small pools make replays, reused ids and conflicts frequent. */
const OP_IDS = ['op-1', 'op-2', 'op-3', 'op-4', 'op-5', 'op-6'];
// `constructor` guards against plain-object lookups of a note id.
const NOTE_IDS = ['constructor', 'claim-1', 'claim-2'];
const TEXTS = ['a', 'b', 'c', ''];

interface ValidOp {
  op_id: string;
  note_id: string;
  base_revision: number;
  text: string;
}

/** Every queue item says by construction whether it is a valid operation. */
type Tagged =
  { kind: 'valid'; item: ValidOp } | { kind: 'invalid'; item: unknown };

const validOp: fc.Arbitrary<ValidOp> = fc.record({
  op_id: fc.constantFrom(...OP_IDS),
  note_id: fc.constantFrom(...NOTE_IDS),
  base_revision: fc.integer({ min: 0, max: 4 }),
  text: fc.constantFrom(...TEXTS),
});

const FIELDS = ['op_id', 'note_id', 'base_revision', 'text'] as const;

const invalidItem: fc.Arbitrary<unknown> = fc.oneof(
  fc.tuple(validOp, fc.constantFrom(...FIELDS)).map(([op, field]) => {
    const rest: Record<string, unknown> = { ...op };
    delete rest[field];
    return rest;
  }),
  validOp.map((op) => ({ ...op, extra: 'x' })),
  fc
    .tuple(validOp, fc.integer({ min: -5, max: -1 }))
    .map(([op, base_revision]) => ({ ...op, base_revision })),
  fc
    .tuple(validOp, fc.constantFrom(0.5, 1.5, 2.25))
    .map(([op, base_revision]) => ({ ...op, base_revision })),
  fc
    .tuple(validOp, fc.constantFrom('0', '1', 'one'))
    .map(([op, base_revision]) => ({ ...op, base_revision })),
  validOp.map((op) => ({ ...op, op_id: '' })),
  validOp.map((op) => ({ ...op, note_id: '' })),
  fc.constantFrom<unknown>(null, 42, 'op-1', true, []),
);

const tagged: fc.Arbitrary<Tagged> = fc.oneof(
  {
    weight: 9,
    arbitrary: validOp.map((item): Tagged => ({ kind: 'valid', item })),
  },
  {
    weight: 1,
    arbitrary: invalidItem.map((item): Tagged => ({ kind: 'invalid', item })),
  },
);

const queue = fc.array(tagged, { maxLength: 30 });

const NUM_RUNS = 300;

function snapshot(store: ReturnType<typeof createInMemoryStore>): Note[] {
  return listNotes(store);
}

function kindOf(result: OperationResult): string {
  return result.status === 'conflito'
    ? `conflito:${result.reason}`
    : result.status;
}

/** What a first-seen valid operation must produce, given the accepted texts. */
function expectedKind(
  accepted: readonly string[] | undefined,
  baseRevision: number,
): string {
  if (accepted === undefined) {
    return baseRevision === 0 ? 'created' : 'conflito:note_not_found';
  }
  return baseRevision === accepted.length
    ? 'updated'
    : 'conflito:revision_mismatch';
}

interface RunSummary {
  kinds: Set<string>;
  sawReplay: boolean;
}

/**
 * Feeds the queue one operation per call and checks every rule against a
 * model built only from the results seen so far.
 */
function runAgainstModel(items: readonly Tagged[]): RunSummary {
  const store = createInMemoryStore();
  const kinds = new Set<string>();
  let sawReplay = false;

  // The first valid occurrence of an op_id fixes its content and its result.
  // The result is cloned at once, so a result that aliases a stored note
  // shows up when the note changes later.
  const first = new Map<
    string,
    { content: ValidOp; result: OperationResult }
  >();
  const accepted = new Map<string, string[]>();

  for (const entry of items) {
    const notesBefore = snapshot(store);
    const receiptsBefore = countReceipts(store);
    const [result] = processOperations(store, [entry.item]);
    expect(result).toBeDefined();
    kinds.add(kindOf(result));

    if (entry.kind === 'invalid') {
      expect(result.status).toBe('invalid');
      expect(snapshot(store)).toStrictEqual(notesBefore);
      expect(countReceipts(store)).toBe(receiptsBefore);
      continue;
    }

    expect(result.status).not.toBe('invalid');
    const op = entry.item;
    const seen = first.get(op.op_id);

    if (seen === undefined) {
      // The model predicts the outcome, so a rule that accepts or rejects the
      // wrong revision fails here rather than feeding the model its own answer.
      expect(kindOf(result)).toBe(
        expectedKind(accepted.get(op.note_id), op.base_revision),
      );
      first.set(op.op_id, { content: op, result: structuredClone(result) });
      expect(countReceipts(store)).toBe(receiptsBefore + 1);
      if (result.status === 'created' || result.status === 'updated') {
        accepted.set(op.note_id, [
          ...(accepted.get(op.note_id) ?? []),
          op.text,
        ]);
      } else {
        expect(snapshot(store)).toStrictEqual(notesBefore);
      }
      continue;
    }

    // Same op_id again: nothing changes, whatever the content.
    expect(snapshot(store)).toStrictEqual(notesBefore);
    expect(countReceipts(store)).toBe(receiptsBefore);
    const sameContent =
      seen.content.note_id === op.note_id &&
      seen.content.base_revision === op.base_revision &&
      seen.content.text === op.text;
    if (sameContent) {
      sawReplay = true;
      expect(result).toStrictEqual(seen.result);
    } else {
      expect(result).toStrictEqual({
        op_id: op.op_id,
        status: 'id_reutilizado',
      });
    }
  }

  // Revision equals the number of accepted changes; the text is exactly the
  // text of the last accepted operation, never a combination.
  const notes = listNotes(store);
  expect(notes.map((note) => note.note_id)).toStrictEqual(
    [...accepted.keys()].sort(),
  );
  for (const note of notes) {
    const texts = accepted.get(note.note_id)!;
    expect(note.revision).toBe(texts.length);
    expect(note.text).toBe(texts[texts.length - 1]);
  }

  // Receipts are verbatim even after later changes to the notes.
  const originals = [...first.values()];
  const replays = processOperations(
    store,
    originals.map((original) => original.content),
  );
  replays.forEach((replay, index) => {
    expect(replay).toStrictEqual(originals[index].result);
  });
  expect(listNotes(store)).toStrictEqual(notes);
  expect(countReceipts(store)).toBe(first.size);

  return { kinds, sawReplay };
}

describe('sync rules over random queues', () => {
  it('keeps revisions, texts, replays and invalid no-ops consistent with the model', () => {
    fc.assert(
      fc.property(queue, (items) => {
        runAgainstModel(items);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns the same results for any prefix of a queue as for the full queue', () => {
    fc.assert(
      fc.property(queue, fc.nat(30), (items, cut) => {
        const prefix = items.slice(0, Math.min(cut, items.length));
        const full = processOperations(
          createInMemoryStore(),
          items.map((entry) => entry.item),
        );
        const partial = processOperations(
          createInMemoryStore(),
          prefix.map((entry) => entry.item),
        );
        expect(partial).toStrictEqual(full.slice(0, prefix.length));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('meets every result kind and a replay, so no property passes by never meeting its case', () => {
    const kinds = new Set<string>();
    let sawReplay = false;
    for (const items of fc.sample(queue, 300)) {
      const summary = runAgainstModel(items);
      summary.kinds.forEach((kind) => kinds.add(kind));
      sawReplay ||= summary.sawReplay;
    }

    expect([...kinds].sort()).toStrictEqual(
      [
        'conflito:note_not_found',
        'conflito:revision_mismatch',
        'created',
        'id_reutilizado',
        'invalid',
        'updated',
      ].sort(),
    );
    expect(sawReplay).toBe(true);
  });
});
