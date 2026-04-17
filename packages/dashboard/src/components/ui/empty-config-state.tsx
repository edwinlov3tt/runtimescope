import { Settings } from 'lucide-react';

interface ConfigHint {
  key: string;
  value: string;
  description: string;
}

interface EmptyConfigStateProps {
  title: string;
  description: string;
  configHints: ConfigHint[];
  learnMoreUrl?: string;
}

export function EmptyConfigState({ title, description, configHints }: EmptyConfigStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-4">
        <div className="w-10 h-10 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center mx-auto">
          <Settings size={18} className="text-text-muted" />
        </div>
        <div>
          <h3 className="text-[15px] font-semibold text-text-primary mb-1">{title}</h3>
          <p className="text-[13px] text-text-muted leading-relaxed">{description}</p>
        </div>
        <div className="bg-bg-elevated border border-border-default rounded-lg p-4 text-left overflow-hidden">
          <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-3">
            Add to your SDK config
          </p>
          <pre className="font-mono text-[12px] leading-relaxed overflow-x-auto">
            <code>
              <span className="text-text-muted">{'RuntimeScope.init({\n'}</span>
              {configHints.map((hint) => (
                <span key={hint.key}>
                  <span className="text-text-tertiary">{`  // ${hint.description}\n`}</span>
                  <span className="text-text-muted">{'  '}</span>
                  <span className="text-accent">{hint.key}</span>
                  {hint.value && (
                    <>
                      <span className="text-text-muted">{': '}</span>
                      <span className="text-green">{hint.value}</span>
                    </>
                  )}
                  <span className="text-text-muted">{','}</span>
                  {'\n'}
                </span>
              ))}
              <span className="text-text-muted">{'});'}</span>
            </code>
          </pre>
        </div>
        <p className="text-[11px] text-text-tertiary">
          Reload your app after updating the config, then interact with it to generate data.
        </p>
      </div>
    </div>
  );
}
