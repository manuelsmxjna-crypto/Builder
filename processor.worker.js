// Web Worker for Semitonos DTF — all heavy pixel processing runs here
// so the main thread stays smooth (sliders, pan, zoom never freeze).
'use strict';

const INCH_MM = 25.4;

const SRGB_TO_LINEAR_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

function srgbToOklab(r, g, b) {
  const lr = SRGB_TO_LINEAR_LUT[r];
  const lg = SRGB_TO_LINEAR_LUT[g];
  const lb = SRGB_TO_LINEAR_LUT[b];
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const lc = Math.cbrt(l), mc = Math.cbrt(m), sc = Math.cbrt(s);
  return [
    0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc,
    1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc,
    0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc,
  ];
}

function applyBrightnessInPlace(data, factor) {
  if (factor === 1) return;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * factor, g = data[i + 1] * factor, b = data[i + 2] * factor;
    if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}
function applyContrastInPlace(data, factor) {
  if (factor === 1) return;
  for (let i = 0; i < data.length; i += 4) {
    let r = (data[i] - 128) * factor + 128;
    let g = (data[i + 1] - 128) * factor + 128;
    let b = (data[i + 2] - 128) * factor + 128;
    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}
function applySharpness(srcData, w, h, factor) {
  if (factor === 1) return srcData;
  const amount = factor - 1;
  const out = new Uint8ClampedArray(srcData.length);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const avg = (
          srcData[(ym * w + xm) * 4 + c] + srcData[(ym * w + x) * 4 + c] + srcData[(ym * w + xp) * 4 + c] +
          srcData[(y * w + xm) * 4 + c] + srcData[(y * w + x) * 4 + c] + srcData[(y * w + xp) * 4 + c] +
          srcData[(yp * w + xm) * 4 + c] + srcData[(yp * w + x) * 4 + c] + srcData[(yp * w + xp) * 4 + c]
        ) / 9;
        let v = srcData[o + c] + amount * (srcData[o + c] - avg);
        if (v < 0) v = 0; else if (v > 255) v = 255;
        out[o + c] = v;
      }
      out[o + 3] = srcData[o + 3];
    }
  }
  return out;
}

function toLuminance(rgba, w, h) {
  const N = w * h;
  const gray = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    gray[i] = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
  }
  return gray;
}
function toneFromLuminance(rgba, w, h, blackCut, whiteCut, gamma) {
  const gray = toLuminance(rgba, w, h);
  const N = w * h;
  const tone = new Float32Array(N);
  const denom = Math.max(1, whiteCut - blackCut);
  for (let i = 0; i < N; i++) {
    let v = (gray[i] - blackCut) / denom;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    tone[i] = Math.pow(v, gamma);
  }
  return tone;
}
function toneFromColorDistance(rgba, w, h, garment, tolUI, featherUI, chromaWeight, preserveLuma, gamma) {
  const N = w * h;
  const tone = new Float32Array(N);
  const UI_TO_OK = 1 / 200;
  const tol = tolUI * UI_TO_OK;
  const feather = Math.max(0.0001, featherUI * UI_TO_OK);
  const upper = tol + feather;
  const Lw = preserveLuma ? 0.3 : 1.0;
  const Cw = chromaWeight;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const lab = srgbToOklab(rgba[o], rgba[o + 1], rgba[o + 2]);
    const dL = (lab[0] - garment[0]) * Lw;
    const da = (lab[1] - garment[1]) * Cw;
    const db = (lab[2] - garment[2]) * Cw;
    const dist = Math.sqrt(dL * dL + da * da + db * db);
    let v;
    if (dist <= tol) v = 0;
    else if (dist >= upper) v = 1;
    else v = (dist - tol) / feather;
    tone[i] = Math.pow(v, gamma);
  }
  return tone;
}

function makeHalftoneAlpha(tone, w, h, params) {
  const { lpi, angleDeg, minDotMm, softEdges, targetDpi } = params;
  const N = w * h;
  const cell = Math.max(2.0, targetDpi / lpi);
  const angle = angleDeg * Math.PI / 180;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const cx = w * 0.5, cy = h * 0.5;
  let minRX = Infinity, maxRX = -Infinity, minRY = Infinity, maxRY = -Infinity;
  for (const [xc, yc] of [[-cx, -cy], [w - cx, -cy], [-cx, h - cy], [w - cx, h - cy]]) {
    const xr = xc * ca + yc * sa;
    const yr = -xc * sa + yc * ca;
    if (xr < minRX) minRX = xr;
    if (xr > maxRX) maxRX = xr;
    if (yr < minRY) minRY = yr;
    if (yr > maxRY) maxRY = yr;
  }
  const nx = Math.ceil(-minRX / cell - 0.5);
  const ny = Math.ceil(-minRY / cell - 0.5);
  const oX = (nx + 0.5) * cell;
  const oY = (ny + 0.5) * cell;
  const cellsX = Math.ceil((maxRX + oX) / cell) + 2;
  const cellsY = Math.ceil((maxRY + oY) / cell) + 2;
  const totalCells = cellsX * cellsY;
  const sums = new Float64Array(totalCells);
  const counts = new Uint32Array(totalCells);
  for (let y = 0; y < h; y++) {
    const yc = y - cy;
    for (let x = 0; x < w; x++) {
      const xc = x - cx;
      const xr = xc * ca + yc * sa + oX;
      const yr = -xc * sa + yc * ca + oY;
      const ix = (xr / cell) | 0;
      const iy = (yr / cell) | 0;
      if (ix < 0 || iy < 0 || ix >= cellsX || iy >= cellsY) continue;
      const idx = iy * cellsX + ix;
      sums[idx] += tone[y * w + x];
      counts[idx] += 1;
    }
  }
  const maxR = cell * 0.72;
  const minR = Math.max(0, (minDotMm / INCH_MM) * targetDpi);
  const radii = new Float32Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    if (counts[i] === 0) continue;
    const avg = sums[i] / counts[i];
    let r = Math.sqrt(avg) * maxR;
    if (r < minR) r = 0;
    radii[i] = r;
  }
  const alpha = new Uint8ClampedArray(N);
  const AA = !!softEdges;
  for (let y = 0; y < h; y++) {
    const yc = y - cy;
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      const t = tone[o];
      if (t >= 0.999) { alpha[o] = 255; continue; }
      if (t <= 0.001) { alpha[o] = 0; continue; }
      const xc = x - cx;
      const xr = xc * ca + yc * sa + oX;
      const yr = -xc * sa + yc * ca + oY;
      const ix = (xr / cell) | 0;
      const iy = (yr / cell) | 0;
      if (ix < 0 || iy < 0 || ix >= cellsX || iy >= cellsY) continue;
      const idx = iy * cellsX + ix;
      const r = radii[idx];
      if (r <= 0) continue;
      const xrc = (ix + 0.5) * cell;
      const yrc = (iy + 0.5) * cell;
      const dx = xr - xrc, dy = yr - yrc;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (AA) {
        const t2 = r - dist + 0.5;
        if (t2 >= 1) alpha[o] = 255;
        else if (t2 > 0) alpha[o] = (t2 * 255) | 0;
      } else {
        if (dist <= r) alpha[o] = 255;
      }
    }
  }
  return alpha;
}

self.onmessage = (e) => {
  const { id, rgba, width, height, params } = e.data;
  try {
    let data = rgba;
    applyBrightnessInPlace(data, params.brightness);
    applyContrastInPlace(data, params.contrast);
    if (params.sharpness !== 1) data = applySharpness(data, width, height, params.sharpness);

    const N = width * height;
    const baseAlpha = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) baseAlpha[i] = data[i * 4 + 3];

    const isColorMode = params.separationMode === 'color' && params.garmentLab;
    const tone = isColorMode
      ? toneFromColorDistance(
        data, width, height,
        params.garmentLab, params.colorTol, params.colorFeather,
        params.colorChroma, params.preserveLuma, params.gamma,
      )
      : toneFromLuminance(
        data, width, height,
        params.blackCut, params.whiteCut, params.gamma,
      );

    let screenAlpha = null;
    if (params.halftoneOn) {
      screenAlpha = makeHalftoneAlpha(tone, width, height, params);
    }

    const finalAlpha = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) {
      let a = baseAlpha[i];
      if (screenAlpha && screenAlpha[i] < a) a = screenAlpha[i];
      finalAlpha[i] = a;
      data[i * 4 + 3] = a;
    }

    // Final alpha threshold (Photoshop-style "Threshold" on the alpha
    // channel). Maps any partial transparency to either fully opaque
    // (255) or fully transparent (0). Essential for DTF where the
    // printer/RIP wants a 1-bit mask — partial alpha causes flaky
    // edges, halos, and white-ink under-base inconsistencies.
    if (params.alphaThresholdOn) {
      const T = Math.max(1, Math.min(255, params.alphaThreshold | 0));
      for (let i = 0; i < N; i++) {
        const a = finalAlpha[i] >= T ? 255 : 0;
        finalAlpha[i] = a;
        data[i * 4 + 3] = a;
      }
    }

    const transfers = [data.buffer, finalAlpha.buffer, tone.buffer];
    self.postMessage({
      id,
      ok: true,
      colorData: data,
      alphaArray: finalAlpha,
      tone,
      width,
      height,
    }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
