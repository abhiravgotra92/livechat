'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const BROKER  = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC   = 'livechat/public/v6/';
const T_MSG   = TOPIC + 'msg';
const T_CLEAR = TOPIC + 'clear';
const T_TYPE  = TOPIC + 'typing';
const T_PRES  = TOPIC + 'presence';
const T_CALL  = 'livechat/public/v6/call';
const CHAT_PASSWORD = 'artest';
const LS_HIST = 'lc_history_v6';
const LS_EPOCH= 'lc_epoch_v6';
const MAX_HIST= 500;  // keep more history

// ── State ─────────────────────────────────────────────────────────────────────
let mqttClient  = null;
let userName    = '';
let userColor   = '';
let userKey     = '';
let clearEpoch  = 0;
let autoRefresh = true;
let heartbeatTimer = null;
let typTimer    = null;
const seenIds   = new Set();
const onlineMap = {};
const typMap    = {};

const COLORS = ['#6c63ff','#a78bfa','#34d399','#f59e0b','#f87171','#38bdf8','#fb7185','#4ade80'];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const makeId    = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowMs     = () => Date.now();

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const joinScr  = document.getElementById('join-screen');
const chatScr  = document.getElementById('chat-screen');
const nameInp  = document.getElementById('name-input');
const passInp  = document.getElementById('pass-input');
const joinBtn  = document.getElementById('join-btn');
const joinErr  = document.getElementById('join-error');
const msgsEl   = document.getElementById('messages');
const msgForm  = document.getElementById('msg-form');
const msgInp   = document.getElementById('msg-input');
const leaveBtn = document.getElementById('leave-btn');
const clearBtn = document.getElementById('clear-btn');
const refBtn   = document.getElementById('refresh-btn');
const onlineEl = document.getElementById('online-num');
const typEl    = document.getElementById('typing-bar');
const connDot  = document.getElementById('conn-dot');
const modal    = document.getElementById('modal');
const modalYes = document.getElementById('modal-yes');
const modalNo  = document.getElementById('modal-no');

// ── Join ──────────────────────────────────────────────────────────────────────
nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
passInp.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
joinBtn.addEventListener('click', doJoin);

function doJoin() {
  const n = nameInp.value.trim();
  const p = passInp.value;
  if (!n)           { joinErr.textContent = 'Please enter your name.'; return; }
  if (n.length < 2) { joinErr.textContent = 'Name must be at least 2 characters.'; return; }
  if (!p)           { joinErr.textContent = 'Please enter the password.'; return; }
  if (p !== CHAT_PASSWORD) { joinErr.textContent = 'Incorrect password.'; passInp.value = ''; passInp.focus(); return; }
  joinErr.textContent = '';

  userName  = esc(n);
  userColor = pickColor();
  userKey   = makeId();
  clearEpoch = parseInt(localStorage.getItem(LS_EPOCH) || '0', 10);

  // Switch screens
  joinScr.classList.add('hidden');
  chatScr.classList.remove('hidden');
  msgInp.focus();

  // Load saved history first
  renderHistory();

  // Connect MQTT
  connectMQTT();
}

// ── Leave ─────────────────────────────────────────────────────────────────────
leaveBtn.addEventListener('click', doLeave);
window.addEventListener('beforeunload', doLeave);

function doLeave() {
  if (!userName) return;
  publish(T_MSG,  { type: 'system', text: userName + ' left the chat', ts: nowMs() });
  publish(T_PRES, { key: userKey, name: userName, ts: 0 });
  if (mqttClient) {
    mqttClient.removeAllListeners(); // stop auto-reconnect
    mqttClient.end(true);
    mqttClient = null;
  }
  clearInterval(heartbeatTimer);
  userName = '';
  chatScr.classList.add('hidden');
  joinScr.classList.remove('hidden');
  msgsEl.innerHTML = '';
  nameInp.value = '';
  seenIds.clear();
}

// ── MQTT connect ──────────────────────────────────────────────────────────────
function connectMQTT() {
  setDot(false);

  if (typeof mqtt === 'undefined') {
    joinErr.textContent = 'Chat library failed to load. Please refresh.';
    joinScr.classList.remove('hidden');
    chatScr.classList.add('hidden');
    return;
  }

  // Try brokers in order until one connects
  const brokers = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  let brokerIndex = 0;

  function tryConnect() {
    if (brokerIndex >= brokers.length) {
      setDot(false);
      showSysMsg('Could not connect. Retrying...');
      setTimeout(() => { brokerIndex = 0; tryConnect(); }, 5000);
      return;
    }

    const broker = brokers[brokerIndex];
    mqttClient = mqtt.connect(broker, {
      clientId:        'lc_' + makeId(),
      clean:           true,
      reconnectPeriod: 0,       // we handle reconnect manually
      connectTimeout:  8000,
      username:        'livechat',
      password:        'livechat'
    });

    mqttClient.on('connect', () => {
      setDot(true);
      mqttClient.subscribe([T_MSG, T_CLEAR, T_TYPE, T_PRES, T_CALL], err => {
        if (!err) {
          publish(T_MSG,  { type: 'system', text: userName + ' joined the chat', ts: nowMs() });
          // Broadcast presence immediately so others update their count
          publish(T_PRES, { key: userKey, name: userName, ts: nowMs() });
          // Send again after 1s to ensure delivery
          setTimeout(() => publish(T_PRES, { key: userKey, name: userName, ts: nowMs() }), 1000);
          startHeartbeat();
        }
      });
    });

    mqttClient.on('error', () => {
      setDot(false);
      mqttClient.end(true);
      brokerIndex++;
      setTimeout(tryConnect, 1000);
    });

    mqttClient.on('close', () => {
      if (userName) {
        setDot(false);
        setTimeout(() => { brokerIndex = 0; tryConnect(); }, 3000);
      }
    });

    mqttClient.on('reconnect', () => setDot(false));
    mqttClient.on('offline',   () => setDot(false));

    mqttClient.on('message', (topic, raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (topic === T_MSG)   handleMsg(data);
        if (topic === T_CLEAR) handleClear(data);
        if (topic === T_TYPE)  handleTyping(data);
        if (topic === T_PRES)  handlePresence(data);
        if (topic === T_CALL)  { if (typeof handleCallMsg === 'function') handleCallMsg(data); }
      } catch (_) {}
    });
  }

  tryConnect();
}

function publish(topic, data) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, JSON.stringify(data));
  }
}

function setDot(ok) {
  connDot.className = ok ? 'dot-online' : 'dot-offline';
  connDot.title = ok ? 'Connected' : 'Reconnecting...';
}

function showSysMsg(text) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = text;
  msgsEl.appendChild(el);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

// ── History ───────────────────────────────────────────────────────────────────
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch (_) { return []; }
}

function saveHistory(arr) {
  try { localStorage.setItem(LS_HIST, JSON.stringify(arr)); } catch (_) {}
}

function addToHistory(msg) {
  const h = getHistory();
  // Avoid duplicates in storage
  const key = String(msg.ts) + '|' + String(msg.name || '') + '|' + String(msg.text || '');
  if (h.some(m => String(m.ts)+'|'+String(m.name||'')+'|'+String(m.text||'') === key)) return;
  h.push(msg);
  saveHistory(h);  // no slice — keep ALL history until user clears
}

function renderHistory() {
  const h = getHistory().filter(m => m.ts > clearEpoch);
  h.sort((a, b) => a.ts - b.ts);
  h.forEach(m => renderMsg(m, false));
}

// ── Incoming messages ─────────────────────────────────────────────────────────
function handleMsg(msg) {
  if (!msg || !msg.ts) return;
  if (msg.ts <= clearEpoch) return;

  // BUG FIX: deduplicate using a stable key
  const dedupKey = String(msg.ts) + '|' + String(msg.name || '') + '|' + String(msg.text || '');
  if (seenIds.has(dedupKey)) return;
  seenIds.add(dedupKey);

  renderMsg(msg, true);
  if (msg.type === 'user') addToHistory(msg);
}

function renderMsg(msg, animate) {
  if (msg.type === 'system') {
    const el = document.createElement('div');
    el.className = 'sys';
    el.textContent = msg.text;
    msgsEl.appendChild(el);
  } else {
    const isMe = msg.name === userName;
    const row  = document.createElement('div');
    row.className = 'row ' + (isMe ? 'me' : 'them') + (animate ? ' pop' : '');
    row.innerHTML =
      (!isMe ? '<div class="who" style="color:' + msg.color + '">' + esc(msg.name) + '</div>' : '') +
      '<div class="bubble">' + esc(msg.text) + '</div>' +
      '<div class="ts">' + fmtTime(msg.ts) + '</div>';
    msgsEl.appendChild(row);
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

// ── Send message ──────────────────────────────────────────────────────────────
msgForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = msgInp.value.trim();
  if (!text || !userName) return;

  const msg = { type: 'user', name: userName, color: userColor, text, ts: nowMs() };

  // BUG FIX: pre-register dedup key so MQTT echo doesn't double-render
  const dedupKey = String(msg.ts) + '|' + msg.name + '|' + msg.text;
  seenIds.add(dedupKey);

  publish(T_MSG, msg);
  renderMsg(msg, true);
  addToHistory(msg);
  msgInp.value = '';
  doStopTyping();
});

// ── Clear history ─────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => modal.classList.remove('hidden'));
modalNo.addEventListener('click',  () => modal.classList.add('hidden'));

modalYes.addEventListener('click', () => {
  modal.classList.add('hidden');
  const epoch = nowMs();
  // BUG FIX: publish THEN apply locally so both paths use same function
  publish(T_CLEAR, { epoch, by: userName });
  applyClear(epoch, userName);
});

function handleClear(data) {
  if (!data || !data.epoch) return;
  if (data.epoch <= clearEpoch) return;
  applyClear(data.epoch, data.by);
}

function applyClear(epoch, by) {
  clearEpoch = epoch;
  localStorage.setItem(LS_EPOCH, String(epoch));
  saveHistory([]);
  seenIds.clear();
  msgsEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = (by || 'Someone') + ' cleared the chat history';
  msgsEl.appendChild(el);
}

// ── Heartbeat / auto-refresh ──────────────────────────────────────────────────
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!userName || !autoRefresh) return;
    publish(T_PRES, { key: userKey, name: userName, ts: nowMs() });
    updateOnlineCount();
  }, 10000);  // every 10s for faster online count updates
}

refBtn.addEventListener('click', () => {
  autoRefresh = !autoRefresh;
  refBtn.style.opacity = autoRefresh ? '1' : '0.4';
  refBtn.title = autoRefresh ? 'Auto-refresh ON — click to pause' : 'Auto-refresh OFF — click to resume';
});

// ── Presence / online count ───────────────────────────────────────────────────
function handlePresence(data) {
  if (!data || !data.key) return;
  if (!data.ts || nowMs() - data.ts > 35000) {
    delete onlineMap[data.key];
  } else {
    onlineMap[data.key] = { name: data.name, key: data.key, ts: data.ts };
  }
  updateOnlineCount();
}

function updateOnlineCount() {
  Object.keys(onlineMap).forEach(k => {
    if (nowMs() - onlineMap[k].ts > 35000) delete onlineMap[k];
  });
  // Self is always online — count others from map + 1 for self
  const others = Object.keys(onlineMap).filter(k => k !== userKey).length;
  onlineEl.textContent = 1 + others;
}

// ── Typing indicator ──────────────────────────────────────────────────────────
msgInp.addEventListener('input', () => {
  if (!userName) return;
  publish(T_TYPE, { key: userKey, name: userName, ts: nowMs() });
  clearTimeout(typTimer);
  typTimer = setTimeout(doStopTyping, 3000);
});

function doStopTyping() {
  if (userName) publish(T_TYPE, { key: userKey, name: userName, ts: 0 });
  clearTimeout(typTimer);
}

function handleTyping(data) {
  if (!data || !data.key || data.key === userKey) return;
  if (!data.ts || nowMs() - data.ts > 4000) {
    delete typMap[data.key];
  } else {
    typMap[data.key] = data.name;
  }
  const typers = Object.values(typMap);
  typEl.textContent =
    typers.length === 0 ? '' :
    typers.length === 1 ? typers[0] + ' is typing...' :
    typers.join(', ') + ' are typing...';
}
