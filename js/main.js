import { create, createProgram, VS } from './gl-scene.js';
import { makeNoiseData, NOISE_SIZE } from './noise-tex.js';
import { CITY_FS } from './city-shader.js';
import { createCameraRig } from './camera.js';

const DEG = Math.PI / 180;
const NAVE = 14;
const STEP_P = [0, 1 / 3, 2 / 3, 1];

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const mobile = coarse || Math.min(screen.width, screen.height) < 700;

// ---------------------------------------------------------------- палитра (sRGB → linear)
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
const PAL = {
  bg: hex('#0b1020'),
  blue: lin(hex('#1b2cff')),
  gold: lin(hex('#d9b36c')),
  light: lin(hex('#f2f4ff')),
};

// ---------------------------------------------------------------- план города
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261119);
const base = (Math.PI * 2) / NAVE;
const avenues = new Float32Array(NAVE);
for (let i = 0; i < NAVE; i++) avenues[i] = (i + 0.5 + (rnd() - 0.5) * 0.6) * base;

const riverF = (x) => 0.8 * Math.sin(0.38 * x) + 0.25 * Math.sin(1.1 * x);

// проспект для шага 4 — ближайший к направлению 235°
let aveIdx = 0;
{
  let best = 1e9;
  avenues.forEach((a, i) => {
    const d = Math.abs(((a / DEG - 235 + 540) % 360) - 180);
    if (d < best) { best = d; aveIdx = i; }
  });
}
const aTh = avenues[aveIdx];
const aDir = [Math.sin(aTh), Math.cos(aTh)];
const aN = [Math.cos(aTh), -Math.sin(aTh)];
const aR = 3.4;
const aveCam = { x: aDir[0] * aR + aN[0] * 0.022, z: aDir[1] * aR + aN[1] * 0.022, yaw: aTh / DEG - 180 };

// ключевые кадры: p, x, z (км), h (км), yaw, pitch, fov (град)
const KEYS = [
  { p: 0,       x: 0,     z: -3.2,                h: 29,   yaw: 0,   pitch: -84, fov: 66 },
  { p: 1 / 6,   x: -3.3,  z: -7.0,                h: 12,   yaw: 25,  pitch: -58, fov: 56 },
  { p: 1 / 3,   x: -6.2,  z: -3.6,                h: 6,    yaw: 60,  pitch: -40, fov: 54 },
  { p: 1 / 2,   x: -6.3,  z: -1.5,                h: 3.0,  yaw: 80,  pitch: -30, fov: 52 },
  { p: 2 / 3,   x: -5.2,  z: riverF(-5.2) - 0.08, h: 1.5,  yaw: 88,  pitch: -23, fov: 52 },
  { p: 5 / 6,   x: (-5.2 + aveCam.x) / 2 - 0.2, z: (riverF(-5.2) + aveCam.z) / 2 - 0.2, h: 0.62, yaw: (88 + aveCam.yaw) / 2, pitch: -16, fov: 51 },
  { p: 1,       x: aveCam.x, z: aveCam.z,         h: 0.3,  yaw: aveCam.yaw, pitch: -10.5, fov: 50 },
];

// ---------------------------------------------------------------- DOM
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const section = $('#scene');
const stage = $('.stage');
const canvas = $('#city');
const caps = $$('.cap');
const blocks = $$('.step');
const dots = $$('.dots button');
const skip = $('.skip');
const outro = $('#after');

// слова заголовков по очереди: 140 мс + 45 мс на слово
caps.forEach((cap) => {
  const h = $('h2', cap);
  const words = h.textContent.trim().split(/\s+/);
  h.setAttribute('aria-label', h.textContent.trim());
  h.textContent = '';
  words.forEach((w, i) => {
    const s = document.createElement('span');
    s.className = 'w';
    s.setAttribute('aria-hidden', 'true');
    s.style.transitionDelay = `${140 + 45 * i}ms`;
    s.textContent = w;
    h.append(s, i < words.length - 1 ? ' ' : '');
  });
});

// ---------------------------------------------------------------- сцена
const rig = createCameraRig(KEYS, { orbitAt: 1 / 3, reducedMotion });
const pointer = { x: 0, y: 0, present: 0 };
const flash = { x: 0, y: 0, t0: -1e9, last: -1e9 };
let fade = 0;
let clock = 0;

const UNIFORMS = ['uRes', 'uTime', 'uCamPos', 'uCamR', 'uCamU', 'uCamF', 'uTanH', 'uAve', 'uExpo',
  'uFade', 'uVig', 'uLod', 'uSide', 'uBgSrgb', 'uGold', 'uBlue', 'uLight', 'uFlash', 'uBuild', 'uSteps', 'uBRad',
  'uNoise', 'uCity'];

const DEBUG = new URLSearchParams(location.search).has('debug');
const hooks = {};

// ?debug&def=A,B — отладочные #define (выключение частей шейдера для замеров), ?debug&lite — сразу облегчённый шейдер
const withDefs = (src, defs) => (defs.length
  ? src.replace('#version 300 es\n', '#version 300 es\n' + defs.map((d) => `#define ${d.replace(/[^A-Z0-9_]/gi, '')}\n`).join(''))
  : src);
const DEFS = DEBUG ? (new URLSearchParams(location.search).get('def') || '').split(',').filter(Boolean) : [];
if (DEBUG && new URLSearchParams(location.search).has('lite')) DEFS.push('LITE');
const FS = withDefs(CITY_FS, DEFS);

// ---------------------------------------------------------------- текстуры: хеши и карта города
// Текстура хешей заменяет целочисленные хеши и value-noise. Карта города (плотность, парки,
// расстояние до дорог) запекается один раз при старте тем же шейдером с #define BAKE —
// обход кварталов берёт её одной выборкой вместо шума и расчёта расстояний на каждый квартал.
const CITY_RES = 1024;
let texNoise = null, texCity = null;

async function prepareTextures(gl) {
  texNoise = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texNoise);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, NOISE_SIZE, NOISE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeNoiseData());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  texCity = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texCity);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, CITY_RES, CITY_RES);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const bake = await createProgram(gl, VS, withDefs(CITY_FS, ['BAKE']));
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texCity, 0);
  gl.viewport(0, 0, CITY_RES, CITY_RES);
  gl.useProgram(bake);
  gl.uniform1fv(gl.getUniformLocation(bake, 'uAve'), avenues);
  gl.uniform1i(gl.getUniformLocation(bake, 'uNoise'), 0);
  gl.uniform1i(gl.getUniformLocation(bake, 'uCity'), 2);   // в запекании не читается
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, null);                     // не читать текстуру, в которую пишем
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteProgram(bake);
  gl.bindTexture(gl.TEXTURE_2D, texCity);
  gl.activeTexture(gl.TEXTURE0);
}

// ---------------------------------------------------------------- статичный запасной вид
// Без WebGL2 или если даже облегчённый шейдер не успевает — кадры шагов из docs/frames/ с кроссфейдом.
const SHOTS = [1, 2, 3, 4].map((i) => `docs/frames/step-${i}.jpg`);
let shotsReady = false;
let staticMode = false;
function showStaticFallback(reason) {
  if (reason === 'too-slow') staticMode = true;
  if (shotsReady) return;
  shotsReady = true;
  const fb = $('.fallback');
  if (!fb) return;
  SHOTS.forEach((src, i) => {
    const d = document.createElement('div');
    d.className = 'shot';
    d.dataset.step = String(i);
    d.style.backgroundImage = `url("${src}")`;
    fb.prepend(d);
  });
  fb.classList.add('has-shots');
  const p = $('p', fb);
  if (p) {
    p.textContent = reason === 'too-slow'
      ? 'Устройство не успевает рисовать сцену плавно — показаны кадры пролёта.'
      : 'Браузер не поддерживает WebGL2 — показаны кадры пролёта.';
  }
}

// ---------------------------------------------------------------- уровни деталей
// lod 2 — всё; 1 — меньше шагов и радиус домов, без звёзд и искр; 0 — минимум, без «дыхания»,
// в простое кадры не рисуются. Слабые устройства (телефон, встроенная графика) не строят дома выше 4 км.
const LOD_STEPS = [0.5, 0.72, 1];
const LOD_RAD = [0.6, 0.8, 1];

const scene = create(canvas, {
  hooks,
  forceWeak: DEBUG && new URLSearchParams(location.search).get('profile') === 'weak',
  fragment: FS,
  uniformNames: UNIFORMS,
  mobile,
  reducedMotion,
  async onReady(gl) {
    try {
      await prepareTextures(gl);
    } catch (e) {
      console.error(e.message || e);
      stage.classList.add('no-webgl');
      showStaticFallback();
    }
    scene.invalidate && scene.invalidate();
  },
  onFallback(onFlag, reason) {
    if (staticMode) return;   // статичный вид включён окончательно
    stage.classList.toggle('no-webgl', !!onFlag);
    if (onFlag) showStaticFallback(reason);
  },
  onLite: () => withDefs(CITY_FS, [...DEFS, 'LITE']),
  idleFps: (st) => (st.lod === 0 ? 0 : (mobile || st.weak ? 30 : 60)),
  render(gl, u, time, dt, st) {
    clock = time;
    const aspect = st.width / st.height;
    const cam = rig.update(dt, time, st.progress, pointer, aspect, st.lod === 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texCity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texNoise);
    gl.uniform1i(u.uNoise, 0);
    gl.uniform1i(u.uCity, 1);
    gl.uniform2f(u.uRes, st.width, st.height);
    gl.uniform1f(u.uTime, time % 100000);
    gl.uniform3fv(u.uCamPos, cam.pos);
    gl.uniform3fv(u.uCamR, cam.right);
    gl.uniform3fv(u.uCamU, cam.up);
    gl.uniform3fv(u.uCamF, cam.fwd);
    gl.uniform1f(u.uTanH, cam.tanH);
    gl.uniform1fv(u.uAve, avenues);
    // экспозиция чуть выше на низких шагах, где огней в кадре меньше
    gl.uniform1f(u.uExpo, 1.3 + 0.1 * rig.progress);
    gl.uniform1f(u.uFade, fade);
    gl.uniform1f(u.uVig, 1);
    gl.uniform1f(u.uLod, st.lod);
    gl.uniform1f(u.uSide, aspect < 0.8 ? 1 : 0);
    gl.uniform3fv(u.uBgSrgb, PAL.bg);
    gl.uniform3fv(u.uGold, PAL.gold);
    gl.uniform3fv(u.uBlue, PAL.blue);
    gl.uniform3fv(u.uLight, PAL.light);
    // здания: на мощной графике выключены выше 8 км и в полную высоту ниже 2 км;
    // на слабой — выключены выше 4 км и в полную высоту ниже 1.5 км
    const hk = st.weak
      ? Math.min(1, Math.max(0, (cam.pos[1] - 1.5) / 2.5))
      : Math.min(1, Math.max(0, (cam.pos[1] - 2) / 6));
    gl.uniform1f(u.uBuild, 1 - hk * hk * (3 - 2 * hk));
    gl.uniform1f(u.uSteps, Math.round((mobile ? 40 : (st.weak ? 52 : 68)) * LOD_STEPS[st.lod]));
    gl.uniform1f(u.uBRad, (mobile ? 3.4 : 4.8) * LOD_RAD[st.lod]);
    const ft = (performance.now() - flash.t0) / 1000;
    const fl = ft < 0.35 ? 1 - ft / 0.35 : 0;
    const k = st.width / st.cssW;
    gl.uniform3f(u.uFlash, flash.x * k, (st.cssH - flash.y) * k, fl);
    return cam.settling || fl > 0;
  },
});

// ---------------------------------------------------------------- шаги и подписи
let active = -1;
function setActive(i) {
  if (i === active) return;
  active = i;
  caps.forEach((c, j) => {
    const on = j === i;
    c.classList.toggle('is-on', on);
    c.setAttribute('aria-hidden', on ? 'false' : 'true');
    c.inert = !on;
  });
  dots.forEach((d, j) => {
    if (j === i) d.setAttribute('aria-current', 'step');
    else d.removeAttribute('aria-current');
  });
  stage.dataset.step = String(i);
  scene.setProgress(STEP_P[i]);
}

function onScroll() {
  const vh = window.innerHeight;
  const line = 0.6 * vh;
  const centers = blocks.map((b) => {
    const r = b.getBoundingClientRect();
    return r.top + r.height / 2;
  });
  let i = 0;
  centers.forEach((c, j) => { if (c < line) i = j; });
  setActive(i);

  // полоска прогресса внутри подписи — до следующего шага
  const sr = section.getBoundingClientRect();
  let frac;
  if (i < blocks.length - 1) {
    const a = i === 0 ? sr.top + 0 : centers[i];
    const b = centers[i + 1];
    frac = (line - a) / Math.max(1, b - a);
  } else {
    frac = (line - centers[i]) / Math.max(1, sr.bottom - vh - (centers[i] - line));
  }
  frac = Math.max(0, Math.min(1, frac));
  const bar = $('.bar i', caps[i]);
  if (bar) bar.style.transform = `scaleX(${frac.toFixed(4)})`;

  // вход/выход из сцены: подписи гаснут, сцена уходит в цвет фона
  const inScene = sr.top < 0.4 * vh && sr.bottom > 0.8 * vh;
  stage.classList.toggle('in-scene', inScene);
  const out = sr.bottom / vh; // 1 — сцена ещё закреплена, 0 — ушла
  const x = Math.max(0, Math.min(1, (0.95 - out) / 0.6));
  const nf = x * x * (3 - 2 * x);
  if (Math.abs(nf - fade) > 1e-4) { fade = nf; scene.invalidate(); }
}

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);
onScroll();

const smooth = reducedMotion ? 'auto' : 'smooth';
function scrollToStep(i) {
  const b = blocks[i];
  const r = b.getBoundingClientRect();
  const y = window.scrollY + (i === 0 ? section.getBoundingClientRect().top : r.top + r.height / 2 - 0.5 * window.innerHeight);
  window.scrollTo({ top: Math.max(0, y), behavior: smooth });
}
dots.forEach((d, i) => d.addEventListener('click', () => scrollToStep(i)));
skip.addEventListener('click', () => {
  window.scrollTo({ top: window.scrollY + outro.getBoundingClientRect().top, behavior: smooth });
});

// ---------------------------------------------------------------- мышь и клик
stage.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const r = stage.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  pointer.present = 1;
  scene.invalidate();
});
stage.addEventListener('pointerleave', () => { pointer.present = 0; pointer.x = 0; pointer.y = 0; scene.invalidate(); });
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, a')) return;
  const now = performance.now();
  if (now - flash.last < 340) return;
  flash.last = now;
  const r = canvas.getBoundingClientRect();
  flash.x = e.clientX - r.left;
  flash.y = e.clientY - r.top;
  flash.t0 = now;
  scene.invalidate();
});

// ---------------------------------------------------------------- отладка (?debug)
if (DEBUG && new URLSearchParams(location.search).has('static')) {
  scene.setPaused(true);
  stage.classList.add('no-webgl');
  showStaticFallback('too-slow');
}
if (DEBUG && scene.ok) {
  import('./debug.js').then(({ attachDebug }) => attachDebug(scene, hooks, () => ({
    step: String(active + 1),
    progress: rig.progress.toFixed(3),
    mobile: String(mobile),
    weak: String(scene.state.weak),
    tier: scene.state.tier,
  })));
}
