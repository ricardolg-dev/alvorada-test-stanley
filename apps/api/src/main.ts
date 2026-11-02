import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './configure-app';
import { SyncModule } from './sync.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(SyncModule);
  configureApp(app);
  await app.listen(3001, '127.0.0.1');
}

void bootstrap();
