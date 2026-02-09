import { Layout } from './components/Layout';
import { DashboardStats } from './components/DashboardStats';
import { ActivePositions } from './components/ActivePositions';
import { Screener } from './components/Screener';
import { SettingsPanel } from './components/SettingsPanel';
import { TransactionManager } from './components/TransactionManager';

function App() {
  return (
    <Layout>
      <DashboardStats />
      <ActivePositions />
      <Screener />
      <SettingsPanel />
      <TransactionManager />
    </Layout>
  );
}

export default App;
