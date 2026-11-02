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

const post = (body: unknown) =>
  request(serverOf(app))
    .post('/operations')
    .send(body as object);

describe('POST /operations', () => {
  it('starts with no notes', async () => {
    const res = await request(serverOf(app)).get('/notes');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual([]);
  });

  it('answers 200 with one result per operation, in order', async () => {
    const res = await post([
      operation('op-1', 0, 'Claim opened.'),
      { op_id: 'op-2', note_id: 'CLM-1042' },
      operation('op-3', 0, 'A stale edit.'),
      operation('op-4', 1, 'Photos attached.'),
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual([
      {
        op_id: 'op-1',
        status: 'created',
        note: { note_id: 'CLM-1042', revision: 1, text: 'Claim opened.' },
      },
      {
        op_id: 'op-2',
        status: 'invalid',
        reason: expect.any(String) as string,
      },
      {
        op_id: 'op-3',
        status: 'conflito',
        reason: 'revision_mismatch',
        note_id: 'CLM-1042',
        server: { note_id: 'CLM-1042', revision: 1, text: 'Claim opened.' },
        proposal: { base_revision: 0, text: 'A stale edit.' },
      },
      {
        op_id: 'op-4',
        status: 'updated',
        note: { note_id: 'CLM-1042', revision: 2, text: 'Photos attached.' },
      },
    ]);
  });

  it('answers 200 with an empty list for an empty batch', async () => {
    const res = await post([]);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual([]);
  });

  it('gives one invalid result per element of [1, null], without op_id', async () => {
    const res = await post([1, null]);

    expect(res.status).toBe(200);
    const results = res.body as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('invalid');
      expect(typeof result.reason).toBe('string');
      expect(Object.keys(result).sort()).toStrictEqual(['reason', 'status']);
    }
  });

  it('keeps op_id in an invalid result only when it was a string', async () => {
    const res = await post([
      { op_id: 'kept', note_id: 'CLM-1042' },
      { op_id: 7, note_id: 'CLM-1042' },
    ]);

    const results = res.body as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ op_id: 'kept', status: 'invalid' });
    expect(results[1]).not.toHaveProperty('op_id');
    expect(results[1]).toMatchObject({ status: 'invalid' });
  });

  it.each([
    ['an object', { op_id: 'x' }],
    ['a string', 'text'],
    ['a number', 3],
    ['null', null],
  ])(
    'answers 400 for a body that is %s and stores nothing',
    async (_n, body) => {
      const res = await request(serverOf(app))
        .post('/operations')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body));

      expect(res.status).toBe(400);
      const notes = await request(serverOf(app)).get('/notes');
      const count = await request(serverOf(app)).get('/receipts/count');
      expect(notes.body).toStrictEqual([]);
      expect(count.body).toStrictEqual({ count: 0 });
    },
  );

  it('answers 400 for an empty body and for a non-JSON content type', async () => {
    const empty = await request(serverOf(app)).post('/operations');
    const text = await request(serverOf(app))
      .post('/operations')
      .set('Content-Type', 'text/plain')
      .send('[]');

    expect(empty.status).toBe(400);
    expect(text.status).toBe(400);
  });

  it('answers 400 for malformed JSON', async () => {
    const res = await request(serverOf(app))
      .post('/operations')
      .set('Content-Type', 'application/json')
      .send('[{"op_id":');

    expect(res.status).toBe(400);
  });

  it('accepts a 110 KB text and stores it whole', async () => {
    const text = 'x'.repeat(110 * 1024);

    const res = await post([operation('big', 0, text)]);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual([
      {
        op_id: 'big',
        status: 'created',
        note: { note_id: 'CLM-1042', revision: 1, text },
      },
    ]);
  });

  it('rejects a body above the limit and stores nothing', async () => {
    const text = 'x'.repeat(11 * 1024 * 1024);

    const res = await post([operation('huge', 0, text)]);

    expect(res.status).toBe(413);
    const notes = await request(serverOf(app)).get('/notes');
    expect(notes.body).toStrictEqual([]);
  });
});
