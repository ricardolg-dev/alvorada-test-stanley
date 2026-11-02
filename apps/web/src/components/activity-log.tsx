import type { DeviceEvent } from '../device/device';
import { Icon } from './icons';
import { DEVICE_META, type DeviceId } from './device-meta';
import { StatusPill } from './result-summary';

export interface LogEntry {
  seq: number;
  source: DeviceId;
  event: DeviceEvent;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function requestLine(event: DeviceEvent): string {
  if (event.kind === 'pull') {
    return event.response === null
      ? 'GET /notes'
      : `GET /notes · ${plural(event.response.length, 'note')}`;
  }
  return event.kind === 'resend'
    ? 'POST /operations · resend'
    : `POST /operations · ${plural(event.request.length, 'operation')}`;
}

function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

/** Requests and responses of both devices, newest first. */
export function ActivityLog({ entries }: { entries: readonly LogEntry[] }) {
  const ordered = [...entries].sort((a, b) => b.seq - a.seq);
  return (
    <section className="card" aria-label="What just happened">
      <h2>What just happened</h2>
      {ordered.length === 0 ? (
        <p className="empty">
          Nothing sent yet. Each request and response appears here, newest
          first.
        </p>
      ) : (
        <div className="log">
          {ordered.map(({ seq, source, event }) => {
            const meta = DEVICE_META[source];
            const failed = event.error !== null;
            const lost = event.discarded || failed;
            const results =
              event.kind !== 'pull' && event.response !== null
                ? event.response
                : [];
            return (
              <details className="log-row" key={seq}>
                <summary data-fid={`log:${seq}`}>
                  <span className="seq">{seq}</span>
                  <span className="who-log">
                    <Icon name={meta.icon} /> {meta.name}
                  </span>
                  <span className="mono small muted">{requestLine(event)}</span>
                  {results.length > 0 ? (
                    <span className="chips">
                      {results.map((result, index) => (
                        <StatusPill key={index} text={result.status} />
                      ))}
                    </span>
                  ) : null}
                  {lost ? (
                    <StatusPill text="response lost" kind="lost" />
                  ) : null}
                </summary>
                <div className="log-json">
                  {event.request === null ? null : (
                    <div>
                      <span className="section-label">Request</span>
                      <Json value={event.request} />
                    </div>
                  )}
                  <div>
                    <span className="section-label">
                      {event.discarded
                        ? 'Response, lost on the way back'
                        : failed
                          ? 'Error'
                          : 'Response'}
                    </span>
                    {event.error === null ? (
                      <Json value={event.response} />
                    ) : (
                      <p className="log-error">{event.error}</p>
                    )}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
