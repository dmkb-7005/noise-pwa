# Noise — live colored-noise PWA

White → pink → brown noise, generated sample-by-sample (never a loop), with an 8-band EQ,
sleep timer, stereo/mono, offline support and lock-screen controls.

## Files
| File | Purpose |
|---|---|
| `noise-worklet.js` | DSP: random samples → cascade of 10 octave-spaced pole/zero filters. One "color" value (0–1) sets the slope continuously: 0 = white (0 dB/oct), 0.5 = pink (−3), 1 = brown (−6). Power-normalized so loudness stays steady. Sleep timer + fades run here, sample-accurate. |
| `app.js` | Audio graph (worklet → 18 Hz HP → 8 EQ bands → limiter → volume), UI, Media Session, settings in localStorage. |
| `sw.js` | Offline cache. **Bump `VERSION` after every change**, or phones keep the old copy. |
| `index.html`, `style.css`, `manifest.webmanifest`, `icons/` | App shell. |

## Background playback
In "Background mode" (on by default), the audio is routed through a `MediaStream` into an
`<audio>` element instead of straight to the speakers. The browser then treats it as media
playback: it shows a notification / lock-screen control and keeps running with the screen off.
- **Android (Chrome):** works reliably. If a battery saver kills it, set Chrome's battery usage to "Unrestricted".
- **iOS (Safari, Home-Screen app):** uses `navigator.audioSession.type = "playback"` (iOS 16.4+). Background audio
  for web apps on iOS works on recent versions but is less dependable than on Android; test on your phone.
If background mode can't start, the app falls back to direct output automatically. You can toggle it in Settings.

## Hosting (must be HTTPS)
Any static host works. Easiest: **GitHub Pages**: create a repo, upload these files, Settings → Pages →
deploy from `main` / root. Or drag the folder onto **Netlify Drop** (app.netlify.com/drop).
Then open the URL on your phone → "Add to Home screen" / "Install app".

Local test: `python3 -m http.server 8000` → http://localhost:8000 (localhost counts as secure).
