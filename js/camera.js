// Камера по ключевым кадрам: монотонный сплайн Фриче–Карлсона по каждому каналу,
// высота в пространстве asinh(h/1.5), углы по кратчайшему пути, пружина на прогрессе,
// «дыхание» в простое и параллакс от мыши.

const DEG = Math.PI / 180;

// Монотонный кубический сплайн Эрмита (Фриче–Карлсон).
export function monotoneSpline(xs, ys) {
  const n = xs.length;
  const h = [], d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : 0.5 * (d[i - 1] + d[i]);
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

const HS = 1.5; // масштаб asinh-пространства высоты, км

/**
 * keys: [{ p, x, z, h, yaw, pitch, fov }] — км и градусы. yaw: 0 — взгляд вдоль +z, 90 — вдоль +x.
 * orbitAt: прогресс, около которого в простое камера медленно облетает центр.
 */
export function createCameraRig(keys, { orbitAt = null, reducedMotion = false } = {}) {
  const ps = keys.map((k) => k.p);
  // углы по кратчайшему пути: разворачиваем последовательность
  const yaws = [];
  keys.forEach((k, i) => {
    let y = k.yaw;
    if (i > 0) {
      const prev = yaws[i - 1];
      while (y - prev > 180) y -= 360;
      while (y - prev < -180) y += 360;
    }
    yaws.push(y);
  });
  const ch = {
    x: monotoneSpline(ps, keys.map((k) => k.x)),
    z: monotoneSpline(ps, keys.map((k) => k.z)),
    a: monotoneSpline(ps, keys.map((k) => Math.asinh(k.h / HS))),
    yaw: monotoneSpline(ps, yaws),
    pitch: monotoneSpline(ps, keys.map((k) => k.pitch)),
    fov: monotoneSpline(ps, keys.map((k) => k.fov)),
  };

  let prog = 0, vel = 0, inited = false;
  const mouse = { x: 0, y: 0, pres: 0 };
  const omega = 3.0; // скорость пружины

  function step(dt, target) {
    if (!inited || reducedMotion) { prog = target; vel = 0; inited = true; return; }
    // точное решение критически демпфированной пружины на шаге dt
    const x0 = prog - target;
    const e = Math.exp(-omega * dt);
    const j = (vel + omega * x0) * dt;
    prog = target + (x0 + j) * e;
    vel = (vel - omega * j) * e;
    if (Math.abs(prog - target) < 1e-5 && Math.abs(vel) < 1e-5) { prog = target; vel = 0; }
  }

  return {
    get progress() { return prog; },
    get moving() { return vel !== 0; },
    /**
     * pointer: { x, y ∈ [-1, 1], present: 0|1 }; aspect = w/h
     */
    update(dt, time, target, pointer, aspect) {
      step(dt, target);
      const p = prog;
      // мышь: плавное следование τ = 0.45 с, «присутствие» τ = 0.6 с
      const k1 = 1 - Math.exp(-dt / 0.45), k2 = 1 - Math.exp(-dt / 0.6);
      mouse.x += ((pointer ? pointer.x : 0) - mouse.x) * k1;
      mouse.y += ((pointer ? pointer.y : 0) - mouse.y) * k1;
      mouse.pres += ((pointer && pointer.present ? 1 : 0) - mouse.pres) * k2;

      let x = ch.x(p), z = ch.z(p), h = HS * Math.sinh(ch.a(p));
      let yaw = ch.yaw(p), pitch = ch.pitch(p), fov = ch.fov(p);

      if (!reducedMotion) {
        // медленный облёт вокруг центра около шага «Кольца»
        if (orbitAt !== null) {
          const w = Math.exp(-Math.pow((p - orbitAt) / 0.09, 2));
          const da = 9 * Math.sin((time * Math.PI * 2) / 46) * w;
          const c = Math.cos(da * DEG), s = Math.sin(da * DEG);
          const nx = x * c + z * s, nz = -x * s + z * c;
          x = nx; z = nz; yaw += da;
        }
        // «дыхание»: суммы синусов с несовпадающими периодами, ≈0.5°
        const T = time * Math.PI * 2;
        yaw += 0.5 * (0.6 * Math.sin(T / 11) + 0.4 * Math.sin(T / 17.9 + 1.3));
        pitch += 0.5 * (0.6 * Math.sin(T / 14.7 + 0.7) + 0.4 * Math.sin(T / 23.3 + 2.1));
        h *= 1 + 0.006 * Math.sin(T / 17.9 + 0.4);
      }
      // параллакс ±3°
      yaw += 3 * mouse.x * mouse.pres;
      pitch += 2.4 * mouse.y * mouse.pres;
      pitch = Math.max(-88.5, Math.min(10, pitch));

      // узкий экран: расширяем вертикальный угол, чтобы по горизонтали влезало больше
      if (aspect < 1.25) {
        const t = Math.tan((fov * DEG) / 2) * Math.pow(1.6 / aspect, 0.5);
        const nf = Math.min(84, (2 * Math.atan(t)) / DEG);
        // на портретном экране опускаем взгляд, чтобы небо не занимало полкадра
        pitch = Math.max(-88.5, pitch - 0.35 * (nf - fov));
        fov = nf;
      }

      const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG);
      const cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
      const fwd = [sy * cp, sp, cy * cp];
      // right = cross(worldUp, fwd), up = cross(fwd, right)
      let r = [fwd[2], 0, -fwd[0]];
      const rl = Math.hypot(r[0], r[2]) || 1;
      r = [r[0] / rl, 0, r[2] / rl];
      const up = [
        fwd[1] * r[2] - fwd[2] * r[1],
        fwd[2] * r[0] - fwd[0] * r[2],
        fwd[0] * r[1] - fwd[1] * r[0],
      ];
      return {
        pos: [x, h, z], right: r, up, fwd,
        fovY: fov * DEG,
        tanH: Math.tan((fov * DEG) / 2),
        settling: vel !== 0 || Math.abs(mouse.x - (pointer ? pointer.x : 0)) > 1e-4,
      };
    },
  };
}
