import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SyncModule } from './sync.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(SyncModule);
  await app.listen(3001, '127.0.0.1');
}

void bootstrap();
