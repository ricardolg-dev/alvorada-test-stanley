import type { Note } from '../api-client/contract';
import { Icon } from './icons';

export interface ServerView {
  /** `loading` until the first read answers. */
  status: 'loading' | 'ready';
  notes: readonly Note[];
  receiptCount: number | null;
  /** The last read failed; the notes shown are from the last good read. */
  error: string | null;
}

export function receiptsLabel(count: number): string {
  return `${count} stored receipt${count === 1 ? '' : 's'}`;
}

/** The server between the devices: its notes as they are now and its receipts. */
export function ServerArea({ view }: { view: ServerView }) {
  return (
    <section className="server" aria-label="Server">
      <div className="server-head">
        <div className="server-title">
          <Icon name="server" /> Server
        </div>
        <span className="small muted">Notes as they are now</span>
      </div>
      <div className="server-body">
        {view.error === null ? null : (
          <p className="server-error" role="alert">
            {view.error}
          </p>
        )}
        {view.status === 'loading' && view.error === null ? (
          <p className="empty">Reading the server.</p>
        ) : view.notes.length > 0 ? (
          view.notes.map((note) => (
            <div className="snote" key={note.note_id}>
              <div className="row-top">
                <span className="mono">{note.note_id}</span>
                <span className="rev">{`r${note.revision}`}</span>
              </div>
              <div className="note-text">{note.text}</div>
            </div>
          ))
        ) : (
          <p className="empty">No notes on the server.</p>
        )}
      </div>
      <div className="server-foot">
        <span>
          {view.receiptCount === null
            ? 'Receipts unknown'
            : receiptsLabel(view.receiptCount)}
        </span>
      </div>
    </section>
  );
}
