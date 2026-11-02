'use client';

import { useState } from 'react';
import type { ConflictResult } from '../api-client/contract';
import type { Resolution } from '../device/device';
import { StatusPill } from './result-summary';
import type { DeviceId } from './device-meta';

export interface ConflictViewProps {
  deviceId: DeviceId;
  noteId: string;
  conflict: ConflictResult;
  /** True while a request is in flight; offline a resolution just stays pending. */
  disabled: boolean;
  onResolve: (resolution: Resolution) => void;
}

/**
 * What the server holds beside what this device proposed, and the ways to
 * choose. It decides nothing: each button hands a resolution to the device.
 * Only the combined-text draft is local state.
 */
export function ConflictView({
  deviceId,
  noteId,
  conflict,
  disabled,
  onResolve,
}: ConflictViewProps) {
  const [combined, setCombined] = useState(
    conflict.server === null
      ? ''
      : `${conflict.server.text}\n${conflict.proposal.text}`,
  );
  const fid = (mode: string) => `resolve:${deviceId}:${noteId}:${mode}`;

  if (conflict.server === null) {
    return (
      <div className="conflict" role="status">
        <b>
          <StatusPill text="conflito" /> This note does not exist on the server.
        </b>
        <div className="box">{conflict.proposal.text}</div>
        <div className="row-actions">
          <button
            type="button"
            data-fid={fid('mine')}
            disabled={disabled}
            onClick={() => {
              onResolve({ mode: 'mine' });
            }}
          >
            Create it again with my text
          </button>
          <button
            type="button"
            data-fid={fid('discard')}
            disabled={disabled}
            onClick={() => {
              onResolve({ mode: 'discard' });
            }}
          >
            Discard my text
          </button>
        </div>
      </div>
    );
  }

  const server = conflict.server;
  return (
    <div className="conflict" role="status">
      <div>
        <StatusPill text="conflito" />{' '}
        {`The server moved to r${server.revision} while this device edited from r${conflict.proposal.base_revision}.`}
      </div>
      <div className="compare">
        <div>
          <span className="section-label">{`Server · r${server.revision}`}</span>
          <div className="box">{server.text}</div>
        </div>
        <div>
          <span className="section-label">Your proposal</span>
          <div className="box">{conflict.proposal.text}</div>
        </div>
      </div>
      <div className="row-actions">
        <button
          type="button"
          data-fid={fid('server')}
          disabled={disabled}
          onClick={() => {
            onResolve({ mode: 'discard' });
          }}
        >
          Keep server text
        </button>
        <button
          type="button"
          data-fid={fid('mine')}
          disabled={disabled}
          onClick={() => {
            onResolve({ mode: 'mine' });
          }}
        >
          Use my text
        </button>
      </div>
      <label className="field">
        Or combine both
        <textarea
          data-fid={`combo:${deviceId}:${noteId}`}
          value={combined}
          onChange={(event) => {
            setCombined(event.target.value);
          }}
        />
      </label>
      <div>
        <button
          type="button"
          className="primary"
          data-fid={fid('custom')}
          disabled={disabled}
          onClick={() => {
            onResolve({ mode: 'text', text: combined });
          }}
        >
          Send combined text
        </button>
      </div>
    </div>
  );
}
