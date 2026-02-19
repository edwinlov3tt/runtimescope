import { Badge, Button, StatusDot, SearchInput, CodeBlock, MetricCard, Kbd, DataTable } from '@/components/ui';
import { Topbar } from '@/components/layout/topbar';
import { Activity, Zap, AlertTriangle, Globe, Clock } from 'lucide-react';

// ── Mock data for the table ──
const MOCK_REQUESTS = [
  { name: 'GetCampaigns', status: 200, method: 'GET', url: '/api/campaigns', duration: '85ms', size: '4.2KB' },
  { name: 'CreateCampaign', status: 201, method: 'POST', url: '/api/campaigns', duration: '210ms', size: '1.1KB' },
  { name: 'GetCharacter', status: 200, method: 'POST', url: '/graphql', duration: '429ms', size: '2.8KB' },
  { name: 'DeleteCampaign', status: 200, method: 'DELETE', url: '/api/campaigns/42', duration: '95ms', size: '0.1KB' },
  { name: 'NotFound', status: 404, method: 'GET', url: '/api/invalid', duration: '12ms', size: '0.2KB' },
  { name: 'ServerError', status: 500, method: 'POST', url: '/api/process', duration: '3.2s', size: '0.5KB' },
  { name: 'Analytics', status: 200, method: 'POST', url: '/mp/collect', duration: '1.2s', size: '0.3KB' },
];

const STATUS_TEXT_COLORS: Record<string, string> = {
  red: 'text-red',
  amber: 'text-amber',
  blue: 'text-blue',
  cyan: 'text-cyan',
  green: 'text-green',
};

function StatusBadge({ status }: { status: number }) {
  const color = status >= 500 ? 'red' : status >= 400 ? 'amber' : status >= 300 ? 'blue' : 'green';
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot color={color as 'red' | 'amber' | 'blue' | 'green'} size="sm" />
      <span className={STATUS_TEXT_COLORS[color]}>{status}</span>
    </span>
  );
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'green',
    POST: 'purple',
    PUT: 'amber',
    DELETE: 'red',
    PATCH: 'orange',
  };
  const color = colors[method] ?? 'default';
  return <Badge variant={color as 'green' | 'purple' | 'amber' | 'red'}>{method}</Badge>;
}

export function KitchenSink() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="Component Showcase"
        tabs={[
          { id: 'all', label: 'All Components' },
          { id: 'layout', label: 'Layout' },
          { id: 'data', label: 'Data' },
        ]}
        activeTab="all"
        connected={true}
        showSearch
      />

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-10 max-w-5xl">
          {/* ── Section: Metric Cards ── */}
          <Section title="Metric Cards">
            <div className="grid grid-cols-4 gap-4">
              <MetricCard
                label="Network Requests"
                value="1,247"
                change={{ value: 12, label: 'from last session' }}
                icon={<Globe size={16} />}
              />
              <MetricCard
                label="Avg Latency"
                value="145"
                suffix="ms"
                change={{ value: -8, label: 'faster' }}
                icon={<Clock size={16} />}
              />
              <MetricCard
                label="Renders"
                value="3,423"
                change={{ value: 565, label: 'regression' }}
                icon={<Zap size={16} />}
              />
              <MetricCard
                label="Issues"
                value="7"
                change={{ value: 0 }}
                icon={<AlertTriangle size={16} />}
              />
            </div>
          </Section>

          {/* ── Section: Badges ── */}
          <Section title="Badges">
            <div className="flex flex-wrap gap-2">
              <Badge>Default</Badge>
              <Badge variant="brand">Brand</Badge>
              <Badge variant="green">Connected</Badge>
              <Badge variant="blue">Info</Badge>
              <Badge variant="purple">GraphQL</Badge>
              <Badge variant="amber">Warning</Badge>
              <Badge variant="red">Error</Badge>
              <Badge variant="orange">Force</Badge>
              <Badge variant="cyan">200 OK</Badge>
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <Badge size="sm" variant="green">sm</Badge>
              <Badge size="md" variant="blue">md</Badge>
              <Badge size="lg" variant="purple">lg</Badge>
            </div>
          </Section>

          {/* ── Section: Status Dots ── */}
          <Section title="Status Dots">
            <div className="flex items-center gap-4">
              {(['green', 'blue', 'purple', 'amber', 'red', 'orange', 'cyan', 'gray', 'brand'] as const).map((color) => (
                <div key={color} className="flex items-center gap-2">
                  <StatusDot color={color} size="md" />
                  <span className="text-xs text-text-secondary">{color}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-3">
              <div className="flex items-center gap-2">
                <StatusDot color="green" size="lg" pulse />
                <span className="text-xs text-text-secondary">Pulse</span>
              </div>
              <div className="flex items-center gap-2">
                <StatusDot color="red" size="lg" pulse />
                <span className="text-xs text-text-secondary">Error Pulse</span>
              </div>
            </div>
          </Section>

          {/* ── Section: Buttons ── */}
          <Section title="Buttons">
            <div className="flex flex-wrap gap-3">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="success">Success</Button>
            </div>
            <div className="flex flex-wrap gap-3 mt-3">
              <Button size="sm" variant="primary">Small</Button>
              <Button size="md" variant="primary">Medium</Button>
              <Button size="lg" variant="primary">Large</Button>
              <Button size="icon" variant="secondary"><Activity size={16} /></Button>
            </div>
            <div className="flex flex-wrap gap-3 mt-3">
              <Button variant="primary" disabled>Disabled</Button>
              <Button variant="secondary" disabled>Disabled</Button>
            </div>
          </Section>

          {/* ── Section: Inputs ── */}
          <Section title="Inputs">
            <div className="grid grid-cols-2 gap-4 max-w-xl">
              <SearchInput placeholder="Search requests..." />
              <SearchInput placeholder="Filter components..." />
            </div>
          </Section>

          {/* ── Section: Keyboard Shortcuts ── */}
          <Section title="Keyboard Shortcuts">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-1.5">
                <Kbd>⌘</Kbd><Kbd>K</Kbd>
                <span className="text-xs text-text-secondary ml-1">Command Palette</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Kbd>J</Kbd>/<Kbd>K</Kbd>
                <span className="text-xs text-text-secondary ml-1">Navigate Rows</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd>
                <span className="text-xs text-text-secondary ml-1">Close Panel</span>
              </div>
            </div>
          </Section>

          {/* ── Section: Code Block ── */}
          <Section title="Code Block">
            <div className="max-w-2xl space-y-4">
              <CodeBlock language="json">{`{
  "accept": "application/json",
  "authorization": "[REDACTED]",
  "content-type": "application/json",
  "x-request-id": "abc-123-def"
}`}</CodeBlock>
              <CodeBlock language="sql">{`SELECT c.id, c.name, c.status, COUNT(a.id) as ad_count
FROM campaigns c
LEFT JOIN ads a ON a.campaign_id = c.id
WHERE c.user_id = $1
GROUP BY c.id
ORDER BY c.created_at DESC
LIMIT 50;`}</CodeBlock>
            </div>
          </Section>

          {/* ── Section: Data Table ── */}
          <Section title="Data Table">
            <div className="border border-border-default rounded-lg overflow-hidden">
              <DataTable
                columns={[
                  { key: 'name', header: 'Name', width: '160px' },
                  {
                    key: 'status',
                    header: 'Status',
                    width: '80px',
                    render: (row) => <StatusBadge status={row.status as number} />,
                  },
                  {
                    key: 'method',
                    header: 'Method',
                    width: '100px',
                    render: (row) => <MethodBadge method={row.method as string} />,
                  },
                  { key: 'url', header: 'URL' },
                  { key: 'duration', header: 'Duration', width: '100px' },
                  { key: 'size', header: 'Size', width: '80px' },
                ]}
                data={MOCK_REQUESTS}
                selectedIndex={2}
              />
            </div>
          </Section>

          {/* ── Section: Color Palette ── */}
          <Section title="Color Palette">
            <div className="space-y-6">
              <div>
                <p className="text-xs text-text-muted mb-2 uppercase tracking-wider">Backgrounds</p>
                <div className="flex gap-2">
                  {[
                    ['base', 'bg-bg-base'],
                    ['app', 'bg-bg-app'],
                    ['surface', 'bg-bg-surface'],
                    ['elevated', 'bg-bg-elevated'],
                    ['overlay', 'bg-bg-overlay'],
                    ['input', 'bg-bg-input'],
                  ].map(([name, cls]) => (
                    <div key={name} className="flex flex-col items-center gap-1.5">
                      <div className={`w-12 h-12 rounded-md border border-border-default ${cls}`} />
                      <span className="text-[10px] text-text-muted">{name}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-2 uppercase tracking-wider">Dark-to-Light System</p>
                <div className="flex gap-4">
                  {[
                    { name: 'brand', dark: 'bg-brand-dark', muted: 'bg-brand-muted', ref: 'bg-brand', border: 'border-brand-border', light: 'text-brand-light' },
                    { name: 'green', dark: 'bg-green-dark', muted: 'bg-green-muted', ref: 'bg-green', border: 'border-green-border', light: 'text-green-light' },
                    { name: 'red', dark: 'bg-red-dark', muted: 'bg-red-muted', ref: 'bg-red', border: 'border-red-border', light: 'text-red-light' },
                    { name: 'amber', dark: 'bg-amber-dark', muted: 'bg-amber-muted', ref: 'bg-amber', border: 'border-amber-border', light: 'text-amber-light' },
                    { name: 'purple', dark: 'bg-purple-dark', muted: 'bg-purple-muted', ref: 'bg-purple', border: 'border-purple-border', light: 'text-purple-light' },
                    { name: 'cyan', dark: 'bg-cyan-dark', muted: 'bg-cyan-muted', ref: 'bg-cyan', border: 'border-cyan-border', light: 'text-cyan-light' },
                  ].map((c) => (
                    <div key={c.name} className="flex flex-col items-center gap-1.5">
                      <div className="flex gap-1">
                        <div className={`w-8 h-8 rounded-md border ${c.border} ${c.dark}`} title="dark" />
                        <div className={`w-8 h-8 rounded-md border ${c.border} ${c.muted}`} title="muted" />
                        <div className={`w-8 h-8 rounded-md ${c.ref}`} title="ref" />
                      </div>
                      <span className="text-[10px] text-text-muted">{c.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-2 uppercase tracking-wider">Text</p>
                <div className="flex gap-6">
                  <span className="text-sm text-text-primary">Primary</span>
                  <span className="text-sm text-text-secondary">Secondary</span>
                  <span className="text-sm text-text-tertiary">Tertiary</span>
                  <span className="text-sm text-text-muted">Muted</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-2 uppercase tracking-wider">Borders</p>
                <div className="flex gap-2">
                  {[
                    ['muted', 'border-border-muted'],
                    ['default', 'border-border-default'],
                    ['strong', 'border-border-strong'],
                    ['hover', 'border-border-hover'],
                  ].map(([name, cls]) => (
                    <div key={name} className="flex flex-col items-center gap-1.5">
                      <div className={`w-16 h-8 rounded-md border-2 bg-bg-surface ${cls}`} />
                      <span className="text-[10px] text-text-muted">{name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          {/* ── Section: Typography ── */}
          <Section title="Typography">
            <div className="space-y-3">
              <p className="text-2xl font-bold tracking-tight">Heading XL — 24px Bold</p>
              <p className="text-lg font-semibold">Heading LG — 18px Semibold</p>
              <p className="text-[15px] font-medium">Heading MD — 15px Medium</p>
              <p className="text-sm text-text-primary">Body SM — 13px Regular</p>
              <p className="text-xs text-text-secondary">Caption XS — 11px Regular</p>
              <p className="font-mono text-[13px] text-text-secondary">Mono Base — JetBrains Mono 13px</p>
              <p className="font-mono text-xs text-text-tertiary">Mono SM — JetBrains Mono 12px</p>
            </div>
          </Section>

          {/* Bottom spacer */}
          <div className="h-10" />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <div className="flex-1 h-px bg-border-muted" />
      </div>
      {children}
    </section>
  );
}
