/* ================================================================
 * Real camera mode — everything below runs in this browser.
 *
 *   camera frame → paper detection → stability check → capture
 *   → perspective flattening → same-page guard → OCR → grouping
 *   → rule-based classification → archive
 *
 * Detection is a lightweight classical method (no model download):
 * paper is found as the largest bright, low-colour region in a small
 * copy of the frame, and its four corners are its extreme points.
 * It works best with paper on a darker table.
 * ================================================================ */
type Pt = [number, number];
type RealPhase = 'searching' | 'detected' | 'steady' | 'focusing' | 'captured' | 'same';

interface RealPage {
  key: string; image: string; thumb: string; original: string; originalRatio: number;
  quad: Pt[]; sig: number[]; capturedAt: number; sharpness: number; blurry: boolean;
  look?: Uint8Array; aspect?: number;   // small grey copy of the flattened page, for spotting re-scans
  source?: 'photo' | 'video'; size?: [number, number];
}
interface Detection { quad: Pt[]; gray: Uint8Array; w: number; h: number }

const ANALYSIS_W = 192;
const STEADY_MS = 450;
const OCR_LONG_SIDE = 2400;   // long side of the page when reading text; small print needs the pixels
const FOCUS_GIVE_UP_MS = 800;    // after holding still this long, capture the sharpest we can get
const MIN_DETAIL = 50;           // pages with less fine detail than this are blank surfaces, not documents

/* ---------- Focus ---------- */
/** Ask the camera for continuous autofocus where the browser allows it (Chrome on Android does). */
function setupFocus(stream: MediaStream) {
  const track: any = stream.getVideoTracks()[0];
  const caps: any = (track && track.getCapabilities && track.getCapabilities()) || {};
  // Keep exposure short where the camera lets us choose: less motion blur
  if (track && caps.exposureMode && caps.exposureMode.includes('continuous')) track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }).catch(() => {});
  if (track && caps.focusMode && caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  return { track, caps };
}
/** Point the focus at the paper, where supported. */
function focusOn(f: { track: any; caps: any }, x: number, y: number) {
  if (!f.track || f.caps.pointsOfInterest === undefined) return;
  f.track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }] }] }).catch(() => {});
}
/**
 * How sharp the paper looks right now: the variance of a Laplacian filter
 * over the middle of the paper, measured at a modest resolution. Out-of-focus
 * frames have soft edges and score low; the score peaks once focus settles.
 */
function measureSharpness(video: HTMLVideoElement, quad: Pt[], cv: HTMLCanvasElement): number {
  return sharpnessIn(video, video.videoWidth, video.videoHeight, quad, cv);
}
function sharpnessIn(video: CanvasImageSource, vw: number, vh: number, quad: Pt[], cv: HTMLCanvasElement): number {
  const xs = quad.map((p) => p[0] * vw), ys = quad.map((p) => p[1] * vh);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ix = (x1 - x0) * 0.15, iy = (y1 - y0) * 0.15;
  x0 += ix; x1 -= ix; y0 += iy; y1 -= iy;
  const bw = Math.max(8, x1 - x0), bh = Math.max(8, y1 - y0);
  const scale = Math.min(1, 420 / Math.max(bw, bh));
  const w = Math.max(8, Math.round(bw * scale)), h = Math.max(8, Math.round(bh * scale));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(video, x0, y0, bw, bh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.3 * d[j] + 0.59 * d[j + 1] + 0.11 * d[j + 2];
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
    sum += lap; sum2 += lap * lap; n++;
  }
  const mean = sum / Math.max(1, n);
  return sum2 / Math.max(1, n) - mean * mean;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyArea(p: Pt[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
const maxCornerDelta = (a: Pt[], b: Pt[]) => Math.max(...a.map((p, i) => dist(p, b[i])));

/** Find the paper in a video frame. Returns normalized corners tl, tr, br, bl. */
function detectPaper(video: HTMLVideoElement, cv: HTMLCanvasElement): Detection | null {
  return detectPaperIn(video, video.videoWidth, video.videoHeight, cv);
}
function detectPaperIn(video: CanvasImageSource, vw: number, vh: number, cv: HTMLCanvasElement): Detection | null {
  if (!vw || !vh) return null;
  const w = ANALYSIS_W, h = Math.max(1, Math.round((ANALYSIS_W * vh) / vw));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(video, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h, g = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], gg = d[j + 1], b = d[j + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    let v = 0.3 * r + 0.59 * gg + 0.11 * b - 0.7 * (mx - mn); // bright and colourless scores high
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    g[i] = v; hist[g[i]]++;
  }
  // Otsu threshold
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128, mB0 = 0, mF0 = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; mB0 = mB; mF0 = mF; }
  }
  if (mF0 < 110 || mF0 - mB0 < 30) return null;

  // Largest bright connected region
  const lab = new Uint8Array(n), queue = new Int32Array(n);
  let bestArea = 0, bestPts: number[] = [], bestEdge = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (lab[s0] || g[s0] <= thr) continue;
    let qh = 0, qt = 0; queue[qt++] = s0; lab[s0] = 1;
    let edge = 0, area = 0, minS = 1e9, maxS = -1e9, minD = 1e9, maxD = -1e9, pMinS = s0, pMaxS = s0, pMinD = s0, pMaxD = s0;
    while (qh < qt) {
      const p = queue[qh++]; area++;
      const x = p % w, y = (p / w) | 0, sm = x + y, df = x - y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge++;
      if (sm < minS) { minS = sm; pMinS = p; } if (sm > maxS) { maxS = sm; pMaxS = p; }
      if (df < minD) { minD = df; pMinD = p; } if (df > maxD) { maxD = df; pMaxD = p; }
      if (x > 0 && !lab[p - 1] && g[p - 1] > thr) { lab[p - 1] = 1; queue[qt++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && g[p + 1] > thr) { lab[p + 1] = 1; queue[qt++] = p + 1; }
      if (y > 0 && !lab[p - w] && g[p - w] > thr) { lab[p - w] = 1; queue[qt++] = p - w; }
      if (y < h - 1 && !lab[p + w] && g[p + w] > thr) { lab[p + w] = 1; queue[qt++] = p + w; }
    }
    if (area > bestArea) { bestArea = area; bestPts = [pMinS, pMaxD, pMaxS, pMinD]; bestEdge = edge; }
  }
  const frac = bestArea / n;
  if (frac < 0.04 || frac > 0.82) return null;
  const quadPx: Pt[] = bestPts.map((p) => [(p % w) + 0.5, ((p / w) | 0) + 0.5] as Pt);
  const fill = bestArea / Math.max(1, polyArea(quadPx));
  if (fill < 0.72 || fill > 1.25) return null;          // not rectangle-shaped
  const ar = dist(quadPx[0], quadPx[1]) / Math.max(1, dist(quadPx[0], quadPx[3]));
  if (ar < 0.3 || ar > 3.3) return null;
  // A document lies fully inside the view. Bright areas running off the edge are walls, tables or windows.
  if (bestEdge > 2) return null;
  // Opposite sides of a sheet of paper are about the same length, even when seen at an angle.
  const top = dist(quadPx[0], quadPx[1]), bottom = dist(quadPx[3], quadPx[2]), left = dist(quadPx[0], quadPx[3]), right = dist(quadPx[1], quadPx[2]);
  if (top / bottom < 0.72 || top / bottom > 1.39 || left / right < 0.72 || left / right > 1.39) return null;
  return { quad: quadPx.map(([x, y]) => [x / w, y / h] as Pt), gray: g, w, h };
}

/** Homography that maps points `from` onto `to` (4 point pairs). */
function solveHomography(from: Pt[], to: Pt[]): number[] {
  const A: number[][] = [], B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); B.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); B.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [B[c], B[piv]] = [B[piv], B[c]];
    const v = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / v; if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  return B.map((b, i) => b / A[i][i]);
}
const applyH = (H: number[], x: number, y: number): Pt => {
  const z = H[6] * x + H[7] * y + 1;
  return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
};

/** Small normalized fingerprint of what is inside the outline, used to tell pages apart. */
function signature(det: Detection, quad: Pt[]): number[] {
  const { gray, w, h } = det, SW = 14, SH = 20;
  const H = solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]], quad.map(([x, y]) => [x * w, y * h] as Pt));
  const out: number[] = [];
  for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
    const [x, y] = applyH(H, (i + 0.5) / SW, (j + 0.5) / SH);
    const xi = Math.min(w - 1, Math.max(0, x | 0)), yi = Math.min(h - 1, Math.max(0, y | 0));
    out.push(gray[yi * w + xi]);
  }
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  const sd = Math.max(12, Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length));
  return out.map((v) => (v - mean) / sd);
}
function sigDiff(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 9;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Gentle unsharp mask on brightness only: crisper letter edges without colour fringes.
 * out = pixel + amount × (brightness − blurred brightness)
 */
function sharpen(o: Uint8ClampedArray, W: number, H: number, amount: number) {
  const n = W * H, L = new Float32Array(n), T = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.3 * o[j] + 0.59 * o[j + 1] + 0.11 * o[j + 2];
  for (let y = 0; y < H; y++) {
    const r = y * W;
    T[r] = L[r]; T[r + W - 1] = L[r + W - 1];
    for (let x = 1; x < W - 1; x++) T[r + x] = (L[r + x - 1] + 2 * L[r + x] + L[r + x + 1]) * 0.25;
  }
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H - 1; y++) {
      const i = y * W + x, blur = (T[i - W] + 2 * T[i] + T[i + W]) * 0.25, d = amount * (L[i] - blur), j = i * 4;
      if (d > -1 && d < 1) continue;
      o[j] += d; o[j + 1] += d; o[j + 2] += d;
    }
  }
}

/** Grab the full-resolution frame and flatten the paper into a straight page. */
function captureFrame(video: HTMLVideoElement, quad: Pt[]) {
  return { ...captureFrom(video, video.videoWidth, video.videoHeight, quad, 2200), source: 'video' as const };
}
function captureFrom(video: CanvasImageSource, vw: number, vh: number, quad: Pt[], maxLong: number) {
  const fc = document.createElement('canvas'); fc.width = vw; fc.height = vh;
  const fctx = fc.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  fctx.drawImage(video, 0, 0, vw, vh);
  const src = fctx.getImageData(0, 0, vw, vh).data;
  const q = quad.map(([x, y]) => [x * vw, y * vh] as Pt);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), Hh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1.5, maxLong / Math.max(W, Hh));
  W = Math.max(8, Math.round(W * k)); Hh = Math.max(8, Math.round(Hh * k));
  const H = solveHomography([[0, 0], [W, 0], [W, Hh], [0, Hh]], q);
  const oc = document.createElement('canvas'); oc.width = W; oc.height = Hh;
  const octx = oc.getContext('2d') as CanvasRenderingContext2D;
  const img = octx.createImageData(W, Hh), o = img.data, lum = new Uint32Array(256);
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const z = H[6] * x + H[7] * y + 1;
    let sx = (H[0] * x + H[1] * y + H[2]) / z, sy = (H[3] * x + H[4] * y + H[5]) / z;
    sx = sx < 0 ? 0 : sx > vw - 1.001 ? vw - 1.001 : sx;
    sy = sy < 0 ? 0 : sy > vh - 1.001 ? vh - 1.001 : sy;
    const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
    const i00 = (y0 * vw + x0) * 4, i10 = i00 + 4, i01 = i00 + vw * 4, i11 = i01 + 4, oi = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      o[oi + c] = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy) + (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
    }
    o[oi + 3] = 255;
    lum[(o[oi] * 0.3 + o[oi + 1] * 0.59 + o[oi + 2] * 0.11) | 0]++;
    hr[o[oi]]++; hg[o[oi + 1]]++; hb[o[oi + 2]]++;
  }
  // Neutral clean-up: make the paper white by scaling each colour channel to its own paper
  // brightness (removes the yellow/pink cast of room light) with one shared black point,
  // so ink and logos keep their real colours instead of being pushed into strong tints.
  const total = W * Hh;
  const pct = (h: Uint32Array, q: number) => { let acc = 0; for (let t = 0; t < 256; t++) { acc += h[t]; if (acc >= total * q) return t; } return 255; };
  const lo = Math.min(60, Math.round(pct(lum, 0.01) * 0.85));
  const wr = pct(hr, 0.9), wg = pct(hg, 0.9), wb = pct(hb, 0.9);
  if (Math.min(wr, wg, wb) - lo > 60) {
    const sr = 250 / (wr - lo), sg = 250 / (wg - lo), sb = 250 / (wb - lo);
    for (let i = 0; i < o.length; i += 4) { o[i] = (o[i] - lo) * sr; o[i + 1] = (o[i + 1] - lo) * sg; o[i + 2] = (o[i + 2] - lo) * sb; }
  }
  sharpen(o, W, Hh, 0.8);
  octx.putImageData(img, 0, 0);
  const image = oc.toDataURL('image/jpeg', 0.92);
  const lc = document.createElement('canvas'); lc.width = LOOK_W; lc.height = LOOK_H;
  const lctx = lc.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  lctx.drawImage(oc, 0, 0, LOOK_W, LOOK_H);
  const ld = lctx.getImageData(0, 0, LOOK_W, LOOK_H).data, look = new Uint8Array(LOOK_W * LOOK_H);
  for (let i = 0, j = 0; i < look.length; i++, j += 4) look[i] = 0.3 * ld[j] + 0.59 * ld[j + 1] + 0.11 * ld[j + 2];

  const tw = 120, th = Math.round((Hh * tw) / W);
  const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
  (tc.getContext('2d') as CanvasRenderingContext2D).drawImage(oc, 0, 0, tw, th);
  const thumb = tc.toDataURL('image/jpeg', 0.7);

  const os = Math.min(1, 1280 / Math.max(vw, vh));
  const ocv = document.createElement('canvas'); ocv.width = Math.round(vw * os); ocv.height = Math.round(vh * os);
  (ocv.getContext('2d') as CanvasRenderingContext2D).drawImage(fc, 0, 0, ocv.width, ocv.height);
  const original = ocv.toDataURL('image/jpeg', 0.75);
  return { image, thumb, original, originalRatio: vw / vh, look, aspect: W / Hh, size: [W, Hh] as [number, number] };
}

/* ---------- Text reading (Tesseract.js, runs on device) ---------- */
let ocrWorkerPromise: Promise<any> | null = null;
function loadScript(src: string) {
  return new Promise<void>((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('load failed'));
    document.head.appendChild(s);
  });
}
function getOcrWorker(): Promise<any> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const w = window as any;
      if (!w.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      const worker = await w.Tesseract.createWorker(['heb', 'eng']);
      try { await worker.setParameters({ user_defined_dpi: '300', tessedit_do_invert: '0', tessedit_pageseg_mode: '3' }); } catch { /* older engine */ }
      return worker;
    })();
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}
/**
 * Prepare a page for text reading: enlarge small text, convert to grey and
 * apply a local (adaptive) threshold so shadows from the phone and uneven
 * light don't swallow the letters.
 */
async function prepareForOcr(dataUrl: string, target = OCR_LONG_SIDE): Promise<HTMLCanvasElement> {
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('image')); img.src = dataUrl; });
  const long = Math.max(img.width, img.height);
  const k = Math.min(2, Math.max(0.6, target / long));
  const W = Math.round(img.width * k), H = Math.round(img.height * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H), d = id.data, n = W * H;
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.3 * d[j] + 0.59 * d[j + 1] + 0.11 * d[j + 2];
  // integral image for fast local means
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
  }
  const r = Math.max(8, Math.round(Math.min(W, H) / 40));
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      const mean = sum / area, v = g[y * W + x];
      const out = v < mean * 0.86 && mean - v > 10 ? 0 : 255;
      const j = (y * W + x) * 4; d[j] = d[j + 1] = d[j + 2] = out;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Drop lines that are mostly noise (stray marks the reader turned into symbols). */
function cleanOcrLines(text: string): string[] {
  return String(text || '').split('\n').map((l) => lightNorm(l).trim()).filter((l) => {
    const good = (l.match(/[\u05D0-\u05EAa-zA-Z0-9]/g) || []).length;
    const ok = (l.match(/[\u05D0-\u05EAa-zA-Z0-9₪.,:\/\-\s"'%()]/g) || []).length;
    return good >= 2 && ok / l.length >= 0.75;
  });
}

/* ---------- Parallel reading ----------
 * Tesseract reads one page on one core. Phones have 6–8 cores, so the page is
 * cut into horizontal bands at blank rows (never through a line of text) and
 * the bands are read at the same time by a small pool of readers. */
interface PdfPart { bytes: Uint8Array; rows: number; textOnly?: boolean }
type PagePdf = Uint8Array | PdfPart[];
function poolSize() {
  const cores = navigator.hardwareConcurrency || 4, mem = (navigator as any).deviceMemory || 4;
  return Math.max(1, Math.min(4, cores - 1, mem <= 3 ? 2 : 4));
}
let poolPromise: Promise<any[]> | null = null;
function getOcrPool(): Promise<any[]> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const first = await getOcrWorker();
      const w = window as any, n = poolSize();
      const rest = await Promise.all(Array.from({ length: n - 1 }, async () => {
        try {
          const wk = await w.Tesseract.createWorker(['heb', 'eng']);
          await wk.setParameters({ user_defined_dpi: '300', tessedit_do_invert: '0', tessedit_pageseg_mode: '3' });
          return wk;
        } catch { return null; }
      }));
      return [first, ...rest.filter(Boolean)];
    })();
    poolPromise.catch(() => { poolPromise = null; });
  }
  return poolPromise;
}
/** Rows to cut at: the emptiest row near each even split, so no text line is cut. */
function bandCuts(c: HTMLCanvasElement, n: number): number[] {
  const W = c.width, H = c.height;
  const d = (c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D).getImageData(0, 0, W, H).data;
  const ink = new Uint32Array(H);
  for (let y = 0; y < H; y++) { let k = 0; for (let x = 0, j = y * W * 4; x < W; x++, j += 4) if (d[j] < 128) k++; ink[y] = k; }
  const cuts = [0];
  for (let i = 1; i < n; i++) {
    const target = Math.round((H * i) / n), win = Math.round(H * 0.08);
    let best = target, bestInk = Infinity;
    for (let y = Math.max(cuts[cuts.length - 1] + 40, target - win); y < Math.min(H - 40, target + win); y++) {
      const v = ink[y] * 1000 + Math.abs(y - target);       // emptiest row, then the closest one
      if (v < bestInk) { bestInk = v; best = y; }
    }
    if (best > cuts[cuts.length - 1] + 40) cuts.push(best);
  }
  cuts.push(H);
  return cuts;
}
async function readBands(c: HTMLCanvasElement, workers: any[]): Promise<{ text: string; pdf: PdfPart[] }> {
  const n = c.height > 900 ? workers.length : 1;
  const cuts = bandCuts(c, n);
  const bands = cuts.slice(0, -1).map((y0, i) => {
    const h = cuts[i + 1] - y0, b = document.createElement('canvas');
    b.width = c.width; b.height = h;
    (b.getContext('2d') as CanvasRenderingContext2D).drawImage(c, 0, y0, c.width, h, 0, 0, c.width, h);
    return b;
  });
  const results: any[] = await Promise.all(bands.map((b, i) => workers[i % workers.length].recognize(b, { pdfTextOnly: true }, { text: true, pdf: true })));
  return {
    text: results.map((r) => r.data.text || '').join('\n'),
    pdf: results.map((r, i) => ({ bytes: new Uint8Array(r.data.pdf || []), rows: bands[i].height, textOnly: true })),
  };
}

/* ---------- Background reading queue ----------
 * Pages are read one at a time in the background as soon as they are
 * captured, so most of the work is already done when you tap Finish.
 * The reader also produces a searchable PDF page (image + hidden text). */
interface OcrOut { lines: string[]; ok: boolean }
const ocrJobs = new Map<string, Promise<OcrOut>>();
const pagePdf = new Map<string, PagePdf>();
let ocrChain: Promise<any> = Promise.resolve();
/** Set by the app so finished reads are saved with the page on the device. */
let onPageRead: (key: string, out: OcrOut, pdf: PagePdf | null) => void = () => {};
function readPage(page: RealPage): Promise<OcrOut> {
  const existing = ocrJobs.get(page.key);
  if (existing) return existing;
  const job: Promise<OcrOut> = ocrChain.then(async () => {
    let workers: any[];
    try { workers = await withTimeout(getOcrPool(), 90000); } catch { return { lines: [], ok: false }; }
    try {
      const prepared = await prepareForOcr(page.image);
      const r = await withTimeout(readBands(prepared, workers), 120000);
      let lines = cleanOcrLines(r.text);
      let pdf: PagePdf | null = r.pdf;
      if (lines.length < 2) { // cleanup may have lost faint text: try the photo as it is
        const r2: any = await withTimeout(workers[0].recognize(page.image, { pdfTextOnly: true }, { text: true, pdf: true }), 90000);
        const alt = cleanOcrLines(r2.data.text);
        if (alt.length > lines.length) { lines = alt; pdf = r2.data.pdf ? [{ bytes: new Uint8Array(r2.data.pdf), rows: 1, textOnly: true }] : pdf; }
      }
      if (pdf) pagePdf.set(page.key, pdf);
      try { onPageRead(page.key, { lines, ok: true }, pdf); } catch { /* storage unavailable */ }
      return { lines, ok: true };
    } catch { return { lines: [], ok: true }; }
  });
  ocrChain = job.catch(() => {});
  ocrJobs.set(page.key, job);
  return job;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/* ---------- Deterministic classification rules ---------- */
const SENDER_RULES: { re: RegExp; name?: string; cat: Category; store?: boolean }[] = [
  { re: /חברת החשמל|חשמל לישראל/, name: 'חברת החשמל', cat: 'Bills' },
  { re: /מי אביבים/, name: 'מי אביבים', cat: 'Bills' },
  { re: /תאגיד (ה)?מים|מי שבע|הגיחון|מי כרמל|מניב|מי רעננה|מי מודיעין|מי נתניה/, cat: 'Bills' },
  { re: /סופרגז/, name: 'סופרגז', cat: 'Bills' },
  { re: /אמישראגז/, name: 'אמישראגז', cat: 'Bills' },
  { re: /פזגז/, name: 'פזגז', cat: 'Bills' },
  { re: /בזק/, name: 'בזק', cat: 'Bills' },
  { re: /פרטנר|partner/i, name: 'פרטנר', cat: 'Bills' },
  { re: /סלקום|cellcom/i, name: 'סלקום', cat: 'Bills' },
  { re: /\bהוט\b|\bHOT\b/, name: 'הוט', cat: 'Bills' },
  { re: /המוסד לביטוח לאומי|ביטוח לאומי/, name: 'ביטוח לאומי', cat: 'Government' },
  { re: /רשות המסים/, name: 'רשות המסים', cat: 'Government' },
  { re: /רשות האוכלוסין/, name: 'רשות האוכלוסין', cat: 'Government' },
  { re: /עיריית\s?[֐-׿\-]{2,15}(\s[֐-׿\-]{2,10})?/, cat: 'Government' },
  { re: /משרד ה[֐-׿]{2,15}/, cat: 'Government' },
  { re: /כלל (חברה ל)?ביטוח/, name: 'כלל ביטוח', cat: 'Insurance' },
  { re: /הראל/, name: 'הראל ביטוח', cat: 'Insurance' },
  { re: /מגדל/, name: 'מגדל ביטוח', cat: 'Insurance' },
  { re: /הפניקס/, name: 'הפניקס', cat: 'Insurance' },
  { re: /מנורה/, name: 'מנורה מבטחים', cat: 'Insurance' },
  { re: /איילון/, name: 'איילון ביטוח', cat: 'Insurance' },
  { re: /ביטוח ישיר/, name: 'ביטוח ישיר', cat: 'Insurance' },
  { re: /בנק הפועלים|הפועלים/, name: 'בנק הפועלים', cat: 'Bank' },
  { re: /בנק לאומי/, name: 'בנק לאומי', cat: 'Bank' },
  { re: /דיסקונט/, name: 'בנק דיסקונט', cat: 'Bank' },
  { re: /מזרחי/, name: 'מזרחי טפחות', cat: 'Bank' },
  { re: /הבינלאומי/, name: 'הבינלאומי', cat: 'Bank' },
  { re: /ישראכרט/, name: 'ישראכרט', cat: 'Bank' },
  { re: /כאל|כרטיסי אשראי לישראל/, name: 'כאל', cat: 'Bank' },
  { re: /שופרסל/, name: 'שופרסל', cat: 'Other', store: true },
  { re: /רמי לוי/, name: 'רמי לוי', cat: 'Other', store: true },
  { re: /יוחננוף/, name: 'יוחננוף', cat: 'Other', store: true },
  { re: /ויקטורי/, name: 'ויקטורי', cat: 'Other', store: true },
  { re: /אושר עד/, name: 'אושר עד', cat: 'Other', store: true },
  { re: /טיב טעם/, name: 'טיב טעם', cat: 'Other', store: true },
  { re: /מחסני השוק/, name: 'מחסני השוק', cat: 'Other', store: true },
  { re: /יינות ביתן/, name: 'יינות ביתן', cat: 'Other', store: true },
  { re: /סופר[- ]?פארם/, name: 'סופר-פארם', cat: 'Other', store: true },
  { re: /קרפור/, name: 'קרפור', cat: 'Other', store: true },
  { re: /איקאה|IKEA/i, name: 'איקאה', cat: 'Other', store: true },
  { re: /הום סנטר/, name: 'הום סנטר', cat: 'Other', store: true },
  { re: /\bKSP\b/i, name: 'KSP', cat: 'Other', store: true },
  { re: /\bACE\b|אייס/i, name: 'ACE', cat: 'Other', store: true },
  { re: /פוקס|FOX/i, name: 'פוקס', cat: 'Other', store: true },
  { re: /קסטרו/, name: 'קסטרו', cat: 'Other', store: true },
  { re: /מקדונלדס/, name: 'מקדונלדס', cat: 'Other', store: true },
  { re: /ארומה/, name: 'ארומה', cat: 'Other', store: true },
  { re: /מכבי/, name: 'מכבי', cat: 'Other' },
  { re: /כללית/, name: 'כללית', cat: 'Other' },
  { re: /מאוחדת/, name: 'מאוחדת', cat: 'Other' },
];
const CATEGORY_HINTS: { re: RegExp; cat: Category; why: string }[] = [
  { re: /ארנונה/, cat: 'Government', why: 'Text mentions ארנונה (municipal tax)' },
  { re: /פוליסה|פרמיה/, cat: 'Insurance', why: 'Text mentions a policy or premium' },
  { re: /דף חשבון|יתרה|עו״ש|עו"ש/, cat: 'Bank', why: 'Text looks like a bank statement' },
  { re: /קוט״ש|קוט"ש|מ״ק|מ"ק|צריכה/, cat: 'Bills', why: 'Text mentions usage units' },
];
const TYPE_WORDS = ['חשבונית מס קבלה', 'חשבונית מס/קבלה', 'דף חשבון', 'חשבונית מס', 'חשבונית', 'הודעת תשלום', 'דרישת תשלום', 'קבלה', 'פוליסה', 'חשבון', 'הודעה', 'אישור', 'מכתב', 'Invoice', 'Receipt', 'Statement'];

/* ---------- Finding the document date ----------
 * Folds, creases and small print make the reader split or misread dates:
 * "0 1/09/2 2", "01.O9.22", "18,11.2025", "2025-11-18" or "18 בנובמבר 2025".
 * We repair common misreadings, accept all these shapes, and prefer the date
 * printed next to a label such as "תאריך" or "Date". */
const HE_MONTHS: Record<string, number> = { 'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12 };
const EN_MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_LABEL = /תאריך|ת\.\s?הפקה|הופק|date|issued/i;
function fixDigits(line: string): string {
  // Letters the reader often confuses with digits, only when they sit among digits
  return line
    .replace(/(?<=[\d.\/\-])[oOםס](?=[\d.\/\-])/g, '0')
    .replace(/(?<=[\d.\/\-])[lI|!ו](?=[\d.\/\-])/g, '1')
    .replace(/(?<=\d)[sS](?=\d)/g, '5')
    .replace(/(?<=\d)B(?=\d)/g, '8')
    // a crease can split a number: "0 1/09/2 2" -> "01/09/22"
    .replace(/(?<![\d])(\d)\s(\d)(?=\s?[.\/\-,])/g, '$1$2')
    .replace(/([.\/\-,])\s?(\d)\s(\d)(?![\d])/g, '$1$2$3');
}
function findDate(s: string): string {
  const year = new Date().getFullYear();
  const cands: { v: string; score: number; at: number }[] = [];
  const push = (d: number, m: number, y: number, score: number, at: number) => {
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || m < 1 || m > 12 || y < 1990 || y > year + 1) return;
    cands.push({ v: `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`, score, at });
  };
  s.split('\n').forEach((raw, li) => {
    const line = fixDigits(raw);
    const near = DATE_LABEL.test(line) ? 3 : 0;
    let m: RegExpExecArray | null;
    const dmy = /(?<!\d)(\d{1,2})\s?[.\/\-,:]\s?(\d{1,2})\s?[.\/\-,:]\s?(\d{4}|\d{2})(?!\d)/g;
    while ((m = dmy.exec(line))) push(+m[1], +m[2], +m[3], near + (m[3].length === 4 ? 1 : 0), li);
    const ymd = /(?<!\d)(\d{4})\s?[.\/\-]\s?(\d{1,2})\s?[.\/\-]\s?(\d{1,2})(?!\d)/g;
    while ((m = ymd.exec(line))) push(+m[3], +m[2], +m[1], near + 1, li);
    const heb = /(?<!\d)(\d{1,2})\s?(?:ב|ל)?(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s?,?\s?(\d{4})/g;
    while ((m = heb.exec(line))) push(+m[1], HE_MONTHS[m[2]], +m[3], near + 2, li);
    const eng = /(?<!\d)(\d{1,2})\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s?(\d{4})/gi;
    while ((m = eng.exec(line))) push(+m[1], EN_MONTHS[m[2].toLowerCase()], +m[3], near + 2, li);
    // A date on the line after a label ("תאריך:" on its own line)
    if (!near && li > 0 && DATE_LABEL.test(s.split('\n')[li - 1]) && cands.length && cands[cands.length - 1].at === li) cands[cands.length - 1].score += 2;
  });
  if (!cands.length) return '';
  cands.sort((a, b) => b.score - a.score || a.at - b.at);
  return cands[0].v;
}
function findAmount(lines: string[]): { amount: string; label: string } | null {
  const num = /(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/;
  const key = /לתשלום|סה["״׳']?כ|סכום|total|amount/i;
  for (const l of lines) { const k = l.match(key); const m = l.match(num); if (k && m) return { amount: `₪${m[1]}.${m[2]}`, label: k[0] }; }
  for (const l of lines) { if (/₪|ש["״]ח|NIS/i.test(l)) { const m = l.match(num); if (m) return { amount: `₪${m[1]}.${m[2]}`, label: '₪' }; } }
  return null;
}

function classifyPages(group: { pages: RealPage[]; texts: string[][] }, uid: string, ocrOk: boolean): ArchiveDoc {
  const lines = group.texts.flat();
  const all = lightNorm(lines.join('\n'));
  const forgiving = norm(all);
  let sender = '', senderSrc = '', category: Category = 'Other', catWhy = '';
  for (const r of SENDER_RULES) {
    const m = all.match(r.re);
    if (m) { senderSrc = m[0].trim(); sender = r.name || senderSrc; category = r.cat; if (r.store) catWhy = 'A store receipt. Add a category such as “Store receipts” to file these together'; break; }
  }
  if (!sender) for (const hnt of CATEGORY_HINTS) if (hnt.re.test(all)) { category = hnt.cat; catWhy = hnt.why; break; }
  // The person's own categories win: they said what these words mean.
  let userCat = '', userHit = '';
  for (const c of CUSTOM_RULES) {
    const hit = c.keywords.find((k) => norm(k) && forgiving.includes(norm(k)));
    if (hit) { userCat = c.name; userHit = hit; break; }
  }
  if (userCat) category = userCat;
  let senderGuess = false;
  if (!sender && userCat) {
    const top = (group.texts[0] || []).find((l) => /[\u05D0-\u05EAa-zA-Z]{2,}/.test(l));
    if (top) { sender = top.slice(0, 32); senderSrc = top.slice(0, 32); senderGuess = true; }
  }
  const typeWord = TYPE_WORDS.find((t) => all.includes(t)) || '';
  const date = findDate(all);
  const amt = findAmount(lines);
  const firstLine = (group.texts[0] || []).find((l) => /[֐-׿a-zA-Z]{3}/.test(l)) || '';
  const title = typeWord || firstLine.slice(0, 42) || 'מסמך';

  const reasons: Reason[] = [];
  reasons.push(sender
    ? { label: senderGuess ? 'Looks like sender' : 'Detected sender', value: sender, source: senderGuess ? 'First line of the page' : `Found “${senderSrc}” in the text` }
    : { label: 'Sender', value: 'Unknown', source: lines.length ? 'No known sender name in the text' : 'No text could be read from this page' });
  if (typeWord) reasons.push({ label: 'Detected document type', value: typeWord, source: `Text contains “${typeWord}”` });
  reasons.push(date
    ? { label: 'Detected date', value: date, source: 'First date found in the text' }
    : { label: 'Date', value: 'Not found', source: 'No date pattern in the text' });
  if (amt) reasons.push({ label: 'Detected amount', value: amt.amount, source: `Number next to “${amt.label}”` });
  reasons.push({ label: 'Looks like', value: category, source: userCat ? `Text contains “${userHit}” (your rule)` : catWhy || (sender ? 'Based on the sender' : 'No stronger match, so filed under Other') });

  if (group.pages.some((p) => p.blurry)) reasons.push({ label: 'Image', value: 'May be blurry', source: 'Focus didn’t fully settle while capturing. Check the original page' });
  const p0 = group.pages[0];
  return {
    id: uid, sender: sender || 'Unknown', letterhead: sender, address: '', title, typeWord,
    date, category, pages: group.pages.length, amount: amt?.amount, amountLabel: amt?.label,
    tint: '#8C95A2', kind: 'letter', tilt: 0,
    real: true, images: group.pages.map((p) => p.image), thumbs: group.pages.map((p) => p.thumb),
    originals: group.pages.map((p) => ({ src: p.original, quad: p.quad, ratio: p.originalRatio })),
    sources: group.pages.map((p) => (p.source ? { from: p.source, size: p.size } : null)),
    pageKeys: group.pages.map((p) => p.key), looks: group.pages.map((p) => p.look), aspects: group.pages.map((p) => p.aspect), pageTexts: group.texts, ocr: lines, reasons, pdfs: group.pages.map((p) => pagePdf.get(p.key) || null), blurry: group.pages.some((p) => p.blurry),
    review: !ocrOk || !lines.length || (!sender && !userCat) ? 'unclear' : undefined,
    capturedAt: clock(p0.capturedAt),
  } as ArchiveDoc;
}

/* ---------- Spotting the same page scanned twice ----------
 * Two scans of one page never match pixel for pixel: the framing, crop, light and the
 * reader's mistakes all differ. So a re-scan is recognised when (1) the pages look alike
 * after sliding and scaling one over the other, and (2) the text read from them mostly
 * agrees, unless (3) they clearly show a different date and amount, which is what tells
 * two monthly bills from the same company apart. */
const LOOK_W = 96, LOOK_H = 128;
interface PageFace { lines: string[]; look?: Uint8Array; aspect?: number }
function trigramCos(a: string, b: string): number {
  const grams = (t: string) => {
    const m = new Map<string, number>();
    norm(t).replace(/[^\u05D0-\u05EAa-z0-9]+/g, ' ').split(' ').forEach((w) => {
      if (w.length < 2) return;
      const x = ` ${w} `;
      for (let i = 0; i + 3 <= x.length; i++) { const g = x.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1); }
    });
    return m;
  };
  const A = grams(a), B = grams(b);
  let dot = 0, na = 0, nb = 0;
  A.forEach((v, k) => { na += v * v; const w = B.get(k); if (w) dot += v * w; });
  B.forEach((v) => { nb += v * v; });
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
/** Softened copy of a look: a slight blur makes the comparison tolerant of small offsets. */
const softCache = new WeakMap<Uint8Array, Float32Array>();
function soften(a: Uint8Array): Float32Array {
  const hit = softCache.get(a); if (hit) return hit;
  let cur = Float32Array.from(a);
  const tmp = new Float32Array(cur.length), W = LOOK_W, H = LOOK_H, r = 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += cur[y * W + xx]; n++; } } tmp[y * W + x] = s / n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } } cur[y * W + x] = s / n;
    }
  }
  softCache.set(a, cur);
  return cur;
}
function resizeLook(b: Float32Array, sc: number): { B: Float32Array; bw: number; bh: number } {
  const bw = Math.round(LOOK_W * sc), bh = Math.round(LOOK_H * sc), B = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const sy = Math.min(LOOK_H - 1.001, Math.max(0, (y + 0.5) / sc - 0.5)), y0 = sy | 0, fy = sy - y0;
    for (let x = 0; x < bw; x++) {
      const sx = Math.min(LOOK_W - 1.001, Math.max(0, (x + 0.5) / sc - 0.5)), x0 = sx | 0, fx = sx - x0, i = y0 * LOOK_W + x0;
      B[y * bw + x] = (b[i] * (1 - fx) + b[i + 1] * fx) * (1 - fy) + (b[i + LOOK_W] * (1 - fx) + b[i + LOOK_W + 1] * fx) * fy;
    }
  }
  return { B, bw, bh };
}
/** Best correlation of the middle of page A against page B, over small shifts and zooms (coarse, then fine). */
function lookCorr(aRaw: Uint8Array, bRaw: Uint8Array): number {
  const a = soften(aRaw), b = soften(bRaw);
  const cw = 72, ch = 96, ax = (LOOK_W - cw) >> 1, ay = (LOOK_H - ch) >> 1, n = cw * ch;
  const win = new Float32Array(n);
  let m = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const v = a[(ay + y) * LOOK_W + ax + x]; win[y * cw + x] = v; m += v; }
  m /= n;
  let sd = 0; for (let i = 0; i < n; i++) { win[i] -= m; sd += win[i] * win[i]; }
  sd = Math.sqrt(sd / n) || 1;
  const at = (B: Float32Array, bw: number, dx: number, dy: number) => {
    let s = 0, s2 = 0, sab = 0;
    for (let y = 0; y < ch; y++) {
      const row = (dy + y) * bw + dx, wr = y * cw;
      for (let x = 0; x < cw; x++) { const v = B[row + x]; s += v; s2 += v * v; sab += v * win[wr + x]; }
    }
    const mb = s / n, sdb = Math.sqrt(Math.max(1e-6, s2 / n - mb * mb));
    return sab / n / (sd * sdb);
  };
  const scales = [0.86, 0.9, 0.95, 1, 1.05, 1.1, 1.16];
  const sized = scales.map((sc) => resizeLook(b, sc));
  let best = -1, bs = 3, bx = 0, by = 0;
  sized.forEach(({ B, bw, bh }, si) => {
    for (let dy = 0; dy + ch <= bh; dy += 3) for (let dx = 0; dx + cw <= bw; dx += 3) {
      const c = at(B, bw, dx, dy); if (c > best) { best = c; bs = si; bx = dx; by = dy; }
    }
  });
  for (let si = Math.max(0, bs - 1); si <= Math.min(scales.length - 1, bs + 1); si++) {
    const { B, bw, bh } = sized[si];
    const cx = si === bs ? bx : Math.round((bx * scales[si]) / scales[bs]), cy = si === bs ? by : Math.round((by * scales[si]) / scales[bs]);
    for (let dy = Math.max(0, cy - 3); dy <= Math.min(bh - ch, cy + 3); dy++) for (let dx = Math.max(0, cx - 3); dx <= Math.min(bw - cw, cx + 3); dx++) {
      const c = at(B, bw, dx, dy); if (c > best) best = c;
    }
  }
  return best;
}
function isSamePage(a: PageFace, b: PageFace): boolean {
  if (!a.look || !b.look) return false;
  if (a.aspect && b.aspect && Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect) > 0.22) return false;
  const ta = a.lines.join('\n'), tb = b.lines.join('\n');
  const hasText = a.lines.length >= 3 && b.lines.length >= 3;
  const tc = hasText ? trigramCos(ta, tb) : -1;
  if (hasText && tc < 0.4) return false;                      // clearly different text
  const need = hasText ? 0.8 : 0.9;
  let ic = lookCorr(a.look, b.look);
  if (ic < need && ic > need - 0.2) ic = Math.max(ic, lookCorr(b.look, a.look)); // check the other way round only when close
  if (ic < need) return false;                                 // they don't look alike
  const da = findDate(ta), db = findDate(tb), ma = findAmount(a.lines)?.amount, mb = findAmount(b.lines)?.amount;
  const dateDiffers = !!(da && db && da !== db), amountDiffers = !!(ma && mb && ma !== mb);
  if (dateDiffers && amountDiffers) return false;             // e.g. this month's bill and last month's
  if (tc < 0.5 && (dateDiffers || amountDiffers)) return false;
  return true;
}

function buildRealDocs(pages: RealPage[], texts: string[][], ocrOk: boolean, existing: ArchiveDoc[] = []): ArchiveDoc[] {
  const groups: { pages: RealPage[]; texts: string[][]; dupOf?: string | number }[] = [];
  const contRe = /עמוד\s*([2-9]|1\d)\b|page\s*([2-9])\s*(of|\/)/i;
  // Every page seen so far: pages of documents already in the archive, then this batch
  const known: (PageFace & { ref: string | number })[] = [];
  existing.forEach((d) => (d.looks || []).forEach((look, i) => known.push({ look, aspect: d.aspects?.[i], lines: d.pageTexts?.[i] || [], ref: d.id })));
  pages.forEach((p, i) => {
    const me: PageFace = { lines: texts[i], look: p.look, aspect: p.aspect };
    const twin = known.find((k) => isSamePage(me, k));
    if (twin) {
      // Same page scanned again: keep it apart as its own document and ask, instead of adding it as "page 2"
      groups.push({ pages: [p], texts: [texts[i]], dupOf: twin.ref });
    } else if (groups.length && contRe.test(texts[i].join(' ')) && groups[groups.length - 1].dupOf === undefined) {
      const g = groups[groups.length - 1]; g.pages.push(p); g.texts.push(texts[i]);
    } else groups.push({ pages: [p], texts: [texts[i]] });
    known.push({ ...me, ref: groups.length - 1 });
  });
  const stamp = Date.now().toString(36);
  const docs = groups.map((g, i) => classifyPages(g, `r${stamp}${i}`, ocrOk));
  groups.forEach((g, i) => {
    if (g.dupOf === undefined) return;
    docs[i].review = 'duplicate';
    docs[i].duplicateOf = typeof g.dupOf === 'number' ? docs[g.dupOf].id : g.dupOf;
  });
  return docs;
}

/* ---------- Real camera screen ---------- */
const REAL_STATUS: Record<RealPhase, string> = {
  searching: 'Place a document on the table',
  detected: 'Document detected',
  steady: 'Hold still…',
  focusing: 'Focusing…',
  captured: 'Captured',
  same: 'Captured. Place the next page',
};

function RealCameraScreen({ stream, onFinish, onRestart, onExit, openPrivacy, initialPages = [], onPageCaptured = () => {}, onPageUpgraded = () => {}, sessionName = '', existingFaces = [], target = null }: any) {
  const videoRef = useRef(null);
  const cvRef = useRef(null as any);
  if (!cvRef.current) cvRef.current = document.createElement('canvas');
  const [running, setRunning] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [pages, setPages] = useState(initialPages as RealPage[]);
  const [phase, setPhase] = useState('searching' as RealPhase);
  const [quad, setQuad] = useState(null as Pt[] | null);
  const [progress, setProgress] = useState(0);
  const [ratio, setRatio] = useState(3 / 4);
  const [flashKey, setFlashKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [readKeys, setReadKeys] = useState(new Set() as Set<string>);
  const [dupKeys, setDupKeys] = useState(new Set() as Set<string>);
  const [torch, setTorch] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const finished = useRef(false);
  function toggleTorch() {
    const t = focusRef.current.track; if (!t) return;
    const next = !torch;
    t.applyConstraints({ advanced: [{ torch: next }] }).then(() => setTorch(next)).catch(() => setHasTorch(false));
  }
  const faces = useRef(new Map() as Map<string, PageFace>);
  const [lastBlurry, setLastBlurry] = useState(false);
  const stripRef = useRef(null);
  const sharpRef = useRef(null as any);
  if (!sharpRef.current) sharpRef.current = document.createElement('canvas');
  const focusRef = useRef({ track: null as any, caps: {} as any });
  const stillOk = useRef(true);
  const stillFails = useRef(0);
  const photoSettings = useRef(null as any);
  const stillCv = useRef(null as any);
  const stillCv2 = useRef(null as any);
  if (!stillCv2.current) stillCv2.current = document.createElement('canvas');
  if (!stillCv.current) stillCv.current = document.createElement('canvas');

  /**
   * After the instant capture from the video, ask the camera for a full-resolution still
   * photo (Chrome on Android supports this) and re-cut the page from it. The video stream is
   * only ~2 MP; the still is the phone's full sensor, so the scan and PDF are much sharper.
   * If the phone is slow at this, it's switched off for the rest of the session.
   */
  async function upgradeWithStill(page: RealPage): Promise<RealPage> {
    const IC = (window as any).ImageCapture, track = focusRef.current.track;
    if (!stillOk.current || !IC || !track || track.readyState !== 'live') return page;
    try {
      const ic = new IC(track);
      if (!photoSettings.current) {
        // Ask for the camera's largest photo size (the default is sometimes smaller)
        try {
          const caps: any = await withTimeout(ic.getPhotoCapabilities(), 2000);
          photoSettings.current = caps?.imageWidth?.max ? { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight?.max } : {};
        } catch { photoSettings.current = {}; }
      }
      let blob: Blob;
      try { blob = await withTimeout(ic.takePhoto(photoSettings.current), 6000); }
      catch { blob = await withTimeout(ic.takePhoto(), 6000); photoSettings.current = {}; }
      const bmp: any = await createImageBitmap(blob);
      stillFails.current = 0;
      const det2 = detectPaperIn(bmp, bmp.width, bmp.height, stillCv.current);
      if (!det2) return page;
      const ratioOf = (q: Pt[], w: number, h: number) => dist([q[0][0] * w, q[0][1] * h], [q[1][0] * w, q[1][1] * h]) / Math.max(1, dist([q[0][0] * w, q[0][1] * h], [q[3][0] * w, q[3][1] * h]));
      const v = videoRef.current as HTMLVideoElement;
      const r1 = ratioOf(page.quad, v.videoWidth, v.videoHeight), r2 = ratioOf(det2.quad, bmp.width, bmp.height);
      if (Math.abs(r1 - r2) / r1 > 0.12) return page;                         // a different paper moved in
      // Keep the photo only if it really is sharper (a hand or a refocus can blur it)
      const stillSharp = sharpnessIn(bmp, bmp.width, bmp.height, det2.quad, stillCv2.current);
      if (page.sharpness && stillSharp < page.sharpness * 0.9) { bmp.close?.(); return page; }
      const shot = captureFrom(bmp, bmp.width, bmp.height, det2.quad, 3200);
      bmp.close?.();
      return { ...page, ...shot, quad: det2.quad, source: 'photo' };
    } catch { if (++stillFails.current >= 3) stillOk.current = false; return page; }
  }
  const lastInitial: RealPage | undefined = initialPages[initialPages.length - 1];
  const st = useRef({
    focusMax: 0, focusMaxAt: 0, lastSharp: 0, lastBlurryCapture: false, lastKey: '', focusedFor: '',
    smooth: null as Pt[] | null, stableSince: 0, lastSeen: 0, lastSig: null as number[] | null, lastQuad: null as Pt[] | null,
    waitingNew: false, cooldownUntil: 0, searchingSince: performance.now(),
    ...(lastInitial ? { lastSig: lastInitial.sig, lastQuad: lastInitial.quad, waitingNew: true } : {}),
  });
  const active = useRef(true);
  active.current = running && !confirm;

  useEffect(() => {
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v) return;
    v.srcObject = stream;
    focusRef.current = setupFocus(stream);
    setHasTorch(!!focusRef.current.caps.torch);
    const onMeta = () => { if (v.videoWidth) setRatio(v.videoWidth / v.videoHeight); };
    v.addEventListener('loadedmetadata', onMeta);
    v.play?.().catch(() => {});
    onMeta();
    return () => v.removeEventListener('loadedmetadata', onMeta);
  }, [stream]);

  useEffect(() => {
    getOcrPool().catch(() => {}); // start all readers now, so pages are read while you keep going
    // Pages from an earlier visit: finish reading any that weren't read yet
    initialPages.forEach((p: RealPage) => readPage(p).then((out) => {
      setReadKeys((ks: Set<string>) => new Set(ks).add(p.key));
      faces.current.set(p.key, { lines: out.lines, look: p.look, aspect: p.aspect });
    }));
  }, []);

  // Keep the screen on while capturing; a sleeping phone would stop the camera
  useEffect(() => {
    let lock: any = null, gone = false;
    const ask = async () => { try { lock = await (navigator as any).wakeLock?.request('screen'); if (gone) lock?.release(); } catch { /* not allowed */ } };
    const onVis = () => { if (document.visibilityState === 'visible') ask(); };
    ask(); document.addEventListener('visibilitychange', onVis);
    return () => { gone = true; document.removeEventListener('visibilitychange', onVis); try { lock?.release(); } catch { /* already released */ } };
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((e: number) => e + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => { if (stripRef.current) stripRef.current.scrollLeft = stripRef.current.scrollWidth; }, [pages.length]);

  function capture(q: Pt[], det: Detection | null, sharp = 0, blurry = false, replaceKey = '') {
    const v = videoRef.current as HTMLVideoElement, s = st.current;
    try {
      const shot = captureFrame(v, q);
      const sig = det ? signature(det, q) : [];
      const page: RealPage = { key: `p${Date.now()}`, ...shot, quad: q, sig, capturedAt: Date.now(), sharpness: sharp, blurry };
      setPages((ps: RealPage[]) => (replaceKey ? ps.map((p) => (p.key === replaceKey ? page : p)) : [...ps, page]));
      onPageCaptured(page, replaceKey);
      upgradeWithStill(page).then((up) => {
        if (up !== page) { setPages((ps: RealPage[]) => ps.map((p) => (p.key === page.key ? up : p))); onPageUpgraded(up); }
        if (target?.mode === 'retake' && !finished.current) { finished.current = true; setTimeout(() => onFinish([up]), 450); }
        readPage(up).then((out) => {
          setReadKeys((ks: Set<string>) => new Set(ks).add(up.key));
          const me: PageFace = { lines: out.lines, look: up.look, aspect: up.aspect };
          let twin = false;
          faces.current.forEach((f, k) => { if (!twin && k !== up.key && isSamePage(me, f)) twin = true; });
          (existingFaces as PageFace[]).forEach((f) => { if (!twin && isSamePage(me, f)) twin = true; });
          faces.current.set(up.key, me);
          if (twin) setDupKeys((ks: Set<string>) => new Set(ks).add(up.key));
        });
      });
      s.lastSig = sig; s.lastQuad = q; s.waitingNew = true; s.cooldownUntil = performance.now() + 550;
      s.lastSharp = sharp; s.lastBlurryCapture = blurry; s.lastKey = page.key;
      setLastBlurry(blurry);
      setPhase('captured'); setFlashKey((k: number) => k + 1); setProgress(0); setShowHelp(false);
      try { navigator.vibrate?.(25); } catch { /* not supported */ }
    } catch (e) { console.error(e); }
  }

  function step() {
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v || v.readyState < 2) return;
    const s = st.current, now = performance.now();
    const det = detectPaper(v, cvRef.current);
    if (!det) {
      if (now - s.lastSeen > 450) {
        s.smooth = null; setQuad(null); s.waitingNew = false; s.stableSince = 0;
        if (now > s.cooldownUntil) { setPhase('searching'); setProgress(0); }
        if (now - s.searchingSince > 7000) setShowHelp(true);
      }
      return;
    }
    s.lastSeen = now; s.searchingSince = now;
    const q: Pt[] = s.smooth ? s.smooth.map((p, i) => [p[0] * 0.45 + det.quad[i][0] * 0.55, p[1] * 0.45 + det.quad[i][1] * 0.55] as Pt) : det.quad;
    const delta = s.smooth ? maxCornerDelta(q, s.smooth) : 1;
    s.smooth = q; setQuad(q);
    if (now < s.cooldownUntil) return;
    if (delta > 0.012) { s.stableSince = 0; setProgress(0); setPhase(s.waitingNew ? 'same' : 'detected'); return; }
    if (!s.stableSince) {
      s.stableSince = now; s.focusMax = 0; s.focusMaxAt = now;
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      if (!s.focusedFor) { focusOn(focusRef.current, cx, cy); s.focusedFor = 'once'; } // aim focus once; continuous autofocus does the rest
    }
    if (s.waitingNew) {
      if (now - s.stableSince < 300) { setPhase('same'); return; }
      const sameSpot = s.lastQuad ? maxCornerDelta(q, s.lastQuad) < 0.05 : false;
      const samePage = s.lastSig ? sigDiff(signature(det, q), s.lastSig) < 0.5 : false;
      if (sameSpot && samePage) {
        // Same page still there. If the last copy was blurry and it is sharper now, quietly replace it.
        if (s.lastBlurryCapture) {
          const sh = measureSharpness(v, q, sharpRef.current);
          if (sh > s.lastSharp * 1.35) { capture(q, det, sh, false, s.lastKey); return; }
        }
        setPhase('same'); return;
      }
      s.waitingNew = false; s.stableSince = now; s.focusMax = 0; s.focusMaxAt = now; // a different page is on the table
    }
    // Hold still, then wait for focus to settle: sharpness stops improving and stays near its best.
    const sh = measureSharpness(v, q, sharpRef.current);
    if (sh > s.focusMax * 1.03) { s.focusMax = sh; s.focusMaxAt = now; }
    const held = now - s.stableSince;
    const settled = now - s.focusMaxAt > 120 && sh >= s.focusMax * 0.85 && s.focusMax > 0;
    // No fine detail at all: a blank wall, screen or tabletop, not a document
    if (held > 400 && s.focusMax < MIN_DETAIL) { setPhase('searching'); setQuad(null); setProgress(0); (window as any).__paLastDetail = s.focusMax; return; }
    (window as any).__paLastDetail = s.focusMax;
    if (held < STEADY_MS) { setPhase('steady'); setProgress(held / STEADY_MS); return; }
    if (settled) { capture(q, det, sh, false); return; }
    if (held > STEADY_MS + FOCUS_GIVE_UP_MS) { capture(q, det, sh, true); return; }
    setPhase('focusing'); setProgress(1);
  }

  useEffect(() => {
    let raf = 0, last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!active.current || t - last < 90) return;
      last = t; step();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function captureWholeView() {
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v) return;
    const det = detectPaper(v, cvRef.current);
    capture(st.current.smooth || det?.quad || [[0.03, 0.03], [0.97, 0.03], [0.97, 0.97], [0.03, 0.97]], det);
  }

  const stepIdx: Record<RealPhase, number> = { searching: -1, detected: 0, steady: 1, focusing: 2, captured: 3, same: 3 };
  const steps = ['Detected', 'Holding still', 'In focus', 'Captured'];
  const activeStep = stepIdx[phase as RealPhase];
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0');
  const statusClass = phase === 'searching' ? 'status-clear' : phase === 'captured' || phase === 'same' ? 'status-captured' : '';

  return (
    <div className="cam">
      <header className="cam-top">
        <div className="cam-left">
          {!target && <button className="btn btn-cam btn-sm" onClick={() => { setRunning(false); setConfirm(true); }} type="button"><Icon name="restart" size={15} /> Start over</button>}
        </div>
        <div className="cam-title"><span className={`rec ${running ? '' : 'off'}`} /> {running ? 'Archiving' : 'Paused'} <span className="cam-time">{mm}:{ss}</span></div>
        <LocalPill onClick={openPrivacy} label="Local processing" dark />
      </header>

      <div className="cam-stage">
        <div className="cam-frame real-frame" style={{ aspectRatio: String(ratio), width: `min(100%, calc((100dvh - 300px) * ${ratio}))` }}>
          <video ref={videoRef} className="real-video" autoPlay muted playsInline />
          <svg className="quad-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            {quad && <polygon className={`quad quad-${phase}`} points={quad.map((p) => p.join(',')).join(' ')} />}
          </svg>
          {flashKey > 0 && <div key={flashKey} className="real-flash" />}
          <div className={`status ${statusClass}`} role="status" aria-live="polite">
            {phase === 'steady' && (
              <svg className="ring" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="8" className="ring-bg" />
                <circle cx="10" cy="10" r="8" className="ring-fg live" style={{ strokeDashoffset: 50.3 * (1 - progress) }} />
              </svg>
            )}
            {phase === 'focusing' && <span className="focus-dot" aria-hidden="true" />}
            {(phase === 'captured' || phase === 'same') && <Icon name="check" size={14} />}
            <span>{(phase === 'captured' || phase === 'same') && lastBlurry ? 'Captured, a little soft. Keep it still for a sharper copy' : REAL_STATUS[phase as RealPhase]}</span>
          </div>
          {confirm && (
            <div className="paused">
              <strong>Start over?</strong>
              <span>{pages.length ? `The ${plural(pages.length, 'page')} not yet sorted will be discarded. Documents already in this archive stay.` : 'Nothing has been captured yet.'}</span>
              <div className="cta-row center">
                <button className="btn btn-cam" onClick={() => { setConfirm(false); setRunning(true); }} type="button">Keep going</button>
                <button className="btn btn-light" onClick={onRestart} type="button"><Icon name="restart" size={16} /> Start over</button>
              </div>
              <button className="link-cam" onClick={onExit} type="button">Leave for now. Your pages are saved</button>
            </div>
          )}
          {!running && !confirm && (
            <div className="paused">
              <strong>Paused</strong>
              <span>Captured pages are kept on this device.</span>
              <button className="btn btn-light" onClick={() => setRunning(true)} type="button"><Icon name="play" size={16} /> Resume</button>
            </div>
          )}
        </div>
      </div>

      <footer className="cam-bottom">
        <div className="cam-stats">
          <div className="counts">
            <span className="big">{plural(pages.length, 'page')}</span><span className="dot">·</span><span className="sub">{pages.length ? `${pages.filter((p) => readKeys.has(p.key)).length} read so far` : 'read while you work'}</span>
          </div>
          <ol className="capture-steps" aria-label="Current page">
            {steps.map((x, i) => <li key={x} className={i < activeStep ? 'past' : i === activeStep ? 'now' : ''}>{x}</li>)}
          </ol>
        </div>

        <div className="strip" ref={stripRef} aria-label="Captured pages">
          {target && pages.length === initialPages.length && !showHelp && <span className="strip-empty target-note">{target.mode === 'retake' ? `Retaking page ${target.index + 1} of “${target.title}”. Lay the page down and hold still.` : `Adding pages to “${target.title}”. Lay each page down, then tap Done.`}</span>}
          {!target && pages.length === 0 && !showHelp && <span className="strip-empty">No buttons to press. Lay a document down and let go.</span>}
          {dupKeys.size > 0 && pages.length > 0 && dupKeys.has(pages[pages.length - 1].key) && <span className="strip-empty dup-note">That page was already scanned. It will be marked as a possible duplicate.</span>}
          {initialPages.length > 0 && pages.length === initialPages.length && !showHelp && <span className="strip-empty">Continuing {sessionName ? `“${sessionName}”` : 'your archive'}. Place the next document.</span>}
          {showHelp && (
            <span className="help-row">
              Not detecting? A table darker than the paper works best.
              <button className="link-cam" onClick={captureWholeView} type="button">Capture the view now</button>
            </span>
          )}
          {pages.map((p, i) => (
            <div key={p.key} className={`strip-item ${i === pages.length - 1 ? 'is-new' : ''}`}>
              <img className="strip-img" src={p.thumb} alt={`Captured page ${i + 1}`} />
              {dupKeys.has(p.key) && <span className="dup-mark" title="Looks like a page you already scanned">2×</span>}
              <span className={`read-mark ${readKeys.has(p.key) ? 'done' : ''}`} title={readKeys.has(p.key) ? 'Text read' : 'Reading text…'}>
                {readKeys.has(p.key) ? <Icon name="check" size={10} /> : <span className="mini-spin" />}
              </span>
            </div>
          ))}
        </div>

        <div className="cam-actions">
          <button className="btn btn-cam" onClick={() => setRunning(!running)} type="button">
            <Icon name={running ? 'pause' : 'play'} size={16} /> {running ? 'Pause' : 'Resume'}
          </button>
          {hasTorch && (
            <button className={`btn btn-cam ${torch ? 'is-on' : ''}`} onClick={toggleTorch} type="button" aria-pressed={torch}>
              <Icon name="bolt" size={16} /> Light
            </button>
          )}
          {target ? (
            <button className="btn btn-light" onClick={() => { finished.current = true; onFinish(pages.slice(initialPages.length)); }} type="button">{target.mode === 'retake' ? 'Cancel' : 'Done'}</button>
          ) : (
            <button className="btn btn-light" onClick={() => onFinish(pages)} type="button">Finish archive</button>
          )}
        </div>
      </footer>
    </div>
  );
}

function RealProcessingScreen({ pages, onView, openPrivacy, existing = [] }: any) {
  const [step, setStep] = useState(0);
  const [ocrCount, setOcrCount] = useState(0);
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null as null | { docs: ArchiveDoc[]; dupes: number; ocrOk: boolean });

  useEffect(() => {
    let live = true;
    (async () => {
      await wait(450); if (!live) return; setStep(1);
      await wait(400); if (!live) return; setStep(2);
      // Most pages were already read in the background during capture; this waits for the rest.
      const texts: string[][] = [];
      let anyOk = false;
      for (let i = 0; i < pages.length; i++) {
        const out = await readPage(pages[i]);
        if (!live) return;
        anyOk = anyOk || out.ok;
        if (!out.ok) setNote('Text reader unavailable, pages kept as images');
        texts.push(out.lines); setOcrCount(i + 1);
      }
      setStep(3);
      const docs = buildRealDocs(pages, texts, anyOk, existing);
      await wait(450); if (!live) return; setStep(4);
      const dupes = docs.filter((d) => d.review === 'duplicate').length;
      await wait(400); if (!live) return; setStep(5);
      await wait(350); if (!live) return; setStep(6);
      setResult({ docs, dupes, ocrOk: anyOk });
    })();
    return () => { live = false; };
  }, []);

  const docs = result?.docs || [];
  const cats = new Set(docs.map((d) => d.category)).size;
  const review = docs.filter((d) => d.review).length;
  const stages = [
    ['Documents detected', plural(pages.length, 'page') + ' captured'],
    ['Pages separated', plural(pages.length, 'page')],
    ['Text extracted', note || `${ocrCount} of ${pages.length} pages`],
    ['Documents classified', result ? plural(cats, 'category', 'categories') : '…'],
    ['Duplicates checked', result ? plural(result.dupes, 'possible duplicate') : '…'],
    ['Archive created', 'Saved on this device'],
  ];

  return (
    <div className="page">
      <AppHeader onHome={() => {}} openPrivacy={openPrivacy} />
      <main className="narrow processing">
        <h1 className="h-page">{result ? 'Your archive is ready' : 'Building your archive'}</h1>
        {!result && <p className="muted">Reading your pages on this device. The text reader is downloaded once; your pages are never uploaded.</p>}
        <ol className="stages">
          {stages.map(([label, detail], i) => (
            <li key={label} className={i < step ? 'done' : i === step ? 'now' : ''}>
              <span className="stage-mark">{i < step ? <Icon name="check" size={14} /> : i === step ? <span className="spin" /> : null}</span>
              <span className="stage-label">{label}</span>
              <span className="stage-detail">{i <= step ? detail : ''}</span>
            </li>
          ))}
        </ol>
        {result && (
          <>
            <dl className="summary">
              <div><dt>Documents</dt><dd>{docs.length}</dd></div>
              <div><dt>Pages</dt><dd>{pages.length}</dd></div>
              <div><dt>Categories</dt><dd>{cats}</dd></div>
              <div><dt>Possible duplicates</dt><dd>{result.dupes}</dd></div>
              <div className={review ? 'warn' : ''}><dt>Need review</dt><dd>{review}</dd></div>
            </dl>
            <div className="cta-row">
              <button className="btn btn-primary btn-lg" onClick={() => onView(docs)} type="button">View archive</button>
            </div>
            <p className="fine"><Icon name="lock" size={13} /> 0 bytes of your documents uploaded. Every step ran in this browser.</p>
          </>
        )}
      </main>
    </div>
  );
}



