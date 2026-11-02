import { describe, expect, it } from 'vitest';
import { CLAIM, device, note, state } from '../test-support/fixtures';
import {
  advance,
  blockedReason,
  currentStep,
  FALLBACK_REASON,
  freePlay,
  isComplete,
  matchedCount,
  restart,
  start,
} from './guide-run';
import { SCENARIOS } from './scenarios';

const empty = state(device(), device());

describe('start and restart', () => {
  it('starts at step 1 with no results and a fresh run id', () => {
    const run = start('conflict');
    expect(run).toMatchObject({
      scenarioId: 'conflict',
      index: 0,
      results: [],
    });
    expect(currentStep(run)?.title).toBe('Create the claim note on the phone.');
    expect(start('lost', run).runId).not.toBe(run.runId);
  });

  it('restarts the same scenario from step 1, or stays in Free play', () => {
    const moved = { ...start('lost'), index: 2 };
    expect(restart(moved)).toMatchObject({
      scenarioId: 'lost',
      index: 0,
      results: [],
    });
    expect(restart(moved).runId).not.toBe(moved.runId);
    expect(restart(freePlay()).scenarioId).toBeNull();
  });
});

describe('advance', () => {
  it('returns the very same run when the current step is not done', () => {
    const run = start('conflict');
    expect(advance(run, empty)).toBe(run);
  });

  it('records exactly one result for a finished step and moves on', () => {
    const run = start('conflict');
    const s = state(device({ seen: { [CLAIM]: 1 } }), device(), [note(1)]);
    const next = advance(run, s);
    expect(next.index).toBe(1);
    expect(next.results).toEqual([
      {
        n: 1,
        title: 'Create the claim note on the phone.',
        expected: 'created at r1. An online device sends it right away.',
        got: 'server at r1',
        ok: true,
      },
    ]);
    expect(advance(next, s)).toBe(next);
  });

  it('records a different result when the state is not what was expected', () => {
    const s = state(device({ seen: { [CLAIM]: 1 } }), device(), [note(4)]);
    const next = advance(start('conflict'), s);
    expect(next.results[0]).toMatchObject({ ok: false, got: 'server at r4' });
    expect(matchedCount(next)).toBe(0);
  });

  it('passes several steps at once when one state meets them all', () => {
    const s = state(
      device({
        seen: { [CLAIM]: 1 },
        online: false,
        outbox: { [CLAIM]: { base: 1 } },
      }),
      device({ seen: { [CLAIM]: 1 } }),
      [note(1)],
    );
    const next = advance(start('conflict'), s);
    expect(next.results.map((r) => r.n)).toEqual([1, 2, 3, 4]);
    expect(next.index).toBe(4);
  });

  it('never moves in Free play', () => {
    const run = freePlay();
    expect(advance(run, empty)).toBe(run);
    expect(currentStep(run)).toBeNull();
    expect(isComplete(run)).toBe(false);
  });

  it('is complete after the last step', () => {
    const run = { ...start('lost'), index: SCENARIOS.lost.steps.length };
    expect(isComplete(run)).toBe(true);
    expect(currentStep(run)).toBeNull();
  });
});

describe('blockedReason', () => {
  const step = SCENARIOS.conflict.steps[1];
  if (step === undefined) throw new Error('missing step');
  const offline = state(device(), device({ online: false }));

  it('gives the hint when there is one, even if the control is ready', () => {
    expect(blockedReason(step, offline, 'ready')).toBe(
      'The office computer is offline, so this step is blocked. Bring it back online to continue.',
    );
  });

  it('gives the generic reason for a missing or disabled control without a hint', () => {
    expect(blockedReason(step, empty, 'missing')).toBe(FALLBACK_REASON);
    expect(blockedReason(step, empty, 'disabled')).toBe(
      'This step cannot run in the current state. Restart the scenario to continue.',
    );
  });

  it('names the note to select when a step with a note has no control on screen', () => {
    const withNote = SCENARIOS.conflict.steps[3];
    if (withNote === undefined) throw new Error('missing step');
    const s = state(device({ seen: { [CLAIM]: 1 }, online: false }), device(), [
      note(1),
    ]);
    expect(blockedReason(withNote, s, 'missing')).toBe(
      `Select ${CLAIM} to continue.`,
    );
    expect(blockedReason(withNote, s, 'ready')).toBeNull();
    expect(blockedReason(withNote, s, 'disabled')).toBe(FALLBACK_REASON);
  });

  it('is null when nothing blocks the step', () => {
    expect(blockedReason(step, empty, 'ready')).toBeNull();
  });
});
