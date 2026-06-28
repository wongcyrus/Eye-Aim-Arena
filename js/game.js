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
    ZEN:         'zen',
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
//  Custom asset support — image cache & IndexedDB store
// ─────────────────────────────────────────────────────────────────────

const _imgCache = new Map(); // url → HTMLImageElement

// Extra pixel buffer added to target radius when computing spawn margins so
// the target circle edge never clips the viewport boundary.
const SPAWN_EDGE_PADDING = 4; // px

// File size limits for uploads
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;  // 2 MB
const MAX_AUDIO_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Format milliseconds as a compact seconds string, e.g. 1500 → "1.5s", 2000 → "2s" */
function _formatSeconds(ms) {
    return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')}s`;
}

function _getCachedImage(url) {
    if (_imgCache.has(url)) return _imgCache.get(url);
    const img = new Image();
    img.src = url;
    _imgCache.set(url, img);
    return img;
}

class AssetStore {
    constructor(dbName) {
        this.dbName = dbName;
        this.db = null;
    }

    open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('audio')) {
                    db.createObjectStore('audio', { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = () => reject(req.error);
        });
    }

    addImage(name, type, blob) {
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('images', 'readwrite').objectStore('images').add({ name, type, blob });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    getAllImages() {
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('images', 'readonly').objectStore('images').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    deleteImage(id) {
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('images', 'readwrite').objectStore('images').delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    setAudio(name, blob) {
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('audio', 'readwrite').objectStore('audio').put({ id: 1, name, blob });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    getAudio() {
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('audio', 'readonly').objectStore('audio').get(1);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    deleteAudio() {
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('audio', 'readwrite').objectStore('audio').delete(1);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
}

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

    playHit(score)  { 
        if (window.game && window.game.mode === 'zen') {
            // Gentle ascending musical chime bubble pop for positive, comforting reinforcement
            this._tone(523.25, 0.15, 'sine', 0.25, 1046.50); // Soothing C5-C6 ascending bell
        } else {
            this._tone(score > 150 ? 1200 : 800, 0.12, 'sine', 0.28, 400); 
        }
    }
    playMiss()      { 
        if (window.game && window.game.mode === 'zen') return; // Silence missed expiries completely in Zen Mode
        this._tone(200, 0.18, 'sawtooth', 0.18, 80); 
    }
    playBlink()     { this._tone(600, 0.06, 'square', 0.15); }
    playLevelUp()   { this._tone(440, 0.08, 'sine', 0.2, 880); }
    playGameOver()  { this._tone(300, 0.4, 'sawtooth', 0.3, 100); }
    playCountdown() { this._tone(520, 0.1, 'sine', 0.18); }
    playDwellTick(progress) {
        const freq = 440 + progress * 400; // Ascending soft bubble sound
        this._tone(freq, 0.03, 'sine', 0.05);
    }
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

        /** Optional custom image URL (set by createTarget when targetMode is 'custom') */
        this.imageUrl = cfg.imageUrl || null;

        const emojis = ["🐶", "🐱", "🐻", "🐸", "🐼", "🐨", "🐰", "🦁", "🐵", "🦊", "🐯", "🐧"];
        this.emoji = emojis[Math.floor(Math.random() * emojis.length)];
    }

    /** @param {number} dt — milliseconds since last frame */
    update(dt) {
        if (this.hit) return;
        const age = performance.now() - this.createdAt;
        if (age >= this.lifetime) { this.expired = true; return; }

        const margin = this.safeAreaMargin || 0.09;
        const minX = margin;
        const maxX = 1 - margin;
        const minY = margin;
        const maxY = 1 - margin;

        if (this.type === 'linear') {
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            if (this.x < minX || this.x > maxX) { this.vx *= -1; this.x = Math.max(minX, Math.min(maxX, this.x)); }
            if (this.y < minY || this.y > maxY) { this.vy *= -1; this.y = Math.max(minY, Math.min(maxY, this.y)); }
        } else if (this.type === 'drift') {
            this.vx += (Math.random() - 0.5) * 0.00008 * dt;
            this.vy += (Math.random() - 0.5) * 0.00008 * dt;
            const maxV = SPEED.SLOW;
            this.vx = Math.max(-maxV, Math.min(maxV, this.vx));
            this.vy = Math.max(-maxV, Math.min(maxV, this.vy));
            this.x  = Math.max(minX, Math.min(maxX, this.x + this.vx * dt));
            this.y  = Math.max(minY, Math.min(maxY, this.y + this.vy * dt));
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

        // Custom image rendering (overrides theme when image is ready)
        if (this.imageUrl) {
            const img = _getCachedImage(this.imageUrl);
            if (img.complete && img.naturalWidth > 0) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(img, px - r, py - r, r * 2, r * 2);
                ctx.restore();
                // White border
                ctx.strokeStyle = 'rgba(255,255,255,0.55)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.stroke();
                // Danger flash and alpha cleanup handled below — skip default theme
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
                return;
            }
            // Image not loaded yet — fall through to default bubble for this frame
        }

        const theme = window.game?.settings?.targetTheme || 'bubbles';

        if (theme === 'emojis') {
            // Draw a cute circular background first so it stands out nicely against the dark canvas
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();

            // Draw the emoji face centered
            ctx.font = `${r * 1.5}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.emoji || "🐶", px, py);
        } else if (theme === 'stars') {
            // Draw the golden star centered
            ctx.font = `${r * 1.6}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("⭐", px, py);
        } else {
            // Main body (using soothing pastel colors in Zen mode to reduce sensory fatigue)
            let mainColor = this.color;
            if (window.game && window.game.mode === 'zen') {
                if (this.color === PALETTE.LARGE) mainColor = '#ffb347';      // Soft pastel orange
                else if (this.color === PALETTE.MEDIUM) mainColor = '#ff6b6b'; // Soothing soft coral
                else if (this.color === PALETTE.SMALL) mainColor = '#b19ffb';  // Friendly pastel lavender
            }
            ctx.fillStyle = mainColor;
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
        }

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
     * @param {number} buffer optional pixel buffer for aim assist
     */
    containsGaze(gx, gy, W, H, buffer = 0) {
        const dx = (gx - this.x) * W;
        const dy = (gy - this.y) * H;
        return Math.hypot(dx, dy) <= (this.radius + buffer);
    }

    /**
     * Register a hit. Returns points earned (includes accuracy bonus).
     */
    registerHit(gx, gy, W, H, buffer = 0) {
        if (this.hit) return 0;
        this.hit     = true;
        this.hitTime = performance.now();

        const dx   = (gx - this.x) * W;
        const dy   = (gy - this.y) * H;
        const dist = Math.hypot(dx, dy);
        const maxDist = this.radius + buffer;
        const acc  = Math.max(0, 1 - dist / maxDist);     // 0..1
        return Math.round(this.baseScore * (1 + acc));         // up to 2×
    }
}

// ─────────────────────────────────────────────────────────────────────
//  Target factory
// ─────────────────────────────────────────────────────────────────────

function randomEdge() { return Math.random() * 0.82 + 0.09; }

function createTarget(difficulty = 1, mode = MODE.TIME_ATTACK, settings = null) {
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

    // Apply target scale from settings
    let targetScale = 1.0;
    if (settings && settings.targetScale !== undefined) {
        targetScale = parseFloat(settings.targetScale);
    }
    radius = Math.round(radius * targetScale);

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

    // Get margin boundary from settings
    let margin = 0.09;
    if (settings && settings.safeAreaMargin !== undefined) {
        margin = parseFloat(settings.safeAreaMargin);
    }

    // Enforce pixel-safe margin so large targets always stay fully visible
    const screenW = window.innerWidth  || 1280;
    const screenH = window.innerHeight || 720;
    const pixMarginX = (radius + SPAWN_EDGE_PADDING) / screenW;
    const pixMarginY = (radius + SPAWN_EDGE_PADDING) / screenH;
    const safeMarginX = Math.max(margin, pixMarginX);
    const safeMarginY = Math.max(margin, pixMarginY);

    const minX = safeMarginX;
    const maxX = 1 - safeMarginX;
    const minY = safeMarginY;
    const maxY = 1 - safeMarginY;

    const x = minX + Math.random() * (Math.max(0, maxX - minX));
    const y = minY + Math.random() * (Math.max(0, maxY - minY));

    // Resolve custom image URL (if targetMode is 'custom' and images are available)
    let imageUrl = null;
    if (settings && settings.targetMode === 'custom' && window.game && window.game._customImages && window.game._customImages.length > 0) {
        const imgs = window.game._customImages;
        imageUrl = imgs[Math.floor(Math.random() * imgs.length)].url;
    }

    const target = new Target({
        x,
        y,
        radius,
        color,
        baseScore,
        type,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        lifetime,
        imageUrl,
    });

    target.safeAreaMargin = Math.max(margin, pixMarginX);

    return target;
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
    return { 
        [MODE.TIME_ATTACK]: 'Time Attack', 
        [MODE.SURVIVAL]: 'Survival', 
        [MODE.PRECISION]: 'Precision',
        [MODE.ZEN]: 'Zen Practice'
    }[m] ?? m;
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
        this._updateGazeAlpha();
        this.availableCameras = [];
        this.currentCameraDeviceId = this.settings.cameraDeviceId || '';

        // Custom assets
        this._assetStore  = new AssetStore('eyeAimArenaDB');
        this._customImages = []; // [{id, name, url}]
        this._bgMusicUrl   = null;
        this._bgAudio      = null; // set in start()

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
        this._mediaPipeInitialized = false;
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

        // Warm up speech synthesis voices
        if (window.speechSynthesis) {
            window.speechSynthesis.getVoices();
            if ('onvoiceschanged' in window.speechSynthesis) {
                window.speechSynthesis.onvoiceschanged = () => {
                    window.speechSynthesis.getVoices();
                };
            }
        }

        // Intercept getUserMedia globally to automatically route WebGazer and other components to the chosen camera device
        const self = this;
        if (navigator.mediaDevices && !navigator.mediaDevices._originalGetUserMedia) {
            navigator.mediaDevices._originalGetUserMedia = navigator.mediaDevices.getUserMedia;
            navigator.mediaDevices.getUserMedia = async function(constraints) {
                if (self.settings && self.settings.cameraDeviceId && constraints && constraints.video) {
                    if (constraints.video === true) {
                        constraints.video = {
                            deviceId: { exact: self.settings.cameraDeviceId }
                        };
                    } else if (typeof constraints.video === 'object') {
                        if (!constraints.video.deviceId) {
                            constraints.video.deviceId = { exact: self.settings.cameraDeviceId };
                        }
                    }
                }
                return navigator.mediaDevices._originalGetUserMedia.call(navigator.mediaDevices, constraints);
            };
        }
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

        // Wire up background audio element
        this._bgAudio = document.getElementById('bgMusic');
        if (this._bgAudio) {
            this._bgAudio.volume = Math.min(1, Math.max(0, this.settings.audioVolume ?? 0.7));
            this._bgAudio.muted  = this.settings.audioMuted || false;
            this._bgAudio.loop   = this.settings.audioLoop !== false;
        }

        // Tab visibility state tracking to pause/resume WebGazer
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (this._webgazerInitialized) {
                    try { webgazer.pause(); } catch (err) {}
                }
                this._pauseBgMusic();
            } else {
                if (this._webgazerInitialized && this.settings.trackingMode === 'webgazer' && 
                    (this.state === STATES.MENU || this.state === STATES.PLAYING || this.state === STATES.CALIBRATION || this.isSettingsOpen)) {
                    try { webgazer.resume(); } catch (err) {}
                }
                if (this.state === STATES.PLAYING) this._resumeBgMusic();
            }
        });

        this._showScreen('loadingScreen');
        this._setProgress(5, 'Requesting camera…');

        // Load custom assets from IndexedDB (non-blocking – errors are silently ignored)
        this._assetStore.open().then(() => {
            this._loadCustomImages();
            this._loadCustomAudio();
        }).catch(err => {
            console.warn('IndexedDB unavailable; custom assets will not persist:', err);
        });

        // Webcam
        try {
            await this._openCamera(this.settings.cameraDeviceId);
            await this._refreshCameraList();
        } catch (err) {
            this._showError('Camera access denied or unavailable.', err.message);
            return;
        }

        if (this.settings.trackingMode === 'webgazer') {
            this._setProgress(20, 'Initializing WebGazer…');
            try {
                // Clear any MediaPipe globals before WebGazer starts
                if (window.Module) {
                    try { delete window.Module; } catch (e) { window.Module = undefined; }
                }
                try {
                    delete window.createMediapipeSolutionsWasm;
                    delete window.createMediapipeSolutionsPackedAssets;
                } catch (e) {}

                await this._updateTrackingMode();
            } catch (err) {
                console.warn('Failed to initialize WebGazer:', err);
            }
        } else {
            this._setProgress(20, 'Loading MediaPipe…');
            try {
                await this._initMediaPipe(msg => this._setProgress(null, msg));
            } catch (err) {
                this._showError('Failed to load the face-tracking model.', err.message);
                return;
            }
        }

        this._setProgress(100, 'Ready!');
        await _sleep(400);

        // Go straight to menu on first load so the user can configure settings (such as WebGazer)
        // and select cameras before calibrating or playing.
        await this._goToMenu();

        // Kick off the render loop
        requestAnimationFrame(ts => this._loop(ts));
    }

    // ── Main loop ─────────────────────────────────────────────────

    _loop(timestamp) {
        requestAnimationFrame(ts => this._loop(ts));

        const dt = Math.min(50, timestamp - (this._lastTs ?? timestamp));
        this._lastTs = timestamp;

        // Eye tracking (every frame)
        let tracking = null;
        if (this.settings.trackingMode === 'mediapipe' && this._mediaPipeInitialized) {
            tracking = this.tracker.processFrame(this.activeVideo, timestamp);
        }

        if (this.settings.trackingMode === 'webgazer') {
            const tracker = window.webgazer && window.webgazer.getTracker();
            this.webgazerDetected = !!(tracker && (
                tracker.predictionReady === true || 
                (typeof tracker.getPositions === 'function' && tracker.getPositions() && tracker.getPositions().length > 0)
            ));

            if (this.webgazerDetected) {
                // Map the absolute screen pixel coordinates to normalized range [0, 1]
                const normX = this.webgazerRawX / window.innerWidth;
                const normY = this.webgazerRawY / window.innerHeight;

                const cal = this.calibration.applyTransform(normX, normY);
                const mappedX = this.settings.invertX ? 1 - cal.x : cal.x;
                const mappedY = this.settings.invertY ? 1 - cal.y : cal.y;

                // Range Amplification around center point (0.5)
                const sens = parseFloat(this.settings.gazeSensitivity || '1.0');
                const amplifiedX = 0.5 + (mappedX - 0.5) * sens;
                const amplifiedY = 0.5 + (mappedY - 0.5) * sens;

                this._smoothGazeX += (amplifiedX - this._smoothGazeX) * this._gazeAlpha;
                this._smoothGazeY += (amplifiedY - this._smoothGazeY) * this._gazeAlpha;
                this.gazeX = Math.max(0, Math.min(1, this._smoothGazeX));
                this.gazeY = Math.max(0, Math.min(1, this._smoothGazeY));
            }
        } else {
            if (tracking?.faceDetected) {
                // Apply calibration transform (normalised coordinates in [0,1]).
                const cal = this.calibration.applyTransform(tracking.gazeX, tracking.gazeY);
                const mappedX = this.settings.invertX ? 1 - cal.x : cal.x;
                const mappedY = this.settings.invertY ? 1 - cal.y : cal.y;

                // Range Amplification around center point (0.5)
                const sens = parseFloat(this.settings.gazeSensitivity || '1.0');
                const amplifiedX = 0.5 + (mappedX - 0.5) * sens;
                const amplifiedY = 0.5 + (mappedY - 0.5) * sens;

                // Secondary smoothing
                this._smoothGazeX += (amplifiedX - this._smoothGazeX) * this._gazeAlpha;
                this._smoothGazeY += (amplifiedY - this._smoothGazeY) * this._gazeAlpha;
                this.gazeX = Math.max(0, Math.min(1, this._smoothGazeX));
                this.gazeY = Math.max(0, Math.min(1, this._smoothGazeY));
            }
        }

        // State-specific update
        switch (this.state) {
            case STATES.CALIBRATION:
                this.calibration.update(timestamp);
                if (this.cameraPreview) {
                    const currentPoint = this.calibration.points[this.calibration._pointIdx];
                    if (currentPoint) {
                        // Horizontally position opposite to current point
                        if (currentPoint.x > 0.5) {
                            this.cameraPreview.style.left = '16px';
                            this.cameraPreview.style.right = 'auto';
                        } else {
                            this.cameraPreview.style.left = 'auto';
                            this.cameraPreview.style.right = '16px';
                        }
                        // Vertically position opposite to current point
                        if (currentPoint.y > 0.5) {
                            this.cameraPreview.style.top = '16px';
                            this.cameraPreview.style.bottom = 'auto';
                        } else {
                            this.cameraPreview.style.top = 'auto';
                            this.cameraPreview.style.bottom = '16px';
                        }
                    }
                }
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
        } else if (this.mode === MODE.ZEN) {
            this.difficulty = 1.0; // Keep targets completely steady and friendly
        }

        // ---- Time Attack end ----
        if (this.mode === MODE.TIME_ATTACK && elapsed >= this.gameDuration) {
            this._endGame();
            return;
        }

        // ---- Spawn targets ----
        const maxActive = this.mode === MODE.SURVIVAL
            ? Math.min(SURVIVAL_HARD_MAX_TARGETS, SURVIVAL_BASE_MAX_TARGETS + Math.floor(this.difficulty))
            : this.mode === MODE.PRECISION ? 1 
            : this.mode === MODE.ZEN ? 3 : 5; // Moderate target counts for Zen to avoid overload

        if (this.targets.length < maxActive &&
            timestamp - this.lastSpawnTime >= this.spawnInterval) {
            if (this.mode !== MODE.PRECISION || this.precisionRounds < this.precisionTotal) {
                this.targets.push(createTarget(this.difficulty, this.mode, this.settings));
                this.lastSpawnTime = timestamp;
            }
        }

        // ---- Update targets ----
        this._onTarget = false;
        const assistBuffer = this._getAimAssistBuffer();
        const W = this.canvas.width;
        const H = this.canvas.height;
        const triggerMode = this.settings.triggerMode || 'blink';
        const isAutoShoot = triggerMode === 'auto';
        const isDwellMode = triggerMode.startsWith('dwell_');
        let autoShootRegistered = false;
        let hoveredTarget = null;

        for (const t of this.targets) {
            t.update(dt);
            if (!t.hit && !t.expired && t.containsGaze(this.gazeX, this.gazeY, W, H, assistBuffer)) {
                this._onTarget = true;
                hoveredTarget = t;
                if (isAutoShoot && !autoShootRegistered) {
                    autoShootRegistered = true;
                    this.shots++;
                    this._lastShotTime = performance.now();
                    const pts = t.registerHit(this.gazeX, this.gazeY, W, H, assistBuffer);
                    this.score += pts;
                    this.hits++;
                    if (this.mode === MODE.PRECISION) this.precisionRounds++;
                    this._checkZenMilestones();

                    // Spawn particles
                    const px = t.x * W;
                    const py = t.y * H;
                    for (let i = 0; i < 14; i++) {
                        this.particles.push(new Particle(px, py, t.color));
                    }

                    this.audio.playHit(pts);
                    this._updateHUD();
                }
            }
        }

        // ---- Gaze Dwell Logic ----
        if (isDwellMode) {
            // Resolve dwell limit: presets or custom configurable value
            let dwellLimit;
            if (triggerMode === 'dwell_short')       dwellLimit = 500;
            else if (triggerMode === 'dwell_medium')  dwellLimit = 1000;
            else if (triggerMode === 'dwell_long')    dwellLimit = 1500;
            else /* dwell_custom */                   dwellLimit = this.settings.gazeDwellMs || 2000;

            if (hoveredTarget) {
                if (this._dwellTarget !== hoveredTarget) {
                    this._dwellTarget = hoveredTarget;
                    this._dwellStartTime = timestamp;
                    this._dwellProgress = 0;
                    this._lastDwellTickTime = timestamp;
                } else {
                    const elapsedDwell = timestamp - this._dwellStartTime;
                    this._dwellProgress = Math.min(1.0, elapsedDwell / dwellLimit);

                    // Play a tick sound every 150ms
                    if (!this._lastDwellTickTime) this._lastDwellTickTime = 0;
                    if (timestamp - this._lastDwellTickTime >= 150) {
                        this._lastDwellTickTime = timestamp;
                        if (this._dwellProgress < 1.0) {
                            this.audio.playDwellTick(this._dwellProgress);
                        }
                    }

                    if (elapsedDwell >= dwellLimit) {
                        // Pop target!
                        this.shots++;
                        this._lastShotTime = performance.now();
                        const pts = hoveredTarget.registerHit(this.gazeX, this.gazeY, W, H, assistBuffer);
                        this.score += pts;
                        this.hits++;
                        if (this.mode === MODE.PRECISION) this.precisionRounds++;
                        this._checkZenMilestones();

                        // Spawn particles
                        const px = hoveredTarget.x * W;
                        const py = hoveredTarget.y * H;
                        for (let i = 0; i < 14; i++) {
                            this.particles.push(new Particle(px, py, hoveredTarget.color));
                        }

                        this.audio.playHit(pts);
                        this._updateHUD();

                        // Reset
                        this._dwellTarget = null;
                        this._dwellStartTime = 0;
                        this._dwellProgress = 0;
                    }
                }
            } else {
                this._dwellTarget = null;
                this._dwellStartTime = 0;
                this._dwellProgress = 0;
            }
        } else {
            this._dwellTarget = null;
            this._dwellStartTime = 0;
            this._dwellProgress = 0;
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

        // Survival lives penalty for missed targets (skipped during grace period)
        const gracePeriodMs = (this.settings.gracePeriodSec || 0) * 1000;
        const inGracePeriod = elapsed < gracePeriodMs;
        if (this.mode === MODE.SURVIVAL && missedCount > 0 && !inGracePeriod) {
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
        const assistBuffer = this._getAimAssistBuffer();

        for (const t of this.targets) {
            if (!t.hit && !t.expired && t.containsGaze(this.gazeX, this.gazeY, W, H, assistBuffer)) {
                const pts = t.registerHit(this.gazeX, this.gazeY, W, H, assistBuffer);
                this.score += pts;
                this.hits++;
                this._checkZenMilestones();
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
            const cal = this.calibration.applyTransform(this.tracker.rawGazeX, this.tracker.rawGazeY);
            px = cal.x * W;
            py = cal.y * H;
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
                px = (1 - this.tracker.absoluteIrisX) * W;
                py = this.tracker.absoluteIrisY * H;
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
                const cal = this.calibration.applyTransform(normX, normY);
                liveGazeX = liveInvertX ? 1 - cal.x : cal.x;
                liveGazeY = liveInvertY ? 1 - cal.y : cal.y;
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

        // Dwell charging indicator
        const trigMode = this.settings.triggerMode || 'blink';
        if (trigMode.startsWith('dwell_') && this._dwellProgress > 0) {
            ctx.strokeStyle = '#ffcc00'; // Bright gold
            ctx.lineWidth   = 4;
            ctx.beginPath();
            ctx.arc(px, py, 34, -Math.PI / 2, -Math.PI / 2 + this._dwellProgress * Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = `rgba(255, 204, 0, ${this._dwellProgress * 0.18})`;
            ctx.beginPath();
            ctx.arc(px, py, 34, 0, Math.PI * 2);
            ctx.fill();
        }

        // Blink indicator
        const isBlinking = this.settings.trackingMode === 'webgazer' ? false : this.tracker.isBlinking;
        if (isBlinking) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth   = 3;
            ctx.beginPath();
            ctx.arc(px, py, 38, 0, Math.PI * 2);
            ctx.stroke();
        }

        // No-face warning
        const faceDetected = this.settings.trackingMode === 'webgazer' ? this.webgazerDetected : this.tracker.faceDetected;
        if (!faceDetected) {
            ctx.font      = 'bold 14px Arial';
            ctx.fillStyle = '#ff4444';
            ctx.textAlign = 'center';
            ctx.fillText('⚠ Face not detected', W / 2, H - 70);
        }
    }

    // ── Game lifecycle ────────────────────────────────────────────

    async _startCalibration() {
        // Show pre-calibration guide modal if the setting is enabled
        if (this.settings.showCalibrationGuide) {
            this._hideAllScreens();
            this._showScreen('calibrationGuideModal');
            // The actual calibration is started by the modal buttons (wired in _bindButtons)
            return;
        }
        await this._beginCalibration();
    }

    async _beginCalibration() {
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
        this._updateCalibrationStatusUI();

        try {
            await this._updateTrackingMode();
        } catch (err) {
            console.error('Failed to update tracking mode on menu transition:', err);
        }
    }

    _updateCalibrationStatusUI() {
        const calibrateBtn = document.getElementById('calibrateBtn');
        if (!calibrateBtn) return;

        const isCal = this.calibration.isCalibrated();
        const mode = this.settings.trackingMode === 'webgazer' ? 'WebGazer' : 'MediaPipe';
        
        let existingStatusBadge = document.getElementById('calStatusBadge');
        if (!existingStatusBadge) {
            existingStatusBadge = document.createElement('span');
            existingStatusBadge.id = 'calStatusBadge';
            existingStatusBadge.style.display = 'inline-block';
            existingStatusBadge.style.marginLeft = '10px';
            existingStatusBadge.style.padding = '2px 8px';
            existingStatusBadge.style.borderRadius = '12px';
            existingStatusBadge.style.fontSize = '0.75rem';
            existingStatusBadge.style.fontWeight = 'bold';
            calibrateBtn.appendChild(existingStatusBadge);
        }

        const lang = this.settings.voiceLanguage || 'zh-HK';
        if (isCal) {
            existingStatusBadge.className = 'status-badge calibrated';
            existingStatusBadge.style.background = 'rgba(0, 255, 136, 0.15)';
            existingStatusBadge.style.color = '#00ff88';
            existingStatusBadge.style.border = '1px solid #00ff88';
            
            if (lang === 'zh-HK') {
                existingStatusBadge.innerHTML = `已校準 (${mode}) ✓`;
            } else if (lang === 'zh-CN') {
                existingStatusBadge.innerHTML = `已校准 (${mode}) ✓`;
            } else {
                existingStatusBadge.innerHTML = `Calibrated (${mode}) ✓`;
            }
        } else {
            existingStatusBadge.className = 'status-badge uncalibrated';
            existingStatusBadge.style.background = 'rgba(255, 64, 129, 0.15)';
            existingStatusBadge.style.color = '#ff4081';
            existingStatusBadge.style.border = '1px solid #ff4081';
            
            if (lang === 'zh-HK') {
                existingStatusBadge.innerHTML = `未校準 ✗`;
            } else if (lang === 'zh-CN') {
                existingStatusBadge.innerHTML = `未校准 ✗`;
            } else {
                existingStatusBadge.innerHTML = `Not Calibrated ✗`;
            }
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
        if (mode === MODE.ZEN) {
            this.spawnInterval = 3500; // Relaxed pacing for Zen Practice Mode
        } else {
            this.spawnInterval = mode === MODE.SURVIVAL ? 2800 : 2500;
        }
        // Use configurable round duration (Time Attack only; other modes are open-ended)
        this.gameDuration = (this.settings.roundDurationSec || 60) * 1000;
        this.startTime   = performance.now();

        this._hideAllScreens();
        this._showHUD(mode);
        this._updateHUD();

        // Start background music after the user's click gesture (satisfies autoplay policy)
        this._startBgMusic();

        // Speak starting guidance
        if (mode === MODE.ZEN) {
            this._speak("Let's practice! Follow the targets with your eyes, and hold your gaze steady to pop them.");
        } else {
            this._speak(`Starting ${modeLabel(mode)}! Get ready, three, two, one, go!`);
        }

        await this._updateTrackingMode();
    }

    _endGame() {
        this.state = STATES.GAMEOVER;
        const accuracy = this.shots > 0
            ? Math.round((this.hits / this.shots) * 100) : 0;

        const elapsed = Math.round((performance.now() - this.startTime) / 1000);

        saveScore({ mode: this.mode, score: this.score, accuracy, elapsed, date: Date.now() });
        this.audio.playGameOver();
        this._stopBgMusic();
        this._hideHUD();
        this._showGameOver(accuracy, elapsed);
    }

    _pauseGame() {
        if (this.state !== STATES.PLAYING) return;
        this.state = STATES.PAUSED;
        this._pauseBgMusic();
        document.getElementById('pauseScreen').style.display = 'flex';
    }

    _resumeGame() {
        if (this.state !== STATES.PAUSED) return;
        this.state = STATES.PLAYING;
        this._resumeBgMusic();
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
        if (this.mode === MODE.ZEN) {
            document.getElementById('scoreDisplay').textContent = `Hits: ${this.hits}`;
            document.getElementById('accuracyDisplay').style.display = 'none';
        } else {
            document.getElementById('scoreDisplay').textContent = `Score: ${this.score}`;
            document.getElementById('accuracyDisplay').style.display = 'inline';
            const accuracy = this.shots > 0
                ? Math.round((this.hits / this.shots) * 100) : 100;
            document.getElementById('accuracyDisplay').textContent = `Acc: ${accuracy}%`;
        }
        document.getElementById('eyeStatus').textContent = this._getEyeStatusText();

        const nowMs = performance.now() - this.startTime;
        const gracePeriodMs = (this.settings.gracePeriodSec || 0) * 1000;
        const graceRemaining = Math.ceil(Math.max(0, gracePeriodMs - nowMs) / 1000);

        if (this.mode === MODE.TIME_ATTACK) {
            if (graceRemaining > 0) {
                document.getElementById('timerDisplay').textContent = `⏳ Grace: ${graceRemaining}s`;
            } else {
                const remaining = Math.max(0, Math.ceil((this.gameDuration - nowMs) / 1000));
                document.getElementById('timerDisplay').textContent = `Time: ${remaining}s`;
            }
        } else if (this.mode === MODE.SURVIVAL) {
            if (graceRemaining > 0) {
                document.getElementById('timerDisplay').textContent = `⏳ Grace: ${graceRemaining}s`;
            } else {
                const elapsed = Math.floor(nowMs / 1000);
                document.getElementById('timerDisplay').textContent = `Time: ${elapsed}s`;
            }
        } else if (this.mode === MODE.PRECISION) {
            document.getElementById('timerDisplay').textContent =
                `Round: ${this.precisionRounds}/${this.precisionTotal}`;
        } else if (this.mode === MODE.ZEN) {
            const elapsed = Math.floor(nowMs / 1000);
            const m = Math.floor(elapsed / 60);
            const s = elapsed % 60;
            document.getElementById('timerDisplay').textContent = `Practice: ${m}:${s.toString().padStart(2, '0')}`;
        }
    }

    _updateLivesBar() {
        const pct = Math.max(0, (this.lives / 5) * 100);
        document.getElementById('healthFill').style.width = `${pct}%`;
    }

    // ── Screen management ─────────────────────────────────────────

    _hideAllScreens() {
        ['loadingScreen', 'menuScreen', 'settingsScreen', 'gameoverScreen', 'calibrationGuideModal'].forEach(id => {
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
        if (!visible) {
            this.cameraPreview.style.left = 'auto';
            this.cameraPreview.style.right = '16px';
            this.cameraPreview.style.top = 'auto';
            this.cameraPreview.style.bottom = '16px';
        }
    }

    async _initMediaPipe(onProgress) {
        if (this._mediaPipeInitialized) return;
        if (window.Module) {
            try { delete window.Module; } catch (e) { window.Module = undefined; }
        }
        try {
            delete window.createMediapipeSolutionsWasm;
            delete window.createMediapipeSolutionsPackedAssets;
        } catch (e) {}
        await this.tracker.init(onProgress);
        this.tracker.onBlink(() => this._shoot());
        this._mediaPipeInitialized = true;
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
            const tracker = webgazer.getTracker();
            const predictionReady = tracker && (
                tracker.predictionReady === true || 
                (typeof tracker.getPositions === 'function' && tracker.getPositions() && tracker.getPositions().length > 0)
            );

            if (predictionReady) {
                this.webgazerDetected = true;
                if (data) {
                    this.webgazerRawX = data.x;
                    this.webgazerRawY = data.y;
                } else {
                    // Fallback when WebGazer regression data is null (e.g. before calibration)
                    const positions = typeof tracker.getPositions === 'function' ? tracker.getPositions() : null;
                    if (positions && positions.length > 0) {
                        let sumX = 0, sumY = 0;
                        for (let i = 0; i < positions.length; i++) {
                            sumX += positions[i][0];
                            sumY += positions[i][1];
                        }
                        const avgX = sumX / positions.length;
                        const avgY = sumY / positions.length;

                        const video = document.getElementById('webgazerVideoFeed');
                        const w = (video && video.videoWidth) || 320;
                        const h = (video && video.videoHeight) || 240;

                        const normX = avgX / w;
                        const normY = avgY / h;

                        const scaleX = 3.0;
                        const scaleY = 3.0;

                        const mappedX = 0.5 + ((1 - normX) - 0.5) * scaleX;
                        const mappedY = 0.5 + (normY - 0.5) * scaleY;

                        const clampedX = Math.max(0, Math.min(1, mappedX));
                        const clampedY = Math.max(0, Math.min(1, mappedY));

                        this.webgazerRawX = clampedX * window.innerWidth;
                        this.webgazerRawY = clampedY * window.innerHeight;
                    }
                }
            } else {
                this.webgazerDetected = false;
            }
        });

        // Clear global Emscripten Module and other MediaPipe properties to prevent clash
        if (window.Module) {
            try {
                delete window.Module;
            } catch (e) {
                window.Module = undefined;
            }
        }
        try {
            delete window.createMediapipeSolutionsWasm;
            delete window.createMediapipeSolutionsPackedAssets;
        } catch (e) {}

        try {
            webgazer.saveDataAcrossSessions(true);
        } catch (err) {
            console.warn('Failed to enable WebGazer cross-session saving:', err);
        }

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
            webgazer.removeMouseEventListeners();
        } catch (err) {
            console.warn('Failed to hide WebGazer default UI elements or remove mouse listeners:', err);
        }

        this._webgazerInitialized = true;
    }

    async _updateTrackingMode() {
        const mode = this.settings.trackingMode;
        if (mode === 'webgazer') {
            try {
                if (this._mediaPipeInitialized) {
                    try {
                        await this.tracker.close();
                    } catch (e) {
                        console.warn('Failed to close MediaPipe tracker:', e);
                    }
                    this._mediaPipeInitialized = false;
                }

                // Release the webcam resource on our own element to prevent conflicts in Safari
                if (this.video.srcObject) {
                    const stream = this.video.srcObject;
                    for (const track of stream.getTracks()) {
                        track.stop();
                    }
                    this.video.srcObject = null;
                }

                // Add a small delay to let the OS release the webcam device lock completely
                await _sleep(450);

                // Clean the global namespace so WebGazer face mesh loads cleanly
                if (window.Module) {
                    try { delete window.Module; } catch (e) { window.Module = undefined; }
                }
                try {
                    delete window.createMediapipeSolutionsWasm;
                    delete window.createMediapipeSolutionsPackedAssets;
                } catch (e) {}

                if (!this._webgazerInitialized) {
                    await this._initWebGazer();
                } else {
                    webgazer.resume();
                    try {
                        webgazer.removeMouseEventListeners();
                    } catch (e) {
                        console.warn('Failed to remove WebGazer mouse listeners on resume:', e);
                    }
                }
            } catch (err) {
                console.error('Error enabling WebGazer tracking mode:', err);
                alert('WebGazer Eyeball Tracking Failed\n\n' + (err.message || 'An unknown error occurred during WebGazer initialization.') + '\n\nPlease check camera permissions or use Iris Tracking (MediaPipe) in Settings instead.');
                
                if (this._webgazerInitialized) {
                    try {
                        webgazer.pause();
                    } catch (pauseErr) {
                        console.warn('Failed to pause WebGazer:', pauseErr);
                    }
                }
            }
        } else {
            // mode === 'mediapipe'
            if (!this._mediaPipeInitialized) {
                try {
                    await this._initMediaPipe();
                } catch (err) {
                    console.error('Failed to initialize MediaPipe on mode switch:', err);
                    alert('MediaPipe Initialization Failed\n\n' + (err.message || 'An unknown error occurred during MediaPipe initialization.'));
                    return;
                }
            }

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
            aimAssist: 'normal',
            triggerMode: 'auto',
            gazeSmoothing: 'normal',
            safeAreaMargin: '0.09',
            targetScale: '1.0',
            gazeSensitivity: '1.0',
            targetTheme: 'bubbles',
            voiceGuidance: true,
            voiceLanguage: 'zh-HK',
            calibrationPoints: '9',
            // New settings
            gazeDwellMs: 2000,
            roundDurationSec: 60,
            gracePeriodSec: 5,
            showCalibrationGuide: true,
            targetMode: 'default',
            audioVolume: 0.7,
            audioLoop: true,
            audioMuted: false,
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
                aimAssist: (parsed.aimAssist === 'high' || parsed.aimAssist === 'off') ? parsed.aimAssist : 'normal',
                triggerMode: ['blink', 'auto', 'dwell_short', 'dwell_medium', 'dwell_long', 'dwell_custom'].includes(parsed.triggerMode) ? parsed.triggerMode : defaults.triggerMode,
                gazeSmoothing: ['normal', 'high', 'heavy'].includes(parsed.gazeSmoothing) ? parsed.gazeSmoothing : defaults.gazeSmoothing,
                safeAreaMargin: typeof parsed.safeAreaMargin === 'string' ? parsed.safeAreaMargin : defaults.safeAreaMargin,
                targetScale: typeof parsed.targetScale === 'string' ? parsed.targetScale : defaults.targetScale,
                gazeSensitivity: typeof parsed.gazeSensitivity === 'string' ? parsed.gazeSensitivity : defaults.gazeSensitivity,
                targetTheme: ['bubbles', 'emojis', 'stars'].includes(parsed.targetTheme) ? parsed.targetTheme : defaults.targetTheme,
                voiceGuidance: parsed.voiceGuidance !== undefined ? Boolean(parsed.voiceGuidance) : defaults.voiceGuidance,
                voiceLanguage: ['en', 'zh-HK', 'zh-CN'].includes(parsed.voiceLanguage) ? parsed.voiceLanguage : defaults.voiceLanguage,
                calibrationPoints: ['9', '5', '3'].includes(parsed.calibrationPoints) ? parsed.calibrationPoints : defaults.calibrationPoints,
                // New settings
                gazeDwellMs: (typeof parsed.gazeDwellMs === 'number') ? Math.min(4000, Math.max(1000, parsed.gazeDwellMs)) : defaults.gazeDwellMs,
                roundDurationSec: (typeof parsed.roundDurationSec === 'number') ? Math.min(300, Math.max(30, parsed.roundDurationSec)) : defaults.roundDurationSec,
                gracePeriodSec: (typeof parsed.gracePeriodSec === 'number') ? Math.min(15, Math.max(0, parsed.gracePeriodSec)) : defaults.gracePeriodSec,
                showCalibrationGuide: parsed.showCalibrationGuide !== undefined ? Boolean(parsed.showCalibrationGuide) : defaults.showCalibrationGuide,
                targetMode: parsed.targetMode === 'custom' ? 'custom' : 'default',
                audioVolume: (typeof parsed.audioVolume === 'number') ? Math.min(1, Math.max(0, parsed.audioVolume)) : defaults.audioVolume,
                audioLoop: parsed.audioLoop !== undefined ? Boolean(parsed.audioLoop) : defaults.audioLoop,
                audioMuted: parsed.audioMuted !== undefined ? Boolean(parsed.audioMuted) : defaults.audioMuted,
            };
        } catch {
            return defaults;
        }
    }

    _updateGazeAlpha() {
        const smoothing = this.settings.gazeSmoothing || 'normal';
        if (smoothing === 'heavy') {
            this._gazeAlpha = 0.05;
        } else if (smoothing === 'high') {
            this._gazeAlpha = 0.10;
        } else {
            this._gazeAlpha = 0.20;
        }

        if (this.tracker) {
            this.tracker.setSmoothingAlpha(this._gazeAlpha);
        }
    }

    _selectFemaleVoice(lang) {
        if (!window.speechSynthesis) return null;
        const voices = window.speechSynthesis.getVoices();
        if (!voices || voices.length === 0) return null;

        const langLower = lang.toLowerCase();
        let candidateVoices = [];

        // Step 1: Filter voices compatible with the requested language code
        if (langLower === 'zh-hk') {
            candidateVoices = voices.filter(v => {
                const vl = v.lang.toLowerCase();
                const name = v.name.toLowerCase();
                return vl.startsWith('zh-hk') || 
                       vl.replace('_', '-').startsWith('zh-hk') ||
                       vl.includes('-hk') ||
                       name.includes('cantonese') ||
                       name.includes('hong kong') ||
                       name.includes('粵語') ||
                       name.includes('粤语');
            });
            if (candidateVoices.length === 0) {
                candidateVoices = voices.filter(v => v.lang.toLowerCase().startsWith('zh'));
            }
        } else if (langLower === 'zh-cn') {
            candidateVoices = voices.filter(v => {
                const vl = v.lang.toLowerCase();
                const name = v.name.toLowerCase();
                return (vl.startsWith('zh-cn') || vl.replace('_', '-').startsWith('zh-cn') || vl.includes('-cn') || name.includes('mandarin') || name.includes('putonghua') || name.includes('普通话')) &&
                       !vl.includes('-hk') && !name.includes('cantonese') && !name.includes('粵語');
            });
            if (candidateVoices.length === 0) {
                candidateVoices = voices.filter(v => v.lang.toLowerCase().startsWith('zh'));
            }
        } else {
            candidateVoices = voices.filter(v => v.lang.toLowerCase().startsWith('en'));
        }

        if (candidateVoices.length === 0) {
            candidateVoices = voices;
        }

        // Step 2: Score each candidate voice (higher score is better)
        const scored = candidateVoices.map(voice => {
            const name = voice.name.toLowerCase();
            let score = 0;

            // Prioritize higher-quality remote neural voices (Microsoft Online Natural, Google Online, etc.)
            if (name.includes('natural') || name.includes('online') || name.includes('neural')) {
                score += 100;
            }
            if (name.includes('google')) {
                score += 40;
            }

            // Language-specific premium voice matching (female-first)
            if (langLower === 'zh-hk') {
                // Microsoft Neural (Tracy / Hiuting)
                if (name.includes('hiuting')) score += 150;
                if (name.includes('tracy')) score += 140;
                // Apple Premium (Sin-ji / Mei-Jia)
                if (name.includes('sinji') || name.includes('sin-ji')) score += 130;
                if (name.includes('mei-jia') || name.includes('meijia')) score += 110;
                if (name.includes('szeman')) score += 100;
                // Google Cantonese
                if (name.includes('粵語') || name.includes('粤语') || name.includes('cantonese')) score += 80;
                
                // Penalize male Cantonese voices / Mandarin fallback leakages
                if (name.includes('yunxi') || name.includes('yunyang') || name.includes('yunxiu') || name.includes('xiaoxuan')) {
                    score -= 50;
                }
                if (name.includes('dann') || name.includes('samuel') || name.includes('male') || name.includes('boy')) {
                    score -= 100;
                }
            } else if (langLower === 'zh-cn') {
                // Microsoft Neural (Xiaoxiao, Xiaoyi, Yaoyao)
                if (name.includes('xiaoxiao')) score += 150;
                if (name.includes('xiaoyi')) score += 140;
                if (name.includes('yaoyao')) score += 130;
                if (name.includes('xiaoni')) score += 120;
                // Apple Premium (Ting-ting)
                if (name.includes('ting-ting') || name.includes('tingting')) score += 110;
                // Google Mandarin
                if (name.includes('普通话') || name.includes('mandarin') || name.includes('chinese')) score += 80;
                
                // Penalize male Mandarin voices
                if (name.includes('yunxi') || name.includes('yunyang') || name.includes('yunjie') || name.includes('yunze') || name.includes('kangkang')) {
                    score -= 50;
                }
                if (name.includes('male') || name.includes('boy') || name.includes('man') || name.includes('dongdong')) {
                    score -= 100;
                }
            } else {
                // English: Sonia, Aria, Jenny, Samantha, Zira, Susan, Nicky, Lulu
                if (name.includes('sonia')) score += 150;
                if (name.includes('aria')) score += 140;
                if (name.includes('jenny')) score += 130;
                if (name.includes('samantha')) score += 120;
                if (name.includes('zira')) score += 100;
                if (name.includes('susan') || name.includes('nicky') || name.includes('lulu')) score += 90;
                
                // Penalize male English voices
                if (name.includes('david') || name.includes('guy') || name.includes('male') || name.includes('boy') || name.includes('man') || name.includes('mark') || name.includes('george')) {
                    score -= 100;
                }
            }

            // General gender metadata heuristic
            if (voice.gender === 'female') {
                score += 50;
            } else if (voice.gender === 'male') {
                score -= 100;
            }

            return { voice, score };
        });

        // Sort descending
        scored.sort((a, b) => b.score - a.score);
        
        if (scored.length > 0) {
            console.log(`[SpeechSynthesis] Voice selected for ${lang}: "${scored[0].voice.name}" (Score: ${scored[0].score}, Lang: ${scored[0].voice.lang})`);
            return scored[0].voice;
        }
        return null;
    }

    _speak(text) {
        if (!this.settings.voiceGuidance) return;
        if (!window.speechSynthesis) return;

        try {
            // Cancel current speaking to avoid voice lag
            window.speechSynthesis.cancel();

            const lang = this.settings.voiceLanguage || 'zh-HK';
            const translatedText = this._getTranslation(text, lang);

            const utterance = new SpeechSynthesisUtterance(translatedText);
            utterance.lang = lang;

            const voice = this._selectFemaleVoice(lang);
            if (voice) {
                utterance.voice = voice;
            }
            
            utterance.rate = 1.0;
            if (lang.startsWith('zh')) {
                utterance.rate = 0.95; // Slightly slower pacing for clearer Chinese pronunciation
            }
            utterance.pitch = 1.15; // Friendly higher pitch for kids
            window.speechSynthesis.speak(utterance);
        } catch (err) {
            console.warn('Speech synthesis failed:', err);
        }
    }

    _getTranslation(text, lang) {
        if (!lang || lang === 'en') return text;

        const cleanText = text.trim();

        // 1. Exact dictionary matches
        const exactDict = {
            'zh-HK': {
                "Calibration complete! Great job!": "校準完成啦！你做得好叻呀！",
                "Let's practice! Follow the targets with your eyes, and hold your gaze steady to pop them.": "我哋一齊練習啦！用對眼跟住目標，定定地望住佢就可以射爆佢啦。",
                "Awesome! 5 hits! You are doing great!": "好嘢！射中五個啦！做得好叻呀！",
                "Incredible! 10 hits! Superb focus!": "太好啦！射中十個啦！好有專注力呀！",
                "Amazing! 20 hits! You are an eye tracking champion!": "好神奇呀！射中二十個啦！你簡真係眼動追蹤大師呀！",
                "Woohoo! 30 hits! Outstanding control!": "嘩！射中三十個啦！控制得好完美呀！",
                "Forty hits! Absolutely brilliant!": "四十個啦！真係非常之聰明呀！",
                "Fifty hits! That is stellar! You are a master!": "五十個啦！簡直係奇蹟呀！你太厲害啦！"
            },
            'zh-CN': {
                "Calibration complete! Great job!": "校准完成啦！你做得太棒了！",
                "Let's practice! Follow the targets with your eyes, and hold your gaze steady to pop them.": "我们一起来练习吧！用眼睛跟着目标，盯着它就能把它击碎哦。",
                "Awesome! 5 hits! You are doing great!": "好棒！射中五个啦！做得真好！",
                "Incredible! 10 hits! Superb focus!": "不可思议！射中十个啦！专注力真棒！",
                "Amazing! 20 hits! You are an eye tracking champion!": "太神奇了！射中二十个啦！你简直是眼动追踪大师！",
                "Woohoo! 30 hits! Outstanding control!": "哇！射中三十个啦！控制得太完美了！",
                "Forty hits! Absolutely brilliant!": "四十个啦！真是太聪明太棒了！",
                "Fifty hits! That is stellar! You are a master!": "五十个啦！简直是奇迹！你太厉害了！"
            }
        };

        if (exactDict[lang] && exactDict[lang][cleanText]) {
            return exactDict[lang][cleanText];
        }

        // 2. Calibration start phrase
        const calibStartRegex = /Let's calibrate with (Quick 3 point|Medium 5 point|Standard 9 point) mode\. Look at the yellow star in the center\./i;
        const calibStartMatch = cleanText.match(calibStartRegex);
        if (calibStartMatch) {
            const modeName = calibStartMatch[1];
            if (lang === 'zh-HK') {
                const hkMode = modeName.includes('3') ? "快速三點" : (modeName.includes('5') ? "平衡五點" : "標準九點");
                return `我哋開始用${hkMode}模式校準。望住中間嘅黃色星星。`;
            }
            if (lang === 'zh-CN') {
                const cnMode = modeName.includes('3') ? "快速三点" : (modeName.includes('5') ? "平衡五点" : "标准九点");
                return `我们开始用${cnMode}模式校准。看着中间的黄色星星。`;
            }
        }

        // 3. Calibration point transit
        const transitRegex = /(.+?)\.\s*Now look at the yellow star in the\s*(.+?)\./i;
        const transitMatch = cleanText.match(transitRegex);
        if (transitMatch) {
            const praise = transitMatch[1].trim();
            const nextDesc = transitMatch[2].trim().replace(/\.$/, '');

            const praiseDict = {
                'zh-HK': {
                    "Good": "好呀", "Nice": "好叻", "Keep holding": "繼續望住", "Perfect": "好完美",
                    "Great": "真係好棒", "Excellent": "非常之好", "Well done": "做得好", "Almost there": "就快好啦"
                },
                'zh-CN': {
                    "Good": "真棒", "Nice": "很好", "Keep holding": "继续保持", "Perfect": "太完美了",
                    "Great": "做得太棒了", "Excellent": "非常优秀", "Well done": "做得好", "Almost there": "马上就好"
                }
            };

            const dirDict = {
                'zh-HK': {
                    "next target": "下一個目標", "top left": "左上角", "top center": "正上方", "top right": "右上角",
                    "middle left": "左邊中間", "center": "正中間", "middle right": "右邊中間", "bottom left": "左下角",
                    "bottom center": "正下方", "bottom right": "右下角",
                    "left side, slightly up": "左邊偏上", "right side, slightly down": "右邊偏下"
                },
                'zh-CN': {
                    "next target": "下一个目标", "top left": "左上角", "top center": "正上方", "top right": "右上角",
                    "middle left": "左边中间", "center": "正中间", "middle right": "右边中间", "bottom left": "左下角",
                    "bottom center": "正下方", "bottom right": "右下角",
                    "left side, slightly up": "左边偏上", "right side, slightly down": "右边偏下"
                }
            };

            const pTrans = (praiseDict[lang] && praiseDict[lang][praise]) || praise;
            const dTrans = (dirDict[lang] && dirDict[lang][nextDesc]) || nextDesc;

            if (lang === 'zh-HK') {
                return `${pTrans}。而家望住${dTrans}嘅黃色星星。`;
            }
            if (lang === 'zh-CN') {
                return `${pTrans}。现在看着${dTrans}的黄色星星。`;
            }
        }

        // 4. Starting game: "Starting [Mode]! Get ready, three, two, one, go!"
        const startingRegex = /Starting\s+(.+?)!\s*Get ready,\s*three,\s*two,\s*one,\s*go!/i;
        const startingMatch = cleanText.match(startingRegex);
        if (startingMatch) {
            const modeName = startingMatch[1].trim();
            const modeTrans = {
                'zh-HK': { "Time Attack": "限時挑戰", "Survival": "生存挑戰", "Precision": "精準挑戰", "Zen Practice": "無盡練習" },
                'zh-CN': { "Time Attack": "限时挑战", "Survival": "生存挑战", "Precision": "精准挑战", "Zen Practice": "无尽练习" }
            };
            const mTrans = (modeTrans[lang] && modeTrans[lang][modeName]) || modeName;
            if (lang === 'zh-HK') {
                return `${mTrans}模式開始！準備，三，二，一，出發！`;
            }
            if (lang === 'zh-CN') {
                return `${mTrans}模式开始！准备，三，二，一，出发！`;
            }
        }

        // 5. Zen milestone dynamic hits: "[h] hits! Unbelievable effort! Keep it up!"
        const hitsRegex = /^(\d+)\s+hits!\s*Unbelievable effort!\s*Keep it up!/i;
        const hitsMatch = cleanText.match(hitsRegex);
        if (hitsMatch) {
            const h = hitsMatch[1];
            if (lang === 'zh-HK') {
                return `${h}個啦！真係難以置信嘅努力！繼續加油呀！`;
            }
            if (lang === 'zh-CN') {
                return `${h}个啦！真是令人难以置信的努力！继续加油呀！`;
            }
        }

        // 6. Game over session result: "Great practice session! You popped [hits] targets. Wonderful focus!"
        const practiceEndRegex = /Great practice session!\s*You popped\s+(\d+)\s+targets\.\s*Wonderful focus!/i;
        const practiceEndMatch = cleanText.match(practiceEndRegex);
        if (practiceEndMatch) {
            const hits = practiceEndMatch[1];
            if (lang === 'zh-HK') {
                return `好棒嘅練習！你射爆咗 ${hits} 個目標。專注力真係好厲害！`;
            }
            if (lang === 'zh-CN') {
                return `好棒的练习！你射爆了 ${hits} 个目标。注意力真棒！`;
            }
        }

        // 7. Game over classic result: "Game over! Splendid effort! Your final score is [score] points with [accuracy]% accuracy."
        const gameOverRegex = /Game over!\s*Splendid effort!\s*Your final score is\s+(\d+)\s+points\s+with\s+(\d+)\s+percent\s+accuracy\./i;
        const gameOverMatch = cleanText.match(gameOverRegex);
        if (gameOverMatch) {
            const score = gameOverMatch[1];
            const accuracy = gameOverMatch[2];
            if (lang === 'zh-HK') {
                return `遊戲結束啦！非常之努力！你最後攞到 ${score} 分，同埋百分之 ${accuracy} 嘅準確度。`;
            }
            if (lang === 'zh-CN') {
                return `游戏结束啦！非常非常努力！你最后拿到了 ${score} 分，以及百分之 ${accuracy} 的准确度。`;
            }
        }

        return text;
    }

    _checkZenMilestones() {
        if (this.mode !== MODE.ZEN) return;
        const h = this.hits;
        if (h === 5) {
            this._speak("Awesome! 5 hits! You are doing great!");
        } else if (h === 10) {
            this._speak("Incredible! 10 hits! Superb focus!");
        } else if (h === 20) {
            this._speak("Amazing! 20 hits! You are an eye tracking champion!");
        } else if (h === 30) {
            this._speak("Woohoo! 30 hits! Outstanding control!");
        } else if (h === 40) {
            this._speak("Forty hits! Absolutely brilliant!");
        } else if (h === 50) {
            this._speak("Fifty hits! That is stellar! You are a master!");
        } else if (h > 50 && h % 20 === 0) {
            this._speak(`${h} hits! Unbelievable effort! Keep it up!`);
        }
    }

    _saveSettings() {
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(this.settings)); } catch { /* ignore */ }
    }

    _getAimAssistBuffer() {
        const assist = this.settings.aimAssist || 'normal';
        if (assist === 'high') return 55;
        if (assist === 'normal') return 30;
        return 0;
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

        const aimAssistEl = document.getElementById('aimAssistSelect');
        if (aimAssistEl) aimAssistEl.value = this.settings.aimAssist || 'normal';

        const triggerModeEl = document.getElementById('triggerModeSelect');
        if (triggerModeEl) triggerModeEl.value = this.settings.triggerMode || 'blink';

        const gazeSmoothingEl = document.getElementById('gazeSmoothingSelect');
        if (gazeSmoothingEl) gazeSmoothingEl.value = this.settings.gazeSmoothing || 'normal';

        const safeAreaMarginEl = document.getElementById('safeAreaMarginSelect');
        if (safeAreaMarginEl) safeAreaMarginEl.value = this.settings.safeAreaMargin || '0.09';

        const targetScaleEl = document.getElementById('targetScaleSelect');
        if (targetScaleEl) targetScaleEl.value = this.settings.targetScale || '1.0';

        const gazeSensitivityEl = document.getElementById('gazeSensitivitySelect');
        if (gazeSensitivityEl) gazeSensitivityEl.value = this.settings.gazeSensitivity || '1.0';

        const targetThemeEl = document.getElementById('targetThemeSelect');
        if (targetThemeEl) targetThemeEl.value = this.settings.targetTheme || 'bubbles';

        const voiceGuidanceEl = document.getElementById('voiceGuidanceCheckbox');
        if (voiceGuidanceEl) voiceGuidanceEl.checked = this.settings.voiceGuidance !== undefined ? this.settings.voiceGuidance : true;

        const voiceLanguageEl = document.getElementById('voiceLanguageSelect');
        if (voiceLanguageEl) voiceLanguageEl.value = this.settings.voiceLanguage || 'zh-HK';

        const calibrationPointsEl = document.getElementById('calibrationPointsSelect');
        if (calibrationPointsEl) calibrationPointsEl.value = this.settings.calibrationPoints || '9';

        // ── New settings controls ────────────────────────────────────
        // Custom dwell time slider
        const dwellSlider = document.getElementById('gazeDwellSlider');
        const dwellLabel  = document.getElementById('dwellTimeLabel');
        const customDwellGroup = document.getElementById('customDwellGroup');
        if (dwellSlider) dwellSlider.value = this.settings.gazeDwellMs || 2000;
        if (dwellLabel) dwellLabel.textContent = _formatSeconds(this.settings.gazeDwellMs || 2000);
        if (customDwellGroup) customDwellGroup.style.display = (this.settings.triggerMode === 'dwell_custom') ? '' : 'none';

        // Round duration + grace period sliders
        const roundSlider = document.getElementById('roundDurationSlider');
        const roundLabel  = document.getElementById('roundDurationLabel');
        const gracSlider  = document.getElementById('gracePeriodSlider');
        const gracLabel   = document.getElementById('gracePeriodLabel');
        if (roundSlider) roundSlider.value = this.settings.roundDurationSec || 60;
        if (roundLabel) roundLabel.textContent = `${this.settings.roundDurationSec || 60}s`;
        if (gracSlider) gracSlider.value = this.settings.gracePeriodSec || 5;
        if (gracLabel) gracLabel.textContent = `${this.settings.gracePeriodSec || 5}s`;

        // Custom target images toggle
        const customTargetsEl = document.getElementById('useCustomTargetsCheckbox');
        if (customTargetsEl) customTargetsEl.checked = this.settings.targetMode === 'custom';
        this._refreshImagePreviews();

        // Background music controls
        const bgMuteEl   = document.getElementById('bgMusicMuteCheckbox');
        const bgLoopEl   = document.getElementById('bgMusicLoopCheckbox');
        const bgVolSlider = document.getElementById('bgMusicVolumeSlider');
        const bgVolLabel  = document.getElementById('bgMusicVolumeLabel');
        const bgInfo      = document.getElementById('bgMusicInfo');
        if (bgMuteEl)    bgMuteEl.checked = this.settings.audioMuted || false;
        if (bgLoopEl)    bgLoopEl.checked = this.settings.audioLoop !== false;
        if (bgVolSlider) bgVolSlider.value = Math.round((this.settings.audioVolume ?? 0.7) * 100);
        if (bgVolLabel)  bgVolLabel.textContent = `${Math.round((this.settings.audioVolume ?? 0.7) * 100)}%`;
        if (bgInfo && this._bgMusicUrl) {
            bgInfo.textContent = this._bgMusicName ? `Loaded: ${this._bgMusicName}` : 'Custom track loaded';
        } else if (bgInfo) {
            bgInfo.textContent = 'No custom track. Default sounds only.';
        }

        // Calibration guide toggle
        const calGuideEl = document.getElementById('showCalibrationGuideCheckbox');
        if (calGuideEl) calGuideEl.checked = this.settings.showCalibrationGuide !== false;

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

        const liveTrackingMode = document.getElementById('trackingModeSelect')?.value || this.settings.trackingMode;

        if (liveTrackingMode === 'webgazer') {
            this.settings.cameraDeviceId = nextId;
            this.currentCameraDeviceId = nextId;
            this._saveSettings();

            if (this._webgazerInitialized) {
                try {
                    // Stop any existing WebGazer media stream tracks
                    const wgVideo = document.getElementById('webgazerVideoFeed');
                    if (wgVideo && wgVideo.srcObject) {
                        const stream = wgVideo.srcObject;
                        for (const track of stream.getTracks()) {
                            track.stop();
                        }
                        wgVideo.srcObject = null;
                    }

                    try {
                        webgazer.end();
                    } catch (e) {}
                    this._webgazerInitialized = false;

                    // Let hardware release the camera device completely
                    await _sleep(450);

                    // Re-init WebGazer which will trigger our global getUserMedia interceptor to request the new deviceId
                    await this._initWebGazer();
                } catch (err) {
                    console.error('Failed to switch WebGazer camera:', err);
                }
            }
        } else {
            await this._openCamera(nextId);
        }
        await this._refreshCameraList();
    }

    _getEyeStatusText() {
        const faceDetected = this.settings.trackingMode === 'webgazer' ? this.webgazerDetected : this.tracker.faceDetected;
        if (!faceDetected) return 'Eye: face not detected';
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

        // Speak game over results
        if (this.mode === MODE.ZEN) {
            this._speak(`Great practice session! You popped ${this.hits} targets. Wonderful focus!`);
        } else {
            this._speak(`Game over! Splendid effort! Your final score is ${this.score} points with ${accuracy} percent accuracy.`);
        }
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
        document.getElementById('zenBtn')?.addEventListener('click',
            () => this._startGame(MODE.ZEN));
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
                if (this._mediaPipeInitialized) {
                    try {
                        await this.tracker.close();
                    } catch (err) {
                        console.warn('Failed to close MediaPipe tracker during preview swap:', err);
                    }
                    this._mediaPipeInitialized = false;
                }

                // Explicitly stop this.video tracks first to prevent contention in Safari
                if (this.video.srcObject) {
                    const stream = this.video.srcObject;
                    for (const track of stream.getTracks()) {
                        track.stop();
                    }
                    this.video.srcObject = null;
                }

                // Wait for the hardware lock to completely release
                await _sleep(450);

                try {
                    if (!this._webgazerInitialized) {
                        await this._initWebGazer();
                    } else {
                        webgazer.resume();
                        try {
                            webgazer.removeMouseEventListeners();
                        } catch (e) {
                            console.warn('Failed to remove WebGazer mouse listeners on preview resume:', e);
                        }
                    }
                } catch (err) {
                    console.error('Failed to initialize or resume WebGazer for preview:', err);
                    alert('WebGazer Eyeball Tracking Failed\n\n' + (err.message || 'An unknown error occurred during WebGazer initialization.') + '\n\nPlease check camera permissions or select another mode.');
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
            const aimAssistEl = document.getElementById('aimAssistSelect');
            const triggerModeEl = document.getElementById('triggerModeSelect');
            const gazeSmoothingEl = document.getElementById('gazeSmoothingSelect');
            const safeAreaMarginEl = document.getElementById('safeAreaMarginSelect');
            const targetScaleEl = document.getElementById('targetScaleSelect');
            const gazeSensitivityEl = document.getElementById('gazeSensitivitySelect');
            const targetThemeEl = document.getElementById('targetThemeSelect');
            const voiceGuidanceEl = document.getElementById('voiceGuidanceCheckbox');
            const voiceLanguageEl = document.getElementById('voiceLanguageSelect');
            const calibrationPointsEl = document.getElementById('calibrationPointsSelect');
            if (!invertXEl || !invertYEl || !cameraSelectEl || !trackingModeEl || !aimAssistEl || !triggerModeEl || !gazeSmoothingEl || !safeAreaMarginEl || !targetScaleEl || !gazeSensitivityEl || !targetThemeEl || !voiceGuidanceEl || !calibrationPointsEl || !voiceLanguageEl) {
                this._showError('Settings controls unavailable.', 'Some settings controls are missing from the page. Please reload and try again.');
                return;
            }

            const invertX = invertXEl.checked;
            const invertY = invertYEl.checked;
            const cameraId = cameraSelectEl.value;
            const trackingMode = trackingModeEl.value;
            const aimAssist = aimAssistEl.value;
            const triggerMode = triggerModeEl.value;
            const gazeSmoothing = gazeSmoothingEl.value;
            const safeAreaMargin = safeAreaMarginEl.value;
            const targetScale = targetScaleEl.value;
            const gazeSensitivity = gazeSensitivityEl.value;
            const targetTheme = targetThemeEl.value;
            const voiceGuidance = voiceGuidanceEl.checked;
            const voiceLanguage = voiceLanguageEl.value;
            const calibrationPoints = calibrationPointsEl.value;

            // New settings
            const gazeDwellSlider = document.getElementById('gazeDwellSlider');
            const roundDurationSlider = document.getElementById('roundDurationSlider');
            const gracePeriodSlider = document.getElementById('gracePeriodSlider');
            const useCustomTargetsEl = document.getElementById('useCustomTargetsCheckbox');
            const bgMuteEl = document.getElementById('bgMusicMuteCheckbox');
            const bgLoopEl = document.getElementById('bgMusicLoopCheckbox');
            const bgVolSlider = document.getElementById('bgMusicVolumeSlider');
            const calGuideEl = document.getElementById('showCalibrationGuideCheckbox');
            const gazeDwellMs = gazeDwellSlider ? parseInt(gazeDwellSlider.value) : (this.settings.gazeDwellMs || 2000);
            const roundDurationSec = roundDurationSlider ? parseInt(roundDurationSlider.value) : (this.settings.roundDurationSec || 60);
            const gracePeriodSec = gracePeriodSlider ? parseInt(gracePeriodSlider.value) : (this.settings.gracePeriodSec || 5);
            const targetMode = (useCustomTargetsEl && useCustomTargetsEl.checked && this._customImages.length > 0) ? 'custom' : 'default';
            const audioMuted = bgMuteEl ? bgMuteEl.checked : this.settings.audioMuted;
            const audioLoop = bgLoopEl ? bgLoopEl.checked : this.settings.audioLoop;
            const audioVolume = bgVolSlider ? parseInt(bgVolSlider.value) / 100 : this.settings.audioVolume;
            const showCalibrationGuide = calGuideEl ? calGuideEl.checked : this.settings.showCalibrationGuide;

            try {
                await this._applyCameraSelection(cameraId);
                this.settings.invertX = invertX;
                this.settings.invertY = invertY;
                this.settings.trackingMode = trackingMode;
                this.settings.aimAssist = aimAssist;
                this.settings.triggerMode = triggerMode;
                this.settings.gazeSmoothing = gazeSmoothing;
                this.settings.safeAreaMargin = safeAreaMargin;
                this.settings.targetScale = targetScale;
                this.settings.gazeSensitivity = gazeSensitivity;
                this.settings.targetTheme = targetTheme;
                this.settings.voiceGuidance = voiceGuidance;
                this.settings.voiceLanguage = voiceLanguage;
                this.settings.calibrationPoints = calibrationPoints;
                this.settings.cameraDeviceId = this.currentCameraDeviceId || cameraId || '';
                // New settings
                this.settings.gazeDwellMs = gazeDwellMs;
                this.settings.roundDurationSec = roundDurationSec;
                this.settings.gracePeriodSec = gracePeriodSec;
                this.settings.targetMode = targetMode;
                this.settings.audioMuted = audioMuted;
                this.settings.audioLoop = audioLoop;
                this.settings.audioVolume = audioVolume;
                this.settings.showCalibrationGuide = showCalibrationGuide;
                // Apply audio preferences immediately
                if (this._bgAudio) {
                    this._bgAudio.volume = audioVolume;
                    this._bgAudio.muted  = audioMuted;
                    this._bgAudio.loop   = audioLoop;
                }
                this._saveSettings();
                this._updateGazeAlpha();
                await this._updateTrackingMode();
                this._closeSettings(false);
            } catch (err) {
                this._showError('Failed to switch camera.', err.message);
            }
        });

        // Trigger mode change — show/hide custom dwell slider
        document.getElementById('triggerModeSelect')?.addEventListener('change', (e) => {
            const customDwellGroup = document.getElementById('customDwellGroup');
            if (customDwellGroup) customDwellGroup.style.display = (e.target.value === 'dwell_custom') ? '' : 'none';
        });

        // Live label updates for range sliders
        document.getElementById('gazeDwellSlider')?.addEventListener('input', (e) => {
            const label = document.getElementById('dwellTimeLabel');
            if (label) label.textContent = _formatSeconds(parseInt(e.target.value));
        });
        document.getElementById('roundDurationSlider')?.addEventListener('input', (e) => {
            const label = document.getElementById('roundDurationLabel');
            if (label) label.textContent = `${e.target.value}s`;
        });
        document.getElementById('gracePeriodSlider')?.addEventListener('input', (e) => {
            const label = document.getElementById('gracePeriodLabel');
            if (label) label.textContent = `${e.target.value}s`;
        });
        document.getElementById('bgMusicVolumeSlider')?.addEventListener('input', (e) => {
            const label = document.getElementById('bgMusicVolumeLabel');
            if (label) label.textContent = `${e.target.value}%`;
            // Live volume preview
            if (this._bgAudio) this._bgAudio.volume = parseInt(e.target.value) / 100;
        });

        // Custom target image upload
        document.getElementById('targetImageUpload')?.addEventListener('change', async (e) => {
            const errorEl = document.getElementById('targetImageError');
            if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
            const files = Array.from(e.target.files || []);
            const MAX_IMAGES = 10;
            const MAX_SIZE   = MAX_IMAGE_SIZE_BYTES;
            const ALLOWED    = ['image/png', 'image/jpeg', 'image/webp'];

            if (this._customImages.length + files.length > MAX_IMAGES) {
                if (errorEl) { errorEl.style.display = ''; errorEl.textContent = `Maximum ${MAX_IMAGES} images allowed. Remove some first.`; }
                e.target.value = '';
                return;
            }

            for (const file of files) {
                if (!ALLOWED.includes(file.type)) {
                    if (errorEl) { errorEl.style.display = ''; errorEl.textContent = `"${file.name}" is not a supported image (PNG/JPG/WebP).`; }
                    e.target.value = '';
                    return;
                }
                if (file.size > MAX_SIZE) {
                    if (errorEl) { errorEl.style.display = ''; errorEl.textContent = `"${file.name}" exceeds the 2 MB limit.`; }
                    e.target.value = '';
                    return;
                }
            }

            for (const file of files) {
                let id = null;
                const blob = file.slice(0, file.size, file.type);
                if (this._assetStore.db) {
                    id = await this._assetStore.addImage(file.name, file.type, blob).catch(() => null);
                }
                const url = URL.createObjectURL(blob);
                this._customImages.push({ id, name: file.name, url });
                _getCachedImage(url); // pre-load
            }
            this._refreshImagePreviews();
            e.target.value = '';
        });

        // Background music upload
        document.getElementById('bgMusicUpload')?.addEventListener('change', async (e) => {
            const errorEl = document.getElementById('bgMusicError');
            const infoEl  = document.getElementById('bgMusicInfo');
            if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

            const file = e.target.files && e.target.files[0];
            if (!file) return;

            if (file.type !== 'audio/mpeg' && !file.name.toLowerCase().endsWith('.mp3')) {
                if (errorEl) { errorEl.style.display = ''; errorEl.textContent = 'Only MP3 files are supported.'; }
                e.target.value = '';
                return;
            }
            const MAX_AUDIO = MAX_AUDIO_SIZE_BYTES;
            if (file.size > MAX_AUDIO) {
                if (errorEl) { errorEl.style.display = ''; errorEl.textContent = 'File exceeds the 20 MB limit.'; }
                e.target.value = '';
                return;
            }

            // Revoke old blob URL if any
            if (this._bgMusicUrl) {
                URL.revokeObjectURL(this._bgMusicUrl);
                this._bgMusicUrl = null;
            }

            const blob = file.slice(0, file.size, file.type);
            this._bgMusicUrl  = URL.createObjectURL(blob);
            this._bgMusicName = file.name;
            if (this._bgAudio) {
                this._bgAudio.src = this._bgMusicUrl;
                this._bgAudio.load();
            }
            if (infoEl) infoEl.textContent = `Loaded: ${file.name}`;

            // Persist to IndexedDB
            if (this._assetStore.db) {
                await this._assetStore.setAudio(file.name, blob).catch(err => console.warn('Could not save audio to DB:', err));
            }
            e.target.value = '';
        });

        // Remove background music
        document.getElementById('removeBgMusicBtn')?.addEventListener('click', async () => {
            if (this._bgMusicUrl) URL.revokeObjectURL(this._bgMusicUrl);
            this._bgMusicUrl  = null;
            this._bgMusicName = null;
            if (this._bgAudio) { this._bgAudio.pause(); this._bgAudio.removeAttribute('src'); this._bgAudio.load(); }
            const infoEl = document.getElementById('bgMusicInfo');
            if (infoEl) infoEl.textContent = 'No custom track. Default sounds only.';
            if (this._assetStore.db) await this._assetStore.deleteAudio().catch(() => {});
        });

        // Calibration guide modal buttons
        document.getElementById('startCalibrationFromGuideBtn')?.addEventListener('click',
            () => this._beginCalibration());
        document.getElementById('skipCalibrationGuideBtn')?.addEventListener('click',
            () => this._beginCalibration());

        // Reset settings to defaults
        document.getElementById('resetSettingsBtn')?.addEventListener('click', async () => {
            const defaults = this._defaultSettings();
            // Keep camera ID so the camera stays connected
            const keepCameraId = this.settings.cameraDeviceId;
            Object.assign(this.settings, defaults);
            this.settings.cameraDeviceId = keepCameraId;
            this._saveSettings();
            this._updateGazeAlpha();
            try {
                await this._openSettings();
            } catch (err) {
                console.error('Failed to reload settings panel after reset:', err);
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
        document.getElementById('pauseMenuBtn')?.addEventListener('click', () => {
            this._hideAllScreens();
            document.getElementById('pauseScreen').style.display = 'none';
            this._goToMenu();
        });

        // Error retry
        document.getElementById('retryBtn')?.addEventListener('click',
            () => location.reload());

        // Also allow clicking canvas to shoot (mobile-friendly fallback)
        this.canvas.addEventListener('click', () => {
            if (this.state === STATES.PLAYING) this._shoot();
        });
    }

    // ── Custom image helpers ───────────────────────────────────────

    async _loadCustomImages() {
        if (!this._assetStore.db) return;
        const records = await this._assetStore.getAllImages().catch(() => []);
        this._customImages = records.map(r => ({
            id:   r.id,
            name: r.name,
            url:  URL.createObjectURL(r.blob),
        }));
        this._customImages.forEach(img => _getCachedImage(img.url));
        this._refreshImagePreviews();
    }

    _refreshImagePreviews() {
        const container = document.getElementById('targetImagePreviews');
        if (!container) return;
        container.innerHTML = '';
        for (const img of this._customImages) {
            const wrap = document.createElement('div');
            wrap.className = 'image-preview-item';

            const thumb = document.createElement('img');
            thumb.src = img.url;
            thumb.alt = img.name;
            wrap.appendChild(thumb);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'image-preview-remove';
            removeBtn.title = `Remove ${img.name}`;
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', async () => {
                // Revoke object URL
                URL.revokeObjectURL(img.url);
                _imgCache.delete(img.url);
                // Remove from DB
                if (this._assetStore.db && img.id !== null && img.id !== undefined) {
                    await this._assetStore.deleteImage(img.id).catch(() => {});
                }
                // Remove from array
                this._customImages = this._customImages.filter(i => i !== img);
                // If no images remain, switch back to default mode
                if (this._customImages.length === 0 && this.settings.targetMode === 'custom') {
                    this.settings.targetMode = 'default';
                    const el = document.getElementById('useCustomTargetsCheckbox');
                    if (el) el.checked = false;
                }
                this._refreshImagePreviews();
            });
            wrap.appendChild(removeBtn);
            container.appendChild(wrap);
        }
    }

    // ── Custom audio helpers ───────────────────────────────────────

    async _loadCustomAudio() {
        if (!this._assetStore.db) return;
        const record = await this._assetStore.getAudio().catch(() => null);
        if (record && record.blob) {
            if (this._bgMusicUrl) URL.revokeObjectURL(this._bgMusicUrl);
            this._bgMusicUrl  = URL.createObjectURL(record.blob);
            this._bgMusicName = record.name;
        }
    }

    _startBgMusic() {
        if (!this._bgAudio || !this._bgMusicUrl) return;
        if (this._bgAudio.src !== this._bgMusicUrl) {
            this._bgAudio.src = this._bgMusicUrl;
            this._bgAudio.load();
        }
        this._bgAudio.play().catch(err => console.warn('Background music play blocked:', err));
    }

    _stopBgMusic() {
        if (!this._bgAudio) return;
        this._bgAudio.pause();
        this._bgAudio.currentTime = 0;
    }

    _pauseBgMusic() {
        if (!this._bgAudio) return;
        this._bgAudio.pause();
    }

    _resumeBgMusic() {
        if (!this._bgAudio || !this._bgMusicUrl) return;
        this._bgAudio.play().catch(() => {});
    }
}


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
