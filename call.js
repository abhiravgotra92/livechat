'use strict';

// ── PeerJS state ──────────────────────────────────────────────────────────────
let peer         = null;
let activeCall   = null;
let localStream  = null;
let remoteStream = null;  // store so we can re-attach after card rebuild
let callState    = 'idle';
let callTarget   = '';
let callTargetId = '';
let isVideo      = false;
let callTimer    = null;
let callSeconds  = 0;
let ringtoneCtx  = null;
let ringtoneInt  = null;

// ── Init — called by chat.js after join ───────────────────────────────────────
function initCallButtons() {
  peer = new Peer(userKey, {
    host: '0.peerjs.com', port: 443, secure: true, path: '/', debug: 0
  });

  peer.on('open', () => {
    document.getElementById('call-btn').addEventListener('click',       () => startCall(false));
    document.getElementById('video-call-btn').addEventListener('click', () => startCall(true));
  });

  peer.on('error', err => {
    if (err.type !== 'peer-unavailable') showSysMsg('⚠️ Call service error: ' + err.type);
  });

  // ── Incoming call ──────────────────────────────────────────────────────────
  peer.on('call', incoming => {
    if (callState !== 'idle') { incoming.close(); return; }
    activeCall   = incoming;
    callState    = 'ringing';
    isVideo      = !!(incoming.metadata && incoming.metadata.video);
    callTarget   = (incoming.metadata && incoming.metadata.name) || incoming.peer;
    callTargetId = incoming.peer;

    showCallCard('ringing');
    playRingtone(true);

    incoming.on('stream', s => { remoteStream = s; attachRemote(s); });
    incoming.on('close',  () => { if (callState !== 'idle') { showSysMsg(callTarget + ' ended the call.'); endCall(); } });
    incoming.on('error',  () => endCall());
  });
}

// ── Start call ────────────────────────────────────────────────────────────────
function startCall(withVideo) {
  if (!peer || !peer.open) { showSysMsg('⚠️ Call service not ready yet.'); return; }
  if (callState !== 'idle') return;

  updateOnlineCount();
  const others = Object.values(onlineMap).filter(u => u.key !== userKey);

  // Always show picker — never auto-call even if only 1 person online
  showPickerCard(withVideo, others);
}

// ── Picker card ───────────────────────────────────────────────────────────────
function showPickerCard(withVideo, users) {
  removeCard();
  const card = baseCard();

  addEl(card, 'div', withVideo ? '📹' : '📞', 'font-size:36px;margin-bottom:8px');
  addEl(card, 'div', withVideo ? 'Video Call' : 'Voice Call', 'font-size:17px;font-weight:700;color:#fff;margin-bottom:4px');
  addEl(card, 'div', users.length ? 'Select who to call' : 'Enter the name of the person to call', 'font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:16px');

  if (users.length) {
    users.forEach(u => {
      const btn = document.createElement('button');
      btn.style.cssText = 'width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px;min-height:52px';
      const av = addEl(btn, 'div', u.name.charAt(0).toUpperCase(), 'width:38px;height:38px;border-radius:50%;background:#6c63ff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;flex-shrink:0');
      addEl(btn, 'span', u.name, '');
      addEl(btn, 'div', '', 'width:9px;height:9px;border-radius:50%;background:#34d399;margin-left:auto;flex-shrink:0');
      btn.addEventListener('click', () => { removeCard(); initiateCall(u.key, u.name, withVideo); });
      card.appendChild(btn);
    });
  } else {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = 'Their name...'; inp.autocomplete = 'off';
    inp.style.cssText = 'width:100%;padding:12px 14px;background:rgba(255,255,255,0.08);border:1px solid rgba(108,99,255,0.5);border-radius:10px;color:#fff;font-size:16px;outline:none;margin-bottom:12px;text-align:center;display:block';
    card.appendChild(inp);

    const go = addEl(card, 'button', 'Call', 'width:100%;padding:13px;background:linear-gradient(135deg,#6c63ff,#a78bfa);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;min-height:48px;margin-bottom:8px');
    const doCall = () => {
      const name = inp.value.trim(); if (!name) { inp.focus(); return; }
      const match = Object.values(onlineMap).find(u => u.name.toLowerCase() === name.toLowerCase() && u.key !== userKey);
      if (!match) { showSysMsg('⚠️ "' + name + '" is not online.'); removeCard(); return; }
      removeCard(); initiateCall(match.key, match.name, withVideo);
    };
    go.addEventListener('click', doCall);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doCall(); });
    setTimeout(() => inp.focus(), 100);
  }

  const cancel = addEl(card, 'button', 'Cancel', 'width:100%;padding:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:rgba(255,255,255,0.5);font-size:13px;cursor:pointer;min-height:44px');
  cancel.addEventListener('click', removeCard);
  document.body.appendChild(card);
}

// ── Initiate call ─────────────────────────────────────────────────────────────
async function initiateCall(targetId, targetName, withVideo) {
  isVideo = withVideo; callTarget = targetName; callTargetId = targetId; callState = 'calling';
  showCallCard('calling');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo ? { width:640, height:480 } : false });
  } catch(e) {
    endCall(); showSysMsg('⚠️ Microphone/camera access denied.'); return;
  }

  attachLocal(localStream, withVideo);

  activeCall = peer.call(targetId, localStream, { metadata: { name: userName, video: withVideo } });
  if (!activeCall) { endCall(); showSysMsg('⚠️ Could not reach ' + targetName + '.'); return; }

  activeCall.on('stream', s => { remoteStream = s; callState = 'active'; showCallCard('active'); startCallTimer(); attachRemote(s); });
  activeCall.on('close',  () => { if (callState !== 'idle') { showSysMsg(callTarget + ' ended the call.'); endCall(); } });
  activeCall.on('error',  () => endCall());

  setTimeout(() => { if (callState === 'calling') { showSysMsg(callTarget + " didn't answer."); endCall(); } }, 30000);
}

// ── Accept / Decline / Hangup ─────────────────────────────────────────────────
async function acceptCall() {
  if (!activeCall || callState !== 'ringing') return;
  playRingtone(false);
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo ? { width:640, height:480 } : false });
  } catch(e) { endCall(); showSysMsg('⚠️ Microphone/camera access denied.'); return; }

  activeCall.answer(localStream);
  callState = 'active';
  showCallCard('active');  // rebuild card — video elements now exist
  startCallTimer();
  attachLocal(localStream, isVideo);
  if (remoteStream) attachRemote(remoteStream);  // re-attach if stream already arrived
}

function declineCall() { playRingtone(false); if (activeCall) activeCall.close(); endCall(); }
function hangup()      { if (activeCall) activeCall.close(); endCall(); }

function endCall() {
  playRingtone(false); clearInterval(callTimer); callSeconds = 0;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  remoteStream = null;
  const ra = document.getElementById('call-remote-audio');
  if (ra) ra.remove();
  activeCall = null; callState = 'idle'; callTarget = ''; callTargetId = '';
  removeCard();
}

// ── Stream helpers ────────────────────────────────────────────────────────────
function attachLocal(stream, withVideo) {
  const lv = document.getElementById('call-local-video');
  const vw = document.getElementById('call-video-wrap');
  if (lv) lv.srcObject = stream;
  if (vw && withVideo) vw.style.display = 'block';
}

function attachRemote(stream) {
  const rv = document.getElementById('call-remote-video');
  const vw = document.getElementById('call-video-wrap');
  if (rv) {
    rv.srcObject = stream;
    rv.play().catch(() => {});
  }
  if (vw && isVideo) vw.style.display = 'block';

  // For voice calls, ensure audio plays via a hidden audio element
  if (!isVideo) {
    let audio = document.getElementById('call-remote-audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'call-remote-audio';
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(() => {});
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const b = document.getElementById('call-mute-btn');
  if (b) b.textContent = t.enabled ? '🎤' : '🔇';
}
function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const b = document.getElementById('call-cam-btn');
  if (b) b.textContent = t.enabled ? '📷' : '📷🚫';
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startCallTimer() {
  callSeconds = 0; clearInterval(callTimer);
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s = String(callSeconds%60).padStart(2,'0');
    const d = document.getElementById('call-duration');
    if (d) d.textContent = m+':'+s;
  }, 1000);
}

// ── Ringtone ──────────────────────────────────────────────────────────────────
function playRingtone(on) {
  if (!on) {
    clearInterval(ringtoneInt); ringtoneInt = null;
    if (ringtoneCtx) { ringtoneCtx.close().catch(()=>{}); ringtoneCtx = null; }
    return;
  }
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!ringtoneCtx) return;
      const o = ringtoneCtx.createOscillator(), g = ringtoneCtx.createGain();
      o.connect(g); g.connect(ringtoneCtx.destination);
      o.frequency.value = 440;
      g.gain.setValueAtTime(0.3, ringtoneCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ringtoneCtx.currentTime+0.5);
      o.start(); o.stop(ringtoneCtx.currentTime+0.5);
    };
    beep(); ringtoneInt = setInterval(beep, 1500);
  } catch(_) {}
}

// ── Card builder ──────────────────────────────────────────────────────────────
function removeCard() { const c = document.getElementById('call-card'); if (c) c.remove(); }

function baseCard() {
  removeCard(); injectStyles();
  const c = document.createElement('div');
  c.id = 'call-card';
  c.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);width:calc(100% - 32px);max-width:340px;background:linear-gradient(160deg,#1e1b4b,#1a1a2e);border:1px solid #4f46e5;border-radius:20px;padding:22px 20px 20px;z-index:9999;box-shadow:0 12px 40px rgba(0,0,0,0.85);font-family:system-ui,-apple-system,sans-serif;color:#fff;text-align:center';
  return c;
}

function showCallCard(state) {
  const card = baseCard();

  // Avatar
  const av = addEl(card, 'div', state==='ringing'?'📲':state==='active'?'🔊':'📞',
    'width:76px;height:76px;border-radius:50%;background:linear-gradient(135deg,#6c63ff,#a78bfa);display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 14px;animation:callPulse 1.8s ease-in-out infinite');

  addEl(card, 'div', callTarget, 'font-size:20px;font-weight:700;margin-bottom:4px');

  const statusText = state==='calling'?'Calling...' : state==='ringing'?'Incoming call' : 'Connected';
  addEl(card, 'div', statusText, 'font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:16px');

  // Animated dots (calling)
  if (state === 'calling') {
    const dots = addEl(card, 'div', '', 'display:flex;justify-content:center;gap:7px;margin-bottom:16px');
    [0, 0.2, 0.4].forEach(d => addEl(dots, 'div', '', `width:9px;height:9px;border-radius:50%;background:#a78bfa;animation:dotBounce 1.2s ${d}s infinite ease-in-out`));
  }

  // Duration (active)
  if (state === 'active') {
    const dur = addEl(card, 'div', '00:00', 'font-size:22px;font-weight:700;color:#a78bfa;margin-bottom:16px;font-variant-numeric:tabular-nums');
    dur.id = 'call-duration';
  }

  // Video wrap
  const vw = addEl(card, 'div', '', 'display:none;position:relative;border-radius:12px;overflow:hidden;background:#000;margin-bottom:16px;aspect-ratio:4/3');
  vw.id = 'call-video-wrap';
  const rv = document.createElement('video'); rv.id='call-remote-video'; rv.autoplay=true; rv.playsInline=true; rv.style.cssText='width:100%;height:100%;object-fit:cover'; vw.appendChild(rv);
  const lv = document.createElement('video'); lv.id='call-local-video';  lv.autoplay=true; lv.playsInline=true; lv.muted=true; lv.style.cssText='position:absolute;bottom:8px;right:8px;width:80px;border-radius:8px;border:2px solid rgba(255,255,255,0.3)'; vw.appendChild(lv);

  // Buttons
  const row = addEl(card, 'div', '', 'display:flex;justify-content:center;gap:24px;flex-wrap:wrap');

  if (state === 'ringing') {
    row.appendChild(actionBtn('📵', 'Decline', '#ef4444', 'call-decline-btn', declineCall));
    row.appendChild(actionBtn('📞', 'Accept',  '#22c55e', 'call-accept-btn',  acceptCall));
  } else {
    if (state === 'active') {
      row.appendChild(actionBtn('🎤', 'Mute',   '#374151', 'call-mute-btn', toggleMute));
      if (isVideo) row.appendChild(actionBtn('📷', 'Camera', '#374151', 'call-cam-btn', toggleCam));
    }
    row.appendChild(actionBtn('📵', 'End', '#ef4444', 'call-end-btn', hangup));
  }

  document.body.appendChild(card);
  if (state === 'active' && localStream)  attachLocal(localStream, isVideo);
  if (state === 'active' && remoteStream) attachRemote(remoteStream);
}

function actionBtn(icon, label, bg, id, fn) {
  const wrap = addEl(document.createElement('div'), 'div', '', '');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px';
  const btn = addEl(wrap, 'button', icon, `width:64px;height:64px;border-radius:50%;border:none;background:${bg};color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center`);
  btn.id = id;
  btn.addEventListener('click', fn);
  addEl(wrap, 'span', label, 'font-size:11px;color:rgba(255,255,255,0.5)');
  return wrap;
}

function addEl(parent, tag, text, css) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (css)  e.style.cssText = css;
  parent.appendChild(e);
  return e;
}

function injectStyles() {
  if (document.getElementById('call-styles')) return;
  const s = document.createElement('style');
  s.id = 'call-styles';
  s.textContent = `
    @keyframes callPulse {
      0%   { box-shadow:0 0 0 0 rgba(108,99,255,0.7); }
      70%  { box-shadow:0 0 0 20px rgba(108,99,255,0); }
      100% { box-shadow:0 0 0 0 rgba(108,99,255,0); }
    }
    @keyframes dotBounce {
      0%,80%,100% { transform:scale(0.5);opacity:0.3; }
      40%         { transform:scale(1.0);opacity:1.0; }
    }
  `;
  document.head.appendChild(s);
}
