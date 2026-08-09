// Web Worker — Background removal with BiRefNet_lite 512 (ONNX Runtime Web).
// Browser-ready export (studioludens/birefnet-lite-512). The 1024 variant OOMs
// in Chrome/WebGPU/WASM; 512 is the working BiRefNet_lite for the browser.
// Tries WebGPU first, falls back to WASM SIMD.
//
// Protocol:
//   in : { id, type:'run'|'init'|'cancel', rgba?, width?, height?, modelUrl?, preferGpu?, alphaMode?, ortBase? }
//   out: { id?, type:'progress'|'ready'|'done', ... }
'use strict';

const ORT_VERSION = '1.18.0';
const ORT_CDN_BASES = [
  './ort/',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/',
  'https://unpkg.com/onnxruntime-web@' + ORT_VERSION + '/dist/',
];

// BiRefNet_lite 512 preprocessor (ViTFeatureExtractor / ImageNet):
// size 512×512, mean/std ImageNet, rescale 1/255
const MODEL_SIZE = 512;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD  = [0.229, 0.224, 0.225];
const DEFAULT_MODEL = './models/bg-remove.onnx';

let ortApi = null;
let ortInit = null;
let ortBaseUrl = null;
let cachedSession = null;
let cachedBackend = 'wasm';
let cachedModelKey = '';
const cancelled = new Set();

function tryImport(url){
  try { importScripts(url); return null; }
  catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return (e && e.name) ? (e.name + ': ' + msg) : msg;
  }
}

function loadOrt(preferGpu, overrideBase){
  if (ortInit) return ortInit;
  ortInit = (async () => {
    const bases = [];
    if (overrideBase){
      bases.push(overrideBase.endsWith('/') ? overrideBase : overrideBase + '/');
    }
    for (const b of ORT_CDN_BASES) bases.push(b);

    const filesPrimary = preferGpu
      ? ['ort.webgpu.min.js', 'ort.min.js']
      : ['ort.min.js', 'ort.webgpu.min.js'];

    const tried = [];
    for (const base of bases){
      for (const file of filesPrimary){
        const url = base + file;
        const err = tryImport(url);
        tried.push({ url, err });
        if (err === null && self.ort){
          ortApi = self.ort;
          ortBaseUrl = base;
          break;
        }
        if (err === null && !self.ort){
          tried[tried.length - 1].err = 'loaded, but self.ort is undefined';
        }
      }
      if (ortApi) break;
    }
    if (!ortApi){
      const lines = tried.map(t => '  - ' + t.url + (t.err ? '\n      → ' + t.err : ''));
      throw new Error(
        'No se pudo cargar ONNX Runtime. Probado:\n' + lines.join('\n')
      );
    }

    ortApi.env.wasm.wasmPaths = ortBaseUrl;
    ortApi.env.wasm.simd = true;
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
  if (cachedSession && cachedModelKey === key) return cachedSession;
  await loadOrt(preferGpu, ortBase);

  // WebGPU first (fp16), then WASM fallback.
  const tryEps = preferGpu ? [['webgpu'], ['wasm']] : [['wasm']];
  let lastErr = null, session = null, backend = 'wasm';
  for (const eps of tryEps){
    try {
      progress(null, 'init', eps[0] === 'webgpu' ? 30 : 60, { trying: eps[0] });
      session = await ortApi.InferenceSession.create(modelUrl, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });
      backend = eps[0];
      break;
    } catch (e){
      lastErr = e;
      console.warn('[bgremove] EP failed:', eps[0], e && e.message ? e.message : e);
    }
  }
  if (!session){
    throw friendlyOrtError(lastErr) || new Error('No se pudo iniciar el removedor de fondo');
  }
  cachedSession = session;
  cachedBackend = backend;
  cachedModelKey = key;
  return session;
}

function progress(id, stage, pct, extra){
  const msg = { id, type: 'progress', stage, pct };
  if (extra) Object.assign(msg, extra);
  self.postMessage(msg);
}

function friendlyOrtError(err){
  const raw = String((err && err.message) || err || '');
  const low = raw.toLowerCase();
  if (low.includes('bad_alloc') || low.includes('out of memory') || low.includes('oom') || low.includes('memory')){
    return new Error('Memoria insuficiente para quitar el fondo. Cierra otras pestañas e inténtalo de nuevo.');
  }
  if (low.includes('webgpu')){
    return new Error('No se pudo acelerar con GPU. Actualiza Chrome o prueba de nuevo.');
  }
  if (!raw || raw === 'undefined' || raw === 'null'){
    return new Error('No se pudo iniciar el removedor de fondo.');
  }
  return new Error(raw.length > 220 ? raw.slice(0, 220) + '…' : raw);
}

// Bilinear resize + ImageNet normalize → NCHW float32 [1,3,512,512]
function rgbaToModelInput(rgba, width, height){
  const N = MODEL_SIZE;
  const out = new Float32Array(3 * N * N);
  const xRatio = width  / N;
  const yRatio = height / N;
  const plane = N * N;
  const inv255 = 1 / 255;
  for (let y = 0; y < N; y++){
    const sy = Math.min(height - 1, (y + 0.5) * yRatio - 0.5);
    let y0 = Math.floor(sy); let y1 = y0 + 1;
    const fy = sy - y0;
    if (y0 < 0) y0 = 0; if (y1 < 0) y1 = 0;
    if (y0 >= height) y0 = height - 1; if (y1 >= height) y1 = height - 1;
    for (let x = 0; x < N; x++){
      const sx = Math.min(width - 1, (x + 0.5) * xRatio - 0.5);
      let x0 = Math.floor(sx); let x1 = x0 + 1;
      const fx = sx - x0;
      if (x0 < 0) x0 = 0; if (x1 < 0) x1 = 0;
      if (x0 >= width) x0 = width - 1; if (x1 >= width) x1 = width - 1;

      const i00 = (y0 * width + x0) * 4;
      const i10 = (y0 * width + x1) * 4;
      const i01 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const o = y * N + x;
      for (let c = 0; c < 3; c++){
        const v =
          rgba[i00 + c] * w00 +
          rgba[i10 + c] * w10 +
          rgba[i01 + c] * w01 +
          rgba[i11 + c] * w11;
        out[c * plane + o] = (v * inv255 - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
      }
    }
  }
  return out;
}

function upsampleMaskU8(mask, mw, mh, width, height){
  const out = new Uint8ClampedArray(width * height);
  const xRatio = mw / width;
  const yRatio = mh / height;
  for (let y = 0; y < height; y++){
    const sy = Math.min(mh - 1, (y + 0.5) * yRatio - 0.5);
    let y0 = Math.floor(sy); let y1 = y0 + 1;
    const fy = sy - y0;
    if (y0 < 0) y0 = 0; if (y1 < 0) y1 = 0;
    if (y0 >= mh) y0 = mh - 1; if (y1 >= mh) y1 = mh - 1;
    for (let x = 0; x < width; x++){
      const sx = Math.min(mw - 1, (x + 0.5) * xRatio - 0.5);
      let x0 = Math.floor(sx); let x1 = x0 + 1;
      const fx = sx - x0;
      if (x0 < 0) x0 = 0; if (x1 < 0) x1 = 0;
      if (x0 >= mw) x0 = mw - 1; if (x1 >= mw) x1 = mw - 1;
      const a = mask[y0 * mw + x0];
      const b = mask[y0 * mw + x1];
      const c = mask[y1 * mw + x0];
      const d = mask[y1 * mw + x1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      out[y * width + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

function composeWithAlpha(rgba, maskU8, width, height, alphaMode){
  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  const N = width * height;

  for (let i = 0, o = 3; i < N; i++, o += 4){
    const m = maskU8[i];
    const prev = rgba[o];
    out[o] = Math.round((m * prev) / 255);
  }

  // Light despill on soft fringe
  for (let y = 0; y < height; y++){
    for (let x = 0; x < width; x++){
      const i = y * width + x;
      const a = out[i * 4 + 3];
      if (a === 0 || a === 255) continue;
      let bgR = 0, bgG = 0, bgB = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++){
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -2; dx <= 2; dx++){
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (out[j * 4 + 3] === 0){
            bgR += rgba[j * 4];
            bgG += rgba[j * 4 + 1];
            bgB += rgba[j * 4 + 2];
            n++;
          }
        }
      }
      if (n === 0){ bgR = 255; bgG = 255; bgB = 255; }
      else { bgR /= n; bgG /= n; bgB /= n; }
      const af = a / 255;
      const o = i * 4;
      let r = (out[o]     - (1 - af) * bgR) / af;
      let g = (out[o + 1] - (1 - af) * bgG) / af;
      let b = (out[o + 2] - (1 - af) * bgB) / af;
      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }

  if (alphaMode === 'binary'){
    for (let i = 0, o = 3; i < N; i++, o += 4){
      const a = out[o] >= 128 ? 255 : 0;
      out[o] = a;
      if (a === 0){
        out[o - 3] = 0;
        out[o - 2] = 0;
        out[o - 1] = 0;
      }
    }
  } else {
    for (let i = 0, o = 3; i < N; i++, o += 4){
      if (out[o] === 0){
        out[o - 3] = 0;
        out[o - 2] = 0;
        out[o - 1] = 0;
      }
    }
  }
  return out;
}

function logitsToMaskU8(data, plane){
  // BiRefNet emits logits → sigmoid → 0..255 (same as transformers.js demo)
  const maskU8 = new Uint8ClampedArray(plane);
  for (let i = 0; i < plane; i++){
    let z = data[i];
    if (z > 50) z = 50; else if (z < -50) z = -50;
    const s = 1 / (1 + Math.exp(-z));
    maskU8[i] = s * 255;
  }
  return maskU8;
}

async function initModel(req){
  const modelUrl = req.modelUrl || DEFAULT_MODEL;
  const preferGpu = req.preferGpu !== false;
  const ortBase = req.ortBase || './ort/';
  progress(null, 'init', 0);
  const session = await ensureSession(modelUrl, preferGpu, ortBase);
  progress(null, 'init', 100, { backend: cachedBackend });
  self.postMessage({
    type: 'ready',
    backend: cachedBackend,
    input: session.inputNames[0],
  });
}

async function runBgRemove(req){
  const {
    id, rgba, width, height,
    modelUrl = DEFAULT_MODEL,
    preferGpu = true,
    alphaMode = 'binary',
    ortBase = './ort/',
  } = req;

  progress(id, 'init', 5);
  const session = await ensureSession(modelUrl, preferGpu, ortBase);
  if (cancelled.has(id)) throw new Error('cancelled');
  progress(id, 'init', 100, { backend: cachedBackend });

  progress(id, 'preprocess', 20);
  const inputData = rgbaToModelInput(rgba, width, height);
  if (cancelled.has(id)) throw new Error('cancelled');
  progress(id, 'preprocess', 100);

  // Prefer canonical BiRefNet names; fall back to session discovery.
  const inputName = session.inputNames.includes('input_image')
    ? 'input_image'
    : session.inputNames[0];
  const outName = session.outputNames.includes('output_image')
    ? 'output_image'
    : session.outputNames[0];

  const tensor = new ortApi.Tensor('float32', inputData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const feed = {}; feed[inputName] = tensor;

  progress(id, 'inference', 10);
  const result = await session.run(feed);
  if (cancelled.has(id)) throw new Error('cancelled');
  progress(id, 'inference', 100, { backend: cachedBackend });

  progress(id, 'postprocess', 20);
  const out = result[outName];
  const data = out.data;
  let mw = MODEL_SIZE, mh = MODEL_SIZE;
  if (out.dims.length === 4){
    mh = out.dims[2];
    mw = out.dims[3];
  } else if (out.dims.length === 3){
    mh = out.dims[1];
    mw = out.dims[2];
  } else if (out.dims.length === 2){
    mh = out.dims[0];
    mw = out.dims[1];
  }

  const plane = mw * mh;
  const maskU8 = logitsToMaskU8(data, plane);
  const fullMask = upsampleMaskU8(maskU8, mw, mh, width, height);
  progress(id, 'postprocess', 100);

  progress(id, 'compose', 40);
  const outRgba = composeWithAlpha(rgba, fullMask, width, height, alphaMode);
  progress(id, 'compose', 100);

  return {
    rgba: outRgba,
    width,
    height,
    backend: cachedBackend,
  };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'cancel'){
    cancelled.add(msg.id);
    return;
  }
  try {
    if (msg.type === 'init'){
      await initModel(msg);
      return;
    }
    if (msg.type !== 'run') return;
    const id = msg.id;
    const r = await runBgRemove(msg);
    if (cancelled.has(id)){
      cancelled.delete(id);
      self.postMessage({ id, type: 'done', ok: false, error: 'cancelled' });
      return;
    }
    self.postMessage({
      id, type: 'done', ok: true,
      rgba: r.rgba, width: r.width, height: r.height,
      backend: r.backend,
    }, [r.rgba.buffer]);
  } catch (err){
    const friendly = friendlyOrtError(err);
    const error = friendly.message;
    if (msg.type === 'init'){
      self.postMessage({ type: 'done', ok: false, error });
      return;
    }
    cancelled.delete(msg.id);
    self.postMessage({ id: msg.id, type: 'done', ok: false, error });
  }
};
