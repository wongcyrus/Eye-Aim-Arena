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
        this.transformX = null;          // screenX = a·ix + b·iy + c
        this.transformY = null;          // screenY = d·ix + e·iy + f

        this._onComplete = null;

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
        if (this.eyeTracker.faceDetected) {
            this._buffer.push({
                irisX: this.eyeTracker.rawGazeX,
                irisY: this.eyeTracker.rawGazeY,
            });
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
                this._finish();
            } else {
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

        if (this._phase === 'countdown') {
            const pulse  = 0.5 + 0.5 * Math.sin(elapsed * 0.01);
            const outerR = 22 + pulse * 8;

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
        } else {
            // Progress arc
            const progress = Math.min(elapsed / COLLECT_MS, 1);

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

        // Face-detection status
        const detected = this.eyeTracker.faceDetected;
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
        if (!this.transformX || !this.transformY) {
            return { x: irisX, y: irisY };
        }
        const [a, b, c] = this.transformX;
        const [d, e, f] = this.transformY;
        return {
            x: Math.max(0, Math.min(1, a * irisX + b * irisY + c)),
            y: Math.max(0, Math.min(1, d * irisX + e * irisY + f)),
        };
    }

    isCalibrated() {
        return this.transformX !== null && this.transformY !== null;
    }

    get active() { return this._active; }

    // ── Private ────────────────────────────────────────────────────

    _finish() {
        this._active = false;

        if (this._data.length >= 4) {
            try {
                this._computeAffineTransform(this._data);
                this._saveToStorage();
                this._onComplete?.(true);
                return;
            } catch (err) {
                console.warn('Calibration solve failed:', err);
            }
        }
        // Not enough valid data — use identity fallback
        this.transformX = [-1, 0, 1];   // screen_x ≈ 1 - iris_x  (mirror)
        this.transformY = [0, 1, 0];
        this._onComplete?.(false);
    }

    /**
     * Least-squares affine transform.
     * Minimises Σ(aX·iX + bX·iY + cX − sX)² and same for Y.
     */
    _computeAffineTransform(data) {
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

        this.transformX = _solveLinear3(M, [sumSxIx, sumSxIy, sumSx]);
        this.transformY = _solveLinear3(M, [sumSyIx, sumSyIy, sumSy]);
    }

    _saveToStorage() {
        try {
            localStorage.setItem('eyeAimArena_cal', JSON.stringify({
                transformX: this.transformX,
                transformY: this.transformY,
            }));
        } catch { /* storage unavailable */ }
    }

    _loadFromStorage() {
        try {
            const raw = localStorage.getItem('eyeAimArena_cal');
            if (!raw) return false;
            const { transformX, transformY } = JSON.parse(raw);
            if (transformX && transformY) {
                this.transformX = transformX;
                this.transformY = transformY;
                return true;
            }
        } catch { /* corrupted data */ }
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

        if (Math.abs(aug[col][col]) < 1e-12) throw new Error('Singular system');

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
