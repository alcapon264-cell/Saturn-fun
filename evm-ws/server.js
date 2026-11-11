import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from './src/app.js';

const app = createApp({ WebSocketImpl: WebSocket, WebSocketServer });
app.start().catch(e => { console.error('[saturn-evm-ws] startup_failed:', e.message); process.exit(1); });
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; app.shutdown().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
