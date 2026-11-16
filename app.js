// app.js — UI, audio graph, background playback, PWA wiring
const $ = (s) => document.querySelector(s);

// ---------- settings ----------
const BANDS = [
  { f: 60, type: 'lowshelf', label: '60' },
  { f: 125, label: '125' },
  { f: 250, label: '250' },
  { f: 500, label: '500' },
  { f: 1000, label: '1k' },
  { f: 2000, label: '2k' },
  { f: 4000, label: '4k' },
  { f: 8000, type: 'highshelf', label: '8k+' },
];
const EQ_RANGE = 15; // ± dB
const DEFAULTS = { color: 0.5, highcut: 1, pulseRate: 0.45, pulseDepth: 0, volume: 0.6, eq: BANDS.map(() => 0), stereo: true, bgMode: true, sleep: 0 };

const state = (() => {
  try {
    const s = JSON.parse(localStorage.getItem('noise-settings')) || {};
    return { ...DEFAULTS, ...s, eq: Array.isArray(s.eq) && s.eq.length === BANDS.length ? s.eq : DEFAULTS.eq.slice() };
  } catch { return { ...DEFAULTS, eq: DEFAULTS.eq.slice() }; }
})();
let saveT;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('noise-settings', JSON.stringify(state)); } catch {} }, 250); };

// ---------- audio graph ----------
// worklet → highpass 18 Hz → 8 EQ bands → limiter → master gain →
//   (background mode) MediaStream → <audio> element   — keeps playing with screen off
//   (direct mode)     AudioContext.destination
let ctx, noise, hp, eqNodes = [], limiter, master, streamDest, workletReady;
let playing = false, stopTimer = null, sleepDeadline = null;
const sink = $('#sink');

const volGain = (v) => v * v; // perceptual taper

function buildGraph() {
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC({ latencyHint: 'playback' }); // big buffers = less CPU/battery
  hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 18; hp.Q.value = 0.7;
  let last = hp;
  eqNodes = BANDS.map((b, i) => {
    const n = ctx.createBiquadFilter();
    n.type = b.type || 'peaking';
    n.frequency.value = b.f;
    if (n.type === 'peaking') n.Q.value = 1.1;
    n.gain.value = state.eq[i];
    last.connect(n); last = n; return n;
  });
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.003; limiter.release.value = 0.25;
  master = ctx.createGain();
  master.gain.value = volGain(state.volume);
  last.connect(limiter); limiter.connect(master);
  streamDest = ctx.createMediaStreamDestination();
  applyRouting();
  ctx.onstatechange = updateStatus;

  workletReady = ctx.audioWorklet.addModule('noise-worklet.js').then(() => {
    noise = new AudioWorkletNode(ctx, 'noise', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    noise.port.onmessage = (e) => { if (e.data.type === 'sleepDone') { state.sleep = 0; renderSleep(); save(); stop(); } };
    noise.port.postMessage({ type: 'color', value: state.color, immediate: true });
    noise.port.postMessage({ type: 'highcut', value: state.highcut, immediate: true });
    noise.port.postMessage({ type: 'pulse', rate: pulseHz(state.pulseRate), depth: state.pulseDepth, immediate: true });
    noise.port.postMessage({ type: 'stereo', value: state.stereo });
    noise.connect(hp);
  });
}

function applyRouting() {
  if (!master) return;
  master.disconnect();
  if (state.bgMode) {
    master.connect(streamDest);
    if (sink.srcObject !== streamDest.stream) sink.srcObject = streamDest.stream;
  } else {
    master.connect(ctx.destination);
    sink.pause();
    sink.srcObject = null;
  }
}

async function start() {
  if (playing) return;
  playing = true; // set early so a double tap doesn't start twice
  updateUI();
  try {
    // iOS 16.4+: treat as media playback (ignores silent switch, allows background)
    if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch {} }
    if (!ctx) buildGraph();
    clearTimeout(stopTimer);
    // Kick these off while we're still inside the user's tap
    const resumeP = ctx.resume();
    const playP = state.bgMode ? sink.play() : Promise.resolve();
    await resumeP;
    try { await playP; }
    catch (err) {
      console.warn('Media-element route failed, falling back to direct output', err);
      state.bgMode = false; applyRouting(); renderSettings(); save();
      flash('Background mode unavailable here — using direct output');
    }
    await workletReady;
    if (!playing) return; // stopped while loading
    noise.port.postMessage({ type: 'fade', target: 1, seconds: 2 });
    armSleep();
  } catch (err) {
    playing = false;
    flash('Could not start audio: ' + err.message);
  }
  updateUI();
}

function stop() {
  if (!playing) return;
  playing = false;
  disarmSleep();
  if (noise) noise.port.postMessage({ type: 'fade', target: 0, seconds: 0.4 });
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (playing) return;
    sink.pause();
    ctx && ctx.suspend();
  }, 500);
  updateUI();
}

// If the OS pauses our media element (headphones unplugged, another app takes audio focus)
sink.addEventListener('pause', () => { if (playing && state.bgMode && sink.srcObject) stop(); });

// Recover after interruptions (phone call, Siri, …)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && playing && ctx && ctx.state !== 'running') {
    ctx.resume();
    if (state.bgMode) sink.play().catch(() => {});
  }
  if (!document.hidden) renderSleep();
});

// ---------- sleep timer ----------
function armSleep() {
  if (!noise) return;
  if (state.sleep > 0) {
    sleepDeadline = Date.now() + state.sleep * 60000;
    noise.port.postMessage({ type: 'sleep', seconds: state.sleep * 60 });
  } else disarmSleep();
  renderSleep();
}
function disarmSleep() {
  sleepDeadline = null;
  if (noise) noise.port.postMessage({ type: 'sleep', seconds: 0 });
  renderSleep();
}
function renderSleep() {
  document.querySelectorAll('#sleep button').forEach((b) => b.classList.toggle('on', +b.dataset.min === state.sleep));
  const el = $('#sleepLeft');
  if (sleepDeadline && playing) {
    const s = Math.max(0, Math.round((sleepDeadline - Date.now()) / 1000));
    el.textContent = `stops in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else el.textContent = state.sleep ? `${state.sleep} min after start` : '';
}
setInterval(() => { if (!document.hidden && sleepDeadline) renderSleep(); }, 1000);

// ---------- media session (lock-screen / notification controls) ----------
const COLORS = [[232, 236, 241], [243, 155, 180], [176, 122, 82]]; // white, pink, brown
function colorName(c) {
  if (c < 0.04) return 'White';
  if (Math.abs(c - 0.5) < 0.04) return 'Pink';
  if (c > 0.96) return 'Brown';
  return c < 0.5 ? 'White–Pink' : 'Pink–Brown';
}
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${colorName(state.color)} noise`,
      artist: 'Noise',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch {}
}
if ('mediaSession' in navigator) {
  for (const [a, fn] of [['play', start], ['pause', stop], ['stop', stop]]) {
    try { navigator.mediaSession.setActionHandler(a, fn); } catch {}
  }
}

// ---------- UI ----------
function lerpColor(c) {
  const t = c * 2, i = Math.min(1, Math.floor(t)), f = t - i;
  return COLORS[i].map((v, k) => Math.round(v + (COLORS[i + 1][k] - v) * f));
}
function updateUI() {
  $('#play').classList.toggle('playing', playing);
  $('#play').setAttribute('aria-label', playing ? 'Stop' : 'Play');
  $('#play').setAttribute('aria-pressed', String(playing));
  updateStatus();
  updateMediaSession();
  renderSleep();
}
function updateStatus() {
  $('#status').textContent = playing ? (ctx && ctx.state !== 'running' ? 'interrupted — tap ▶' : 'playing') : 'stopped';
}
function renderColor() {
  const c = state.color;
  $('#color').value = c;
  $('#colorOut').textContent = `${colorName(c)} · ${c === 0 ? '0.0' : '−' + (6.02 * c).toFixed(1)} dB/oct`;
  const [r, g, b] = lerpColor(c);
  document.documentElement.style.setProperty('--accent', `rgb(${r},${g},${b})`);
  document.querySelectorAll('.presets button').forEach((btn) => btn.classList.toggle('on', Math.abs(+btn.dataset.color - c) < 0.005));
}
function renderSettings() {
  $('#stereo').checked = state.stereo;
  $('#bgMode').checked = state.bgMode;
}

function setColor(c, immediate = false) {
  state.color = c;
  noise && noise.port.postMessage({ type: 'color', value: c, immediate });
  renderColor(); drawSpectrum(); updateMediaSession(); save();
}
$('#color').addEventListener('input', (e) => setColor(+e.target.value));

// High cut (in EQ section): 1 = full bandwidth, 0 = band-limited to ~250 Hz
const speedCutoff = (s) => 20000 * Math.pow(250 / 20000, 1 - s);
function renderHighcut() {
  $('#highcut').value = state.highcut;
  const fc = speedCutoff(state.highcut);
  $('#highcutOut').textContent = state.highcut >= 0.995 ? 'off'
    : `above ${fc >= 1000 ? (fc / 1000).toFixed(1) + ' kHz' : Math.round(fc) + ' Hz'}`;
}
$('#highcut').addEventListener('input', (e) => {
  state.highcut = +e.target.value;
  noise && noise.port.postMessage({ type: 'highcut', value: state.highcut });
  renderHighcut(); drawSpectrum(); save();
});

// Pulses ("engine RPM"): rate 1 … 120 bursts/s on a log scale
const pulseHz = (p) => Math.pow(120, p);
function renderPulse() {
  $('#pulseRate').value = state.pulseRate;
  $('#pulseDepth').value = state.pulseDepth;
  const hz = pulseHz(state.pulseRate);
  $('#pulseRateOut').textContent = state.pulseDepth === 0 ? 'off — raise Strength'
    : `${hz < 10 ? hz.toFixed(1) : Math.round(hz)} pulses/s · ≈${Math.round(hz * 30 / 10) * 10} rpm`;
  $('#pulseDepthOut').textContent = state.pulseDepth === 0 ? 'off' : Math.round(state.pulseDepth * 100) + '%';
  $('#pulseCard').classList.toggle('dim', state.pulseDepth === 0);
}
$('#pulseRate').addEventListener('input', (e) => {
  state.pulseRate = +e.target.value;
  noise && noise.port.postMessage({ type: 'pulse', rate: pulseHz(state.pulseRate) });
  renderPulse(); save();
});
$('#pulseDepth').addEventListener('input', (e) => {
  state.pulseDepth = +e.target.value;
  noise && noise.port.postMessage({ type: 'pulse', depth: state.pulseDepth });
  renderPulse(); save();
});
document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => setColor(+b.dataset.color)));

$('#volume').value = state.volume;
const renderVol = () => ($('#volOut').textContent = Math.round(state.volume * 100) + '%');
$('#volume').addEventListener('input', (e) => {
  state.volume = +e.target.value; renderVol(); save();
  master && master.gain.setTargetAtTime(volGain(state.volume), ctx.currentTime, 0.05);
});

$('#play').addEventListener('click', () => (playing ? stop() : start()));

// EQ
const eqWrap = $('#eq');
BANDS.forEach((b, i) => {
  const row = document.createElement('div');
  row.className = 'eqrow';
  row.innerHTML = `<label for="eq${i}">${b.label}<small>Hz</small></label>
    <input type="range" id="eq${i}" min="${-EQ_RANGE}" max="${EQ_RANGE}" step="0.5" value="${state.eq[i]}">
    <output id="eqo${i}"></output>`;
  eqWrap.appendChild(row);
  const out = row.querySelector('output');
  const show = () => (out.textContent = (state.eq[i] > 0 ? '+' : '') + state.eq[i].toFixed(1) + ' dB');
  show();
  const input = row.querySelector('input');
  input.addEventListener('input', () => {
    state.eq[i] = +input.value; show(); save(); drawSpectrum();
    eqNodes[i] && eqNodes[i].gain.setTargetAtTime(state.eq[i], ctx.currentTime, 0.03);
    previewEq[i].gain.value = state.eq[i];
  });
  input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); });
});
$('#eqReset').addEventListener('click', () => {
  $('#highcut').value = 1; $('#highcut').dispatchEvent(new Event('input'));
  document.querySelectorAll('#eq input').forEach((inp) => { inp.value = 0; inp.dispatchEvent(new Event('input')); });
});

// Sleep timer
document.querySelectorAll('#sleep button').forEach((b) => b.addEventListener('click', () => {
  state.sleep = +b.dataset.min; save();
  if (playing) armSleep(); else renderSleep();
}));

// Settings
$('#stereo').addEventListener('change', (e) => {
  state.stereo = e.target.checked; save();
  noise && noise.port.postMessage({ type: 'stereo', value: state.stereo });
});
$('#bgMode').addEventListener('change', (e) => {
  state.bgMode = e.target.checked; save();
  if (!ctx) return;
  applyRouting();
  if (playing && state.bgMode) sink.play().catch(() => flash('Could not start media playback'));
});

let flashT;
function flash(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---------- spectrum preview ----------
// Uses its own offline context so the curve can be drawn before audio starts.
const pctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 128, 48000);
const previewEq = BANDS.map((b, i) => {
  const n = pctx.createBiquadFilter();
  n.type = b.type || 'peaking'; n.frequency.value = b.f;
  if (n.type === 'peaking') n.Q.value = 1.1;
  n.gain.value = state.eq[i];
  return n;
});
const NP = 160;
const freqs = new Float32Array(NP).map((_, i) => 20 * Math.pow(1000, i / (NP - 1)));
const mag = new Float32Array(NP), phase = new Float32Array(NP);

function colorDb(f, c) { // same pole/zero layout as the worklet (analog approximation)
  let m = 1;
  for (let k = 0; k < 10; k++) {
    const fp = 20 * 2 ** k, fz = fp * 2 ** c;
    m *= (f * f + fz * fz) / (f * f + fp * fp);
  }
  return 10 * Math.log10(m);
}

const canvas = $('#spectrum');
function drawSpectrum() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const yMin = -36, yMax = 48;
  const X = (f) => (Math.log(f / 20) / Math.log(1000)) * w;
  const Y = (db) => h - ((Math.max(yMin, Math.min(yMax, db)) - yMin) / (yMax - yMin)) * h;

  // grid
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue('--grid'); g.lineWidth = 1;
  g.fillStyle = css.getPropertyValue('--muted'); g.font = '10px system-ui, sans-serif';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    g.beginPath(); g.moveTo(X(f) + 0.5, 0); g.lineTo(X(f) + 0.5, h); g.stroke();
    g.fillText(f >= 1000 ? f / 1000 + 'k' : f, X(f) + 3, h - 4);
  }
  for (let d = -24; d <= 36; d += 12) {
    g.beginPath(); g.moveTo(0, Y(d) + 0.5); g.lineTo(w, Y(d) + 0.5); g.stroke();
    g.fillText((d > 0 ? '+' : '') + d + ' dB', 3, Y(d) - 3);
  }

  // curve: color slope (0 dB at 1 kHz) + EQ
  const eqDb = new Float32Array(NP);
  previewEq.forEach((n) => {
    n.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < NP; i++) eqDb[i] += 20 * Math.log10(mag[i] || 1e-9);
  });
  const ref = colorDb(1000, state.color);
  const accent = css.getPropertyValue('--accent');
  g.beginPath();
  for (let i = 0; i < NP; i++) {
    const fc = speedCutoff(state.highcut);
    const lp = state.highcut >= 0.995 ? 0 : -10 * Math.log10(1 + (freqs[i] / fc) ** 8);
    const db = colorDb(freqs[i], state.color) - ref + eqDb[i] + lp;
    i ? g.lineTo(X(freqs[i]), Y(db)) : g.moveTo(X(freqs[i]), Y(db));
  }
  g.strokeStyle = accent; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, accent.replace('rgb', 'rgba').replace(')', ',0.35)'));
  grad.addColorStop(1, accent.replace('rgb', 'rgba').replace(')', ',0)'));
  g.fillStyle = grad; g.fill();
}
window.addEventListener('resize', drawSpectrum);

// ---------- init ----------
renderColor(); renderHighcut(); renderPulse(); renderVol(); renderSettings(); updateUI(); drawSpectrum();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
