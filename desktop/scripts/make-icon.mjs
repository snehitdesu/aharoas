/**
 * Rasterizes the Aharos BrandMark (src/components/layout/BrandMark.tsx, 32×32
 * viewBox) to anti-aliased RGBA PNGs using signed distance fields — no image
 * dependencies — and writes the Windows .ico itself (PNG-compressed entries), so
 * packaging does not depend on electron-builder's memory-hungry icon converter.
 *
 *   node desktop/scripts/make-icon.mjs <outDir>   → icon.png (256 px) + icon.ico (256/64/48/32/16)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [, , outDir] = process.argv;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const MOON = hex("#357d90");
const RING = hex("#eff6f8");
const VANILLA = hex("#ffebaf");

function roundedRectSdf(x, y, w, h, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Cubic bezier of "M9.5 19.5c2.2-5 10.8-5 13 0" sampled into a polyline.
const P0 = [9.5, 19.5], P1 = [11.7, 14.5], P2 = [20.3, 14.5], P3 = [22.5, 19.5];
const arc = [];
for (let i = 0; i <= 200; i++) {
  const t = i / 200, u = 1 - t;
  arc.push([0, 1].map((k) => u * u * u * P0[k] + 3 * u * u * t * P1[k] + 3 * u * t * t * P2[k] + t * t * t * P3[k]));
}
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function arcDist(x, y) {
  let d = Infinity;
  for (let i = 1; i < arc.length; i++) d = Math.min(d, segDist(x, y, arc[i - 1], arc[i]));
  return d;
}

function renderRaw(SIZE) {
  const S = SIZE / 32;
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
      const x = (px + 0.5) / S, y = (py + 0.5) / S;
      let c = [0, 0, 0, 0];
      const tile = cover(roundedRectSdf(x, y, 32, 32, 9));
      if (tile > 0) {
        c = over(c, MOON, tile);
        const sheen = 0.25 * (1 - Math.min(1, (x + y) / 64)) * tile; // white → transparent diagonal
        c = over(c, [255, 255, 255], sheen);
        c = over(c, RING, 0.85 * cover(Math.abs(Math.hypot(x - 16, y - 16.5) - 7.5) - 1));
        c = over(c, VANILLA, cover(arcDist(x, y) - 1.2));
        c = over(c, VANILLA, cover(Math.hypot(x - 16, y - 12.6) - 1.8));
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

function png(SIZE) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(renderRaw(SIZE), { level: 9 })),
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

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.png"), png(256));
fs.writeFileSync(path.join(outDir, "icon.ico"), ico([256, 64, 48, 32, 16]));
console.log(`[icon] ${outDir}: icon.png (256 px), icon.ico (256/64/48/32/16)`);
