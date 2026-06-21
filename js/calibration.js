/**
 * calibration.js
 * 9-point gaze calibration system.
 *
 * Renders a 3×3 grid of calibration targets onto a canvas.
 * For each point the system waits 1 s (fixation) then collects
 * raw iris positions for 2 s, averages them, and stores the
 * (irisX, irisY) → (screenX, screenY) mapping.
 *
 * After all 9 points a least-squares affine transform is computed:
 *   screenX = aX·iX + bX·iY + cX
 *   screenY = aY·iX + bY·iY + cY
 *
 * The calibration parameters are persisted in localStorage.
 */

const GRID_MARGIN = 0.1;          // 10 % padding from screen edges
const COUNTDOWN_MS = 1200;        // look-at-dot phase
const COLLECT_MS   = 2000;        // data-collection phase

const POINT_DESCRIPTIONS_9 = [
    "top left",
    "top center",
    "top right",
    "middle left",
    "center",
    "middle right",
    "bottom left",
    "bottom center",
    "bottom right"
];

const POINT_DESCRIPTIONS_5 = [
    "center",
    "middle left",
    "middle right",
    "top center",
    "bottom center"
];

const POINT_DESCRIPTIONS_3 = [
    "center",
    "left side, slightly up",
    "right side, slightly down"
];


/** Generate the 9 screen positions in reading order (row-major). */
function makeCalibrationPoints() {
    const pts = [];
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
            pts.push({
                x: GRID_MARGIN + (col / 2) * (1 - 2 * GRID_MARGIN),
                y: GRID_MARGIN + (row / 2) * (1 - 2 * GRID_MARGIN),
            });
        }
    }
    return pts;
}

export class CalibrationSystem {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {import('./eyetracker.js').EyeTracker} eyeTracker
     */
    constructor(canvas, eyeTracker) {
        this.canvas     = canvas;
        this.eyeTracker = eyeTracker;

        this.points = makeCalibrationPoints();

        // Runtime state
        this._active    = false;
        this._pointIdx  = 0;
        this._phase     = 'countdown';   // 'countdown' | 'collect'
        this._phaseStart = 0;
        this._buffer    = [];            // raw iris samples
        this._data      = [];            // {irisX,irisY,screenX,screenY}

        // Affine transform coefficients  [a, b, c]
        this.transformX = null;          // screenX = a·ix + b·iy + c (mediapipe)
        this.transformY = null;          // screenY = d·ix + e·iy + f (mediapipe)
        this.webgazerTransformX = null;  // screenX = a·wx + b·wy + c (webgazer)
        this.webgazerTransformY = null;  // screenY = d·wx + e·wy + f (webgazer)

        this._onComplete = null;
        this._lastWebGazerRecordTime = 0;

        // Try to restore a previous calibration immediately
        this._loadFromStorage();
    }

    // ── Lifecycle ──────────────────────────────────────────────────

    /**
     * Begin the calibration sequence.
     * @param {function(boolean):void} onComplete  called with true on success
     */
    start(onComplete) {
        this._onComplete = onComplete;
        this._active     = true;
        this._pointIdx   = 0;
        this._phase      = 'countdown';
        this._phaseStart = performance.now();
        this._buffer     = [];
        this._data       = [];
        this._lastWebGazerRecordTime = 0;

        // Dynamically generate points based on current settings
        const margin = parseFloat(window.game?.settings?.safeAreaMargin || '0.09');
        const calPointsMode = parseInt(window.game?.settings?.calibrationPoints || '9');

        if (calPointsMode === 3) {
            // Triangle layout to avoid collinearity and singularity issues in the affine solver
            this.points = [
                { x: 0.5, y: 0.5 },                  // Center
                { x: margin, y: 0.5 - 0.15 },        // Left, slightly up
                { x: 1 - margin, y: 0.5 + 0.15 }     // Right, slightly down
            ];
        } else if (calPointsMode === 5) {
            // Cross shape layout
            this.points = [
                { x: 0.5, y: 0.5 },                  // Center
                { x: margin, y: 0.5 },               // Left
                { x: 1 - margin, y: 0.5 },           // Right
                { x: 0.5, y: margin },               // Top
                { x: 0.5, y: 1 - margin }            // Bottom
            ];
        } else {
            // Standard 9-Point Grid
            this.points = [];
            for (let row = 0; row < 3; row++) {
                for (let col = 0; col < 3; col++) {
                    this.points.push({
                        x: margin + (col / 2) * (1 - 2 * margin),
                        y: margin + (row / 2) * (1 - 2 * margin),
                    });
                }
            }
        }

        if (window.webgazer && window.game?.settings?.trackingMode === 'webgazer') {
            try {
                window.webgazer.clearData();
            } catch (err) {
                console.warn('Failed to clear WebGazer data:', err);
            }
        }

        if (window.game && window.game._speak) {
            const calPointsMode = parseInt(window.game?.settings?.calibrationPoints || '9');
            const modeText = calPointsMode === 3 ? "Quick 3 point" : (calPointsMode === 5 ? "Medium 5 point" : "Standard 9 point");
            window.game._speak(`Let's calibrate with ${modeText} mode. Look at the yellow star in the center.`);
        }
    }

    /**
     * Drive the calibration state machine.
     * Call once per animation frame while calibration is active.
     * @param {DOMHighResTimeStamp} timestamp
     */
    update(timestamp) {
        if (!this._active) return;

        const elapsed = timestamp - this._phaseStart;
        const current = this.points[this._pointIdx];

        if (this._phase === 'countdown') {
            if (elapsed >= COUNTDOWN_MS) {
                this._phase      = 'collect';
                this._phaseStart = timestamp;
                this._buffer     = [];
            }
            return;
        }

        // --- collect phase ---
        const isWebGazer = window.game?.settings?.trackingMode === 'webgazer';
        if (isWebGazer) {
            if (window.game?.webgazerDetected) {
                this._buffer.push({
                    irisX: window.game.webgazerRawX / window.innerWidth,
                    irisY: window.game.webgazerRawY / window.innerHeight,
                });
            }
        } else {
            if (this.eyeTracker.faceDetected) {
                this._buffer.push({
                    irisX: this.eyeTracker.rawGazeX,
                    irisY: this.eyeTracker.rawGazeY,
                });
            }
        }

        if (window.webgazer && isWebGazer) {
            const now = performance.now();
            if (now - this._lastWebGazerRecordTime >= 400) {
                this._lastWebGazerRecordTime = now;
                const xPixels = current.x * window.innerWidth;
                const yPixels = current.y * window.innerHeight;
                try {
                    window.webgazer.recordScreenPosition(xPixels, yPixels, 'click');
                } catch (err) {
                    // Ignore silent errors during recordScreenPosition
                }
            }
        }

        if (elapsed >= COLLECT_MS) {
            if (this._buffer.length >= 5) {
                const n    = this._buffer.length;
                const avgX = this._buffer.reduce((s, p) => s + p.irisX, 0) / n;
                const avgY = this._buffer.reduce((s, p) => s + p.irisY, 0) / n;
                this._data.push({ irisX: avgX, irisY: avgY, screenX: current.x, screenY: current.y });
            }

            this._pointIdx++;
            if (this._pointIdx >= this.points.length) {
                if (window.game && window.game._speak) {
                    window.game._speak("Calibration complete! Great job!");
                }
                this._finish();
            } else {
                if (window.game && window.game._speak) {
                    const praises = ["Good", "Nice", "Keep holding", "Perfect", "Great", "Excellent", "Well done", "Almost there"];
                    const praise = praises[this._pointIdx % praises.length];
                    
                    const calPointsMode = parseInt(window.game?.settings?.calibrationPoints || '9');
                    let nextDesc = "next target";
                    if (calPointsMode === 3) {
                        nextDesc = POINT_DESCRIPTIONS_3[this._pointIdx] || "next target";
                    } else if (calPointsMode === 5) {
                        nextDesc = POINT_DESCRIPTIONS_5[this._pointIdx] || "next target";
                    } else {
                        nextDesc = POINT_DESCRIPTIONS_9[this._pointIdx] || "next target";
                    }
                    window.game._speak(praise + `. Now look at the yellow star in the ${nextDesc}.`);
                }
                this._phase      = 'countdown';
                this._phaseStart = timestamp;
                this._buffer     = [];
            }
        }
    }

    /**
     * Render calibration UI on the provided 2-D context.
     * @param {CanvasRenderingContext2D} ctx
     * @param {DOMHighResTimeStamp} timestamp
     */
    render(ctx, timestamp) {
        if (!this._active) return;

        const W = ctx.canvas.width;
        const H = ctx.canvas.height;

        // Semi-opaque black overlay
        ctx.fillStyle = 'rgba(5, 10, 25, 0.85)';
        ctx.fillRect(0, 0, W, H);

        // Header text
        ctx.textAlign  = 'center';
        ctx.fillStyle  = '#e0f0ff';
        ctx.font       = 'bold 26px Arial';
        ctx.fillText('👁  Calibration', W / 2, 52);

        ctx.font      = '17px Arial';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(
            `Point ${this._pointIdx + 1} of ${this.points.length}  —  keep your eyes on the dot`,
            W / 2, 83
        );

        // Completed points (green tick)
        for (let i = 0; i < this._pointIdx; i++) {
            const p = this.points[i];
            ctx.beginPath();
            ctx.arc(p.x * W, p.y * H, 8, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,255,136,0.35)';
            ctx.fill();
        }

        // Future points (dim)
        for (let i = this._pointIdx + 1; i < this.points.length; i++) {
            const p = this.points[i];
            ctx.beginPath();
            ctx.arc(p.x * W, p.y * H, 7, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.fill();
        }

        // Active point
        const cur     = this.points[this._pointIdx];
        const px      = cur.x * W;
        const py      = cur.y * H;
        const elapsed = timestamp - this._phaseStart;

        const theme = window.game?.settings?.targetTheme || 'bubbles';

        if (this._phase === 'countdown') {
            const pulse  = 0.5 + 0.5 * Math.sin(elapsed * 0.01);
            const outerR = 24 + pulse * 8;

            if (theme === 'emojis') {
                ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
                ctx.lineWidth   = 3;
                ctx.beginPath();
                ctx.arc(px, py, outerR, 0, Math.PI * 2);
                ctx.stroke();

                ctx.font = '28px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText("🐝", px, py);
            } else if (theme === 'stars') {
                ctx.strokeStyle = 'rgba(255, 204, 0, 0.5)';
                ctx.lineWidth   = 3;
                ctx.beginPath();
                ctx.arc(px, py, outerR, 0, Math.PI * 2);
                ctx.stroke();

                ctx.font = '28px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText("⭐", px, py);
            } else {
                ctx.strokeStyle = `rgba(255, 204, 0, ${0.5 + 0.5 * pulse})`;
                ctx.lineWidth   = 3;
                ctx.beginPath();
                ctx.arc(px, py, outerR, 0, Math.PI * 2);
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(px, py, 14, 0, Math.PI * 2);
                ctx.fillStyle = '#ffcc00';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(px, py, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
            }
        } else {
            // Progress arc
            const progress = Math.min(elapsed / COLLECT_MS, 1);

            if (theme === 'emojis') {
                ctx.strokeStyle = 'rgba(0,255,136,0.15)';
                ctx.lineWidth   = 5;
                ctx.beginPath();
                ctx.arc(px, py, 28, 0, Math.PI * 2);
                ctx.stroke();

                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth   = 5;
                ctx.beginPath();
                ctx.arc(px, py, 28, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
                ctx.stroke();

                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText("🦄", px, py);
            } else if (theme === 'stars') {
                ctx.strokeStyle = 'rgba(255,204,0,0.15)';
                ctx.lineWidth   = 5;
                ctx.beginPath();
                ctx.arc(px, py, 28, 0, Math.PI * 2);
                ctx.stroke();

                ctx.strokeStyle = '#ffcc00';
                ctx.lineWidth   = 5;
                ctx.beginPath();
                ctx.arc(px, py, 28, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
                ctx.stroke();

                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText("🌟", px, py);
            } else {
                ctx.strokeStyle = 'rgba(0,229,255,0.2)';
                ctx.lineWidth   = 7;
                ctx.beginPath();
                ctx.arc(px, py, 26, 0, Math.PI * 2);
                ctx.stroke();

                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth   = 7;
                ctx.beginPath();
                ctx.arc(px, py, 26, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(px, py, 12, 0, Math.PI * 2);
                ctx.fillStyle = '#00ff88';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
            }
        }

        // Face-detection status
        const isWebGazer = window.game?.settings?.trackingMode === 'webgazer';
        const detected = isWebGazer ? window.game.webgazerDetected : this.eyeTracker.faceDetected;
        ctx.font      = '16px Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = detected ? '#00ff88' : '#ff4444';
        ctx.fillText(
            detected ? '✓  Face detected' : '✗  No face detected — look at the camera',
            W / 2, H - 36
        );
    }

    // ── Gaze transform ─────────────────────────────────────────────

    /**
     * Map raw iris coordinates to normalised screen position [0,1].
     * @param {number} irisX
     * @param {number} irisY
     * @returns {{ x: number, y: number }}
     */
    applyTransform(irisX, irisY) {
        const mode = window.game?.settings?.trackingMode || 'mediapipe';
        const tX = mode === 'webgazer' ? this.webgazerTransformX : this.transformX;
        const tY = mode === 'webgazer' ? this.webgazerTransformY : this.transformY;

        if (!tX || !tY) {
            if (mode === 'webgazer') {
                return {
                    x: Math.max(0, Math.min(1, irisX)),
                    y: Math.max(0, Math.min(1, irisY)),
                };
            }
            // Fallback for relative offsets: center at 0.5, scale by -2.5 for X and 3.0 for Y
            return {
                x: Math.max(0, Math.min(1, -2.5 * irisX + 1.75)),
                y: Math.max(0, Math.min(1, 3.0 * irisY - 1.0)),
            };
        }
        const [a, b, c] = tX;
        const [d, e, f] = tY;
        return {
            x: Math.max(0, Math.min(1, a * irisX + b * irisY + c)),
            y: Math.max(0, Math.min(1, d * irisX + e * irisY + f)),
        };
    }

    isCalibrated() {
        const mode = window.game?.settings?.trackingMode || 'mediapipe';
        if (mode === 'webgazer') {
            return this.webgazerTransformX !== null && this.webgazerTransformY !== null;
        }
        return this.transformX !== null && this.transformY !== null;
    }

    get active() { return this._active; }

    // ── Private ────────────────────────────────────────────────────

    _finish() {
        this._active = false;

        const isWebGazer = window.game?.settings?.trackingMode === 'webgazer';

        if (isWebGazer) {
            // WebGazer trains its own non-linear regression model directly during calibration
            // via webgazer.recordScreenPosition. Applying an affine transform on top of its
            // prediction is a double-calibration error that distorts and squishes the gaze coordinates.
            this.webgazerTransformX = [1.0, 0, 0];
            this.webgazerTransformY = [0, 1.0, 0];
            this._saveToStorage();
            this._onComplete?.(true);
            return;
        }

        if (this._data.length >= 3) {
            try {
                this._computeAffineTransform(this._data, isWebGazer);
                this._saveToStorage();
                this._onComplete?.(true);
                return;
            } catch (err) {
                console.warn('Calibration solve failed:', err);
            }
        }

        // Not enough valid data — use identity fallback designed for relative offsets
        this.transformX = [-2.5, 0, 1.75];   // screen_x ≈ -2.5 * iris_x + 1.75
        this.transformY = [0, 3.0, -1.0];    // screen_y ≈ 3.0 * iris_y - 1.0
        this._onComplete?.(false);
    }

    /**
     * Least-squares affine transform.
     * Minimises Σ(aX·iX + bX·iY + cX − sX)² and same for Y.
     */
    _computeAffineTransform(data, isWebGazer = false) {
        let sumIx2 = 0, sumIy2 = 0, sumIxIy = 0;
        let sumIx  = 0, sumIy  = 0;
        let sumSxIx = 0, sumSxIy = 0, sumSx = 0;
        let sumSyIx = 0, sumSyIy = 0, sumSy = 0;
        const n = data.length;

        for (const d of data) {
            sumIx2  += d.irisX * d.irisX;
            sumIy2  += d.irisY * d.irisY;
            sumIxIy += d.irisX * d.irisY;
            sumIx   += d.irisX;
            sumIy   += d.irisY;
            sumSxIx += d.screenX * d.irisX;
            sumSxIy += d.screenX * d.irisY;
            sumSx   += d.screenX;
            sumSyIx += d.screenY * d.irisX;
            sumSyIy += d.screenY * d.irisY;
            sumSy   += d.screenY;
        }

        const M = [
            [sumIx2, sumIxIy, sumIx],
            [sumIxIy, sumIy2, sumIy],
            [sumIx,  sumIy,  n    ],
        ];

        const tX = _solveLinear3(M, [sumSxIx, sumSxIy, sumSx]);
        const tY = _solveLinear3(M, [sumSyIx, sumSyIy, sumSy]);

        if (isWebGazer) {
            this.webgazerTransformX = tX;
            this.webgazerTransformY = tY;
        } else {
            this.transformX = tX;
            this.transformY = tY;
        }
    }

    _saveToStorage() {
        try {
            const existingRaw = localStorage.getItem('eyeAimArena_cal_v3');
            const existing = existingRaw ? JSON.parse(existingRaw) : {};

            const dataToSave = {
                transformX: this.transformX !== null ? this.transformX : (existing.transformX || null),
                transformY: this.transformY !== null ? this.transformY : (existing.transformY || null),
                webgazerTransformX: this.webgazerTransformX !== null ? this.webgazerTransformX : (existing.webgazerTransformX || null),
                webgazerTransformY: this.webgazerTransformY !== null ? this.webgazerTransformY : (existing.webgazerTransformY || null),
            };

            console.log("[CalibrationSystem] Saving calibration parameters to localStorage:", dataToSave);
            localStorage.setItem('eyeAimArena_cal_v3', JSON.stringify(dataToSave));
        } catch (err) {
            console.warn("[CalibrationSystem] Failed to save calibration to storage:", err);
        }
    }

    _loadFromStorage() {
        try {
            const raw = localStorage.getItem('eyeAimArena_cal_v3');
            console.log("[CalibrationSystem] Loading calibration data (eyeAimArena_cal_v3):", raw);
            if (raw) {
                const { transformX, transformY, webgazerTransformX, webgazerTransformY } = JSON.parse(raw);
                if (transformX && transformY) {
                    this.transformX = transformX;
                    this.transformY = transformY;
                }
                if (webgazerTransformX && webgazerTransformY) {
                    this.webgazerTransformX = webgazerTransformX;
                    this.webgazerTransformY = webgazerTransformY;
                }
                console.log("[CalibrationSystem] Calibration loaded successfully. MediaPipe:", 
                    this.transformX ? "Calibrated ✓" : "None", "WebGazer:", 
                    this.webgazerTransformX ? "Calibrated ✓" : "None");
                return true;
            }
        } catch (err) {
            console.warn("[CalibrationSystem] Failed to load calibration v3:", err);
        }

        // Legacy fallback
        try {
            const rawLegacy = localStorage.getItem('eyeAimArena_cal_v2');
            console.log("[CalibrationSystem] Falling back to legacy eyeAimArena_cal_v2:", rawLegacy);
            if (rawLegacy) {
                const { transformX, transformY } = JSON.parse(rawLegacy);
                if (transformX && transformY) {
                    this.transformX = transformX;
                    this.transformY = transformY;
                    console.log("[CalibrationSystem] Legacy calibration loaded successfully:", this.transformX, this.transformY);
                    return true;
                }
            }
        } catch (err) {
            console.warn("[CalibrationSystem] Failed to load legacy calibration v2:", err);
        }

        console.log("[CalibrationSystem] No calibration found in localStorage.");
        return false;
    }
}

// ── Maths helpers ──────────────────────────────────────────────────

/**
 * Solve a 3×3 linear system M·x = rhs using Gaussian elimination
 * with partial pivoting.
 * @param {number[][]} M  3×3 matrix
 * @param {number[]}   rhs
 * @returns {number[]}    solution [x0, x1, x2]
 */
function _solveLinear3(M, rhs) {
    const N = 3;
    // Build augmented matrix [M | rhs]
    const aug = M.map((row, i) => [...row, rhs[i]]);

    // Forward elimination with partial pivoting
    for (let col = 0; col < N; col++) {
        // Find pivot row
        let maxRow = col;
        for (let row = col + 1; row < N; row++) {
            if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
        }
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

        if (Math.abs(aug[col][col]) < 1e-12) {
            throw new Error(
                'Calibration failed: unable to compute eye tracking transform. ' +
                'Please try recalibrating and ensure your face is clearly visible.'
            );
        }

        for (let row = col + 1; row < N; row++) {
            const f = aug[row][col] / aug[col][col];
            for (let j = col; j <= N; j++) aug[row][j] -= f * aug[col][j];
        }
    }

    // Back substitution
    const x = new Array(N).fill(0);
    for (let i = N - 1; i >= 0; i--) {
        x[i] = aug[i][N];
        for (let j = i + 1; j < N; j++) x[i] -= aug[i][j] * x[j];
        x[i] /= aug[i][i];
    }
    return x;
}
