// Test-only: an in-memory `fetch` double for the API, with routes that can be
// held and released. The real sync rules live in the API; this double keeps
// just enough of them to answer with the shapes in docs/contract/results.json.
// It imports nothing from the API: fake-server.test.ts replays the requests
// behind that file against it, so it cannot drift from the real answers.

type Route =
  'POST /reset' | 'GET /notes' | 'GET /receipts/count' | 'POST /operations';

interface Note {
  note_id: string;
  revision: number;
  text: string;
}

interface Op {
  op_id: string;
  note_id: string;
  base_revision: number;
  text: string;
}

type Content = Pick<Op, 'note_id' | 'base_revision' | 'text'>;

interface Answer {
  status: number;
  body?: unknown;
}

const OP_KEYS = ['op_id', 'note_id', 'base_revision', 'text'];

/** Why an item is not an operation, or undefined when it is one. */
function invalidReason(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return 'operation must be an object';
  }
  const fields = item as Record<string, unknown>;
  const extra = Object.keys(fields).find((key) => !OP_KEYS.includes(key));
  if (extra !== undefined) return `unexpected field ${extra}`;
  for (const key of ['op_id', 'note_id']) {
    const value = fields[key];
    if (typeof value !== 'string' || value === '') {
      return `${key} must be a non-empty string`;
    }
  }
  const base = fields['base_revision'];
  if (typeof base !== 'number' || !Number.isInteger(base) || base < 0) {
    return 'base_revision must be an integer of 0 or more';
  }
  if (typeof fields['text'] !== 'string') return 'text must be a string';
  return undefined;
}

export interface FakeServer {
  fetch: typeof fetch;
  /** Requests to this route wait until `release` is called. */
  hold: (route: Route) => void;
  release: (route: Route) => void;
  /** Resolves once a request to a held route is waiting. */
  waitFor: (route: Route) => Promise<void>;
  /** How many requests each route has received. */
  calls: (route: Route) => number;
  notes: () => Note[];
}

export function createFakeServer(prefix = '/api'): FakeServer {
  const notes = new Map<string, Note>();
  const receipts = new Map<string, { content: Content; result: unknown }>();
  const gates = new Map<Route, { open: Promise<void>; open_: () => void }>();
  const arrivals = new Map<Route, (() => void)[]>();
  const waiting = new Map<Route, number>();
  const counts = new Map<Route, number>();

  function operate(item: unknown): unknown {
    const reason = invalidReason(item);
    if (reason !== undefined) {
      // Like the API, an invalid operation is answered and never stored.
      const opId = (item as { op_id?: unknown } | null)?.op_id;
      return typeof opId === 'string'
        ? { op_id: opId, status: 'invalid', reason }
        : { status: 'invalid', reason };
    }
    const op = item as Op;
    const stored = receipts.get(op.op_id);
    if (stored !== undefined) {
      const same =
        stored.content.note_id === op.note_id &&
        stored.content.base_revision === op.base_revision &&
        stored.content.text === op.text;
      return same
        ? structuredClone(stored.result)
        : { op_id: op.op_id, status: 'id_reutilizado' };
    }
    const current = notes.get(op.note_id);
    let result: unknown;
    if (op.base_revision === 0 && current === undefined) {
      const note = { note_id: op.note_id, revision: 1, text: op.text };
      notes.set(op.note_id, note);
      result = { op_id: op.op_id, status: 'created', note: { ...note } };
    } else if (current === undefined || current.revision !== op.base_revision) {
      result = {
        op_id: op.op_id,
        status: 'conflito',
        reason: current === undefined ? 'note_not_found' : 'revision_mismatch',
        note_id: op.note_id,
        server: current === undefined ? null : { ...current },
        proposal: { base_revision: op.base_revision, text: op.text },
      };
    } else {
      const note = {
        ...current,
        revision: current.revision + 1,
        text: op.text,
      };
      notes.set(op.note_id, note);
      result = { op_id: op.op_id, status: 'updated', note: { ...note } };
    }
    receipts.set(op.op_id, {
      content: {
        note_id: op.note_id,
        base_revision: op.base_revision,
        text: op.text,
      },
      result: structuredClone(result),
    });
    return result;
  }

  function answer(route: Route, body: string | null): Answer {
    switch (route) {
      case 'POST /reset':
        notes.clear();
        receipts.clear();
        return { status: 204 };
      case 'GET /notes':
        // Code-unit order, as the API sorts.
        return {
          status: 200,
          body: [...notes.values()]
            .sort((a, b) =>
              a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : 0,
            )
            .map((note) => ({ ...note })),
        };
      case 'GET /receipts/count':
        return { status: 200, body: { count: receipts.size } };
      case 'POST /operations':
        return {
          status: 200,
          body: (JSON.parse(body ?? '[]') as unknown[]).map(operate),
        };
    }
  }

  const fake = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    const route = `${init?.method ?? 'GET'} ${path}` as Route;
    counts.set(route, (counts.get(route) ?? 0) + 1);
    const gate = gates.get(route);
    if (gate) {
      waiting.set(route, (waiting.get(route) ?? 0) + 1);
      for (const notify of arrivals.get(route) ?? []) notify();
      await gate.open;
      waiting.set(route, (waiting.get(route) ?? 1) - 1);
    }
    const { status, body } = answer(
      route,
      typeof init?.body === 'string' ? init.body : null,
    );
    if (body === undefined) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    fetch: fake,
    hold: (route) => {
      if (gates.has(route)) return;
      let open_: () => void = () => undefined;
      const open = new Promise<void>((resolve) => {
        open_ = () => {
          resolve();
        };
      });
      gates.set(route, { open, open_ });
    },
    release: (route) => {
      gates.get(route)?.open_();
      gates.delete(route);
    },
    waitFor: (route) =>
      (waiting.get(route) ?? 0) > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            arrivals.set(route, [...(arrivals.get(route) ?? []), resolve]);
          }),
    calls: (route) => counts.get(route) ?? 0,
    notes: () => [...notes.values()].map((note) => ({ ...note })),
  };
}
