import { describe, expect, it } from 'vitest';
import type {
  ConflictResult,
  Note,
  Operation,
  OperationResult,
} from '../api-client/contract';
import {
  createDevice,
  type Device,
  type DeviceEvent,
  type RandomSource,
  type Transport,
} from './device';

// ---- Test helpers ----

/** Small deterministic generator (mulberry32) behind the injected source. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (length) =>
    Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

/** A server that returns the documented result shapes, with Map stores. */
class FakeServer {
  notes = new Map<string, Note>();
  receipts = new Map<
    string,
    { content: Omit<Operation, 'op_id'>; result: OperationResult }
  >();
  batches: Operation[][] = [];

  post(batch: Operation[]): OperationResult[] {
    this.batches.push(structuredClone(batch));
    return batch.map((op) => this.one(op));
  }

  list(): Note[] {
    return [...this.notes.values()].map((note) => ({ ...note }));
  }

  private one(op: Operation): OperationResult {
    const content = {
      note_id: op.note_id,
      base_revision: op.base_revision,
      text: op.text,
    };
    const stored = this.receipts.get(op.op_id);
    if (stored) {
      return JSON.stringify(stored.content) === JSON.stringify(content)
        ? structuredClone(stored.result)
        : { op_id: op.op_id, status: 'id_reutilizado' };
    }
    const result = this.apply(op);
    this.receipts.set(op.op_id, { content, result: structuredClone(result) });
    return result;
  }

  private apply(op: Operation): OperationResult {
    const proposal = { base_revision: op.base_revision, text: op.text };
    const note = this.notes.get(op.note_id);
    if (!note) {
      if (op.base_revision === 0) {
        const created = { note_id: op.note_id, revision: 1, text: op.text };
        this.notes.set(op.note_id, created);
        return { op_id: op.op_id, status: 'created', note: { ...created } };
      }
      return {
        op_id: op.op_id,
        status: 'conflito',
        reason: 'note_not_found',
        note_id: op.note_id,
        server: null,
        proposal,
      };
    }
    if (op.base_revision === note.revision) {
      note.revision += 1;
      note.text = op.text;
      return { op_id: op.op_id, status: 'updated', note: { ...note } };
    }
    return {
      op_id: op.op_id,
      status: 'conflito',
      reason: 'revision_mismatch',
      note_id: op.note_id,
      server: { ...note },
      proposal,
    };
  }
}

/** A transport over the fake server whose answers the test can hold or bend. */
function makeTransport(server: FakeServer) {
  let holder: Promise<void> | null = null;
  let failure: { error: Error; processed: boolean } | null = null;
  let bend: ((results: OperationResult[]) => OperationResult[]) | null = null;
  let posts = 0;

  const transport: Transport = {
    postOperations: async (operations) => {
      posts += 1;
      if (failure && !failure.processed) {
        const { error } = failure;
        failure = null;
        throw error;
      }
      const results = server.post(operations);
      if (failure) {
        const { error } = failure;
        failure = null;
        throw error;
      }
      if (holder) {
        const gate = holder;
        holder = null;
        await gate;
      }
      return bend ? bend(results) : results;
    },
    getNotes: async () => {
      if (holder) {
        const gate = holder;
        holder = null;
        await gate;
      }
      return server.list();
    },
  };

  return {
    transport,
    posts: () => posts,
    /** Holds the next answer; call the returned function to release it. */
    hold(): () => void {
      let release: () => void = () => undefined;
      holder = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNext(message: string, processed = false): void {
      failure = { error: new Error(message), processed };
    },
    bendNext(change: (results: OperationResult[]) => OperationResult[]): void {
      bend = (results) => {
        bend = null;
        return change(results);
      };
    },
  };
}

interface Rig {
  device: Device;
  link: ReturnType<typeof makeTransport>;
  events: DeviceEvent[];
}

function makeDevice(server: FakeServer, prefix: string, seed: number): Rig {
  const link = makeTransport(server);
  const events: DeviceEvent[] = [];
  const device = createDevice({
    prefix,
    transport: link.transport,
    random: seededRandom(seed),
    onEvent: (event) => events.push(event),
  });
  return { device, link, events };
}

async function seedNote(server: FakeServer, text = 'start'): Promise<string> {
  const office = makeDevice(server, 'seed', 99);
  const created = await office.device.createNote(text);
  if (!created.ok) throw new Error('seed failed');
  return created.noteId;
}

function conflictOf(device: Device, noteId: string): ConflictResult {
  const conflict = device.getState().conflicts.get(noteId);
  if (!conflict) throw new Error('expected a conflict');
  return conflict;
}

// ---- Tests ----

describe('outbox while offline', () => {
  it('keeps one pending operation per note and replaces its text', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 1);
    await device.setOnline(false);
    const created = await device.createNote('first');
    if (!created.ok) throw new Error('create refused');
    const before = device.getState().outbox.get(created.noteId);

    await device.editNote(created.noteId, 'second');
    const state = device.getState();
    expect(state.outbox.size).toBe(1);
    const entry = state.outbox.get(created.noteId);
    expect(entry?.op.text).toBe('second');
    expect(entry?.op.op_id).toBe(before?.op.op_id);
    expect(entry?.frozen).toBe(false);
    expect(server.batches).toHaveLength(0);
  });

  it('sends the whole outbox as one batch in creation order when back online', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 2);
    await device.setOnline(false);
    const a = await device.createNote('note a');
    const b = await device.createNote('note b');
    if (!a.ok || !b.ok) throw new Error('create refused');
    await device.editNote(a.noteId, 'note a, edited');

    await device.setOnline(true);
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0]?.map((op) => [op.note_id, op.text])).toEqual([
      [a.noteId, 'note a, edited'],
      [b.noteId, 'note b'],
    ]);
    const state = device.getState();
    expect(state.outbox.size).toBe(0);
    expect(state.receipts).toHaveLength(2);
    expect(state.canRetry).toBe(false);
  });
});

describe('sending', () => {
  it('sends an online edit right away and updates what the device saw', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 3);
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');
    await device.editNote(created.noteId, 'edited');

    expect(server.notes.get(created.noteId)).toMatchObject({
      revision: 2,
      text: 'edited',
    });
    const state = device.getState();
    expect(state.seen.get(created.noteId)).toEqual({
      note_id: created.noteId,
      revision: 2,
      text: 'edited',
    });
    expect(state.receipts.map((r) => r.result.status)).toEqual([
      'updated',
      'created',
    ]);
    expect(state.receipts.map((r) => r.seq)).toEqual([2, 1]);
  });

  it('freezes a sent operation until its receipt arrives', async () => {
    const server = new FakeServer();
    const { device, link } = makeDevice(server, 'adj', 4);
    const release = link.hold();
    const pending = device.createNote('opened');

    const during = device.getState();
    expect(during.busy).toBe(true);
    expect([...during.outbox.values()].map((e) => e.frozen)).toEqual([true]);
    expect(during.canRetry).toBe(true);

    release();
    await pending;
    const after = device.getState();
    expect(after.busy).toBe(false);
    expect(after.outbox.size).toBe(0);
    expect(after.canRetry).toBe(false);
  });
});

describe('pull', () => {
  it('never changes the base revision of a pending operation', async () => {
    const server = new FakeServer();
    const noteId = await seedNote(server, 'v1');
    const { device } = makeDevice(server, 'adj', 5);
    await device.pull();
    await device.setOnline(false);
    await device.editNote(noteId, 'adjuster edit');
    const office = makeDevice(server, 'ofc', 6);
    await office.device.pull();
    await office.device.editNote(noteId, 'office edit');

    device.setLoseNextResponse(false);
    // The device is offline, so the pull is refused; go online without a send.
    expect(await device.pull()).toEqual({ ok: false, reason: 'offline' });
    const held = makeDevice(server, 'adj2', 7);
    await held.device.pull();
    expect(held.device.getState().seen.get(noteId)?.revision).toBe(2);

    // Pull on the offline device after it reconnects but before it sends:
    // use a lost response so the outbox survives going online.
    device.setLoseNextResponse(true);
    await device.setOnline(true);
    expect(device.getState().outbox.get(noteId)?.op.base_revision).toBe(1);
    await device.pull();
    const state = device.getState();
    expect(state.seen.get(noteId)?.revision).toBe(2);
    expect(state.outbox.get(noteId)?.op.base_revision).toBe(1);
  });

  it('does not delete a local note or clear a conflict', async () => {
    const server = new FakeServer();
    const noteId = await seedNote(server, 'v1');
    const { device } = makeDevice(server, 'adj', 8);
    await device.pull();
    await device.setOnline(false);
    await device.editNote(noteId, 'mine');
    const office = makeDevice(server, 'ofc', 9);
    await office.device.pull();
    await office.device.editNote(noteId, 'theirs');
    await device.setOnline(true);
    expect(conflictOf(device, noteId).reason).toBe('revision_mismatch');

    server.notes.clear();
    await device.pull();
    expect(device.getState().conflicts.has(noteId)).toBe(true);
    expect(device.getState().seen.has(noteId)).toBe(true);
  });
});

describe('conflicts', () => {
  async function conflicted() {
    const server = new FakeServer();
    const noteId = await seedNote(server, 'v1');
    const rig = makeDevice(server, 'adj', 10);
    await rig.device.pull();
    await rig.device.setOnline(false);
    await rig.device.editNote(noteId, 'adjuster text');
    const office = makeDevice(server, 'ofc', 11);
    await office.device.pull();
    await office.device.editNote(noteId, 'office text');
    await rig.device.setOnline(true);
    return { server, noteId, ...rig };
  }

  it('offers the server text and the proposal, and refreshes seen', async () => {
    const { device, noteId } = await conflicted();
    const conflict = conflictOf(device, noteId);
    expect(conflict).toMatchObject({
      status: 'conflito',
      reason: 'revision_mismatch',
      server: { revision: 2, text: 'office text' },
      proposal: { base_revision: 1, text: 'adjuster text' },
    });
    expect(device.getState().seen.get(noteId)?.revision).toBe(2);
    expect(device.getState().outbox.size).toBe(0);
  });

  it('resolves with a new op_id and the server revision', async () => {
    const { device, server, noteId } = await conflicted();
    const old = conflictOf(device, noteId).op_id;
    expect(
      await device.resolve(noteId, { mode: 'text', text: 'both' }),
    ).toEqual({
      ok: true,
    });
    const sent = server.batches.at(-1)?.[0];
    expect(sent?.op_id).not.toBe(old);
    expect(sent?.base_revision).toBe(2);
    expect(server.notes.get(noteId)).toMatchObject({
      revision: 3,
      text: 'both',
    });
    expect(device.getState().conflicts.size).toBe(0);
  });

  it('resolves with the device text', async () => {
    const { device, server, noteId } = await conflicted();
    await device.resolve(noteId, { mode: 'mine' });
    expect(server.notes.get(noteId)?.text).toBe('adjuster text');
  });

  it('discards the proposal without sending anything', async () => {
    const { device, server, noteId, link } = await conflicted();
    const posts = link.posts();
    await device.resolve(noteId, { mode: 'discard' });
    expect(link.posts()).toBe(posts);
    expect(server.notes.get(noteId)?.text).toBe('office text');
    expect(device.getState().conflicts.size).toBe(0);
  });

  it('uses the conflict base even when a pull moved seen', async () => {
    const { device, server, noteId } = await conflicted();
    const office = makeDevice(server, 'ofc2', 12);
    await office.device.pull();
    await office.device.editNote(noteId, 'office again');
    await device.pull();
    expect(device.getState().seen.get(noteId)?.revision).toBe(3);

    await device.resolve(noteId, { mode: 'mine' });
    expect(server.batches.at(-1)?.[0]?.base_revision).toBe(2);
    expect(conflictOf(device, noteId).server?.revision).toBe(3);
    expect(server.notes.get(noteId)?.text).toBe('office again');
  });

  it('accepts no edit on a note in conflict', async () => {
    const { device, noteId } = await conflicted();
    expect(await device.editNote(noteId, 'nope')).toEqual({
      ok: false,
      reason: 'conflict',
    });
  });

  it('handles note_not_found with base revision 0 on resolution', async () => {
    const server = new FakeServer();
    const noteId = await seedNote(server, 'v1');
    const { device } = makeDevice(server, 'adj', 13);
    await device.pull();
    server.notes.clear();
    await device.editNote(noteId, 'late edit');
    const conflict = conflictOf(device, noteId);
    expect(conflict).toMatchObject({ reason: 'note_not_found', server: null });
    expect(device.getState().seen.has(noteId)).toBe(false);

    await device.resolve(noteId, { mode: 'mine' });
    expect(server.batches.at(-1)?.[0]?.base_revision).toBe(0);
    expect(server.notes.get(noteId)).toMatchObject({
      revision: 1,
      text: 'late edit',
    });
  });
});

describe('lost responses and failures', () => {
  it('keeps operations frozen and retry returns the stored receipt', async () => {
    const server = new FakeServer();
    const { device, events } = makeDevice(server, 'adj', 14);
    device.setLoseNextResponse(true);
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');

    expect(server.notes.get(created.noteId)?.revision).toBe(1);
    let state = device.getState();
    expect(state.loseNextResponse).toBe(false);
    expect(state.canRetry).toBe(true);
    expect(state.outbox.get(created.noteId)?.frozen).toBe(true);
    expect(state.receipts).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ kind: 'send', discarded: true });
    expect(await device.editNote(created.noteId, 'x')).toEqual({
      ok: false,
      reason: 'frozen',
    });

    await device.retry();
    state = device.getState();
    expect(server.notes.get(created.noteId)?.revision).toBe(1);
    expect(server.receipts.size).toBe(1);
    expect(state.canRetry).toBe(false);
    expect(state.receipts[0]?.result.status).toBe('created');
  });

  it('applies the lost response only to a send, not to pull or resend', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 15);
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');
    device.setLoseNextResponse(true);
    await device.pull();
    await device.resend(1);
    expect(device.getState().loseNextResponse).toBe(true);
    expect(device.getState().receipts).toHaveLength(2);
  });

  it('never lowers the revision seen on a stale receipt', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 16);
    device.setLoseNextResponse(true);
    const created = await device.createNote('v1');
    if (!created.ok) throw new Error('create refused');
    const office = makeDevice(server, 'ofc', 17);
    await office.device.pull();
    await office.device.editNote(created.noteId, 'v2');
    await device.pull();
    expect(device.getState().seen.get(created.noteId)?.revision).toBe(2);

    await device.retry();
    expect(device.getState().receipts[0]?.result).toMatchObject({
      status: 'created',
      note: { revision: 1 },
    });
    expect(device.getState().seen.get(created.noteId)?.revision).toBe(2);
  });

  it('treats a wrong number of results as a failed request', async () => {
    const server = new FakeServer();
    const { device, link } = makeDevice(server, 'adj', 18);
    link.bendNext(() => []);
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');
    const state = device.getState();
    expect(state.error).not.toBeNull();
    expect(state.canRetry).toBe(true);
    expect(state.receipts).toHaveLength(0);
    expect(state.outbox.get(created.noteId)?.frozen).toBe(true);
  });

  it('treats a different op_id as a failed request', async () => {
    const server = new FakeServer();
    const { device, link } = makeDevice(server, 'adj', 19);
    link.bendNext((results) =>
      results.map((r) => ({ ...r, op_id: 'someone-else' })),
    );
    await device.createNote('opened');
    const state = device.getState();
    expect(state.error).not.toBeNull();
    expect(state.canRetry).toBe(true);
    expect(state.seen.size).toBe(0);
  });

  it('treats a rejected request like a lost response', async () => {
    const server = new FakeServer();
    const { device, link, events } = makeDevice(server, 'adj', 20);
    link.failNext('timeout');
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');
    let state = device.getState();
    expect(state.error).toBe('timeout');
    expect(state.canRetry).toBe(true);
    expect(events.at(-1)).toMatchObject({ error: 'timeout', response: null });

    await device.retry();
    state = device.getState();
    expect(state.error).toBeNull();
    expect(state.outbox.size).toBe(0);
    expect(server.notes.get(created.noteId)?.revision).toBe(1);
  });

  it('retries safely when the server processed a rejected request', async () => {
    const server = new FakeServer();
    const { device, link } = makeDevice(server, 'adj', 21);
    link.failNext('socket hang up', true);
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');
    await device.retry();
    expect(server.notes.get(created.noteId)?.revision).toBe(1);
    expect(server.receipts.size).toBe(1);
  });

  it('sets an error and changes nothing when a pull or resend fails', async () => {
    const server = new FakeServer();
    const { device, link } = makeDevice(server, 'adj', 22);
    await device.createNote('opened');
    const before = device.getState();

    link.failNext('down');
    await device.resend(1);
    let state = device.getState();
    expect(state.error).toBe('down');
    expect(state.receipts).toBe(before.receipts);
    expect(state.seen).toEqual(before.seen);

    const failingPull = createDevice({
      prefix: 'adj',
      random: seededRandom(1),
      transport: {
        postOperations: () => Promise.resolve([]),
        getNotes: () => Promise.reject(new Error('no route')),
      },
    });
    await failingPull.pull();
    state = failingPull.getState();
    expect(state.error).toBe('no route');
    expect(state.seen.size).toBe(0);
  });
});

describe('resend', () => {
  it('lists the original receipt marked resend and touches nothing else', async () => {
    const server = new FakeServer();
    const noteId = await seedNote(server, 'v1');
    const { device } = makeDevice(server, 'adj', 23);
    await device.pull();
    await device.setOnline(false);
    await device.editNote(noteId, 'mine');
    const office = makeDevice(server, 'ofc', 24);
    await office.device.pull();
    await office.device.editNote(noteId, 'theirs');
    await device.setOnline(true);
    await device.resolve(noteId, { mode: 'discard' });
    await office.device.editNote(noteId, 'theirs again');
    await device.pull();
    const before = device.getState();
    const conflictReceipt = before.receipts.find(
      (r) => r.result.status === 'conflito',
    );
    if (!conflictReceipt) throw new Error('expected a conflict receipt');

    await device.resend(conflictReceipt.seq);
    const after = device.getState();
    expect(after.receipts[0]).toMatchObject({
      resend: true,
      op: conflictReceipt.op,
      result: conflictReceipt.result,
    });
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect(after.seen).toEqual(before.seen);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.conflicts).toEqual(before.conflicts);
    expect(server.notes.get(noteId)?.revision).toBe(3);
  });
});

describe('busy and reset', () => {
  it('refuses every action but reset and the lose switch while in flight', async () => {
    const server = new FakeServer();
    const { device, link } = makeDevice(server, 'adj', 25);
    const noteId = await seedNote(server, 'v1');
    await device.pull();
    const release = link.hold();
    const flight = device.editNote(noteId, 'slow');
    expect(device.getState().busy).toBe(true);

    const busy = { ok: false, reason: 'busy' };
    expect(await device.setOnline(false)).toEqual(busy);
    expect(await device.createNote('x')).toEqual(busy);
    expect(await device.editNote(noteId, 'y')).toEqual(busy);
    expect(await device.pull()).toEqual(busy);
    expect(await device.retry()).toEqual(busy);
    expect(await device.resend(1)).toEqual(busy);
    expect(await device.resolve(noteId, { mode: 'discard' })).toEqual(busy);
    device.setLoseNextResponse(true);
    expect(device.getState().loseNextResponse).toBe(true);

    release();
    await flight;
    expect(device.getState().busy).toBe(false);
  });

  it('ignores a response that arrives after a reset', async () => {
    const server = new FakeServer();
    const { device, link, events } = makeDevice(server, 'adj', 27);
    const release = link.hold();
    const flight = device.createNote('opened');
    expect(device.getState().busy).toBe(true);
    device.reset();
    expect(device.getState().busy).toBe(false);
    release();
    await flight;
    const state = device.getState();
    expect(state.receipts).toHaveLength(0);
    expect(state.seen.size).toBe(0);
    expect(state.outbox.size).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('restores the start state: online with the lose switch off', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 28);
    await device.createNote('opened');
    await device.setOnline(false);
    device.setLoseNextResponse(true);
    device.reset();
    const state = device.getState();
    expect(state).toMatchObject({
      online: true,
      loseNextResponse: false,
      busy: false,
      canRetry: false,
      error: null,
      message: '',
    });
    expect(state.seen.size + state.outbox.size + state.conflicts.size).toBe(0);
    expect(state.receipts).toHaveLength(0);
  });
});

describe('receipts that end an operation', () => {
  it.each([
    [
      'invalid',
      (op: Operation): OperationResult => ({
        op_id: op.op_id,
        status: 'invalid',
        reason: 'text must be a string',
      }),
    ],
    [
      'id_reutilizado',
      (op: Operation): OperationResult => ({
        op_id: op.op_id,
        status: 'id_reutilizado',
      }),
    ],
  ])(
    'drops the operation on %s and changes nothing else',
    async (status, make) => {
      const server = new FakeServer();
      const noteId = await seedNote(server, 'v1');
      const { device, link } = makeDevice(server, 'adj', 29);
      await device.pull();
      const seenBefore = device.getState().seen;
      link.bendNext((results) =>
        results.map((r, i) =>
          make({ ...(server.batches.at(-1)?.[i] as Operation) }),
        ),
      );
      await device.editNote(noteId, 'edit');
      const state = device.getState();
      expect(state.outbox.size).toBe(0);
      expect(state.receipts[0]?.result.status).toBe(status);
      expect(state.seen).toEqual(seenBefore);
      expect(state.conflicts.size).toBe(0);
    },
  );
});

describe('ids', () => {
  it('builds op_ids from the prefix and 64 random bits, and note_ids as claim numbers', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 30);
    const created = await device.createNote('opened');
    if (!created.ok) throw new Error('create refused');
    expect(created.noteId).toMatch(/^CLM-[0-9A-F]{8}$/);
    expect(server.batches[0]?.[0]?.op_id).toMatch(/^adj-[0-9a-f]{16}$/);
  });

  it('is unique across both devices and across a re-created device', async () => {
    const server = new FakeServer();
    const opIds = new Set<string>();
    const noteIds = new Set<string>();
    const random = seededRandom(31);
    let total = 0;
    for (const prefix of ['adj', 'ofc', 'adj']) {
      // The same prefix twice stands for a re-created device state.
      const link = makeTransport(server);
      const device = createDevice({
        prefix,
        transport: link.transport,
        random,
      });
      await device.setOnline(false);
      for (let i = 0; i < 50; i += 1) {
        const created = await device.createNote(`note ${i}`);
        if (!created.ok) throw new Error('create refused');
        noteIds.add(created.noteId);
        total += 1;
      }
      for (const entry of device.getState().outbox.values()) {
        opIds.add(entry.op.op_id);
      }
    }
    expect(opIds.size).toBe(total);
    expect(noteIds.size).toBe(total);
  });

  it('retries a note_id the device already holds', async () => {
    const server = new FakeServer();
    const bytes = [
      [0xab, 0xcd, 0x01, 0x23], // note id
      [1, 2, 3, 4, 5, 6, 7, 8], // op id
      [0xab, 0xcd, 0x01, 0x23], // same note id again
      [0x00, 0x00, 0x00, 0x09], // fresh note id
      [8, 7, 6, 5, 4, 3, 2, 1],
    ];
    let call = 0;
    const link = makeTransport(server);
    const device = createDevice({
      prefix: 'adj',
      transport: link.transport,
      random: () => Uint8Array.from(bytes[call++] ?? [0, 0, 0, 0, 0, 0, 0, 0]),
    });
    await device.setOnline(false);
    const first = await device.createNote('one');
    const second = await device.createNote('two');
    expect(first).toEqual({ ok: true, noteId: 'CLM-ABCD0123' });
    expect(second).toEqual({ ok: true, noteId: 'CLM-00000009' });
  });

  it('treats constructor and __proto__ as ordinary ids', async () => {
    const server = new FakeServer();
    server.notes.set('__proto__', {
      note_id: '__proto__',
      revision: 1,
      text: 'a',
    });
    server.notes.set('constructor', {
      note_id: 'constructor',
      revision: 1,
      text: 'b',
    });
    const { device } = makeDevice(server, 'adj', 32);
    await device.pull();
    expect(device.getState().seen.get('__proto__')?.text).toBe('a');
    await device.editNote('__proto__', 'a2');
    await device.editNote('constructor', 'b2');
    expect(server.notes.get('__proto__')).toMatchObject({
      revision: 2,
      text: 'a2',
    });
    expect(server.notes.get('constructor')).toMatchObject({
      revision: 2,
      text: 'b2',
    });
    expect(device.getState().seen.get('constructor')?.revision).toBe(2);
  });
});

describe('refusals', () => {
  it('names the reason and leaves the snapshot untouched', async () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 33);
    const before = device.getState();
    expect(await device.editNote('CLM-NONE', 'x')).toEqual({
      ok: false,
      reason: 'unknown_note',
    });
    expect(await device.retry()).toEqual({
      ok: false,
      reason: 'nothing_to_retry',
    });
    expect(await device.resolve('CLM-NONE', { mode: 'mine' })).toEqual({
      ok: false,
      reason: 'no_conflict',
    });
    expect(await device.resend(7)).toEqual({
      ok: false,
      reason: 'unknown_receipt',
    });
    await device.setOnline(false);
    const offline = device.getState();
    expect(await device.pull()).toEqual({ ok: false, reason: 'offline' });
    expect(await device.resend(1)).toEqual({ ok: false, reason: 'offline' });
    expect(device.getState()).toBe(offline);
    expect(before).not.toBe(offline);
  });
});

describe('snapshot and events', () => {
  it('returns the same frozen snapshot until something changes', () => {
    const server = new FakeServer();
    const { device } = makeDevice(server, 'adj', 34);
    const first = device.getState();
    expect(device.getState()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() =>
      (first.seen as Map<string, Note>).set('x', {
        note_id: 'x',
        revision: 1,
        text: '',
      }),
    ).toThrow();

    let calls = 0;
    const stop = device.subscribe(() => {
      calls += 1;
    });
    device.setLoseNextResponse(true);
    expect(calls).toBe(1);
    expect(device.getState()).not.toBe(first);
    device.setLoseNextResponse(true);
    expect(calls).toBe(1);
    stop();
    device.setLoseNextResponse(false);
    expect(calls).toBe(1);
  });

  it('reports each request with its response', async () => {
    const server = new FakeServer();
    const { device, events } = makeDevice(server, 'adj', 35);
    await device.createNote('opened');
    await device.pull();
    await device.resend(1);
    expect(events.map((e) => e.kind)).toEqual(['send', 'pull', 'resend']);
    expect(events[0]).toMatchObject({ error: null, discarded: false });
    expect(events[0]?.response).toHaveLength(1);
    expect(events[1]?.response).toHaveLength(1);
  });
});
