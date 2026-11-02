import { describe, expect, it } from 'vitest';
import rawExamples from '../../../../docs/contract/results.json';
import type {
  ContractExamples,
  Operation,
  OperationResult,
} from '../api-client/contract';
import { createDevice } from './device';

// The same file is read by the API tests, so both sides share one set of shapes.

// A JSON import types its strings as `string`, so the literal types of the
// contract (`'created'`, `null`) are widened before the two are compared.
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends readonly (infer Item)[]
      ? Widen<Item>[]
      : T extends object
        ? { [Key in keyof T]: Widen<T[Key]> }
        : T;

/** A type error unless `T` is `true`. */
type Assert<T extends true> = T;

/** True only when each type is assignable to the other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Fails `pnpm typecheck` when the JSON examples and `ContractExamples` differ
 * in a key name, a missing or an extra required key, or the kind of a value.
 * It cannot see the literal text of `status` and `reason`, an extra key the
 * type declares as optional, or a key that is optional in the type and absent
 * from the JSON; the tests below cover the literal values at run time.
 */
export type ExamplesMatchTypes = Assert<
  Mutual<typeof rawExamples, Widen<ContractExamples>>
>;

const examples = rawExamples as ContractExamples;

/**
 * The example as the server would answer the request, with only the value of
 * its own `op_id` replaced. It refuses an example that has no `op_id` key, so
 * a rename in the file cannot be hidden by adding the key back.
 */
function answering<T extends { op_id: string }>(example: T, opId: string): T {
  if (!Object.hasOwn(example, 'op_id')) {
    throw new Error('the example has no op_id key');
  }
  return { ...example, op_id: opId };
}

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

/** A device whose server answers every request with `answer`, keeping the op_id. */
function deviceAnswering(answer: (op: Operation) => OperationResult) {
  return createDevice({
    prefix: 'adj',
    random: (length) => Uint8Array.from({ length }, (_, i) => i + 1),
    transport: {
      postOperations: (ops) => Promise.resolve(ops.map(answer)),
      getNotes: () => Promise.resolve(examples.notes),
    },
  });
}

describe('shared HTTP contract examples', () => {
  it('holds one example of each wire shape', () => {
    expect(sortedKeys(examples)).toEqual([
      'conflito_note_not_found',
      'conflito_revision_mismatch',
      'created',
      'id_reutilizado',
      'invalid_with_op_id',
      'invalid_without_op_id',
      'note',
      'notes',
      'operation',
      'receipt_count',
      'updated',
    ]);
    expect(examples.note.note_id).toBe('CLM-1042');
    expect(examples.conflito_note_not_found.server).toBeNull();
    expect('op_id' in examples.invalid_without_op_id).toBe(false);
  });

  it('has exactly the keys of the contract in every example, nested ones too', () => {
    const noteKeys = ['note_id', 'revision', 'text'];
    const proposalKeys = ['base_revision', 'text'];
    const conflictKeys = [
      'note_id',
      'op_id',
      'proposal',
      'reason',
      'server',
      'status',
    ];
    expect(examples.notes).toHaveLength(1);
    const cases: [string, object, string[]][] = [
      [
        'operation',
        examples.operation,
        ['base_revision', 'note_id', 'op_id', 'text'],
      ],
      ['note', examples.note, noteKeys],
      ['notes[0]', examples.notes[0] ?? {}, noteKeys],
      ['receipt_count', examples.receipt_count, ['count']],
      ['created', examples.created, ['note', 'op_id', 'status']],
      ['created.note', examples.created.note, noteKeys],
      ['updated', examples.updated, ['note', 'op_id', 'status']],
      ['updated.note', examples.updated.note, noteKeys],
      [
        'conflito_revision_mismatch',
        examples.conflito_revision_mismatch,
        conflictKeys,
      ],
      [
        'conflito_revision_mismatch.server',
        examples.conflito_revision_mismatch.server,
        noteKeys,
      ],
      [
        'conflito_revision_mismatch.proposal',
        examples.conflito_revision_mismatch.proposal,
        proposalKeys,
      ],
      [
        'conflito_note_not_found',
        examples.conflito_note_not_found,
        conflictKeys,
      ],
      [
        'conflito_note_not_found.proposal',
        examples.conflito_note_not_found.proposal,
        proposalKeys,
      ],
      ['id_reutilizado', examples.id_reutilizado, ['op_id', 'status']],
      [
        'invalid_with_op_id',
        examples.invalid_with_op_id,
        ['op_id', 'reason', 'status'],
      ],
      [
        'invalid_without_op_id',
        examples.invalid_without_op_id,
        ['reason', 'status'],
      ],
    ];
    for (const [name, example, keys] of cases) {
      expect(sortedKeys(example), name).toEqual(keys);
    }
  });

  it('applies created and updated examples to what the device has seen', async () => {
    for (const example of [examples.created, examples.updated]) {
      const device = deviceAnswering((op) => answering(example, op.op_id));
      await device.createNote('text');
      const state = device.getState();
      expect(state.seen.get(example.note.note_id)).toEqual(example.note);
      expect(state.outbox.size).toBe(0);
      expect(state.receipts[0]?.result.status).toBe(example.status);
    }
  });

  it('keeps the revision_mismatch example as a conflict with both texts', async () => {
    const example = examples.conflito_revision_mismatch;
    const device = deviceAnswering((op) => answering(example, op.op_id));
    await device.createNote('text');
    const state = device.getState();
    expect(state.conflicts.get(op(state))).toMatchObject({
      server: example.server,
      proposal: example.proposal,
    });
    expect(state.seen.get(example.server.note_id)).toEqual(example.server);
  });

  it('keeps the note_not_found example as a conflict with no server note', async () => {
    const example = examples.conflito_note_not_found;
    const device = deviceAnswering((o) => answering(example, o.op_id));
    await device.createNote('text');
    const state = device.getState();
    const conflict = state.conflicts.get(op(state));
    expect(conflict).toMatchObject({ reason: 'note_not_found', server: null });
    expect(state.seen.size).toBe(0);
  });

  it('drops the operation on the id_reutilizado and invalid examples', async () => {
    const reused = deviceAnswering((o) =>
      answering(examples.id_reutilizado, o.op_id),
    );
    await reused.createNote('text');
    expect(reused.getState().outbox.size).toBe(0);
    expect(reused.getState().receipts[0]?.result.status).toBe('id_reutilizado');

    const invalid = deviceAnswering((o) =>
      answering(examples.invalid_with_op_id, o.op_id),
    );
    await invalid.createNote('text');
    expect(invalid.getState().outbox.size).toBe(0);
    expect(invalid.getState().receipts[0]?.result.status).toBe('invalid');
  });

  it('treats an invalid result without an op_id as a failed request', async () => {
    const device = deviceAnswering(() => examples.invalid_without_op_id);
    await device.createNote('text');
    const state = device.getState();
    expect(state.error).not.toBeNull();
    expect(state.canRetry).toBe(true);
  });

  it('merges the note example on a pull', async () => {
    const device = deviceAnswering((o) => answering(examples.created, o.op_id));
    await device.pull();
    expect(device.getState().seen.get('CLM-1042')).toEqual(examples.note);
  });
});

/** The single conflicted note id of a state. */
function op(
  state: ReturnType<ReturnType<typeof deviceAnswering>['getState']>,
): string {
  const [noteId] = [...state.conflicts.keys()];
  if (noteId === undefined) throw new Error('expected a conflict');
  return noteId;
}
