// Режим отладки (?debug): оверлей с FPS, временем кадра, масштабом, размером буфера и временем GPU.
// Время GPU — через EXT_disjoint_timer_query_webgl2, если расширение доступно.

export function attachDebug(scene, hooks, info) {
  const gl = scene.gl;
  const ext = gl && gl.getExtension('EXT_disjoint_timer_query_webgl2');

  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = [
    'position:fixed', 'left:8px', 'top:8px', 'z-index:9999', 'pointer-events:none',
    'font:11px/1.4 ui-monospace,Consolas,monospace', 'color:#f2f4ff',
    'background:rgba(0,0,0,.6)', 'padding:6px 8px', 'border-radius:6px', 'white-space:pre',
  ].join(';');
  document.body.append(box);

  const frames = [];
  let gpuMs = -1;
  const samples = [];
  const pending = [];
  let active = null;

  hooks.before = (g) => {
    if (!ext || active || pending.length > 3) return;
    active = g.createQuery();
    g.beginQuery(ext.TIME_ELAPSED_EXT, active);
  };
  hooks.after = (g, now) => {
    frames.push(now);
    while (frames.length && now - frames[0] > 1000) frames.shift();
    if (active) {
      g.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    }
    while (pending.length) {
      const q = pending[0];
      if (!g.getQueryParameter(q, g.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = g.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = g.getQueryParameter(q, g.QUERY_RESULT);
      if (!disjoint) {
        gpuMs = gpuMs < 0 ? ns / 1e6 : gpuMs * 0.85 + (ns / 1e6) * 0.15;
        samples.push(ns / 1e6);
        if (samples.length > 400) samples.shift();
      }
      g.deleteQuery(q);
      pending.shift();
    }
  };

  let renderer = '';
  try {
    const ri = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(gl.getParameter(ri ? ri.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch (e) { renderer = '?'; }

  function update() {
    const n = frames.length;
    const fps = n > 1 ? ((n - 1) * 1000) / (frames[n - 1] - frames[0]) : 0;
    const st = scene.state;
    const extra = info();
    box.textContent =
      `fps      ${fps.toFixed(0)}\n` +
      `frame    ${fps ? (1000 / fps).toFixed(1) : '-'} ms\n` +
      `gpu      ${ext ? (gpuMs >= 0 ? gpuMs.toFixed(2) + ' ms' : '…') : 'нет timer query'}\n` +
      `scale    ${st.scale.toFixed(2)}  lod ${st.lod}\n` +
      `buffer   ${st.width}×${st.height} (${((st.width * st.height) / 1e6).toFixed(2)} Мп)\n` +
      Object.entries(extra).map(([k, v]) => `${k.padEnd(8)} ${v}`).join('\n');
    setTimeout(update, 250);
  }
  update();

  window.__cityDebug = {
    renderer,
    timerQuery: !!ext,
    get gpuMs() { return gpuMs; },
    // перцентили сырых замеров GPU с последнего сброса (устойчивее к фоновой нагрузке на видеокарту)
    resetGpu() { samples.length = 0; },
    gpuStats() {
      if (!samples.length) return null;
      const s = [...samples].sort((a, b) => a - b);
      const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
      return { n: s.length, p10: q(0.1), p20: q(0.2), median: q(0.5) };
    },
    state: scene.state,
    info,
    bench(n = 20) {
      scene.setPaused(true);
      const ms = scene.drawSync(n);
      scene.setPaused(false);
      return { ms, width: scene.state.width, height: scene.state.height, scale: scene.state.scale, lod: scene.state.lod };
    },
  };
}
