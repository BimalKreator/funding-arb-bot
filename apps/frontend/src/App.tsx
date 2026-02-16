import { Layout } from './components/Layout';
import { Login } from './components/Login';
import { DashboardStats } from './components/DashboardStats';
import { ActivePositions } from './components/ActivePositions';
import { Screener } from './components/Screener';
import { BannedTokens } from './components/BannedTokens';
import { SettingsPanel } from './components/SettingsPanel';
import { TransactionManager } from './components/TransactionManager';
import { ClosedTrades } from './components/ClosedTrades';

const TOKEN_KEY = 'token';

function App() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    return <Login />;
  }
  return (
    <Layout>
      <DashboardStats />
      <ActivePositions />
      <Screener />
      <BannedTokens />
      <SettingsPanel />
      <TransactionManager />
      <ClosedTrades />
    </Layout>
  );
}

export default App;
