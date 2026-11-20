// Фрагментный шейдер ночного города: одна плоскость y = 0 (аналитическое пересечение),
// небо, ray differentials для фильтрации всех узоров, тонмаппинг и дизеринг.
// Единицы — километры.

export const CITY_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

// LITE — облегчённый вариант для самых слабых устройств: плоский город без домов, машин, звёзд и искр.
#ifdef LITE
#define ABL_BUILD
#define ABL_CARS
#define ABL_STARS
#define NO_SPARKS
#endif

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uCamR;
uniform vec3  uCamU;
uniform vec3  uCamF;
uniform float uTanH;      // tan(fovY / 2)
uniform float uAve[14];   // углы радиальных проспектов, рад, по возрастанию в [0, 2pi)
uniform float uExpo;
uniform float uFade;      // 0 — сцена видна, 1 — полностью цвет фона
uniform float uVig;
uniform float uLod;       // уровень деталей: 2 — полный, 1 — без звёзд и искр, 0 — минимальный
uniform float uSide;      // 1 — растушёвка и по бокам (узкий экран)
uniform vec3  uBgSrgb;    // цвет фона страницы, sRGB
uniform vec3  uGold;      // линейные
uniform vec3  uBlue;
uniform vec3  uLight;
uniform vec3  uFlash;     // x, y — пиксели холста, z — сила 0..1
uniform float uBuild;     // 0..1 — масштаб высоты зданий (0 — плоский город)
uniform float uSteps;     // лимит шагов обхода кварталов
uniform float uBRad;      // базовый радиус зданий вокруг камеры, км
uniform highp sampler2D uNoise;   // 512×512 RGBA8: R — h2(x−256, y−256), G, B, A — независимые хеши
uniform highp sampler2D uCity;    // 1024×1024 карта города ±24 км: плотность, парк, расстояние до дорог
const float CITY_EXT = 24.0;

out vec4 outColor;

const float PI  = 3.14159265;
const float TAU = 6.28318531;
const int   NAVE = 14;

const vec3 SODIUM = vec3(1.0, 0.40, 0.09);
const vec3 LED    = vec3(0.60, 0.76, 1.0);
const vec3 TAIL   = vec3(1.0, 0.035, 0.015);

// ---------------------------------------------------------------- хеши и шум
uint hu(uint x) {
  x ^= x >> 16; x *= 0x7feb352dU;
  x ^= x >> 15; x *= 0x846ca68bU;
  x ^= x >> 16; return x;
}
float h2(int a, int b) {
  uint x = hu(uint(a + 1048576) * 0x9E3779B1U ^ hu(uint(b + 1048576)));
  return float(x >> 8) * (1.0 / 16777216.0);
}
// Value noise: одна билинейная выборка по сдвинутым на smoothstep координатам
// даёт ту же гладкую интерполяцию, что и четыре хеша с mix.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 256.5) * (1.0 / 512.0), 0.0).r;
}
// Дешёвый хеш целочисленной пары — выборка из той же текстуры (период 512).
vec4 th(int a, int b) { return texelFetch(uNoise, ivec2(a & 511, b & 511), 0); }

// ---------------------------------------------------------------- фильтры
vec2 gDx, gDy; // размер пикселя на плоскости (ray differentials)
float fwA(vec2 axis) { return abs(dot(gDx, axis)) + abs(dot(gDy, axis)); }

// Одна полоса ширины w вокруг d = 0, box-фильтр по окну fw.
float lineBox(float d, float w, float fw) {
  fw = max(fw, 1e-6);
  return max(0.0, min(d + 0.5 * fw, 0.5 * w) - max(d - 0.5 * fw, -0.5 * w)) / fw;
}
// Первообразная «полоса [0, w] на периоде T».
float stripeF(float x, float T, float w) {
  float k = floor(x / T);
  return k * w + clamp(x - k * T, 0.0, w);
}
// Полосы ширины w с центрами в k*T, интеграл по окну пикселя; при fw >= T — среднее w/T.
float stripes(float x, float T, float w, float fw) {
  fw = max(fw, 1e-6);
  float x0 = x + 0.5 * w;
  float v = (stripeF(x0 + 0.5 * fw, T, w) - stripeF(x0 - 0.5 * fw, T, w)) / fw;
  return mix(v, w / T, smoothstep(0.6 * T, 2.0 * T, fw));
}
// Цепочка гауссовых огней вдоль оси al с шагом L; ac — расстояние до оси цепочки.
// Ширина растёт с размером пикселя, энергия сохраняется (2D: множитель s0^2/(sa*sc)).
// Когда пиксель больше шага — плавно переходим к усреднённой линии.
float lightRow(float al, float ac, float L, float fwal, float fwac, float s0) {
  float sa = sqrt(s0 * s0 + 0.09 * fwal * fwal);
  float sc = sqrt(s0 * s0 + 0.09 * fwac * fwac);
  float da = al - L * floor(al / L + 0.5);
  float g  = exp(-0.5 * ac * ac / (sc * sc));
  float disc = (s0 * s0 / (sa * sc)) * exp(-0.5 * da * da / (sa * sa)) * g;
  float line = (s0 * s0 * 2.5066 / (sc * L)) * g;
  return mix(disc, line, smoothstep(0.25 * L, 0.8 * L, fwal));
}
// Решётка огней: цепочки с шагом L, сами цепочки повторяются с периодом T поперёк.
float lightGrid(float al, float ac, float L, float T, float fwal, float fwac, float s0) {
  float dc = ac - T * floor(ac / T + 0.5);
  float v = lightRow(al, dc, L, fwal, fwac, s0);
  float full = s0 * s0 * TAU / (L * T);
  return mix(v, full, smoothstep(0.3 * T, 0.9 * T, fwac));
}
// Машины одной полосы: позиция = (вдоль − время·скорость) / шаг, часть ячеек пустая.
float carLane(float al, float ac, float L, float v, float fwal, float fwac, float s0, int seed) {
  float sc = sqrt(s0 * s0 + 0.09 * fwac * fwac);
  float g = exp(-0.5 * ac * ac / (sc * sc));
  float line = 0.62 * (s0 * s0 * 2.5066 / (sc * L)) * g;
  float k = smoothstep(0.2 * L, 0.7 * L, fwal);
  if (k >= 1.0 || g < 1e-4) return line * step(1e-4, g);
  float x = al - v * uTime;
  float cell = floor(x / L);
  vec4 hh = th(int(cell), seed);
  float present = step(0.38, hh.g);
  float jit = (hh.b - 0.5) * 0.5 * L;
  float da = x - (cell + 0.5) * L - jit;
  float sa = sqrt(s0 * s0 + 0.09 * fwal * fwal);
  float disc = present * (s0 * s0 / (sa * sc)) * exp(-0.5 * da * da / (sa * sa)) * g;
  return mix(disc, line, k);
}
// Мягкий ореол вокруг линии (гаусс поперёк, нормированный по энергии).
float halo(float d, float s0, float fw) {
  float s = sqrt(s0 * s0 + 0.09 * fw * fw);
  return (s0 / s) * exp(-0.5 * d * d / (s * s));
}

// ---------------------------------------------------------------- небо
vec3 skyBase(vec3 rd) {
  float e = max(rd.y, 0.0);
  vec3 hor = vec3(0.014, 0.021, 0.060) + uBlue * 0.010;
  vec3 zen = vec3(0.0010, 0.0014, 0.0042);
  vec3 c = mix(hor, zen, pow(smoothstep(0.0, 0.75, e), 0.55));
  c += vec3(0.16, 0.12, 0.05) * 0.22 * exp(-e / 0.025);   // тонкая тёплая полоса
  c += vec3(0.014, 0.030, 0.075) * exp(-e / 0.1);           // холодная, шире
  // засветка горизонта в сторону центра города
  vec2 toC = -uCamPos.xz;
  float dC = length(toC);
  vec2 hd = rd.xz / max(length(rd.xz), 1e-5);
  float face = dC > 1e-3 ? dot(hd, toC / dC) : 1.0;
  float inside = 1.0 - smoothstep(3.0, 22.0, dC);
  float g = mix(0.5 + 0.5 * face, 1.0, 0.6 * inside);
  c += vec3(0.20, 0.15, 0.075) * 0.17 * g * g * exp(-e / 0.07);
  return c;
}
float stars(vec3 rd) {
  if (rd.y < 0.02) return 0.0;
  vec3 q = rd * 160.0;
  vec3 c = floor(q);
  ivec3 ic = ivec3(c);
  float h = h2(ic.x + 512 * ic.y, ic.z);
  if (h < 0.991) return 0.0;
  vec3 o = vec3(h2(ic.x, ic.y + 77), h2(ic.y, ic.z + 31), h2(ic.z, ic.x + 13));
  vec3 sp = normalize((c + 0.2 + 0.6 * o) / 160.0);
  float d = length(rd - sp);
  float px = 2.0 * uTanH / uRes.y;
  float s = max(0.7 * px, 0.00025);
  float b = (h - 0.991) / 0.009;
  return (0.00025 / s) * (0.00025 / s) * b * b * 1.6 * exp(-0.5 * d * d / (s * s))
         * smoothstep(0.02, 0.25, rd.y);
}
vec3 sky(vec3 rd) {
  vec3 c = skyBase(rd);
#ifndef ABL_STARS
  if (uLod > 0.5) c += vec3(0.85, 0.88, 1.0) * stars(rd);
#endif
  return c;
}

// ---------------------------------------------------------------- река
float riverF(float x)  { return 0.8 * sin(0.38 * x) + 0.25 * sin(1.1 * x); }
float riverDF(float x) { return 0.304 * cos(0.38 * x) + 0.275 * cos(1.1 * x); }

// ---------------------------------------------------------------- сетка кварталов
// Одна и та же сетка используется плоским городом и зданиями — совпадение по построению.
// nS, nE — нормали к лучам-границам сектора, r0..r1 — кольцевая полоса: проверка «точка в этой сетке» без atan.
struct Grid { int gid; float T; vec2 eu; vec2 ev; vec2 off; vec2 nS; vec2 nE; float r0; float r1; };

int gidAt(vec2 p) {
  float r = length(p);
  if (r < 1.3) return 997;
  float a = atan(p.x, p.y); if (a < 0.0) a += TAU;
  int idx = int(floor(a / (TAU / float(NAVE)))) % NAVE;
  int s = (a < uAve[idx]) ? (idx + NAVE - 1) % NAVE : idx;
  int band = r < 2.3 ? 1 : (r < 5.5 ? 2 : (r < 17.5 ? 3 : 4));
  return s + band * NAVE;
}
Grid gridFor(int gid) {
  Grid G;
  G.gid = gid;
  G.T = mix(0.085, 0.14, h2(gid, 17));
  float ang = 0.35;
  G.nS = vec2(0.0); G.nE = vec2(0.0); G.r0 = 0.0; G.r1 = 1.3;
  if (gid != 997) {
    int s = gid % NAVE;
    int band = gid / NAVE;
    float thS = uAve[s], thE = uAve[(s + 1) % NAVE];
    if (thE < thS) thE += TAU;
    ang = 0.5 * (thS + thE) + (h2(gid, 5) - 0.5) * 0.5;
    G.nS = vec2(cos(thS), -sin(thS));
    G.nE = vec2(cos(thE), -sin(thE));
    G.r0 = band == 1 ? 1.3 : (band == 2 ? 2.3 : (band == 3 ? 5.5 : 17.5));
    G.r1 = band == 1 ? 2.3 : (band == 2 ? 5.5 : (band == 3 ? 17.5 : 1e6));
  }
  G.eu = vec2(sin(ang), cos(ang));
  G.ev = vec2(cos(ang), -sin(ang));
  G.off = vec2(h2(gid, 8), h2(gid, 9)) * G.T;   // сдвиг фазы сетки: улицы прямые, без шумового изгиба
  return G;
}
bool inGrid(Grid G, vec2 p) {
  float r = length(p);
  if (r < G.r0 || r >= G.r1) return false;
  return G.gid == 997 || (dot(p, G.nS) >= 0.0 && dot(p, G.nE) < 0.0);
}
// Расстояние до ближайшей «запретной» полосы: кольца, проспекты, река с набережными.
float roadDist(vec2 c) {
  float r = length(c);
  float d = 1e3;
  float rings[4] = float[4](1.3, 2.3, 5.5, 17.5);
  for (int i = 0; i < 4; i++) d = min(d, abs(r - rings[i]) - 0.5 * (0.016 + 0.0032 * rings[i]) - 0.012);
  float a = atan(c.x, c.y); if (a < 0.0) a += TAU;
  int idx = int(floor(a / (TAU / float(NAVE)))) % NAVE;
  for (int k = -1; k <= 1; k++) {
    int i = (idx + k + NAVE) % NAVE;
    float th = uAve[i];
    float al = dot(c, vec2(sin(th), cos(th)));
    if (al < 1.15) continue;
    d = min(d, abs(dot(c, vec2(cos(th), -sin(th)))) - 0.5 * (0.026 + 0.0015 * min(al, 18.0)) - 0.014);
  }
  float dfr = riverDF(c.x);
  d = min(d, abs(c.y - riverF(c.x)) * inversesqrt(1.0 + dfr * dfr) - 0.125);
  return d;
}

// ---------------------------------------------------------------- город
vec3 cityColor(vec2 p, vec3 rd, float t) {
  float r = length(p);
  vec2 rdir = r > 1e-4 ? p / r : vec2(0.0, 1.0);
  vec2 tdir = vec2(rdir.y, -rdir.x);
  float fwR = fwA(rdir), fwT = fwA(tdir);
  float fwIso = max(length(gDx), length(gDy));

  // ---- плотность, парки, тип света
  float n1 = 0.6 * vnoise(p * 0.45 + 3.1) + 0.4 * vnoise(p * 1.15 - 7.3);
  float n2 = vnoise(p * 0.32 + 11.7);
  float park = smoothstep(0.31, 0.24, n1) * smoothstep(0.6, 1.2, r);
  float urban = (0.14 + 0.86 * exp(-r / 5.0) + 0.9 * exp(-r / 1.4)) * (1.0 - smoothstep(16.5, 21.0, r));
  float rural = 0.25 * smoothstep(0.62, 0.78, vnoise(p * 0.7 + 21.0)) * smoothstep(15.0, 20.0, r);
  float n3 = vnoise(p * 3.1 + 1.7);
  float dens = (urban * smoothstep(0.18, 0.5, n1) * (0.45 + 0.9 * n3 * n3) + rural) * (1.0 - park);
  vec3 lcol = mix(SODIUM, LED, smoothstep(0.5, 0.72, n2) * (0.3 + 0.7 * (1.0 - smoothstep(2.5, 8.0, r))));

  // ---- река (нужна заранее, чтобы вырезать кварталы)
  float fr = riverF(p.x), dfr = riverDF(p.x);
  float rs = inversesqrt(1.0 + dfr * dfr);
  float rDist = (p.y - fr) * rs;               // расстояние до оси реки
  vec2 rN = vec2(-dfr, 1.0) * rs;
  vec2 rT = vec2(1.0, dfr) * rs;
  float fwRn = fwA(rN), fwRt = fwA(rT);
  float water = lineBox(rDist, 0.17, fwRn);
  float bankZone = lineBox(rDist, 0.235, fwRn);  // вода + набережные — без кварталов

  // ---- сектор и сетка кварталов
  float a = atan(p.x, p.y); if (a < 0.0) a += TAU;
  float base = TAU / float(NAVE);
  int idx = int(floor(a / base)) % NAVE;
  Grid G = gridFor(gidAt(p));
  int gid = G.gid;
  float T = G.T;
  vec2 eu = G.eu, ev = G.ev;
  float u = dot(p, eu) + G.off.x, v = dot(p, ev) + G.off.y;
  float fwu = fwA(eu), fwv = fwA(ev);

  // улицы: полосы box-фильтром, часть улиц выключена
  float sw = 0.011;
  // сила улицы: выключена (30 %), второстепенная (0.25) или главная (1); среднее 0.3625
  float hV = th(gid * 131 + int(floor(v / T + 0.5)), 3).g;
  float hU = th(gid * 137 + int(floor(u / T + 0.5)), 4).b;
  float onV = hV < 0.3 ? 0.0 : (hV > 0.75 ? 1.0 : 0.25);
  float onU = hU < 0.3 ? 0.0 : (hU > 0.75 ? 1.0 : 0.25);
  onV = mix(onV, 0.3625, smoothstep(0.35 * T, 1.0 * T, fwv));
  onU = mix(onU, 0.3625, smoothstep(0.35 * T, 1.0 * T, fwu));
  float stV = stripes(v, T, sw, fwv) * onV;   // улицы вдоль u
  float stU = stripes(u, T, sw, fwu) * onU;   // улицы вдоль v
  float streets = 1.0 - (1.0 - stV) * (1.0 - stU);

  float block = 1.0 - bankZone;
  float lit = dens * block;

  vec3 col = vec3(0.0016, 0.0019, 0.0034);    // тёмная земля

  // подсвеченный асфальт
  col += lcol * 0.035 * streets * lit;

  // фонари: каждые 25 м вдоль улиц + на перекрёстках
  float s0 = 0.0024;
#ifndef ABL_LAMPS
  float lamps = lightGrid(u, v, 0.025, T, fwu, fwv, s0) * onV
              + lightGrid(v, u, 0.025, T, fwv, fwu, s0) * onU
              + 1.6 * lightGrid(u, v, T, T, fwu, fwv, 0.003) * sqrt(onU * onV);
  col += lcol * 6.5 * lamps * lit;
#endif

  // окна: слабая шумовая подсветка ячеек 18 м
#ifndef ABL_WIN
  float wc = 0.018;
  float wn = vnoise(vec2(u, v) / wc + float(gid) * 13.1);
#endif
#ifndef ABL_WIN
  float win = mix(wn * wn, 0.296, smoothstep(0.25 * wc, 1.1 * wc, max(fwu, fwv)));
  vec3 wcol = mix(vec3(1.0, 0.62, 0.30), vec3(0.75, 0.85, 1.0), smoothstep(0.4, 0.7, n2));
  col += wcol * 0.05 * win * (1.0 - streets) * lit;
#endif

  // редкие яркие «искры» вблизи
#if !defined(ABL_WIN) && !defined(NO_SPARKS)
  if (uLod > 0.5) {
    vec2 cc = floor(vec2(u, v) / wc);
    ivec2 ic = ivec2(cc);
    float hs = fwIso < wc ? th(ic.x + gid * 7919, ic.y).a : 0.0;
    float spark = 0.0;
    float sp0 = 0.0016;
    if (hs > 0.975) {
      vec2 d = vec2(u, v) - (cc + 0.5) * wc;
      float ss = sqrt(sp0 * sp0 + 0.09 * fwIso * fwIso);
      spark = (sp0 * sp0) / (ss * ss) * exp(-0.5 * dot(d, d) / (ss * ss));
    }
    float sparkAvg = 0.025 * TAU * sp0 * sp0 / (wc * wc);
    spark = mix(spark, sparkAvg, smoothstep(0.3 * wc, 1.0 * wc, fwIso));
    col += vec3(1.0, 0.85, 0.65) * 7.0 * spark * (1.0 - streets) * lit;
  }
#endif

  // ---- вода: почти чёрная, отражение неба и огней набережной (считаем только рядом с рекой)
  if (abs(rDist) < 0.14 + 3.0 * fwRn) {
#ifndef ABL_WATER
  vec3 refl = skyBase(reflect(rd, vec3(0.0, 1.0, 0.0)));
  float fres = 0.04 + 0.96 * pow(1.0 - abs(rd.y), 5.0);
  vec3 wcolr = vec3(0.0006, 0.0009, 0.0022) + uBlue * 0.0012 + refl * fres * 0.6;
  float bankDist = 0.085 - abs(rDist);
  float shimmerPer = 0.011;
  float wn1 = vnoise(vec2(p.x / shimmerPer + uTime * 0.6, rDist * 55.0 - uTime * 0.35));
  float shimmer = 0.25 + 1.2 * wn1 * wn1;
  shimmer = mix(shimmer, 0.6, smoothstep(0.25 * shimmerPer, 1.0 * shimmerPer, max(fwRt, fwRn * 0.2)));
  float reflGlow = exp(-max(bankDist, 0.0) / 0.018) * smoothstep(-0.002, 0.004, bankDist);
  wcolr += SODIUM * 0.20 * reflGlow * shimmer;
  col = mix(col, wcolr, water);
#endif

  // набережные: дорога и цепочки фонарей по обоим берегам
  float embW = 0.007;
  float emb = lineBox(abs(rDist) - 0.097, embW, fwRn);
  col += uGold * 0.35 * emb;
  float bankLamps = lightRow(p.x, abs(rDist) - 0.089, 0.03, fwA(vec2(1.0, 0.0)), fwRn, 0.0028);
  col += mix(SODIUM, uGold, 0.5) * 7.0 * bankLamps;
  }

  // ---- кольцевые дороги
  float rings[4] = float[4](1.3, 2.3, 5.5, 17.5);
  for (int i = 0; i < 4; i++) {
    float R = rings[i];
    float d = r - R;
    if (abs(d) > 0.6 + 4.0 * fwR) continue;
    float w = 0.016 + 0.0032 * R;
    float m = lineBox(d, w, fwR);
    float edges = lineBox(abs(d) - 0.5 * w + 0.002, 0.004, fwR);
    col += uGold * (0.16 * m + 1.1 * edges + 0.10 * halo(d, 0.5 * w + 0.02, fwR));
    // поток машин по кольцу (длина дуги, шаг подогнан, чтобы не было шва)
    float circ = TAU * R;
    float Lc = circ / floor(circ / 0.05);
    float al = (a / TAU) * circ;
#ifndef ABL_CARS
    col += uLight * 6.0 * carLane(al, d - 0.25 * w, Lc,  0.012, fwT, fwR, 0.0012, 40 + i);
    col += TAIL   * 4.5 * carLane(al, d + 0.25 * w, Lc, -0.012, fwT, fwR, 0.0012, 50 + i);
#endif
  }

  // ---- радиальные проспекты (три ближайших)
  for (int k = -1; k <= 1; k++) {
    int i = (idx + k + NAVE) % NAVE;
    float th = uAve[i];
    vec2 d = vec2(sin(th), cos(th));
    vec2 n = vec2(cos(th), -sin(th));
    float al = dot(p, d), ac = dot(p, n);
    if (al < 1.0 || abs(ac) > 0.5 + 4.0 * fwA(n)) continue;
    float fwal = fwA(d), fwac = fwA(n);
    float start = smoothstep(1.22, 1.38, al);
    float w = 0.026 + 0.0015 * min(al, 18.0);
    float m = lineBox(ac, w, fwac) * start;
    float edges = lineBox(abs(ac) - 0.5 * w + 0.002, 0.004, fwac) * start;
    col += uGold * (0.10 * m + 1.0 * edges + 0.08 * halo(ac, 0.5 * w + 0.02, fwac) * start);
    // фары в одну сторону, стоп-сигналы — в другую
#ifndef ABL_CARS
    col += uLight * 14.0 * carLane(al, ac - 0.0065, 0.045,  0.016, fwal, fwac, 0.0017, 10 + i) * start;
    col += TAIL   * 18.0 * carLane(al, ac + 0.0065, 0.045, -0.016, fwal, fwac, 0.0017, 30 + i) * start;
#endif
  }

  // центр: площадь с мягким тёплым свечением
  col += uGold * 0.10 * halo(r, 0.25, fwIso);
  return col;
}

// ---------------------------------------------------------------- здания
// Обход сетки кварталов по лучу (DDA в локальных осях сектора); в квартале 1, 2 или 4 бокса.
struct Hit { float t; int face; vec3 bmin; vec3 bmax; int bid; float dens; Grid G; };

// Один хеш на квартал, дальше — дешёвая LCG-последовательность.
uint bseed;
float bnext() { bseed = bseed * 1664525U + 1013904223U; return float(bseed >> 8) * (1.0 / 16777216.0); }

bool boxHit(vec3 o, vec3 inv, vec3 bmin, vec3 bmax, float tmin, out float tn, out int face) {
  vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
  vec3 tl = min(t0, t1), th = max(t0, t1);
  tn = max(max(tl.x, tl.y), tl.z);
  float tf = min(min(th.x, th.y), th.z);
  face = tn == tl.x ? 0 : (tn == tl.y ? 1 : 2);
  return tn <= tf && tf >= tmin;
}

void frameFor(Grid G, vec3 ro, vec3 rd, out vec3 o, out vec3 dl, out vec3 inv) {
  o = vec3(dot(ro.xz, G.eu) + G.off.x, ro.y, dot(ro.xz, G.ev) + G.off.y);
  dl = vec3(dot(rd.xz, G.eu), rd.y, dot(rd.xz, G.ev));
  vec3 dd = dl;
  dd.x = abs(dd.x) < 1e-7 ? 1e-7 : dd.x;
  dd.y = abs(dd.y) < 1e-7 ? 1e-7 : dd.y;
  dd.z = abs(dd.z) < 1e-7 ? 1e-7 : dd.z;
  inv = 1.0 / dd;
}

float traceBuildings(vec3 ro, vec3 rd, float tGround, out Hit hit) {
  hit.t = -1.0;
  if (uBuild < 0.01) return -1.0;
  float HG = 0.37 * uBuild;
  float t0, t1;
  if (rd.y < 0.0) { t0 = max(0.0, (ro.y - HG) / (-rd.y)); t1 = tGround; }
  else { if (ro.y >= HG) return -1.0; t0 = 0.0; t1 = (HG - ro.y) / max(rd.y, 1e-6); }
  float Rfar = uBRad * (1.0 + 0.35 * ro.y);
  t1 = min(t1, Rfar / max(length(rd.xz), 1e-6));
  if (t0 >= t1) return -1.0;

  float tc = t0;
  Grid G = gridFor(gidAt((ro + rd * (tc + 2e-5)).xz));
  vec3 o, dl, inv;
  frameFor(G, ro, rd, o, dl, inv);

  for (int i = 0; i < 96; i++) {
    if (float(i) >= uSteps || tc >= t1) break;
    float te = tc + 2e-5;
    float T = G.T;
    vec2 cell = floor((o.xz + dl.xz * te) / T);
    vec2 cl = (cell + 0.5) * T;
    vec2 cw = G.eu * (cl.x - G.off.x) + G.ev * (cl.y - G.off.y);
    bool inG = inGrid(G, cw);
    if (!inG) {
      // центр квартала в другой зоне — возможно, луч уже пересёк границу сетки
      int g = gidAt((ro + rd * te).xz);
      if (g != G.gid) {
        G = gridFor(g); frameFor(G, ro, rd, o, dl, inv);
        T = G.T;
        cell = floor((o.xz + dl.xz * te) / T);
        cl = (cell + 0.5) * T;
        cw = G.eu * (cl.x - G.off.x) + G.ev * (cl.y - G.off.y);
        inG = inGrid(G, cw);
      }
    }
    float tu = ((dl.x > 0.0 ? cell.x + 1.0 : cell.x) * T - o.x) * inv.x;
    float tv = ((dl.z > 0.0 ? cell.y + 1.0 : cell.y) * T - o.z) * inv.z;
    float tx = max(min(tu, tv), tc + 1e-5);
    float rc = length(cw);
    float ymin = min(ro.y + rd.y * tc, ro.y + rd.y * tx);
    float hcap = (rc < 2.3 ? 0.37 : min(0.27, (0.012 + 0.2 * exp(-rc / 1.6)) * 3.2)) * uBuild;

    if (ymin < hcap && rc < 17.0 && inG) {
      vec4 cd = textureLod(uCity, cw * (0.5 / CITY_EXT) + 0.5, 0.0);
      float densF = cd.r, park = cd.g;
      if (park < 0.5 && densF > 0.12) {
        float dR = cd.b * 0.8 - 0.1;
        int cx = int(cell.x), cy = int(cell.y);
        float dcam = length(cw - ro.xz);
        float hs = uBuild * (1.0 - smoothstep(0.6 * Rfar, Rfar, dcam));
        float base = (0.012 + 0.20 * exp(-rc / 1.6)) * mix(0.55, 1.1, densF)
                   * (1.0 + 0.3 * (1.0 - smoothstep(0.02, 0.3, dR)));
        bseed = hu(uint(cx + 1048576) * 0x9E3779B1U ^ hu(uint(cy + 1048576) ^ uint(G.gid) * 0x85EBCA6BU));
        float ht = bnext();
        int nl = ht < 0.10 ? 0 : (ht < 0.40 ? 1 : (ht < 0.68 ? 2 : 4));
        bool alongU = bnext() < 0.5;
        float sb = 0.0095;
        vec2 lo0 = cell * T + sb, hi0 = (cell + 1.0) * T - sb;
        vec2 mid0 = 0.5 * (lo0 + hi0);
        float best = 1e9; int bface = 0; vec3 bmn = vec3(0.0), bmx = vec3(0.0); int bk = 0;
        for (int k = 0; k < 4; k++) {
          if (k >= nl) break;
          vec2 lo = lo0, hi = hi0;
          if (nl == 2) {
            if (alongU) { if (k == 0) hi.x = mid0.x - 0.003; else lo.x = mid0.x + 0.003; }
            else        { if (k == 0) hi.y = mid0.y - 0.003; else lo.y = mid0.y + 0.003; }
          } else if (nl == 4) {
            if ((k & 1) == 0) hi.x = mid0.x - 0.003; else lo.x = mid0.x + 0.003;
            if ((k & 2) == 0) hi.y = mid0.y - 0.003; else lo.y = mid0.y + 0.003;
          }
          float q1 = bnext(), q2 = bnext(), q3 = bnext();
          if (nl == 4 && q1 < 0.15) continue;           // пустой участок
          vec2 sz = hi - lo;
          lo += sz * 0.13 * vec2(q2, q3);
          hi -= sz * 0.13 * vec2(q3, q2);
          float H = base * mix(0.5, 1.15, q1);
          bool tall = false;
          if (nl == 4 && q3 > 0.78) {                   // узкая башня
            float side = min(hi.x - lo.x, hi.y - lo.y) * mix(0.5, 0.8, q2);
            vec2 c = 0.5 * (lo + hi) + (vec2(q2, q1) - 0.5) * 0.15 * (hi - lo);
            lo = c - 0.5 * side; hi = c + 0.5 * side;
            H = base * mix(1.5, 2.6, q1);
            if (rc < 2.3 && q3 > 0.965) { H = mix(0.30, 0.36, q2); tall = true; }   // редкие высотки
          }
          if (!tall) H = min(H, 0.27);
          H = max(H, 0.008) * hs;
          if (H < 0.002) continue;
          // не ставим на дороги и в реку
          vec2 lc = 0.5 * (lo + hi);
          float hd = 0.5 * length(hi - lo);
          float dLot = dR - length(lc - cl);
          if (dR < T + 0.06) dLot = roadDist(G.eu * (lc.x - G.off.x) + G.ev * (lc.y - G.off.y));
          if (dLot < hd) continue;
          float tn; int f;
          if (boxHit(o, inv, vec3(lo.x, 0.0, lo.y), vec3(hi.x, H, hi.y), tc - 1e-4, tn, f) && tn < best) {
            best = tn; bface = f; bmn = vec3(lo.x, 0.0, lo.y); bmx = vec3(hi.x, H, hi.y); bk = k;
          }
        }
        if (best < 1e8 && best < t1 + 0.01) {
          hit.t = max(best, 0.0); hit.face = bface; hit.bmin = bmn; hit.bmax = bmx;
          hit.bid = (cx * 73856093) ^ (cy * 19349663) ^ (G.gid * 83492791) ^ (bk * 2654435);
          hit.dens = densF; hit.G = G;
          return hit.t;
        }
      }
    }
    tc = tx;
  }
  return -1.0;
}

vec3 shadeBuilding(Hit h, vec3 ro, vec3 rd, vec3 rdx, vec3 rdy) {
  Grid G = h.G;
  vec3 o, dl, inv;
  frameFor(G, ro, rd, o, dl, inv);
  vec3 P = o + dl * h.t;                         // локальные (u, y, v)
  vec3 nl = h.face == 0 ? vec3(-sign(dl.x), 0.0, 0.0)
          : (h.face == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, -sign(dl.z)));
  vec3 nw = vec3(G.eu.x * nl.x + G.ev.x * nl.z, nl.y, G.eu.y * nl.x + G.ev.y * nl.z);
  // ray differentials на плоскость грани
  vec3 dx = rdx - rd, dy = rdy - rd;
  float rn = dot(rd, nw);
  rn = abs(rn) < 1e-5 ? -1e-5 : rn;
  vec3 dPx = h.t * (dx - rd * (dot(dx, nw) / rn));
  vec3 dPy = h.t * (dy - rd * (dot(dy, nw) / rn));
  vec3 lx = vec3(dot(dPx.xz, G.eu), dPx.y, dot(dPx.xz, G.ev));
  vec3 ly = vec3(dot(dPy.xz, G.eu), dPy.y, dot(dPy.xz, G.ev));

  float hb1 = h2(h.bid, 1), hb2 = h2(h.bid, 2);
  float Hm = h.bmax.y * 1000.0;
  float ym = P.y * 1000.0;
  vec3 glowC = mix(SODIUM, vec3(1.0, 0.7, 0.45), 0.4);
  vec3 facade = vec3(0.0030, 0.0040, 0.0085);

  if (h.face == 1) {
    // крыша: чуть светлее, у высоких — мигающий красный огонь
    // крыша: чуть светлее фасада, плюс рассеянный свет окон верхних этажей и техники —
    // сверху центр не должен становиться темнее плоского плана
    vec3 c = facade * 1.8 + vec3(1.0, 0.72, 0.46) * 0.007 * (0.3 + h.dens);
    if (Hm > 110.0) {
      vec2 cc = 0.5 * (h.bmin.xz + h.bmax.xz);
      vec2 d = P.xz - cc;
      float fw = max(length(lx.xz) + length(ly.xz), 1e-6);
      float s0 = 0.0009;
      float s = sqrt(s0 * s0 + 0.09 * fw * fw);
      float blink = 0.35 + 0.65 * step(0.45, fract(uTime * 0.55 + hb1));
      c += TAIL * 9.0 * (s0 * s0) / (s * s) * exp(-0.5 * dot(d, d) / (s * s)) * blink;
    }
    c += vec3(1.0, 0.8, 0.6) * 0.006 * step(0.8, hb2);   // подсветка техники на части крыш
    return c;
  }

  // фасад: координата вдоль грани и высота, в метрах
  float sm = (h.face == 0 ? P.z : P.x) * 1000.0;
  float fws = (h.face == 0 ? abs(lx.z) + abs(ly.z) : abs(lx.x) + abs(ly.x)) * 1000.0;
  float fwy = (abs(lx.y) + abs(ly.y)) * 1000.0;
  fws = max(fws, 1e-3); fwy = max(fwy, 1e-3);

  const float CX = 3.6, CY = 3.2, WX = 2.3, WY = 1.7;
  float cov = stripes(sm - 0.5 * CX, CX, WX, fws) * stripes(ym - 0.5 * CY, CY, WY, fwy);
  float ci = floor(sm / CX), fi = floor(ym / CY);
  float lf = mix(0.05, 0.30, hb1 * hb1);
  float hw = h2(h.bid * 977 + int(ci) * 7 + h.face * 131, int(fi));
  float lit = step(hw, lf) * (0.55 + 0.9 * fract(hw * 37.0));
  float a = smoothstep(0.35, 1.0, max(fws / CX, fwy / CY));
  float meanCov = (WX / CX) * (WY / CY);
  float em = mix(cov * lit, 0.42 * meanCov * lf, a);   // вдали чуть темнее: вблизи пики окон срезает тонмаппинг
  em *= 1.0 - smoothstep(Hm - 3.5, Hm - 1.5, ym);          // без окон на парапете
  float cool = step(0.55, hb2);
  float wv = fract(hw * 91.0);
  vec3 wcol = mix(mix(vec3(1.0, 0.60, 0.28), vec3(1.0, 0.78, 0.5), wv),
                  mix(vec3(0.70, 0.82, 1.0), vec3(0.9, 0.93, 1.0), wv), cool);
  wcol = mix(wcol, mix(vec3(1.0, 0.68, 0.38), vec3(0.78, 0.86, 1.0), cool), a);   // вдали — средний цвет

  vec3 c = facade;
  c += glowC * 0.011 * (0.4 + h.dens) * exp(-ym / 25.0);   // отсвет улиц снизу
  c *= mix(0.35, 1.0, smoothstep(0.0, 10.0, ym));          // затенение у основания
  c += wcol * 1.1 * em;
  return c;
}

// ---------------------------------------------------------------- цвет
vec3 toOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 fromOklab(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 gamutGuard(vec3 c) {
  vec3 lab = toOklab(c);
  float C = length(lab.yz);
  float cmax = 0.62 * lab.x;
  if (C > cmax && C > 1e-6) lab.yz *= cmax / C;
  return max(fromOklab(lab), 0.0);
}
vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 antiPurple(vec3 c) {
  if (c.g < c.r && c.g < c.b) {
    if (c.b > c.r) c.r = c.g + min(c.r - c.g, 0.55 * (c.b - c.g));
    else           c.b = c.g + min(c.b - c.g, 0.55 * (c.r - c.g));
  }
  return c;
}
vec3 toSrgb(vec3 c) {
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hashPix(vec2 p) { return h2(int(p.x), int(p.y) + int(fract(uTime) * 17.0) * 4099); }

vec3 rayDir(vec2 fc) {
  vec2 q = (2.0 * fc - uRes) / uRes.y;
  return normalize(uCamF + (q.x * uCamR + q.y * uCamU) * uTanH);
}

#ifdef BAKE
void main() {
  vec2 p = (gl_FragCoord.xy * (1.0 / 1024.0) * 2.0 - 1.0) * CITY_EXT;
  float r = length(p);
  float n1 = 0.6 * vnoise(p * 0.45 + 3.1) + 0.4 * vnoise(p * 1.15 - 7.3);
  float park = smoothstep(0.31, 0.24, n1) * smoothstep(0.6, 1.2, r);
  float densF = smoothstep(0.18, 0.5, n1);
  float dR = roadDist(p);
  outColor = vec4(densF, park, clamp((dR + 0.1) / 0.8, 0.0, 1.0), n1);
}
#else
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec3 rd  = rayDir(fc);
  vec3 rdx = rayDir(fc + vec2(1.0, 0.0));
  vec3 rdy = rayDir(fc + vec2(0.0, 1.0));
  vec3 ro = uCamPos;

  vec3 hz = skyBase(vec3(rd.x, 0.0, rd.z));
  float hy = abs(rdx.y - rd.y) + abs(rdy.y - rd.y);
  float gcov = clamp(0.5 - rd.y / max(hy, 1e-6), 0.0, 1.0);   // сглаженный горизонт

  vec3 ground = hz;
  float tG = rd.y < -1e-5 ? min(-ro.y / rd.y, 400.0) : 400.0;
  Hit bhit;
#ifndef ABL_BUILD
  float tb = traceBuildings(ro, rd, tG, bhit);
#else
  float tb = -1.0;
#endif
  float H = 1.5;
  float hr = max(ro.y, 1e-3);
  vec3 haze = hz * 1.2 + vec3(0.010, 0.0085, 0.005);
  if (tb >= 0.0) {
    vec3 c = shadeBuilding(bhit, ro, rd, rdx, rdy);
    float depth = tb * (H / hr) * (1.0 - exp(-hr / H)) / 38.0;
    ground = mix(c, haze, 1.0 - exp(-depth));
    gcov = 1.0;
  } else if (rd.y < -1e-5) {
    float t = -ro.y / rd.y;
    if (t < 400.0) {
      vec3 P = ro + t * rd;
      vec3 dx = rdx - rd, dy = rdy - rd;
      gDx = (t * (dx - rd * (dx.y / rd.y))).xz;
      gDy = (t * (dy - rd * (dy.y / rd.y))).xz;
      vec3 c = cityColor(P.xz, rd, t);
      // дымка: оптическая толща по экспоненциальной атмосфере (шкала 1.5 км)
      float depth = t * (H / hr) * (1.0 - exp(-hr / H)) / 38.0;
      float fog = 1.0 - exp(-depth);
      ground = mix(c, haze, fog);
    }
  }
  vec3 col = gcov >= 1.0 ? ground : mix(sky(rd), ground, gcov);

  col *= uExpo;

  // вспышка в точке клика
  if (uFlash.z > 0.001) {
    vec2 d = (fc - uFlash.xy) / uRes.y;
    col += vec3(1.0, 0.62, 0.28) * 1.6 * uFlash.z * uFlash.z * exp(-0.5 * dot(d, d) / (0.075 * 0.075));
  }

  col = gamutGuard(col);
  col = aces(col);
  col = antiPurple(col);

  // виньетка
  vec2 uv = fc / uRes;
  vec2 vq = (uv - 0.5) * vec2(1.0, 1.15);
  col *= mix(1.0, 1.0 - 0.55 * dot(vq, vq), uVig);

  vec3 srgb = toSrgb(col);

  // растушёвка к цвету фона у краёв и при выходе из сцены
  float edge = smoothstep(0.0, 0.14, uv.y) * smoothstep(0.0, 0.14, 1.0 - uv.y);
  edge *= mix(1.0, smoothstep(0.0, 0.07, uv.x) * smoothstep(0.0, 0.07, 1.0 - uv.x), uSide);
  srgb = mix(uBgSrgb, srgb, edge * (1.0 - uFade));

  srgb += (hashPix(fc) - 0.5) / 255.0;
  outColor = vec4(srgb, 1.0);
}
#endif
`;
