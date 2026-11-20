// Каркас WebGL2-сцены: полноэкранный шейдер, асинхронная сборка, размер холста с бюджетом,
// рендер по требованию, частота простоя, пауза, восстановление контекста, адаптивное качество
// (разрешение и уровень деталей), переход на облегчённый шейдер.

export const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatLog(log, src) {
  const lines = src.split('\n');
  const out = [log.trim()];
  const re = /ERROR:\s*\d+:(\d+):/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(log))) {
    const n = +m[1];
    if (seen.has(n)) continue;
    seen.add(n);
    for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++) {
      out.push(`${i === n ? '>' : ' '} ${String(i).padStart(4)} | ${lines[i - 1]}`);
    }
  }
  return out.join('\n');
}

function makeShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

export async function createProgram(gl, vsSrc, fsSrc) {
  const vs = makeShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = makeShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  if (ext) {
    while (!gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) {
      if (gl.isContextLost()) throw new Error('WebGL context lost during compile');
      await sleep(40);
    }
  }
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    let msg = 'Shader program failed to link.';
    for (const [sh, src, name] of [[vs, vsSrc, 'vertex'], [fs, fsSrc, 'fragment']]) {
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        msg = `Ошибка компиляции ${name} шейдера:\n` + formatLog(gl.getShaderInfoLog(sh) || '', src);
      }
    }
    if (msg.startsWith('Shader')) msg += '\n' + (gl.getProgramInfoLog(p) || '');
    gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(p);
    throw new Error(msg);
  }
  gl.detachShader(p, vs); gl.detachShader(p, fs);
  gl.deleteShader(vs); gl.deleteShader(fs);
  return p;
}

export function uniforms(gl, program, names) {
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(program, n);
  return u;
}


function rendererName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch (e) {
    return '';
  }
}

// Профиль устройства: потолок DPR рендера, бюджет пикселей, стартовый масштаб.
// Холст растягивается CSS-ом до размера окна (сглаженный апскейл браузера).
function deviceProfile(renderer, mobile) {
  const weak = /intel|iris|uhd|hd graphics|radeon\(tm\)|radeon graphics|vega|mali|adreno|powervr|apple gpu|videocore/i.test(renderer);
  if (mobile) return { weak: true, dprCap: 1.25, budget: 0.45e6, start: 1, min: 0.5 };
  if (weak) return { weak: true, dprCap: 1.5, budget: 1.6e6, start: 0.8, min: 0.5 };
  return { weak: false, dprCap: 2, budget: 2.5e6, start: 1, min: 0.5 };
}

// Адаптивное качество по интервалам между кадрами.
// - быстрая реакция вниз: медиана последних 10 кадров > 28 мс → масштаб × 0.8 сразу;
// - медленная: медиана 40 кадров > slowMs (20 мс; на слабых устройствах 26 мс — им достаточно 38+ к/с) → × 0.85;
// - вверх: медиана 40 < 12.5 мс, либо «упираемся в vsync» (< 17.6 мс) спустя 6 с после смены;
//   если снижение случилось меньше чем через 10 с после повышения — это «пульсация», после двух таких
//   повышений по vsync-правилу больше нет;
// - интервалы > 150 мс не учитываются (троттлинг вкладки, переключение, разовый фриз);
// - на минимальном масштабе и медиане > 40 мс дольше 3 с — сигнал перейти на облегчённый шейдер.
export function createQuality(start, min, slowMs = 20) {
  const hist = [];
  let scale = start;
  let lastChange = -1e9;
  let lastUp = -1e9;
  let osc = 0;
  let slowSince = -1;
  const drop = (k, now) => {
    if (now - lastUp < 10000) osc++;
    scale = Math.max(min, scale * k);
    lastChange = now; hist.length = 0;
  };
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  };
  return {
    get scale() { return scale; },
    reset(to) { hist.length = 0; slowSince = -1; if (to) scale = to; },
    push(ms, now) {
      if (ms > 150) return null;
      hist.push(ms);
      if (hist.length > 40) hist.shift();
      if (hist.length >= 10) {
        const m10 = median(hist.slice(-10));
        if (m10 > 28 && scale > min + 1e-3 && now - lastChange > 300) {
          drop(0.8, now);
          return 'down';
        }
        if (scale <= min + 1e-3 && m10 > 40) {
          if (slowSince < 0) slowSince = now;
          else if (now - slowSince > 3000) { slowSince = -1; hist.length = 0; return 'lite'; }
        } else if (m10 < 34) {
          slowSince = -1;
        }
      }
      if (hist.length >= 40) {
        const m40 = median(hist);
        if (m40 > slowMs && scale > min + 1e-3) {
          drop(0.85, now);
          return 'down';
        }
        const relaxed = m40 < 17.6 && now - lastChange > 6000 && osc < 2;
        if (scale < 1 && (m40 < 12.5 || relaxed)) {
          scale = Math.min(1, scale / 0.85);
          lastChange = now; lastUp = now; hist.length = 0;
          return 'up';
        }
      }
      return null;
    },
  };
}

/**
 * create(canvas, options) → { ok, state, gl, setProgress, setPaused, setFragment, resize, invalidate, destroy }
 * options:
 *   fragment, uniformNames[]
 *   render(gl, u, time, dt, state) → bool — кадр «занят» (камера едет, курсор, вспышка)
 *   idleFps(state) → 0 | 30 | 60 — частота кадров, когда сцена «не занята» (0 — не рисовать)
 *   onFallback(on, reason), onLite(), onReady(), hooks { before(gl), after(gl, now) }, mobile, reducedMotion
 */
export function create(canvas, options) {
  const opts = Object.assign({ mobile: false, reducedMotion: false }, options);
  const state = { progress: 0, scale: 1, lod: 2, width: 1, height: 1, cssW: 1, cssH: 1, tier: 'full', renderer: '', weak: false };
  const cleanups = [];
  const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o)); };

  const noop = () => {};
  const failApi = (reason) => {
    opts.onFallback && opts.onFallback(true, reason);
    return { ok: false, reason, state, setProgress: noop, setPaused: noop, setFragment: noop, resize: noop, invalidate: noop, destroy: noop };
  };

  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!gl) return failApi('no-webgl2');
  state.renderer = rendererName(gl);
  if (/swiftshader|llvmpipe|software|basic render/i.test(state.renderer)) return failApi('software-renderer');

  const prof = deviceProfile(opts.forceWeak ? 'intel' : state.renderer, opts.mobile);
  state.weak = prof.weak;
  const quality = createQuality(prof.start, prof.min, prof.weak ? 26 : 20);
  let fragment = opts.fragment;
  let prog = null, vao = null, buf = null, u = null;
  let ready = false, lost = false, destroyed = false;
  let paused = false, offscreen = false;
  let raf = 0, last = 0, lastRender = 0, time = 0, consecutive = false, dirty = true, busy = true;

  async function build(src) {
    const p = await createProgram(gl, VS, src);
    if (destroyed || gl.isContextLost()) { gl.deleteProgram(p); return false; }
    if (prog) gl.deleteProgram(prog);
    prog = p;
    u = uniforms(gl, prog, opts.uniformNames || []);
    return true;
  }

  async function init() {
    ready = false;
    try {
      if (!(await build(fragment))) return;
    } catch (e) {
      if (gl.isContextLost()) return;
      console.error(e.message);
      opts.onFallback && opts.onFallback(true, 'shader-error');
      return;
    }
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ready = true;
    resize();
    opts.onReady && opts.onReady(gl);
    opts.onFallback && opts.onFallback(false);
    wake();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const cssW = Math.max(1, r.width), cssH = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, prof.dprCap);
    let k = Math.min(dpr, Math.sqrt(prof.budget / (cssW * cssH))) * quality.scale;
    k = Math.max(k, 0.35);
    const w = Math.round(cssW * k), h = Math.round(cssH * k);
    state.cssW = cssW; state.cssH = cssH;
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w; canvas.height = h;
    }
    state.width = w; state.height = h;
    state.scale = quality.scale;
    state.lod = quality.scale >= 0.8 ? 2 : (quality.scale >= 0.6 ? 1 : 0);
    dirty = true;
    wake();
  }

  async function goLite() {
    if (state.tier !== 'full') {
      // и облегчённый шейдер не тянет — статичный запасной вид
      state.tier = 'static';
      opts.onFallback && opts.onFallback(true, 'too-slow');
      paused = true;
      return;
    }
    state.tier = 'lite';
    const src = opts.onLite && opts.onLite();
    if (!src) return;
    try {
      await build(src);
      quality.reset(0.75);
      resize();
    } catch (e) {
      console.error(e.message);
    }
  }

  const canRun = () => ready && !lost && !destroyed && !paused && !offscreen && !document.hidden;

  function frame(now) {
    raf = 0;
    if (!canRun()) { consecutive = false; return; }
    const rawMs = now - last;
    last = now;
    if (consecutive && !opts.reducedMotion) {
      const r = quality.push(rawMs, now);
      if (r === 'down' || r === 'up') resize();
      else if (r === 'lite') goLite();
    }
    // простой: реже или вовсе не рисуем
    const fps = opts.reducedMotion ? 0 : (opts.idleFps ? opts.idleFps(state) : 60);
    if (!dirty && !busy) {
      if (fps <= 0) { consecutive = false; return; }
      if (fps < 60 && now - lastRender < 1000 / fps - 4) {
        consecutive = true;
        raf = requestAnimationFrame(frame);
        return;
      }
    }
    const dt = lastRender && now - lastRender < 200 ? Math.min((now - lastRender) / 1000, 0.05) : 1 / 60;
    lastRender = now;
    if (!opts.reducedMotion && (fps > 0 || busy || dirty)) time += dt;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    busy = !!opts.render(gl, u, time, dt, state);
    if (opts.hooks && opts.hooks.before) opts.hooks.before(gl);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (opts.hooks && opts.hooks.after) opts.hooks.after(gl, now);
    dirty = false;
    if ((opts.reducedMotion || fps <= 0) && !busy) {
      consecutive = false;
      return;
    }
    consecutive = true;
    raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (raf || !canRun()) return;
    consecutive = false;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function invalidate() { dirty = true; wake(); }

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  cleanups.push(() => ro.disconnect());
  const io = new IntersectionObserver((entries) => {
    offscreen = !entries[entries.length - 1].isIntersecting;
    if (!offscreen) invalidate();
  });
  io.observe(canvas);
  cleanups.push(() => io.disconnect());
  on(document, 'visibilitychange', () => { if (!document.hidden) invalidate(); });

  on(canvas, 'webglcontextlost', (e) => {
    e.preventDefault();
    lost = true; ready = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    prog = null; vao = null; buf = null;
    opts.onFallback && opts.onFallback(true, 'context-lost');
  });
  on(canvas, 'webglcontextrestored', () => {
    lost = false;
    init();
  });

  init();

  return {
    ok: true,
    state,
    gl,
    setProgress(p) { state.progress = p; invalidate(); },
    setPaused(b) { paused = !!b; if (!paused) invalidate(); },
    // заменить фрагментный шейдер (например, облегчённый вариант)
    async setFragment(src) { fragment = src; if (ready) { await build(src); invalidate(); } },
    resize,
    invalidate,
    // Отладка: n раз рисует последний кадр с синхронизацией, возвращает среднее время, мс.
    drawSync(n = 20) {
      if (!ready) return -1;
      const px = new Uint8Array(4);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / n;
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      cleanups.forEach((f) => f());
      if (!gl.isContextLost()) {
        if (buf) gl.deleteBuffer(buf);
        if (vao) gl.deleteVertexArray(vao);
        if (prog) gl.deleteProgram(prog);
      }
      const lose = gl.getExtension('WEBGL_lose_context');
      lose && lose.loseContext();
    },
  };
}
