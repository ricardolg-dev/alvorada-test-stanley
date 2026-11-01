import { z } from 'zod';

/** A note as it travels on the wire: `{note_id, revision, text}`. */
export interface Note {
  note_id: string;
  revision: number;
  text: string;
}

/**
 * The strict operation object. A missing or an extra field makes the
 * operation invalid, `op_id` and `note_id` are non-empty, `base_revision` is
 * an integer of 0 or more and `text` may be empty.
 */
export const operationSchema = z.strictObject({
  op_id: z.string().min(1),
  note_id: z.string().min(1),
  base_revision: z.number().int().min(0),
  text: z.string(),
});

export type Operation = z.infer<typeof operationSchema>;

export interface Proposal {
  base_revision: number;
  text: string;
}

export type ConflictReason = 'revision_mismatch' | 'note_not_found';

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

export interface ConflictResult {
  op_id: string;
  status: 'conflito';
  reason: ConflictReason;
  note_id: string;
  server: Note | null;
  proposal: Proposal;
}

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

/** Results that a valid, first-time operation can produce, and so be stored. */
export type StoredResult = CreatedResult | UpdatedResult | ConflictResult;

export type OperationResult = StoredResult | ReusedIdResult | InvalidResult;

/** What the server remembers about an `op_id`: its content and its result. */
export interface Receipt {
  content: Pick<Operation, 'note_id' | 'base_revision' | 'text'>;
  result: StoredResult;
}
