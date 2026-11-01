import { describe, expect, it } from 'vitest';
import {
  countReceipts,
  getNote,
  processOperations,
} from '../../src/domain/sync';
import { createInMemoryStore } from '../../src/infrastructure/in-memory-store';

const op = (
  op_id: string,
  base_revision: number,
  text: string,
  note_id = 'N',
) => ({ op_id, note_id, base_revision, text });

describe('required scenarios', () => {
  it('processes a valid operation that reuses the op_id of an invalid one (catches storing invalid operations)', () => {
    const store = createInMemoryStore();
    const results = processOperations(store, [
      { op_id: 'X', note_id: 'N', base_revision: -1, text: 'bad' },
      op('X', 0, 'good'),
    ]);

    expect(results[0]).toMatchObject({ op_id: 'X', status: 'invalid' });
    expect(results[1]).toStrictEqual({
      op_id: 'X',
      status: 'created',
      note: { note_id: 'N', revision: 1, text: 'good' },
    });
    expect(countReceipts(store)).toBe(1);
  });

  it('returns the revision-2 conflict on a late resend while the query shows revision 3 (catches recomputing receipts)', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('O1', 0, 'start'), op('O2', 1, 'A')]);
    const [original] = processOperations(store, [op('O3', 1, 'B')]);
    processOperations(store, [op('O4', 2, 'A + B')]);

    const [resend] = processOperations(store, [op('O3', 1, 'B')]);

    expect(resend).toStrictEqual(original);
    expect(resend).toMatchObject({
      status: 'conflito',
      server: { revision: 2, text: 'A' },
    });
    expect(getNote(store, 'N')).toStrictEqual({
      note_id: 'N',
      revision: 3,
      text: 'A + B',
    });
  });

  it('reports base revision 0 on an existing note as a conflict and leaves the note alone (catches a create that overwrites)', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('O1', 0, 'start')]);

    const [result] = processOperations(store, [op('O2', 0, 'overwrite')]);

    expect(result).toStrictEqual({
      op_id: 'O2',
      status: 'conflito',
      reason: 'revision_mismatch',
      note_id: 'N',
      server: { note_id: 'N', revision: 1, text: 'start' },
      proposal: { base_revision: 0, text: 'overwrite' },
    });
    expect(getNote(store, 'N')).toStrictEqual({
      note_id: 'N',
      revision: 1,
      text: 'start',
    });
  });
});

describe('rule interactions', () => {
  it('answers invalid for an invalid operation whose op_id is already used', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'one')]);

    const [result] = processOperations(store, [
      { op_id: 'A', note_id: 'N', base_revision: 'x', text: 'one' },
    ]);

    expect(result).toMatchObject({ op_id: 'A', status: 'invalid' });
  });

  it('keeps the original receipt after id_reutilizado', () => {
    const store = createInMemoryStore();
    const [original] = processOperations(store, [op('A', 0, 'one')]);

    const [reused] = processOperations(store, [op('A', 0, 'two')]);
    const [again] = processOperations(store, [op('A', 0, 'one')]);

    expect(reused).toStrictEqual({ op_id: 'A', status: 'id_reutilizado' });
    expect(again).toStrictEqual(original);
    expect(countReceipts(store)).toBe(1);
  });

  it('treats a different note_id with the same op_id as a different content', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'one', 'N1')]);

    const [result] = processOperations(store, [op('A', 0, 'one', 'N2')]);

    expect(result).toStrictEqual({ op_id: 'A', status: 'id_reutilizado' });
    expect(getNote(store, 'N2')).toBeUndefined();
  });

  it('compares text exactly, with no trimming or case folding', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'one')]);

    expect(processOperations(store, [op('A', 0, 'one ')])[0]).toStrictEqual({
      op_id: 'A',
      status: 'id_reutilizado',
    });
    expect(processOperations(store, [op('A', 0, 'ONE')])[0]).toStrictEqual({
      op_id: 'A',
      status: 'id_reutilizado',
    });
  });

  it('increments the revision for an accepted change with the same text', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'same')]);

    const [result] = processOperations(store, [op('B', 1, 'same')]);

    expect(result).toMatchObject({
      status: 'updated',
      note: { revision: 2, text: 'same' },
    });
  });

  it('does not change the revision on a conflict', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'one'), op('B', 1, 'two')]);

    processOperations(store, [op('C', 1, 'three')]);

    expect(getNote(store, 'N')?.revision).toBe(2);
  });

  it('resolves a conflict with a new op_id, never with the conflicted one', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'one'), op('B', 1, 'two')]);
    const [conflict] = processOperations(store, [op('C', 1, 'mine')]);
    if (conflict?.status !== 'conflito' || conflict.server === null) {
      throw new Error('expected a conflict with server data');
    }

    const [reused] = processOperations(store, [
      op('C', conflict.server.revision, 'mine'),
    ]);
    const [resolved] = processOperations(store, [
      op('D', conflict.server.revision, 'mine'),
    ]);

    expect(reused).toStrictEqual({ op_id: 'C', status: 'id_reutilizado' });
    expect(resolved).toStrictEqual({
      op_id: 'D',
      status: 'updated',
      note: { note_id: 'N', revision: 3, text: 'mine' },
    });
  });

  it('gives the first receipt to the same op_id twice in one batch', () => {
    const store = createInMemoryStore();

    const results = processOperations(store, [
      op('A', 0, 'one'),
      op('A', 0, 'one'),
    ]);

    expect(results[1]).toStrictEqual(results[0]);
    expect(getNote(store, 'N')?.revision).toBe(1);
    expect(countReceipts(store)).toBe(1);
  });

  it('answers id_reutilizado for the second occurrence with another content in one batch', () => {
    const store = createInMemoryStore();

    const results = processOperations(store, [
      op('A', 0, 'one'),
      op('A', 0, 'two'),
    ]);

    expect(results[1]).toStrictEqual({ op_id: 'A', status: 'id_reutilizado' });
  });

  it('returns one result per operation, in order, with an invalid one in the middle', () => {
    const store = createInMemoryStore();

    const results = processOperations(store, [
      op('A', 0, 'one'),
      { nonsense: true },
      op('B', 1, 'two'),
    ]);

    expect(results.map((r) => r.status)).toStrictEqual([
      'created',
      'invalid',
      'updated',
    ]);
    expect(getNote(store, 'N')?.revision).toBe(2);
  });

  it('keeps the stored receipt unchanged when a returned result is changed', () => {
    const store = createInMemoryStore();
    const [first] = processOperations(store, [op('A', 0, 'one')]);
    if (first?.status !== 'created') throw new Error('expected created');
    first.note.text = 'tampered';
    first.note.revision = 99;

    const [replay] = processOperations(store, [op('A', 0, 'one')]);
    if (replay?.status !== 'created') throw new Error('expected created');
    replay.note.text = 'tampered again';

    expect(processOperations(store, [op('A', 0, 'one')])[0]).toStrictEqual({
      op_id: 'A',
      status: 'created',
      note: { note_id: 'N', revision: 1, text: 'one' },
    });
    expect(getNote(store, 'N')?.text).toBe('one');
  });

  it('keeps a conflict receipt unchanged when its returned server note is changed', () => {
    const store = createInMemoryStore();
    processOperations(store, [op('A', 0, 'one')]);
    const [conflict] = processOperations(store, [op('B', 0, 'mine')]);
    if (conflict?.status !== 'conflito' || conflict.server === null) {
      throw new Error('expected a conflict with server data');
    }
    conflict.server.text = 'tampered';
    conflict.proposal.text = 'tampered';

    expect(processOperations(store, [op('B', 0, 'mine')])[0]).toMatchObject({
      server: { text: 'one' },
      proposal: { text: 'mine' },
    });
  });
});
