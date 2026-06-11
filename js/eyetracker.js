/**
 * eyetracker.js
 * Wraps MediaPipe Face Landmarker for real-time iris gaze estimation
 * and blink-based shoot detection.
 *
 * Iris landmark indices (MediaPipe 478-landmark model):
 *   Left iris center  : 468   Right iris center : 473
 *
 * EAR (Eye Aspect Ratio) landmark sets:
 *   Left  eye : [33, 160, 158, 133, 153, 144]
 *   Right eye : [362, 385, 387, 263, 373, 380]
 */

// 6-point eye landmark indices for EAR calculation
const LEFT_EYE_EAR  = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE_EAR = [362, 385, 387, 263, 373, 380];

const LEFT_IRIS_CENTER  = 468;
const RIGHT_IRIS_CENTER = 473;

// WASM / model base URLs (CDN)
const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM_URL   = `${VISION_CDN}/wasm`;
const MODEL_URL  =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export class EyeTracker {
    constructor() {
        this.faceLandmarker = null;

        // Smoothed gaze (normalized [0,1] in video-frame space)
        this.gazeX    = 0.5;
        this.gazeY    = 0.5;
        this.rawGazeX = 0.5;
        this.rawGazeY = 0.5;

        // Blink state
        this.isBlinking       = false;
        this._blinkInProgress = false;
        this.lastBlinkTime    = 0;

        // Public flags
        this.faceDetected = false;
        this.landmarks    = null;

        // Tunable parameters
        this.smoothingAlpha    = 0.18;   // EMA weight (higher = more responsive)
        this.EAR_THRESHOLD     = 0.18;   // below this = blink
        this.BLINK_DEBOUNCE_MS = 450;    // minimum ms between registered blinks

        /** @type {Array<function():void>} */
        this._blinkCallbacks = [];
    }

    /**
     * Asynchronously load MediaPipe Face Landmarker via CDN.
     * @param {function(string):void} [onProgress]
     */
    async init(onProgress) {
        onProgress?.('Importing MediaPipe Tasks Vision…');

        // Dynamic import of ES-module bundle from CDN
        const { FaceLandmarker, FilesetResolver } = await import(
            `${VISION_CDN}/vision_bundle.mjs`
        );

        onProgress?.('Resolving WASM assets…');
        const filesetResolver = await FilesetResolver.forVisionTasks(WASM_URL);

        onProgress?.('Loading face-landmark model…');
        this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
                modelAssetPath: MODEL_URL,
                delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numFaces: 1,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence:  0.5,
            minTrackingConfidence:      0.5,
            outputFaceBlendshapes:               false,
            outputFacialTransformationMatrixes:  false,
        });

        onProgress?.('Model ready ✓');
    }

    /**
     * Run inference on the current video frame.
     * Must be called inside a requestAnimationFrame callback.
     *
     * @param {HTMLVideoElement} video
     * @param {DOMHighResTimeStamp} timestamp - from rAF
     * @returns {{ gazeX, gazeY, rawGazeX, rawGazeY, faceDetected, isBlinking } | null}
     */
    processFrame(video, timestamp) {
        if (!this.faceLandmarker) return null;
        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;

        let results;
        try {
            results = this.faceLandmarker.detectForVideo(video, timestamp);
        } catch {
            return null;
        }

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
            this.landmarks    = results.faceLandmarks[0];
            this.faceDetected = true;

            // --- Iris centre (average of left and right) ---
            const lIris = this.landmarks[LEFT_IRIS_CENTER];
            const rIris = this.landmarks[RIGHT_IRIS_CENTER];

            this.rawGazeX = (lIris.x + rIris.x) / 2;
            this.rawGazeY = (lIris.y + rIris.y) / 2;

            // --- Exponential moving average smoothing ---
            this.gazeX += (this.rawGazeX - this.gazeX) * this.smoothingAlpha;
            this.gazeY += (this.rawGazeY - this.gazeY) * this.smoothingAlpha;

            // --- Blink detection ---
            this._detectBlink(this.landmarks);
        } else {
            this.faceDetected = false;
            this.landmarks    = null;
        }

        return {
            gazeX:      this.gazeX,
            gazeY:      this.gazeY,
            rawGazeX:   this.rawGazeX,
            rawGazeY:   this.rawGazeY,
            faceDetected: this.faceDetected,
            isBlinking: this.isBlinking,
        };
    }

    // ── Private helpers ────────────────────────────────────────────

    /**
     * Eye Aspect Ratio: (|P2-P6| + |P3-P5|) / (2 * |P1-P4|)
     * where P1..P6 follow the standard 6-point eye ordering.
     */
    _calculateEAR(landmarks, indices) {
        const pts = indices.map(i => landmarks[i]);
        const v1  = Math.hypot(pts[1].x - pts[5].x, pts[1].y - pts[5].y);
        const v2  = Math.hypot(pts[2].x - pts[4].x, pts[2].y - pts[4].y);
        const h   = Math.hypot(pts[0].x - pts[3].x, pts[0].y - pts[3].y);
        return h < 1e-6 ? 1 : (v1 + v2) / (2 * h);
    }

    _detectBlink(landmarks) {
        const leftEAR  = this._calculateEAR(landmarks, LEFT_EYE_EAR);
        const rightEAR = this._calculateEAR(landmarks, RIGHT_EYE_EAR);
        const avgEAR   = (leftEAR + rightEAR) / 2;

        const now = performance.now();

        if (avgEAR < this.EAR_THRESHOLD) {
            if (!this._blinkInProgress) {
                this._blinkInProgress = true;
                this.isBlinking       = true;
            }
        } else {
            if (this._blinkInProgress) {
                this._blinkInProgress = false;
                this.isBlinking       = false;

                // Only fire a registered blink if debounce has elapsed
                if (now - this.lastBlinkTime > this.BLINK_DEBOUNCE_MS) {
                    this.lastBlinkTime = now;
                    for (const cb of this._blinkCallbacks) cb();
                }
            }
        }
    }

    // ── Public API ─────────────────────────────────────────────────

    /**
     * Register a callback invoked once per intentional blink.
     * Returns an unsubscribe function.
     * @param {function():void} callback
     * @returns {function():void}
     */
    onBlink(callback) {
        this._blinkCallbacks.push(callback);
        return () => {
            this._blinkCallbacks = this._blinkCallbacks.filter(cb => cb !== callback);
        };
    }

    /** Adjust EMA smoothing strength (0.05 = very smooth, 1.0 = raw). */
    setSmoothingAlpha(alpha) {
        this.smoothingAlpha = Math.max(0.05, Math.min(1.0, alpha));
    }

    /** Estimated left-iris radius in normalised image units. */
    getIrisRadius() {
        if (!this.landmarks) return 0.015;
        const c = this.landmarks[LEFT_IRIS_CENTER];
        const e = this.landmarks[469]; // left iris edge point
        return Math.hypot(c.x - e.x, c.y - e.y);
    }
}
