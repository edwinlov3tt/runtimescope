import { EmptyState } from '@/components/ui/empty-state';
import { ShieldAlert } from 'lucide-react';

// TODO(analytics-admin): de-anonymized PII table (email/IP) behind an X-Admin-Key —
// slice 6, NO backend endpoint exists yet. The dashboard must NOT show PII until
// the gated endpoint lands; render a restricted "coming soon" state only.
export function AnalyticsAdminPage() {
  return (
    <EmptyState
      icon={<ShieldAlert size={28} />}
      title="Admin de-anonymization is restricted"
      description="The PII (email / IP) view requires an X-Admin-Key and a backend endpoint that doesn't exist yet (slice 6). All other analytics views show anonymous IDs only — the client never receives PII until this lands."
    />
  );
}
