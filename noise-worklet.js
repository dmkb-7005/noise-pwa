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
    this.gridW = new Float64Array(GRID);
    this.pRef = 0;
    for (let i = 0; i < GRID; i++) {
      const f = F0 * Math.pow(fMax / F0, i / (GRID - 1));
      this.gridCos[i] = Math.cos((2 * Math.PI * f) / sampleRate);
      this.gridW[i] = f; // equal steps in log f ⇒ weight by f for per-Hz power
      this.pRef += f;
    }

    this.target = 0.5;
    this.color = 0.5;
    this.computeCoeffs(this.color);

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'color':
        this.target = Math.min(1, Math.max(0, +m.value));
        if (m.immediate) { this.color = this.target; this.computeCoeffs(this.color); }
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

  computeCoeffs(c) {
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
    // Normalize total power (20 Hz–20 kHz) to match white noise
    let p = 0;
    for (let i = 0; i < GRID; i++) {
      const cw = this.gridCos[i];
      let m = 1;
      for (let k = 0; k < SECTIONS; k++) {
        const b0 = this.b0[k], b1 = this.b1[k], a1 = this.a1[k];
        m *= (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cw) / (1 + a1 * a1 + 2 * a1 * cw);
      }
      p += this.gridW[i] * m;
    }
    // uniform [-1, 1] has RMS 1/√3
    this.norm = Math.sqrt(this.pRef / p) * TARGET_RMS * Math.sqrt(3);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;

    // Glide toward the requested color (no zipper noise)
    if (this.color !== this.target) {
      const d = this.target - this.color;
      this.color = Math.abs(d) < 0.002 ? this.target : this.color + d * 0.08;
      this.computeCoeffs(this.color);
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

    const { b0, b1, a1 } = this;
    for (let ch = 0; ch < out.length; ch++) {
      const o = out[ch];
      if (ch > 0 && !this.stereo) { o.set(out[0]); continue; }
      const x1 = this.x1[ch & 1], y1 = this.y1[ch & 1];
      for (let i = 0; i < n; i++) {
        let s = Math.random() * 2 - 1;
        for (let k = 0; k < SECTIONS; k++) {
          const y = b0[k] * s + b1[k] * x1[k] - a1[k] * y1[k];
          x1[k] = s;
          y1[k] = y;
          s = y;
        }
        o[i] = s * env[i];
      }
    }
    return true;
  }
}

registerProcessor('noise', NoiseProcessor);
