import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, operation } from './create-app';

let app: INestApplication;
let url: string;

beforeEach(async () => {
  app = await createApp();
  // Listen on an ephemeral port: supertest cannot start one server twice
  // when two requests run in parallel.
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
});

afterEach(async () => {
  await app.close();
});

const send = (ops: unknown[]) => request(url).post('/operations').send(ops);

type Result = { status: string; [key: string]: unknown };

describe('simultaneous batches', () => {
  it('gives one updated and one conflito for the same base revision', async () => {
    await send([operation('base', 0, 'start')]);

    const [a, b] = await Promise.all([
      send([operation('edit-a', 1, 'edit A')]),
      send([operation('edit-b', 1, 'edit B')]),
    ]);

    const statuses = [
      (a.body as Result[])[0]?.status,
      (b.body as Result[])[0]?.status,
    ].sort();
    expect(statuses).toStrictEqual(['conflito', 'updated']);
    const note = await request(url).get('/notes/CLM-1042');
    expect((note.body as { revision: number }).revision).toBe(2);
  });

  it('gives equal results, one revision and one receipt for the same op_id', async () => {
    await send([operation('base', 0, 'start')]);

    const [a, b] = await Promise.all([
      send([operation('same', 1, 'edit')]),
      send([operation('same', 1, 'edit')]),
    ]);

    expect(a.status).toBe(200);
    expect(a.body).toStrictEqual(b.body);
    expect((a.body as Result[])[0]).toMatchObject({ status: 'updated' });
    const note = await request(url).get('/notes/CLM-1042');
    const count = await request(url).get('/receipts/count');
    expect((note.body as { revision: number }).revision).toBe(2);
    expect(count.body).toStrictEqual({ count: 2 });
  });

  it('returns the original receipt on a resend, with no new revision', async () => {
    const first = await send([operation('once', 0, 'start')]);
    const resend = await send([operation('once', 0, 'start')]);

    expect(resend.status).toBe(200);
    expect(resend.body).toStrictEqual(first.body);
    const note = await request(url).get('/notes/CLM-1042');
    expect(note.body).toStrictEqual({
      note_id: 'CLM-1042',
      revision: 1,
      text: 'start',
    });
  });
});
