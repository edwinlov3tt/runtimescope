import { useCollectorHealth } from './hooks/useCollectorHealth';
import { Header } from './components/Header';
import { StatsRow } from './components/StatsRow';
import { SessionList } from './components/SessionList';
import { UpdateBanner } from './components/UpdateBanner';
import { ActionButtons } from './components/ActionButtons';

export function App() {
  const { snapshot, refresh } = useCollectorHealth();

  return (
    <div className="dropdown" role="dialog" aria-label="RuntimeScope status">
      <Header snapshot={snapshot} />
      <StatsRow snapshot={snapshot} />
      <SessionList sessions={snapshot.sessions} state={snapshot.state} />
      {snapshot.updateAvailable && (
        <UpdateBanner
          current={snapshot.runningVersion}
          latest={snapshot.latestVersion}
        />
      )}
      <ActionButtons
        showUpdate={snapshot.updateAvailable}
        onAfterAction={refresh}
      />
    </div>
  );
}
