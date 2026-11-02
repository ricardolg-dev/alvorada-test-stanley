// Same-origin HTTP calls to the API, through the `/api` proxy. Every call
// rejects on a network error, a timeout or a non-2xx answer; the device module
// treats such a rejection as a lost response.

import type { Transport } from '../device/device';
import type { Note, Operation, OperationResult } from './contract';

const API_PREFIX = '/api';
const REQUEST_TIMEOUT_MS = 8000;

export interface ApiClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  prefix?: string;
}

/** What the server area shows: current notes and the stored-receipt count. */
export interface ServerSnapshot {
  notes: Note[];
  receiptCount: number;
}

export interface ApiClient {
  transport: Transport;
  getReceiptCount: () => Promise<number>;
  /** One silent read of the server's state; it never goes through a device. */
  readServer: () => Promise<ServerSnapshot>;
  resetServer: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNote(value: unknown): value is Note {
  return (
    isRecord(value) &&
    typeof value.note_id === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.text === 'string'
  );
}

function parseNotes(body: unknown): Note[] {
  if (!Array.isArray(body) || !body.every(isNote)) {
    throw new Error('The server sent notes in an unexpected shape.');
  }
  return body;
}

function parseCount(body: unknown): number {
  if (
    !isRecord(body) ||
    typeof body.count !== 'number' ||
    !Number.isInteger(body.count) ||
    body.count < 0
  ) {
    throw new Error('The server sent a receipt count in an unexpected shape.');
  }
  return body.count;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const prefix = options.prefix ?? API_PREFIX;
  // Resolved at call time so a stub installed later is still honoured.
  const doFetch: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /**
   * Sends the request and reads the answer with `read`. The timer covers both:
   * a body that never finishes ends the call the same way a silent server does.
   */
  async function call<T>(
    path: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced against the request, so a fetch that ignores the signal still ends.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('The request timed out.'));
      }, timeoutMs);
    });
    const answer = (async () => {
      const response = await doFetch(`${prefix}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The server answered with status ${response.status}.`);
      }
      return read(response);
    })();
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const readJson = async (response: Response): Promise<unknown> =>
    (await response.json()) as unknown;

  const getJson = (path: string): Promise<unknown> => call(path, {}, readJson);

  const getReceiptCount = async (): Promise<number> =>
    parseCount(await getJson('/receipts/count'));

  const getNotes = async (): Promise<Note[]> =>
    parseNotes(await getJson('/notes'));

  const postOperations = async (
    operations: Operation[],
  ): Promise<OperationResult[]> => {
    // The device checks the shape of every result before it applies it.
    return (await call(
      '/operations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(operations),
      },
      readJson,
    )) as OperationResult[];
  };

  return {
    transport: { postOperations, getNotes },
    getReceiptCount,
    readServer: async () => {
      const [notes, receiptCount] = await Promise.all([
        getNotes(),
        getReceiptCount(),
      ]);
      return { notes, receiptCount };
    },
    resetServer: async () => {
      await call('/reset', { method: 'POST' }, () => Promise.resolve());
    },
  };
}

const defaultClient = createApiClient();

export const transport: Transport = defaultClient.transport;
export const readServer = defaultClient.readServer;
export const resetServer = defaultClient.resetServer;
