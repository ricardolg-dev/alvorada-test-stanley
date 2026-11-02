// The guided scenarios as typed data. A step only reads state to know when its
// goal is met; it holds no sync rule. This module imports types from the
// device module and nothing from React, Next.js, the api-client or components.

import type { DeviceState } from '../device/device';

export type GuideDeviceId = 'adjuster' | 'office';
export type ScenarioId = 'conflict' | 'lost';

/** A note as the server holds it, read through the silent server refresh. */
export interface GuideNote {
  readonly note_id: string;
  readonly revision: number;
  readonly text: string;
}

/**
 * What a step may read: both devices and the server area, taken together once
 * the last response was applied and the server refreshed.
 */
export interface GuideState {
  readonly devices: Readonly<Record<GuideDeviceId, DeviceState>>;
  readonly server: {
    readonly notes: readonly GuideNote[];
    readonly receiptCount: number;
  };
}

/** Suggested text for a field the person edits. */
export interface Prefill {
  /** `new-text` is the box for a new note; `edit` is the selected note's box. */
  readonly field: 'new-text' | 'edit';
  readonly text: string;
}

export interface StepCheck {
  readonly ok: boolean;
  readonly got: string;
}

export interface Step {
  readonly device: GuideDeviceId;
  readonly phase: string;
  readonly title: string;
  readonly expected: string;
  /** The `data-fid` of the control to click, or null when there is none now. */
  readonly target: (state: GuideState) => string | null;
  readonly prefill?: Prefill;
  /** The note the device should show while the step is current. */
  readonly note?: (state: GuideState) => string | undefined;
  /** A reason the step cannot run right now, or null. */
  readonly hint?: (state: GuideState) => string | null;
  /** True once the step's goal is met. */
  readonly done: (state: GuideState) => boolean;
  /** Compares the state after the step with what the step expected. */
  readonly check: (state: GuideState) => StepCheck;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly title: string;
  /** The closing text shown when every step has run. */
  readonly closing: string;
  readonly steps: readonly Step[];
}

const TEXT = {
  opened: 'Claim opened: rear bumper damage reported.',
  field: 'Inspection: rear bumper and left tail light damaged.',
  office: 'Customer sent photos of the damage.',
  lost: 'Claim opened: windshield cracked by road debris.',
} as const;

const DEVICE_NAMES: Record<GuideDeviceId, string> = {
  adjuster: 'The phone',
  office: 'The office computer',
};

/** Structural equality for JSON-like values, used to compare receipts. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      deepEqual(left[key], right[key]),
  );
}

/**
 * The note id is generated, so every step reads it from the phone. A note the
 * server already holds comes first, so a second, unsent note never takes over
 * the scenario.
 */
export function claimOf(state: GuideState): string | undefined {
  const phone = state.devices.adjuster;
  return [
    ...phone.seen.keys(),
    ...phone.conflicts.keys(),
    ...phone.outbox.keys(),
  ][0];
}

function serverRevision(state: GuideState, noteId: string | undefined): number {
  return (
    state.server.notes.find((note) => note.note_id === noteId)?.revision ?? 0
  );
}

function serverText(state: GuideState, noteId: string | undefined): string {
  return state.server.notes.find((note) => note.note_id === noteId)?.text ?? '';
}

function seenRevision(
  state: GuideState,
  device: GuideDeviceId,
  noteId: string | undefined,
): number {
  return noteId === undefined
    ? 0
    : (state.devices[device].seen.get(noteId)?.revision ?? 0);
}

function onlineHint(device: GuideDeviceId) {
  return (state: GuideState): string | null =>
    state.devices[device].online
      ? null
      : `${DEVICE_NAMES[device]} is offline, so this step is blocked. Bring it back online to continue.`;
}

/** The first conflict receipt the phone received, never a resend of it. */
function conflictReceipt(state: GuideState) {
  return state.devices.adjuster.receipts
    .slice()
    .reverse()
    .find((receipt) => receipt.result.status === 'conflito' && !receipt.resend);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const conflictSteps: readonly Step[] = [
  {
    device: 'adjuster',
    phase: 'Set up',
    title: 'Create the claim note on the phone.',
    expected: 'created at r1. An online device sends it right away.',
    target: () => 'create:adjuster',
    hint: onlineHint('adjuster'),
    prefill: { field: 'new-text', text: TEXT.opened },
    done: (s) => {
      const claim = claimOf(s);
      return claim !== undefined && s.devices.adjuster.seen.has(claim);
    },
    check: (s) => {
      const rev = serverRevision(s, claimOf(s));
      return { ok: rev === 1, got: `server at r${rev}` };
    },
  },
  {
    device: 'office',
    phase: 'Set up',
    title: 'Pull the notes on the office computer.',
    expected: 'The office also sees the note at r1.',
    target: () => 'pull:office',
    hint: (s) => {
      const claim = claimOf(s);
      if (claim !== undefined && serverRevision(s, claim) === 0) {
        return 'The server no longer holds this note. Restart the scenario.';
      }
      return onlineHint('office')(s);
    },
    done: (s) => {
      const claim = claimOf(s);
      return claim !== undefined && s.devices.office.seen.has(claim);
    },
    check: (s) => {
      const rev = seenRevision(s, 'office', claimOf(s));
      return { ok: rev === 1, got: `office sees r${rev}` };
    },
  },
  {
    device: 'adjuster',
    phase: 'Diverge',
    title: 'Take the phone offline.',
    expected:
      'The line to the server breaks. Editing still works; Pull turns off.',
    target: () => 'net:adjuster:offline',
    done: (s) => !s.devices.adjuster.online,
    check: (s) => ({ ok: !s.devices.adjuster.online, got: 'phone offline' }),
  },
  {
    device: 'adjuster',
    phase: 'Diverge',
    title: 'Edit the note on the phone.',
    expected: 'It stays pending on base r1. The server stays at r1.',
    note: claimOf,
    target: (s) => `edit:adjuster:${claimOf(s) ?? ''}`,
    prefill: { field: 'edit', text: TEXT.field },
    hint: (s) =>
      s.devices.adjuster.online
        ? 'The phone is online again. Take it offline to follow the scenario.'
        : null,
    done: (s) => {
      const claim = claimOf(s);
      return (
        (claim !== undefined && s.devices.adjuster.outbox.has(claim)) ||
        serverRevision(s, claim) >= 2
      );
    },
    check: (s) => {
      const claim = claimOf(s);
      const pending =
        claim === undefined ? undefined : s.devices.adjuster.outbox.get(claim);
      const rev = serverRevision(s, claim);
      return {
        ok:
          pending !== undefined && pending.op.base_revision === 1 && rev === 1,
        got: pending
          ? `pending on base r${pending.op.base_revision}, server at r${rev}`
          : `already sent, server at r${rev}`,
      };
    },
  },
  {
    device: 'office',
    phase: 'Diverge',
    title: 'Edit the same note at the office.',
    expected: 'updated to r2, sent right away. The phone does not know yet.',
    note: claimOf,
    target: (s) => `edit:office:${claimOf(s) ?? ''}`,
    prefill: { field: 'edit', text: TEXT.office },
    hint: onlineHint('office'),
    done: (s) => serverRevision(s, claimOf(s)) >= 2,
    check: (s) => {
      const claim = claimOf(s);
      const rev = serverRevision(s, claim);
      const phone = seenRevision(s, 'adjuster', claim);
      return {
        ok: rev === 2 && phone === 1,
        got: `server at r${rev}, phone last saw r${phone}`,
      };
    },
  },
  {
    device: 'adjuster',
    phase: 'Conflict',
    title: 'Bring the phone back online.',
    expected:
      'The pending operation goes out by itself on base r1. conflito: the server keeps r2, and both texts come back.',
    note: claimOf,
    target: () => 'net:adjuster:online',
    done: (s) => s.devices.adjuster.online,
    check: (s) => {
      const claim = claimOf(s);
      const conflict =
        claim === undefined
          ? undefined
          : s.devices.adjuster.conflicts.get(claim);
      const rev = serverRevision(s, claim);
      return {
        ok: conflict?.reason === 'revision_mismatch' && rev === 2,
        got: conflict
          ? `conflito, server at r${rev}`
          : `no conflict, server at r${rev}`,
      };
    },
  },
  {
    device: 'adjuster',
    phase: 'Resolve',
    title: 'Send a combined text to resolve the conflict.',
    expected:
      'A new operation with a new op_id, on base r2: updated to r3. Neither text was lost.',
    note: claimOf,
    target: (s) => `resolve:adjuster:${claimOf(s) ?? ''}:custom`,
    done: (s) => {
      const claim = claimOf(s);
      return claim !== undefined && !s.devices.adjuster.conflicts.has(claim);
    },
    check: (s) => {
      const claim = claimOf(s);
      const rev = serverRevision(s, claim);
      const text = serverText(s, claim);
      return {
        ok:
          rev === 3 && text.includes(TEXT.office) && text.includes(TEXT.field),
        got: `server at r${rev}`,
      };
    },
  },
  {
    device: 'adjuster',
    phase: 'Resolve',
    title: 'Resend the conflict receipt.',
    expected:
      'The original receipt comes back, still showing r2. The server stays at r3.',
    note: claimOf,
    target: (s) => {
      const receipt = conflictReceipt(s);
      return receipt ? `resend:adjuster:${receipt.seq}` : null;
    },
    hint: onlineHint('adjuster'),
    done: (s) => s.devices.adjuster.receipts[0]?.resend === true,
    check: (s) => {
      const original = conflictReceipt(s);
      const latest = s.devices.adjuster.receipts[0];
      const same =
        original !== undefined &&
        latest !== undefined &&
        deepEqual(latest.result, original.result);
      const rev = serverRevision(s, claimOf(s));
      return {
        ok: same && rev === 3,
        got: `${same ? 'same receipt' : 'different answer'}, server at r${rev}`,
      };
    },
  },
];

const lostSteps: readonly Step[] = [
  {
    device: 'adjuster',
    phase: 'Lose it',
    title: 'Turn on "Lose next response" for the phone.',
    expected:
      'The next answer from the server will be dropped on its way back.',
    target: () => 'lose:adjuster',
    done: (s) =>
      s.devices.adjuster.loseNextResponse || serverRevision(s, claimOf(s)) > 0,
    check: (s) => ({
      ok: s.devices.adjuster.loseNextResponse,
      got: s.devices.adjuster.loseNextResponse
        ? 'next response will be lost'
        : 'not armed',
    }),
  },
  {
    device: 'adjuster',
    phase: 'Lose it',
    title: 'Create the claim note on the phone.',
    expected:
      'The server creates r1, but no receipt arrives. The operation stays pending and frozen, and Retry appears.',
    target: () => 'create:adjuster',
    hint: onlineHint('adjuster'),
    prefill: { field: 'new-text', text: TEXT.lost },
    done: (s) => serverRevision(s, claimOf(s)) > 0,
    check: (s) => {
      const claim = claimOf(s);
      const pending =
        claim === undefined ? undefined : s.devices.adjuster.outbox.get(claim);
      const rev = serverRevision(s, claim);
      return {
        ok:
          pending?.frozen === true &&
          rev === 1 &&
          s.devices.adjuster.receipts.length === 0,
        got: `server at r${rev}, ${pending ? 'still pending' : 'no longer pending'}`,
      };
    },
  },
  {
    device: 'adjuster',
    phase: 'Resend',
    title: 'Retry the operation.',
    expected:
      'The stored receipt returns: created at r1. No new revision, and still one stored receipt.',
    note: claimOf,
    target: () => 'retry:adjuster',
    hint: onlineHint('adjuster'),
    done: (s) => {
      const claim = claimOf(s);
      return claim !== undefined && !s.devices.adjuster.outbox.has(claim);
    },
    check: (s) => {
      const receipt = s.devices.adjuster.receipts[0];
      const rev = serverRevision(s, claimOf(s));
      const stored = s.server.receiptCount;
      return {
        ok: receipt?.result.status === 'created' && rev === 1 && stored === 1,
        got: `${receipt ? receipt.result.status : 'no receipt'}, server at r${rev}, ${plural(stored, 'stored receipt')}`,
      };
    },
  },
];

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  conflict: {
    id: 'conflict',
    title: 'Conflict between devices',
    closing:
      'Both edits survived. The server surfaced the conflict, a person chose the text, and nothing was silently overwritten.',
    steps: conflictSteps,
  },
  lost: {
    id: 'lost',
    title: 'Lost response and resend',
    closing:
      'The change was applied once. Resending the same op_id returned the stored receipt instead of applying it again.',
    steps: lostSteps,
  },
};
