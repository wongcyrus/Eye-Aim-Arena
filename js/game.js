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
const LS_SETTINGS = 'eyeAimArena_settings';
const MAX_SCORES = 10;
const LEADERBOARD_DISPLAY_COUNT = 8;

// Target lifetime tuning
const TARGET_LIFETIME_MIN_MS       = 2000;
const TARGET_LIFETIME_BASE_MS      = 5000;
const TARGET_LIFETIME_DIFF_STEP_MS = 400;

// Target fade-in / fade-out thresholds (fraction of lifetime)
const FADE_IN_END         = 0.10;  // fade in over first 10 %
const FADE_OUT_START      = 0.78;  // start fading at 78 %
const FADE_OUT_DURATION   = 0.22;  // fade span = 22 % of lifetime

// Danger flash (near expiry)
const DANGER_FLASH_START  = 0.72;
const DANGER_FLASH_RANGE  = 0.28;
const DANGER_FLASH_FREQ   = 10;    // oscillations per remaining fraction

// Survival spawning limits
const SURVIVAL_BASE_MAX_TARGETS = 3;
const SURVIVAL_HARD_MAX_TARGETS = 8;

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
        if (lifeRat < FADE_IN_END)    alpha = lifeRat / FADE_IN_END;
        if (lifeRat > FADE_OUT_START) alpha = (1 - lifeRat) / FADE_OUT_DURATION;
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
        if (lifeRat > DANGER_FLASH_START) {
            const flash = Math.sin(
                (lifeRat - DANGER_FLASH_START) / DANGER_FLASH_RANGE * Math.PI * DANGER_FLASH_FREQ
            ) > 0;
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

    lifetime = Math.max(
        TARGET_LIFETIME_MIN_MS,
        TARGET_LIFETIME_BASE_MS - difficulty * TARGET_LIFETIME_DIFF_STEP_MS
    );

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
        window.game = this;
        // DOM
        this.canvas   = document.getElementById('gameCanvas');
        this.ctx      = this.canvas.getContext('2d');
        this.video    = document.getElementById('webcamVideo');
        const cameraPreviewEl = document.getElementById('cameraPreview');
        this.cameraOverlay = document.getElementById('cameraOverlay');
        this.cameraCtx = this.cameraOverlay ? this.cameraOverlay.getContext('2d') : null;
        this.cameraPreview = this.cameraCtx ? cameraPreviewEl : null;

        // Settings Preview elements
        this.settingsCameraOverlay = document.getElementById('settingsCameraOverlay');
        this.settingsCameraCtx = this.settingsCameraOverlay ? this.settingsCameraOverlay.getContext('2d') : null;
        this.settingsEyeStatus = document.getElementById('settingsEyeStatus');
        this.isSettingsOpen = false;

        this.menuGazeReticle = document.getElementById('menuGazeReticle');

        // Core systems
        this.tracker  = new EyeTracker();
        this.calibration = new CalibrationSystem(this.canvas, this.tracker);
        this.audio    = new GameAudio();
        this.settings = this._loadSettings();
        this.availableCameras = [];
        this.currentCameraDeviceId = this.settings.cameraDeviceId || '';

        // State
        this.state    = STATES.LOADING;
        this.mode     = null;

        // Gaze (screen normalised [0,1])
        this.gazeX = 0.5;
        this.gazeY = 0.5;
        this._smoothGazeX = 0.5;
        this._smoothGazeY = 0.5;
        this._gazeAlpha   = 0.2;   // secondary EMA after calibration

        // WebGazer properties
        this._webgazerInitialized = false;
        this.webgazerDetected = false;
        this.webgazerRawX = window.innerWidth / 2;
        this.webgazerRawY = window.innerHeight / 2;

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

    get activeVideo() {
        if (this.settings.trackingMode === 'webgazer') {
            const wgVideo = document.getElementById('webgazerVideoFeed');
            if (wgVideo && wgVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                return wgVideo;
            }
        }
        return this.video;
    }

    // ── Bootstrap ─────────────────────────────────────────────────

    async start() {
        this._resize();
        window.addEventListener('resize', this._onResize);
        window.addEventListener('keydown', this._onKeyDown);

        // Tab visibility state tracking to pause/resume WebGazer
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (this._webgazerInitialized) {
                    try { webgazer.pause(); } catch (err) {}
                }
            } else {
                if (this._webgazerInitialized && this.settings.trackingMode === 'webgazer' && 
                    (this.state === STATES.MENU || this.state === STATES.PLAYING || this.state === STATES.CALIBRATION || this.isSettingsOpen)) {
                    try { webgazer.resume(); } catch (err) {}
                }
            }
        });

        this._showScreen('loadingScreen');
        this._setProgress(5, 'Requesting camera…');

        // Webcam
        try {
            await this._openCamera(this.settings.cameraDeviceId);
            await this._refreshCameraList();
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

        // Initialize WebGazer if selected
        if (this.settings.trackingMode === 'webgazer') {
            try {
                await this._updateTrackingMode();
            } catch (err) {
                console.warn('Failed to initialize WebGazer:', err);
            }
        }

        this._setProgress(100, 'Ready!');
        await _sleep(400);

        // If we have saved calibration go straight to menu
        if (this.calibration.isCalibrated()) {
            await this._goToMenu();
        } else {
            await this._startCalibration();
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
        const tracking = this.tracker.processFrame(this.activeVideo, timestamp);
        if (this.settings.trackingMode === 'webgazer') {
            if (this.webgazerDetected) {
                // Map the absolute screen pixel coordinates to normalized range [0, 1]
                const normX = this.webgazerRawX / window.innerWidth;
                const normY = this.webgazerRawY / window.innerHeight;

                const mappedX = this.settings.invertX ? 1 - normX : normX;
                const mappedY = this.settings.invertY ? 1 - normY : normY;

                this._smoothGazeX += (mappedX - this._smoothGazeX) * this._gazeAlpha;
                this._smoothGazeY += (mappedY - this._smoothGazeY) * this._gazeAlpha;
                this.gazeX = Math.max(0, Math.min(1, this._smoothGazeX));
                this.gazeY = Math.max(0, Math.min(1, this._smoothGazeY));
            }
        } else {
            if (tracking?.faceDetected) {
                // Apply calibration transform (normalised coordinates in [0,1]).
                const cal = this.calibration.applyTransform(tracking.gazeX, tracking.gazeY);
                const mappedX = this.settings.invertX ? 1 - cal.x : cal.x;
                const mappedY = this.settings.invertY ? 1 - cal.y : cal.y;
                // Secondary smoothing
                this._smoothGazeX += (mappedX - this._smoothGazeX) * this._gazeAlpha;
                this._smoothGazeY += (mappedY - this._smoothGazeY) * this._gazeAlpha;
                this.gazeX = Math.max(0, Math.min(1, this._smoothGazeX));
                this.gazeY = Math.max(0, Math.min(1, this._smoothGazeY));
            }
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
            ? Math.min(SURVIVAL_HARD_MAX_TARGETS, SURVIVAL_BASE_MAX_TARGETS + Math.floor(this.difficulty))
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
        const activeVid = this.activeVideo;
        if (activeVid && activeVid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(activeVid, 0, 0, W, H);
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
            this._drawCameraPreview();
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

        this._drawCameraPreview();
        this._drawSettingsCameraPreview();

        // --- Menu Gaze Reticle ---
        if (this.state === STATES.MENU) {
            if (this.menuGazeReticle) {
                this.menuGazeReticle.style.display = 'block';
                this.menuGazeReticle.style.left = `${this.gazeX * window.innerWidth}px`;
                this.menuGazeReticle.style.top = `${this.gazeY * window.innerHeight}px`;
            }
        } else {
            if (this.menuGazeReticle) {
                this.menuGazeReticle.style.display = 'none';
            }
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
        const isWebGazer = this.settings.trackingMode === 'webgazer';
        const detected = isWebGazer ? this.webgazerDetected : this.tracker.faceDetected;
        if (!detected) return;

        let px, py;
        let colorTheme;
        if (isWebGazer) {
            // WebGazer coordinates are absolute pixels relative to window
            const normX = this.webgazerRawX / window.innerWidth;
            const normY = this.webgazerRawY / window.innerHeight;
            px = normX * W;
            py = normY * H;
            colorTheme = 'rgba(255,102,0,'; // Orange glow for WebGazer
        } else {
            px = this.tracker.rawGazeX * W;
            py = this.tracker.rawGazeY * H;
            colorTheme = 'rgba(0,229,255,'; // Cyan for MediaPipe
        }

        ctx.strokeStyle = colorTheme + '0.6)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = colorTheme + '0.4)';
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawCameraPreview() {
        if (!this.cameraCtx) return;
        const ctx = this.cameraCtx;
        const W = this.cameraOverlay.width;
        const H = this.cameraOverlay.height;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);

        const activeVid = this.activeVideo;
        if (activeVid && activeVid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            ctx.save();
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(activeVid, 0, 0, W, H);
            ctx.restore();
        }

        const isWebGazer = this.settings.trackingMode === 'webgazer';
        const detected = isWebGazer ? this.webgazerDetected : this.tracker.faceDetected;

        if (detected) {
            let px, py;
            let colorTheme;
            if (isWebGazer) {
                const normX = this.webgazerRawX / window.innerWidth;
                const normY = this.webgazerRawY / window.innerHeight;
                // Preview video is mirrored horizontally, so mirror horizontal coordinate
                px = (1 - normX) * W;
                py = normY * H;
                colorTheme = '#ff6600';
            } else {
                px = (1 - this.tracker.rawGazeX) * W;
                py = this.tracker.rawGazeY * H;
                colorTheme = '#00e5ff';
            }

            ctx.strokeStyle = colorTheme;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, 14, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = colorTheme;
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.fillStyle = 'rgba(255,68,68,0.9)';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Face not detected', W / 2, H - 10);
        }
    }

    _drawSettingsCameraPreview() {
        if (!this.isSettingsOpen || !this.settingsCameraCtx) return;
        const ctx = this.settingsCameraCtx;
        const W = this.settingsCameraOverlay.width;
        const H = this.settingsCameraOverlay.height;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);

        const activeVid = this.activeVideo;
        if (activeVid && activeVid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            ctx.save();
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(activeVid, 0, 0, W, H);
            ctx.restore();
        }

        const trackingModeEl = document.getElementById('trackingModeSelect');
        const liveTrackingMode = trackingModeEl ? trackingModeEl.value : this.settings.trackingMode;
        const isWebGazer = liveTrackingMode === 'webgazer';
        const detected = isWebGazer ? this.webgazerDetected : this.tracker.faceDetected;

        if (detected) {
            const invertXEl = document.getElementById('invertXCheckbox');
            const invertYEl = document.getElementById('invertYCheckbox');
            const liveInvertX = invertXEl ? invertXEl.checked : this.settings.invertX;
            const liveInvertY = invertYEl ? invertYEl.checked : this.settings.invertY;

            // Compute calibrated live eye position
            let liveGazeX, liveGazeY;
            if (liveTrackingMode === 'webgazer') {
                const normX = this.webgazerRawX / window.innerWidth;
                const normY = this.webgazerRawY / window.innerHeight;
                liveGazeX = liveInvertX ? 1 - normX : normX;
                liveGazeY = liveInvertY ? 1 - normY : normY;
            } else {
                const cal = this.calibration.applyTransform(this.tracker.gazeX, this.tracker.gazeY);
                liveGazeX = liveInvertX ? 1 - cal.x : cal.x;
                liveGazeY = liveInvertY ? 1 - cal.y : cal.y;
            }

            const px = liveGazeX * W;
            const py = liveGazeY * H;

            // Screen boundary simulation
            ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.strokeRect(10, 10, W - 20, H - 20);

            // Cross grid lines
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.beginPath();
            ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
            ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
            ctx.stroke();

            // Render aiming crosshair/point
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, 10, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(px - 15, py); ctx.lineTo(px + 15, py);
            ctx.moveTo(px, py - 15); ctx.lineTo(px, py + 15);
            ctx.stroke();

            ctx.fillStyle = '#00ff88';
            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fill();

            if (this.settingsEyeStatus) {
                this.settingsEyeStatus.textContent = `Eye: ${Math.round(liveGazeX * 100)}%, ${Math.round(liveGazeY * 100)}%`;
                this.settingsEyeStatus.style.color = '#00ff88';
            }
        } else {
            ctx.fillStyle = 'rgba(255,68,68,0.9)';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Face not detected', W / 2, H / 2);

            if (this.settingsEyeStatus) {
                this.settingsEyeStatus.textContent = 'Face not detected';
                this.settingsEyeStatus.style.color = '#ff4444';
            }
        }
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

    async _startCalibration() {
        this.state = STATES.CALIBRATION;
        this._hideAllScreens();
        this._setCameraPreviewVisible(true);

        try {
            await this._updateTrackingMode();
        } catch (err) {
            console.error('Failed to update tracking mode for calibration:', err);
        }

        this.calibration.start((success) => {
            if (success) {
                this._goToMenu();
            } else {
                // Calibration had too few samples — go to menu anyway
                this._goToMenu();
            }
        });
    }

    async _goToMenu() {
        this.state = STATES.MENU;
        this._hideAllScreens();
        this._setCameraPreviewVisible(false);
        this._renderLeaderboard();
        this._showScreen('menuScreen');

        try {
            await this._updateTrackingMode();
        } catch (err) {
            console.error('Failed to update tracking mode on menu transition:', err);
        }
    }

    async _startGame(mode) {
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

        await this._updateTrackingMode();
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
        this._setCameraPreviewVisible(true);

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
        this._setCameraPreviewVisible(false);
    }

    _updateHUD() {
        document.getElementById('scoreDisplay').textContent = `Score: ${this.score}`;
        const accuracy = this.shots > 0
            ? Math.round((this.hits / this.shots) * 100) : 100;
        document.getElementById('accuracyDisplay').textContent = `Acc: ${accuracy}%`;
        document.getElementById('eyeStatus').textContent = this._getEyeStatusText();

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
        ['loadingScreen', 'menuScreen', 'settingsScreen', 'gameoverScreen'].forEach(id => {
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

    _setCameraPreviewVisible(visible) {
        if (!this.cameraPreview) return;
        this.cameraPreview.style.display = visible ? 'block' : 'none';
    }

    async _initWebGazer() {
        if (this._webgazerInitialized) return;
        if (!window.webgazer) {
            console.error('WebGazer.js is not loaded.');
            throw new Error('WebGazer.js is not loaded on the window object.');
        }

        // Set MediaPipe face mesh solution path to the official CDN to avoid local 404 errors
        webgazer.params.faceMeshSolutionPath = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh';

        webgazer.setGazeListener((data, elapsed) => {
            if (!data) {
                this.webgazerDetected = false;
                return;
            }
            this.webgazerDetected = true;
            this.webgazerRawX = data.x;
            this.webgazerRawY = data.y;
        });

        try {
            await webgazer.begin();
        } catch (err) {
            console.error('Error starting WebGazer.js:', err);
            throw new Error('WebGazer.js failed to start. This can happen if third-party CDN scripts are blocked by your browser, or if camera access was denied.');
        }

        try {
            webgazer.showVideo(false);
            webgazer.showFaceOverlay(false);
            webgazer.showFaceFeedbackBox(false);
            webgazer.showPredictionPoints(false);
        } catch (err) {
            console.warn('Failed to hide WebGazer default UI elements:', err);
        }

        this._webgazerInitialized = true;
    }

    async _updateTrackingMode() {
        const mode = this.settings.trackingMode;
        if (mode === 'webgazer') {
            try {
                // Release the webcam resource on our own element to prevent conflicts in Safari
                if (this.video.srcObject) {
                    const stream = this.video.srcObject;
                    for (const track of stream.getTracks()) {
                        track.stop();
                    }
                    this.video.srcObject = null;
                }

                if (!this._webgazerInitialized) {
                    await this._initWebGazer();
                } else {
                    webgazer.resume();
                }
            } catch (err) {
                console.error('Error enabling WebGazer tracking mode:', err);
                alert('WebGazer Eyeball Tracking Failed\n\n' + (err.message || 'An unknown error occurred during WebGazer initialization.') + '\n\nAutomatically falling back to MediaPipe (Iris Tracking) mode.');
                
                // Automatically fall back to MediaPipe hybrid tracking
                this.settings.trackingMode = 'mediapipe';
                const trackingModeEl = document.getElementById('trackingModeSelect');
                if (trackingModeEl) {
                    trackingModeEl.value = 'mediapipe';
                }
                if (this._webgazerInitialized) {
                    try {
                        webgazer.pause();
                    } catch (pauseErr) {
                        console.warn('Failed to pause WebGazer during fallback:', pauseErr);
                    }
                }
                
                // Recursively apply the fallback mode (mediapipe)
                await this._updateTrackingMode();
            }
        } else {
            // Re-open our camera for MediaPipe if it's not already open
            if (!this.video.srcObject) {
                try {
                    await this._openCamera(this.settings.cameraDeviceId);
                } catch (err) {
                    console.error('Failed to re-open camera on mode switch:', err);
                }
            }
            if (this._webgazerInitialized) {
                try {
                    webgazer.pause();
                } catch (err) {
                    console.warn('Failed to pause WebGazer:', err);
                }
            }
        }
    }

    _defaultSettings() {
        return {
            invertX: false,
            invertY: false,
            cameraDeviceId: '',
            trackingMode: 'mediapipe',
        };
    }

    _loadSettings() {
        const defaults = this._defaultSettings();
        try {
            const raw = localStorage.getItem(LS_SETTINGS);
            if (!raw) return defaults;
            const parsed = JSON.parse(raw);
            return {
                invertX: Boolean(parsed.invertX),
                invertY: Boolean(parsed.invertY),
                cameraDeviceId: typeof parsed.cameraDeviceId === 'string' ? parsed.cameraDeviceId : '',
                trackingMode: parsed.trackingMode === 'webgazer' ? 'webgazer' : 'mediapipe',
            };
        } catch {
            return defaults;
        }
    }

    _saveSettings() {
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(this.settings)); } catch { /* ignore */ }
    }

    async _openCamera(deviceId = '') {
        const constraints = {
            video: deviceId
                ? {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    deviceId: { exact: deviceId },
                }
                : {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: 'user',
                },
            audio: false,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const oldStream = this.video.srcObject;
        if (oldStream && oldStream !== stream) {
            for (const t of oldStream.getTracks()) t.stop();
        }

        this.video.srcObject = stream;
        await new Promise((res, rej) => {
            this.video.onloadeddata = res;
            this.video.onerror = rej;
            this.video.play();
        });

        const [track] = stream.getVideoTracks();
        // deviceId may be unavailable on older browsers/privacy-restricted contexts.
        const activeId = track?.getSettings?.().deviceId || deviceId || '';
        this.currentCameraDeviceId = activeId;
        this.settings.cameraDeviceId = activeId;
        this._saveSettings();
    }

    async _refreshCameraList() {
        if (!navigator.mediaDevices?.enumerateDevices) {
            this.availableCameras = [];
            this._populateCameraSelect();
            return;
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        this.availableCameras = devices.filter(d => d.kind === 'videoinput');
        this._populateCameraSelect();
    }

    _populateCameraSelect() {
        const select = document.getElementById('cameraSelect');
        if (!select) return;

        select.innerHTML = '';
        if (this.availableCameras.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Default camera';
            select.appendChild(option);
            select.value = '';
            return;
        }

        this.availableCameras.forEach((camera, idx) => {
            const option = document.createElement('option');
            option.value = camera.deviceId;
            option.textContent = camera.label || `Camera ${idx + 1}`;
            select.appendChild(option);
        });

        const selectedId = this.settings.cameraDeviceId || this.currentCameraDeviceId;
        const hasSelected = this.availableCameras.some(c => c.deviceId === selectedId);
        select.value = hasSelected ? selectedId : this.availableCameras[0].deviceId;
    }

    async _openSettings() {
        this._hideAllScreens();

        // Backup current settings and camera ID in case Cancel is clicked
        this._settingsBackup = { ...this.settings };
        this._cameraBackupId = this.currentCameraDeviceId;

        const invertXEl = document.getElementById('invertXCheckbox');
        const invertYEl = document.getElementById('invertYCheckbox');
        if (invertXEl) invertXEl.checked = this.settings.invertX;
        if (invertYEl) invertYEl.checked = this.settings.invertY;

        const trackingModeEl = document.getElementById('trackingModeSelect');
        if (trackingModeEl) trackingModeEl.value = this.settings.trackingMode;

        await this._refreshCameraList();
        this._showScreen('settingsScreen');
        this.isSettingsOpen = true;

        // Ensure tracking mode is active for settings live preview
        try {
            await this._updateTrackingMode();
        } catch (err) {
            console.error('Failed to initialize tracking mode in settings:', err);
        }
    }

    async _closeSettings(cancelled = false) {
        this.isSettingsOpen = false;

        if (cancelled && this._settingsBackup) {
            this.settings = { ...this._settingsBackup };
            try {
                await this._updateTrackingMode();
            } catch (err) {
                console.error('Failed to revert tracking mode on cancellation:', err);
            }
            if (this.currentCameraDeviceId !== this._cameraBackupId) {
                try {
                    await this._openCamera(this._cameraBackupId);
                } catch (err) {
                    console.error('Failed to revert camera selection:', err);
                }
            }
        }
        this._settingsBackup = null;
        this._cameraBackupId = null;

        await this._goToMenu();
    }

    async _applyCameraSelection(deviceId) {
        const nextId = deviceId || '';
        const currentId = this.currentCameraDeviceId || this.settings.cameraDeviceId || '';
        if (nextId === currentId) return;
        await this._openCamera(nextId);
        await this._refreshCameraList();
    }

    _getEyeStatusText() {
        if (!this.tracker.faceDetected) return 'Eye: face not detected';
        return `Eye: ${Math.round(this.gazeX * 100)}%, ${Math.round(this.gazeY * 100)}%`;
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
        el.innerHTML = scores.slice(0, LEADERBOARD_DISPLAY_COUNT).map((s, i) => `
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
                if (document.getElementById('settingsScreen')?.style.display === 'flex') {
                    this._closeSettings(true);
                    break;
                }
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
        document.getElementById('settingsBtn').addEventListener('click', async () => {
            try {
                await this._openSettings();
            } catch (err) {
                this._showError('Failed to load settings.', err.message);
            }
        });
        document.getElementById('calibrateBtn').addEventListener('click',
            () => this._startCalibration());

        // Settings
        document.getElementById('settingsCancelBtn')?.addEventListener('click',
            () => this._closeSettings(true));
        
        document.getElementById('cameraSelect')?.addEventListener('change', async (e) => {
            try {
                await this._applyCameraSelection(e.target.value);
            } catch (err) {
                this._showError('Failed to switch camera.', err.message);
            }
        });

        document.getElementById('trackingModeSelect')?.addEventListener('change', async (e) => {
            const mode = e.target.value;
            if (mode === 'webgazer') {
                // Explicitly stop this.video tracks first to prevent contention in Safari
                if (this.video.srcObject) {
                    const stream = this.video.srcObject;
                    for (const track of stream.getTracks()) {
                        track.stop();
                    }
                    this.video.srcObject = null;
                }

                try {
                    if (!this._webgazerInitialized) {
                        await this._initWebGazer();
                    } else {
                        webgazer.resume();
                    }
                } catch (err) {
                    console.error('Failed to initialize or resume WebGazer for preview:', err);
                    alert('WebGazer Eyeball Tracking Failed\n\n' + (err.message || 'An unknown error occurred during WebGazer initialization.') + '\n\nAutomatically falling back to MediaPipe (Iris Tracking) mode.');
                    
                    // Reset the select's value programmatically to 'mediapipe'
                    const selectEl = document.getElementById('trackingModeSelect');
                    if (selectEl) {
                        selectEl.value = 'mediapipe';
                    }
                    // Call _updateTrackingMode() to restore state synchronization
                    await this._updateTrackingMode();
                }
            } else {
                if (this._webgazerInitialized) {
                    try {
                        webgazer.pause();
                    } catch (err) {
                        console.warn('Failed to pause WebGazer during preview:', err);
                    }
                }
                // Ensure _openCamera() is re-invoked
                if (!this.video.srcObject) {
                    try {
                        await this._openCamera(this.settings.cameraDeviceId);
                    } catch (err) {
                        console.error('Failed to re-open camera on mode preview switch:', err);
                        this._showError('Camera access failed', err.message);
                    }
                }
            }
        });

        document.getElementById('settingsSaveBtn')?.addEventListener('click', async () => {
            const invertXEl = document.getElementById('invertXCheckbox');
            const invertYEl = document.getElementById('invertYCheckbox');
            const cameraSelectEl = document.getElementById('cameraSelect');
            const trackingModeEl = document.getElementById('trackingModeSelect');
            if (!invertXEl || !invertYEl || !cameraSelectEl || !trackingModeEl) {
                this._showError('Settings controls unavailable.', 'Some settings controls are missing from the page. Please reload and try again.');
                return;
            }

            const invertX = invertXEl.checked;
            const invertY = invertYEl.checked;
            const cameraId = cameraSelectEl.value;
            const trackingMode = trackingModeEl.value;

            try {
                await this._applyCameraSelection(cameraId);
                this.settings.invertX = invertX;
                this.settings.invertY = invertY;
                this.settings.trackingMode = trackingMode;
                this.settings.cameraDeviceId = this.currentCameraDeviceId || cameraId || '';
                this._saveSettings();
                await this._updateTrackingMode();
                this._closeSettings(false);
            } catch (err) {
                this._showError('Failed to switch camera.', err.message);
            }
        });

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
