/**
 * game.js  —  Eye Aim Arena main game module
 *
 * Imports EyeTracker and CalibrationSystem, manages the full game
 * lifecycle: loading → calibration → menu → playing → game-over.
 *
 * Three game modes:
 *   Time Attack  — 60 s, maximise score
 *   Survival     — ever-harder waves, limited lives (missed targets)
 *   Precision    — smaller targets, accuracy-weighted score, 20 rounds
 */

import { EyeTracker }       from './eyetracker.js';
import { CalibrationSystem } from './calibration.js';

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

const STATES = Object.freeze({
    LOADING:     'loading',
    CALIBRATION: 'calibration',
    MENU:        'menu',
    PLAYING:     'playing',
    PAUSED:      'paused',
    GAMEOVER:    'gameover',
});

const MODE = Object.freeze({
    TIME_ATTACK: 'time_attack',
    SURVIVAL:    'survival',
    PRECISION:   'precision',
});

// Target visual size ranges (canvas pixels, scaled below)
const SIZE = { LARGE: 48, MEDIUM: 32, SMALL: 20 };

// Velocity in normalised coords per millisecond
const SPEED = { SLOW: 0.00008, NORMAL: 0.00014, FAST: 0.00022 };

const PALETTE = {
    LARGE:  '#ff9900',
    MEDIUM: '#ff4444',
    SMALL:  '#cc44ff',
};

const LS_SCORES = 'eyeAimArena_scores';
const MAX_SCORES = 10;

// ─────────────────────────────────────────────────────────────────────
//  Audio (Web Audio API — no external files)
// ─────────────────────────────────────────────────────────────────────

class GameAudio {
    constructor() {
        this._ctx = null;
    }

    _ensureCtx() {
        if (!this._ctx) {
            try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch { /* Safari might reject */ }
        }
        if (this._ctx?.state === 'suspended') this._ctx.resume();
    }

    _tone(freq, duration, type = 'sine', gain = 0.25, freqEnd = null) {
        this._ensureCtx();
        if (!this._ctx) return;
        const now  = this._ctx.currentTime;
        const osc  = this._ctx.createOscillator();
        const vol  = this._ctx.createGain();
        osc.connect(vol);
        vol.connect(this._ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);
        vol.gain.setValueAtTime(gain, now);
        vol.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        osc.start(now);
        osc.stop(now + duration + 0.01);
    }

    playHit(score)  { this._tone(score > 150 ? 1200 : 800, 0.12, 'sine', 0.28, 400); }
    playMiss()      { this._tone(200, 0.18, 'sawtooth', 0.18, 80); }
    playBlink()     { this._tone(600, 0.06, 'square', 0.15); }
    playLevelUp()   { this._tone(440, 0.08, 'sine', 0.2, 880); }
    playGameOver()  { this._tone(300, 0.4, 'sawtooth', 0.3, 100); }
    playCountdown() { this._tone(520, 0.1, 'sine', 0.18); }
}

// ─────────────────────────────────────────────────────────────────────
//  Particle
// ─────────────────────────────────────────────────────────────────────

class Particle {
    constructor(x, y, color) {
        this.x     = x;
        this.y     = y;
        this.color = color;
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.5 + Math.random() * 3;
        this.vx    = Math.cos(angle) * speed;
        this.vy    = Math.sin(angle) * speed;
        this.life  = 1.0;
        this.decay = 0.03 + Math.random() * 0.03;
        this.size  = 3 + Math.random() * 4;
    }

    update() {
        this.x    += this.vx;
        this.y    += this.vy;
        this.vy   += 0.08;   // gravity
        this.life -= this.decay;
    }

    draw(ctx) {
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.fillStyle   = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    get dead() { return this.life <= 0; }
}

// ─────────────────────────────────────────────────────────────────────
//  Target
// ─────────────────────────────────────────────────────────────────────

class Target {
    /**
     * @param {{ x, y, radius, type, vx, vy, color, baseScore, lifetime }} cfg
     */
    constructor(cfg) {
        this.id        = Math.random().toString(36).slice(2);
        this.x         = cfg.x;       // normalised [0,1]
        this.y         = cfg.y;
        this.radius    = cfg.radius;  // canvas pixels
        this.type      = cfg.type;    // 'static'|'linear'|'drift'
        this.vx        = cfg.vx ?? 0;
        this.vy        = cfg.vy ?? 0;
        this.color     = cfg.color;
        this.baseScore = cfg.baseScore;
        this.lifetime  = cfg.lifetime;
        this.createdAt = performance.now();

        this.hit     = false;
        this.hitTime = 0;
        this.expired = false;
    }

    /** @param {number} dt — milliseconds since last frame */
    update(dt) {
        if (this.hit) return;
        const age = performance.now() - this.createdAt;
        if (age >= this.lifetime) { this.expired = true; return; }

        if (this.type === 'linear') {
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            if (this.x < 0.04 || this.x > 0.96) { this.vx *= -1; this.x = Math.max(0.04, Math.min(0.96, this.x)); }
            if (this.y < 0.06 || this.y > 0.96) { this.vy *= -1; this.y = Math.max(0.06, Math.min(0.96, this.y)); }
        } else if (this.type === 'drift') {
            this.vx += (Math.random() - 0.5) * 0.00008 * dt;
            this.vy += (Math.random() - 0.5) * 0.00008 * dt;
            const maxV = SPEED.SLOW;
            this.vx = Math.max(-maxV, Math.min(maxV, this.vx));
            this.vy = Math.max(-maxV, Math.min(maxV, this.vy));
            this.x  = Math.max(0.04, Math.min(0.96, this.x + this.vx * dt));
            this.y  = Math.max(0.06, Math.min(0.96, this.y + this.vy * dt));
        }
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} W  canvas width
     * @param {number} H  canvas height
     */
    draw(ctx, W, H) {
        const px      = this.x * W;
        const py      = this.y * H;
        const r       = this.radius;
        const age     = performance.now() - this.createdAt;
        const lifeRat = Math.min(age / this.lifetime, 1);

        // Hit pop animation
        if (this.hit) {
            const hitAge = performance.now() - this.hitTime;
            if (hitAge < 250) {
                const t = hitAge / 250;
                ctx.globalAlpha = 1 - t;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth   = 4;
                ctx.beginPath();
                ctx.arc(px, py, r * (1 + t * 1.5), 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            return;
        }

        // Fade-in / fade-out alpha
        let alpha = 1;
        if (lifeRat < 0.1)  alpha = lifeRat / 0.1;
        if (lifeRat > 0.78) alpha = (1 - lifeRat) / 0.22;
        ctx.globalAlpha = Math.max(0.05, alpha);

        // Outer glow
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r * 1.6);
        grad.addColorStop(0,   this.color + 'aa');
        grad.addColorStop(0.5, this.color + '44');
        grad.addColorStop(1,   this.color + '00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r * 1.6, 0, Math.PI * 2);
        ctx.fill();

        // Main body
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();

        // Inner rings
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.arc(px, py, r * 0.62, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(px, py, r * 0.3, 0, Math.PI * 2);
        ctx.fill();

        // Danger flash near expiry
        if (lifeRat > 0.72) {
            const flash = Math.sin((lifeRat - 0.72) / 0.28 * Math.PI * 10) > 0;
            if (flash) {
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth   = 3;
                ctx.beginPath();
                ctx.arc(px, py, r + 5, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.globalAlpha = 1;
    }

    /**
     * Check whether a normalised gaze position is inside the target.
     * @param {number} gx  normalised [0,1]
     * @param {number} gy
     * @param {number} W   canvas width
     * @param {number} H   canvas height
     */
    containsGaze(gx, gy, W, H) {
        const dx = (gx - this.x) * W;
        const dy = (gy - this.y) * H;
        return Math.hypot(dx, dy) <= this.radius;
    }

    /**
     * Register a hit. Returns points earned (includes accuracy bonus).
     */
    registerHit(gx, gy, W, H) {
        if (this.hit) return 0;
        this.hit     = true;
        this.hitTime = performance.now();

        const dx   = (gx - this.x) * W;
        const dy   = (gy - this.y) * H;
        const dist = Math.hypot(dx, dy);
        const acc  = Math.max(0, 1 - dist / this.radius);     // 0..1
        return Math.round(this.baseScore * (1 + acc));         // up to 2×
    }
}

// ─────────────────────────────────────────────────────────────────────
//  Target factory
// ─────────────────────────────────────────────────────────────────────

function randomEdge() { return Math.random() * 0.82 + 0.09; }

function createTarget(difficulty = 1, mode = MODE.TIME_ATTACK) {
    const rand = Math.random();

    let radius, color, baseScore, type, lifetime;

    // Size tier (adjusted by mode)
    if (mode === MODE.PRECISION || rand < 0.25 * difficulty) {
        radius = SIZE.SMALL;  color = PALETTE.SMALL;  baseScore = 200;
    } else if (rand < 0.6) {
        radius = SIZE.MEDIUM; color = PALETTE.MEDIUM; baseScore = 120;
    } else {
        radius = SIZE.LARGE;  color = PALETTE.LARGE;  baseScore = 70;
    }

    if (mode === MODE.PRECISION) {
        radius    = Math.round(radius * 0.65);
        baseScore = Math.round(baseScore * 1.4);
    }

    lifetime = Math.max(2000, 5000 - difficulty * 400);

    // Movement type
    const typeRoll = Math.random();
    if (typeRoll < 0.35) {
        type = 'static';
    } else if (typeRoll < 0.70) {
        type = 'linear';
    } else {
        type = 'drift';
    }

    const angle = Math.random() * Math.PI * 2;
    const speed = SPEED.SLOW + Math.random() * (SPEED.NORMAL * difficulty - SPEED.SLOW);

    return new Target({
        x:  randomEdge(),
        y:  0.08 + Math.random() * 0.84,
        radius,
        color,
        baseScore,
        type,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        lifetime,
    });
}

// ─────────────────────────────────────────────────────────────────────
//  Leaderboard (localStorage)
// ─────────────────────────────────────────────────────────────────────

function loadScores() {
    try {
        return JSON.parse(localStorage.getItem(LS_SCORES)) || [];
    } catch { return []; }
}

function saveScore(entry) {
    const scores = loadScores();
    scores.push(entry);
    scores.sort((a, b) => b.score - a.score);
    scores.splice(MAX_SCORES);
    try { localStorage.setItem(LS_SCORES, JSON.stringify(scores)); } catch { /* quota */ }
    return scores;
}

function modeLabel(m) {
    return { [MODE.TIME_ATTACK]: 'Time Attack', [MODE.SURVIVAL]: 'Survival', [MODE.PRECISION]: 'Precision' }[m] ?? m;
}

// ─────────────────────────────────────────────────────────────────────
//  Game
// ─────────────────────────────────────────────────────────────────────

class Game {
    constructor() {
        // DOM
        this.canvas   = document.getElementById('gameCanvas');
        this.ctx      = this.canvas.getContext('2d');
        this.video    = document.getElementById('webcamVideo');

        // Core systems
        this.tracker  = new EyeTracker();
        this.calibration = new CalibrationSystem(this.canvas, this.tracker);
        this.audio    = new GameAudio();

        // State
        this.state    = STATES.LOADING;
        this.mode     = null;

        // Gaze (screen normalised [0,1])
        this.gazeX = 0.5;
        this.gazeY = 0.5;
        this._smoothGazeX = 0.5;
        this._smoothGazeY = 0.5;
        this._gazeAlpha   = 0.2;   // secondary EMA after calibration

        // Game session
        this.targets    = [];
        this.particles  = [];
        this.score      = 0;
        this.shots      = 0;
        this.hits       = 0;
        this.lives      = 5;       // Survival only
        this.precisionRounds = 0;  // Precision only
        this.precisionTotal  = 20;
        this.startTime  = 0;
        this.gameDuration = 60_000; // ms — Time Attack
        this.difficulty = 1;
        this.lastSpawnTime = 0;
        this.spawnInterval = 2500;  // ms

        // Reticle visual state
        this._reticlePulse = 0;
        this._lastShotTime = -9999;
        this._onTarget     = false;

        // Bind event handlers
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onResize  = this._onResize.bind(this);
    }

    // ── Bootstrap ─────────────────────────────────────────────────

    async start() {
        this._resize();
        window.addEventListener('resize', this._onResize);
        window.addEventListener('keydown', this._onKeyDown);

        this._showScreen('loadingScreen');
        this._setProgress(5, 'Requesting camera…');

        // Webcam
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
                audio: false,
            });
            this.video.srcObject = stream;
            await new Promise((res, rej) => {
                this.video.onloadeddata = res;
                this.video.onerror = rej;
                this.video.play();
            });
        } catch (err) {
            this._showError('Camera access denied or unavailable.', err.message);
            return;
        }

        this._setProgress(20, 'Loading MediaPipe…');

        // Eye tracker init
        try {
            await this.tracker.init(msg => this._setProgress(null, msg));
        } catch (err) {
            this._showError('Failed to load the face-tracking model.', err.message);
            return;
        }

        // Register blink → shoot
        this.tracker.onBlink(() => this._shoot());

        this._setProgress(100, 'Ready!');
        await _sleep(400);

        // If we have saved calibration go straight to menu
        if (this.calibration.isCalibrated()) {
            this._goToMenu();
        } else {
            this._startCalibration();
        }

        // Kick off the render loop
        requestAnimationFrame(ts => this._loop(ts));
    }

    // ── Main loop ─────────────────────────────────────────────────

    _loop(timestamp) {
        requestAnimationFrame(ts => this._loop(ts));

        const dt = Math.min(50, timestamp - (this._lastTs ?? timestamp));
        this._lastTs = timestamp;

        // Eye tracking (every frame)
        const tracking = this.tracker.processFrame(this.video, timestamp);
        if (tracking?.faceDetected) {
            // Apply calibration transform
            const cal = this.calibration.applyTransform(tracking.gazeX, tracking.gazeY);
            // Secondary smoothing
            this._smoothGazeX += (cal.x - this._smoothGazeX) * this._gazeAlpha;
            this._smoothGazeY += (cal.y - this._smoothGazeY) * this._gazeAlpha;
            this.gazeX = this._smoothGazeX;
            this.gazeY = this._smoothGazeY;
        }

        // State-specific update
        switch (this.state) {
            case STATES.CALIBRATION:
                this.calibration.update(timestamp);
                break;
            case STATES.PLAYING:
                this._updateGame(timestamp, dt);
                break;
        }

        // Render
        this._render(timestamp);
    }

    // ── Game update ───────────────────────────────────────────────

    _updateGame(timestamp, dt) {
        const elapsed = timestamp - this.startTime;

        // ---- Difficulty ramp ----
        if (this.mode === MODE.TIME_ATTACK) {
            this.difficulty = 1 + elapsed / 20_000;
        } else if (this.mode === MODE.SURVIVAL) {
            const level = Math.floor(elapsed / 15_000);
            this.difficulty = 1 + level * 0.5;
            this.spawnInterval = Math.max(1000, 2500 - level * 200);
        } else if (this.mode === MODE.PRECISION) {
            this.difficulty = 1 + this.precisionRounds / 8;
        }

        // ---- Time Attack end ----
        if (this.mode === MODE.TIME_ATTACK && elapsed >= this.gameDuration) {
            this._endGame();
            return;
        }

        // ---- Spawn targets ----
        const maxActive = this.mode === MODE.SURVIVAL
            ? Math.min(8, 3 + Math.floor(this.difficulty))
            : this.mode === MODE.PRECISION ? 1 : 5;

        if (this.targets.length < maxActive &&
            timestamp - this.lastSpawnTime >= this.spawnInterval) {
            if (this.mode !== MODE.PRECISION || this.precisionRounds < this.precisionTotal) {
                this.targets.push(createTarget(this.difficulty, this.mode));
                this.lastSpawnTime = timestamp;
            }
        }

        // ---- Update targets ----
        this._onTarget = false;
        for (const t of this.targets) {
            t.update(dt);
            if (!t.hit && t.containsGaze(this.gazeX, this.gazeY,
                    this.canvas.width, this.canvas.height)) {
                this._onTarget = true;
            }
        }

        // ---- Remove dead targets, count unhit expiries ----
        let missedCount = 0;
        this.targets = this.targets.filter(t => {
            if (t.expired && !t.hit) {
                missedCount++;
                // In Precision mode a missed target still uses up a round
                if (this.mode === MODE.PRECISION) this.precisionRounds++;
                return false;           // remove immediately
            }
            if (t.hit) {
                return (performance.now() - t.hitTime) < 300;  // brief death anim
            }
            return true;
        });

        // Survival lives penalty for missed targets
        if (this.mode === MODE.SURVIVAL && missedCount > 0) {
            this.lives = Math.max(0, this.lives - missedCount);
            this.audio.playMiss();
            this._updateLivesBar();
            if (this.lives <= 0) {
                this._endGame();
                return;
            }
        }

        // Precision: end after all rounds done and targets cleared
        if (this.mode === MODE.PRECISION &&
            this.precisionRounds >= this.precisionTotal &&
            this.targets.length === 0) {
            this._endGame();
            return;
        }

        // ---- Update particles ----
        this.particles = this.particles.filter(p => { p.update(); return !p.dead; });

        // ---- Pulse ----
        this._reticlePulse += dt * 0.004;
    }

    // ── Shooting ──────────────────────────────────────────────────

    _shoot() {
        if (this.state !== STATES.PLAYING) return;
        this.shots++;
        this._lastShotTime = performance.now();
        this.audio.playBlink();

        const W = this.canvas.width;
        const H = this.canvas.height;
        let hit = false;

        for (const t of this.targets) {
            if (!t.hit && !t.expired && t.containsGaze(this.gazeX, this.gazeY, W, H)) {
                const pts = t.registerHit(this.gazeX, this.gazeY, W, H);
                this.score += pts;
                this.hits++;
                hit = true;

                if (this.mode === MODE.PRECISION) this.precisionRounds++;

                // Spawn particles
                const px = t.x * W;
                const py = t.y * H;
                for (let i = 0; i < 14; i++) {
                    this.particles.push(new Particle(px, py, t.color));
                }

                this.audio.playHit(pts);
                this._updateHUD();
                break;  // one target per blink
            }
        }

        if (!hit) {
            // miss flash on reticle handled in render
        }
    }

    // ── Rendering ─────────────────────────────────────────────────

    _render(timestamp) {
        const ctx = this.ctx;
        const W   = this.canvas.width;
        const H   = this.canvas.height;

        // --- Background ---
        ctx.fillStyle = '#050a19';
        ctx.fillRect(0, 0, W, H);

        // Draw mirrored webcam feed (subtle, darkened)
        if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(this.video, 0, 0, W, H);
            ctx.restore();
            ctx.globalAlpha = 1;
        }

        // Grid lines (decorative)
        this._drawGrid(ctx, W, H);

        // --- Calibration overlay ---
        if (this.state === STATES.CALIBRATION) {
            this.calibration.render(ctx, timestamp);
            // Show raw gaze marker during calibration
            this._drawRawGazeMarker(ctx, W, H);
            return;
        }

        // --- Targets ---
        if (this.state === STATES.PLAYING || this.state === STATES.PAUSED) {
            for (const t of this.targets) t.draw(ctx, W, H);
            for (const p of this.particles) p.draw(ctx);
        }

        // --- Reticle ---
        if (this.state === STATES.PLAYING || this.state === STATES.PAUSED) {
            this._drawReticle(ctx, W, H, timestamp);
        }

        // --- Pause dim ---
        if (this.state === STATES.PAUSED) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(0, 0, W, H);
        }
    }

    _drawGrid(ctx, W, H) {
        ctx.strokeStyle = 'rgba(0,229,255,0.04)';
        ctx.lineWidth   = 1;
        const cols = 12, rows = 8;
        for (let i = 1; i < cols; i++) {
            ctx.beginPath();
            ctx.moveTo(i / cols * W, 0);
            ctx.lineTo(i / cols * W, H);
            ctx.stroke();
        }
        for (let j = 1; j < rows; j++) {
            ctx.beginPath();
            ctx.moveTo(0, j / rows * H);
            ctx.lineTo(W, j / rows * H);
            ctx.stroke();
        }
    }

    _drawRawGazeMarker(ctx, W, H) {
        if (!this.tracker.faceDetected) return;
        const px = this.tracker.rawGazeX * W;
        const py = this.tracker.rawGazeY * H;
        ctx.strokeStyle = 'rgba(0,229,255,0.6)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,229,255,0.4)';
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawReticle(ctx, W, H, timestamp) {
        const px = this.gazeX * W;
        const py = this.gazeY * H;

        const pulse     = 0.5 + 0.5 * Math.sin(this._reticlePulse);
        const onTarget  = this._onTarget;
        const justShot  = (performance.now() - this._lastShotTime) < 180;

        const baseColor  = onTarget ? '#ff4444' : '#00e5ff';
        const outerColor = onTarget ? 'rgba(255,68,68,' : 'rgba(0,229,255,';
        const shotFlash  = justShot ? 1.0 : 0;

        // Outer pulsing ring
        const outerR = 28 + pulse * 6 + shotFlash * 12;
        ctx.strokeStyle = outerColor + (0.4 + 0.4 * pulse + shotFlash * 0.4) + ')';
        ctx.lineWidth   = 2 + shotFlash;
        ctx.beginPath();
        ctx.arc(px, py, outerR, 0, Math.PI * 2);
        ctx.stroke();

        // Mid ring (on-target only)
        if (onTarget) {
            ctx.strokeStyle = 'rgba(255,68,68,0.6)';
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.arc(px, py, 18, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Crosshair arms
        const armLen = 14 + shotFlash * 4;
        const gap    = 6;
        ctx.strokeStyle = baseColor;
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(px - armLen - gap, py); ctx.lineTo(px - gap, py);
        ctx.moveTo(px + gap, py);          ctx.lineTo(px + armLen + gap, py);
        ctx.moveTo(px, py - armLen - gap); ctx.lineTo(px, py - gap);
        ctx.moveTo(px, py + gap);          ctx.lineTo(px, py + armLen + gap);
        ctx.stroke();

        // Center dot
        const dotR = justShot ? 5 : 3;
        ctx.fillStyle = baseColor;
        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fill();

        // Blink indicator
        if (this.tracker.isBlinking) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth   = 3;
            ctx.beginPath();
            ctx.arc(px, py, 38, 0, Math.PI * 2);
            ctx.stroke();
        }

        // No-face warning
        if (!this.tracker.faceDetected) {
            ctx.font      = 'bold 14px Arial';
            ctx.fillStyle = '#ff4444';
            ctx.textAlign = 'center';
            ctx.fillText('⚠ Face not detected', W / 2, H - 70);
        }
    }

    // ── Game lifecycle ────────────────────────────────────────────

    _startCalibration() {
        this.state = STATES.CALIBRATION;
        this._hideAllScreens();
        this.calibration.start((success) => {
            if (success) {
                this._goToMenu();
            } else {
                // Calibration had too few samples — go to menu anyway
                this._goToMenu();
            }
        });
    }

    _goToMenu() {
        this.state = STATES.MENU;
        this._hideAllScreens();
        this._renderLeaderboard();
        this._showScreen('menuScreen');
    }

    _startGame(mode) {
        this.mode        = mode;
        this.state       = STATES.PLAYING;
        this.score       = 0;
        this.shots       = 0;
        this.hits        = 0;
        this.lives       = 5;
        this.precisionRounds = 0;
        this.targets     = [];
        this.particles   = [];
        this.difficulty  = 1;
        this.lastSpawnTime = 0;
        this.spawnInterval = mode === MODE.SURVIVAL ? 2800 : 2500;
        this.startTime   = performance.now();

        this._hideAllScreens();
        this._showHUD(mode);
        this._updateHUD();
    }

    _endGame() {
        this.state = STATES.GAMEOVER;
        const accuracy = this.shots > 0
            ? Math.round((this.hits / this.shots) * 100) : 0;

        const elapsed = Math.round((performance.now() - this.startTime) / 1000);

        saveScore({ mode: this.mode, score: this.score, accuracy, elapsed, date: Date.now() });
        this.audio.playGameOver();
        this._hideHUD();
        this._showGameOver(accuracy, elapsed);
    }

    _pauseGame() {
        if (this.state !== STATES.PLAYING) return;
        this.state = STATES.PAUSED;
        document.getElementById('pauseScreen').style.display = 'flex';
    }

    _resumeGame() {
        if (this.state !== STATES.PAUSED) return;
        this.state = STATES.PLAYING;
        document.getElementById('pauseScreen').style.display = 'none';
    }

    // ── HUD helpers ───────────────────────────────────────────────

    _showHUD(mode) {
        const hud = document.getElementById('hud');
        hud.style.display = 'flex';

        document.getElementById('modeDisplay').textContent = modeLabel(mode);

        const healthBar = document.getElementById('healthBar');
        if (mode === MODE.SURVIVAL) {
            healthBar.style.display = 'block';
            this._updateLivesBar();
        } else {
            healthBar.style.display = 'none';
        }

        const timerEl = document.getElementById('timerDisplay');
        if (mode === MODE.PRECISION) timerEl.textContent = `Round: 0/${this.precisionTotal}`;

        document.getElementById('keyboardHint').style.display = 'block';
    }

    _hideHUD() {
        document.getElementById('hud').style.display = 'none';
        document.getElementById('healthBar').style.display = 'none';
        document.getElementById('keyboardHint').style.display = 'none';
    }

    _updateHUD() {
        document.getElementById('scoreDisplay').textContent = `Score: ${this.score}`;
        const accuracy = this.shots > 0
            ? Math.round((this.hits / this.shots) * 100) : 100;
        document.getElementById('accuracyDisplay').textContent = `Acc: ${accuracy}%`;

        if (this.mode === MODE.TIME_ATTACK) {
            const remaining = Math.max(0, Math.ceil((this.gameDuration - (performance.now() - this.startTime)) / 1000));
            document.getElementById('timerDisplay').textContent = `Time: ${remaining}s`;
        } else if (this.mode === MODE.SURVIVAL) {
            const elapsed = Math.floor((performance.now() - this.startTime) / 1000);
            document.getElementById('timerDisplay').textContent = `Time: ${elapsed}s`;
        } else if (this.mode === MODE.PRECISION) {
            document.getElementById('timerDisplay').textContent =
                `Round: ${this.precisionRounds}/${this.precisionTotal}`;
        }
    }

    _updateLivesBar() {
        const pct = Math.max(0, (this.lives / 5) * 100);
        document.getElementById('healthFill').style.width = `${pct}%`;
    }

    // ── Screen management ─────────────────────────────────────────

    _hideAllScreens() {
        ['loadingScreen', 'menuScreen', 'gameoverScreen'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        document.getElementById('pauseScreen').style.display = 'none';
    }

    _showScreen(id) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'flex';
    }

    _setProgress(pct, msg) {
        if (pct !== null) {
            document.getElementById('loadProgress').style.width = `${pct}%`;
        }
        if (msg) document.getElementById('loadStatus').textContent = msg;
    }

    _showError(title, detail) {
        const el = document.getElementById('errorScreen');
        el.querySelector('h2').textContent = title;
        el.querySelector('p').textContent  = detail || '';
        el.style.display = 'flex';
        this._hideAllScreens();
    }

    _showGameOver(accuracy, elapsed) {
        const modeStr = modeLabel(this.mode);
        const html = `
            <div class="stat-row"><span class="stat-label">Mode</span><span class="stat-val">${modeStr}</span></div>
            <div class="stat-row"><span class="stat-label">Score</span><span class="stat-val">${this.score}</span></div>
            <div class="stat-row"><span class="stat-label">Hits / Shots</span><span class="stat-val">${this.hits} / ${this.shots}</span></div>
            <div class="stat-row"><span class="stat-label">Accuracy</span><span class="stat-val">${accuracy}%</span></div>
            <div class="stat-row"><span class="stat-label">Time</span><span class="stat-val">${elapsed}s</span></div>
        `;
        document.getElementById('finalStats').innerHTML = html;
        this._showScreen('gameoverScreen');
    }

    _renderLeaderboard() {
        const scores = loadScores();
        const el     = document.getElementById('leaderboardList');
        if (scores.length === 0) {
            el.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.35);font-size:0.85rem">No scores yet — play a game!</p>';
            return;
        }
        el.innerHTML = scores.slice(0, 8).map((s, i) => `
            <div class="lb-entry">
                <span class="lb-rank">#${i + 1}</span>
                <span class="lb-mode">${modeLabel(s.mode)}</span>
                <span class="lb-score">${s.score}</span>
            </div>
        `).join('');
    }

    // ── Event handlers ────────────────────────────────────────────

    _onKeyDown(e) {
        switch (e.code) {
            case 'Space':
                e.preventDefault();
                if (this.state === STATES.PLAYING) this._shoot();
                break;
            case 'Escape':
            case 'KeyP':
                if (this.state === STATES.PLAYING)  this._pauseGame();
                else if (this.state === STATES.PAUSED) this._resumeGame();
                break;
        }
    }

    _onResize() {
        this._resize();
    }

    _resize() {
        this.canvas.width  = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    // ── Wire up DOM buttons (called in DOMContentLoaded) ──────────

    _bindButtons() {
        // Menu
        document.getElementById('timeAttackBtn').addEventListener('click',
            () => this._startGame(MODE.TIME_ATTACK));
        document.getElementById('survivalBtn').addEventListener('click',
            () => this._startGame(MODE.SURVIVAL));
        document.getElementById('precisionBtn').addEventListener('click',
            () => this._startGame(MODE.PRECISION));
        document.getElementById('calibrateBtn').addEventListener('click',
            () => this._startCalibration());

        // Game over
        document.getElementById('playAgainBtn').addEventListener('click', () => {
            this._hideAllScreens();
            this._startGame(this.mode);
        });
        document.getElementById('menuBtn').addEventListener('click',
            () => this._goToMenu());

        // Pause resume
        document.getElementById('resumeBtn')?.addEventListener('click',
            () => this._resumeGame());

        // Error retry
        document.getElementById('retryBtn')?.addEventListener('click',
            () => location.reload());

        // Also allow clicking canvas to shoot (mobile-friendly fallback)
        this.canvas.addEventListener('click', () => {
            if (this.state === STATES.PLAYING) this._shoot();
        });
    }
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    const game = new Game();
    game._bindButtons();
    game.start();

    // Continuously refresh HUD timer during play
    setInterval(() => {
        if (game.state === STATES.PLAYING) game._updateHUD();
    }, 250);
});
