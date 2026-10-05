/**
 * Rasterizes the RESTORA BrandMark (src/components/layout/BrandMark.tsx, 32×32
 * viewBox) to anti-aliased RGBA PNGs using signed distance fields — no image
 * dependencies — and writes the Windows .ico and the macOS .icns itself
 * (PNG-compressed entries), so packaging does not depend on electron-builder's
 * memory-hungry icon converter (or on macOS-only iconutil).
 *
 *   node desktop/scripts/make-icon.mjs <outDir>
 *     → icon.png (256 px) + icon.ico (256/64/48/32/16) + icon.icns (16–1024 px)
 *
 * The macOS icon sits on Apple's icon grid (824 px tile on a 1024 px canvas), so
 * it is the same size as other Dock icons; the Windows icon stays full-bleed.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [, , outDir] = process.argv;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// Must match src/components/layout/BrandMark.tsx.
const ESPRESSO = hex("#24180f");
const TERRACOTTA = hex("#c85a35");
const SAFFRON = hex("#f6dfa3");
const IVORY = hex("#fffcf6");

function roundedRectSdf(x, y, w, h, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
/** SDF of an axis-aligned rounded rectangle at (x0, y0). */
const boxSdf = (x, y, x0, y0, w, h, r) => roundedRectSdf(x - x0, y - y0, w, h, r);
/** SDF of the upper half-disc ("M7 19.5a9 9 0 0 1 18 0Z"): the disc intersected with y <= 19.5. */
const sunSdf = (x, y) => Math.max(Math.hypot(x - 16, y - 19.5) - 9, y - 19.5);

/** `inset`: transparent margin on each side, as a fraction of SIZE (macOS icon grid). */
function renderRaw(SIZE, inset = 0) {
  const off = SIZE * inset;
  const S = (SIZE - 2 * off) / 32;
  const cover = (sdf) => Math.max(0, Math.min(1, 0.5 - sdf * S)); // sdf in viewBox units → pixel coverage
  const over = (dst, rgb, a) => {
    const outA = a + dst[3] * (1 - a);
    if (outA === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((k) => (rgb[k] * a + dst[k] * dst[3] * (1 - a)) / outA).concat(outA);
  };

  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let py = 0; py < SIZE; py++) {
    raw[py * (SIZE * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < SIZE; px++) {
      const x = (px + 0.5 - off) / S, y = (py + 0.5 - off) / S;
      let c = [0, 0, 0, 0];
      const tile = cover(roundedRectSdf(x, y, 32, 32, 7));
      if (tile > 0) {
        c = over(c, ESPRESSO, tile);
        c = over(c, TERRACOTTA, cover(sunSdf(x, y)));
        c = over(c, SAFFRON, cover(Math.hypot(x - 16, y - 19.5) - 3.4));
        c = over(c, IVORY, cover(boxSdf(x, y, 5, 21, 22, 1.8, 0.9)));
        c = over(c, IVORY, 0.8 * cover(boxSdf(x, y, 7.5, 24.2, 17, 1.8, 0.9)));
        c = over(c, IVORY, 0.6 * cover(boxSdf(x, y, 10, 27.4, 12, 1.8, 0.9)));
      }
      const o = py * (SIZE * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(c[0]); raw[o + 1] = Math.round(c[1]); raw[o + 2] = Math.round(c[2]); raw[o + 3] = Math.round(c[3] * 255);
    }
  }
  return raw;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(SIZE, inset = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(renderRaw(SIZE, inset), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO with PNG-compressed images (supported by Windows Vista and later). */
function ico(sizes) {
  const images = sizes.map((n) => ({ n, data: png(n) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ n, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = n >= 256 ? 0 : n; // 0 means 256
    header[e + 1] = n >= 256 ? 0 : n;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((x) => x.data)]);
}

/** ICNS with PNG entries (OS X 10.7+): 16–512 pt at 1× and 2×. */
const MAC_INSET = 100 / 1024;
function icns() {
  const types = [["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024]];
  const cache = new Map();
  const entries = types.map(([type, n]) => {
    if (!cache.has(n)) cache.set(n, png(n, MAC_INSET));
    const data = cache.get(n);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.png"), png(256));
fs.writeFileSync(path.join(outDir, "icon.ico"), ico([256, 64, 48, 32, 16]));
fs.writeFileSync(path.join(outDir, "icon.icns"), icns());
console.log(`[icon] ${outDir}: icon.png (256 px), icon.ico (256/64/48/32/16), icon.icns (16–1024 px)`);
