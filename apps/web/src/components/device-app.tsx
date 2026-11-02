'use client';

import { useState } from 'react';
import type { Device, DeviceState } from '../device/device';
import { ConflictView } from './conflict-view';
import { DEVICE_META, type DeviceId } from './device-meta';
import { ReceiptsList } from './receipts-list';
import { StatusPill } from './result-summary';

export interface DeviceAppProps {
  id: DeviceId;
  device: Pick<
    Device,
    'createNote' | 'editNote' | 'pull' | 'retry' | 'resend' | 'resolve'
  >;
  state: DeviceState;
}

/**
 * The app inside a phone or a window. It renders the device module's state and
 * forwards each click to it; the sync rules stay in the module.
 */
export function DeviceApp({ id, device, state }: DeviceAppProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newText, setNewText] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const noteIds = [
    ...new Set([
      ...state.seen.keys(),
      ...state.outbox.keys(),
      ...state.conflicts.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const selected =
    selectedId !== null && noteIds.includes(selectedId)
      ? selectedId
      : noteIds[0];
  const showNew = noteIds.length === 0 || newOpen;
  const frozenCount = [...state.outbox.values()].filter(
    (entry) => entry.frozen,
  ).length;
  const pullOff = !state.online || state.busy;

  function create() {
    const text = newText;
    setNewText('');
    setNewOpen(false);
    void device.createNote(text).then((result) => {
      if (result.ok) setSelectedId(result.noteId);
    });
  }

  function renderChips(noteId: string) {
    const known = state.seen.get(noteId);
    const entry = state.outbox.get(noteId);
    return (
      <span className="chips">
        {known ? <StatusPill text={`r${known.revision}`} kind="rev" /> : null}
        {state.conflicts.has(noteId) ? <StatusPill text="conflito" /> : null}
        {entry ? (
          entry.frozen ? (
            <StatusPill text="waiting for receipt" kind="waiting" />
          ) : (
            <StatusPill text="pending" />
          )
        ) : null}
      </span>
    );
  }

  function renderDetail(noteId: string) {
    const known = state.seen.get(noteId);
    const entry = state.outbox.get(noteId);
    const conflictResult = state.conflicts.get(noteId);
    const conflicted = conflictResult !== undefined;
    const frozen = entry?.frozen === true;
    const key = `edit:${id}:${noteId}`;
    const value = drafts[noteId] ?? entry?.op.text ?? known?.text ?? '';
    return (
      <div className="stack">
        <div className="detail-head">
          <h3 className="mono">{noteId}</h3>
          <span className="small muted">
            {known
              ? `Last seen at r${known.revision}`
              : 'Not confirmed by the server yet'}
          </span>
        </div>
        {known && !conflicted ? (
          <div className="note-text">{known.text}</div>
        ) : null}
        {entry ? (
          <div className="pending-box">
            <span className="small muted">
              {frozen ? 'Sent, waiting for its receipt' : 'Pending'} ·{' '}
              <span className="mono">{entry.op.op_id}</span> · base r
              {entry.op.base_revision}
            </span>
            <div className="note-text">{entry.op.text}</div>
          </div>
        ) : null}
        {conflictResult !== undefined ? (
          <ConflictView
            key={conflictResult.op_id}
            deviceId={id}
            noteId={noteId}
            conflict={conflictResult}
            disabled={state.busy}
            onResolve={(resolution) => {
              void device.resolve(noteId, resolution);
            }}
          />
        ) : (
          <>
            <label className="field">
              Edit note
              <textarea
                data-fid={`field-${key}`}
                value={value}
                disabled={frozen || state.busy}
                onChange={(event) => {
                  setDrafts({ ...drafts, [noteId]: event.target.value });
                }}
              />
            </label>
            <div className="row-actions">
              <button
                type="button"
                data-fid={key}
                disabled={frozen || state.busy}
                onClick={() => {
                  const text = value;
                  setDrafts(
                    Object.fromEntries(
                      Object.entries(drafts).filter(([key]) => key !== noteId),
                    ),
                  );
                  void device.editNote(noteId, text);
                }}
              >
                Save edit
              </button>
              {frozen ? (
                <span className="small muted">
                  A sent operation is frozen until its receipt arrives.
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    );
  }

  const status = state.error ?? state.message;

  return (
    <div className="app-shell">
      <div className="app">
        <div className="app-head">
          <h3>{DEVICE_META[id].app}</h3>
        </div>
        <div className="app-actions">
          <button
            type="button"
            data-fid={`pull:${id}`}
            disabled={pullOff}
            onClick={() => {
              void device.pull();
            }}
          >
            Pull notes
          </button>
          {state.canRetry ? (
            <button
              type="button"
              className="primary"
              data-fid={`retry:${id}`}
              disabled={pullOff}
              onClick={() => {
                void device.retry();
              }}
            >
              {`Retry (${frozenCount})`}
            </button>
          ) : null}
        </div>
        <div className={`app-body ${noteIds.length > 0 ? '' : 'single'}`}>
          <div className="pane">
            {noteIds.length > 0 ? (
              <div className="stack">
                <div className="list-head">
                  <span className="section-label">Notes</span>
                  {showNew ? null : (
                    <button
                      type="button"
                      data-fid={`new:${id}`}
                      onClick={() => {
                        setNewOpen(true);
                      }}
                    >
                      New note
                    </button>
                  )}
                </div>
                <div className="note-list">
                  {noteIds.map((noteId) => (
                    <button
                      type="button"
                      key={noteId}
                      className="note-row"
                      data-fid={`select:${id}:${noteId}`}
                      aria-pressed={noteId === selected}
                      onClick={() => {
                        setSelectedId(noteId);
                      }}
                    >
                      <span className="row-top">
                        <span className="mono">{noteId}</span>
                        {renderChips(noteId)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty">
                No notes on this device. Create one, or pull from the server.
              </p>
            )}
            {showNew ? (
              <div className="stack">
                <label className="field">
                  Note text
                  <textarea
                    data-fid={`new-text:${id}`}
                    value={newText}
                    onChange={(event) => {
                      setNewText(event.target.value);
                    }}
                  />
                </label>
                <p className="small muted">
                  The device generates the claim number.
                </p>
                <div>
                  <button
                    type="button"
                    data-fid={`create:${id}`}
                    disabled={state.busy}
                    onClick={create}
                  >
                    Create note
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          {noteIds.length > 0 && selected !== undefined ? (
            <div className="pane">
              {renderDetail(selected)}
              <ReceiptsList
                deviceId={id}
                receipts={state.receipts}
                disabled={!state.online || state.busy}
                onResend={(seq) => {
                  void device.resend(seq);
                }}
              />
            </div>
          ) : null}
        </div>
        <div
          className={`app-status ${state.error === null ? '' : 'error'}`}
          role="status"
        >
          {status}
        </div>
      </div>
    </div>
  );
}
