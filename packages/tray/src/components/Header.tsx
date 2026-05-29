import type { HealthSnapshot } from '../hooks/useCollectorHealth';

interface Props {
  snapshot: HealthSnapshot;
}

const STATUS_LABEL: Record<HealthSnapshot['state'], string> = {
  green: 'Healthy',
  yellow: 'Degraded',
  red: 'Offline',
  gray: 'Starting',
};

export function Header({ snapshot }: Props) {
  // Map yellow → amber so we hit the right token class. (`HealthState` keeps
  // `yellow` for backward-compat with the IPC payload, but the design token
  // is `amber`.)
  const color = snapshot.state === 'yellow' ? 'amber' : snapshot.state;
  const label = STATUS_LABEL[snapshot.state] ?? STATUS_LABEL.gray;
  // Pulse the dot only when there's something live to convey — a steady
  // green or amber. Red/gray hold still so they read as a stalled state.
  const pulse = color === 'green' || color === 'amber';

  return (
    <>
      <div className="header">
        <div className="brand">
          <div className="brand-logo" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
              <path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">RuntimeScope</div>
            <div className="brand-sub">Collector</div>
          </div>
        </div>
        <span className={`status-pill ${color}`} role="status" aria-live="polite">
          <span className={`status-dot ${color}${pulse ? ' pulse' : ''}`} aria-hidden="true" />
          {label}
        </span>
      </div>
      {snapshot.errorReason && (
        <div className="error-line" role="alert">
          {snapshot.errorReason}
        </div>
      )}
    </>
  );
}
