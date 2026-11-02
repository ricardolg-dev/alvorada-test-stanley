import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Operation, OperationResult } from '../api-client/contract';
import { createDevice, type Device, type Transport } from '../device/device';
import { DeviceApp } from './device-app';
import { DeviceToolbar } from './device-toolbar';
import { ServerArea } from './server-area';
import { resetSimulation, SimulatorPage } from './simulator-page';
import { Wire } from './wire';

// Bytes a0 a1 a2 ... make the first generated claim number CLM-A0A1A2A3.
const random = (length: number) =>
  Uint8Array.from({ length }, (_, index) => 0xa0 + index);

/** A server that creates every note at revision 1. */
const acceptingTransport: Transport = {
  postOperations: (operations: Operation[]) =>
    Promise.resolve(
      operations.map((op): OperationResult => ({
        op_id: op.op_id,
        status: 'created',
        note: { note_id: op.note_id, revision: 1, text: op.text },
      })),
    ),
  getNotes: () => Promise.resolve([]),
};

function newDevice(): Device {
  return createDevice({ prefix: 'adj', transport: acceptingTransport, random });
}

const render = (device: Device) =>
  renderToStaticMarkup(
    <DeviceApp id="adjuster" device={device} state={device.getState()} />,
  );

/** The opening tag of the element that carries a given data-fid. */
function tagOf(html: string, fid: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-fid="${fid}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no element with data-fid ${fid}`);
  return match[0];
}

const isDisabled = (tag: string) => / disabled(=|\s|>)/.test(tag);

function section(html: string, className: string): string {
  const start = html.indexOf(`<section class="${className}"`);
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) throw new Error(`no section ${className}`);
  return html.slice(start, end);
}

describe('page markup', () => {
  const html = renderToStaticMarkup(<SimulatorPage />);

  it('shows the phone, the computer window and the server', () => {
    expect(html).toContain('aria-label="Field adjuster phone"');
    expect(html).toContain('aria-label="Claims office computer"');
    expect(html).toContain('aria-label="Server"');
  });

  it('joins each device to the server by a line', () => {
    expect(html.match(/class="wire /g)).toHaveLength(2);
  });

  it('puts the toolbar of each device outside its frame', () => {
    for (const [id, frame, label] of [
      ['adjuster', 'phone', 'Field adjuster phone'],
      ['office', 'window', 'Claims office computer'],
    ] as const) {
      const framed = section(html, frame);
      expect(framed).toContain(`aria-label="${label}"`);
      expect(framed).not.toContain(`data-fid="net:${id}:`);
      expect(framed).not.toContain(`data-fid="lose:${id}"`);
      expect(html.indexOf(`data-fid="lose:${id}"`)).toBeLessThan(
        html.indexOf(`aria-label="${label}"`),
      );
    }
  });

  it('has one Lose next response per device and no Sync button', () => {
    expect(html.match(/Lose next response/g)).toHaveLength(2);
    expect(html).not.toMatch(/>\s*Sync\s*</);
  });

  it('carries the data-fid hooks the browser tests target', () => {
    for (const device of ['adjuster', 'office']) {
      for (const fid of [
        `net:${device}:online`,
        `net:${device}:offline`,
        `lose:${device}`,
        `pull:${device}`,
        `create:${device}`,
        `new-text:${device}`,
      ]) {
        expect(html).toContain(`data-fid="${fid}"`);
      }
    }
    expect(html).toContain('data-fid="reset"');
  });

  it('shows no retry on a fresh page', () => {
    expect(html).not.toContain('data-fid="retry:');
  });
});

describe('wire', () => {
  it('is solid and labelled Online while the device is online', () => {
    const html = renderToStaticMarkup(<Wire online />);
    expect(html).not.toContain(' off');
    expect(html).toContain('>Online<');
  });

  it('turns dashed and labelled Offline when the device is offline', () => {
    const html = renderToStaticMarkup(<Wire online={false} />);
    expect(html).toMatch(/class="wire [^"]*\boff\b/);
    expect(html).toContain('>Offline<');
  });
});

describe('device toolbar', () => {
  const props = {
    id: 'office' as const,
    online: false,
    loseNextResponse: true,
    busy: false,
    onOnline: () => undefined,
    onLoseNextResponse: () => undefined,
  };

  it('marks the pressed network state and the armed checkbox', () => {
    const html = renderToStaticMarkup(<DeviceToolbar {...props} />);
    expect(tagOf(html, 'net:office:offline')).toContain('aria-pressed="true"');
    expect(tagOf(html, 'net:office:online')).toContain('aria-pressed="false"');
    expect(tagOf(html, 'lose:office')).toContain('checked=""');
  });
});

describe('device app', () => {
  it('disables Pull while the device is offline and enables it online', async () => {
    const device = newDevice();
    expect(isDisabled(tagOf(render(device), 'pull:adjuster'))).toBe(false);

    await device.setOnline(false);

    expect(isDisabled(tagOf(render(device), 'pull:adjuster'))).toBe(true);
  });

  it('asks only for the note text when creating', () => {
    const html = render(newDevice());
    expect(html).toContain('data-fid="new-text:adjuster"');
    expect(html).toContain('The device generates the claim number.');
    expect(html).not.toContain('<input');
  });

  it('shows the generated claim number as text that no control edits', async () => {
    const device = newDevice();
    await device.createNote('rear bumper dented');

    const html = render(device);

    expect(html).toContain('CLM-A0A1A2A3');
    const fields = [...html.matchAll(/<textarea[^>]*>([^<]*)<\/textarea>/g)];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field[1]).not.toContain('CLM-');
    expect(html).not.toContain('<input');
  });

  it('keeps an offline edit pending without a Retry button', async () => {
    const device = newDevice();
    await device.setOnline(false);
    await device.createNote('written offline');

    const html = render(device);

    expect(html).toContain('>pending<');
    expect(html).not.toContain('data-fid="retry:');
    expect(isDisabled(tagOf(html, 'edit:adjuster:CLM-A0A1A2A3'))).toBe(false);
  });

  it('shows Retry and freezes the edit while a sent operation has no receipt', async () => {
    const device = newDevice();
    device.setLoseNextResponse(true);
    await device.createNote('response will be lost');

    const html = render(device);

    expect(tagOf(html, 'retry:adjuster')).toBeTruthy();
    expect(html).toContain('Retry (1)');
    expect(isDisabled(tagOf(html, 'retry:adjuster'))).toBe(false);
    expect(isDisabled(tagOf(html, 'edit:adjuster:CLM-A0A1A2A3'))).toBe(true);
    expect(isDisabled(tagOf(html, 'field-edit:adjuster:CLM-A0A1A2A3'))).toBe(
      true,
    );
  });

  it('drops Retry and unfreezes the edit once the receipt arrives', async () => {
    const device = newDevice();
    device.setLoseNextResponse(true);
    await device.createNote('response will be lost');
    await device.retry();

    const html = render(device);

    expect(html).not.toContain('data-fid="retry:');
    expect(isDisabled(tagOf(html, 'edit:adjuster:CLM-A0A1A2A3'))).toBe(false);
  });

  it('disables Retry while the device is offline', async () => {
    const device = newDevice();
    device.setLoseNextResponse(true);
    await device.createNote('response will be lost');
    await device.setOnline(false);

    expect(isDisabled(tagOf(render(device), 'retry:adjuster'))).toBe(true);
  });

  it('escapes note text instead of rendering it', async () => {
    const device = newDevice();
    await device.createNote('<img src=x onerror=alert(1)>');

    const html = render(device);

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('server area', () => {
  it('lists notes with their revisions and the receipt count', () => {
    const html = renderToStaticMarkup(
      <ServerArea
        view={{
          status: 'ready',
          notes: [{ note_id: 'CLM-0000AAAA', revision: 3, text: 'hello' }],
          receiptCount: 1,
          error: null,
        }}
      />,
    );
    expect(html).toContain('CLM-0000AAAA');
    expect(html).toContain('>r3<');
    expect(html).toContain('1 stored receipt<');
  });

  it('uses the plural for any other receipt count', () => {
    const html = renderToStaticMarkup(
      <ServerArea
        view={{ status: 'ready', notes: [], receiptCount: 0, error: null }}
      />,
    );
    expect(html).toContain('0 stored receipts');
    expect(html).toContain('No notes on the server.');
  });

  it('shows a failed read as an error and keeps the last notes', () => {
    const html = renderToStaticMarkup(
      <ServerArea
        view={{
          status: 'ready',
          notes: [{ note_id: 'CLM-0000AAAA', revision: 1, text: 'kept' }],
          receiptCount: 1,
          error: 'Could not read the server: boom',
        }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not read the server: boom');
    expect(html).toContain('kept');
  });
});

describe('resetSimulation', () => {
  it('empties the server before it resets either device', async () => {
    const order: string[] = [];
    const settled = () => Promise.resolve();
    await resetSimulation(() => {
      order.push('server');
      return Promise.resolve();
    }, [
      { settled, reset: () => order.push('adjuster') },
      { settled, reset: () => order.push('office') },
    ]);
    expect(order).toEqual(['server', 'adjuster', 'office']);
  });

  it('lets a request that is already open land before it empties the server', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored: string[] = [];
    const device = createDevice({
      prefix: 'adj',
      random,
      transport: {
        getNotes: () => Promise.resolve([]),
        postOperations: async (operations: Operation[]) => {
          await held;
          for (const op of operations) stored.push(op.note_id);
          return operations.map((op): OperationResult => ({
            op_id: op.op_id,
            status: 'created',
            note: { note_id: op.note_id, revision: 1, text: op.text },
          }));
        },
      },
    });
    const sending = device.createNote('still on its way');
    const emptied: string[][] = [];

    const resetting = resetSimulation(() => {
      emptied.push([...stored]);
      stored.length = 0;
      return Promise.resolve();
    }, [device]);
    await Promise.resolve();
    await Promise.resolve();
    expect(emptied).toEqual([]);

    release();
    await sending;
    await resetting;

    // The note had landed when the server was emptied, so none is left over.
    expect(emptied).toEqual([['CLM-A0A1A2A3']]);
    expect(stored).toEqual([]);
  });

  it('changes nothing on the devices when the server call fails', async () => {
    const device = newDevice();
    await device.createNote('keep me');

    await expect(
      resetSimulation(() => Promise.reject(new Error('down')), [device]),
    ).rejects.toThrow('down');

    expect(device.getState().seen.size).toBe(1);
  });

  it('puts a device back online, without Lose next response and with no notes', async () => {
    const device = newDevice();
    await device.setOnline(false);
    device.setLoseNextResponse(true);
    await device.createNote('gone after reset');

    await resetSimulation(() => Promise.resolve(), [device]);

    const state = device.getState();
    expect(state.online).toBe(true);
    expect(state.loseNextResponse).toBe(false);
    expect(state.outbox.size).toBe(0);
    expect(render(device)).toContain('No notes on this device.');
  });
});
