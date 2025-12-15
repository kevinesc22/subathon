import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import TikTokLiveConnection from 'tiktok-live-connector';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load rules
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf-8'));

// State
let remaining = rules.baseSeconds;
let lastTick = Date.now();

// Runtime connectors
let tiktok = null;
let tiktokUser = process.env.TIKTOK_USERNAME || '';
let kickWS = null;
let kickChannel = process.env.KICK_CHANNEL || '';

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return void res.end('ok'); }
  if (req.url.startsWith('/status')) {
    res.writeHead(200, {'content-type':'application/json'});
    return void res.end(JSON.stringify({ tiktokUser, kickChannel, remaining }));
  }
  res.writeHead(200, {'content-type':'text/plain'});
  res.end('Subathon Hub running');
});

const wss = new WebSocketServer({ server });
const broadcast = (type, payload) => {
  const msg = JSON.stringify({ type, payload });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
};

function tickLoop(){
  const now = Date.now();
  const delta = Math.floor((now - lastTick)/1000);
  if (delta>0){
    remaining = Math.max(0, remaining - delta * rules.decaySecondsPerSecond);
    lastTick = now;
    broadcast('timer', { remaining });
  }
  setTimeout(tickLoop, 200);
}
tickLoop();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', payload: { remaining, rules, tiktokUser, kickChannel }}));
  ws.on('message', (raw) => {
    try {
      const { type, payload } = JSON.parse(raw.toString());
      if (type === 'manual:add') {
        remaining = Math.min(rules.maxSeconds, remaining + (payload?.seconds ?? rules.manualStep));
        broadcast('timer', { remaining });
      } else if (type === 'manual:sub') {
        remaining = Math.max(0, remaining - (payload?.seconds ?? rules.manualStep));
        broadcast('timer', { remaining });
      } else if (type === 'config:update') {
        if (typeof payload?.tiktokUser === 'string') { setTikTok(payload.tiktokUser.trim()); }
        if (typeof payload?.kickChannel === 'string') { setKick(payload.kickChannel.trim()); }
        ws.send(JSON.stringify({ type:'config:applied', payload: { tiktokUser, kickChannel }}));
      }
    } catch {}
  });
});

// ---- TikTok ----
function setTikTok(username){
  if (tiktok) { try { tiktok.disconnect(); } catch{} tiktok = null; }
  tiktokUser = username || '';
  if (!tiktokUser) return;
  tiktok = new TikTokLiveConnection(tiktokUser, { enableWebsocketUpgrade:true });
  tiktok.connect().catch(()=>{});
  tiktok.on('gift', (data)=>{
    const add = Math.round((data.diamondCount || 0) * rules.tiktok.coinToSeconds);
    if (add>0){ remaining = Math.min(rules.maxSeconds, remaining + add); broadcast('event', { platform:'tiktok', type:'gift', add }); }
  });
  tiktok.on('subscribe', ()=>{
    remaining = Math.min(rules.maxSeconds, remaining + rules.tiktok.subSeconds);
    broadcast('event', { platform:'tiktok', type:'sub', add: rules.tiktok.subSeconds });
  });
}

// ---- Kick ----
function setKick(channel){
  if (kickWS) { try { kickWS.close(); } catch{} kickWS = null; }
  kickChannel = channel || '';
  if (!kickChannel) return;
  const url = `wss://chat.kick.com/ws`;
  const ws = new WebSocket(url);
  kickWS = ws;
  ws.on('open', ()=>{
    ws.send(JSON.stringify({ event:'phx_join', topic:`channel:${kickChannel}`, payload:{}, ref:1 }));
  });
  ws.on('message', (buf)=>{
    try{
      const msg = JSON.parse(buf.toString());
      if (msg?.event === 'subscription'){
        remaining = Math.min(rules.maxSeconds, remaining + rules.kick.subscriptionSeconds);
        broadcast('event', { platform:'kick', type:'sub', add: rules.kick.subscriptionSeconds });
      }
      if (msg?.event === 'gifted_subs'){
        const qty = Number(msg?.payload?.count || 1);
        const add = qty * rules.kick.giftedSubSeconds;
        remaining = Math.min(rules.maxSeconds, remaining + add);
        broadcast('event', { platform:'kick', type:'gifted_subs', add });
      }
      if (msg?.event === 'paid_message' || msg?.event === 'sticker'){
        const coins = Number(msg?.payload?.amount || 0);
        const add = Math.round(coins * rules.kick.kickCoinToSeconds);
        if (add>0){ remaining = Math.min(rules.maxSeconds, remaining + add); broadcast('event', { platform:'kick', type:'coins', add }); }
      }
    }catch{}
  });
  ws.on('close', ()=>{ if (kickWS === ws) setTimeout(()=> setKick(kickChannel), 2000); });
  ws.on('error', ()=> ws.close());
}

// Boot with env if provided
if (tiktokUser) setTikTok(tiktokUser);
if (kickChannel) setKick(kickChannel);

server.listen(port, '0.0.0.0', ()=> console.log('HTTP+WS :'+port));