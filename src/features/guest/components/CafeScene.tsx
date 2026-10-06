"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * The storefront hero "set": an original flat illustration of a Coders' Cafe
 * interior (striped awning, menu board, counter, scalloped booths, terrazzo
 * floor). It is an illustration, not a photograph, and says so to assistive
 * tech. The guest moves the "camera" between a few views — one transform on a
 * wrapper, so the motion stays on the compositor and is interruptible.
 */

const VB_W = 1600;
const VB_H = 1000;

type View = { id: string; label: string; fx: number; fy: number; s: number };

export const SCENE_VIEWS: View[] = [
  { id: "street", label: "Street", fx: 800, fy: 500, s: 1 },
  { id: "counter", label: "Counter", fx: 860, fy: 640, s: 1.85 },
  { id: "booth", label: "Booth", fx: 1340, fy: 690, s: 2 },
  { id: "board", label: "Board", fx: 840, fy: 312, s: 2.5 },
];

// Deterministic terrazzo flecks (same on server and client — no hydration drift).
const FLECKS = (() => {
  let a = 0x5eed;
  const rnd = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const colors = ["#a3282c", "#e8782b", "#4a2a20", "#d9a066", "#7a1f24", "#c9b28f"];
  return Array.from({ length: 170 }, () => ({
    x: Math.round(rnd() * VB_W),
    y: Math.round(868 + rnd() * 128),
    r: Math.round((1.5 + rnd() * 4.5) * 10) / 10,
    rot: Math.round(rnd() * 180),
    c: colors[Math.floor(rnd() * colors.length)],
  }));
})();

/** Awning scallops along y = 150 from x = 0 → 1600. */
const AWNING = (() => {
  let d = `M0 64 H${VB_W} V150`;
  for (let x = VB_W; x > 0; x -= 50) d += ` A25 20 0 0 1 ${x - 50} 150`;
  return `${d} Z`;
})();

/** A booth back with a scalloped top, x..x+w, top y. */
function scallopTop(x: number, y: number, w: number, n: number) {
  const step = w / n;
  let d = `M${x} ${y + 30}`;
  for (let i = 0; i < n; i++) d += ` a${step / 2} ${step / 2.2} 0 0 1 ${step} 0`;
  return `${d} V${y + 210} H${x} Z`;
}

function Pendant({ x, top = 150, y }: { x: number; top?: number; y: number }) {
  return (
    <g>
      <line x1={x} y1={top} x2={x} y2={y - 22} stroke="#4a2a20" strokeWidth="3" />
      <rect x={x - 10} y={y - 30} width="20" height="12" rx="3" fill="#b8862f" />
    </g>
  );
}

function Globe({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle className="sf-scene-glow" cx={x} cy={y} r="120" fill="url(#sf-glow)" />
      <circle cx={x} cy={y} r="24" fill="#fff8ec" />
      <circle cx={x - 7} cy={y - 8} r="8" fill="#ffffff" opacity="0.9" />
    </g>
  );
}

function Stool({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 3} y="770" width="6" height="84" fill="#2a1916" />
      <ellipse cx={x} cy="818" rx="22" ry="5" fill="none" stroke="#2a1916" strokeWidth="4" />
      <ellipse cx={x} cy="856" rx="30" ry="6" fill="#2a1916" />
      <rect x={x - 36} y="752" width="72" height="20" rx="10" fill="#a3282c" />
      <ellipse cx={x} cy="753" rx="36" ry="8" fill="#c8413d" />
    </g>
  );
}

function Booth({ x }: { x: number }) {
  return (
    <g>
      <path d={scallopTop(x, 560, 210, 5)} fill="#a3282c" />
      <path d={scallopTop(x + 16, 580, 178, 4)} fill="#fbf1e1" />
      <g stroke="#ead7b9" strokeWidth="3">
        <line x1={x + 60} y1="616" x2={x + 60} y2="760" />
        <line x1={x + 105} y1="612" x2={x + 105} y2="760" />
        <line x1={x + 150} y1="616" x2={x + 150} y2="760" />
      </g>
      <rect x={x - 4} y="760" width="218" height="30" rx="10" fill="#c8413d" />
      <rect x={x} y="790" width="210" height="16" fill="#7a1f24" />
      <rect x={x + 10} y="806" width="10" height="50" fill="#4a2a20" />
      <rect x={x + 190} y="806" width="10" height="50" fill="#4a2a20" />
    </g>
  );
}

function Table({ cx }: { cx: number }) {
  return (
    <g>
      <rect x={cx - 6} y="728" width="12" height="122" fill="#2a1916" />
      <ellipse cx={cx} cy="854" rx="44" ry="7" fill="#2a1916" />
      <rect x={cx - 92} y="712" width="184" height="18" rx="6" fill="#7a1f24" />
      <rect x={cx - 92} y="712" width="184" height="6" rx="3" fill="#a3282c" />
    </g>
  );
}

function Cup({ x, y, c = "#fbf1e1", band = "#a3282c" }: { x: number; y: number; c?: string; band?: string }) {
  return (
    <g>
      <path d={`M${x} ${y} h26 l-3 26 h-20 Z`} fill={c} />
      <rect x={x + 1} y={y + 8} width="24" height="5" fill={band} />
      <path d={`M${x + 25} ${y + 6} q12 2 0 14`} fill="none" stroke={c} strokeWidth="4" />
    </g>
  );
}

function Plant({ x, base = 860, h = 1 }: { x: number; base?: number; h?: number }) {
  return (
    <g>
      <g fill="#5f6d3b">
        <ellipse cx={x - 26} cy={base - 150 * h} rx="34" ry="46" transform={`rotate(-24 ${x - 26} ${base - 150 * h})`} />
        <ellipse cx={x + 28} cy={base - 160 * h} rx="32" ry="48" transform={`rotate(22 ${x + 28} ${base - 160 * h})`} />
      </g>
      <g fill="#7b8a4a">
        <ellipse cx={x} cy={base - 200 * h} rx="30" ry="52" />
        <ellipse cx={x - 44} cy={base - 110 * h} rx="26" ry="38" transform={`rotate(-40 ${x - 44} ${base - 110 * h})`} />
        <ellipse cx={x + 44} cy={base - 112 * h} rx="26" ry="38" transform={`rotate(40 ${x + 44} ${base - 112 * h})`} />
      </g>
      <path d={`M${x - 42} ${base - 92} h84 l-10 92 h-64 Z`} fill="#c8642b" />
      <rect x={x - 46} y={base - 100} width="92" height="14" rx="3" fill="#a94f22" />
    </g>
  );
}

function SceneArt() {
  const display = { fontFamily: "var(--sf-display)" } as CSSProperties;
  const mono = { fontFamily: "var(--sf-mono)" } as CSSProperties;
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid slice" className="sf-scene-svg" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="sf-stripes" width="50" height="10" patternUnits="userSpaceOnUse">
          <rect width="25" height="10" fill="#a3282c" />
          <rect x="25" width="25" height="10" fill="#fbf1e1" />
        </pattern>
        <pattern id="sf-tiles" width="18" height="18" patternUnits="userSpaceOnUse">
          <rect width="18" height="18" fill="#7a1f24" />
          <rect width="2" height="18" fill="#8e2a2f" />
          <rect width="18" height="1.5" fill="#6a1a1f" />
        </pattern>
        <pattern id="sf-flute" width="22" height="10" patternUnits="userSpaceOnUse">
          <rect width="22" height="10" fill="#7a1f24" />
          <rect x="18" width="4" height="10" fill="#621519" />
          <rect x="2" width="3" height="10" fill="#93302f" />
        </pattern>
        <linearGradient id="sf-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fde9cc" />
          <stop offset="1" stopColor="#f2c48f" />
        </linearGradient>
        <linearGradient id="sf-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a1916" stopOpacity="0.18" />
          <stop offset="1" stopColor="#2a1916" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="sf-glow">
          <stop offset="0" stopColor="#ffd9a3" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffd9a3" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* wall */}
      <rect width={VB_W} height={VB_H} fill="#f4e4cb" />
      <rect y="64" width={VB_W} height="40" fill="#ead6b8" />

      {/* wainscot + trim */}
      <rect x="0" y="600" width={VB_W} height="262" fill="url(#sf-tiles)" />
      <rect x="0" y="592" width={VB_W} height="10" fill="#4a2a20" />

      {/* entrance: arched door */}
      <path d="M110 860 V430 a90 90 0 0 1 180 0 V860 Z" fill="#7a1f24" />
      <path d="M126 860 V432 a74 74 0 0 1 148 0 V860 Z" fill="url(#sf-glass)" />
      <rect x="197" y="358" width="6" height="502" fill="#7a1f24" />
      <rect x="126" y="610" width="148" height="6" fill="#7a1f24" />
      <rect x="180" y="640" width="6" height="56" rx="3" fill="#b8862f" />
      <rect x="214" y="640" width="6" height="56" rx="3" fill="#b8862f" />
      <text x="200" y="470" textAnchor="middle" fontSize="34" fontWeight="700" fill="#7a1f24" style={mono}>
        &lt;/&gt;
      </text>
      <Plant x={390} />
      {/* shelves */}
      {[300, 392].map((y) => (
        <g key={y}>
          <rect x="318" y={y} width="150" height="9" fill="#4a2a20" />
          <Cup x={328} y={y - 27} />
          <Cup x={368} y={y - 27} c="#a3282c" band="#fbf1e1" />
          <rect x="414" y={y - 44} width="26" height="44" rx="5" fill="#d9a066" opacity="0.9" />
          <rect x="414" y={y - 50} width="26" height="9" rx="3" fill="#4a2a20" />
        </g>
      ))}


      {/* counter side: shifted right so wide screens can lay the headline card over the doorway */}
      <g transform="translate(100 0)">
      {/* menu board */}
      <rect x="586" y="196" width="308" height="232" rx="8" fill="#4a2a20" />
      <rect x="598" y="208" width="284" height="208" rx="4" fill="#2a1916" />
      <text x="740" y="250" textAnchor="middle" fontSize="27" fontWeight="700" fill="#e8782b" style={display}>
        Coders&apos; Cafe
      </text>
      <line x1="640" y1="266" x2="840" y2="266" stroke="#f6e7d2" strokeOpacity="0.35" strokeDasharray="4 6" strokeWidth="2" />
      <g fill="#f6e7d2" fontSize="20" letterSpacing="2" style={mono}>
        <text x="624" y="304">GOOD FOOD.</text>
        <text x="624" y="338">GOOD COFFEE.</text>
        <text x="624" y="372" fill="#e8782b">
          GOOD CODE.
        </text>
      </g>
      <text x="856" y="400" textAnchor="end" fontSize="13" fill="#f6e7d2" fillOpacity="0.55" letterSpacing="2" style={mono}>
        BREW · MUSE · PLAY
      </text>

      </g>

      {/* arched windows (booth side) */}
      {[1170, 1400].map((x) => (
        <g key={x}>
          <path d={`M${x} 520 V290 a65 65 0 0 1 130 0 V520 Z`} fill="#7a1f24" />
          <path d={`M${x + 10} 520 V292 a55 55 0 0 1 110 0 V520 Z`} fill="url(#sf-glass)" />
          <rect x={x + 62} y="230" width="6" height="290" fill="#7a1f24" />
          <rect x={x + 10} y="380" width="110" height="5" fill="#7a1f24" />
          <rect x={x - 10} y="516" width="150" height="10" rx="2" fill="#4a2a20" />
        </g>
      ))}

      {/* pendants (cords) */}
      <Pendant x={1100} y={470} />
      <Pendant x={1240} y={440} />
      <Pendant x={1470} y={440} />

      <g transform="translate(100 0)">
      {/* counter */}
      <rect x="500" y="608" width="500" height="236" fill="url(#sf-flute)" />
      <rect x="500" y="840" width="500" height="22" fill="#2a1916" />
      <rect x="488" y="586" width="524" height="24" rx="4" fill="#fff6ea" />
      <rect x="488" y="604" width="524" height="6" fill="#d9c3a3" />
      {/* espresso machine */}
      <rect x="544" y="490" width="160" height="96" rx="12" fill="#c8642b" />
      <rect x="544" y="490" width="160" height="22" rx="10" fill="#fbf1e1" />
      <rect x="566" y="526" width="116" height="10" rx="4" fill="#a94f22" />
      <rect x="580" y="536" width="20" height="16" rx="3" fill="#2a1916" />
      <rect x="648" y="536" width="20" height="16" rx="3" fill="#2a1916" />
      <circle cx="624" cy="512" r="8" fill="#2a1916" />
      <Cup x={577} y={556} />
      <Cup x={645} y={556} />
      <g fill="none" stroke="#c9b28f" strokeWidth="3" strokeLinecap="round" opacity="0.7">
        <path d="M590 548 q-8 -14 0 -26" />
        <path d="M658 548 q8 -14 0 -26" />
      </g>
      {/* cake dome */}
      <ellipse cx="830" cy="586" rx="64" ry="8" fill="#e9d6b6" />
      <circle cx="800" cy="568" r="16" fill="#e0a052" />
      <circle cx="834" cy="566" r="18" fill="#c8642b" />
      <circle cx="866" cy="570" r="14" fill="#e0a052" />
      <path d="M772 584 V560 a58 58 0 0 1 116 0 V584" fill="#ffffff" fillOpacity="0.35" stroke="#d9c3a3" strokeWidth="3" />
      <circle cx="830" cy="500" r="6" fill="#d9c3a3" />
      {/* cup stack */}
      {[0, 1, 2].map((i) => (
        <Cup key={i} x={960} y={556 - i * 22} c={i === 1 ? "#a3282c" : "#fbf1e1"} band={i === 1 ? "#fbf1e1" : "#a3282c"} />
      ))}
      <Stool x={570} />
      <Stool x={710} />
      <Stool x={850} />
      </g>

      {/* booths + tables */}
      <Plant x={1135} h={0.9} />
      <Booth x={1180} />
      <Booth x={1380} />
      <Table cx={1285} />
      <Table cx={1490} />
      {/* laptop on the first table */}
      <path d="M1236 712 l12 -64 h88 l-12 64 Z" fill="#2a1916" />
      <text x="1292" y="688" textAnchor="middle" fontSize="18" fontWeight="700" fill="#e8782b" style={mono}>
        &lt;/&gt;
      </text>
      <rect x="1220" y="708" width="112" height="6" rx="2" fill="#4a2a20" />
      <Cup x={1342} y={686} />
      {/* coffee + pizza on the second */}
      <Cup x={1420} y={686} c="#a3282c" band="#fbf1e1" />
      <ellipse cx="1510" cy="710" rx="42" ry="6" fill="#fbf1e1" />
      <path d="M1478 706 l64 -4 l-34 -26 Z" fill="#e0a052" />
      <circle cx="1504" cy="696" r="4" fill="#a3282c" />
      <circle cx="1520" cy="701" r="3.5" fill="#a3282c" />

      {/* terrazzo floor */}
      <rect y="862" width={VB_W} height="138" fill="#f1e4ce" />
      <rect y="862" width={VB_W} height="22" fill="url(#sf-shade)" />
      <g>
        {FLECKS.map((f, i) => (
          <ellipse key={i} cx={f.x} cy={f.y} rx={f.r} ry={f.r * 0.6} fill={f.c} opacity="0.75" transform={`rotate(${f.rot} ${f.x} ${f.y})`} />
        ))}
      </g>

      {/* ceiling fan */}
      <line x1="840" y1="150" x2="840" y2="176" stroke="#4a2a20" strokeWidth="4" />
      <ellipse cx="780" cy="180" rx="62" ry="7" fill="#4a2a20" />
      <ellipse cx="900" cy="180" rx="62" ry="7" fill="#4a2a20" />
      <circle cx="840" cy="180" r="11" fill="#b8862f" />

      {/* evening light: dim the room, then light the globes over it */}
      <rect className="sf-scene-dusk" width={VB_W} height={VB_H} fill="#2b0f12" />
      <Globe x={1100} y={470} />
      <Globe x={1240} y={440} />
      <Globe x={1470} y={440} />

      {/* facade: sign band, awning, pilasters (always in daylight colours) */}
      <rect x="0" y="0" width={VB_W} height="64" fill="#7a1f24" />
      <text x="800" y="45" textAnchor="middle" fontSize="30" fontWeight="700" letterSpacing="10" fill="#fff6ea" style={display}>
        CODERS&apos; CAFE
      </text>
      <text x="80" y="40" fontSize="14" letterSpacing="3" fill="#fff6ea" fillOpacity="0.6" style={mono}>
        &lt;/&gt; BREW · MUSE · PLAY
      </text>
      <text x="1520" y="40" textAnchor="end" fontSize="14" letterSpacing="3" fill="#fff6ea" fillOpacity="0.6" style={mono}>
        GOOD CODE &lt;/&gt;
      </text>
      <rect y="150" width={VB_W} height="40" fill="url(#sf-shade)" />
      <path d={AWNING} fill="url(#sf-stripes)" />
      <rect y="64" width={VB_W} height="6" fill="#5c151a" />
      <rect x="0" y="64" width="34" height={VB_H - 64} fill="#7a1f24" />
      <rect x={VB_W - 34} y="64" width="34" height={VB_H - 64} fill="#7a1f24" />
    </svg>
  );
}

/** The illustrated café with its camera views and the evening-light switch. */
export function CafeScene() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(SCENE_VIEWS[0]);
  const [evening, setEvening] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // On wide screens the headline card sits over the left of the scene, so
  // views frame their subject in the open area to its right.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const focusX = wide ? 0.68 : 0.5;

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Where the focal point of the view lands: the SVG is drawn "slice" (cover),
  // so map viewBox units to stage pixels first, then scale about the origin
  // and clamp so the frame never shows an empty edge.
  let cam: CSSProperties | undefined;
  if (size && view.s !== 1) {
    const k = Math.max(size.w / VB_W, size.h / VB_H);
    const ox = (size.w - VB_W * k) / 2;
    const oy = (size.h - VB_H * k) / 2;
    const px = ox + view.fx * k;
    const py = oy + view.fy * k;
    const clamp = (v: number, lo: number) => Math.min(0, Math.max(lo, v));
    const tx = clamp(size.w * focusX - view.s * px, size.w * (1 - view.s));
    const ty = clamp(size.h * 0.52 - view.s * py, size.h * (1 - view.s));
    cam = { transform: `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${view.s})` };
  }

  return (
    <div className="sf-scene" data-evening={evening} ref={stageRef}>
      <div className="sf-scene-cam" style={cam}>
        <div className="sf-scene-intro">
          <div className="sf-scene-scroll">
            <SceneArt />
          </div>
        </div>
      </div>
      <span className="sf-sr">Illustration of the Coders&apos; Cafe interior: a striped awning, a menu board, the espresso counter and red booths.</span>
      <button type="button" className="sf-scene-light" aria-pressed={evening} onClick={() => setEvening((v) => !v)}>
        <span aria-hidden="true" className="sf-scene-light-dot" />
        Evening light
      </button>
      <div className="sf-scene-views" role="group" aria-label="Look around the café">
        {SCENE_VIEWS.map((v) => (
          <button key={v.id} type="button" aria-pressed={view.id === v.id} onClick={() => setView(v)}>
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}
