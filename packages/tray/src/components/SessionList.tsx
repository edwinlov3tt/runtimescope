import type { HealthSnapshot, SessionSummary } from '../hooks/useCollectorHealth';

interface Props {
  sessions: SessionSummary[];
  state: HealthSnapshot['state'];
}

export function SessionList({ sessions, state }: Props) {
  const connected = sessions.filter((s) => s.isConnected);
  const offline = state === 'red' || state === 'gray';

  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">Active Sessions</span>
        <span className="section-count">
          {connected.length.toString().padStart(2, '0')}
        </span>
      </div>
      <div className="session-list" role="list" aria-label="Active SDK sessions">
        {offline ? (
          <div className="empty">No collector to query</div>
        ) : connected.length === 0 ? (
          <div className="empty">No SDK sessions connected</div>
        ) : (
          connected.map((s) => (
            <div className="session-row" role="listitem" key={s.sessionId}>
              <span
                className="status-dot green pulse"
                aria-label="Live session"
              />
              <span className="session-name" title={s.appName}>
                {s.appName}
              </span>
              <span className="session-id" title={s.sessionId}>
                {s.sessionId.slice(0, 8)}…
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
