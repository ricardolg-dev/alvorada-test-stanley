import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Operation, OperationResult } from '../api-client/contract';
import { ActivityLog, type LogEntry } from './activity-log';
import { SimulatorPage } from './simulator-page';

const op = (id: string): Operation => ({
  op_id: id,
  note_id: 'CLM-1',
  base_revision: 0,
  text: 'text',
});

const created = (id: string): OperationResult => ({
  op_id: id,
  status: 'created',
  note: { note_id: 'CLM-1', revision: 1, text: 'text' },
});

const send = (seq: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  seq,
  source: 'adjuster',
  event: {
    kind: 'send',
    request: [op(`a-${seq}`), op(`b-${seq}`), op(`c-${seq}`)],
    response: [
      created(`a-${seq}`),
      { op_id: `b-${seq}`, status: 'id_reutilizado' },
      { op_id: `c-${seq}`, status: 'invalid', reason: 'bad' },
    ],
    error: null,
    discarded: false,
  },
  ...overrides,
});

const render = (entries: LogEntry[]) =>
  renderToStaticMarkup(<ActivityLog entries={entries} />);

describe('activity log', () => {
  it('says so when nothing was sent', () => {
    const html = render([]);
    expect(html).toContain('What just happened');
    expect(html).toContain(
      'Nothing sent yet. Each request and response appears here, newest first.',
    );
    expect(html).not.toContain('<details');
  });

  it('lists entries newest first whatever order they arrive in', () => {
    const html = render([send(1), send(3), send(2)]);
    const at = (seq: number) => html.indexOf(`data-fid="log:${seq}"`);
    expect(at(3)).toBeGreaterThan(-1);
    expect(at(3)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(1));
  });

  it('writes the sequence, the device name and the request line', () => {
    const html = render([
      send(4),
      send(3, {
        source: 'office',
        event: {
          kind: 'pull',
          request: null,
          response: [
            { note_id: 'CLM-1', revision: 1, text: 'a' },
            { note_id: 'CLM-2', revision: 1, text: 'b' },
          ],
          error: null,
          discarded: false,
        },
      }),
      send(2, {
        event: {
          kind: 'resend',
          request: [op('a-2')],
          response: [created('a-2')],
          error: null,
          discarded: false,
        },
      }),
      send(1, {
        event: {
          kind: 'send',
          request: [op('a-1')],
          response: [created('a-1')],
          error: null,
          discarded: false,
        },
      }),
    ]);
    expect(html).toContain('Field adjuster');
    expect(html).toContain('Claims office');
    expect(html).toContain('POST /operations · 3 operations');
    expect(html).toContain('GET /notes · 2 notes');
    expect(html).toContain('POST /operations · resend');
    expect(html).toContain('POST /operations · 1 operation<');
  });

  it('shows one status pill per result', () => {
    const html = render([send(1)]);
    expect(html).toContain('>created<');
    expect(html).toContain('>id_reutilizado<');
    expect(html).toContain('>invalid<');
  });

  it('keeps the request and response JSON in a closed details element', () => {
    const html = render([send(1)]);
    expect(html).toMatch(/<details class="log-row">/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('<pre>');
    expect(html).toContain('&quot;op_id&quot;: &quot;a-1&quot;');
    expect(html).toContain('Request');
    expect(html).toContain('>Response<');
    expect(html).not.toContain('response lost');
  });

  it('marks a lost response and keeps what the server answered', () => {
    const base = send(1);
    const html = render([
      {
        ...base,
        event: { ...base.event, discarded: true } as LogEntry['event'],
      },
    ]);
    expect(html).toContain('>response lost<');
    expect(html).toContain('Response, lost on the way back');
  });

  it('shows the error message in place of a response, marked as a failed request', () => {
    const html = render([
      send(1, {
        event: {
          kind: 'send',
          request: [op('a-1')],
          response: null,
          error: 'The request timed out.',
          discarded: false,
        },
      }),
    ]);
    expect(html).toContain('The request timed out.');
    expect(html).toContain('>request failed<');
    expect(html).not.toContain('response lost');
    expect(html).not.toContain('>Response<');
    expect(html).not.toContain('null');
  });

  it('escapes hostile text in the JSON and the error', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = render([
      send(1, {
        event: {
          kind: 'send',
          request: [{ ...op('a-1'), text: hostile }],
          response: null,
          error: hostile,
          discarded: false,
        },
      }),
    ]);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});

describe('page', () => {
  it('puts the log below the stage', () => {
    const html = renderToStaticMarkup(<SimulatorPage />);
    expect(html.indexOf('aria-label="What just happened"')).toBeGreaterThan(
      html.indexOf('aria-label="Claims office computer"'),
    );
    expect(html).toContain('Nothing sent yet.');
  });
});
