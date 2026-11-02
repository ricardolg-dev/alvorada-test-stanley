export interface WireProps {
  online: boolean;
  /** The office wire runs from the bottom of the stage upwards. */
  fromBottom?: boolean;
}

/** The line between a device and the server; dashed and labelled when offline. */
export function Wire({ online, fromBottom = false }: WireProps) {
  const classes = [
    'wire',
    fromBottom ? 'from-bottom wire-b' : 'wire-a',
    online ? '' : 'off',
  ]
    .filter((name) => name !== '')
    .join(' ');
  return (
    <div className={classes} aria-hidden="true">
      <span className="wire-line" />
      <span className="wire-label">{online ? 'Online' : 'Offline'}</span>
    </div>
  );
}
