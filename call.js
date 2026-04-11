'use strict';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    {
      urls: ['turn:relay1.expressturn.com:3478', 'turn:relay1.expressturn.com:3478?transport=tcp'],
      username: 'efIFGOGCMBSBGBOFYL',
      credential: 'KBFdFFsnzmODggAP'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

const T_CALL = 'livechat/public/v6/call';

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

// DOM refs
const callOverlay  = document.getElementById('call-overlay');
const callStatus   = document.getElementById('call-status');
const callAvatar   = document.getElementById('call-avatar');
const callNameEl   = document.getElementById('call-name');
const callDuration = document.getElementById('call-duration');
const localVideo   = document.getElementById('local-video');
const remoteVideo  = document.getElementById('remote-video');
const videoBox     = document.getElementById('video-box');

// ── Called from chat.js after user successfully joins ─────────────────────────
function initCallButtons() {
  document.getElementById('call-btn').addEventListener('click',       () => startCall(false));
  document.getElementById('video-call-btn').addEventListener('click', () => startCall(true));
  document.getElementById('btn-accept').addEventListener('click',  acceptCall);
  document.getElementById('btn-decline').addEventListener('click', declineCall);
  document.getElementById('btn-hangup').addEventListener('click',  hangup);
  document.getElementById('btn-mute').addEventListener('click',    toggleMute);
  document.getElementById('btn-cam').addEventListener('click',     toggleCam);
}

// ── MQTT helpers ──────────────────────────────────────────────────────────────
function publishCall(data) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(T_CALL, JSON.stringify(data));
  }
}

function isForMe(data) {
  if (data.to && data.to === userKey) return true;
  if (data.toName && data.toName.toLowerCase() === userName.toLowerCase()) return true;
  return false;
}

// ── Route incoming call messages ──────────────────────────────────────────────
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

// ── Start call ────────────────────────────────────────────────────────────────
function startCall(withVideo) {
  if (callState !== 'idle') return;

  updateOnlineCount();
  const others = Object.values(onlineMap).filter(u => u.key !== userKey);

  if (!others.length) {
    const targetName = prompt('Enter the name of the person to call:');
    if (!targetName || !targetName.trim()) return;
    initiateCall({ name: targetName.trim(), key: '' }, withVideo);
    return;
  }

  if (others.length === 1) {
    initiateCall(others[0], withVideo);
  } else {
    showUserPicker(others, withVideo);
  }
}

// ── User picker ───────────────────────────────────────────────────────────────
function showUserPicker(users, withVideo) {
  document.getElementById('user-picker')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'user-picker';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:300;padding:20px';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--sur);border:1px solid var(--bdr);border-radius:20px;padding:24px;width:100%;max-width:320px;';
  box.innerHTML = `
    <div style="font-size:15px;font-weight:700;color:var(--txt);margin-bottom:4px">${withVideo ? '📹 Video Call' : '📞 Voice Call'}</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:16px">Select who to call</div>
  `;

  users.forEach(u => {
    const btn = document.createElement('button');
    btn.style.cssText = 'width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--sur2);border:1px solid var(--bdr);border-radius:12px;color:var(--txt);font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px;';
    btn.innerHTML = `
      <div style="width:36px;height:36px;border-radius:50%;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;flex-shrink:0">${u.name.charAt(0).toUpperCase()}</div>
      <span>${u.name}</span>
      <div style="width:8px;height:8px;border-radius:50%;background:#34d399;margin-left:auto;flex-shrink:0"></div>
    `;
    btn.onclick = () => { overlay.remove(); initiateCall(u, withVideo); };
    box.appendChild(btn);
  });

  const cancel = document.createElement('button');
  cancel.style.cssText = 'width:100%;padding:10px;background:none;border:1px solid var(--bdr);border-radius:10px;color:var(--muted);font-size:13px;cursor:pointer;margin-top:4px;';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => overlay.remove();
  box.appendChild(cancel);

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── Initiate call ─────────────────────────────────────────────────────────────
async function initiateCall(target, withVideo) {
  isVideo       = withVideo;
  callTarget    = target.name;
  callTargetKey = target.key || '';
  callState     = 'calling';
  remoteDescSet = false;
  pendingCandidates = [];

  showCallUI('calling');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { width: 640, height: 480 } : false
    });
  } catch (e) {
    endCall();
    showSysMsg('Microphone/camera access denied. Please allow permissions.');
    return;
  }

  if (withVideo) { localVideo.srcObject = localStream; videoBox.style.display = 'flex'; }

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  publishCall({
    type: 'call-offer', fromKey: userKey, fromName: userName,
    to: callTargetKey, toName: callTarget,
    sdp: offer.sdp, video: withVideo
  });

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
  showCallUI('ringing');
  playRingtone(true);
}

async function acceptCall() {
  if (callState !== 'ringing') return;
  playRingtone(false);

  const data = window._pendingOffer;
  callState = 'active';
  showCallUI('active');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: 640, height: 480 } : false
    });
  } catch (e) {
    endCall();
    showSysMsg('Microphone/camera access denied.');
    return;
  }

  if (isVideo) { localVideo.srcObject = localStream; videoBox.style.display = 'flex'; }

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
  await flushCandidates();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  publishCall({ type: 'call-answer', fromKey: userKey, fromName: userName, to: callTargetKey, toName: callTarget, sdp: answer.sdp });
  startCallTimer();
}

function declineCall() {
  playRingtone(false);
  publishCall({ type: 'call-decline', to: callTargetKey, toName: callTarget, fromKey: userKey, fromName: userName, reason: 'declined' });
  endCall();
}

async function onCallAnswered(data) {
  if (data.fromKey) callTargetKey = data.fromKey;
  callState = 'active';
  showCallUI('active');
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
  await flushCandidates();
  startCallTimer();
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
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  videoBox.style.display = 'none';
  callState = 'idle'; callTarget = ''; callTargetKey = '';
  window._pendingOffer = null;
  hideCallUI();
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
    remoteVideo.srcObject = e.streams[0];
    if (!isVideo) videoBox.style.display = 'none';
  };

  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'connected') callStatus.textContent = `On call with ${callTarget}`;
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
  document.getElementById('btn-mute').textContent = track.enabled ? '🎤' : '🔇';
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  document.getElementById('btn-cam').textContent = track.enabled ? '📷' : '📷🚫';
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    callDuration.textContent = `${m}:${s}`;
  }, 1000);
}

// ── Ringtone ──────────────────────────────────────────────────────────────────
let ringtoneCtx = null;
let ringtoneInterval = null;

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
      gain.gain.setValueAtTime(0.4, ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ringtoneCtx.currentTime + 0.5);
      osc.start(); osc.stop(ringtoneCtx.currentTime + 0.5);
    };
    beep();
    ringtoneInterval = setInterval(beep, 1500);
  } catch (_) {}
}

// ── Call UI ───────────────────────────────────────────────────────────────────
function showCallUI(state) {
  callOverlay.classList.remove('hidden');
  callNameEl.textContent   = callTarget;
  callDuration.textContent = '';

  const icons = { calling: '📞', ringing: '📲', active: '🔊' };
  const texts = {
    calling: `Calling ${callTarget}...`,
    ringing: `${callTarget} is calling you`,
    active:  `On call with ${callTarget}`
  };

  callAvatar.textContent = icons[state] || '📞';
  callStatus.textContent = texts[state] || '';

  document.getElementById('group-incoming').style.display = state === 'ringing' ? 'flex' : 'none';
  document.getElementById('group-active').style.display   = state !== 'ringing' ? 'flex' : 'none';
  document.getElementById('wrap-cam').style.display       = state === 'active' && isVideo ? 'flex' : 'none';
}

function hideCallUI() {
  callOverlay.classList.add('hidden');
  callDuration.textContent = '';
}
