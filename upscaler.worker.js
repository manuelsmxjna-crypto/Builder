// Web Worker for AI Upscaling (Real-ESRGAN family) via ONNX Runtime Web.
// Runs entirely in the browser. Tries WebGPU first for ~10–30× speed-up,
// falls back to WASM SIMD when WebGPU is unavailable.
//
// Protocol with the page:
//   in : { id, type:'run', rgba, width, height, modelUrl, preferGpu, tile, pad, alphaMode }
//   in : { id, type:'cancel' }
//   out: { id, type:'progress', stage, pct }
//   out: { id, type:'done', ok:true,  rgba, width, height, scale, backend }
//   out: { id, type:'done', ok:false, error }
'use strict';

const ORT_VERSION = '1.18.0';
// Try the LOCAL copy first (shipped under ./ort/ in this repo) so the app
// works offline / behind firewalls with no extra setup from the user.
// If for any reason the local files are missing, we fall back to CDN
// mirrors. Each base URL must end with a slash and host the standard
// `ort.*.min.js` files plus the `*.wasm` binaries.
const ORT_CDN_BASES = [
  './ort/',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/',
  'https://unpkg.com/onnxruntime-web@'           + ORT_VERSION + '/dist/',
];

// NOTE: do NOT declare a top-level `let ort` here. The ONNX Runtime
// bundle itself declares `var ort = (()=>{...})()` at the top of the
// loaded script, and `let` + `var` colliding on the same identifier
// throws a SyntaxError at parse time inside `importScripts`. We read
// the runtime through `self.ort` after a successful import instead.
let ortApi = null;
let ortInit = null;
let ortBaseUrl = null;        // resolved base URL used to load wasm binaries
const sessions = new Map();   // modelUrl -> InferenceSession
const cancelled = new Set();  // request ids the page asked to abort

// Tries `importScripts(url)` and returns null on success, or the captured
// error string on failure. Worker globals stay clean because importScripts
// is synchronous and atomic — a failed call doesn't pollute.
function tryImport(url){
  try { importScripts(url); return null; }
  catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return (e && e.name) ? (e.name + ': ' + msg) : msg;
  }
}

function loadOrt(preferGpu, overrideBase){
  if (ortInit) return ortInit;
  // Build the promise. If it rejects, clear `ortInit` so the next call
  // can retry instead of returning the same failed promise forever.
  ortInit = (async () => {
    // Build the list of (base, file) candidates to try, in order:
    //   1. caller-provided override (if any), preferred build first
    //   2. each CDN base, preferred build first
    // Preferred = webgpu build when GPU is wanted, plain wasm build otherwise.
    const bases = [];
    if (overrideBase){
      bases.push(overrideBase.endsWith('/') ? overrideBase : overrideBase + '/');
    }
    for (const b of ORT_CDN_BASES) bases.push(b);

    const filesPrimary   = preferGpu ? ['ort.webgpu.min.js', 'ort.min.js']
                                     : ['ort.min.js', 'ort.webgpu.min.js'];

    const tried = [];   // [{ url, err }]
    for (const base of bases){
      for (const file of filesPrimary){
        const url = base + file;
        const err = tryImport(url);
        tried.push({ url, err });
        if (err === null){
          // importScripts succeeded — ORT must have set `self.ort`.
          if (self.ort){
            ortApi = self.ort;
            ortBaseUrl = base;
            break;
          }
          // Loaded but didn't expose `self.ort` (shouldn't happen with
          // the canonical ORT bundles, but flag it as an error so we
          // keep trying other candidates and surface a useful message).
          tried[tried.length - 1].err = 'loaded, but self.ort is undefined';
        }
      }
      if (ortApi) break;
    }
    if (!ortApi){
      const lines = tried.map(t => '  - ' + t.url + (t.err ? '\n      → ' + t.err : ''));
      throw new Error(
        'Could not load ONNX Runtime Web from any source. Tried:\n' +
        lines.join('\n')
      );
    }

    ortApi.env.wasm.wasmPaths = ortBaseUrl;
    ortApi.env.wasm.simd      = true;
    // Multi-threaded WASM needs SharedArrayBuffer (cross-origin-isolated
    // page). When that's not available, fall back to single-thread cleanly.
    const canSAB = typeof SharedArrayBuffer !== 'undefined';
    const cores  = (self.navigator && self.navigator.hardwareConcurrency) || 2;
    ortApi.env.wasm.numThreads = canSAB ? Math.max(1, Math.min(4, cores)) : 1;
    return ortApi;
  })();
  ortInit.catch(() => { ortInit = null; });
  return ortInit;
}

async function ensureSession(modelUrl, preferGpu, ortBase){
  const key = modelUrl + '|' + (preferGpu ? 'gpu' : 'cpu');
  if (sessions.has(key)) return sessions.get(key);
  await loadOrt(preferGpu, ortBase);
  const tryEps = preferGpu ? [['webgpu','wasm'], ['wasm']] : [['wasm']];
  let lastErr = null, session = null, backend = 'wasm';
  for (const eps of tryEps){
    try {
      session = await ortApi.InferenceSession.create(modelUrl, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });
      backend = eps[0];
      break;
    } catch (e){ lastErr = e; }
  }
  if (!session) throw lastErr || new Error('Could not create ONNX session');
  session.__backend = backend;
  sessions.set(key, session);
  return session;
}

// Replicates edge pixels when the tile crosses the source borders. This
// avoids zero-padding artifacts (visible halos along the image edges).
function rgbaTileToCHW(src, sw, sh, tx, ty, T){
  const out  = new Float32Array(3 * T * T);
  const ps   = T * T;
  for (let y = 0; y < T; y++){
    let sy = ty + y;
    if (sy < 0) sy = 0; else if (sy >= sh) sy = sh - 1;
    const row = sy * sw;
    for (let x = 0; x < T; x++){
      let sx = tx + x;
      if (sx < 0) sx = 0; else if (sx >= sw) sx = sw - 1;
      const so = (row + sx) * 4;
      const o  = y * T + x;
      out[o]          = src[so]     / 255;
      out[ps + o]     = src[so + 1] / 255;
      out[ps * 2 + o] = src[so + 2] / 255;
    }
  }
  return out;
}

// Bilinear upsample of a single 8-bit channel by integer factor `scale`.
// Used to upscale the alpha channel alongside the IA-upscaled RGB so the
// output PNG keeps its original transparency.
function bilinearUpscaleChannel(src, sw, sh, scale){
  const dw = sw * scale, dh = sh * scale;
  const out = new Uint8ClampedArray(dw * dh);
  const inv = 1 / scale;
  for (let y = 0; y < dh; y++){
    const sy = (y + 0.5) * inv - 0.5;
    let y0 = Math.floor(sy); let y1 = y0 + 1;
    const fy = sy - y0;
    if (y0 < 0) y0 = 0; if (y1 < 0) y1 = 0;
    if (y0 >= sh) y0 = sh - 1; if (y1 >= sh) y1 = sh - 1;
    for (let x = 0; x < dw; x++){
      const sx = (x + 0.5) * inv - 0.5;
      let x0 = Math.floor(sx); let x1 = x0 + 1;
      const fx = sx - x0;
      if (x0 < 0) x0 = 0; if (x1 < 0) x1 = 0;
      if (x0 >= sw) x0 = sw - 1; if (x1 >= sw) x1 = sw - 1;
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      out[y * dw + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

function progress(id, stage, pct, extra){
  const msg = { id, type: 'progress', stage, pct };
  if (extra) Object.assign(msg, extra);
  self.postMessage(msg);
}

async function runUpscale(req){
  const {
    id, rgba, width, height,
    modelUrl,
    preferGpu = true,
    tile      = 128,
    pad       = 8,
    alphaMode = 'bilinear',   // 'bilinear' | 'binary' | 'opaque'
    ortBase,                  // optional local URL prefix for ORT runtime
  } = req;

  const T    = tile;
  const PAD  = Math.max(0, Math.min((T / 2) | 0, pad));
  const STEP = Math.max(1, T - PAD * 2);

  progress(id, 'load', 0);
  const session = await ensureSession(modelUrl, preferGpu, ortBase);
  if (cancelled.has(id)) throw new Error('cancelled');
  progress(id, 'load', 100, { backend: session.__backend });

  // Discover scale by running a tiny dry-run (1×1 tile is fragile; instead
  // we assume the conventional x4 Real-ESRGAN scale and verify with the
  // first real tile below).
  let SCALE = 4;
  let scaleLocked = false;

  const inputName = session.inputNames[0];
  const outName   = session.outputNames[0];

  // We allocate the output canvas based on SCALE=4 first; if the model
  // turns out to be x2, we'll reallocate before writing the first tile.
  let outW = width  * SCALE;
  let outH = height * SCALE;
  let outRgba = new Uint8ClampedArray(outW * outH * 4);

  const nx = Math.max(1, Math.ceil(width  / STEP));
  const ny = Math.max(1, Math.ceil(height / STEP));
  const totalTiles = nx * ny;
  let doneTiles = 0;

  for (let iy = 0; iy < ny; iy++){
    for (let ix = 0; ix < nx; ix++){
      if (cancelled.has(id)) throw new Error('cancelled');

      const cx = ix * STEP;            // top-left of the valid region
      const cy = iy * STEP;
      const tx = cx - PAD;             // top-left of the padded sampling region
      const ty = cy - PAD;

      const inData   = rgbaTileToCHW(rgba, width, height, tx, ty, T);
      const inTensor = new ortApi.Tensor('float32', inData, [1, 3, T, T]);
      const feed = {}; feed[inputName] = inTensor;
      const result = await session.run(feed);
      const out = result[outName];
      // out.dims is typically [1, 3, T*SCALE, T*SCALE]
      const oh = out.dims[2], ow = out.dims[3];
      if (!scaleLocked){
        SCALE = Math.max(1, Math.round(ow / T));
        scaleLocked = true;
        if (SCALE !== 4){
          outW = width  * SCALE;
          outH = height * SCALE;
          outRgba = new Uint8ClampedArray(outW * outH * 4);
        }
      }
      const data = out.data;            // Float32Array, length 3 * ow * oh
      const ps   = ow * oh;

      // Valid output region (in tile-local coords): crop PAD*SCALE from each side.
      const startX = PAD * SCALE;
      const startY = PAD * SCALE;
      // Effective valid extent in the source is STEP px → STEP * SCALE in output,
      // but the LAST tile in each axis may need fewer (we still copy the rest
      // and the writes go past nothing because we clamp against outW/outH).
      let endX = startX + STEP * SCALE;
      let endY = startY + STEP * SCALE;
      if (endX > ow) endX = ow;
      if (endY > oh) endY = oh;
      // For the LAST tile we also need to include any extra padding region
      // that actually maps inside the source image (because cx + STEP might
      // overshoot width). Compute how far into the tile the source edge is.
      const validW = Math.min(STEP, width  - cx);  // valid src cols in this tile
      const validH = Math.min(STEP, height - cy);
      endX = startX + validW * SCALE;
      endY = startY + validH * SCALE;

      const dstX0 = cx * SCALE;
      const dstY0 = cy * SCALE;
      for (let y = startY; y < endY; y++){
        const dy = dstY0 + (y - startY);
        if (dy < 0 || dy >= outH) continue;
        const rowOut = dy * outW;
        for (let x = startX; x < endX; x++){
          const dx = dstX0 + (x - startX);
          if (dx < 0 || dx >= outW) continue;
          const oi = y * ow + x;
          let r = data[oi]          * 255;
          let g = data[ps + oi]     * 255;
          let b = data[ps * 2 + oi] * 255;
          if (r < 0) r = 0; else if (r > 255) r = 255;
          if (g < 0) g = 0; else if (g > 255) g = 255;
          if (b < 0) b = 0; else if (b > 255) b = 255;
          const o4 = (rowOut + dx) * 4;
          outRgba[o4]     = r;
          outRgba[o4 + 1] = g;
          outRgba[o4 + 2] = b;
          outRgba[o4 + 3] = 255;
        }
      }

      doneTiles++;
      progress(id, 'tile', Math.round((doneTiles / totalTiles) * 100), {
        backend: session.__backend,
      });
    }
  }

  // ---- Alpha channel ------------------------------------------------------
  // Real-ESRGAN consumes RGB only. We upsample the original alpha channel
  // separately and merge it back so the output PNG keeps transparency.
  if (alphaMode !== 'opaque'){
    const aSrc = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 3; i < aSrc.length; i++, j += 4) aSrc[i] = rgba[j];
    const aUp = bilinearUpscaleChannel(aSrc, width, height, SCALE);
    if (alphaMode === 'binary'){
      // Crisper edges: hard-threshold the upscaled alpha. Good for logos
      // where a fuzzy bilinear edge would soften the silhouette.
      for (let i = 0, o = 3; i < aUp.length; i++, o += 4){
        outRgba[o] = aUp[i] >= 128 ? 255 : 0;
      }
    } else {
      for (let i = 0, o = 3; i < aUp.length; i++, o += 4){
        outRgba[o] = aUp[i];
      }
    }
  }

  return {
    rgba: outRgba,
    width:  outW,
    height: outH,
    scale:  SCALE,
    backend: session.__backend,
  };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'cancel'){
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== 'run') return;
  const id = msg.id;
  try {
    const r = await runUpscale(msg);
    if (cancelled.has(id)){
      cancelled.delete(id);
      self.postMessage({ id, type: 'done', ok: false, error: 'cancelled' });
      return;
    }
    const transfers = [r.rgba.buffer];
    self.postMessage({
      id, type: 'done', ok: true,
      rgba: r.rgba, width: r.width, height: r.height,
      scale: r.scale, backend: r.backend,
    }, transfers);
  } catch (err){
    cancelled.delete(id);
    self.postMessage({
      id, type: 'done', ok: false,
      error: String((err && err.message) || err),
    });
  }
};
