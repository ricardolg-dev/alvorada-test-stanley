import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  NoteNotFoundResult,
  Operation,
  OperationResult,
  RevisionMismatchResult,
} from '../api-client/contract';
import type { Device, Receipt } from '../device/device';
import { createDevice, type Transport } from '../device/device';
import { ConflictView } from './conflict-view';
import { DeviceApp } from './device-app';
import { ReceiptsList } from './receipts-list';
import { ResultSummary } from './result-summary';

const XSS = '<img src=x onerror=alert(1)>';

const mismatch: RevisionMismatchResult = {
  op_id: 'adj-0001',
  status: 'conflito',
  reason: 'revision_mismatch',
  note_id: 'CLM-1',
  server: { note_id: 'CLM-1', revision: 3, text: 'server words' },
  proposal: { base_revision: 1, text: 'my words' },
};

const notFound: NoteNotFoundResult = {
  op_id: 'adj-0002',
  status: 'conflito',
  reason: 'note_not_found',
  note_id: 'CLM-2',
  server: null,
  proposal: { base_revision: 4, text: 'orphan words' },
};

const noop = () => undefined;

const renderConflict = (
  conflict: RevisionMismatchResult | NoteNotFoundResult,
  disabled = false,
) =>
  renderToStaticMarkup(
    <ConflictView
      deviceId="adjuster"
      noteId={conflict.note_id}
      conflict={conflict}
      disabled={disabled}
      onResolve={noop}
    />,
  );

/** The opening tag of the element that carries a given data-fid. */
function tagOf(html: string, fid: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-fid="${fid}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no element with data-fid ${fid}`);
  return match[0];
}

const isDisabled = (tag: string) => / disabled(=|\s|>)/.test(tag);

describe('conflict view, revision_mismatch', () => {
  const html = renderConflict(mismatch);

  it('shows the server text with its revision beside the proposal', () => {
    expect(html).toContain('Server · r3');
    expect(html).toContain('server words');
    expect(html).toContain('Your proposal');
    expect(html).toContain('my words');
    expect(html.indexOf('server words')).toBeLessThan(html.indexOf('my words'));
  });

  it('offers the two choices and the combined send', () => {
    expect(html).toContain('Keep server text');
    expect(html).toContain('Use my text');
    expect(html).toContain('Send combined text');
    expect(html).not.toContain('Discard my text');
  });

  it('prefills the combined text with the server text, a line break and the proposal', () => {
    expect(html).toMatch(
      /<textarea[^>]*>\s*server words\nmy words<\/textarea>/,
    );
  });

  it('carries the data-fid of every resolve mode', () => {
    for (const mode of ['server', 'mine', 'custom']) {
      expect(html).toContain(`data-fid="resolve:adjuster:CLM-1:${mode}"`);
    }
  });

  it('disables the resolve buttons only while asked to', () => {
    expect(isDisabled(tagOf(html, 'resolve:adjuster:CLM-1:server'))).toBe(
      false,
    );
    const busy = renderConflict(mismatch, true);
    for (const mode of ['server', 'mine', 'custom']) {
      expect(isDisabled(tagOf(busy, `resolve:adjuster:CLM-1:${mode}`))).toBe(
        true,
      );
    }
  });
});

describe('conflict view, note_not_found', () => {
  const html = renderConflict(notFound);

  it('shows the proposal and no server column', () => {
    expect(html).toContain('orphan words');
    expect(html).not.toContain('Server ·');
    expect(html).not.toContain('<textarea');
  });

  it('offers to create it again or discard', () => {
    expect(html).toContain('Create it again with my text');
    expect(html).toContain('Discard my text');
    expect(html).not.toContain('Keep server text');
    expect(html).toContain('data-fid="resolve:adjuster:CLM-2:mine"');
    expect(html).toContain('data-fid="resolve:adjuster:CLM-2:discard"');
  });
});

function receipt(
  seq: number,
  result: OperationResult,
  resend = false,
): Receipt {
  return {
    seq,
    op: { op_id: `adj-${seq}`, note_id: 'CLM-1', base_revision: 0, text: 't' },
    result,
    resend,
  };
}

describe('receipts list', () => {
  const created: OperationResult = {
    op_id: 'adj-1',
    status: 'created',
    note: { note_id: 'CLM-1', revision: 1, text: 't' },
  };
  const updated: OperationResult = {
    op_id: 'adj-2',
    status: 'updated',
    note: { note_id: 'CLM-1', revision: 2, text: 't' },
  };
  const reused: OperationResult = { op_id: 'adj-3', status: 'id_reutilizado' };
  const invalid: OperationResult = {
    op_id: 'adj-4',
    status: 'invalid',
    reason: 'text is empty',
  };

  const render = (receipts: Receipt[], disabled = false) =>
    renderToStaticMarkup(
      <ReceiptsList
        deviceId="office"
        receipts={receipts}
        disabled={disabled}
        onResend={noop}
      />,
    );

  it('counts the receipts in the heading', () => {
    const html = render([receipt(2, updated), receipt(1, created)]);
    expect(html).toMatch(
      /<summary[^>]*data-fid="receipts:office"[^>]*>Receipts \(2\)<\/summary>/,
    );
  });

  it('writes one row per receipt with the status token and the result', () => {
    const html = render([
      receipt(5, invalid),
      receipt(4, reused),
      receipt(3, mismatch),
      receipt(2, updated),
      receipt(1, created),
    ]);
    expect(html.match(/class="receipt"/g)).toHaveLength(5);
    expect(html).toContain('adj-1');
    expect(html).toContain('created</span> at r1');
    expect(html).toContain('updated</span> to r2');
    expect(html).toContain('server r3 · proposal on base r1');
    expect(html).toContain('id_reutilizado');
    expect(html).toContain('text is empty');
  });

  it('gives each Resend button the receipt sequence in its data-fid', () => {
    const html = render([receipt(7, created), receipt(6, updated)]);
    expect(html).toContain('data-fid="resend:office:7"');
    expect(html).toContain('data-fid="resend:office:6"');
    expect(isDisabled(tagOf(html, 'resend:office:7'))).toBe(false);
  });

  it('disables Resend when the list is disabled', () => {
    const html = render([receipt(1, created)], true);
    expect(isDisabled(tagOf(html, 'resend:office:1'))).toBe(true);
  });

  it('marks a resent receipt', () => {
    expect(render([receipt(2, created, true)])).toContain('>resent<');
    expect(render([receipt(2, created, false)])).not.toContain('>resent<');
  });

  it('says so when there are no receipts', () => {
    const html = render([]);
    expect(html).toContain('Receipts (0)');
    expect(html).toContain(
      'No receipts yet. They arrive when an operation reaches the server.',
    );
    expect(html).not.toContain('Resend');
  });
});

describe('result summary', () => {
  it('summarises a not-found conflict without a server revision', () => {
    const html = renderToStaticMarkup(<ResultSummary result={notFound} />);
    expect(html).toContain('note not found · proposal on base r4');
  });
});

/** A device whose server answers every operation with a revision conflict. */
function conflictedDevice(): Device {
  const transport: Transport = {
    postOperations: (operations: Operation[]) =>
      Promise.resolve(
        operations.map((op): OperationResult => ({
          op_id: op.op_id,
          status: 'conflito',
          reason: 'revision_mismatch',
          note_id: op.note_id,
          server: { note_id: op.note_id, revision: 3, text: 'server words' },
          proposal: { base_revision: op.base_revision, text: op.text },
        })),
      ),
    getNotes: () => Promise.resolve([]),
  };
  return createDevice({
    prefix: 'adj',
    transport,
    random: (length) => Uint8Array.from({ length }, (_, i) => 0xa0 + i),
  });
}

describe('device app with a conflict', () => {
  it('replaces the editor with the conflict view and lists the receipt', async () => {
    const device = conflictedDevice();
    await device.createNote('my words');
    const html = renderToStaticMarkup(
      <DeviceApp id="adjuster" device={device} state={device.getState()} />,
    );
    expect(html).toContain('Keep server text');
    expect(html).toContain('Send combined text');
    expect(html).toContain('Receipts (1)');
    expect(html).not.toContain('Save edit');
    expect(html).not.toContain('not available');
  });
});

describe('escaping', () => {
  const escaped = '&lt;img src=x onerror=alert(1)&gt;';

  it('escapes hostile text in the conflict view', () => {
    const hostile: RevisionMismatchResult = {
      ...mismatch,
      server: { ...mismatch.server, text: XSS },
      proposal: { ...mismatch.proposal, text: XSS },
    };
    const html = renderConflict(hostile);
    expect(html).toContain(escaped);
    expect(html).not.toContain('<img');
    const missing = renderConflict({
      ...notFound,
      proposal: { ...notFound.proposal, text: XSS },
    });
    expect(missing).toContain(escaped);
    expect(missing).not.toContain('<img');
  });

  it('escapes hostile ids and results in the receipts list', () => {
    const html = renderToStaticMarkup(
      <ReceiptsList
        deviceId="adjuster"
        receipts={[
          {
            seq: 1,
            op: { op_id: XSS, note_id: XSS, base_revision: 0, text: XSS },
            result: {
              op_id: XSS,
              status: 'conflito',
              reason: 'revision_mismatch',
              note_id: XSS,
              server: { note_id: XSS, revision: 2, text: XSS },
              proposal: { base_revision: 1, text: XSS },
            },
            resend: false,
          },
        ]}
        disabled={false}
        onResend={noop}
      />,
    );
    expect(html).toContain(escaped);
    expect(html).not.toContain('<img');
  });
});
