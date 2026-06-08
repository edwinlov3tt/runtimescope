import { useState } from 'react';
import { DataTable, EmptyState, Badge, DetailPanel, KpiRow, type KpiSpec } from '@/components/ui';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ExportButton } from '@/components/ui/export-button';
import { Users, DollarSign, Clock, ShieldCheck, Activity } from 'lucide-react';
import { fetchAnalyticsUsers } from '@/lib/analytics-api';
import type { AnalyticsUser } from '@/lib/analytics-types';
import { AnalyticsLayout, AnalyticsToolbar, useAnalytics, fmtMoney, fmtHours, relTime } from './_shared';

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-tertiary">{k}</span>
      <span className="font-mono text-text-secondary">{v}</span>
    </div>
  );
}

export function AnalyticsUsersPage() {
  const { data, loading } = useAnalytics(() => fetchAnalyticsUsers(), []);
  const [selected, setSelected] = useState<AnalyticsUser | null>(null);
  const users = data ?? [];

  const total = users.length;
  const consented = users.filter((u) => u.consent).length;
  const totalHours = users.reduce((a, u) => a + u.hours, 0);
  const totalValue = users.reduce((a, u) => a + u.value, 0);
  const avgValue = total ? Math.round(totalValue / total) : 0;
  const activeToday = users.filter((u) => Date.now() - u.lastSeen <= 86_400_000).length;
  const consentPct = total ? Math.round((consented / total) * 100) : 0;

  const pool: Record<string, KpiSpec> = {
    total: { icon: Users, label: 'Total Users', value: String(total), footerLabel: 'Identified' },
    // TODO(analytics-3a): hours/value are ROI ($) — 0 until baselines+roles set.
    hours: { icon: Clock, label: 'Hours Saved', value: fmtHours(totalHours), unit: 'hrs', footerLabel: 'Across users' },
    avgValue: { icon: DollarSign, label: 'Avg Value / User', value: fmtMoney(avgValue), footerLabel: 'ROI per user' },
    valueSaved: { icon: DollarSign, label: 'Value Saved', value: fmtMoney(totalValue), footerLabel: 'All users' },
    consent: { icon: ShieldCheck, label: 'Consent Rate', value: String(consentPct), unit: '%', footerLabel: `${consented} of ${total}` },
    activeToday: { icon: Activity, label: 'Active Today', value: String(activeToday), footerLabel: 'DAU' },
  };

  if (loading) {
    return (
      <AnalyticsLayout>
        <TableSkeleton rows={10} />
      </AnalyticsLayout>
    );
  }

  const columns = [
    { key: 'anonId', header: 'User', mono: true, render: (u: AnalyticsUser) => `USER_${u.anonId}` },
    { key: 'role', header: 'Role', render: (u: AnalyticsUser) => <Badge variant="purple">{u.role}</Badge> },
    { key: 'sessions', header: 'Sessions', align: 'right' as const, mono: true, sortable: true },
    { key: 'events', header: 'Events', align: 'right' as const, mono: true, sortable: true, render: (u: AnalyticsUser) => u.events.toLocaleString() },
    // TODO(analytics-3a): value/hours = ROI ($).
    { key: 'value', header: 'Value', align: 'right' as const, mono: true, render: (u: AnalyticsUser) => fmtMoney(u.value) },
    { key: 'hours', header: 'Hours', align: 'right' as const, mono: true, render: (u: AnalyticsUser) => `${fmtHours(u.hours)}h` },
    { key: 'lastSeen', header: 'Last Seen', render: (u: AnalyticsUser) => relTime(u.lastSeen) },
    { key: 'consent', header: 'Consent', render: (u: AnalyticsUser) => (u.consent ? <Badge variant="green">Given</Badge> : <Badge variant="amber">Pending</Badge>) },
  ];

  return (
    <AnalyticsLayout
      toolbar={<AnalyticsToolbar left={<span className="text-[13px] font-semibold">Users · anonymized</span>} right={<ExportButton data={users as unknown as Record<string, unknown>[]} filename="analytics-users.csv" />} />}
    >
      <KpiRow pool={pool} active={['total', 'hours', 'avgValue', 'consent']} />
      <div className="rounded-lg border border-border-strong bg-bg-surface overflow-hidden">
        {users.length === 0 ? (
          <EmptyState title="No identified users yet" description="Once your app calls RuntimeScope.identify({ email, role }), users appear here — anonymized, no PII." />
        ) : (
          <DataTable columns={columns as any} data={users as any} onRowClick={(u) => setSelected(u as unknown as AnalyticsUser)} defaultSort={{ key: 'events', direction: 'desc' }} />
        )}
      </div>

      <DetailPanel open={!!selected} onClose={() => setSelected(null)} title={selected ? `USER_${selected.anonId}` : ''} subtitle={selected?.role}>
        {selected && (
          <div className="space-y-3 text-sm">
            <Row k="Role" v={selected.role} />
            <Row k="Consent" v={selected.consent ? 'Given' : 'Pending'} />
            <Row k="Sessions" v={String(selected.sessions)} />
            <Row k="Events" v={selected.events.toLocaleString()} />
            <Row k="Features used" v={String(selected.features)} />
            {/* TODO(analytics-3a): value/hours = ROI ($). */}
            <Row k="Value attributed" v={fmtMoney(selected.value)} />
            <Row k="Hours saved" v={`${fmtHours(selected.hours)}h`} />
            <Row k="First seen" v={relTime(selected.firstSeen)} />
            <Row k="Last seen" v={relTime(selected.lastSeen)} />
            {/* TODO(analytics-feature-topusers): per-user top features + recent events aren't in /users{,/{id}} yet. */}
            {/* TODO(analytics-survey): per-user "Survey" button (targeted show_survey) — slice 4 not built. */}
          </div>
        )}
      </DetailPanel>
    </AnalyticsLayout>
  );
}
