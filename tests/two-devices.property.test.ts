// Random actions on two devices against the real sync rules. It lives in the
// repository-level `tests/` folder because it joins both apps: it imports the
// device from the web app and the domain and store from the API, so neither
// app depends on the other. The transport below calls `processOperations` on
// one in-memory store, so no HTTP is involved.
//
// The expectations come from the actions the generator issued, never from what
// the code under test reports. Every text is `w<action index>`, so a text names
// the action that wrote it. The model records that text as written, discarded
// or replaced from the action alone. The only thing read back from a call is
// whether the device accepted or refused it, because a refused action wrote
// nothing and the person is told so, which is not a silent loss. What the
// devices and the server hold at the end is only compared with the model.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SyncStore } from '../apps/api/src/domain/store';
import { listNotes, processOperations } from '../apps/api/src/domain/sync';
import { createInMemoryStore } from '../apps/api/src/infrastructure/in-memory-store';
import type {
  Note,
  Operation,
  OperationResult,
} from '../apps/web/src/api-client/contract';
import { createDevice, type Device } from '../apps/web/src/device/device';

// ---- Actions ----

/** Small pools make shared notes, stale bases and id clashes frequent. */
const NOTE_POOL = [0, 1] as const;
const DEVICE_COUNT = 2;
const DEVICE_PREFIXES = ['phone', 'office'] as const;
const MODES = ['discard', 'mine', 'text'] as const;

type Mode = (typeof MODES)[number];

type Action =
  | { kind: 'online'; device: number; value: boolean }
  | { kind: 'create'; device: number; note: number }
  | { kind: 'edit'; device: number; note: number }
  | { kind: 'pull'; device: number }
  | { kind: 'retry'; device: number }
  | { kind: 'lose'; device: number }
  | { kind: 'resolve'; device: number; note: number; mode: Mode };

const deviceIndex = fc.integer({ min: 0, max: DEVICE_COUNT - 1 });
const noteIndex = fc.constantFrom(...NOTE_POOL);

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('online' as const),
      device: deviceIndex,
      value: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      device: deviceIndex,
      note: noteIndex,
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('edit' as const),
      device: deviceIndex,
      note: noteIndex,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('pull' as const),
      device: deviceIndex,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('retry' as const),
      device: deviceIndex,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('lose' as const),
      device: deviceIndex,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('resolve' as const),
      device: deviceIndex,
      note: noteIndex,
      mode: fc.constantFrom(...MODES),
    }),
  },
);

const actions = fc.array(action, { minLength: 1, maxLength: 60, size: 'max' });

// ---- Harness ----

/** The id a device makes from the bytes `[0, 0, attempt, note]`. */
function noteIdFor(note: number): string {
  return `CLM-0000000${note}`;
}

interface Stats {
  runs: number;
  conflicts: number;
  lostResponses: number;
  accepted: Record<string, number>;
  resolved: Record<Mode, number>;
}

function newStats(): Stats {
  return {
    runs: 0,
    conflicts: 0,
    lostResponses: 0,
    accepted: {},
    resolved: { discard: 0, mine: 0, text: 0 },
  };
}

/** What the actions alone say about every text, kept per device and note. */
interface Model {
  written: Set<string>;
  /** The person threw the proposal away or replaced it with their own text. */
  discarded: Set<string>;
  /** The same device replaced an unsent offline text on the same note. */
  replaced: Set<string>;
  online: boolean[];
  /** The text each device last wrote for a note: the proposal if it conflicts. */
  lastWritten: Map<string, string>[];
  /** Unsent text a device holds for a note while it is offline. */
  unsent: Map<string, string>[];
}

function newModel(): Model {
  return {
    written: new Set(),
    discarded: new Set(),
    replaced: new Set(),
    online: Array.from({ length: DEVICE_COUNT }, () => true),
    lastWritten: Array.from(
      { length: DEVICE_COUNT },
      () => new Map<string, string>(),
    ),
    unsent: Array.from(
      { length: DEVICE_COUNT },
      () => new Map<string, string>(),
    ),
  };
}

function recordText(
  model: Model,
  device: number,
  noteId: string,
  text: string,
): void {
  if (!model.online[device]) {
    const previous = model.unsent[device]?.get(noteId);
    if (previous !== undefined) model.replaced.add(previous);
    model.unsent[device]?.set(noteId, text);
  }
  model.lastWritten[device]?.set(noteId, text);
  model.written.add(text);
}

interface Harness {
  store: SyncStore;
  devices: Device[];
  /** Makes the next note id the pool note, as far as the device allows. */
  createWith: (
    device: Device,
    note: number,
    text: string,
  ) => ReturnType<Device['createNote']>;
}

function createHarness(stats?: Stats): Harness {
  const store = createInMemoryStore();
  let noteToCreate = 0;
  let attempt = 0;
  let opCounter = 0;

  const transport = {
    // The wire is simulated with a JSON round trip, as fetch would do.
    postOperations: (operations: Operation[]): Promise<OperationResult[]> => {
      const items = JSON.parse(JSON.stringify(operations)) as unknown[];
      const results = processOperations(store, items);
      if (stats) {
        stats.conflicts += results.filter(
          (result) => result.status === 'conflito',
        ).length;
      }
      return Promise.resolve(
        JSON.parse(JSON.stringify(results)) as OperationResult[],
      );
    },
    getNotes: (): Promise<Note[]> =>
      Promise.resolve(JSON.parse(JSON.stringify(listNotes(store))) as Note[]),
  };

  // 4 bytes make a note id: the first try is the pool note the action asked
  // for, later tries (the device already holds it) give other ids.
  // 8 bytes make an op id: a counter, so op ids never repeat.
  const random = (length: number): Uint8Array => {
    if (length === 4) {
      const bytes = Uint8Array.of(0, 0, attempt, noteToCreate);
      attempt += 1;
      return bytes;
    }
    opCounter += 1;
    const bytes = new Uint8Array(length);
    new DataView(bytes.buffer).setUint32(length - 4, opCounter);
    return bytes;
  };

  const devices = DEVICE_PREFIXES.map((prefix) =>
    createDevice({
      prefix,
      transport,
      random,
      onEvent: (event) => {
        if (stats && event.kind !== 'pull' && event.discarded) {
          stats.lostResponses += 1;
        }
      },
    }),
  );

  const createWith = (device: Device, note: number, text: string) => {
    noteToCreate = note;
    attempt = 0;
    return device.createNote(text);
  };

  return { store, devices, createWith };
}

// ---- The property ----

/** Texts of operations the server accepted, with the chain checks. */
function acceptedTexts(store: SyncStore): Set<string> {
  const texts = new Set<string>();
  const chains = new Map<string, { revision: number; text: string }[]>();

  for (const [opId, receipt] of store.receipts) {
    const result = receipt.result;
    if (result.status !== 'created' && result.status !== 'updated') continue;
    texts.add(receipt.content.text);
    // An edit is accepted only on top of the revision it was made from.
    expect(
      result.note.revision,
      `${opId} was accepted from base ${receipt.content.base_revision} but made revision ${result.note.revision}`,
    ).toBe(receipt.content.base_revision + 1);
    const chain = chains.get(receipt.content.note_id) ?? [];
    chain.push({ revision: result.note.revision, text: result.note.text });
    chains.set(receipt.content.note_id, chain);
  }

  for (const [noteId, chain] of chains) {
    // The revision is the number of accepted changes: 1, 2, 3, ... with no gap
    // and no repeat, and the note holds the text of the latest one.
    const revisions = chain
      .map((entry) => entry.revision)
      .sort((a, b) => a - b);
    expect(revisions, `accepted revisions of ${noteId}`).toEqual(
      revisions.map((_, index) => index + 1),
    );
    const note = store.notes.get(noteId);
    expect(note?.revision, `server revision of ${noteId}`).toBe(chain.length);
    const latest = chain.find((entry) => entry.revision === chain.length);
    expect(note?.text, `server text of ${noteId}`).toBe(latest?.text);
  }
  expect(store.notes.size, 'notes without an accepted change').toBe(
    chains.size,
  );
  return texts;
}

function heldTexts(devices: Device[]): {
  outbox: Set<string>;
  conflicts: Set<string>;
} {
  const outbox = new Set<string>();
  const conflicts = new Set<string>();
  for (const device of devices) {
    const state = device.getState();
    for (const entry of state.outbox.values()) outbox.add(entry.op.text);
    for (const conflict of state.conflicts.values()) {
      conflicts.add(conflict.proposal.text);
    }
  }
  return { outbox, conflicts };
}

/** Every text written is accepted, pending, in a conflict, or let go. */
function expectNoSilentLoss(model: Model, harness: Harness, when: string) {
  const accepted = acceptedTexts(harness.store);
  const { outbox, conflicts } = heldTexts(harness.devices);
  for (const text of model.written) {
    if (model.discarded.has(text) || model.replaced.has(text)) continue;
    const kept = accepted.has(text) || outbox.has(text) || conflicts.has(text);
    expect(kept, `${text} disappeared silently ${when}`).toBe(true);
  }
}

async function apply(
  model: Model,
  harness: Harness,
  step: Action,
  index: number,
  stats?: Stats,
): Promise<void> {
  const device = harness.devices[step.device];
  if (device === undefined) throw new Error('Unknown device');
  const text = `w${index}`;
  const count = (done: boolean): void => {
    if (stats && done) {
      stats.accepted[step.kind] = (stats.accepted[step.kind] ?? 0) + 1;
    }
  };

  switch (step.kind) {
    case 'online': {
      const result = await device.setOnline(step.value);
      if (result.ok) {
        model.online[step.device] = step.value;
        // Going online sends everything the device holds.
        if (step.value) model.unsent[step.device]?.clear();
      }
      count(result.ok);
      return;
    }
    case 'create': {
      const result = await harness.createWith(device, step.note, text);
      if (result.ok) recordText(model, step.device, result.noteId, text);
      count(result.ok);
      return;
    }
    case 'edit': {
      const noteId = noteIdFor(step.note);
      const result = await device.editNote(noteId, text);
      if (result.ok) recordText(model, step.device, noteId, text);
      count(result.ok);
      return;
    }
    case 'pull': {
      count((await device.pull()).ok);
      return;
    }
    case 'retry': {
      const result = await device.retry();
      if (result.ok) model.unsent[step.device]?.clear();
      count(result.ok);
      return;
    }
    case 'lose': {
      device.setLoseNextResponse(true);
      count(true);
      return;
    }
    case 'resolve': {
      const noteId = noteIdFor(step.note);
      const resolution =
        step.mode === 'text'
          ? ({ mode: 'text', text } as const)
          : ({ mode: step.mode } as const);
      const result = await device.resolve(noteId, resolution);
      if (result.ok) {
        // The proposal is the text this device last wrote for the note.
        const proposal = model.lastWritten[step.device]?.get(noteId);
        if (proposal === undefined) throw new Error('Model out of sync');
        if (step.mode === 'discard') {
          model.discarded.add(proposal);
        } else if (step.mode === 'text') {
          model.discarded.add(proposal);
          recordText(model, step.device, noteId, text);
        } else if (!model.online[step.device]) {
          model.unsent[step.device]?.set(noteId, proposal);
        }
        if (stats) stats.resolved[step.mode] += 1;
      }
      count(result.ok);
      return;
    }
  }
}

/** Brings both devices online, retries, resolves what is open and pulls. */
async function settle(harness: Harness): Promise<void> {
  for (const device of harness.devices) {
    device.setLoseNextResponse(false);
    await device.setOnline(true);
  }
  for (let round = 0; round < 20; round += 1) {
    for (const device of harness.devices) {
      await device.retry();
      for (const noteId of device.getState().conflicts.keys()) {
        await device.resolve(noteId, { mode: 'mine' });
      }
      await device.pull();
    }
    const open = harness.devices.some((device) => {
      const state = device.getState();
      return state.outbox.size > 0 || state.conflicts.size > 0;
    });
    if (!open) break;
  }
  // Nothing is open now, so one more pull each shows the final server state.
  for (const device of harness.devices) await device.pull();
}

async function runScenario(steps: Action[], stats?: Stats): Promise<void> {
  const harness = createHarness(stats);
  const model = newModel();
  if (stats) stats.runs += 1;

  for (const [index, step] of steps.entries()) {
    await apply(model, harness, step, index, stats);
    expectNoSilentLoss(model, harness, `after action ${index}`);
  }

  await settle(harness);
  for (const [index, device] of harness.devices.entries()) {
    const state = device.getState();
    expect(state.outbox.size, `device ${index} outbox`).toBe(0);
    expect(state.conflicts.size, `device ${index} conflicts`).toBe(0);
  }
  expectNoSilentLoss(model, harness, 'after settling');

  const server = listNotes(harness.store);
  for (const [index, device] of harness.devices.entries()) {
    const seen = [...device.getState().seen.values()].sort((a, b) =>
      a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : 0,
    );
    expect(seen, `device ${index} agrees with the server`).toEqual(server);
  }
}

describe('two devices against the real sync rules', () => {
  it('loses no edit silently and agrees with the server once settled', async () => {
    await fc.assert(
      fc.asyncProperty(actions, async (steps) => {
        await runScenario(steps);
      }),
      { numRuns: 200 },
    );
  });

  it('generates conflicts, lost responses and every conflict choice', async () => {
    const stats = newStats();
    const samples = fc.sample(actions, { numRuns: 300, seed: 20261101 });
    for (const steps of samples) await runScenario(steps, stats);

    expect(stats.runs).toBe(300);
    expect(stats.conflicts).toBeGreaterThan(0);
    expect(stats.lostResponses).toBeGreaterThan(0);
    for (const mode of MODES) {
      expect(stats.resolved[mode], `${mode} resolutions`).toBeGreaterThan(0);
    }
    for (const kind of ['online', 'create', 'edit', 'pull', 'retry', 'lose']) {
      expect(stats.accepted[kind] ?? 0, `${kind} actions`).toBeGreaterThan(0);
    }
  });
});
