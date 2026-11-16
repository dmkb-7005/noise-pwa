// noise-worklet.js — real-time colored noise generator (AudioWorklet)
//
// Every sample is freshly generated random noise; nothing is looped.
//
// "color" c in [0, 1] sets the spectral slope:  power ∝ 1 / f^(2c)
//   c = 0    → white  (  0 dB/octave, flat)
//   c = 0.5  → pink   ( -3 dB/octave)
//   c = 1    → brown  ( -6 dB/octave)
// and every value in between.
//
// How: white noise is fed through a cascade of first-order pole/zero filters,
// one per octave starting at 20 Hz. Each zero sits 2^c above its pole, so each
// octave contributes an average tilt of -6·c dB. c = 0 makes every zero cancel
// its pole (flat). c = 1 makes each zero cancel the next pole (pure -6 dB/oct).
// The output is power-normalized so the overall level stays roughly constant
// while you sweep the color.

const F0 = 20;            // first pole (Hz)
const SECTIONS = 10;      // octaves covered: 20 Hz … 20 kHz
const TARGET_RMS = 0.12;  // leaves headroom for EQ boosts
const GRID = 96;          // frequency points used for normalization
const MIN_FC = 250;       // slowest "speed": noise band-limited to ~250 Hz
const BUTTER_Q = [0.5412, 1.3066]; // 4th-order Butterworth low-pass = 2 biquads

// "speed" s in [0, 1] works like playback speed of the noise: how fast the
// waveform is allowed to change. s = 1 → full bandwidth (fast, fizzy);
// lower s → everything above a cutoff (20 kHz … 250 Hz, log scale) is removed
// (slow, smooth churn). Color tilt is kept; loudness is re-normalized.

class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.b0 = new Float64Array(SECTIONS);
    this.b1 = new Float64Array(SECTIONS);
    this.a1 = new Float64Array(SECTIONS);
    this.x1 = [new Float64Array(SECTIONS), new Float64Array(SECTIONS)];
    this.y1 = [new Float64Array(SECTIONS), new Float64Array(SECTIONS)];
    this.norm = 1;
    this.stereo = true;

    // speed low-pass (transposed direct form II), per section and channel
    this.lb0 = new Float64Array(2); this.lb1 = new Float64Array(2);
    this.la1 = new Float64Array(2); this.la2 = new Float64Array(2);
    this.lz1 = [new Float64Array(2), new Float64Array(2)];
    this.lz2 = [new Float64Array(2), new Float64Array(2)];
    this.lpOn = false;
    this.speed = this.speedTarget = 1;

    // Fade envelope (start/stop without clicks)
    this.level = 0;
    this.levelTarget = 0;
    this.levelStep = 1 / (sampleRate * 1.5);

    // Sleep timer, counted in samples, so it works even if the main
    // thread is throttled while the screen is off.
    this.sleepLeft = -1;
    this.sleepFade = 0;
    this.env = new Float32Array(128);

    // Log-spaced frequency grid for power normalization
    const fMax = Math.min(20000, sampleRate * 0.49);
    this.gridCos = new Float64Array(GRID);
    this.gridCos2 = new Float64Array(GRID);
    this.gridW = new Float64Array(GRID);
    this.pRef = 0;
    for (let i = 0; i < GRID; i++) {
      const f = F0 * Math.pow(fMax / F0, i / (GRID - 1));
      this.gridCos[i] = Math.cos((2 * Math.PI * f) / sampleRate);
      this.gridCos2[i] = Math.cos((4 * Math.PI * f) / sampleRate);
      this.gridW[i] = f; // equal steps in log f ⇒ weight by f for per-Hz power
      this.pRef += f;
    }

    this.target = 0.5;
    this.color = 0.5;
    this.computeCoeffs();

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'color':
        this.target = Math.min(1, Math.max(0, +m.value));
        if (m.immediate) { this.color = this.target; this.computeCoeffs(); }
        break;
      case 'speed':
        this.speedTarget = Math.min(1, Math.max(0, +m.value));
        if (m.immediate) { this.speed = this.speedTarget; this.computeCoeffs(); }
        break;
      case 'stereo':
        this.stereo = !!m.value;
        break;
      case 'fade':
        this.levelTarget = m.target;
        this.levelStep = 1 / (sampleRate * Math.max(0.01, m.seconds));
        break;
      case 'sleep':
        if (m.seconds > 0) {
          this.sleepLeft = Math.round(m.seconds * sampleRate);
          this.sleepFade = Math.min(this.sleepLeft, Math.round(60 * sampleRate)); // 60 s fade-out
        } else {
          this.sleepLeft = -1;
        }
        break;
    }
  }

  computeCoeffs() {
    const c = this.color;
    const fs = sampleRate;
    const lim = fs * 0.45;
    const K = 2 * fs;
    for (let k = 0; k < SECTIONS; k++) {
      const fp = Math.min(F0 * Math.pow(2, k), lim);
      const fz = Math.min(F0 * Math.pow(2, k + c), lim);
      // pre-warped bilinear transform of H(s) = (s + wz) / (s + wp)
      const wp = K * Math.tan((Math.PI * fp) / fs);
      const wz = K * Math.tan((Math.PI * fz) / fs);
      const d = K + wp;
      this.b0[k] = (K + wz) / d;
      this.b1[k] = (wz - K) / d;
      this.a1[k] = (wp - K) / d;
    }
    // Speed → low-pass cutoff
    const fc = 20000 * Math.pow(MIN_FC / 20000, 1 - this.speed);
    this.lpOn = fc < fs * 0.45;
    if (this.lpOn) {
      const w0 = (2 * Math.PI * fc) / fs, cw = Math.cos(w0), al0 = Math.sin(w0) / 2;
      for (let j = 0; j < 2; j++) {
        const al = al0 / BUTTER_Q[j], a0 = 1 + al;
        this.lb0[j] = (1 - cw) / 2 / a0;
        this.lb1[j] = (1 - cw) / a0;
        this.la1[j] = (-2 * cw) / a0;
        this.la2[j] = (1 - al) / a0;
      }
    }
    // Normalize total power (20 Hz–20 kHz) to match white noise
    let p = 0;
    for (let i = 0; i < GRID; i++) {
      const cw = this.gridCos[i];
      let m = 1;
      for (let k = 0; k < SECTIONS; k++) {
        const b0 = this.b0[k], b1 = this.b1[k], a1 = this.a1[k];
        m *= (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cw) / (1 + a1 * a1 + 2 * a1 * cw);
      }
      if (this.lpOn) {
        for (let j = 0; j < 2; j++) {
          const b0 = this.lb0[j], b1 = this.lb1[j], a1 = this.la1[j], a2 = this.la2[j];
          const num = (b1 + 2 * b0 * cw) ** 2;
          const den = 1 + a1 * a1 + a2 * a2 + 2 * (a1 + a1 * a2) * cw + 2 * a2 * this.gridCos2[i];
          m *= num / den;
        }
      }
      p += this.gridW[i] * m;
    }
    // uniform [-1, 1] has RMS 1/√3
    this.norm = Math.sqrt(this.pRef / p) * TARGET_RMS * Math.sqrt(3);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;

    // Glide toward the requested color / speed (no zipper noise)
    if (this.color !== this.target || this.speed !== this.speedTarget) {
      const d = this.target - this.color;
      this.color = Math.abs(d) < 0.002 ? this.target : this.color + d * 0.08;
      const ds = this.speedTarget - this.speed;
      this.speed = Math.abs(ds) < 0.002 ? this.speedTarget : this.speed + ds * 0.08;
      this.computeCoeffs();
    }

    // Envelope: fade × sleep fade-out
    if (this.env.length < n) this.env = new Float32Array(n);
    const env = this.env;
    let finishedSleep = false;
    for (let i = 0; i < n; i++) {
      if (this.level < this.levelTarget) this.level = Math.min(this.levelTarget, this.level + this.levelStep);
      else if (this.level > this.levelTarget) this.level = Math.max(this.levelTarget, this.level - this.levelStep);
      let g = this.level * this.level;
      if (this.sleepLeft >= 0) {
        if (this.sleepLeft === 0) { g = 0; finishedSleep = true; }
        else {
          if (this.sleepLeft < this.sleepFade) { const s = this.sleepLeft / this.sleepFade; g *= s * s; }
          this.sleepLeft--;
        }
      }
      env[i] = g * this.norm;
    }
    if (finishedSleep) {
      this.sleepLeft = -1;
      this.level = this.levelTarget = 0;
      this.port.postMessage({ type: 'sleepDone' });
    }

    const { b0, b1, a1, lb0, lb1, la1, la2, lpOn } = this;
    for (let ch = 0; ch < out.length; ch++) {
      const o = out[ch];
      if (ch > 0 && !this.stereo) { o.set(out[0]); continue; }
      const x1 = this.x1[ch & 1], y1 = this.y1[ch & 1];
      const z1 = this.lz1[ch & 1], z2 = this.lz2[ch & 1];
      for (let i = 0; i < n; i++) {
        let s = Math.random() * 2 - 1;
        for (let k = 0; k < SECTIONS; k++) {
          const y = b0[k] * s + b1[k] * x1[k] - a1[k] * y1[k];
          x1[k] = s;
          y1[k] = y;
          s = y;
        }
        if (lpOn) {
          for (let j = 0; j < 2; j++) {
            const y = lb0[j] * s + z1[j];
            z1[j] = lb1[j] * s - la1[j] * y + z2[j];
            z2[j] = lb0[j] * s - la2[j] * y;
            s = y;
          }
        }
        o[i] = s * env[i];
      }
    }
    return true;
  }
}

registerProcessor('noise', NoiseProcessor);
