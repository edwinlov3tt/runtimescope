import { useState, useEffect } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { Badge, EmptyState } from '@/components/ui';
import { useConnected } from '@/hooks/use-connected';
import { cn } from '@/lib/cn';

interface PlatformStatus {
  name: string;
  id: string;
  configured: boolean;
  envVar: string;
  docsUrl: string;
  description: string;
}

const PLATFORMS: PlatformStatus[] = [
  {
    name: 'Vercel',
    id: 'vercel',
    configured: false,
    envVar: 'VERCEL_TOKEN + VERCEL_PROJECT_ID',
    docsUrl: 'https://vercel.com/docs/rest-api',
    description: 'Deploy logs, build status, and runtime errors from Vercel.',
  },
  {
    name: 'Cloudflare',
    id: 'cloudflare',
    configured: false,
    envVar: 'CF_API_TOKEN + CF_ACCOUNT_ID',
    docsUrl: 'https://developers.cloudflare.com/api/',
    description: 'Worker deployments, analytics, and error logs.',
  },
  {
    name: 'Railway',
    id: 'railway',
    configured: false,
    envVar: 'RAILWAY_TOKEN + RAILWAY_PROJECT_ID',
    docsUrl: 'https://docs.railway.app/reference/public-api',
    description: 'Service deployments, build logs, and runtime metrics.',
  },
];

export function InfraPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const connected = useConnected();
  const [platforms, setPlatforms] = useState(PLATFORMS);

  // Check if any platform env vars are set (via health-style endpoint)
  useEffect(() => {
    // For now, platforms are all unconfigured in standalone mode.
    // The MCP server has InfraConnector but standalone doesn't expose it yet.
    setPlatforms(PLATFORMS);
  }, []);

  const configuredCount = platforms.filter((p) => p.configured).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'setup', label: 'Setup' },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="flex-1 overflow-auto">
        {activeTab === 'overview' && (
          <div className="p-5 space-y-4 max-w-3xl mx-auto w-full">
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-sm font-medium text-text-primary">Platform Connections</h2>
              <Badge size="sm" variant={configuredCount > 0 ? 'green' : 'default'}>
                {configuredCount}/{platforms.length} connected
              </Badge>
            </div>

            <div className="grid gap-3">
              {platforms.map((platform) => (
                <PlatformCard key={platform.id} platform={platform} />
              ))}
            </div>

            {configuredCount === 0 && (
              <div className="mt-6 p-4 rounded-lg border border-border-muted bg-bg-surface">
                <p className="text-sm text-text-muted">
                  No platforms connected yet. Switch to the{' '}
                  <button
                    className="text-accent hover:underline"
                    onClick={() => setActiveTab('setup')}
                  >
                    Setup
                  </button>{' '}
                  tab to configure your deployment platforms.
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'setup' && (
          <div className="p-5 space-y-6 max-w-3xl mx-auto w-full">
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-text-primary">Infrastructure Setup</h2>
              <p className="text-sm text-text-muted">
                Connect your deployment platforms to see deploy logs, build status, and runtime errors directly in RuntimeScope.
              </p>
            </div>

            <div className="p-4 rounded-lg border border-border-strong bg-bg-surface space-y-3">
              <h3 className="text-sm font-medium text-text-primary">How it works</h3>
              <ol className="text-sm text-text-secondary space-y-2 list-decimal list-inside">
                <li>Set the required environment variables for your platform</li>
                <li>Configure the platform in your RuntimeScope config file</li>
                <li>Restart the collector — deploy data will appear automatically</li>
              </ol>
            </div>

            <div className="p-4 rounded-lg border border-border-strong bg-bg-surface space-y-3">
              <h3 className="text-sm font-medium text-text-primary">Configuration</h3>
              <p className="text-sm text-text-muted">
                Add platforms to <code className="px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary font-mono text-xs">~/.runtimescope/config.json</code>:
              </p>
              <pre className="text-xs font-mono bg-bg-elevated p-3 rounded-lg overflow-x-auto text-text-secondary">
{`{
  "infra": {
    "vercel": {
      "projectId": "prj_...",
      "token": "your-vercel-token"
    },
    "cloudflare": {
      "accountId": "abc123",
      "workerName": "my-worker",
      "token": "your-cf-token"
    }
  }
}`}
              </pre>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary">Supported Platforms</h3>
              {platforms.map((platform) => (
                <div key={platform.id} className="p-4 rounded-lg border border-border-strong space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">{platform.name}</span>
                    <Badge size="sm" variant={platform.configured ? 'green' : 'default'}>
                      {platform.configured ? 'Connected' : 'Not configured'}
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted">{platform.description}</p>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-text-muted">Required:</span>
                    <code className="px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary font-mono">{platform.envVar}</code>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 rounded-lg border border-amber/20 bg-amber/5 space-y-2">
              <h3 className="text-sm font-medium text-amber">MCP Server Only</h3>
              <p className="text-xs text-text-muted">
                Infrastructure monitoring currently requires the MCP server (not the standalone collector).
                Claude Code can access deploy logs, build status, and runtime errors through MCP tools
                even when this dashboard tab shows no data.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PlatformCard({ platform }: { platform: PlatformStatus }) {
  return (
    <div className={cn(
      'flex items-center gap-4 p-4 rounded-lg border',
      platform.configured ? 'border-green/20 bg-green/5' : 'border-border-muted bg-bg-surface',
    )}>
      <div className={cn(
        'w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold',
        platform.configured ? 'bg-green/10 text-green' : 'bg-bg-elevated text-text-muted',
      )}>
        {platform.name[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{platform.name}</span>
          <Badge size="sm" variant={platform.configured ? 'green' : 'default'}>
            {platform.configured ? 'Connected' : 'Not configured'}
          </Badge>
        </div>
        <p className="text-xs text-text-muted mt-0.5">{platform.description}</p>
      </div>
    </div>
  );
}
