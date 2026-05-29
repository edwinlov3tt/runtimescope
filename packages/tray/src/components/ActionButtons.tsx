import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  showUpdate: boolean;
  onAfterAction: () => void;
}

type Pending = 'restart' | 'update' | 'stop' | null;

// Inline SVG icons — single stroke weight, consistent visual language with
// the rest of the design system. No emoji per design-system rule
// `no-emoji-icons`.
const Icon = {
  dashboard: (
    <svg className="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 8.5L8 3l6 5.5M3.5 7.7V13a.5.5 0 0 0 .5.5h3v-3.5a1 1 0 0 1 1-1h0a1 1 0 0 1 1 1v3.5h3a.5.5 0 0 0 .5-.5V7.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  logs: (
    <svg className="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6h6M5 8.5h6M5 11h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  restart: (
    <svg className="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  stop: (
    <svg className="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="6" width="4" height="4" rx="0.5" fill="currentColor" />
    </svg>
  ),
  update: (
    <svg className="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v6m0 0l-2.5-2.5M8 8l2.5-2.5M3 11.5V13a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-1.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

export function ActionButtons({ showUpdate, onAfterAction }: Props) {
  const [pending, setPending] = useState<Pending>(null);

  const run = async (cmd: 'restart' | 'update' | 'stop', label: Pending) => {
    setPending(label);
    try {
      await invoke('service_action', { action: cmd });
    } catch (e) {
      console.error('service_action failed', e);
    } finally {
      setPending(null);
      onAfterAction();
    }
  };

  const openDashboard = () => invoke('open_dashboard').catch(console.error);
  const openLogs = () => invoke('open_logs').catch(console.error);
  const quitTray = () => invoke('quit_tray').catch(console.error);

  return (
    <div className="actions">
      {showUpdate && (
        // TODO(v0.12.0): the CLI's `service update` implementation flips from
        // npm-install-g to curl-install; this button's contract is unchanged.
        <div className="action-row single">
          <button
            className="btn btn-primary"
            onClick={() => run('update', 'update')}
            disabled={pending !== null}
          >
            {Icon.update}
            {pending === 'update' ? 'Updating…' : 'Update Now'}
          </button>
        </div>
      )}
      <div className="action-row">
        <button className="btn" onClick={openDashboard}>
          {Icon.dashboard}
          Dashboard
        </button>
        <button className="btn" onClick={openLogs}>
          {Icon.logs}
          Logs
        </button>
      </div>
      <div className="action-row">
        <button
          className="btn"
          onClick={() => run('restart', 'restart')}
          disabled={pending !== null}
        >
          {Icon.restart}
          {pending === 'restart' ? 'Restarting…' : 'Restart'}
        </button>
        <button
          className="btn btn-danger"
          onClick={() => run('stop', 'stop')}
          disabled={pending !== null}
        >
          {Icon.stop}
          {pending === 'stop' ? 'Stopping…' : 'Quit Service'}
        </button>
      </div>
      <div className="actions-divider" />
      <div className="action-row single">
        <button className="btn btn-ghost" onClick={quitTray}>
          Quit RuntimeScope (Tray)
        </button>
      </div>
    </div>
  );
}
