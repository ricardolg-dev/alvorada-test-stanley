'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readServer, resetServer, transport } from '../api-client/client';
import {
  createDevice,
  type Device,
  type DeviceEvent,
  type RandomSource,
} from '../device/device';
import { ActivityLog, type LogEntry } from './activity-log';
import {
  advance,
  blockedReason,
  currentStep,
  freePlay,
  restart,
  start,
  type GuideRun,
} from '../guide/guide-run';
import type { GuideState, ScenarioId } from '../guide/scenarios';
import { DeviceApp, type DeviceFocus } from './device-app';
import { findControl, GuideBar, useStepControl } from './guide-bar';
import type { DeviceId } from './device-meta';
import { PhoneFrame, WindowFrame } from './device-frames';
import { DeviceToolbar } from './device-toolbar';
import { Wire } from './wire';
import { ServerArea, type ServerView } from './server-area';

// After one accepted activation of Do this step, a further one is ignored for
// this long: a double click or two quick clicks run one step, not two.
const STEP_LOCKOUT_MS = 400;

// A read that failed is tried once more after this long.
const READ_RETRY_MS = 1000;

const READ_FAILED =
  'The server could not be read, so this step is on hold until a read succeeds.';

const browserRandom: RandomSource = (byteLength) => {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

function makeDevice(
  prefix: string,
  onEvent: (event: DeviceEvent) => void,
): Device {
  return createDevice({ prefix, transport, random: browserRandom, onEvent });
}

/**
 * Waits for each device's open request to end, so none can land after the
 * reset. Then empties the server and puts both devices back to their first
 * state. Then runs `afterReset`, which clears what the page keeps of its own,
 * the log. When the server call fails nothing else changes.
 */
export async function resetSimulation(
  resetTheServer: () => Promise<void>,
  devices: readonly Pick<Device, 'reset' | 'settled'>[],
  afterReset?: () => void,
): Promise<void> {
  await Promise.all(devices.map((device) => device.settled()));
  await resetTheServer();
  for (const device of devices) device.reset();
  afterReset?.();
}

function describe(cause: unknown): string {
  return cause instanceof Error && cause.message !== ''
    ? cause.message
    : 'The request failed.';
}

export function SimulatorPage() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const lastSeq = useRef(0);
  const record = (source: DeviceId, event: DeviceEvent) => {
    lastSeq.current += 1;
    const entry: LogEntry = { seq: lastSeq.current, source, event };
    setLog((previous) => [entry, ...previous]);
  };
  const [adjuster] = useState(() =>
    makeDevice('adj', (event) => {
      record('adjuster', event);
    }),
  );
  const [office] = useState(() =>
    makeDevice('ofc', (event) => {
      record('office', event);
    }),
  );
  const adjusterState = useSyncExternalStore(
    adjuster.subscribe,
    adjuster.getState,
    adjuster.getState,
  );
  const officeState = useSyncExternalStore(
    office.subscribe,
    office.getState,
    office.getState,
  );
  const [server, setServer] = useState<ServerView>({
    status: 'loading',
    notes: [],
    receiptCount: null,
    error: null,
  });
  const [resetError, setResetError] = useState<string | null>(null);
  // True from mount until the first reset ends, and during every later one.
  const [resetting, setResetting] = useState(true);
  const resettingRef = useRef(true);
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const latestRead = useRef(0);
  // Bumped to ask for one more read: after a failed one, or a failed reset.
  const [readTick, setReadTick] = useState(0);
  const handledTick = useRef(0);
  // The first read waits for the one reset a fresh page makes.
  const [ready, setReady] = useState(false);
  const didInitialReset = useRef(false);
  // Bumped by every reset: a screen remounts and forgets its local drafts.
  const [epoch, setEpoch] = useState(0);
  const [run, setRun] = useState<GuideRun>(() => start('conflict'));
  // Both devices and the server, published only once the last response was
  // applied and the refresh after it answered.
  const [settled, setSettled] = useState<GuideState | null>(null);
  const settledRef = useRef<GuideState | null>(null);
  const [focus, setFocus] = useState<
    Partial<Record<DeviceId, DeviceFocus | undefined>>
  >({});
  const focusNonce = useRef(0);

  function endReset() {
    resettingRef.current = false;
    setResetting(false);
  }

  useEffect(
    () => () => {
      clearTimeout(lockTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (didInitialReset.current) return;
    didInitialReset.current = true;
    resetServer().then(
      () => {
        setReady(true);
        endReset();
      },
      (cause: unknown) => {
        setResetError(`Reset failed: ${describe(cause)}`);
        setReady(true);
        endReset();
      },
    );
  }, []);

  // A silent read on mount and after every device state change or Reset. It
  // goes through the api-client only, never through a device's Pull. A slower
  // answer to an older read is dropped.
  useEffect(() => {
    if (!ready) return;
    const id = ++latestRead.current;
    // A read asked for by a tick is the second try: it is not tried again.
    const isRetry = readTick !== handledTick.current;
    handledTick.current = readTick;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    readServer().then(
      (snapshot) => {
        if (id !== latestRead.current) return;
        setServer({
          status: 'ready',
          notes: snapshot.notes,
          receiptCount: snapshot.receiptCount,
          error: null,
        });
        // Settled only when no request is open and no device moved since.
        if (
          !adjusterState.busy &&
          !officeState.busy &&
          adjuster.getState() === adjusterState &&
          office.getState() === officeState
        ) {
          setSettled({
            devices: { adjuster: adjusterState, office: officeState },
            server: {
              notes: snapshot.notes,
              receiptCount: snapshot.receiptCount,
            },
          });
        }
      },
      (cause: unknown) => {
        if (id !== latestRead.current) return;
        setServer((previous) => ({
          ...previous,
          status: 'ready',
          error: `Could not read the server: ${describe(cause)}`,
        }));
        if (isRetry || cancelled) return;
        retryTimer = setTimeout(() => {
          setReadTick((value) => value + 1);
        }, READ_RETRY_MS);
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [ready, adjusterState, officeState, adjuster, office, readTick]);

  const working =
    settled === null ||
    settled.devices.adjuster !== adjusterState ||
    settled.devices.office !== officeState;
  const settledNow = working ? null : settled;

  // A step is evaluated only against a settled state, never a half-updated one.
  useEffect(() => {
    settledRef.current = settled;
    if (settledNow !== null)
      setRun((previous) => advance(previous, settledNow));
  }, [settled, settledNow]);

  // Entering a step: show its note and suggest its text where a box is empty.
  const step = currentStep(run);
  useEffect(() => {
    const entered = step;
    if (entered === null) return;
    const state = settledRef.current;
    focusNonce.current += 1;
    const next: DeviceFocus = { nonce: focusNonce.current };
    const noteId = state === null ? undefined : entered.note?.(state);
    if (noteId !== undefined) next.noteId = noteId;
    if (entered.prefill?.field === 'new-text') {
      next.newText = entered.prefill.text;
    } else if (entered.prefill?.field === 'edit') {
      next.editText = entered.prefill.text;
    }
    setFocus((previous) => ({ ...previous, [entered.device]: next }));
    // Only a new step or a new run enters a step.
  }, [run.runId, run.index]);

  const targetFid =
    step !== null && settledNow !== null ? step.target(settledNow) : null;
  const { control, recheck } = useStepControl(
    targetFid,
    settledNow,
    `${run.runId}:${run.index}`,
    step !== null && settledNow !== null,
  );
  // A step waits for a settled state; when the read that would settle it
  // failed, the guide says so rather than waiting without a reason.
  const blocked =
    step !== null && settledNow !== null
      ? blockedReason(step, settledNow, control)
      : step !== null && server.error !== null
        ? READ_FAILED
        : null;

  /**
   * Empties the server and both devices, then switches the guide with `next`.
   * When the server call fails nothing else changes.
   */
  function resetThen(next: (previous: GuideRun) => GuideRun) {
    if (resettingRef.current) return;
    resettingRef.current = true;
    setResetting(true);
    setResetError(null);
    latestRead.current += 1;
    resetSimulation(resetServer, [adjuster, office], () => {
      lastSeq.current = 0;
      setLog([]);
      setEpoch((value) => value + 1);
      setFocus({});
      setSettled(null);
      setRun(next);
    })
      .catch((cause: unknown) => {
        setResetError(`Reset failed: ${describe(cause)}`);
        // The reset dropped any read still open; read again so the guide
        // is not left waiting for it.
        setReadTick((value) => value + 1);
      })
      .finally(endReset);
  }

  function choose(id: ScenarioId) {
    resetThen((previous) => start(id, previous));
  }

  function reset() {
    resetThen((previous) => restart(previous));
  }

  function doStep() {
    if (resettingRef.current || lockedRef.current) return;
    // The screens may have moved since the last look. If the control is gone,
    // this puts the reason on the guide instead of doing nothing.
    if (recheck() !== 'ready') return;
    const el = findControl(targetFid);
    if (el === null) return;
    lockedRef.current = true;
    setLocked(true);
    lockTimer.current = setTimeout(() => {
      lockedRef.current = false;
      setLocked(false);
    }, STEP_LOCKOUT_MS);
    el.click();
  }

  return (
    <>
      <a className="skip" href="#main">
        Skip to the simulator
      </a>
      <header className="topbar">
        <div className="brand">
          <h1>Sync simulator</h1>
          <span className="sub">
            Case 05 · a fictional insurer&apos;s claim notes
          </span>
        </div>
        {resetError === null ? null : (
          <span className="reset-error" role="alert">
            {resetError}
          </span>
        )}
        <button
          type="button"
          data-fid="reset"
          disabled={resetting}
          onClick={reset}
        >
          Reset server and devices
        </button>
      </header>
      <GuideBar
        run={run}
        blocked={blocked}
        working={working || locked}
        resetting={resetting}
        onChoose={choose}
        onFree={() => {
          if (resettingRef.current) return;
          setRun((previous) => freePlay(previous));
        }}
        onRestart={reset}
        onDoStep={doStep}
      />
      <main id="main">
        <div className="stage" inert={resetting}>
          <div className="device-col phone-col">
            <DeviceToolbar
              id="adjuster"
              online={adjusterState.online}
              loseNextResponse={adjusterState.loseNextResponse}
              busy={adjusterState.busy}
              onOnline={(value) => void adjuster.setOnline(value)}
              onLoseNextResponse={adjuster.setLoseNextResponse}
            />
            <PhoneFrame id="adjuster" online={adjusterState.online}>
              <DeviceApp
                key={epoch}
                id="adjuster"
                device={adjuster}
                state={adjusterState}
                focus={focus.adjuster}
              />
            </PhoneFrame>
          </div>
          <Wire online={adjusterState.online} />
          <div className="server-col">
            <div className="dev-toolbar" aria-hidden="true" />
            <ServerArea view={server} />
          </div>
          <Wire online={officeState.online} fromBottom />
          <div className="device-col window-col">
            <DeviceToolbar
              id="office"
              online={officeState.online}
              loseNextResponse={officeState.loseNextResponse}
              busy={officeState.busy}
              onOnline={(value) => void office.setOnline(value)}
              onLoseNextResponse={office.setLoseNextResponse}
            />
            <WindowFrame id="office" online={officeState.online}>
              <DeviceApp
                key={epoch}
                id="office"
                device={office}
                state={officeState}
                focus={focus.office}
              />
            </WindowFrame>
          </div>
        </div>
        <ActivityLog entries={log} />
      </main>
    </>
  );
}
