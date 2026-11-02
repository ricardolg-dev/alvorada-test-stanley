import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { configureApp } from '../../src/configure-app';
import { SyncModule } from '../../src/sync.module';

/** Boots the real module in memory; every call returns a fresh, empty API. */
export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [SyncModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}

export interface WireOperation {
  op_id: string;
  note_id: string;
  base_revision: number;
  text: string;
}

export const operation = (
  op_id: string,
  base_revision: number,
  text: string,
  note_id = 'CLM-1042',
): WireOperation => ({ op_id, note_id, base_revision, text });

/** The HTTP server of an app, typed for supertest. */
export const serverOf = (app: INestApplication): App =>
  app.getHttpServer() as App;
