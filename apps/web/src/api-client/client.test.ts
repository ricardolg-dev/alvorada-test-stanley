import { describe, expect, it } from 'vitest';
import examples from '../../../../docs/contract/results.json';
import { createDevice } from '../device/device';
import { createApiClient } from './client';
import type { Operation } from './contract';

interface Call {
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
}

type Answer = Response | Error | 'hang' | 'hang-body';

/** A fetch stub: answers by path and records each request it receives. */
function stubFetch(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const stub = ((input: string, init?: RequestInit) => {
    const url = input;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      contentType: new Headers(init?.headers).get('content-type'),
    });
    const answer = answers[url];
    if (answer === undefined) return Promise.reject(new Error(`no ${url}`));
    // 'hang' never settles and ignores the abort signal on purpose.
    if (answer === 'hang') return new Promise<Response>(() => undefined);
    // Headers arrive, but the body never finishes.
    if (answer === 'hang-body') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
      } as unknown as Response);
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  }) as typeof fetch;
  return { stub, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const operation: Operation = {
  op_id: 'adj-0001',
  note_id: 'CLM-0000AAAA',
  base_revision: 0,
  text: 'rear bumper dented',
};

describe('transport', () => {
  it('posts the batch as JSON to the proxied operations path', async () => {
    const results = [
      {
        op_id: 'adj-0001',
        status: 'created',
        note: {
          note_id: 'CLM-0000AAAA',
          revision: 1,
          text: 'rear bumper dented',
        },
      },
    ];
    const { stub, calls } = stubFetch({ '/api/operations': json(results) });
    const client = createApiClient({ fetch: stub });

    await expect(client.transport.postOperations([operation])).resolves.toEqual(
      results,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual([operation]);
  });

  it('reads the notes from the proxied notes path', async () => {
    const notes = [{ note_id: 'CLM-0000AAAA', revision: 2, text: 'x' }];
    const { stub, calls } = stubFetch({ '/api/notes': json(notes) });
    const client = createApiClient({ fetch: stub });

    await expect(client.transport.getNotes()).resolves.toEqual(notes);
    expect(calls[0]).toMatchObject({ url: '/api/notes', method: 'GET' });
  });

  it('rejects on a non-2xx answer to POST /operations', async () => {
    const { stub } = stubFetch({ '/api/operations': json({}, 500) });
    const client = createApiClient({ fetch: stub });

    await expect(client.transport.postOperations([operation])).rejects.toThrow(
      /500/,
    );
  });

  it('rejects on a 400 answer so a bad batch is never taken as results', async () => {
    const { stub } = stubFetch({
      '/api/operations': json({ error: 'x' }, 400),
    });
    const client = createApiClient({ fetch: stub });

    await expect(
      client.transport.postOperations([operation]),
    ).rejects.toThrow();
  });

  it('rejects when the network fails', async () => {
    const { stub } = stubFetch({
      '/api/operations': new TypeError('Failed to fetch'),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.transport.postOperations([operation])).rejects.toThrow(
      'Failed to fetch',
    );
  });

  it('rejects when the request outlives the timeout, even if fetch ignores the abort', async () => {
    const { stub } = stubFetch({ '/api/operations': 'hang' });
    const client = createApiClient({ fetch: stub, timeoutMs: 20 });

    await expect(client.transport.postOperations([operation])).rejects.toThrow(
      /timed out/,
    );
  });

  it('rejects when the headers arrive but the body never finishes', async () => {
    const { stub } = stubFetch({ '/api/operations': 'hang-body' });
    const client = createApiClient({ fetch: stub, timeoutMs: 20 });

    await expect(client.transport.postOperations([operation])).rejects.toThrow(
      /timed out/,
    );
  });

  it('times out a read whose body never finishes', async () => {
    const { stub } = stubFetch({ '/api/notes': 'hang-body' });
    const client = createApiClient({ fetch: stub, timeoutMs: 20 });

    await expect(client.transport.getNotes()).rejects.toThrow(/timed out/);
  });

  it('leaves a device not busy with Retry available after such a send', async () => {
    const { stub } = stubFetch({ '/api/operations': 'hang-body' });
    const client = createApiClient({ fetch: stub, timeoutMs: 20 });
    const device = createDevice({
      prefix: 'adj',
      transport: client.transport,
      random: (length) => Uint8Array.from({ length }, (_, i) => 0xa0 + i),
    });

    await device.createNote('rear bumper dented');

    const state = device.getState();
    expect(state.busy).toBe(false);
    expect(state.canRetry).toBe(true);
    expect(state.error).toMatch(/timed out/);
    expect([...state.outbox.values()].every((entry) => entry.frozen)).toBe(
      true,
    );
  });

  it('rejects when the answer is not JSON', async () => {
    const { stub } = stubFetch({
      '/api/operations': new Response('<html>', { status: 200 }),
    });
    const client = createApiClient({ fetch: stub });

    await expect(
      client.transport.postOperations([operation]),
    ).rejects.toThrow();
  });
});

describe('server reads and reset', () => {
  it('reads the receipt count', async () => {
    const { stub, calls } = stubFetch({
      '/api/receipts/count': json({ count: 3 }),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.getReceiptCount()).resolves.toBe(3);
    expect(calls[0]?.url).toBe('/api/receipts/count');
  });

  it('rejects a receipt count that is not a count', async () => {
    const { stub } = stubFetch({
      '/api/receipts/count': json({ count: 'many' }),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.getReceiptCount()).rejects.toThrow(/unexpected shape/);
  });

  it('combines notes and receipt count in one silent read', async () => {
    const notes = [{ note_id: 'CLM-0000AAAA', revision: 1, text: 'a' }];
    const { stub, calls } = stubFetch({
      '/api/notes': json(notes),
      '/api/receipts/count': json({ count: 1 }),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.readServer()).resolves.toEqual({
      notes,
      receiptCount: 1,
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  it('rejects the whole read when one half fails', async () => {
    const { stub } = stubFetch({
      '/api/notes': json([]),
      '/api/receipts/count': json({}, 503),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.readServer()).rejects.toThrow(/503/);
  });

  it('posts to /reset and accepts 204', async () => {
    const { stub, calls } = stubFetch({
      '/api/reset': new Response(null, { status: 204 }),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.resetServer()).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: '/api/reset', method: 'POST' });
  });

  it('rejects when /reset fails', async () => {
    const { stub } = stubFetch({
      '/api/reset': new Response(null, { status: 500 }),
    });
    const client = createApiClient({ fetch: stub });

    await expect(client.resetServer()).rejects.toThrow(/500/);
  });
});

describe('the shared contract examples', () => {
  it('sends the operation example and returns the created example', async () => {
    const { stub, calls } = stubFetch({
      '/api/operations': json([examples.created]),
    });
    const client = createApiClient({ fetch: stub });

    const results = await client.transport.postOperations([examples.operation]);

    expect(JSON.parse(calls[0]?.body ?? 'null')).toStrictEqual([
      examples.operation,
    ]);
    expect(results).toStrictEqual([examples.created]);
  });

  it('reads the notes example and the receipt_count example', async () => {
    const answers = () => ({
      '/api/notes': json(examples.notes),
      '/api/receipts/count': json(examples.receipt_count),
    });

    const notes = await createApiClient({
      fetch: stubFetch(answers()).stub,
    }).transport.getNotes();
    const count = await createApiClient({
      fetch: stubFetch(answers()).stub,
    }).getReceiptCount();
    const server = await createApiClient({
      fetch: stubFetch(answers()).stub,
    }).readServer();

    expect(notes).toStrictEqual(examples.notes);
    expect(count).toBe(examples.receipt_count.count);
    expect(server).toStrictEqual({
      notes: examples.notes,
      receiptCount: examples.receipt_count.count,
    });
  });
});
