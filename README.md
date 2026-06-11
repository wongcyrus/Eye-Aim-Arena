# 👁️ Eye Aim Arena

A fully client-side, real-time shooting game controlled entirely by **eye gaze** — no backend, no server, no plugins.

## 🎮 How to Play

1. Open `index.html` in a modern browser (Chrome / Edge recommended).
2. Allow camera access when prompted.
3. Complete the **9-point calibration** (look at each dot while it fills).
4. Choose a game mode and play!

### Settings

From the main menu, open **⚙️ Settings** to:

- choose which webcam to use (useful when multiple cameras are connected)
- invert left/right aiming
- invert up/down aiming

### Controls

| Action | Primary | Fallback |
|--------|---------|----------|
| Aim | Eye gaze | — |
| Shoot | Blink | `Space` / click |
| Pause | — | `P` or `Esc` |

## 🕹️ Game Modes

| Mode | Description |
|------|-------------|
| **Time Attack** | 60 seconds — hit as many targets as possible |
| **Survival** | Targets get faster; lose a life every time one escapes |
| **Precision** | 20 rounds with smaller targets; score weighted by accuracy |

## 🛠️ Technology

| Component | Implementation |
|-----------|---------------|
| Eye tracking | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (iris landmarks 468 & 473) |
| Gaze smoothing | Exponential moving average (EMA) |
| Calibration | 9-point least-squares affine transform |
| Blink detection | Eye Aspect Ratio (EAR) with debounce |
| Rendering | HTML5 Canvas 2D |
| Audio | Web Audio API (no external files) |
| Persistence | `localStorage` (scores & calibration) |

## 📁 File Structure

```
index.html          ← entry point
css/
  style.css         ← dark sci-fi theme
js/
  eyetracker.js     ← MediaPipe wrapper, gaze + blink
  calibration.js    ← 9-point calibration & affine solve
  game.js           ← game loop, targets, modes, scoring
```

## 🚀 Deployment

The game is a static site — just serve the repository root with any static file server or host on **GitHub Pages**:

```bash
# Local preview (Python)
python3 -m http.server 8080
# then open http://localhost:8080
```

> **Note:** The MediaPipe WASM files and face-landmark model are loaded from CDN on first run; an internet connection is required for loading (gameplay is then fully local).

## ✨ Features

- Real-time iris gaze tracking (30–60 FPS)
- Blink-to-shoot with debounce to prevent accidental firing
- 9-point affine-transform calibration (persisted across sessions)
- Settings screen for webcam selection and aim inversion
- Three distinct game modes with adaptive difficulty
- Moving targets: static, linear (bouncing), and drifting
- Particle hit effects and reticle animations
- Accuracy tracking and top-10 local leaderboard
- Keyboard / click fallback for accessibility
- Mirrored camera feed as subtle AR background
