import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAIM, device, note, receipt, state } from '../test-support/fixtures';
import { claimOf, deepEqual, SCENARIOS } from './scenarios';

const conflict = SCENARIOS.conflict.steps;
const lost = SCENARIOS.lost.steps;

describe('the scenario tables', () => {
  it('has the conflict scenario with 8 steps and the lost one with 3', () => {
    expect(conflict).toHaveLength(8);
    expect(lost).toHaveLength(3);
    expect(SCENARIOS.conflict.title).toBe('Conflict between devices');
    expect(SCENARIOS.lost.title).toBe('Lost response and resend');
  });

  it('keeps the titles, phases, devices and expected texts of the guide tables', () => {
    expect(
      conflict.map((s) => [s.device, s.phase, s.title, s.expected]),
    ).toEqual([
      [
        'adjuster',
        'Set up',
        'Create the claim note on the phone.',
        'created at r1. An online device sends it right away.',
      ],
      [
        'office',
        'Set up',
        'Pull the notes on the office computer.',
        'The office also sees the note at r1.',
      ],
      [
        'adjuster',
        'Diverge',
        'Take the phone offline.',
        'The line to the server breaks. Editing still works; Pull turns off.',
      ],
      [
        'adjuster',
        'Diverge',
        'Edit the note on the phone.',
        'It stays pending on base r1. The server stays at r1.',
      ],
      [
        'office',
        'Diverge',
        'Edit the same note at the office.',
        'updated to r2, sent right away. The phone does not know yet.',
      ],
      [
        'adjuster',
        'Conflict',
        'Bring the phone back online.',
        'The pending operation goes out by itself on base r1. conflito: the server keeps r2, and both texts come back.',
      ],
      [
        'adjuster',
        'Resolve',
        'Send a combined text to resolve the conflict.',
        'A new operation with a new op_id, on base r2: updated to r3. Neither text was lost.',
      ],
      [
        'adjuster',
        'Resolve',
        'Resend the conflict receipt.',
        'The original receipt comes back, still showing r2. The server stays at r3.',
      ],
    ]);
    expect(lost.map((s) => [s.device, s.phase, s.title, s.expected])).toEqual([
      [
        'adjuster',
        'Lose it',
        'Turn on "Lose next response" for the phone.',
        'The next answer from the server will be dropped on its way back.',
      ],
      [
        'adjuster',
        'Lose it',
        'Create the claim note on the phone.',
        'The server creates r1, but no receipt arrives. The operation stays pending and frozen, and Retry appears.',
      ],
      [
        'adjuster',
        'Resend',
        'Retry the operation.',
        'The stored receipt returns: created at r1. No new revision, and still one stored receipt.',
      ],
    ]);
  });

  it('aims each step at the control the page exposes', () => {
    const s = state(device({ seen: { [CLAIM]: 1 } }), device());
    expect(conflict.map((step) => step.target(s))).toEqual([
      'create:adjuster',
      'pull:office',
      'net:adjuster:offline',
      `edit:adjuster:${CLAIM}`,
      `edit:office:${CLAIM}`,
      'net:adjuster:online',
      `resolve:adjuster:${CLAIM}:custom`,
      null,
    ]);
    expect(lost.map((step) => step.target(s))).toEqual([
      'lose:adjuster',
      'create:adjuster',
      'retry:adjuster',
    ]);
  });

  it('prefills only note text, for the create and edit steps', () => {
    expect(conflict.map((s) => s.prefill?.field ?? null)).toEqual([
      'new-text',
      null,
      null,
      'edit',
      'edit',
      null,
      null,
      null,
    ]);
    expect(lost.map((s) => s.prefill?.field ?? null)).toEqual([
      null,
      'new-text',
      null,
    ]);
  });
});

describe('claimOf', () => {
  it('reads the generated note id from the phone, never from a constant', () => {
    expect(
      claimOf(state(device({ outbox: { 'CLM-1': { base: 0 } } }), device())),
    ).toBe('CLM-1');
    expect(claimOf(state(device({ seen: { 'CLM-2': 1 } }), device()))).toBe(
      'CLM-2',
    );
    expect(
      claimOf(state(device(), device({ seen: { 'CLM-3': 1 } }))),
    ).toBeUndefined();
  });

  it('keeps the scenario on the first note when a second one is still unsent', () => {
    const phone = device({
      seen: { [CLAIM]: 1 },
      outbox: { 'CLM-2': { base: 0 } },
      online: false,
    });
    expect(claimOf(state(phone, device()))).toBe(CLAIM);
    const resolving = device({
      seen: { [CLAIM]: 2 },
      conflictAt: CLAIM,
      outbox: { 'CLM-2': { base: 0 } },
    });
    expect(claimOf(state(resolving, device()))).toBe(CLAIM);
  });
});

describe('conflict steps judge the settled state', () => {
  it('step 1 is done once the phone saw the note and matches only at server r1', () => {
    const phone = device({ seen: { [CLAIM]: 1 } });
    expect(
      conflict[0]?.done(
        state(
          device({ outbox: { [CLAIM]: { base: 0, frozen: true } } }),
          device(),
        ),
      ),
    ).toBe(false);
    expect(conflict[0]?.done(state(phone, device(), [note(1)]))).toBe(true);
    expect(conflict[0]?.check(state(phone, device(), [note(1)]))).toEqual({
      ok: true,
      got: 'server at r1',
    });
    expect(conflict[0]?.check(state(phone, device(), [note(2)]))).toEqual({
      ok: false,
      got: 'server at r2',
    });
  });

  it('step 4 expects a pending edit on base r1 with the server still at r1', () => {
    const pending = device({
      seen: { [CLAIM]: 1 },
      outbox: { [CLAIM]: { base: 1 } },
      online: false,
    });
    expect(conflict[3]?.check(state(pending, device(), [note(1)]))).toEqual({
      ok: true,
      got: 'pending on base r1, server at r1',
    });
    const sent = device({ seen: { [CLAIM]: 1 } });
    expect(conflict[3]?.check(state(sent, device(), [note(2)]))).toEqual({
      ok: false,
      got: 'already sent, server at r2',
    });
  });

  it('step 4 tells a phone that came back online to go offline again', () => {
    const online = state(device({ seen: { [CLAIM]: 1 } }), device());
    expect(conflict[3]?.hint?.(online)).toBe(
      'The phone is online again. Take it offline to follow the scenario.',
    );
    const offline = state(
      device({ seen: { [CLAIM]: 1 }, online: false }),
      device(),
    );
    expect(conflict[3]?.hint?.(offline)).toBeNull();
  });

  it('step 2 stays on the first note when the phone holds an unsent second note', () => {
    const phone = device({
      seen: { [CLAIM]: 1 },
      outbox: { 'CLM-2': { base: 0 } },
      online: false,
    });
    const s = state(phone, device({ seen: { [CLAIM]: 1 } }), [note(1)]);
    expect(conflict[1]?.done(s)).toBe(true);
    expect(conflict[1]?.check(s)).toEqual({ ok: true, got: 'office sees r1' });
    expect(conflict[1]?.done(state(phone, device(), [note(1)]))).toBe(false);
  });

  it('step 4 waits for an edit of the first note, not for an unsent second note', () => {
    const phone = device({
      seen: { [CLAIM]: 1 },
      outbox: { 'CLM-2': { base: 0 } },
      online: false,
    });
    const s = state(phone, device({ seen: { [CLAIM]: 1 } }), [note(1)]);
    expect(conflict[3]?.done(s)).toBe(false);
    expect(conflict[3]?.target(s)).toBe(`edit:adjuster:${CLAIM}`);
    const edited = device({
      seen: { [CLAIM]: 1 },
      outbox: { [CLAIM]: { base: 1 }, 'CLM-2': { base: 0 } },
      online: false,
    });
    expect(conflict[3]?.done(state(edited, device(), [note(1)]))).toBe(true);
  });

  it('step 5 needs the server at r2 while the phone still last saw r1', () => {
    const phone = device({ seen: { [CLAIM]: 1 } });
    expect(conflict[4]?.check(state(phone, device(), [note(2)]))).toEqual({
      ok: true,
      got: 'server at r2, phone last saw r1',
    });
    const caught = device({ seen: { [CLAIM]: 2 } });
    expect(conflict[4]?.check(state(caught, device(), [note(2)])).ok).toBe(
      false,
    );
  });

  it('step 6 expects a revision mismatch while the server keeps r2', () => {
    const withConflict = state(
      device({ seen: { [CLAIM]: 2 }, conflictAt: CLAIM }),
      device(),
      [note(2)],
    );
    expect(conflict[5]?.check(withConflict)).toEqual({
      ok: true,
      got: 'conflito, server at r2',
    });
    const none = state(device({ seen: { [CLAIM]: 2 } }), device(), [note(2)]);
    expect(conflict[5]?.check(none)).toEqual({
      ok: false,
      got: 'no conflict, server at r2',
    });
  });

  it('step 7 needs r3 holding both texts, and loses neither', () => {
    const phone = device({ seen: { [CLAIM]: 3 } });
    const both =
      'Customer sent photos of the damage.\nInspection: rear bumper and left tail light damaged.';
    expect(conflict[6]?.check(state(phone, device(), [note(3, both)])).ok).toBe(
      true,
    );
    expect(
      conflict[6]?.check(
        state(phone, device(), [
          note(3, 'Customer sent photos of the damage.'),
        ]),
      ).ok,
    ).toBe(false);
    expect(conflict[6]?.check(state(phone, device(), [note(2, both)])).ok).toBe(
      false,
    );
  });

  it('step 8 targets the oldest conflict receipt and compares it with the newest answer', () => {
    const original = receipt(2, 'conflito');
    const resent = receipt(5, 'conflito', true);
    const s = state(
      device({
        seen: { [CLAIM]: 3 },
        receipts: [receipt(4, 'created'), original],
      }),
      device(),
      [note(3)],
    );
    expect(conflict[7]?.target(s)).toBe('resend:adjuster:2');
    expect(conflict[7]?.done(s)).toBe(false);
    const after = state(
      device({
        seen: { [CLAIM]: 3 },
        receipts: [resent, receipt(4, 'created'), original],
      }),
      device(),
      [note(3)],
    );
    expect(conflict[7]?.done(after)).toBe(true);
    expect(conflict[7]?.check(after)).toEqual({
      ok: true,
      got: 'same receipt, server at r3',
    });
    const different = state(
      device({
        seen: { [CLAIM]: 3 },
        receipts: [receipt(5, 'created', true), original],
      }),
      device(),
      [note(3)],
    );
    expect(conflict[7]?.check(different)).toEqual({
      ok: false,
      got: 'different answer, server at r3',
    });
  });
});

describe('lost-response steps', () => {
  it('step 1 is armed by the checkbox, or already past once the server has the note', () => {
    expect(lost[0]?.done(state(device(), device()))).toBe(false);
    expect(
      lost[0]?.done(state(device({ loseNextResponse: true }), device())),
    ).toBe(true);
    const held = device({ outbox: { [CLAIM]: { base: 0, frozen: true } } });
    expect(lost[0]?.done(state(held, device(), [note(1)]))).toBe(true);
  });

  it('step 2 needs a frozen operation, no receipt and the server at r1', () => {
    const frozen = device({ outbox: { [CLAIM]: { base: 0, frozen: true } } });
    expect(lost[1]?.check(state(frozen, device(), [note(1)]))).toEqual({
      ok: true,
      got: 'server at r1, still pending',
    });
    const unfrozen = device({
      outbox: { [CLAIM]: { base: 0, frozen: false } },
    });
    expect(lost[1]?.check(state(unfrozen, device(), [note(1)])).ok).toBe(false);
    expect(lost[1]?.check(state(frozen, device(), [note(1)])).ok).toBe(true);
    const withReceipt = device({
      outbox: { [CLAIM]: { base: 0, frozen: true } },
      receipts: [receipt(1, 'created')],
    });
    expect(lost[1]?.check(state(withReceipt, device(), [note(1)])).ok).toBe(
      false,
    );
  });

  it('step 3 reads the stored-receipt count the server reported', () => {
    const phone = device({
      seen: { [CLAIM]: 1 },
      receipts: [receipt(1, 'created')],
    });
    expect(lost[2]?.check(state(phone, device(), [note(1)], 1))).toEqual({
      ok: true,
      got: 'created, server at r1, 1 stored receipt',
    });
    expect(lost[2]?.check(state(phone, device(), [note(1)], 2))).toEqual({
      ok: false,
      got: 'created, server at r1, 2 stored receipts',
    });
  });

  it('blocks the retry and the create while the phone is offline', () => {
    const offline = state(device({ online: false }), device());
    expect(lost[1]?.hint?.(offline)).toBe(
      'The phone is offline, so this step is blocked. Bring it back online to continue.',
    );
    expect(lost[2]?.hint?.(offline)).toBe(
      'The phone is offline, so this step is blocked. Bring it back online to continue.',
    );
    expect(
      conflict[1]?.hint?.(state(device(), device({ online: false }))),
    ).toBe(
      'The office computer is offline, so this step is blocked. Bring it back online to continue.',
    );
  });
});

describe('deepEqual', () => {
  it('compares nested values by structure', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('import boundary', () => {
  it.each(['scenarios.ts', 'guide-run.ts'])(
    '%s imports nothing from react, next, the api-client or components',
    (file) => {
      const source = readFileSync(
        new URL(`./${file}`, import.meta.url),
        'utf8',
      );
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(
        (m) => m[1] ?? '',
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const spec of specifiers) {
        expect(spec).not.toMatch(/^(react|react-dom|next)(\/|$)/);
        expect(spec).not.toMatch(/api-client|components/);
      }
    },
  );
});
