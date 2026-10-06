"use client";

import { useMemo } from "react";
import { create } from "qrcode";

/** The QR matrix as one SVG path (dark modules), with the 4-module quiet zone scanners need. */
export function qrSvgPath(text: string): { size: number; d: string } {
  const qr = create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
  return { size: n + 8, d: parts.join("") };
}

/** A standalone SVG document for printing / downloading. */
export function qrSvgDocument(text: string, caption?: string): string {
  const { size, d } = qrSvgPath(text);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const h = caption ? size + 6 : size;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${h}" width="${size * 10}" height="${h * 10}" shape-rendering="crispEdges"><rect width="${size}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/>${caption ? `<text x="${size / 2}" y="${size + 3}" font-family="sans-serif" font-size="2.6" text-anchor="middle" fill="#000">${esc(caption)}</text>` : ""}</svg>`;
}

/** Scannable QR code for `value`, drawn as SVG (no canvas, no injected markup). */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => qrSvgPath(value), [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className={className}>
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
