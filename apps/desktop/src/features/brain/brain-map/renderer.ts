import { MAP_HEX, type BrainMap, type MapNode } from './layout';

/**
 * Canvas 2D renderer for the brain map. The scene (limbs, filaments, leaves) is painted once
 * into an offscreen layer and only repainted when the view, size or replay cutoff changes;
 * each animation frame blits that layer and draws a bounded overlay on top — a handful of
 * travelling sparks, twinkles, link pulses, question rings and orbiting seeds — so the cost
 * per frame does not grow with the size of the vault.
 */

export interface View {
  k: number;
  px: number;
  py: number;
}

const TAU = Math.PI * 2;
const SPARKS = 16;
const TWINKLES = 64;
const MAX_LABELS = 36;
const BIRTH_MS = 0.06; // fraction of the replay span a newborn leaf flares for

export type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

type Spark = { node: number; start: number; dur: number };

const spriteCache = new Map<string, HTMLCanvasElement>();
/** A soft radial bloom in one colour; drawn scaled, so 1,400 glows cost 1,400 blits. */
function sprite(hex: string): HTMLCanvasElement {
  let s = spriteCache.get(hex);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 64;
  const g = s.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, hexA(hex, 1));
  grad.addColorStop(0.35, hexA(hex, 0.32));
  grad.addColorStop(0.7, hexA(hex, 0.06));
  grad.addColorStop(1, hexA(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  spriteCache.set(hex, s);
  return s;
}

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

export class BrainRenderer {
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement('canvas');
  private lctx = this.layer.getContext('2d')!;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private view: View = { k: 1, px: 0, py: 0 };
  private dirty = true;
  private cutoff = Infinity;
  private hover = -1;
  private keepOut: Rect[] = [];
  /** Search matches: when set, everything else dims. */
  private highlight: Set<number> | null = null;
  private sparks: Spark[] = [];
  private twinkles: number[] = [];
  private flares = new Map<number, number>();
  private recent: number[];
  private grid = new Map<number, number[]>();
  private seedPos: Array<{ x: number; y: number }> = [];
  private neighbours = new Map<number, Set<number>>();
  /** Source-summary pages that orbit a host are drawn as seeds, not as leaves. */
  private seedNodes: Set<number>;

  constructor(
    private canvas: HTMLCanvasElement,
    private map: BrainMap,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const n = map.timeline.length;
    this.recent = map.timeline.slice(Math.floor(n * 0.88));
    this.seedNodes = new Set(map.seeds.flatMap((s) => (s.node === null ? [] : [s.node])));
    for (const node of map.nodes.keys()) this.indexNode(node);
    for (const l of map.links) {
      if (!this.neighbours.has(l.a)) this.neighbours.set(l.a, new Set());
      if (!this.neighbours.has(l.b)) this.neighbours.set(l.b, new Set());
      this.neighbours.get(l.a)!.add(l.b);
      this.neighbours.get(l.b)!.add(l.a);
    }
    this.seedPos = map.seeds.map(() => ({ x: 0, y: 0 }));
  }

  private cellKey(x: number, y: number) {
    return (Math.floor((x + 2) / 0.03) << 12) | Math.floor((y + 2) / 0.03);
  }
  private indexNode(i: number) {
    const n = this.map.nodes[i]!;
    const key = this.cellKey(n.x, n.y);
    const list = this.grid.get(key) ?? [];
    list.push(i);
    this.grid.set(key, list);
  }

  // ---- geometry -------------------------------------------------------------------------

  /** The disc's screen radius and the horizontal stretch that lets it fill a wide hero. */
  private get R() {
    return Math.min(this.h * 0.4, this.w * 0.28) * this.view.k;
  }
  private get stretch() {
    return Math.max(1, Math.min(1.45, (this.w / this.h) * 0.82));
  }
  /** The nucleus sits right of centre: the headline and legend own the left edge. */
  get cx() {
    return this.w * (this.w > 900 ? 0.56 : 0.5);
  }
  get cy() {
    return this.h * 0.52;
  }
  sx(x: number) {
    return this.cx + this.view.px + x * this.R * this.stretch;
  }
  sy(y: number) {
    return this.cy + this.view.py + y * this.R;
  }
  private toWorld(mx: number, my: number) {
    return { x: (mx - this.cx - this.view.px) / (this.R * this.stretch), y: (my - this.cy - this.view.py) / this.R };
  }

  // ---- state ----------------------------------------------------------------------------

  resize(w: number, h: number, dpr: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = Math.min(dpr, 2);
    for (const c of [this.canvas, this.layer]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dirty = true;
  }
  setView(view: View) {
    this.view = view;
    this.dirty = true;
  }
  getView() {
    return this.view;
  }
  setCutoff(t: number) {
    if (t === this.cutoff) return;
    this.cutoff = t;
    this.dirty = true;
  }
  /** Screen rects the hero's overlays occupy; rim labels steer around them. */
  setKeepOut(rects: Rect[]) {
    this.keepOut = rects;
  }
  setHighlight(set: Set<number> | null) {
    this.highlight = set;
    this.dirty = true;
  }
  /** The view that centres a node at zoom k. */
  viewFor(i: number, k: number): View {
    const n = this.map.nodes[i]!;
    const base = this.R / this.view.k;
    return { k, px: -n.x * base * k * this.stretch + (this.w / 2 - this.cx), py: -n.y * base * k + (this.h / 2 - this.cy) };
  }
  setHover(i: number) {
    this.hover = i;
  }
  invalidate() {
    this.dirty = true;
  }

  private visible(n: MapNode) {
    return n.updatedAt <= this.cutoff;
  }
  private growth(n: MapNode) {
    if (this.cutoff === Infinity) return 1;
    const span = Math.max(1, this.map.stats.lastAt - this.map.stats.firstAt);
    return Math.max(0, Math.min(1, (this.cutoff - n.updatedAt) / (span * BIRTH_MS)));
  }

  /** The node under a screen point, or -1. Seeds are tested at their current orbit position. */
  hit(mx: number, my: number): number {
    const w = this.toWorld(mx, my);
    const tol = 9 / this.R;
    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor((w.x + 2) / 0.03);
    const cy = Math.floor((w.y + 2) / 0.03);
    const reach = Math.max(1, Math.ceil(tol / 0.03));
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        for (const i of this.grid.get((gx << 12) | gy) ?? []) {
          const n = this.map.nodes[i]!;
          if (!this.visible(n) || this.seedNodes.has(i)) continue;
          const d = Math.hypot((n.x - w.x) * this.stretch, n.y - w.y);
          if (d < Math.max(tol, n.r * 2) && d < bestD) {
            best = i;
            bestD = d;
          }
        }
      }
    }
    this.map.seeds.forEach((s, k) => {
      if (s.node === null) return;
      const p = this.seedPos[k]!;
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < 8 && d < bestD * this.R) {
        best = s.node;
        bestD = d / this.R;
      }
    });
    return best;
  }

  /** Screen position of a node, for the tooltip. */
  screenOf(i: number) {
    const n = this.map.nodes[i]!;
    const seed = this.map.seeds.findIndex((s) => s.node === i);
    if (seed >= 0) return this.seedPos[seed]!;
    return { x: this.sx(n.x), y: this.sy(n.y) };
  }

  // ---- the static layer -----------------------------------------------------------------

  private paintLayer() {
    const g = this.lctx;
    const { map } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    const zoomW = Math.sqrt(this.view.k);
    const ox = this.sx(0);
    const oy = this.sy(0);

    // A faint nebula behind the nucleus.
    const neb = g.createRadialGradient(ox, oy, 0, ox, oy, this.R * 0.9);
    neb.addColorStop(0, 'rgba(120,150,255,0.10)');
    neb.addColorStop(0.5, 'rgba(80,200,200,0.035)');
    neb.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = neb;
    g.fillRect(0, 0, this.w, this.h);

    const branchVisible = map.branches.map((b) => b.firstAt <= this.cutoff);
    const quad = (x0: number, y0: number, cxw: number, cyw: number, x1: number, y1: number) => {
      g.moveTo(this.sx(x0), this.sy(y0));
      g.quadraticCurveTo(this.sx(cxw), this.sy(cyw), this.sx(x1), this.sy(y1));
    };

    // Leaf filaments, one path per subject: hub → leaf, bowed along the branch so each
    // course fans out like a brush.
    map.subjects.forEach((s, si) => {
      g.beginPath();
      for (const n of map.nodes) {
        if (n.subject !== si || !this.visible(n)) continue;
        const b = map.branches[n.branch]!;
        const lr = Math.hypot(n.x, n.y);
        const cr = (Math.hypot(b.x, b.y) + lr) * 0.5;
        quad(b.x, b.y, Math.cos(b.angle) * cr, Math.sin(b.angle) * cr, n.x, n.y);
      }
      g.strokeStyle = hexA(s.hex, this.highlight ? 0.05 : 0.13);
      g.lineWidth = 0.7 * zoomW;
      g.stroke();
    });

    // Limbs: nucleus → subject → course, each drawn wide-and-faint then thin-and-bright.
    const limb = (width: number, alpha: number, hex: string, draw: () => void) => {
      g.beginPath();
      draw();
      g.strokeStyle = hexA(hex, alpha * 0.25);
      g.lineWidth = width * 3.2;
      g.stroke();
      g.strokeStyle = hexA(hex, alpha);
      g.lineWidth = width;
      g.stroke();
    };
    map.branches.forEach((b, bi) => {
      if (!branchVisible[bi]) return;
      const s = map.subjects[b.subject]!;
      const w = (0.6 + Math.sqrt(b.count) * 0.16) * zoomW;
      limb(w, this.highlight ? 0.2 : 0.42, s.hex, () => {
        const r = 0.26;
        quad(s.x, s.y, Math.cos(b.angle) * r * 0.9 + s.x * 0.25, Math.sin(b.angle) * r * 0.9 + s.y * 0.25, b.x, b.y);
      });
    });
    map.subjects.forEach((s) => {
      if (s.firstAt > this.cutoff) return;
      const w = (1.2 + Math.sqrt(s.count) * 0.09) * zoomW;
      limb(w, 0.55, s.hex, () => quad(0, 0, Math.cos(s.angle - 0.25) * 0.08, Math.sin(s.angle - 0.25) * 0.08, s.x, s.y));
    });

    // Branch hubs: small knots where a course fans out.
    map.branches.forEach((b, bi) => {
      if (!branchVisible[bi]) return;
      const s = map.subjects[b.subject]!;
      const size = (10 + Math.sqrt(b.count) * 1.6) * zoomW;
      g.drawImage(sprite(s.hex), this.sx(b.x) - size / 2, this.sy(b.y) - size / 2, size, size);
    });
    map.subjects.forEach((s) => {
      if (s.firstAt > this.cutoff) return;
      const size = 26 * zoomW;
      g.drawImage(sprite(s.hex), this.sx(s.x) - size / 2, this.sy(s.y) - size / 2, size, size);
    });

    // Leaves: a bloom and a crisp core.
    const pxR = this.R;
    for (let i = 0; i < map.nodes.length; i++) {
      const n = map.nodes[i]!;
      if (!this.visible(n) || this.seedNodes.has(i)) continue;
      const grow = easeOut(this.growth(n));
      const x = this.sx(n.x);
      const y = this.sy(n.y);
      if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
      const rad = Math.max(1.1, n.r * pxR) * (0.4 + 0.6 * grow);
      const lit = !this.highlight || this.highlight.has(i);
      const bloom = rad * (n.status === 'solid' ? 7 : n.status === 'shaky' ? 9 : 6.5) * (this.highlight && lit ? 1.6 : 1);
      g.globalAlpha = !lit ? 0.06 : n.status === 'met' ? 0.75 : 0.9;
      g.drawImage(sprite(n.hex), x - bloom / 2, y - bloom / 2, bloom, bloom);
      g.globalAlpha = 1;
      if (n.kind === 'question') continue; // drawn as a ring in the overlay
      g.fillStyle = hexA(n.hex, lit ? 0.95 : 0.16);
      g.beginPath();
      g.arc(x, y, rad * (lit && this.highlight ? 0.75 : 0.55), 0, TAU);
      g.fill();
      if (n.peer) {
        g.strokeStyle = hexA(MAP_HEX.peer, 0.8);
        g.lineWidth = 1;
        g.beginPath();
        g.arc(x, y, rad * 1.3, 0, TAU);
        g.stroke();
      }
    }
    g.globalCompositeOperation = 'source-over';
    this.dirty = false;
  }

  // ---- the animated overlay -------------------------------------------------------------

  private bezier(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number) {
    const u = 1 - t;
    return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 };
  }

  /** A spark's world position: nucleus → subject → course hub → leaf, three quadratic hops. */
  private sparkAt(i: number, t: number) {
    const n = this.map.nodes[i]!;
    if (n.branch < 0) return this.bezier(0, 0, n.x * 0.3 + n.y * 0.2, n.y * 0.3 - n.x * 0.2, n.x, n.y, t);
    const b = this.map.branches[n.branch]!;
    const s = this.map.subjects[b.subject]!;
    if (t < 0.28) {
      const u = t / 0.28;
      return this.bezier(0, 0, Math.cos(s.angle - 0.25) * 0.08, Math.sin(s.angle - 0.25) * 0.08, s.x, s.y, u);
    }
    if (t < 0.6) {
      const u = (t - 0.28) / 0.32;
      const r = 0.26;
      return this.bezier(s.x, s.y, Math.cos(b.angle) * r * 0.9 + s.x * 0.25, Math.sin(b.angle) * r * 0.9 + s.y * 0.25, b.x, b.y, u);
    }
    const u = (t - 0.6) / 0.4;
    const cr = (Math.hypot(b.x, b.y) + Math.hypot(n.x, n.y)) * 0.5;
    return this.bezier(b.x, b.y, Math.cos(b.angle) * cr, Math.sin(b.angle) * cr, n.x, n.y, u);
  }

  private pickSparkTarget(): number {
    if (this.highlight && this.highlight.size) {
      const list = [...this.highlight];
      return list[Math.floor(Math.random() * list.length)]!;
    }
    const pool = Math.random() < 0.6 && this.recent.length ? this.recent : this.map.timeline;
    for (let tries = 0; tries < 6; tries++) {
      const i = pool[Math.floor(Math.random() * pool.length)]!;
      if (this.visible(this.map.nodes[i]!) && !this.seedNodes.has(i)) return i;
    }
    return -1;
  }

  /** Draw one frame. `now` in ms; `animate` false draws the still picture (reduced motion). */
  frame(now: number, animate: boolean) {
    if (this.dirty) this.paintLayer();
    const g = this.ctx;
    const { map } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.layer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = 'lighter';
    const t = animate ? now : 0;
    const zoomW = Math.sqrt(this.view.k);
    const hoverSet = this.hover >= 0 ? (this.neighbours.get(this.hover) ?? new Set<number>()) : null;

    // The nucleus breathes.
    {
      const pulse = animate ? 0.85 + 0.15 * Math.sin(t / 1400) : 1;
      const size = 70 * zoomW * pulse;
      g.globalAlpha = 0.9;
      g.drawImage(sprite(MAP_HEX.nucleus), this.sx(0) - size / 2, this.sy(0) - size / 2, size, size);
      g.globalAlpha = 1;
    }

    // Links the student (or a peer) made: chords bowed toward the nucleus, like bundled nerves.
    g.lineCap = 'round';
    for (let li = 0; li < map.links.length && li < 800; li++) {
      const l = map.links[li]!;
      const a = map.nodes[l.a]!;
      const b = map.nodes[l.b]!;
      if (!this.visible(a) || !this.visible(b)) continue;
      const hex = l.origin === 'student' ? MAP_HEX.student : l.origin === 'peer' ? MAP_HEX.peer : MAP_HEX.suggested;
      const lit = this.hover >= 0 && (l.a === this.hover || l.b === this.hover);
      const dim = (this.hover >= 0 && !lit) || (this.highlight !== null && !this.highlight.has(l.a) && !this.highlight.has(l.b));
      const cx = (a.x + b.x) * 0.28;
      const cy = (a.y + b.y) * 0.28;
      const path = () => {
        g.beginPath();
        g.moveTo(this.sx(a.x), this.sy(a.y));
        g.quadraticCurveTo(this.sx(cx), this.sy(cy), this.sx(b.x), this.sy(b.y));
      };
      if (l.origin === 'suggested') {
        path();
        g.setLineDash([3, 5]);
        g.lineDashOffset = -t / 60;
        g.strokeStyle = hexA(hex, dim ? 0.12 : lit ? 0.8 : 0.35);
        g.lineWidth = 1;
        g.stroke();
        g.setLineDash([]);
        continue;
      }
      path();
      g.strokeStyle = hexA(hex, dim ? 0.04 : lit ? 0.35 : 0.14);
      g.lineWidth = 5 * zoomW;
      g.stroke();
      g.strokeStyle = hexA(hex, dim ? (this.highlight ? 0.12 : 0.25) : lit ? 1 : 0.7);
      g.lineWidth = (lit ? 1.8 : 1.1) * zoomW;
      g.stroke();
      if (animate) {
        // A pulse travels along each link, staggered so they never march in step.
        const u = ((t / 2600 + li * 0.37) % 1 + 1) % 1;
        const p = this.bezier(a.x, a.y, cx, cy, b.x, b.y, u);
        const size = 16 * zoomW * Math.sin(u * Math.PI);
        g.drawImage(sprite(hex), this.sx(p.x) - size / 2, this.sy(p.y) - size / 2, size, size);
      }
    }

    if (animate) {
      // Sparks: growth travelling outward from the nucleus, mostly to what grew recently.
      while (this.sparks.length < SPARKS) {
        const node = this.pickSparkTarget();
        if (node < 0) break;
        this.sparks.push({ node, start: t + Math.random() * 2400, dur: 2200 + Math.random() * 1600 });
      }
      this.sparks = this.sparks.filter((s) => {
        const u = (t - s.start) / s.dur;
        if (u < 0) return true;
        if (u >= 1) {
          this.flares.set(s.node, t);
          return false;
        }
        const n = map.nodes[s.node]!;
        const hex = n.branch >= 0 ? map.subjects[map.branches[n.branch]!.subject]!.hex : MAP_HEX.nucleus;
        for (let k = 0; k < 4; k++) {
          const uu = Math.max(0, u - k * 0.018);
          const p = this.sparkAt(s.node, easeOut(uu) * 0.15 + uu * 0.85);
          const size = (11 - k * 2.2) * zoomW;
          g.globalAlpha = 1 - k * 0.22;
          g.drawImage(sprite(k === 0 ? '#e8f0ff' : hex), this.sx(p.x) - size / 2, this.sy(p.y) - size / 2, size, size);
        }
        g.globalAlpha = 1;
        return true;
      });
      // A spark's arrival makes its leaf flare.
      for (const [i, at] of this.flares) {
        const u = (t - at) / 900;
        if (u >= 1) {
          this.flares.delete(i);
          continue;
        }
        const n = map.nodes[i]!;
        const size = (14 + 26 * u) * zoomW;
        g.globalAlpha = (1 - u) * 0.9;
        g.drawImage(sprite(n.hex), this.sx(n.x) - size / 2, this.sy(n.y) - size / 2, size, size);
      }
      g.globalAlpha = 1;

      // Twinkles: a slowly rotating handful of leaves brighten and fade.
      if (this.twinkles.length < TWINKLES || Math.random() < 0.04) {
        if (this.twinkles.length >= TWINKLES) this.twinkles.shift();
        const i = this.pickSparkTarget();
        if (i >= 0) this.twinkles.push(i);
      }
      this.twinkles.forEach((i, k) => {
        const n = map.nodes[i]!;
        const a = Math.max(0, Math.sin(t / 900 + k * 1.7));
        if (a < 0.05) return;
        const size = Math.max(6, n.r * this.R * 9) * a;
        g.globalAlpha = a * 0.5;
        g.drawImage(sprite(n.hex), this.sx(n.x) - size / 2, this.sy(n.y) - size / 2, size, size);
      });
      g.globalAlpha = 1;

      // Replay births: leaves that just appeared flare once.
      if (this.cutoff !== Infinity) {
        const span = Math.max(1, map.stats.lastAt - map.stats.firstAt);
        for (const i of map.timeline) {
          const n = map.nodes[i]!;
          if (n.updatedAt > this.cutoff) break;
          const age = (this.cutoff - n.updatedAt) / (span * BIRTH_MS);
          if (age >= 1) continue;
          const size = (8 + 20 * (1 - age)) * zoomW;
          g.globalAlpha = (1 - age) * 0.8;
          g.drawImage(sprite(n.hex), this.sx(n.x) - size / 2, this.sy(n.y) - size / 2, size, size);
        }
        g.globalAlpha = 1;
      }
    }

    // Search matches: a quiet ring on each (capped), so they read even at the rim.
    g.globalCompositeOperation = 'source-over';
    if (this.highlight) {
      let drawn = 0;
      g.lineWidth = 1;
      for (const i of this.highlight) {
        if (drawn++ >= 400) break;
        const n = map.nodes[i]!;
        if (!this.visible(n)) continue;
        const pulse = animate ? 1 + 0.25 * Math.sin(t / 500 + i) : 1;
        g.strokeStyle = 'rgba(235,242,255,0.7)';
        g.beginPath();
        g.arc(this.sx(n.x), this.sy(n.y), Math.max(5, n.r * this.R * 1.5) * pulse, 0, TAU);
        g.stroke();
      }
    }

    // Open questions: hollow rings that keep asking.
    for (const n of map.nodes) {
      if (n.kind !== 'question' || !this.visible(n)) continue;
      const x = this.sx(n.x);
      const y = this.sy(n.y);
      const base = Math.max(3.5, n.r * this.R * 0.9);
      g.strokeStyle = hexA(MAP_HEX.question, 0.95);
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(x, y, base, 0, TAU);
      g.stroke();
      if (animate) {
        for (const off of [0, 0.5]) {
          const u = (t / 2400 + off) % 1;
          g.strokeStyle = hexA(MAP_HEX.question, (1 - u) * 0.7);
          g.lineWidth = 1.2;
          g.beginPath();
          g.arc(x, y, base * (1 + u * 2.6), 0, TAU);
          g.stroke();
        }
      }
    }

    // Seeds: kept sources orbiting the pages they fed.
    g.globalCompositeOperation = 'lighter';
    map.seeds.forEach((s, k) => {
      const host = map.nodes[s.host]!;
      if (!this.visible(host)) return;
      const ang = s.phase + (animate ? t * 0.0005 : 0);
      const x = this.sx(host.x) + Math.cos(ang) * s.orbit * this.R * this.stretch * 0.75;
      const y = this.sy(host.y) + Math.sin(ang) * s.orbit * this.R;
      this.seedPos[k] = { x, y };
      const size = 9 * zoomW;
      g.drawImage(sprite(MAP_HEX.source), x - size / 2, y - size / 2, size, size);
      g.fillStyle = hexA(MAP_HEX.source, 0.95);
      g.beginPath();
      g.arc(x, y, 1.4 * zoomW, 0, TAU);
      g.fill();
    });

    // Hover: the leaf, its neighbours, and the path back to the nucleus light up.
    if (this.hover >= 0) {
      const n = map.nodes[this.hover]!;
      const p = this.screenOf(this.hover);
      if (n.branch >= 0) {
        g.beginPath();
        for (let k = 0; k <= 40; k++) {
          const q = this.sparkAt(this.hover, k / 40);
          if (k === 0) g.moveTo(this.sx(q.x), this.sy(q.y));
          else g.lineTo(this.sx(q.x), this.sy(q.y));
        }
        g.strokeStyle = hexA(map.subjects[map.branches[n.branch]!.subject]!.hex, 0.75);
        g.lineWidth = 1.4;
        g.stroke();
      }
      const size = 46 * zoomW;
      g.drawImage(sprite(n.hex), p.x - size / 2, p.y - size / 2, size, size);
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = 'rgba(235,242,255,0.9)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(p.x, p.y, Math.max(6, n.r * this.R * 1.6), 0, TAU);
      g.stroke();
      for (const j of hoverSet ?? []) {
        const m = map.nodes[j]!;
        g.beginPath();
        g.arc(this.sx(m.x), this.sy(m.y), Math.max(4, m.r * this.R * 1.3), 0, TAU);
        g.stroke();
      }
    }

    g.globalCompositeOperation = 'source-over';
    this.drawLabels();
  }

  private drawLabels() {
    const g = this.ctx;
    const { map } = this;
    g.textBaseline = 'middle';
    // Subjects at the rim, in the display serif.
    const subjectFont = `italic ${Math.round(17 + 2 * Math.min(2, this.view.k - 1))}px "Instrument Serif", Georgia, serif`;
    const placedSubjects: Rect[] = [];
    map.subjects.forEach((s) => {
      if (s.firstAt > this.cutoff) return;
      g.font = subjectFont;
      const tw = Math.max(g.measureText(s.name).width, 60);
      // Slide the label along the rim until it clears the hero's own chrome and the other labels.
      let spot: { x: number; y: number; align: CanvasTextAlign; rect: Rect } | null = null;
      for (let step = 0; step < 24 && !spot; step++) {
        const off = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.06;
        const ang = s.angle + off;
        const x = this.sx(Math.cos(ang) * 1.1);
        const y = this.sy(Math.sin(ang) * 1.1);
        const align: CanvasTextAlign = Math.abs(Math.cos(ang)) < 0.3 ? 'center' : Math.cos(ang) > 0 ? 'left' : 'right';
        const left = align === 'center' ? x - tw / 2 : align === 'left' ? x : x - tw;
        const rect = { x: left - 6, y: y - 14, w: tw + 12, h: 36 };
        if ([...this.keepOut, ...placedSubjects].some((k) => overlaps(k, rect))) continue;
        spot = { x, y, align, rect };
      }
      if (!spot) return;
      placedSubjects.push(spot.rect);
      g.textAlign = spot.align;
      g.fillStyle = 'rgba(214,224,245,0.82)';
      g.fillText(s.name, spot.x, spot.y);
      g.font = `500 10px "Inter Variable", system-ui, sans-serif`;
      g.fillStyle = 'rgba(150,165,200,0.7)';
      g.fillText(`${s.count.toLocaleString('en')} pages`, spot.x, spot.y + 16);
    });

    // Course names once you lean in; page names once you are close. Every label steers clear
    // of the hero's chrome and of the labels already placed.
    const taken: Rect[] = [...this.keepOut, ...placedSubjects];
    const free = (r: Rect) => r.x >= 4 && r.y >= 4 && r.x + r.w <= this.w - 4 && r.y + r.h <= this.h - 4 && !taken.some((k) => overlaps(k, r));
    if (this.view.k >= 1.7) {
      g.font = `600 9.5px "Inter Variable", system-ui, sans-serif`;
      g.textAlign = 'center';
      for (const b of map.branches) {
        if (b.firstAt > this.cutoff) continue;
        const text = b.name.toUpperCase();
        const w = g.measureText(text).width;
        const x = this.sx(b.x);
        const y = this.sy(b.y) - 10;
        const rect = { x: x - w / 2 - 3, y: y - 7, w: w + 6, h: 14 };
        if (!free(rect)) continue;
        taken.push(rect);
        g.fillStyle = 'rgba(190,205,235,0.85)';
        g.fillText(text, x, y);
      }
    }
    if (this.view.k >= 2.6) {
      const cx = this.w / 2;
      const cy = this.h / 2;
      const candidates: Array<{ i: number; d: number; x: number; y: number }> = [];
      map.nodes.forEach((n, i) => {
        if (!this.visible(n) || this.seedNodes.has(i)) return;
        // While searching, only matches (and the hovered leaf) earn a name.
        if (this.highlight && !this.highlight.has(i) && i !== this.hover) return;
        const x = this.sx(n.x);
        const y = this.sy(n.y);
        if (x < 20 || x > this.w - 20 || y < 20 || y > this.h - 20) return;
        candidates.push({ i, d: i === this.hover ? -1 : Math.hypot(x - cx, y - cy), x, y });
      });
      candidates.sort((a, b) => a.d - b.d);
      g.textAlign = 'left';
      let placed = 0;
      for (const c of candidates) {
        if (placed >= MAX_LABELS) break;
        const strong = this.highlight !== null;
        g.font = `${strong ? 500 : 400} ${strong ? 12 : 11}px "Inter Variable", system-ui, sans-serif`;
        const label = map.nodes[c.i]!.title;
        const text = label.length > 28 ? `${label.slice(0, 27)}…` : label;
        const w = g.measureText(text).width;
        const lx = c.x + 8;
        const rect = { x: lx - 3, y: c.y - 8, w: w + 6, h: 16 };
        if (!free(rect)) continue;
        taken.push(rect);
        placed++;
        g.fillStyle = 'rgba(8,10,22,0.66)';
        g.fillRect(rect.x, rect.y, rect.w, rect.h);
        g.fillStyle = strong ? 'rgba(245,248,255,1)' : 'rgba(225,232,248,0.92)';
        g.fillText(text, lx, c.y);
      }
    }
  }
}
