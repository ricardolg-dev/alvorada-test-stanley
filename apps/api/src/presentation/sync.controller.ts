import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { Note, OperationResult } from '../domain/model';
import type { ResettableSyncStore } from '../domain/store';
import {
  countReceipts,
  getNote,
  listNotes,
  processOperations,
} from '../domain/sync';

/** The token under which the module provides the one shared store. */
export const SYNC_STORE = Symbol('SYNC_STORE');

/**
 * Thin HTTP layer: checks that the body is a list, sets status codes and
 * calls the domain. Every sync rule lives in `domain`.
 */
@Controller()
export class SyncController {
  constructor(
    @Inject(SYNC_STORE) private readonly store: ResettableSyncStore,
  ) {}

  @Post('operations')
  @HttpCode(200)
  applyOperations(@Body() body: unknown): OperationResult[] {
    if (!Array.isArray(body)) {
      throw new BadRequestException('The request body must be a list.');
    }
    return processOperations(this.store, body as unknown[]);
  }

  @Get('notes')
  notes(): Note[] {
    return listNotes(this.store);
  }

  @Get('notes/:id')
  note(@Param('id') id: string): Note {
    const found = getNote(this.store, id);
    if (found === undefined) {
      throw new NotFoundException(`Note ${id} does not exist.`);
    }
    return found;
  }

  @Get('receipts/count')
  receiptCount(): { count: number } {
    return { count: countReceipts(this.store) };
  }

  @Post('reset')
  @HttpCode(204)
  reset(): void {
    this.store.reset();
  }
}
