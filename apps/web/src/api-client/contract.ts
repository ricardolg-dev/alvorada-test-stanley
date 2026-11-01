// Wire types of the HTTP contract the page relies on. The API keeps its own
// copy of these shapes; docs/contract/results.json holds one example of each,
// and the tests of both apps read it so the two sides cannot drift apart.

/** A note as the server holds it. */
export interface Note {
  note_id: string;
  revision: number;
  text: string;
}

/** One operation of a batch sent to POST /operations. */
export interface Operation {
  op_id: string;
  note_id: string;
  base_revision: number;
  text: string;
}

/** What a device proposed, kept in a conflict so no text is lost. */
export interface Proposal {
  base_revision: number;
  text: string;
}

export interface CreatedResult {
  op_id: string;
  status: 'created';
  note: Note;
}

export interface UpdatedResult {
  op_id: string;
  status: 'updated';
  note: Note;
}

/** The base revision differs from the current one: the server note is attached. */
export interface RevisionMismatchResult {
  op_id: string;
  status: 'conflito';
  reason: 'revision_mismatch';
  note_id: string;
  server: Note;
  proposal: Proposal;
}

/** The base revision is above 0 but the note does not exist: no server data. */
export interface NoteNotFoundResult {
  op_id: string;
  status: 'conflito';
  reason: 'note_not_found';
  note_id: string;
  server: null;
  proposal: Proposal;
}

export type ConflictResult = RevisionMismatchResult | NoteNotFoundResult;

export interface ReusedIdResult {
  op_id: string;
  status: 'id_reutilizado';
}

/** `op_id` is present only when the input carried a string `op_id`. */
export interface InvalidResult {
  op_id?: string;
  status: 'invalid';
  reason: string;
}

export type OperationResult =
  | CreatedResult
  | UpdatedResult
  | ConflictResult
  | ReusedIdResult
  | InvalidResult;

/** Shape of docs/contract/results.json: one example of each wire shape. */
export interface ContractExamples {
  operation: Operation;
  note: Note;
  notes: Note[];
  receipt_count: { count: number };
  created: CreatedResult;
  updated: UpdatedResult;
  conflito_revision_mismatch: RevisionMismatchResult;
  conflito_note_not_found: NoteNotFoundResult;
  id_reutilizado: ReusedIdResult;
  invalid_with_op_id: InvalidResult & { op_id: string };
  invalid_without_op_id: Omit<InvalidResult, 'op_id'>;
}
