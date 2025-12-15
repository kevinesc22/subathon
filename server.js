import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TikTokLiveConnection from 'tiktok-live-connector';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Cargar reglas
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf-8'));

// ---- Estado del subathon
let remaining = rules.baseSeconds;
let lastTick = Date.now();

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Subathon Hub running');
});

const wss = new WebSocketServer({ server });
const broadcast = (type, payload) => {
  const msg = JSON.stringify({ type, payload });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
};

function tickLoop() {
  const now = Date.now();
  const delta = Math.floor((now - lastTick) / 1000);
  if (delta > 0) {
    remaining = Math.max(0, remaining - delta * rules.decaySecondsPerSecond);
    lastTick = now;
    broadcast('timer', { remaining });
  }
  setTimeout(tickLoop, 200);
}
tickLoop();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', payload: { remaining, rules }}));
  ws.on('message', (raw) => {
    try {
      const { type, payload } = JSON.parse(raw.toString());
      if (type === 'manual:add') {
        remaining = Math.min(rules.maxSeconds, remaining + (payload?.seconds ?? rules.manualStep));
      } else if (type === 'manual:sub') {
        remaining = Math.max(0, remaining - (payload?.seconds ?? rules.manualStep));
      }
      broadcast('timer', { remaining });
    } catch {}
  });
});

// TIKTOK
if (process.env.TIKTOK_USERNAME) {
  const tiktok = new TikTokLiveConnection(process.env.TIKTOK_USERNAME, { enableWebsocketUpgrade: true });
  tiktok.connect().catch(() => {});
  tiktok.on('gift', (data) => {
    const add = Math.round((data.diamondCount || 0) * rules.tiktok.coinToSeconds);
    if (add > 0) { remaining = Math.min(rules.maxSeconds, remaining + add); broadcast('event', { platform: 'tiktok', type:'gift', add }); }
  });
  tiktok.on('subscribe', () => {
    remaining = Math.min(rules.maxSeconds, remaining + rules.tiktok.subSeconds);
    broadcast('event', { platform: 'tiktok', type:'sub', add: rules.tiktok.subSeconds });
  });
}

// KICK (simplificado a eventos de chat)
function connectKick() {
  if (!process.env.KICK_CHANNEL) return;
  const ws = new WebSocket(`wss://chat.kick.com/ws`);
  ws.on('open', () => {
    ws.send(JSON.stringify({ event: "phx_join", topic: `channel:${process.env.KICK_CHANNEL}`, payload: {}, ref: 1 }));
  });
  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg?.event === 'subscription') {
        remaining = Math.min(rules.maxSeconds, remaining + rules.kick.subscriptionSeconds);
        broadcast('event', { platform: 'kick', type:'sub', add: rules.kick.subscriptionSeconds });
      }
      if (msg?.event === 'gifted_subs') {
        const qty = Number(msg?.payload?.count || 1);
        const add = qty * rules.kick.giftedSubSeconds;
        remaining = Math.min(rules.maxSeconds, remaining + add);
        broadcast('event', { platform: 'kick', type:'gifted_subs', add });
      }
      if (msg?.event === 'paid_message' || msg?.event === 'sticker') {
        const coins = Number(msg?.payload?.amount || 0);
        const add = Math.round(coins * rules.kick.kickCoinToSeconds);
        if (add > 0) {
          remaining = Math.min(rules.maxSeconds, remaining + add);
          broadcast('event', { platform:'kick', type:'coins', add });
        }
      }
    } catch {}
  });
  ws.on('close', () => setTimeout(connectKick, 2000));
  ws.on('error', () => ws.close());
}
connectKick();

server.listen(port, '0.0.0.0', () => {
  console.log('HTTP+WS on :' + port);
});