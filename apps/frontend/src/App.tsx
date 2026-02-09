import { Layout } from './components/Layout';
import { Screener } from './components/Screener';
import { ActivePositions } from './components/ActivePositions';

function App() {
  return (
    <Layout>
      <ActivePositions />
      <Screener />
    </Layout>
  );
}

export default App;
