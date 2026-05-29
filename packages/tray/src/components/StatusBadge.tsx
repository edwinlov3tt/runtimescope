import type { HealthSnapshot } from '../hooks/useCollectorHealth';

interface Props {
  snapshot: HealthSnapshot;
}

export function StatusBadge({ snapshot }: Props) {
  const label =
    snapshot.state === 'green'
      ? 'Collector healthy'
      : snapshot.state === 'yellow'
        ? 'Collector degraded'
        : snapshot.state === 'red'
          ? 'Collector unreachable'
          : 'Starting up…';

  return (
    <div>
      <div className="header">
        <span className={`status-dot ${snapshot.state}`} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="status-line">
        {snapshot.statusLine}
        {snapshot.errorReason && (
          <>
            <br />
            <span style={{ opacity: 0.8 }}>{snapshot.errorReason}</span>
          </>
        )}
      </div>
    </div>
  );
}
