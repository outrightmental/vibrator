import './styles/global.css';
import './components/vibrator-app.js';
import { DashboardStore } from './store/dashboard-store.js';

const store = new DashboardStore();
await store.bootstrap();
store.connectLive();

const app = document.createElement('vibrator-app') as HTMLElement & { store: DashboardStore };
(app as unknown as Record<string, unknown>)['store'] = store;
document.body.appendChild(app);
