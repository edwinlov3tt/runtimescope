import { EmptyState } from '@/components/ui/empty-state';
import { HeartPulse } from 'lucide-react';

// TODO(analytics-status): uptime monitoring (monitored apps, heartbeat + 60s active
// probe, uptime strip, incidents) — slice 5, NO collector endpoints exist yet.
// Render an honest "coming soon" state; no mock data, no dead controls.
export function AnalyticsStatusPage() {
  return (
    <EmptyState
      icon={<HeartPulse size={28} />}
      title="Uptime monitoring is coming"
      description="Per-app uptime (SDK hourly heartbeat + a 60s active probe), the 60-day status strip, and incident tracking land in slice 5. No backend endpoints exist yet."
    />
  );
}
