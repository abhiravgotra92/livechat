'use strict';

// ── WebRTC config — free public TURN via OpenRelay (no registration) ──────────
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443?transport=tcp',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// MQTT signal topics — separate namespace from chat
const T_CALL   = 'livechat/public/v6/call';

// ── State ─────────────────────────────────────────────────────────────────────
let pc          = null;   // RTCPeerConnection
let localStream = null;
let callState   = 'idle'; // idle | calling | ringing | active
let callTarget  = '';     // name of the person we're calling / being called by
let callTargetKey = '';
let isVideo     = false;
let callTimer   = null;
let callSeconds = 0;

// ── UI elements ───────────────────────────────────────────────────────────────
const callOverlay   = document.getElementById('call-overlay');
const callStatus    = document.getElementById('call-status');
const callAvatar    = document.getElementById('call-avatar');
const callName      = document.getElementById('call-name');
const callDuration  = document.getElementById('call-duration');
const btnAccept     = document.getElementById('btn-accept');
const btnDecline    = document.getElementById('btn-decline');
const btnHangup     = document.getElementById('btn-hangup');
const btnMute       = document.getElementById('btn-mute');
const btnCam        = document.getElementById('btn-cam');
const localVideo    = document.getElementById('local-video');
const remoteVideo   = document.getElementById('remote-video');
const videoBox      = document.getElementById('video-box');
const callBtn       = document.getElementById('call-btn');
const videoCallBtn  = document.getElementById('video-call-btn');

// ── Publish via MQTT (reuses mqttClient from chat.js) ─────────────────────────
function publishCall(data) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(T_CALL, JSON.stringify(data));
  }
}

// Subscribe to call topic once MQTT connects — called from chat.js after subscribe
function subscribeCall() {
  if (mqttClient && mqttClient.connected) {
    mqttClient.subscribe(T_CALL);
  }
}

// ── Handle incoming MQTT call messages ────────────────────────────────────────
function handleCallMsg(data) {
  if (!data || !data.type) return;

  // Ignore our own messages
  if (data.fromKey === userKey) return;

  switch (data.type) {
    case 'call-offer':
      if (callState !== 'idle') {
        // Busy — auto-decline
        publishCall({ type: 'call-decline', to: data.fromKey, fromKey: userKey, reason: 'busy' });
        return;
      }
      onIncomingCall(data);
      break;
    case 'call-answer':
      if (data.to === userKey) onCallAnswered(data);
      break;
    case 'call-decline':
      if (data.to === userKey) onCallDeclined(data.reason);
      break;
    case 'call-hangup':
      if (callState !== 'idle') onRemoteHangup();
      break;
    case 'ice-candidate':
      if (data.to === userKey && pc) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
      break;
  }
}

// ── Initiate a call ───────────────────────────────────────────────────────────
async function startCall(withVideo) {
  if (callState !== 'idle') return;
  if (!userName) return;

  // Pick a target from online users (excluding self)
  const others = Object.values(onlineMap).filter(u => u.key !== userKey);
  if (!others.length) {
    showSysMsg('No one else is online to call.');
    return;
  }

  // If multiple users, show picker — otherwise call the only one
  let target;
  if (others.length === 1) {
    target = others[0];
  } else {
    const names = others.map((u, i) => `${i + 1}. ${u.name}`).join('\n');
    const choice = prompt(`Who do you want to call?\n\n${names}\n\nEnter number:`);
    const idx = parseInt(choice) - 1;
    if (isNaN(idx) || !others[idx]) return;
    target = others[idx];
  }

  isVideo      = withVideo;
  callTarget   = target.name;
  callTargetKey = target.key;
  callState    = 'calling';

  showCallUI('calling', callTarget);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { width: 640, height: 480 } : false
    });
  } catch (e) {
    endCall();
    showSysMsg('Microphone access denied. Please allow mic permissions.');
    return;
  }

  if (withVideo) {
    localVideo.srcObject = localStream;
    videoBox.style.display = 'flex';
  }

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  publishCall({
    type:     'call-offer',
    fromKey:  userKey,
    fromName: userName,
    to:       callTargetKey,
    sdp:      offer.sdp,
    video:    withVideo
  });

  // Auto-cancel if no answer in 30s
  setTimeout(() => {
    if (callState === 'calling') {
      publishCall({ type: 'call-hangup', fromKey: userKey });
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

  // Store offer SDP for when we accept
  window._pendingOffer = data;

  showCallUI('ringing', callTarget);
  playRingtone(true);
}

async function acceptCall() {
  if (callState !== 'ringing') return;
  playRingtone(false);

  const data = window._pendingOffer;
  callState = 'active';
  showCallUI('active', callTarget);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: 640, height: 480 } : false
    });
  } catch (e) {
    endCall();
    showSysMsg('Microphone access denied.');
    return;
  }

  if (isVideo) {
    localVideo.srcObject = localStream;
    videoBox.style.display = 'flex';
  }

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  publishCall({
    type:    'call-answer',
    fromKey: userKey,
    to:      callTargetKey,
    sdp:     answer.sdp
  });

  startCallTimer();
}

function declineCall() {
  playRingtone(false);
  publishCall({ type: 'call-decline', to: callTargetKey, fromKey: userKey, reason: 'declined' });
  endCall();
}

// ── Call answered (caller side) ───────────────────────────────────────────────
async function onCallAnswered(data) {
  if (callState !== 'calling') return;
  callState = 'active';
  showCallUI('active', callTarget);
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
  startCallTimer();
}

// ── Call declined ─────────────────────────────────────────────────────────────
function onCallDeclined(reason) {
  const msg = reason === 'busy' ? `${callTarget} is busy.` : `${callTarget} declined the call.`;
  showSysMsg(msg);
  endCall();
}

// ── Remote hung up ────────────────────────────────────────────────────────────
function onRemoteHangup() {
  showSysMsg(`${callTarget} ended the call.`);
  endCall();
}

// ── Hang up ───────────────────────────────────────────────────────────────────
function hangup() {
  publishCall({ type: 'call-hangup', fromKey: userKey });
  endCall();
}

function endCall() {
  playRingtone(false);
  clearInterval(callTimer);
  callSeconds = 0;

  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  localVideo.srcObject  = null;
  remoteVideo.srcObject = null;
  videoBox.style.display = 'none';

  callState     = 'idle';
  callTarget    = '';
  callTargetKey = '';
  window._pendingOffer = null;

  hideCallUI();
}

// ── RTCPeerConnection ─────────────────────────────────────────────────────────
function createPC() {
  const conn = new RTCPeerConnection(RTC_CONFIG);

  conn.onicecandidate = e => {
    if (e.candidate) {
      publishCall({
        type:      'ice-candidate',
        fromKey:   userKey,
        to:        callTargetKey,
        candidate: e.candidate.toJSON()
      });
    }
  };

  conn.ontrack = e => {
    remoteVideo.srcObject = e.streams[0];
    if (!isVideo) {
      // Audio only — hide video box but keep audio playing
      videoBox.style.display = 'none';
    }
  };

  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') {
      showSysMsg('Call connection lost.');
      endCall();
    }
  };

  return conn;
}

// ── Mute / camera toggle ──────────────────────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  btnMute.textContent = track.enabled ? '🎤' : '🔇';
  btnMute.title       = track.enabled ? 'Mute' : 'Unmute';
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  btnCam.textContent = track.enabled ? '📷' : '📷🚫';
}

// ── Call timer ────────────────────────────────────────────────────────────────
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

// ── Ringtone (Web Audio API — no file needed) ─────────────────────────────────
let ringtoneCtx = null;
let ringtoneOsc = null;

function playRingtone(on) {
  if (!on) {
    if (ringtoneOsc) { try { ringtoneOsc.stop(); } catch(_) {} ringtoneOsc = null; }
    if (ringtoneCtx) { ringtoneCtx.close(); ringtoneCtx = null; }
    return;
  }
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    function beep() {
      if (!ringtoneCtx) return;
      const osc  = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      osc.frequency.value = 480;
      gain.gain.setValueAtTime(0.3, ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ringtoneCtx.currentTime + 0.4);
      osc.start(); osc.stop(ringtoneCtx.currentTime + 0.4);
      ringtoneOsc = osc;
    }
    beep();
    const interval = setInterval(() => {
      if (!ringtoneCtx) { clearInterval(interval); return; }
      beep();
    }, 1500);
  } catch(_) {}
}

// ── Call UI ───────────────────────────────────────────────────────────────────
function showCallUI(state, name) {
  callOverlay.classList.remove('hidden');
  callName.textContent = name;
  callDuration.textContent = '';

  btnAccept.style.display  = state === 'ringing' ? 'flex' : 'none';
  btnDecline.style.display = state === 'ringing' ? 'flex' : 'none';
  btnHangup.style.display  = state !== 'ringing' ? 'flex' : 'none';
  btnMute.style.display    = state === 'active'  ? 'flex' : 'none';
  btnCam.style.display     = state === 'active' && isVideo ? 'flex' : 'none';

  const icons = { calling: '📞', ringing: '📲', active: '🔊' };
  const texts = { calling: `Calling ${name}...`, ringing: `${name} is calling...`, active: `On call with ${name}` };
  callAvatar.textContent  = icons[state];
  callStatus.textContent  = texts[state];
}

function hideCallUI() {
  callOverlay.classList.add('hidden');
  callDuration.textContent = '';
}

// ── Wire up buttons ───────────────────────────────────────────────────────────
btnAccept.addEventListener('click', acceptCall);
btnDecline.addEventListener('click', declineCall);
btnHangup.addEventListener('click', hangup);
btnMute.addEventListener('click', toggleMute);
btnCam.addEventListener('click', toggleCam);
callBtn.addEventListener('click', () => startCall(false));
videoCallBtn.addEventListener('click', () => startCall(true));
