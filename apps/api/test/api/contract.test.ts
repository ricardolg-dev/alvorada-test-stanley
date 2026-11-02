import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, operation, serverOf } from './create-app';

const contract = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../docs/contract/results.json'),
    'utf8',
  ),
) as Record<string, unknown>;

let app: INestApplication;

beforeEach(async () => {
  app = await createApp();
});

afterEach(async () => {
  await app.close();
});

const server = () => serverOf(app);
const send = async (ops: unknown[]): Promise<unknown[]> =>
  (await request(server()).post('/operations').send(ops)).body as unknown[];

describe('responses match docs/contract/results.json', () => {
  it('matches created, updated, conflito, id_reutilizado and the note', async () => {
    const [created, updated, mismatch, reused] = await send([
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
    const note = (await request(server()).get('/notes/CLM-1042'))
      .body as unknown;
    const notes = (await request(server()).get('/notes')).body as unknown;
    const receiptCount = (await request(server()).get('/receipts/count'))
      .body as unknown;

    expect(created).toStrictEqual(contract.created);
    expect(updated).toStrictEqual(contract.updated);
    expect(mismatch).toStrictEqual(contract.conflito_revision_mismatch);
    expect(reused).toStrictEqual(contract.id_reutilizado);
    expect(note).toStrictEqual(contract.note);
    expect(notes).toStrictEqual(contract.notes);
    expect(receiptCount).toStrictEqual(contract.receipt_count);
  });

  it('accepts the operation example and answers with the created example', async () => {
    const [result] = await send([contract.operation]);

    expect(result).toStrictEqual(contract.created);
  });

  it('matches conflito for a note that does not exist', async () => {
    const [result] = await send([
      operation('adj-0b8e4c7a2f163d95', 3, 'Repair estimate approved.'),
    ]);

    expect(result).toStrictEqual(contract.conflito_note_not_found);
  });

  it('matches both invalid examples exactly, reason included', async () => {
    const [withId, withoutId] = await send([
      { ...operation('adj-c7f1a2e9560b3d84', 0, 'x'), base_revision: -1 },
      'not an object',
    ]);

    expect(withId).toStrictEqual(contract.invalid_with_op_id);
    expect(withoutId).toStrictEqual(contract.invalid_without_op_id);
  });
});
