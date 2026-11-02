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
import { DeviceApp } from './device-app';
import type { DeviceId } from './device-meta';
import { PhoneFrame, WindowFrame } from './device-frames';
import { DeviceToolbar } from './device-toolbar';
import { Wire } from './wire';
import { ServerArea, type ServerView } from './server-area';

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
 * Empties the server first, then puts both devices back to their first state.
 * Then runs `afterReset`, which clears what the page keeps of its own, the
 * log. When the server call fails nothing else changes.
 */
export async function resetSimulation(
  resetTheServer: () => Promise<void>,
  devices: readonly Pick<Device, 'reset'>[],
  afterReset?: () => void,
): Promise<void> {
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
  const latestRead = useRef(0);

  // A silent read on mount and after every device state change or Reset. It
  // goes through the api-client only, never through a device's Pull. A slower
  // answer to an older read is dropped.
  useEffect(() => {
    const id = ++latestRead.current;
    readServer().then(
      (snapshot) => {
        if (id !== latestRead.current) return;
        setServer({
          status: 'ready',
          notes: snapshot.notes,
          receiptCount: snapshot.receiptCount,
          error: null,
        });
      },
      (cause: unknown) => {
        if (id !== latestRead.current) return;
        setServer((previous) => ({
          ...previous,
          status: 'ready',
          error: `Could not read the server: ${describe(cause)}`,
        }));
      },
    );
  }, [adjusterState, officeState]);

  function reset() {
    setResetError(null);
    resetSimulation(resetServer, [adjuster, office], () => {
      lastSeq.current = 0;
      setLog([]);
    }).catch((cause: unknown) => {
      setResetError(`Reset failed: ${describe(cause)}`);
    });
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
        <button type="button" data-fid="reset" onClick={reset}>
          Reset server and devices
        </button>
      </header>
      <main id="main">
        <div className="stage">
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
                id="adjuster"
                device={adjuster}
                state={adjusterState}
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
              <DeviceApp id="office" device={office} state={officeState} />
            </WindowFrame>
          </div>
        </div>
        <ActivityLog entries={log} />
      </main>
    </>
  );
}
