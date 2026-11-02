import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeServer, type FakeServer } from './fake-server';

// The requests behind each example of docs/contract/results.json are replayed
// against the fake, so it cannot drift from the shapes the real API produces.
const path = fileURLToPath(
  new URL('../../../../docs/contract/results.json', import.meta.url),
);
const examples = JSON.parse(readFileSync(path, 'utf8')) as Record<
  string,
  unknown
>;

/** Keys and value kinds, ignoring the values themselves. */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

const operation = (
  op_id: string,
  base_revision: number,
  text: string,
  note_id = 'CLM-1042',
) => ({ op_id, note_id, base_revision, text });

async function send(server: FakeServer, body: unknown) {
  const response = await server.fetch('/api/operations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function get(server: FakeServer, route: string) {
  const response = await server.fetch(`/api${route}`);
  return { status: response.status, body: (await response.json()) as unknown };
}

/** The answer carries the example's `status` and the same keys and kinds. */
function expectLike(answer: unknown, key: string): void {
  const example = examples[key] as { status?: string; reason?: string };
  const got = answer as { status?: string; reason?: string };
  expect(shapeOf(answer), key).toStrictEqual(shapeOf(example));
  if (example.status !== undefined)
    expect(got.status, key).toBe(example.status);
  if (example.status === 'conflito')
    expect(got.reason, key).toBe(example.reason);
}

describe('the fake server answers like docs/contract/results.json', () => {
  it('answers created, updated, conflito, id_reutilizado and the note', async () => {
    const server = createFakeServer();

    const batch = await send(server, [
      operation(
        'adj-3f9c1d7a5b2e4c60',
        0,
        'Claim opened: rear bumper damage reported.',
      ),
      operation(
        'ofc-91a4e6027c3d58b2',
        1,
        'Rear bumper damage confirmed by the field adjuster.',
      ),
      operation(
        'adj-5d20b7e1c48a9f36',
        1,
        'Rear bumper and tail light damage reported.',
      ),
      operation(
        'adj-3f9c1d7a5b2e4c60',
        0,
        'A different text under a used op_id.',
      ),
    ]);
    const notes = await get(server, '/notes');
    const count = await get(server, '/receipts/count');

    expect(batch.status).toBe(200);
    const [created, updated, mismatch, reused] = batch.body as unknown[];
    expect(created).toStrictEqual(examples.created);
    expect(updated).toStrictEqual(examples.updated);
    expect(mismatch).toStrictEqual(examples.conflito_revision_mismatch);
    expect(reused).toStrictEqual(examples.id_reutilizado);
    for (const [answer, key] of [
      [created, 'created'],
      [updated, 'updated'],
      [mismatch, 'conflito_revision_mismatch'],
      [reused, 'id_reutilizado'],
    ] as const) {
      expectLike(answer, key);
    }
    expect(notes.status).toBe(200);
    expect(notes.body).toStrictEqual(examples.notes);
    expect(count.status).toBe(200);
    expect(count.body).toStrictEqual(examples.receipt_count);
  });

  it('accepts the operation example and answers with the created example', async () => {
    const server = createFakeServer();

    const { body } = await send(server, [examples.operation]);

    expect(body).toStrictEqual([examples.created]);
  });

  it('answers conflito for a note that does not exist', async () => {
    const server = createFakeServer();

    const { status, body } = await send(server, [
      operation('adj-0b8e4c7a2f163d95', 3, 'Repair estimate approved.'),
    ]);

    expect(status).toBe(200);
    expectLike((body as unknown[])[0], 'conflito_note_not_found');
    expect((body as unknown[])[0]).toStrictEqual(
      examples.conflito_note_not_found,
    );
  });

  it('answers invalid with and without an op_id, and stores neither', async () => {
    const server = createFakeServer();

    const { body } = await send(server, [
      operation('adj-c7f1a2e9560b3d84', -1, 'x'),
      'not an object',
    ]);

    const [withId, withoutId] = body as unknown[];
    expectLike(withId, 'invalid_with_op_id');
    expectLike(withoutId, 'invalid_without_op_id');
    expect((withId as { op_id: string }).op_id).toBe('adj-c7f1a2e9560b3d84');
    expect(server.notes()).toStrictEqual([]);
    expect((await get(server, '/receipts/count')).body).toStrictEqual({
      count: 0,
    });
  });
});

describe('the fake server keeps the other rules of the API', () => {
  it('answers POST /reset with 204 and no body, and empties the state', async () => {
    const server = createFakeServer();
    await send(server, [operation('a', 0, 'first')]);

    const response = await server.fetch('/api/reset', { method: 'POST' });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(server.notes()).toStrictEqual([]);
    expect((await get(server, '/receipts/count')).body).toStrictEqual({
      count: 0,
    });
  });

  it('lists notes sorted by note_id in code-unit order', async () => {
    const server = createFakeServer();
    await send(server, [
      operation('1', 0, 'x', 'b'),
      operation('2', 0, 'x', 'a'),
      operation('3', 0, 'x', 'B'),
      operation('4', 0, 'x', 'ä'),
    ]);

    const { body } = await get(server, '/notes');

    expect((body as { note_id: string }[]).map((n) => n.note_id)).toStrictEqual(
      ['B', 'a', 'b', 'ä'],
    );
  });

  it('returns the stored result for a repeated op_id with the same content', async () => {
    const server = createFakeServer();
    const first = await send(server, [operation('a', 0, 'first')]);
    await send(server, [operation('b', 1, 'second')]);

    const again = await send(server, [operation('a', 0, 'first')]);

    expect(again.body).toStrictEqual(first.body);
    expect(server.notes()[0]?.revision).toBe(2);
    expect((await get(server, '/receipts/count')).body).toStrictEqual({
      count: 2,
    });
  });

  it('answers id_reutilizado for a used op_id with other content', async () => {
    const server = createFakeServer();
    await send(server, [operation('a', 0, 'first')]);

    const { body } = await send(server, [
      operation('a', 0, 'other text'),
      { ...operation('a', 0, 'first'), note_id: 'CLM-9' },
    ]);

    expect(body).toStrictEqual([
      { op_id: 'a', status: 'id_reutilizado' },
      { op_id: 'a', status: 'id_reutilizado' },
    ]);
    expect(server.notes()).toHaveLength(1);
  });

  it.each([
    ['a missing field', { op_id: 'x', note_id: 'n', base_revision: 0 }],
    ['an extra field', { ...operation('x', 0, 't'), extra: 1 }],
    ['an empty op_id', operation('', 0, 't')],
    ['a fractional base_revision', operation('x', 0.5, 't')],
    ['a null', null],
    ['an array', []],
  ])('answers invalid for %s and stores nothing', async (_name, item) => {
    const server = createFakeServer();

    const { body } = await send(server, [item]);

    const [result] = body as { status: string; reason: string }[];
    expect(result?.status).toBe('invalid');
    expect(typeof result?.reason).toBe('string');
    expect(server.notes()).toStrictEqual([]);
    expect((await get(server, '/receipts/count')).body).toStrictEqual({
      count: 0,
    });
  });
});
