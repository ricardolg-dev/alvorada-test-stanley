# HTTP API

The API behind the simulator. Start it with `pnpm dev`, as the [README](../README.md) explains.

## HTTP contract

The page reaches the API through a same-origin proxy: a request to `/api/<path>` on port 3000 goes to `<path>` on port 3001, the default ports. The [commands at the end](#commands-and-expected-answers) call the API on port 3001 directly. [`docs/contract/results.json`](contract/results.json) holds one example of every result, of a note, of an operation, of the note list and of the receipt count. It is test data only: the tests of both apps read it, `pnpm typecheck` compares it with the web app's contract types, and neither app imports it at run time, so there is no shared package.

| Endpoint              | Answer                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| `POST /operations`    | HTTP 200 and one result per operation, in order. Not a list: 400. Above 10 MB: 413 |
| `GET /notes`          | A bare array of notes, sorted by `note_id`                                         |
| `GET /notes/:id`      | A bare note, or HTTP 404                                                           |
| `GET /receipts/count` | `{"count": n}`, the number of stored receipts                                      |
| `POST /reset`         | HTTP 204. Empties notes and receipts                                               |

A note is `{note_id, revision, text}`. The results, each with `op_id` and a `status`:

- `created` and `updated`: `{op_id, status, note}`.
- `conflito`: `{op_id, status, reason, note_id, server, proposal}`. The reason is `revision_mismatch`, with the server's note in `server`, or `note_not_found`, with `server` set to `null`. The `proposal` is `{base_revision, text}`.
- `id_reutilizado`: `{op_id, status}`.
- `invalid`: `{op_id?, status, reason}`, with `op_id` only when the input carried a string `op_id`.

The position in the list ties a result to its operation. An operation with a missing or an extra field, an empty `op_id` or `note_id`, or a `base_revision` that is not an integer of 0 or more is `invalid`, and that does not stop the others.

## Commands and expected answers

The page and the API share one server: opening the page, `pnpm test:e2e` and the first `curl` command all reset it, and an open page does not notice a change made elsewhere until its next device action.

Each pair below is one command and its answer, indented here for reading (the API prints one line), then the HTTP status. They run in this order, starting with the reset. The operations O1 to O4 are the statement's example: O3 conflicts, O2 and O3 are resent, and O2 is reused with other content.

Reset the server first, so every id and answer below is stable. It answers 204 with no body.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/reset
```

```text
HTTP 204
```

The query on an empty server returns no notes.

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:3001/notes
```

```text
[]
HTTP 200
```

O1 creates the note at revision 1 (base revision 0).

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O1","note_id":"CLM-1042","base_revision":0,"text":"Claim opened."}]'
```

```text
[
  {
    "op_id": "O1",
    "status": "created",
    "note": {
      "note_id": "CLM-1042",
      "revision": 1,
      "text": "Claim opened."
    }
  }
]
HTTP 200
```

O2 changes it from revision 1: updated, revision 2.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O2","note_id":"CLM-1042","base_revision":1,"text":"Edit A"}]'
```

```text
[
  {
    "op_id": "O2",
    "status": "updated",
    "note": {
      "note_id": "CLM-1042",
      "revision": 2,
      "text": "Edit A"
    }
  }
]
HTTP 200
```

O3 also starts from revision 1, which is now outdated: conflito. The server keeps revision 2, and the answer carries both texts.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O3","note_id":"CLM-1042","base_revision":1,"text":"Edit B"}]'
```

```text
[
  {
    "op_id": "O3",
    "status": "conflito",
    "reason": "revision_mismatch",
    "note_id": "CLM-1042",
    "server": {
      "note_id": "CLM-1042",
      "revision": 2,
      "text": "Edit A"
    },
    "proposal": {
      "base_revision": 1,
      "text": "Edit B"
    }
  }
]
HTTP 200
```

Resending O2 returns the original receipt. The note stays at revision 2.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O2","note_id":"CLM-1042","base_revision":1,"text":"Edit A"}]'
```

```text
[
  {
    "op_id": "O2",
    "status": "updated",
    "note": {
      "note_id": "CLM-1042",
      "revision": 2,
      "text": "Edit A"
    }
  }
]
HTTP 200
```

O4 resolves the conflict with a new op_id, based on revision 2: updated, revision 3.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O4","note_id":"CLM-1042","base_revision":2,"text":"Edit A + B"}]'
```

```text
[
  {
    "op_id": "O4",
    "status": "updated",
    "note": {
      "note_id": "CLM-1042",
      "revision": 3,
      "text": "Edit A + B"
    }
  }
]
HTTP 200
```

Resending O3 now returns its original receipt, still showing revision 2. A receipt is what happened then, not what is true now.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O3","note_id":"CLM-1042","base_revision":1,"text":"Edit B"}]'
```

```text
[
  {
    "op_id": "O3",
    "status": "conflito",
    "reason": "revision_mismatch",
    "note_id": "CLM-1042",
    "server": {
      "note_id": "CLM-1042",
      "revision": 2,
      "text": "Edit A"
    },
    "proposal": {
      "base_revision": 1,
      "text": "Edit B"
    }
  }
]
HTTP 200
```

The query shows the note as it is now: revision 3.

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:3001/notes/CLM-1042
```

```text
{
  "note_id": "CLM-1042",
  "revision": 3,
  "text": "Edit A + B"
}
HTTP 200
```

Reusing O2 with another text is refused: id_reutilizado. Nothing changes.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O2","note_id":"CLM-1042","base_revision":1,"text":"Edit C"}]'
```

```text
[
  {
    "op_id": "O2",
    "status": "id_reutilizado"
  }
]
HTTP 200
```

An invalid operation (base revision -1) gets its own invalid result, with the reason. It is not stored.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O5","note_id":"CLM-1042","base_revision":-1,"text":"Bad"}]'
```

```text
[
  {
    "op_id": "O5",
    "status": "invalid",
    "reason": "base_revision: Too small: expected number to be >=0"
  }
]
HTTP 200
```

Four receipts are stored (O1 to O4). The invalid operation is not counted.

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:3001/receipts/count
```

```text
{
  "count": 4
}
HTTP 200
```

O5 was never stored, so a valid operation can use that op_id: updated, revision 4.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O5","note_id":"CLM-1042","base_revision":3,"text":"Edit D"}]'
```

```text
[
  {
    "op_id": "O5",
    "status": "updated",
    "note": {
      "note_id": "CLM-1042",
      "revision": 4,
      "text": "Edit D"
    }
  }
]
HTTP 200
```

Base revision 0 on a note that exists is a conflito, not a create. The note keeps revision 4.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '[{"op_id":"O6","note_id":"CLM-1042","base_revision":0,"text":"Overwrite"}]'
```

```text
[
  {
    "op_id": "O6",
    "status": "conflito",
    "reason": "revision_mismatch",
    "note_id": "CLM-1042",
    "server": {
      "note_id": "CLM-1042",
      "revision": 4,
      "text": "Edit D"
    },
    "proposal": {
      "base_revision": 0,
      "text": "Overwrite"
    }
  }
]
HTTP 200
```

The list of notes shows the one note, still at revision 4.

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:3001/notes
```

```text
[
  {
    "note_id": "CLM-1042",
    "revision": 4,
    "text": "Edit D"
  }
]
HTTP 200
```

A body that is not a list is rejected as a whole with HTTP 400.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3001/operations -H 'content-type: application/json' -d '{"op_id":"O7"}'
```

```text
{
  "message": "The request body must be a list.",
  "error": "Bad Request",
  "statusCode": 400
}
HTTP 400
```
