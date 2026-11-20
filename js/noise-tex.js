// Текстура хешей 512×512 RGBA8 — заменяет целочисленные хеши и value-noise в шейдере.
// Канал R в текселе (x, y) равен h2(x − 256, y − 256) шейдера, поэтому шум в радиусе 256 клеток
// от начала координат совпадает с прежним (с точностью 8 бит). G, B, A — независимые хеши.

const C1 = 0x9e3779b1;
function hu(x) {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
function h2bits(a, b) {
  return hu((Math.imul((a + 1048576) >>> 0, C1) ^ hu((b + 1048576) >>> 0)) >>> 0);
}

export const NOISE_SIZE = 512;

export function makeNoiseData() {
  const N = NOISE_SIZE;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const v = h2bits(x - 256, y - 256);
      const w = hu(v ^ 0x5bd1e995);
      data[i] = Math.round(((v >>> 8) / 16777216) * 255);   // = h2(x − 256, y − 256)
      data[i + 1] = w & 255;
      data[i + 2] = (w >>> 8) & 255;
      data[i + 3] = (w >>> 16) & 255;
    }
  }
  return data;
}
