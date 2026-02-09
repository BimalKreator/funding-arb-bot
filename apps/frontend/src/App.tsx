import { Layout } from './components/Layout';
import { Login } from './components/Login';
import { DashboardStats } from './components/DashboardStats';
import { ActivePositions } from './components/ActivePositions';
import { Screener } from './components/Screener';
import { SettingsPanel } from './components/SettingsPanel';
import { TransactionManager } from './components/TransactionManager';

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
      <SettingsPanel />
      <TransactionManager />
    </Layout>
  );
}

export default App;
