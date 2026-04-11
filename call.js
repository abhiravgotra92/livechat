'use strict';

// ── ICE config ────────────────────────────────────────────────────────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: ['turn:relay1.expressturn.com:3478', 'turn:relay1.expressturn.com:3478?transport=tcp'],
      username: 'efIFGOGCMBSBGBOFYL',
      credential: 'KBFdFFsnzmODggAP'
    },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

const T_CALL = 'livechat/public/v6/call';

// ── State ─────────────────────────────────────────────────────────────────────
let pc                = null;
let localStream       = null;
let callState         = 'idle';
let callTarget        = '';
let callTargetKey     = '';
let isVideo           = false;
let callTimer         = null;
let callSeconds       = 0;
let pendingCandidates = [];
let remoteDescSet     = false;
let ringtoneCtx       = null;
let ringtoneInterval  = null;

// ── MQTT ──────────────────────────────────────────────────────────────────────
function publishCall(data) {
  if (typeof mqttClient !== 'undefined' && mqttClient && mqttClient.connected) {
    mqttClient.publish(T_CALL, JSON.stringify(data));
  }
}

function isForMe(data) {
  if (data.to && data.to === userKey) return true;
  if (data.toName && data.toName.toLowerCase() === userName.toLowerCase()) return true;
  return false;
}

function handleCallMsg(data) {
  if (!data || !data.type) return;
  if (data.fromKey === userKey) return;

  switch (data.type) {
    case 'call-offer':
      if (!isForMe(data)) return;
      if (callState !== 'idle') {
        publishCall({ type: 'call-decline', to: data.fromKey, toName: data.fromName, fromKey: userKey, fromName: userName, reason: 'busy' });
        return;
      }
      onIncomingCall(data);
      break;
    case 'call-answer':
      if (!isForMe(data)) return;
      if (callState === 'calling') onCallAnswered(data);
      break;
    case 'call-decline':
      if (!isForMe(data)) return;
      onCallDeclined(data.reason);
      break;
    case 'call-hangup':
      if (!isForMe(data)) return;
      if (callState !== 'idle') onRemoteHangup();
      break;
    case 'ice-candidate':
      if (!isForMe(data)) return;
      if (!pc) return;
      if (remoteDescSet) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      } else {
        pendingCandidates.push(data.candidate);
      }
      break;
  }
}

async function flushCandidates() {
  remoteDescSet = true;
  for (const c of pendingCandidates) {
    await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
  pendingCandidates = [];
}

// ── Call box UI ───────────────────────────────────────────────────────────────
function getCallBox() {
  return document.getElementById('call-card');
}

function removeCallBox() {
  const el = document.getElementById('call-card');
  if (el) el.remove();
}

function buildCallBox(state) {
  removeCallBox();

  const box = document.createElement('div');
  box.id = 'call-card';
  box.style.cssText = [
    'position:fixed',
    'bottom:90px',
    'left:50%',
    'transform:translateX(-50%)',
    'width:calc(100% - 32px)',
    'max-width:360px',
    'background:linear-gradient(135deg,#1e1b4b,#1e1a3a)',
    'border:1px solid #4f46e5',
    'border-radius:20px',
    'padding:20px',
    'z-index:9999',
    'box-shadow:0 8px 32px rgba(0,0,0,0.8)',
    'font-family:system-ui,sans-serif',
    'color:#fff',
    'text-align:center'
  ].join(';');

  // Avatar
  const avatar = document.createElement('div');
  avatar.style.cssText = 'width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#6c63ff,#a78bfa);display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 12px;animation:callPulse 1.8s ease-in-out infinite';
  avatar.textContent = state === 'ringing' ? '📲' : state === 'active' ? '🔊' : '📞';

  // Name
  const name = document.createElement('div');
  name.id = 'call-card-name';
  name.style.cssText = 'font-size:20px;font-weight:700;margin-bottom:4px';
  name.textContent = callTarget;

  // Status
  const status = document.createElement('div');
  status.id = 'call-card-status';
  status.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:4px';
  status.textContent = state === 'calling' ? 'Calling...' : state === 'ringing' ? 'Incoming call' : 'Connected';

  // Duration
  const duration = document.createElement('div');
  duration.id = 'call-card-duration';
  duration.style.cssText = 'font-size:18px;font-weight:600;color:#a78bfa;min-height:26px;margin-bottom:16px';

  // Dots for calling state
  if (state === 'calling') {
    const dots = document.createElement('div');
    dots.style.cssText = 'display:flex;justify-content:center;gap:6px;margin-bottom:16px';
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div');
      d.style.cssText = `width:8px;height:8px;border-radius:50%;background:#a78bfa;animation:dotBounce 1.2s ${i*0.2}s infinite ease-in-out`;
      dots.appendChild(d);
    }
    box.appendChild(avatar);
    box.appendChild(name);
    box.appendChild(status);
    box.appendChild(dots);
  } else {
    box.appendChild(avatar);
    box.appendChild(name);
    box.appendChild(status);
    box.appendChild(duration);
  }

  // Video box
  const videoWrap = document.createElement('div');
  videoWrap.id = 'call-video-wrap';
  videoWrap.style.cssText = 'display:none;position:relative;border-radius:12px;overflow:hidden;background:#000;margin-bottom:16px;aspect-ratio:4/3';
  const remVid = document.createElement('video');
  remVid.id = 'remote-video';
  remVid.autoplay = true;
  remVid.playsInline = true;
  remVid.style.cssText = 'width:100%;height:100%;object-fit:cover';
  const locVid = document.createElement('video');
  locVid.id = 'local-video';
  locVid.autoplay = true;
  locVid.playsInline = true;
  locVid.muted = true;
  locVid.style.cssText = 'position:absolute;bottom:8px;right:8px;width:80px;border-radius:8px;border:2px solid rgba(255,255,255,0.3)';
  videoWrap.appendChild(remVid);
  videoWrap.appendChild(locVid);
  box.appendChild(videoWrap);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;justify-content:center;gap:20px;flex-wrap:wrap';

  if (state === 'ringing') {
    btnRow.appendChild(makeBtn('📵', 'Decline', '#ef4444', declineCall));
    btnRow.appendChild(makeBtn('📞', 'Accept', '#22c55e', acceptCall));
  } else {
    if (state === 'active') {
      btnRow.appendChild(makeBtn('🎤', 'Mute', '#374151', toggleMute));
      if (isVideo) btnRow.appendChild(makeBtn('📷', 'Camera', '#374151', toggleCam));
    }
    btnRow.appendChild(makeBtn('📵', 'End', '#ef4444', hangup));
  }

  box.appendChild(btnRow);

  // Inject keyframe styles once
  if (!document.getElementById('call-keyframes')) {
    const style = document.createElement('style');
    style.id = 'call-keyframes';
    style.textContent = `
      @keyframes callPulse {
        0%   { box-shadow: 0 0 0 0 rgba(108,99,255,0.6); }
        70%  { box-shadow: 0 0 0 18px rgba(108,99,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(108,99,255,0); }
      }
      @keyframes dotBounce {
        0%,80%,100% { transform:scale(0.6); opacity:0.4; }
        40%         { transform:scale(1.0); opacity:1.0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(box);
  return box;
}

function makeBtn(icon, label, bg, fn) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px';

  const btn = document.createElement('button');
  btn.style.cssText = `width:60px;height:60px;border-radius:50%;border:none;background:${bg};color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center`;
  btn.textContent = icon;
  btn.id = 'call-btn-' + label.toLowerCase();
  btn.addEventListener('click', fn);

  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.5)';
  lbl.textContent = label;

  wrap.appendChild(btn);
  wrap.appendChild(lbl);
  return wrap;
}

function updateCallStatus(text) {
  const el = document.getElementById('call-card-status');
  if (el) el.textContent = text;
}

// ── Start call ────────────────────────────────────────────────────────────────
function startCall(withVideo) {
  if (!userName) return;
  if (callState !== 'idle') return;

  updateOnlineCount();
  const others = Object.values(onlineMap).filter(u => u.key !== userKey);

  if (!others.length) {
    showPickerCard(withVideo);
    return;
  }
  if (others.length === 1) {
    initiateCall(others[0], withVideo);
  } else {
    showPickerCard(withVideo, others);
  }
}

// ── Picker card (shown in chat window) ───────────────────────────────────────
function showPickerCard(withVideo, users) {
  removeCallBox();

  const box = document.createElement('div');
  box.id = 'call-card';
  box.style.cssText = [
    'position:fixed',
    'bottom:90px',
    'left:50%',
    'transform:translateX(-50%)',
    'width:calc(100% - 32px)',
    'max-width:360px',
    'background:linear-gradient(135deg,#1e1b4b,#1e1a3a)',
    'border:1px solid #4f46e5',
    'border-radius:20px',
    'padding:20px',
    'z-index:9999',
    'box-shadow:0 8px 32px rgba(0,0,0,0.8)',
    'font-family:system-ui,sans-serif',
    'color:#fff',
    'text-align:center'
  ].join(';');

  const icon = document.createElement('div');
  icon.style.cssText = 'font-size:32px;margin-bottom:8px';
  icon.textContent = withVideo ? '📹' : '📞';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:4px';
  title.textContent = withVideo ? 'Video Call' : 'Voice Call';

  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:16px';
  sub.textContent = users ? 'Select who to call' : 'Enter the name of the person to call';

  box.appendChild(icon);
  box.appendChild(title);
  box.appendChild(sub);

  if (users && users.length) {
    users.forEach(u => {
      const btn = document.createElement('button');
      btn.style.cssText = 'width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px;min-height:48px';

      const av = document.createElement('div');
      av.style.cssText = 'width:36px;height:36px;border-radius:50%;background:#6c63ff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;flex-shrink:0';
      av.textContent = u.name.charAt(0).toUpperCase();

      const nm = document.createElement('span');
      nm.textContent = u.name;

      const dot = document.createElement('div');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#34d399;margin-left:auto;flex-shrink:0';

      btn.appendChild(av);
      btn.appendChild(nm);
      btn.appendChild(dot);
      btn.addEventListener('click', () => { removeCallBox(); initiateCall(u, withVideo); });
      box.appendChild(btn);
    });
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Their name...';
    input.autocomplete = 'off';
    input.style.cssText = 'width:100%;padding:12px 14px;background:rgba(255,255,255,0.08);border:1px solid rgba(108,99,255,0.5);border-radius:10px;color:#fff;font-size:16px;outline:none;margin-bottom:12px;text-align:center;display:block';
    box.appendChild(input);

    const callBtn = document.createElement('button');
    callBtn.style.cssText = 'width:100%;padding:13px;background:linear-gradient(135deg,#6c63ff,#a78bfa);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;min-height:48px;margin-bottom:8px';
    callBtn.textContent = 'Call';

    const doCall = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      removeCallBox();
      initiateCall({ name, key: '' }, withVideo);
    };
    callBtn.addEventListener('click', doCall);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doCall(); });
    box.appendChild(callBtn);

    setTimeout(() => input.focus(), 100);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'width:100%;padding:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:rgba(255,255,255,0.5);font-size:13px;cursor:pointer;min-height:44px';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', removeCallBox);
  box.appendChild(cancelBtn);

  document.body.appendChild(box);
}

// ── Initiate call ─────────────────────────────────────────────────────────────
async function initiateCall(target, withVideo) {
  isVideo       = withVideo;
  callTarget    = target.name;
  callTargetKey = target.key || '';
  callState     = 'calling';
  remoteDescSet = false;
  pendingCandidates = [];

  buildCallBox('calling');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { width: 640, height: 480 } : false
    });
  } catch (e) {
    endCall();
    showSysMsg('⚠️ Microphone/camera access denied. Please allow permissions and try again.');
    return;
  }

  if (withVideo) {
    const lv = document.getElementById('local-video');
    const vw = document.getElementById('call-video-wrap');
    if (lv) lv.srcObject = localStream;
    if (vw) vw.style.display = 'block';
  }

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  publishCall({ type: 'call-offer', fromKey: userKey, fromName: userName, to: callTargetKey, toName: callTarget, sdp: offer.sdp, video: withVideo });

  setTimeout(() => {
    if (callState === 'calling') {
      publishCall({ type: 'call-hangup', fromKey: userKey, fromName: userName, to: callTargetKey, toName: callTarget });
      endCall();
      showSysMsg(`${callTarget} didn't answer.`);
    }
  }, 30000);
}

// ── Incoming call ─────────────────────────────────────────────────────────────
function onIncomingCall(data) {
  callState     = 'ringing';
  callTarget    = data.fromName;
  callTargetKey = data.fromKey;
  isVideo       = data.video;
  remoteDescSet = false;
  pendingCandidates = [];
  window._pendingOffer = data;
  buildCallBox('ringing');
  playRingtone(true);
}

async function acceptCall() {
  if (callState !== 'ringing') return;
  playRingtone(false);
  const data = window._pendingOffer;
  callState = 'active';
  buildCallBox('active');
  startCallTimer();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: 640, height: 480 } : false
    });
  } catch (e) {
    endCall();
    showSysMsg('⚠️ Microphone/camera access denied.');
    return;
  }

  if (isVideo) {
    const lv = document.getElementById('local-video');
    const vw = document.getElementById('call-video-wrap');
    if (lv) lv.srcObject = localStream;
    if (vw) vw.style.display = 'block';
  }

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
  await flushCandidates();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  publishCall({ type: 'call-answer', fromKey: userKey, fromName: userName, to: callTargetKey, toName: callTarget, sdp: answer.sdp });
}

function declineCall() {
  playRingtone(false);
  publishCall({ type: 'call-decline', to: callTargetKey, toName: callTarget, fromKey: userKey, fromName: userName, reason: 'declined' });
  endCall();
}

async function onCallAnswered(data) {
  if (data.fromKey) callTargetKey = data.fromKey;
  callState = 'active';
  buildCallBox('active');
  startCallTimer();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
  await flushCandidates();
}

function onCallDeclined(reason) {
  showSysMsg(reason === 'busy' ? `${callTarget} is busy.` : `${callTarget} declined the call.`);
  endCall();
}

function onRemoteHangup() {
  showSysMsg(`${callTarget} ended the call.`);
  endCall();
}

function hangup() {
  publishCall({ type: 'call-hangup', fromKey: userKey, fromName: userName, to: callTargetKey, toName: callTarget });
  endCall();
}

function endCall() {
  playRingtone(false);
  clearInterval(callTimer);
  callSeconds = 0;
  remoteDescSet = false;
  pendingCandidates = [];
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  callState = 'idle'; callTarget = ''; callTargetKey = '';
  window._pendingOffer = null;
  removeCallBox();
}

// ── RTCPeerConnection ─────────────────────────────────────────────────────────
function createPC() {
  const conn = new RTCPeerConnection(RTC_CONFIG);

  conn.onicecandidate = e => {
    if (e.candidate) {
      publishCall({ type: 'ice-candidate', fromKey: userKey, fromName: userName, to: callTargetKey, toName: callTarget, candidate: e.candidate.toJSON() });
    }
  };

  conn.ontrack = e => {
    const rv = document.getElementById('remote-video');
    const vw = document.getElementById('call-video-wrap');
    if (rv) rv.srcObject = e.streams[0];
    if (vw && isVideo) vw.style.display = 'block';
  };

  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'connected') updateCallStatus(`On call with ${callTarget}`);
    if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') {
      showSysMsg('Call connection lost.');
      endCall();
    }
  };

  return conn;
}

// ── Controls ──────────────────────────────────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const btn = document.getElementById('call-btn-mute');
  if (btn) btn.textContent = track.enabled ? '🎤' : '🔇';
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const btn = document.getElementById('call-btn-camera');
  if (btn) btn.textContent = track.enabled ? '📷' : '📷🚫';
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const el = document.getElementById('call-card-duration');
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);
}

// ── Ringtone ──────────────────────────────────────────────────────────────────
function playRingtone(on) {
  if (!on) {
    clearInterval(ringtoneInterval); ringtoneInterval = null;
    if (ringtoneCtx) { ringtoneCtx.close().catch(() => {}); ringtoneCtx = null; }
    return;
  }
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!ringtoneCtx) return;
      const osc = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.3, ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ringtoneCtx.currentTime + 0.5);
      osc.start(); osc.stop(ringtoneCtx.currentTime + 0.5);
    };
    beep();
    ringtoneInterval = setInterval(beep, 1500);
  } catch (_) {}
}

// ── Wire buttons at page load ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('call-btn').addEventListener('click', () => startCall(false));
  document.getElementById('video-call-btn').addEventListener('click', () => startCall(true));
});

function initCallButtons() {} // called by chat.js after join — no-op now
