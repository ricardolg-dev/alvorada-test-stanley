// Test-only builders for the states the guide reads.

import type { DeviceState, OutboxEntry, Receipt } from '../device/device';
import type { GuideNote, GuideState } from '../guide/scenarios';

export const CLAIM = 'CLM-0000AAAA';

interface DeviceInit {
  online?: boolean;
  loseNextResponse?: boolean;
  seen?: Record<string, number>;
  outbox?: Record<string, { base: number; frozen?: boolean }>;
  conflictAt?: string;
  receipts?: Receipt[];
}

export function device(init: DeviceInit = {}): DeviceState {
  const seen = new Map(
    Object.entries(init.seen ?? {}).map(([id, revision]) => [
      id,
      { note_id: id, revision, text: 'seen' },
    ]),
  );
  const outbox = new Map<string, OutboxEntry>(
    Object.entries(init.outbox ?? {}).map(([id, entry]) => [
      id,
      {
        op: {
          op_id: `op-${id}`,
          note_id: id,
          base_revision: entry.base,
          text: 't',
        },
        frozen: entry.frozen ?? false,
      },
    ]),
  );
  const conflicts = new Map<
    string,
    DeviceState['conflicts'] extends ReadonlyMap<string, infer C> ? C : never
  >();
  if (init.conflictAt !== undefined) {
    conflicts.set(init.conflictAt, {
      op_id: 'op-c',
      status: 'conflito',
      reason: 'revision_mismatch',
      note_id: init.conflictAt,
      server: { note_id: init.conflictAt, revision: 2, text: 's' },
      proposal: { base_revision: 1, text: 'p' },
    });
  }
  return {
    online: init.online ?? true,
    loseNextResponse: init.loseNextResponse ?? false,
    busy: false,
    canRetry: false,
    message: '',
    error: null,
    seen,
    outbox,
    conflicts,
    receipts: init.receipts ?? [],
  };
}

export function state(
  adjuster: DeviceState,
  office: DeviceState,
  notes: GuideNote[] = [],
  receiptCount = 0,
): GuideState {
  return { devices: { adjuster, office }, server: { notes, receiptCount } };
}

export const note = (revision: number, text = 'x'): GuideNote => ({
  note_id: CLAIM,
  revision,
  text,
});

export function receipt(
  seq: number,
  status: 'created' | 'conflito',
  resend = false,
): Receipt {
  const result =
    status === 'created'
      ? ({
          op_id: 'op-1',
          status,
          note: { note_id: CLAIM, revision: 1, text: 'x' },
        } as const)
      : ({
          op_id: 'op-1',
          status,
          reason: 'revision_mismatch',
          note_id: CLAIM,
          server: { note_id: CLAIM, revision: 2, text: 's' },
          proposal: { base_revision: 1, text: 'p' },
        } as const);
  return {
    seq,
    op: { op_id: 'op-1', note_id: CLAIM, base_revision: 1, text: 'x' },
    result,
    resend,
  };
}
