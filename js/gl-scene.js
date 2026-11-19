// Каркас WebGL2-сцены: полноэкранный шейдер, асинхронная сборка, размер холста с бюджетом,
// рендер по требованию, пауза, восстановление контекста, адаптивное качество.

const VS = `#version 300 es
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

function isSoftware(gl) {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return /swiftshader|llvmpipe|software|basic render/i.test(String(name || ''));
}

// Контроллер адаптивного качества: медиана последних 40 кадров активной анимации.
function createQuality(start) {
  const hist = [];
  let scale = start;
  let lastDropAt = -1e9;
  let drops = 0;
  return {
    get scale() { return scale; },
    reset() { hist.length = 0; },
    push(ms, now) {
      hist.push(ms);
      if (hist.length < 40) return false;
      if (hist.length > 40) hist.shift();
      const med = [...hist].sort((a, b) => a - b)[20];
      if (med > 24 && scale > 0.7) {
        scale = Math.max(0.5, scale * 0.85);
        lastDropAt = now; drops++; hist.length = 0;
        return true;
      }
      // Интервал кадра не опускается ниже периода vsync (16.7 мс на 60 Гц), поэтому порог 12.5 мс
      // недостижим на обычном мониторе. Возврат вверх: < 12.5 мс, либо «упираемся в vsync»
      // (< 17.6 мс) спустя 8 с после последнего снижения и не более двух раз — без пульсации.
      const relaxed = med < 17.6 && now - lastDropAt > 8000 && drops <= 2;
      if (scale < 1 && (med < 12.5 || relaxed)) {
        scale = Math.min(1, scale / 0.85);
        hist.length = 0;
        return true;
      }
      return false;
    },
  };
}

/**
 * create(canvas, options) → { ok, setProgress, setPaused, resize, invalidate, destroy, state }
 * options: { fragment, uniformNames[], render(gl, u, time, dt, state) → bool (нужен ещё кадр),
 *            onFallback(on: bool, reason), onReady(), mobile, reducedMotion }
 */
export function create(canvas, options) {
  const opts = Object.assign({ mobile: false, reducedMotion: false }, options);
  const state = { progress: 0, scale: 1, lod: 1, width: 1, height: 1, cssW: 1, cssH: 1 };
  const cleanups = [];
  const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o)); };

  const noop = () => {};
  const failApi = (reason) => {
    opts.onFallback && opts.onFallback(true, reason);
    return { ok: false, reason, state, setProgress: noop, setPaused: noop, resize: noop, invalidate: noop, destroy: noop };
  };

  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!gl) return failApi('no-webgl2');
  if (isSoftware(gl)) return failApi('software-renderer');

  const quality = createQuality(opts.mobile ? 0.8 : 1);
  let prog = null, vao = null, buf = null, u = null;
  let ready = false, lost = false, destroyed = false;
  let paused = false, offscreen = false;
  let raf = 0, last = 0, time = 0, consecutive = false, dirty = true;

  async function init() {
    ready = false;
    try {
      prog = await createProgram(gl, VS, opts.fragment);
    } catch (e) {
      if (gl.isContextLost()) return;
      console.error(e.message);
      opts.onFallback && opts.onFallback(true, 'shader-error');
      return;
    }
    if (destroyed || gl.isContextLost()) return;
    u = uniforms(gl, prog, opts.uniformNames || []);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ready = true;
    resize();
    opts.onReady && opts.onReady();
    opts.onFallback && opts.onFallback(false);
    wake();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const cssW = Math.max(1, r.width), cssH = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let k = dpr * quality.scale;
    const budget = opts.mobile ? 1.9e6 : 4.6e6;
    if (cssW * cssH * k * k > budget) k = Math.sqrt(budget / (cssW * cssH));
    k = Math.max(k, 0.5);
    const w = Math.round(cssW * k), h = Math.round(cssH * k);
    state.cssW = cssW; state.cssH = cssH;
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w; canvas.height = h;
    }
    state.width = w; state.height = h;
    state.scale = quality.scale;
    state.lod = quality.scale < 0.8 ? 0 : 1;
    dirty = true;
    wake();
  }

  const canRun = () => ready && !lost && !destroyed && !paused && !offscreen && !document.hidden;

  function frame(now) {
    raf = 0;
    if (!canRun()) { consecutive = false; return; }
    const rawMs = now - last;
    const dt = consecutive ? Math.min(rawMs / 1000, 0.05) : 1 / 60;
    last = now;
    if (!opts.reducedMotion) time += dt;
    if (consecutive && !opts.reducedMotion) {
      if (quality.push(rawMs, now)) resize();
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    const more = opts.render(gl, u, time, dt, state);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    dirty = false;
    if (!opts.reducedMotion || more) {
      consecutive = true;
      raf = requestAnimationFrame(frame);
    } else {
      consecutive = false;
    }
  }

  function wake() {
    if (raf || !canRun()) return;
    if (!dirty && opts.reducedMotion) return;
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
    setProgress(p) { state.progress = p; invalidate(); },
    setPaused(b) { paused = !!b; if (!paused) invalidate(); },
    resize,
    invalidate,
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
