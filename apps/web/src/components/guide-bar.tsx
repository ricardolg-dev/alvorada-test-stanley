'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  currentStep,
  isComplete,
  matchedCount,
  scenarioOf,
  type ControlState,
  type GuideRun,
} from '../guide/guide-run';
import {
  SCENARIOS,
  type GuideState,
  type ScenarioId,
} from '../guide/scenarios';
import { DEVICE_META } from './device-meta';
import { Icon } from './icons';

export interface GuideBarProps {
  run: GuideRun;
  /** Why the current step cannot run, or null when it can. */
  blocked: string | null;
  /** True while a request or the refresh after it is still open. */
  working: boolean;
  /** True while a reset is under way: nothing here can be used. */
  resetting: boolean;
  onChoose: (id: ScenarioId) => void;
  onFree: () => void;
  onRestart: () => void;
  onDoStep: () => void;
}

/** The chooser, the progress cells and the progress label. */
function GuideHead({
  run,
  resetting,
  onChoose,
  onFree,
  lastLine,
}: Pick<GuideBarProps, 'run' | 'resetting' | 'onChoose' | 'onFree'> & {
  lastLine: React.ReactNode;
}) {
  const scenario = scenarioOf(run);
  const step = currentStep(run);
  const choice = (id: ScenarioId, label: string) => (
    <button
      type="button"
      data-fid={`scenario:${id}`}
      aria-pressed={run.scenarioId === id}
      disabled={resetting}
      onClick={() => {
        onChoose(id);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="guide-head">
      <div className="seg" role="group" aria-label="Scenario">
        {choice('conflict', 'Conflict')}
        {choice('lost', 'Lost response')}
        <button
          type="button"
          data-fid="free"
          aria-pressed={scenario === null}
          disabled={resetting}
          onClick={onFree}
        >
          Free play
        </button>
      </div>
      {scenario === null ? null : (
        <>
          <div className="progress" aria-hidden="true">
            {scenario.steps.map((_, index) => {
              const result = run.results[index];
              const state = result
                ? result.ok
                  ? 'done'
                  : 'miss'
                : index === run.index
                  ? 'now'
                  : '';
              return <span key={index} className={state} />;
            })}
          </div>
          <span className="step-count">
            {step
              ? `Step ${run.index + 1} of ${scenario.steps.length} · ${step.phase}`
              : `${scenario.steps.length} of ${scenario.steps.length} steps`}
          </span>
        </>
      )}
      {lastLine}
    </div>
  );
}

/** The guide: it shows the step, its expected result and the last outcome. */
export function GuideBar({
  run,
  blocked,
  working,
  resetting,
  onChoose,
  onFree,
  onRestart,
  onDoStep,
}: GuideBarProps) {
  const scenario = scenarioOf(run);
  const last = run.results[run.results.length - 1];
  const complete = isComplete(run);
  const lastLine =
    last && !complete ? (
      <p className="last">
        {`Step ${last.n}: `}
        <b className={last.ok ? 'ok' : 'miss'}>
          {last.ok ? '✓ as expected' : 'different from expected'}
        </b>
        {` · ${last.got}`}
      </p>
    ) : null;
  const head = (
    <GuideHead
      run={run}
      resetting={resetting}
      onChoose={onChoose}
      onFree={onFree}
      lastLine={lastLine}
    />
  );

  if (scenario === null) {
    return (
      <section className="guide" aria-label="Guide">
        {head}
        <p className="small muted">
          Free play: use both devices however you like. Choosing a scenario
          starts it from an empty server.
        </p>
      </section>
    );
  }

  if (complete) {
    const other = SCENARIOS[scenario.id === 'conflict' ? 'lost' : 'conflict'];
    return (
      <section className="guide" aria-label="Guide">
        {head}
        <div className="guide-step">
          <div className="step-copy" role="status">
            <p className="instr">
              {`Scenario complete. ${matchedCount(run)} of ${run.results.length} steps matched.`}
            </p>
            <p className="expect">{scenario.closing}</p>
          </div>
          <div className="step-actions">
            <button
              type="button"
              className="primary"
              data-fid="next-scenario"
              disabled={resetting}
              onClick={() => {
                onChoose(other.id);
              }}
            >
              {`Run “${other.title}”`}
            </button>
            <button
              type="button"
              data-fid="restart"
              disabled={resetting}
              onClick={onRestart}
            >
              Run this one again
            </button>
          </div>
        </div>
      </section>
    );
  }

  const step = currentStep(run);
  if (step === null) return null;
  const meta = DEVICE_META[step.device];
  return (
    <section className="guide" aria-label="Guide">
      {head}
      <div className="guide-step">
        <div className="step-copy" role="status">
          <div className="step-line">
            <span className="who">
              <Icon name={meta.icon} /> {meta.name}
            </span>
            <p className="instr">{step.title}</p>
          </div>
          <p className="expect">
            <b>Expected:</b> {step.expected}
          </p>
          <p className="hint" id="step-hint">
            {blocked ?? ''}
          </p>
        </div>
        <div className="step-actions">
          <button
            type="button"
            className="primary"
            data-fid="do-step"
            disabled={blocked !== null || working || resetting}
            onClick={onDoStep}
          >
            Do this step
          </button>
          <button
            type="button"
            data-fid="restart"
            disabled={resetting}
            onClick={onRestart}
          >
            Restart
          </button>
        </div>
      </div>
    </section>
  );
}

/** The control with this `data-fid`, looked up on the page. */
export function findControl(fid: string | null): HTMLElement | null {
  if (fid === null || fid === '') return null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-fid]')) {
    if (el.getAttribute('data-fid') === fid) return el;
  }
  return null;
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement) &&
    el.disabled
  );
}

function openDisclosures(el: HTMLElement): void {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
}

/**
 * Finds the step's control by `data-fid`. A control that is absent or disabled
 * makes the step blocked; otherwise it gets the spot class and is brought into
 * view, opening any closed section around it. It runs after every render and
 * again whenever the screens change on their own (a device screen keeps its
 * own selection, which the page never sees): a `data-fid` or `disabled`
 * change, or an element added or removed, inside `main`. What it changes
 * itself (the spot class, an opened section) is outside that filter, so it
 * does not trigger itself. `track` is false while no step applies.
 *
 * Returns how the control stands now, and `recheck`, which looks again at once
 * and returns the answer.
 */
export function useStepControl(
  fid: string | null,
  state: GuideState | null,
  stepKey: string,
  track: boolean,
): { control: ControlState; recheck: () => ControlState } {
  const [control, setControl] = useState<ControlState>('ready');
  const revealed = useRef<string | null>(null);
  const latest = useRef({ fid, state, stepKey, track });

  const check = useCallback((): ControlState => {
    const current = latest.current;
    for (const el of document.querySelectorAll('.spot')) {
      el.classList.remove('spot');
    }
    let next: ControlState = 'ready';
    if (current.track && current.state !== null) {
      const el = findControl(current.fid);
      if (el === null) {
        next = 'missing';
      } else if (isDisabled(el)) {
        next = 'disabled';
      } else {
        el.classList.add('spot');
        openDisclosures(el);
        // Scroll once per step, so a later render never pulls the page back.
        if (
          revealed.current !== current.stepKey &&
          typeof el.scrollIntoView === 'function'
        ) {
          revealed.current = current.stepKey;
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }
    setControl(next);
    return next;
  }, []);

  useLayoutEffect(() => {
    latest.current = { fid, state, stepKey, track };
    check();
  });

  useLayoutEffect(() => {
    const main = document.getElementById('main');
    if (main === null) return;
    const observer = new MutationObserver(() => {
      check();
    });
    observer.observe(main, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-fid', 'disabled'],
    });
    return () => {
      observer.disconnect();
    };
  }, [check]);

  return { control, recheck: check };
}
