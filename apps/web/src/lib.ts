// Pure rekenfuncties van de UI (geen DOM): indelingen, zoomniveaus en kleuren. Apart zodat ze te testen zijn.
export const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};
export const hash = (str: string) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};
export const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
export const rgba = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
export const mix = (hex: string, to: string, t: number) => {
  const a = rgb(hex), b = rgb(to);
  return "#" + a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, "0")).join("");
};
const PALETTE = ["#7aa2ff", "#5ee0b0", "#c792ff", "#ffd166", "#ff8fa3", "#7ad7ff", "#9fe870", "#ffa86b"];
/** Vaste kleur per id/naam, zodat dezelfde groep steeds dezelfde kleur houdt. */
export const colorOf = (key: string) => PALETTE[hash(key) % PALETTE.length]!;
export const LINK_COLORS: Record<string, string> = { relates_to: "#7aa2ff", supersedes: "#ffd166", contradicts: "#ff8fa3", source_of: "#c792ff", mentions: "#9aa0c3" };
export const linkColor = (t: string) => LINK_COLORS[t] ?? "#9aa0c3";
export const nl = (n: number) => n.toLocaleString("nl-NL");

export type Cam = { cx: number; cy: number; pitch: number; yaw: number; f: number; scale: number };
export type Pt = { x: number; y: number; k: number; z: number };
/** Perspectiefprojectie van (x, y, z) naar het scherm; `ratio` is de afplatting van cirkels op de grond. */
export function camera(c: Cam) {
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), cw = Math.cos(c.yaw), sw = Math.sin(c.yaw);
  const p = (x: number, y: number, z: number): Pt => {
    const x1 = x * cw + z * sw, z1 = -x * sw + z * cw, y2 = y * cp + z1 * sp, z2 = -y * sp + z1 * cp, k = c.f / Math.max(c.f * 0.15, c.f + z2);
    return { x: c.cx + x1 * k * c.scale, y: c.cy - y2 * k * c.scale, k: k * c.scale, z: z2 };
  };
  p.ratio = Math.max(0.08, Math.abs(sp));
  p.f = c.f;
  p.yaw = c.yaw;
  return p;
}

export type XZ = [number, number];
export type Layout = "banen" | "raster" | "grootte";
/**
 * Verdeelt n groepen (al gesorteerd van groot naar klein) over meerdere banen om Claude: de binnenste baan houdt
 * de grootste groepen, buitenste banen worden alleen zichtbaar als je uitzoomt.
 */
export function groupPositions(n: number, layout: Layout, base = 560, step = 300, first = 5): { pos: XZ[]; rings: number[] } {
  const pos: XZ[] = [], rings: number[] = [];
  if (layout === "raster") {
    const cols = Math.ceil(Math.sqrt(n * 1.3));
    for (let i = 0; i < n; i++) pos.push([((i % cols) - (cols - 1) / 2) * 400, (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * 340]);
    return { pos, rings };
  }
  if (layout === "grootte") {
    for (let i = 0; i < n; i++) {
      const a = i * 2.4, d = 360 + Math.sqrt(i) * 250;
      pos.push([Math.cos(a) * d, Math.sin(a) * d]);
    }
    return { pos, rings };
  }
  let left = n, k = 0;
  while (left > 0) {
    const cap = Math.min(left, first + k * 4), R = base + k * step;
    for (let j = 0; j < cap; j++) {
      const a = (j / cap) * Math.PI * 2 + k * 0.6;
      pos.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    rings.push(R);
    left -= cap;
    k++;
  }
  return { pos, rings };
}
/** Straal van een melkweg op het scherm-ruimte: logaritmisch in het aantal items, zodat 300k de rest niet verplettert. */
export const galaxyRadius = (count: number) => 85 + Math.min(150, Math.log10(count + 1) * 38);

export const MAX_RINGS = 8;
/** Max 8 banen per soort (grootste eerst); de rest wordt één baan "overig". */
export function kindRings(types: { type: string; count: number }[]): { kind: string; count: number; types: string[] }[] {
  const sorted = [...types].sort((a, b) => b.count - a.count);
  if (sorted.length <= MAX_RINGS) return sorted.map((t) => ({ kind: t.type, count: t.count, types: [t.type] }));
  const head = sorted.slice(0, MAX_RINGS - 1), rest = sorted.slice(MAX_RINGS - 1);
  return [...head.map((t) => ({ kind: t.type, count: t.count, types: [t.type] })), { kind: "overig", count: rest.reduce((a, t) => a + t.count, 0), types: rest.map((t) => t.type) }];
}
export const ringRadius = (i: number) => 130 + i * 62;
/** Vaste hoogte (y) per id binnen ±span/2: het heelal is een volume, geen plat vlak. Zelfde id, zelfde hoogte. */
export const lift = (id: string, span: number) => ((hash(id + "~y") % 1000) / 1000 - 0.5) * span;
/** Hoe dik de schijf van items is: dunner dichtbij Claude, dikker in de buitenste banen. */
export const itemLift = (id: string, ring: number, soort: boolean) => lift(id, soort ? 16 + ringRadius(ring) * 0.16 : 120);

export type ILayout = "soort" | "tijd" | "vrij";
/** Plek van het i-de item (nieuwste eerst) binnen zijn baan `ring` van `ringCount`. */
export function itemPos(layout: ILayout, id: string, ring: number, idxInRing: number, rankOverall: number): XZ {
  if (layout === "tijd") {
    const a = rankOverall * 2.4, R = 90 + Math.sqrt(rankOverall) * 34;
    return [Math.cos(a) * R, Math.sin(a) * R];
  }
  if (layout === "vrij") {
    const r = rng(hash(id)), a = r() * Math.PI * 2, d = 90 + Math.sqrt(r()) * 460;
    return [Math.cos(a) * d, Math.sin(a) * d];
  }
  const a = idxInRing * 2.399963 + ring * 0.9, R = ringRadius(ring);
  return [Math.cos(a) * R, Math.sin(a) * R];
}

/** Hoeveel losse items een baan toont: weinig als alles samenvalt, meer naarmate je inzoomt (zoom 1 = beginstand). */
export function visibleCount(total: number, zoom: number): number {
  if (total <= 40) return total;
  return Math.min(total, Math.round(40 * Math.max(1, zoom) ** 2));
}
/** Hoeveel titels er mogen staan: alleen de belangrijkste, en meer pas bij inzoomen. */
export const titleBudget = (zoom: number) => (zoom < 1.4 ? 8 : Math.min(30, 8 + Math.floor((zoom - 1.4) * 14)));
/** Hoeveel groepen als echt stelsel getekend worden (rest = stofwolk). */
export const galaxyBudget = (total: number, zoom: number) => Math.min(total, Math.round(24 * Math.max(1, zoom) ** 1.6));
