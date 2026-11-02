import type { OperationResult } from '../api-client/contract';

/** A small coloured label; the class picks the colour, the text is escaped. */
export function StatusPill({
  text,
  kind = text,
}: {
  text: string;
  kind?: string;
}) {
  return <span className={`pill s-${kind}`}>{text}</span>;
}

/** The status token as written, then a short plain-words result. */
export function ResultSummary({ result }: { result: OperationResult }) {
  switch (result.status) {
    case 'created':
      return (
        <>
          <StatusPill text="created" /> {`at r${result.note.revision}`}
        </>
      );
    case 'updated':
      return (
        <>
          <StatusPill text="updated" /> {`to r${result.note.revision}`}
        </>
      );
    case 'conflito':
      return (
        <>
          <StatusPill text="conflito" />{' '}
          {result.server === null
            ? `note not found · proposal on base r${result.proposal.base_revision}`
            : `server r${result.server.revision} · proposal on base r${result.proposal.base_revision}`}
        </>
      );
    case 'id_reutilizado':
      return (
        <>
          <StatusPill text="id_reutilizado" /> op_id used before with other
          content
        </>
      );
    case 'invalid':
      return (
        <>
          <StatusPill text="invalid" /> {result.reason}
        </>
      );
  }
}
