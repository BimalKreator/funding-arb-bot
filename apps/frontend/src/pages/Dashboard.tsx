import { Screener } from '../components/Screener';
import { ActivePositions } from '../components/ActivePositions';
import { BannedTokens } from '../components/BannedTokens';

export interface DashboardConfig {
  autoEntryEnabled?: boolean;
  autoExitEnabled?: boolean;
  manualEntryEnabled?: boolean;
  capitalPercent?: number;
  autoLeverage?: number;
  screenerMinSpread?: number;
}

interface DashboardProps {
  config: DashboardConfig | null;
  onLogout: () => void;
  loadingConfig?: boolean;
}

/**
 * Dashboard always shows Screener and ActivePositions. They are not conditionally
 * hidden when config is null; components use config?. for optional values (e.g. threshold).
 */
export function Dashboard({ config, onLogout, loadingConfig }: DashboardProps) {
  const threshold = config?.screenerMinSpread ?? 0;

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1>Dashboard</h1>
        <button type="button" onClick={onLogout}>Log out</button>
      </div>

      <section style={{ marginBottom: 16 }}>
        {loadingConfig && config === null ? (
          <p style={{ color: '#888' }}>Loading config…</p>
        ) : (
          <>
            <p><strong>Auto-entry:</strong> {config?.autoEntryEnabled === true ? 'On' : 'Off'}</p>
            <p><strong>Auto-exit:</strong> {config?.autoExitEnabled === true ? 'On' : 'Off'}</p>
            <p><strong>Manual entry:</strong> {config?.manualEntryEnabled === true ? 'On' : 'Off'}</p>
            {config?.screenerMinSpread != null && (
              <p><strong>Min spread %:</strong> {config.screenerMinSpread}</p>
            )}
          </>
        )}
      </section>

      <Screener threshold={threshold} />
      <BannedTokens />
      <ActivePositions />
    </div>
  );
}
