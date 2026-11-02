import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, operation, serverOf } from './create-app';

let app: INestApplication;

beforeEach(async () => {
  app = await createApp();
});

afterEach(async () => {
  await app.close();
});

const server = () => serverOf(app);
const send = (ops: unknown[]) =>
  request(server()).post('/operations').send(ops);

describe('note queries', () => {
  it('returns the current note, and 404 for a missing one', async () => {
    await send([operation('a', 0, 'first'), operation('b', 1, 'second')]);

    const found = await request(server()).get('/notes/CLM-1042');
    const missing = await request(server()).get('/notes/CLM-0000');

    expect(found.status).toBe(200);
    expect(found.body).toStrictEqual({
      note_id: 'CLM-1042',
      revision: 2,
      text: 'second',
    });
    expect(missing.status).toBe(404);
  });

  it('finds a percent-encoded note_id with a space and a slash', async () => {
    const id = 'CLM 7/B';
    await send([operation('a', 0, 'odd id', id)]);

    const res = await request(server()).get(`/notes/${encodeURIComponent(id)}`);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      note_id: id,
      revision: 1,
      text: 'odd id',
    });
  });

  it.each(['constructor', '__proto__'])(
    'answers 404 for %s on an empty server',
    async (id) => {
      const res = await request(server()).get(`/notes/${id}`);

      expect(res.status).toBe(404);
    },
  );

  it('lists notes sorted by note_id', async () => {
    await send([
      operation('a', 0, 'c', 'CLM-3'),
      operation('b', 0, 'a', 'CLM-1'),
      operation('c', 0, 'b', 'CLM-2'),
    ]);

    const res = await request(server()).get('/notes');

    expect(
      (res.body as { note_id: string }[]).map((n) => n.note_id),
    ).toStrictEqual(['CLM-1', 'CLM-2', 'CLM-3']);
  });
});

describe('receipts and reset', () => {
  it('counts stored receipts and not invalid operations', async () => {
    await send([
      operation('a', 0, 'one'),
      operation('b', 5, 'conflicting'),
      { op_id: 'bad' },
      7,
    ]);

    const res = await request(server()).get('/receipts/count');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ count: 2 });
  });

  it('resets with 204, empties notes and receipts and frees used op_ids', async () => {
    await send([operation('a', 0, 'one')]);

    const reset = await request(server()).post('/reset');
    const notes = await request(server()).get('/notes');
    const count = await request(server()).get('/receipts/count');
    const again = await send([operation('a', 0, 'one')]);

    expect(reset.status).toBe(204);
    expect(reset.text).toBe('');
    expect(notes.body).toStrictEqual([]);
    expect(count.body).toStrictEqual({ count: 0 });
    expect(again.body).toStrictEqual([
      {
        op_id: 'a',
        status: 'created',
        note: { note_id: 'CLM-1042', revision: 1, text: 'one' },
      },
    ]);
  });

  it('shares one store between requests of the same app', async () => {
    await send([operation('a', 0, 'one')]);
    await send([operation('b', 1, 'two')]);

    const res = await request(server()).get('/notes/CLM-1042');

    expect((res.body as { revision: number }).revision).toBe(2);
  });

  it('does not share state between two apps', async () => {
    await send([operation('a', 0, 'one')]);
    const other = await createApp();
    try {
      const res = await request(serverOf(other)).get('/notes');
      expect(res.body).toStrictEqual([]);
    } finally {
      await other.close();
    }
  });
});
