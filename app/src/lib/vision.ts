// On-device vision: camera, face landmarks (MediaPipe) and the spoof model (MiniFASNet, ONNX).
// Everything in this file runs in the browser. No frame leaves the device from here.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as ort from 'onnxruntime-web/wasm';

export type Box = { x: number; y: number; w: number; h: number };

export type Analysis = {
  t: number;
  faceCount: number;
  box: Box | null;
  faceFrac: number; // face width as a fraction of frame width
  turn: number; // 0.5 = facing camera; lower / higher = head turned
  blink: number; // 0 open .. 1 closed
  jaw: number; // 0 closed .. 1 mouth wide open
  smile: number; // 0 .. 1
  gaze: number; // horizontal iris position within the eyes, 0.5 = looking straight; rises when the eyes move towards the image right
  brightness: number; // 0..255 mean of the face area
  flags: string[]; // quality problems, empty when the frame is usable
  spoof: number | null; // P(live) from the spoof model for this frame
  padMs: number;
};

const VIRTUAL_CAM = /obs|virtual|manycam|snap camera|splitcam|iriun|droidcam|epoccam|ndi|xsplit|mmhmm|camtwist/i;
const MODELS = [
  { url: '/models/MiniFASNetV2.onnx', scale: 2.7 },
  { url: '/models/MiniFASNetV1SE.onnx', scale: 4.0 },
];

class Vision {
  ready = false;
  error: string | null = null;
  stream: MediaStream | null = null;
  video: HTMLVideoElement | null = null;
  cameraLabel = '';
  virtualCamera = false;
  latest: Analysis | null = null;
  scores: { t: number; s: number }[] = [];
  private landmarker: FaceLandmarker | null = null;
  private sessions: { s: ort.InferenceSession; scale: number }[] = [];
  private crop = document.createElement('canvas');
  private tiny = document.createElement('canvas');
  private frame = document.createElement('canvas');
  private initPromise: Promise<void> | null = null;
  private running = false;
  private loopId = 0;
  // natural-blink tracking for the person currently in front of the camera
  private trackStart = 0;
  private lastSeen = 0;
  private lastBox: Box | null = null;
  private eyesClosedAt = 0;
  private lastBlinkAt = 0;
  private listeners = new Set<(a: Analysis) => void>();

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    try {
      ort.env.wasm.wasmPaths = '/ort/';
      ort.env.wasm.numThreads = 1;
      const [fileset, ...sessions] = await Promise.all([
        FilesetResolver.forVisionTasks('/mediapipe/wasm'),
        ...MODELS.map((m) => ort.InferenceSession.create(m.url, { executionProviders: ['wasm'] })),
      ]);
      this.sessions = sessions.map((s, i) => ({ s, scale: MODELS[i].scale }));
      const make = (delegate: 'GPU' | 'CPU') =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
          runningMode: 'VIDEO',
          numFaces: 3,
          outputFaceBlendshapes: true,
        });
      try {
        this.landmarker = await make('GPU');
      } catch {
        this.landmarker = await make('CPU');
      }
      this.crop.width = this.crop.height = 80;
      this.tiny.width = this.tiny.height = 16;
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      const track = this.stream.getVideoTracks()[0];
      this.cameraLabel = track?.label || '';
      this.virtualCamera = VIRTUAL_CAM.test(this.cameraLabel);
      this.ready = true;
    } catch (e: any) {
      this.error = e?.name === 'NotAllowedError' ? 'Camera permission was denied.' : `Could not start: ${e?.message || e}`;
      throw e;
    }
  }

  attach(video: HTMLVideoElement) {
    this.video = video;
    if (this.stream && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      video.play().catch(() => {});
    }
    this.running = true;
    this.tick(++this.loopId);
  }

  detach(video: HTMLVideoElement) {
    if (this.video === video) {
      this.video = null;
      this.running = false;
    }
  }

  subscribe(fn: (a: Analysis) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private async tick(id: number) {
    if (!this.running || id !== this.loopId) return;
    const v = this.video;
    if (v && this.ready && v.readyState >= 2 && v.videoWidth > 0) {
      try {
        const a = this.analyze(v);
        if (a.box && a.faceCount >= 1) {
          const t0 = performance.now();
          a.spoof = await this.pad(v, a.box);
          a.padMs = performance.now() - t0;
          this.scores.push({ t: a.t, s: a.spoof });
          const cutoff = a.t - 4000;
          while (this.scores.length && this.scores[0].t < cutoff) this.scores.shift();
        }
        this.track(a, v.videoWidth);
        this.latest = a;
        this.listeners.forEach((fn) => fn(a));
      } catch (e) {
        console.warn('vision tick failed', e);
      }
    }
    setTimeout(() => this.tick(id), 35);
  }

  private analyze(v: HTMLVideoElement): Analysis {
    const t = performance.now();
    const res = this.landmarker!.detectForVideo(v, t);
    const W = v.videoWidth, H = v.videoHeight;
    const a: Analysis = { t, faceCount: res.faceLandmarks.length, box: null, faceFrac: 0, turn: 0.5, blink: 0, jaw: 0, smile: 0, gaze: 0.5, brightness: 0, flags: [], spoof: null, padMs: 0 };
    if (!a.faceCount) {
      a.flags.push('NO_FACE');
      return a;
    }
    // use the largest face
    let best = 0, bestArea = 0;
    const boxes = res.faceLandmarks.map((lm) => {
      let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
      for (const p of lm) {
        if (p.x < x1) x1 = p.x;
        if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.y > y2) y2 = p.y;
      }
      return { x: x1 * W, y: y1 * H, w: (x2 - x1) * W, h: (y2 - y1) * H };
    });
    boxes.forEach((b, i) => {
      if (b.w * b.h > bestArea) {
        bestArea = b.w * b.h;
        best = i;
      }
    });
    const lm = res.faceLandmarks[best];
    a.box = boxes[best];
    a.faceFrac = a.box.w / W;
    const l = lm[234].x, r = lm[454].x;
    a.turn = (lm[1].x - l) / Math.max(1e-6, r - l);
    // Iris position relative to the eye corners. A flat photo that is tilted or moved keeps this
    // ratio the same; only real eye movement changes it.
    if (lm.length >= 478) {
      const eye = (c1: number, c2: number, iris: number) => {
        const lo = Math.min(lm[c1].x, lm[c2].x), hi = Math.max(lm[c1].x, lm[c2].x);
        return (lm[iris].x - lo) / Math.max(1e-6, hi - lo);
      };
      a.gaze = (eye(33, 133, 468) + eye(362, 263, 473)) / 2;
    }
    const bs = res.faceBlendshapes?.[best]?.categories;
    if (bs) {
      const bl = bs.find((c) => c.categoryName === 'eyeBlinkLeft')?.score ?? 0;
      const br = bs.find((c) => c.categoryName === 'eyeBlinkRight')?.score ?? 0;
      a.blink = (bl + br) / 2;
      const get = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
      a.jaw = get('jawOpen');
      a.smile = (get('mouthSmileLeft') + get('mouthSmileRight')) / 2;
    }
    a.brightness = this.brightness(v, a.box);
    const others = boxes.filter((b, i) => i !== best && b.w * b.h > bestArea * 0.25).length;
    if (others > 0) a.flags.push('MULTIPLE_FACES');
    if (a.faceFrac < 0.16) a.flags.push('TOO_FAR');
    if (a.faceFrac > 0.62) a.flags.push('TOO_CLOSE');
    if (Math.abs(a.turn - 0.5) > 0.14) a.flags.push('FACE_NOT_ALIGNED');
    if (a.brightness < 55) a.flags.push('LOW_LIGHT');
    if (a.brightness > 225) a.flags.push('TOO_BRIGHT');
    const cx = (a.box.x + a.box.w / 2) / W, cy = (a.box.y + a.box.h / 2) / H;
    if (cx < 0.2 || cx > 0.8 || cy < 0.15 || cy > 0.85) a.flags.push('NOT_CENTRED');
    return a;
  }

  private brightness(v: HTMLVideoElement, b: Box): number {
    const ctx = this.tiny.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(v, b.x + b.w * 0.2, b.y + b.h * 0.2, b.w * 0.6, b.h * 0.6, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / 256;
  }

  // MiniFASNet preprocessing: wide crop around the face, 80x80, BGR, values 0..255, no normalisation.
  private async pad(v: HTMLVideoElement, b: Box): Promise<number> {
    const W = v.videoWidth, H = v.videoHeight;
    const ctx = this.crop.getContext('2d', { willReadFrequently: true })!;
    let sum = 0;
    for (const { s, scale: maxScale } of this.sessions) {
      const scale = Math.min((H - 1) / b.h, (W - 1) / b.w, maxScale);
      const nw = b.w * scale, nh = b.h * scale;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const x1 = Math.max(0, Math.floor(cx - nw / 2)), y1 = Math.max(0, Math.floor(cy - nh / 2));
      const x2 = Math.min(W - 1, Math.floor(cx + nw / 2)), y2 = Math.min(H - 1, Math.floor(cy + nh / 2));
      ctx.drawImage(v, x1, y1, x2 - x1 + 1, y2 - y1 + 1, 0, 0, 80, 80);
      const px = ctx.getImageData(0, 0, 80, 80).data;
      const data = new Float32Array(3 * 6400);
      for (let i = 0; i < 6400; i++) {
        data[i] = px[i * 4 + 2];
        data[6400 + i] = px[i * 4 + 1];
        data[12800 + i] = px[i * 4];
      }
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, 80, 80]) });
      const logits = out[s.outputNames[0]].data as Float32Array;
      const m = Math.max(...logits);
      const exps = Array.from(logits).map((x) => Math.exp(x - m));
      sum += exps[1] / exps.reduce((p, c) => p + c, 0);
    }
    return sum / this.sessions.length;
  }

  // Follows one continuous presentation. If the face disappears or jumps (a photo swapped in),
  // tracking restarts and earlier blinks no longer count.
  private track(a: Analysis, W: number) {
    const b = a.box;
    if (!b) {
      if (a.t - this.lastSeen > 600) this.resetTrack();
      return;
    }
    const lb = this.lastBox;
    const jumped = lb && (Math.abs(b.x + b.w / 2 - (lb.x + lb.w / 2)) > 0.18 * W || b.w / lb.w > 1.45 || lb.w / b.w > 1.45);
    if (!this.trackStart || jumped || a.t - this.lastSeen > 600) {
      this.resetTrack();
      this.trackStart = a.t;
    }
    this.lastSeen = a.t;
    this.lastBox = b;
    if (a.blink > 0.45 && !this.eyesClosedAt) this.eyesClosedAt = a.t;
    if (a.blink < 0.25 && this.eyesClosedAt) {
      // a real blink is short; eyes held shut or a tracking glitch does not count
      if (a.t - this.eyesClosedAt < 700) this.lastBlinkAt = a.t;
      this.eyesClosedAt = 0;
    }
  }

  private resetTrack() {
    this.trackStart = 0;
    this.lastBox = null;
    this.eyesClosedAt = 0;
    this.lastBlinkAt = 0;
  }

  // Evidence of life gathered passively while the person stands at the kiosk.
  evidence(windowSec = 12) {
    const now = performance.now();
    return {
      blinkSeen: !!this.lastBlinkAt && this.lastBlinkAt >= this.trackStart && now - this.lastBlinkAt <= windowSec * 1000,
      trackedMs: this.trackStart ? Math.round(now - this.trackStart) : 0,
    };
  }

  // Mean and minimum spoof score over the last windowMs.
  window(windowMs = 800) {
    const now = performance.now();
    const w = this.scores.filter((x) => now - x.t <= windowMs);
    if (!w.length) return { mean: 0, min: 0, frames: 0 };
    return { mean: w.reduce((p, c) => p + c.s, 0) / w.length, min: Math.min(...w.map((x) => x.s)), frames: w.length };
  }

  captureJpeg(maxW = 512, quality = 0.72): string | null {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, maxW / v.videoWidth);
    this.frame.width = Math.round(v.videoWidth * scale);
    this.frame.height = Math.round(v.videoHeight * scale);
    this.frame.getContext('2d')!.drawImage(v, 0, 0, this.frame.width, this.frame.height);
    return this.frame.toDataURL('image/jpeg', quality);
  }
}

export const vision = new Vision();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
