import { Module } from '@nestjs/common';
import { createInMemoryStore } from './infrastructure/in-memory-store';
import { SYNC_STORE, SyncController } from './presentation/sync.controller';

@Module({
  controllers: [SyncController],
  providers: [{ provide: SYNC_STORE, useFactory: createInMemoryStore }],
})
export class SyncModule {}
