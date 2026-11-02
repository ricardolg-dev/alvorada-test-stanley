// The run of a guided scenario as pure functions. It moves forward only over a
// settled GuideState and holds no sync rule. No React, Next.js, api-client or
// component imports.

import {
  SCENARIOS,
  type GuideState,
  type Scenario,
  type ScenarioId,
  type Step,
} from './scenarios';

export interface StepResult {
  /** 1-based step number. */
  readonly n: number;
  readonly title: string;
  readonly expected: string;
  readonly got: string;
  readonly ok: boolean;
}

export interface GuideRun {
  /** Null in Free play. */
  readonly scenarioId: ScenarioId | null;
  /** Index of the current step; equals the step count when complete. */
  readonly index: number;
  readonly results: readonly StepResult[];
  /** Changes on every start, so a restart is a new run even at step 1. */
  readonly runId: number;
}

export type ControlState = 'ready' | 'missing' | 'disabled';

export const FALLBACK_REASON =
  'This step cannot run in the current state. Restart the scenario to continue.';

export function start(id: ScenarioId, previous?: GuideRun): GuideRun {
  return {
    scenarioId: id,
    index: 0,
    results: [],
    runId: (previous?.runId ?? 0) + 1,
  };
}

export function freePlay(previous?: GuideRun): GuideRun {
  return {
    scenarioId: null,
    index: 0,
    results: [],
    runId: (previous?.runId ?? 0) + 1,
  };
}

/** Starts the same scenario again; in Free play it stays in Free play. */
export function restart(run: GuideRun): GuideRun {
  return run.scenarioId === null ? freePlay(run) : start(run.scenarioId, run);
}

export function scenarioOf(run: GuideRun): Scenario | null {
  return run.scenarioId === null ? null : SCENARIOS[run.scenarioId];
}

export function currentStep(run: GuideRun): Step | null {
  return scenarioOf(run)?.steps[run.index] ?? null;
}

export function isComplete(run: GuideRun): boolean {
  return run.scenarioId !== null && currentStep(run) === null;
}

export function matchedCount(run: GuideRun): number {
  return run.results.filter((result) => result.ok).length;
}

/**
 * Moves past every step whose goal is met in `state`, recording one result
 * per step. Returns the same object when nothing moved.
 */
export function advance(run: GuideRun, state: GuideState): GuideRun {
  let next = run;
  for (
    let step = currentStep(next);
    step !== null && step.done(state);
    step = currentStep(next)
  ) {
    const checked = step.check(state);
    next = {
      ...next,
      index: next.index + 1,
      results: [
        ...next.results,
        {
          n: next.index + 1,
          title: step.title,
          expected: step.expected,
          got: checked.got,
          ok: checked.ok,
        },
      ],
    };
  }
  return next;
}

/**
 * Why the step cannot run, or null when it can. A hint wins; a control that is
 * missing or disabled without a hint gets the generic reason.
 */
export function blockedReason(
  step: Step,
  state: GuideState,
  control: ControlState,
): string | null {
  const hint = step.hint?.(state) ?? null;
  if (hint !== null && hint !== '') return hint;
  return control === 'ready' ? null : FALLBACK_REASON;
}
