import type { HealthSnapshot } from '../hooks/useCollectorHealth';

interface Props {
  snapshot: HealthSnapshot;
}

function formatUptime(seconds: number | null): string {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function StatsRow({ snapshot }: Props) {
  const connectedSessions = snapshot.sessions.filter((s) => s.isConnected).length;
  const uptime = formatUptime(snapshot.uptimeSeconds);
  const version = snapshot.runningVersion ?? '—';
  const offline = snapshot.state === 'red' || snapshot.state === 'gray';

  return (
    <div className="stats" role="group" aria-label="Collector metrics">
      <div className="stat">
        <div className="stat-label">Sessions</div>
        <div className={`stat-value${offline ? ' muted' : ''}`}>
          {offline ? '—' : connectedSessions}
        </div>
        <div className="stat-foot">connected</div>
      </div>
      <div className="stat">
        <div className="stat-label">Uptime</div>
        <div className={`stat-value${offline ? ' muted' : ''}`}>{uptime}</div>
        <div className="stat-foot">port {snapshot.port}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Version</div>
        <div className={`stat-value${offline ? ' muted' : ''}`}>{version}</div>
        <div className="stat-foot">
          {snapshot.latestVersion && snapshot.latestVersion !== version
            ? `latest ${snapshot.latestVersion}`
            : 'up to date'}
        </div>
      </div>
    </div>
  );
}
