// Tekenhulpjes voor het heelal (canvas 2D). Rustig: weinig gloed, geen pulsen of schijneffecten.
import { type Pt, camera, mix, rgba, rng } from "./lib";

type P = ReturnType<typeof camera>;
export const style = { calm: 0.35, orbOn: true, orbA: 1, linkOn: true, linkA: 1 };
export const FONT = '"Fira Sans","Segoe UI",system-ui,sans-serif';
const SUN = "#ffb35c";
const TAU = Math.PI * 2;

export function glow(c: CanvasRenderingContext2D, x: number, y: number, r: number, hex: string, a = 0.5, sy = 1) {
  c.save();
  c.globalCompositeOperation = "lighter";
  c.translate(x, y);
  c.scale(1, sy);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, rgba(hex, a * style.calm));
  g.addColorStop(1, rgba(hex, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, r, 0, TAU);
  c.fill();
  c.restore();
}
export function sphere(c: CanvasRenderingContext2D, x: number, y: number, r: number, hex: string, halo = false) {
  if (halo) glow(c, x, y, r * 3, hex, 0.38);
  const g = c.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.08, x, y, r);
  g.addColorStop(0, mix(hex, "#ffffff", 0.7));
  g.addColorStop(0.35, mix(hex, "#ffffff", 0.1));
  g.addColorStop(0.8, mix(hex, "#000000", 0.45));
  g.addColorStop(1, mix(hex, "#000000", 0.75));
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
}
export function orbit(c: CanvasRenderingContext2D, P: P, x: number, y: number, z: number, R: number, hex: string, a = 0.2, dash?: number[]) {
  if (!style.orbOn) return;
  a *= style.orbA;
  const N = Math.max(48, Math.min(160, Math.round(R * P(x, y, z).k * 0.5)));
  c.lineWidth = 1;
  if (dash) c.setLineDash(dash);
  let prev: Pt | null = null;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TAU, q = P(x + Math.cos(t) * R, y, z + Math.sin(t) * R);
    if (prev && q.z > -P.f * 0.8 && prev.z > -P.f * 0.8) {
      c.strokeStyle = rgba(hex, a * Math.max(0.25, Math.min(1.2, q.k / 0.9)));
      c.beginPath();
      c.moveTo(prev.x, prev.y);
      c.lineTo(q.x, q.y);
      c.stroke();
    }
    prev = q;
  }
  c.setLineDash([]);
}
/** Dunne stippellijn van een zwevend object recht omlaag naar het vlak van de banen, zodat je de hoogte ziet. */
export function stalk(c: CanvasRenderingContext2D, P: P, x: number, y: number, z: number, hex: string) {
  if (Math.abs(y) < 12) return;
  const a = P(x, y, z), b = P(x, 0, z);
  c.save();
  c.setLineDash([2, 4]);
  c.lineWidth = 1;
  c.strokeStyle = rgba(hex, 0.3);
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = rgba(hex, 0.45);
  c.beginPath();
  c.ellipse(b.x, b.y, 2.4, 2.4 * P.ratio, 0, 0, TAU);
  c.fill();
  c.restore();
}
export function pill(c: CanvasRenderingContext2D, text: string, x: number, y: number, o: { hex?: string; sub?: string; s?: number; w?: number; color?: string } = {}) {
  const s = o.s ?? 13;
  c.font = `${o.w ?? 500} ${s}px ${FONT}`;
  const tw = Math.max(c.measureText(text).width, o.sub ? (c.font = `400 ${s - 1}px ${FONT}`, c.measureText(o.sub).width) : 0), w = tw + 22, h = o.sub ? s * 2.9 : s * 2;
  c.fillStyle = "rgba(6,8,22,.84)";
  c.strokeStyle = rgba(o.hex ?? "#9aa0c3", 0.7);
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(x - w / 2, y - h / 2, w, h, h / 2.4);
  c.fill();
  c.stroke();
  c.textAlign = "center";
  c.fillStyle = o.color ?? "#e6e8f5";
  c.font = `${o.w ?? 600} ${s}px ${FONT}`;
  c.fillText(text, x, o.sub ? y - 1 : y + s * 0.36);
  if (o.sub) {
    c.fillStyle = "#9aa0c3";
    c.font = `400 ${s - 1}px ${FONT}`;
    c.fillText(o.sub, x, y + s * 1.05);
  }
}
export function tag(c: CanvasRenderingContext2D, text: string, x: number, y: number, hex = "#cfd3ee") {
  c.font = `400 12px ${FONT}`;
  c.textAlign = "center";
  c.shadowColor = "#000";
  c.shadowBlur = 7;
  c.fillStyle = hex;
  c.fillText(text.length > 34 ? text.slice(0, 33) + "…" : text, x, y);
  c.shadowBlur = 0;
}
/** Gebundelde link als boog tussen twee punten; geeft het midden terug (voor het aantal-label). */
export function arc3(c: CanvasRenderingContext2D, P: P, a: [number, number, number], b: [number, number, number], hex: string, o: { lift?: number; w?: number; a?: number } = {}) {
  const lift = o.lift ?? 90, N = 32, pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, s = Math.sin(Math.PI * t);
    pts.push(P(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + s * lift, a[2] + (b[2] - a[2]) * t));
  }
  if (style.linkOn) {
    c.lineCap = "round";
    c.strokeStyle = rgba(hex, Math.min(1, (o.a ?? 0.6) * style.linkA));
    c.lineWidth = o.w ?? 1.5;
    c.beginPath();
    pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    c.stroke();
  }
  return pts[N >> 1]!;
}
export function sun(c: CanvasRenderingContext2D, x: number, y: number, s = 1) {
  const R = 20 * s;
  glow(c, x, y, 110 * s, SUN, 0.4);
  c.save();
  c.strokeStyle = rgba(SUN, 0.28);
  c.lineWidth = 1;
  for (const rr of [R * 1.55, R * 2.2]) { c.beginPath(); c.arc(x, y, rr, 0, TAU); c.stroke(); }
  c.restore();
  const g = c.createRadialGradient(x - R * 0.35, y - R * 0.4, R * 0.05, x, y, R);
  g.addColorStop(0, "#fffbe8"); g.addColorStop(0.35, "#ffd88f"); g.addColorStop(0.75, "#f0953a"); g.addColorStop(1, "#a9501a");
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, R, 0, TAU);
  c.fill();
  c.save();
  c.beginPath();
  c.arc(x, y, R, 0, TAU);
  c.clip();
  const r = rng(5);
  for (let i = 0; i < 70; i++) {
    const a = r() * TAU, d = Math.sqrt(r()) * R;
    c.fillStyle = r() > 0.5 ? "rgba(255,244,214,.14)" : "rgba(150,70,20,.16)";
    c.beginPath(); c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, (0.8 + r() * 2.2) * s, 0, TAU); c.fill();
  }
  c.restore();
}
// Een melkweg wordt één keer als plaatje getekend (de schijf ligt plat in het grondvlak) en daarna met één drawImage
// geplaatst, gedraaid en afgeplat volgens de camera. Dat houdt 100+ stelsels vloeiend.
const SPR = 150, sprites = new Map<string, HTMLCanvasElement>();
function galaxySprite(hex: string, seed: number) {
  const key = hex + seed, hit = sprites.get(key);
  if (hit) { sprites.delete(key); sprites.set(key, hit); return hit; }
  const size = Math.round(SPR * 2.6), cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d")!, r = rng(seed), warm = mix(hex, "#fff2d6", 0.7), cool = mix(hex, "#9fd8ff", 0.3), m = size / 2;
  g.translate(m, m);
  const halo = g.createRadialGradient(0, 0, 0, 0, 0, SPR * 1.3);
  halo.addColorStop(0, rgba(hex, 0.3 * style.calm * 2)); halo.addColorStop(1, rgba(hex, 0));
  g.fillStyle = halo; g.beginPath(); g.arc(0, 0, SPR * 1.3, 0, TAU); g.fill();
  const body = g.createRadialGradient(0, 0, 0, 0, 0, SPR);
  body.addColorStop(0, rgba(warm, 0.38)); body.addColorStop(0.3, rgba(hex, 0.13)); body.addColorStop(1, rgba(hex, 0));
  g.fillStyle = body; g.beginPath(); g.arc(0, 0, SPR, 0, TAU); g.fill();
  g.strokeStyle = rgba(hex, 0.16); g.beginPath(); g.arc(0, 0, SPR * 1.02, 0, TAU); g.stroke();
  const arm = (k: number, t: number) => (k * Math.PI) / 2 + t * 3.4;
  for (let i = 0; i < 1100; i++) {
    const t = Math.pow(r(), 0.8), ang = arm(i % 4, t) + (r() - 0.5) * (0.55 * (1.1 - t) + 0.05), d = (0.06 + t * 0.94) * SPR, big = r() > 0.97;
    g.fillStyle = rgba(mix(warm, cool, Math.min(1, t * 1.2)), 0.5 + 0.4 * r());
    g.beginPath(); g.arc(Math.cos(ang) * d, Math.sin(ang) * d, big ? 3.4 : 1.7, 0, TAU); g.fill();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, SPR * 0.32);
  core.addColorStop(0, rgba(warm, 0.8)); core.addColorStop(1, rgba(warm, 0));
  g.fillStyle = core; g.beginPath(); g.arc(0, 0, SPR * 0.32, 0, TAU); g.fill();
  sprites.set(key, cv);
  if (sprites.size > 160) sprites.delete(sprites.keys().next().value!);
  return cv;
}
/** Spiraalstelsel voor een groep in het overzicht. */
export function disc(c: CanvasRenderingContext2D, P: P, [x, y, z]: [number, number, number], R: number, hex: string, seed: number) {
  const q = P(x, y, z), RR = R * q.k, spr = galaxySprite(hex, seed), half = (RR * 2.6) / 2;
  c.save();
  c.translate(q.x, q.y);
  c.scale(1, P.ratio);
  c.rotate(-P.yaw);
  c.drawImage(spr, -half, -half, half * 2, half * 2);
  c.restore();
}
/** Subgroep als klein planetenstelsel: ster, banen, planeten (= soorten notities) en een enkele maan of ring. */
export function miniSystem(c: CanvasRenderingContext2D, P: P, [x, y, z]: [number, number, number], Rs: number, hex: string, seed: number, planets: number) {
  const r = rng(seed), q = P(x, y, z), orbs = planets > 6 ? 3 : 2;
  glow(c, q.x, q.y, Rs * q.k * 1.4, hex, 0.22, P.ratio);
  for (let o = 1; o <= orbs; o++) orbit(c, P, x, y, z, Rs * (o / orbs), hex, 0.34);
  const list: { s: Pt; rad: number; moon: boolean; ring: boolean }[] = [];
  for (let i = 0; i < Math.min(planets, 9); i++) {
    const d = Rs * (((i % orbs) + 1) / orbs), ang = r() * TAU, s = P(x + Math.cos(ang) * d, y, z + Math.sin(ang) * d);
    list.push({ s, rad: (3 + r() * 2.6) * s.k + 1, moon: r() > 0.65, ring: r() > 0.88 });
  }
  list.sort((a, b) => b.s.z - a.s.z).forEach((p) => {
    if (p.ring) { c.strokeStyle = rgba(mix(hex, "#fff2d6", 0.5), 0.6); c.lineWidth = 1; c.beginPath(); c.ellipse(p.s.x, p.s.y, p.rad * 2.1, p.rad * 0.7, -0.3, 0, TAU); c.stroke(); }
    sphere(c, p.s.x, p.s.y, p.rad, mix(hex, "#9aa0c3", 0.15));
    if (p.moon) { c.fillStyle = "#dfe7ff"; c.beginPath(); c.arc(p.s.x + p.rad * 2, p.s.y - p.rad * 1.3, Math.max(1.2, p.rad * 0.32), 0, TAU); c.fill(); }
  });
  sphere(c, q.x, q.y, 6.5 * q.k + 3, mix(hex, "#fff2d6", 0.55));
  return q;
}
