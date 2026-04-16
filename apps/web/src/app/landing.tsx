import Link from "next/link";
import { Button } from "@/components/ui/button";

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function portraitBrightness(nx: number, ny: number): number {
  let b = 0;

  const headCx = 0.52,
    headCy = 0.38;
  const headRx = 0.13,
    headRy = 0.15;

  // Head
  {
    const d = Math.sqrt(((nx - headCx) / headRx) ** 2 + ((ny - headCy) / headRy) ** 2);
    if (d < 1) b = Math.max(b, smoothstep(1, 0.15, d));
  }

  // Brow ridge (profile facing right)
  {
    const cx = headCx + headRx * 0.85,
      cy = headCy - 0.03;
    const rx = 0.05,
      ry = 0.03;
    const d = Math.sqrt(((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2);
    if (d < 1) b = Math.max(b, smoothstep(1, 0.3, d) * 0.9);
  }

  // Nose
  {
    const cx = headCx + headRx + 0.02,
      cy = headCy + 0.03;
    const rx = 0.035,
      ry = 0.045;
    const d = Math.sqrt(((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2);
    if (d < 1) b = Math.max(b, smoothstep(1, 0.35, d) * 0.85);
  }

  // Chin / jaw
  {
    const cx = headCx + 0.02,
      cy = headCy + headRy + 0.02;
    const rx = 0.09,
      ry = 0.04;
    const d = Math.sqrt(((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2);
    if (d < 1) b = Math.max(b, smoothstep(1, 0.4, d) * 0.7);
  }

  // Neck
  {
    const neckTop = headCy + headRy + 0.03;
    const neckBot = 0.68;
    if (ny > neckTop && ny < neckBot) {
      const t = (ny - neckTop) / (neckBot - neckTop);
      const w = 0.055 + t * 0.06;
      const cx = headCx - 0.02;
      const d = Math.abs(nx - cx) / w;
      if (d < 1) b = Math.max(b, smoothstep(1, 0.5, d) * (0.55 - t * 0.1));
    }
  }

  // Shoulders
  {
    const top = 0.66,
      bot = 0.9;
    if (ny > top && ny < bot) {
      const t = (ny - top) / (bot - top);
      const w = 0.12 + t * 0.32;
      const cx = headCx - 0.03;
      const d = Math.abs(nx - cx) / w;
      if (d < 1) b = Math.max(b, smoothstep(1, 0.6, d) * (0.3 + t * 0.4));
    }
  }

  // War bonnet feathers — radiating from back-top of head
  {
    const originX = headCx - 0.05;
    const originY = headCy - headRy * 0.65;
    const count = 13;

    for (let i = 0; i < count; i++) {
      const ft = i / (count - 1);
      const angle = -Math.PI * 0.38 - ft * Math.PI * 0.42;
      const len = 0.12 + ft * 0.16;
      const baseWidth = 0.025 - ft * 0.008;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = nx - originX;
      const dy = ny - originY;

      const along = dx * cos + dy * sin;
      const across = Math.abs(-dx * sin + dy * cos);

      if (along > 0 && along < len) {
        const taper = 1 - along / len;
        const w = baseWidth * (0.3 + taper * 0.7);
        if (across < w) {
          const crossFade = smoothstep(w, 0, across);
          b = Math.max(b, crossFade * taper * 0.92);
        }
      }
    }
  }

  // Headband
  {
    const bandY = headCy - headRy * 0.15;
    const bandH = 0.018;
    if (Math.abs(ny - bandY) < bandH) {
      const bandLeft = headCx - headRx * 0.85;
      const bandRight = headCx + headRx * 0.75;
      if (nx > bandLeft && nx < bandRight) {
        const crossFade = smoothstep(bandH, 0, Math.abs(ny - bandY));
        b = Math.max(b, crossFade * 0.88);
      }
    }
  }

  // Subtle per-cell noise
  const noise = hash(Math.floor(nx * 100), Math.floor(ny * 100));
  b = Math.max(0, Math.min(1, b * (0.85 + noise * 0.15)));

  return b;
}

const COLS = 44;
const ROWS = 56;
const CELL = 10;
const MAX_R = 4.2;
const SVG_W = COLS * CELL;
const SVG_H = ROWS * CELL;

function generateDots() {
  const dots: { cx: number; cy: number; r: number }[] = [];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const cx = (col + 0.5) * CELL;
      const cy = (row + 0.5) * CELL;
      const b = portraitBrightness(cx / SVG_W, cy / SVG_H);

      if (b > 0.05) {
        dots.push({ cx, cy, r: b * MAX_R });
      } else {
        // Sparse ambient noise outside portrait
        const ambient = hash(col, row);
        if (ambient > 0.88) {
          dots.push({ cx, cy, r: 0.6 + ambient * 0.4 });
        }
      }
    }
  }

  return dots;
}

const dots = generateDots();

function HalftonePortrait() {
  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-56 sm:w-72 md:w-80 h-auto text-foreground"
      aria-hidden="true"
    >
      {dots.map((dot, i) => (
        <circle key={i} cx={dot.cx} cy={dot.cy} r={dot.r} fill="currentColor" />
      ))}
    </svg>
  );
}

export function Landing() {
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center gap-10 p-6 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
        aria-hidden="true"
      />

      <HalftonePortrait />

      <div className="text-center">
        <h1 className="font-mono text-6xl sm:text-7xl md:text-8xl font-black tracking-[0.25em]">
          WPM
        </h1>
        <div className="mx-auto mt-4 h-px w-32 bg-foreground/20" />
        <p className="mt-4 text-xs sm:text-sm uppercase tracking-[0.2em] text-muted-foreground font-mono">
          Wampum Prediction Markets
        </p>
      </div>

      <div className="flex gap-4">
        <Button
          render={<Link href="/login" />}
          nativeButton={false}
          size="lg"
          className="uppercase tracking-wider font-mono"
        >
          Log in
        </Button>
        <Button
          variant="outline"
          render={<Link href="/register" />}
          nativeButton={false}
          size="lg"
          className="uppercase tracking-wider font-mono"
        >
          Create account
        </Button>
      </div>
    </main>
  );
}
