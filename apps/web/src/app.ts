import { type Bundle, type Card, type GroupData, type Hit, type Item, type ItemRow, type Overview, api } from "./api";
import { FONT, arc3, disc, miniSystem, orbit, pill, sphere, stalk, style, sun, tag } from "./draw";
import { type Cam, type ILayout, type Layout, type Pt, type XZ, camera, colorOf, galaxyBudget, galaxyRadius, groupPositions, itemLift, itemPos, kindRings, lift, linkColor, nl, hash, rgba, ringRadius, rng, titleBudget, visibleCount } from "./lib";
import { $, btn, el, fail, toast } from "./dom";
import { render as renderMd } from "./markdown";
import { confirmDelete, renderDashboard, renderLogs } from "./pages";
import { settings, save } from "./settings";

const cv = $<HTMLCanvasElement>("uni");
const ctx = cv.getContext("2d")!;
const TAU = Math.PI * 2;

// ---------- toestand ----------
type Hit2 = { x: number; y: number; r: number; kind: "group" | "item" | "direct"; id: string };
type Placed = ItemRow & { ring: number; idx: number; rank: number; pos: XZ };
type Sel = { kind: "group"; id: string } | { kind: "item"; id: string } | null;
const S = {
  layer: 1 as 1 | 2 | 3,
  groupId: null as string | null,
  ov: null as Overview | null,
  gd: null as GroupData | null,
  placed: [] as Placed[],
  loadedPerRing: [] as number[],
  itemTotal: 0,
  sel: null as Sel,
  hover: null as Hit2 | null,
  hits: [] as Hit2[],
  searchIds: new Set<string>(),
  cam: { cx: 0, cy: 0, pitch: 0.8, yaw: 0.15, f: 1800, scale: 1 } as Cam,
  scale0: 1,
  W: 0,
  H: 0,
  tagFilter: "" as string,
  hiddenKinds: new Set<string>(),
  selItem: null as Item | null,
  token: 0,
};
const itemCache = new Map<string, Item>();

// ---------- hash-navigatie ----------
type Route = { g?: string; l?: string; n?: string; p?: string };
const parse = (): Route => Object.fromEntries(new URLSearchParams(location.hash.slice(1))) as Route;
const go = (r: Route) => {
  const h = new URLSearchParams(Object.entries(r).filter(([, v]) => v) as [string, string][]).toString();
  if (location.hash.slice(1) === h) void load();
  else location.hash = h;
};
addEventListener("hashchange", () => void load());


// ---------- laden ----------
let reloadLogs: (() => Promise<void>) | undefined;
let page: "dashboard" | "logs" | null = null;
async function showPage(p: "dashboard" | "logs") {
  page = p;
  document.body.classList.add("onpage");
  $("page").hidden = false;
  setNav();
  try {
    if (p === "dashboard") renderDashboard(await api.dashboard(), { open: (id) => void openId(id), search: (t) => { qin.value = t; void search(); } });
    else reloadLogs = renderLogs({ open: (id) => void openId(id) });
  } catch (e) {
    fail(e);
  }
}
function setNav() {
  const cur = page ?? "heelal";
  for (const k of ["heelal", "dashboard", "logs"]) { const a = $("nav-" + k); if (k === cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
}
/** `keep`: ververs de gegevens (live-update) zonder dat de camera of de selectie verspringt. */
async function load(keep = false) {
  const my = ++S.token, r = parse();
  if (r.p === "dashboard" || r.p === "logs") return void (await showPage(r.p));
  page = null;
  document.body.classList.remove("onpage");
  $("page").hidden = true;
  setNav();
  try {
    if (!r.g) {
      const ov = await api.overview();
      if (my !== S.token) return;
      Object.assign(S, { layer: 1, groupId: null, ov, gd: null, placed: [] });
      if (!keep) Object.assign(S, { sel: null, selItem: null, hiddenKinds: new Set(), tagFilter: "" });
    } else {
      const gd = await api.group(r.g);
      if (my !== S.token) return;
      const l3 = r.l === "3" || (gd.children.length === 0 && gd.direct.count > 0);
      if (S.groupId !== r.g) Object.assign(S, { hiddenKinds: new Set(), tagFilter: "" });
      Object.assign(S, { layer: l3 ? 3 : 2, groupId: r.g, gd });
      if (!keep) Object.assign(S, { sel: null, selItem: null });
      if (l3) await loadItems(my);
      if (my !== S.token) return;
    }
    if (!keep && r.n) await select({ kind: "item", id: r.n }, false);
    else if (keep && S.sel?.kind === "item") await select(S.sel, false);
    else showSide();
    const d = defaultCam();
    if (!keep) S.cam = d;
    buildPanels();
    buildCrumbs();
    buildList();
    redraw();
    try { localStorage.setItem("brain-last", location.hash); } catch { /* geen opslag: dan begin je volgende keer bovenaan */ }
  } catch (e) {
    fail(e);
  }
}

async function loadItems(my: number) {
  const gd = S.gd!, rings = kindRings(gd.direct.types);
  const lists = await Promise.all(rings.map((rg) => (rg.kind === "overig" ? Promise.resolve({ total: 0, items: [] as ItemRow[] }) : api.items({ group: gd.group.id, type: rg.kind, tag: S.tagFilter || undefined, limit: 200 }))));
  if (my !== S.token) return;
  const all: (ItemRow & { ring: number })[] = lists.flatMap((l, ring) => l.items.map((it) => ({ ...it, ring })));
  all.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.id.localeCompare(b.id));
  const idxIn: number[] = rings.map(() => 0);
  const layout = settings.iLayout;
  S.placed = all.map((it, rank) => ({ ...it, rank, idx: idxIn[it.ring]!++, pos: [0, 0] as XZ }));
  S.placed.forEach((p) => (p.pos = itemPos(layout, p.id, p.ring, p.idx, p.rank)));
  S.loadedPerRing = idxIn;
  S.itemTotal = gd.direct.count;
}

// ---------- camera ----------
function fit(R: number, c: Cam, half = 0) {
  const P = camera({ ...c, cx: 0, cy: 0, scale: 1 });
  let wx = 1, wy = 1;
  for (let i = 0; i < 16; i++) {
    for (const y of [-half, 0, half]) {
      const q = P(Math.cos((i / 16) * TAU) * R, y, Math.sin((i / 16) * TAU) * R);
      wx = Math.max(wx, Math.abs(q.x));
      wy = Math.max(wy, Math.abs(q.y));
    }
  }
  return Math.min((S.W * 0.34) / wx, (S.H * 0.35) / wy);
}
function defaultCam(): Cam {
  const base: Cam = S.layer === 1 ? { cx: S.W / 2, cy: S.H / 2 + 20, pitch: 0.82, yaw: 0.15, f: 1800, scale: 1 } : S.layer === 2 ? { cx: S.W / 2, cy: S.H / 2 + 20, pitch: 0.62, yaw: 0.2, f: 1900, scale: 1 } : { cx: S.W / 2, cy: S.H / 2 + 20, pitch: 0.75, yaw: 0.15, f: 1100, scale: 1 };
  let R = 900;
  if (S.layer === 1 && S.ov) {
    const n = Math.min(S.ov.groups.length, 14), { pos } = groupPositions(n, settings.layout);
    R = Math.max(500, ...pos.map(([x, z]) => Math.hypot(x, z) + 150));
  } else if (S.layer === 2 && S.gd) {
    const { pos } = groupPositions(S.gd.children.length, settings.layout, 330, 230, 6);
    R = Math.max(380, ...pos.map(([x, z]) => Math.hypot(x, z) + 130));
  } else if (S.layer === 3) R = settings.iLayout === "soort" ? ringRadius(Math.max(0, kindRings(S.gd?.direct.types ?? []).length - 1)) + 70 : 600;
  base.scale = fit(R, base, S.layer === 1 ? DEPTH1 / 2 + 60 : S.layer === 2 ? DEPTH2 / 2 + 40 : 40);
  S.scale0 = base.scale;
  return base;
}
function resetCam() {
  S.cam = defaultCam();
}
const zoomLevel = () => S.cam.scale / S.scale0;

// ---------- tekenen ----------
let queued = 0;
function redraw() {
  if (!queued) queued = requestAnimationFrame(() => { queued = 0; frame(); });
}
function resize() {
  const d = devicePixelRatio || 1;
  S.W = innerWidth;
  S.H = innerHeight;
  cv.width = Math.round(S.W * d);
  cv.height = Math.round(S.H * d);
  ctx.setTransform(d, 0, 0, d, 0, 0);
}
function backdrop() {
  const r = rng(3);
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(200,208,255,${0.1 + r() * 0.4})`;
    ctx.fillRect(r() * S.W, r() * S.H, r() + 0.4, r() + 0.4);
  }
}
const onScreen = (q: Pt, m = 80) => q.x > -m && q.x < S.W + m && q.y > -m && q.y < S.H + m;

function frame() {
  ctx.clearRect(0, 0, S.W, S.H);
  backdrop();
  S.hits = [];
  if (S.layer === 1 && S.ov) scene1(S.ov);
  else if (S.layer === 2 && S.gd) scene2(S.gd);
  else if (S.layer === 3 && S.gd) scene3(S.gd);
  zoomHint();
}

function bundleLines(P: ReturnType<typeof camera>, bundles: Bundle[], at: (path: string) => [number, number, number] | undefined, selPath?: string) {
  const mode = settings.lineMode, drawn: { q: Pt; n: number; hex: string }[] = [];
  const list = bundles.filter((b) => !settings.hiddenLinks.includes(b.type) && (mode === "gebundeld" || (selPath && (b.a === selPath || b.b === selPath)))).sort((a, b) => b.count - a.count).slice(0, 40);
  for (const b of list) {
    const A = at(b.a), B = at(b.b);
    if (!A || !B) continue;
    const hex = linkColor(b.type), m = arc3(ctx, P, A, B, hex, { lift: 110, w: 0.7 + Math.log10(b.count + 1) * 0.8, a: 0.34 });
    drawn.push({ q: m, n: b.count, hex });
  }
  return drawn.sort((a, b) => b.n - a.n).slice(0, 10);
}
const labelLines = (ls: { q: Pt; n: number; hex: string }[]) => style.linkOn && zoomLevel() > 0.7 && ls.forEach((l) => pill(ctx, nl(l.n), l.q.x, l.q.y, { s: 11, hex: l.hex, w: 500 }));

// --- laag 1: melkwegen om Claude ---
/** Hoogteverschil (totaal) tussen groepen in het overzicht en tussen subgroepen in een groep. */
const DEPTH1 = 320, DEPTH2 = 170;
function scene1(ov: Overview) {
  const P = camera(S.cam), Z = zoomLevel();
  const cards = [...ov.groups].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  const { pos, rings } = groupPositions(cards.length, settings.layout);
  rings.forEach((R) => orbit(ctx, P, 0, 0, 0, R, "#7aa2ff", 0.28));
  const where = new Map<string, [number, number, number]>([["/", [0, 0, 0]]]);
  cards.forEach((c, i) => where.set(c.path, [pos[i]![0], lift(c.id, DEPTH1), pos[i]![1]]));
  const selPath = S.sel?.kind === "group" ? cards.find((c) => c.id === S.sel!.id)?.path : undefined;
  const lab = bundleLines(P, ov.bundles, (p) => where.get(p), selPath);
  const budget = galaxyBudget(cards.length, Z), items: { z: number; fn: () => void }[] = [];
  const q0 = P(0, 0, 0);
  items.push({ z: q0.z, fn: () => { sun(ctx, q0.x, q0.y, 1.15 * Math.min(1.6, Math.max(0.5, Math.sqrt(Z)))); pill(ctx, "Claude", q0.x, q0.y + 62, { hex: "#ffb35c", color: "#ffd9a8" }); } });
  // Eerst bepalen welke groepen een titel krijgen: grootste eerst, en nooit twee titels op elkaar.
  const labels = new Set<string>(), boxes: Pt[] = [], late: (() => void)[] = [];
  cards.forEach((c, i) => {
    const q = P(pos[i]![0], lift(c.id, DEPTH1), pos[i]![1]), RR = galaxyRadius(c.count) * q.k;
    const must = c.id === S.sel?.id || c.id === S.hover?.id;
    if (!onScreen(q, 0) || !(must || (RR > 12 && (i < budget || (Z > 1.3 && RR > 30))))) return;
    const at = { ...q, y: q.y + RR * P.ratio * 0.95 + 26 };
    if (!must && boxes.some((b) => Math.abs(b.x - at.x) < 110 && Math.abs(b.y - at.y) < 34)) return;
    boxes.push(at);
    labels.add(c.id);
  });
  let dust = 0, dustAt: Pt | null = null;
  cards.forEach((c, i) => {
    const [x, z] = pos[i]!, y = lift(c.id, DEPTH1), R = galaxyRadius(c.count), q = P(x, y, z), RR = R * q.k;
    if (!onScreen(q, RR + 60)) return;
    const real = i < budget || (Z > 1.3 && RR > 26) || c.id === S.sel?.id;
    if (!real) {
      ctx.fillStyle = rgba(colorOf(c.id), 0.7);
      ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, TAU); ctx.fill();
      dust++; dustAt = q;
      return;
    }
    const hex = colorOf(c.id);
    items.push({ z: q.z, fn: () => {
      stalk(ctx, P, x, y, z, hex);
      disc(ctx, P, [x, y, z], R, hex, hash(c.id));
      if (S.sel?.id === c.id || S.hover?.id === c.id) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(q.x, q.y, RR * 1.08, RR * 1.08 * P.ratio, 0, 0, TAU); ctx.stroke(); }
      if (labels.has(c.id)) late.push(() => pill(ctx, c.title, q.x, q.y + RR * P.ratio * 0.95 + 26, { hex, sub: `${nl(c.count)} items`, s: Math.max(11, Math.min(14, 9 + RR / 14)) }));
      S.hits.push({ x: q.x, y: q.y, r: Math.max(14, RR), kind: "group", id: c.id });
    } });
  });
  items.sort((a, b) => b.z - a.z).forEach((d) => d.fn());
  labelLines(lab);
  late.forEach((f) => f());
  if (dust && dustAt) pill(ctx, `+${nl(dust)} kleinere groepen · zoom in om ze te openen`, S.W / 2, S.H - 110, { s: 12, hex: "#9aa0c3", w: 400 });
}

// --- laag 2: subgroepen als klein planetenstelsel ---
const planetsOf = (n: number) => Math.max(2, Math.min(9, Math.round(Math.log2(n + 1))));
function scene2(gd: GroupData) {
  const P = camera(S.cam), Z = zoomLevel();
  const cards = [...gd.children].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  const { pos } = groupPositions(cards.length, settings.layout, 330, 230, 6);
  const where = new Map<string, [number, number, number]>([[gd.group.path, [0, 0, 0]]]);
  cards.forEach((c, i) => where.set(c.path, [pos[i]![0], lift(c.id, DEPTH2), pos[i]![1]]));
  const selPath = S.sel?.kind === "group" ? cards.find((c) => c.id === S.sel!.id)?.path : undefined;
  const lab = bundleLines(P, gd.bundles, (p) => where.get(p), selPath);
  const list: { z: number; fn: () => void }[] = [], late: (() => void)[] = [];
  const hex0 = colorOf(gd.group.id), q0 = P(0, 0, 0);
  list.push({ z: q0.z, fn: () => {
    if (gd.direct.count > 0) {
      miniSystem(ctx, P, [0, 0, 0], 70, hex0, hash(gd.group.id), Math.max(2, gd.direct.types.length + 1));
      S.hits.push({ x: q0.x, y: q0.y, r: 40, kind: "direct", id: gd.group.id });
      pill(ctx, gd.group.title, q0.x, q0.y + 70 * q0.k * P.ratio + 26, { hex: hex0, sub: `${nl(gd.direct.count)} eigen notities · open`, s: 14 });
    } else {
      sphere(ctx, q0.x, q0.y, 9, hex0, true);
      pill(ctx, gd.group.title, q0.x, q0.y + 34, { hex: hex0, sub: `${nl(gd.count)} items`, s: 14 });
    }
  } });
  cards.forEach((c, i) => {
    const [x, y, z] = where.get(c.path)!, Rs = 48 + Math.min(70, Math.log10(c.count + 1) * 17), q = P(x, y, z), hex = colorOf(c.id);
    if (!onScreen(q, Rs * q.k + 60)) return;
    list.push({ z: q.z, fn: () => {
      stalk(ctx, P, x, y, z, hex);
      miniSystem(ctx, P, [x, y, z], Rs, hex, hash(c.id), planetsOf(c.count));
      if (S.sel?.id === c.id || S.hover?.id === c.id) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(q.x, q.y, Rs * q.k * 1.1, Rs * q.k * 1.1 * P.ratio, 0, 0, TAU); ctx.stroke(); }
      if (Z > 0.6 || i < 12) late.push(() => pill(ctx, c.title, q.x, q.y + Rs * q.k * P.ratio + 22, { hex, sub: `${nl(c.count)} items${c.groups ? ` · ${c.groups} subgroepen` : ""}`, s: 12 }));
      S.hits.push({ x: q.x, y: q.y, r: Math.max(18, Rs * q.k), kind: "group", id: c.id });
    } });
  });
  list.sort((a, b) => b.z - a.z).forEach((d) => d.fn());
  labelLines(lab);
  late.forEach((f) => f());
  if (!cards.length) pill(ctx, "Geen subgroepen", S.W / 2, S.H / 2 + 120, { s: 13, hex: "#9aa0c3", w: 400 });
}

// --- laag 3: items, een baan per soort ---
function scene3(gd: GroupData) {
  const P = camera(S.cam), Z = zoomLevel(), rings = kindRings(gd.direct.types);
  const soort = settings.iLayout === "soort", hex0 = colorOf(gd.group.id), q0 = P(0, 0, 0);
  const sel = S.sel?.kind === "item" ? S.sel.id : null, searching = S.searchIds.size > 0;
  const linked = new Map<string, { type: string }>();
  S.selItem?.links.forEach((l) => linked.set(l.id, l));
  S.selItem?.backlinks.forEach((l) => linked.set(l.id, l));
  const kindOf = (r: number) => rings[r]!.kind;
  const yOf = (p: Placed) => itemLift(p.id, p.ring, soort);
  if (soort) rings.forEach((rg, i) => { if (!S.hiddenKinds.has(rg.kind)) orbit(ctx, P, 0, 0, 0, ringRadius(i), colorOf(rg.kind), 0.32); });
  sphere(ctx, q0.x, q0.y, 10, hex0, true);
  pill(ctx, gd.group.title, q0.x, q0.y + 34, { hex: hex0, sub: `${nl(gd.direct.count)} notities`, s: 13 });
  // samengevoegd stof voor wat niet los geladen is (per baan), zodat dichtheid zichtbaar blijft
  rings.forEach((rg, i) => {
    if (S.hiddenKinds.has(rg.kind)) return;
    const loaded = S.loadedPerRing[i] ?? 0, extra = Math.min(1600, Math.round((rg.count - loaded) / 6));
    if (extra <= 0 || !soort) return;
    const r = rng(hash(rg.kind)), R = ringRadius(i), cl = Array.from({ length: 4 }, () => r() * TAU);
    ctx.fillStyle = rgba(colorOf(rg.kind), 0.32 / Math.sqrt(Math.max(1, Z)));
    for (let k = 0; k < extra; k++) {
      const a = r() < 0.7 ? cl[k % 4]! + (r() + r() + r() - 1.5) * 0.35 : r() * TAU, d = R + (r() + r() - 1) * 14, q = P(Math.cos(a) * d, (r() - 0.5) * (16 + R * 0.16), Math.sin(a) * d);
      ctx.fillRect(q.x, q.y, 1.4, 1.4);
    }
    const lq = P(Math.cos(0.3 + i * 0.5) * R, 0, Math.sin(0.3 + i * 0.5) * R);
    pill(ctx, `${rg.kind} · ${nl(rg.count)}`, lq.x, lq.y - 16, { s: 11, hex: colorOf(rg.kind), w: 500 });
  });
  const proj = new Map<string, Pt>(), drawn: { p: Placed; q: Pt; important: boolean }[] = [];
  const perRingShown: number[] = rings.map(() => 0);
  for (const p of S.placed) {
    if (S.hiddenKinds.has(kindOf(p.ring))) continue;
    const q = P(p.pos[0], yOf(p), p.pos[1]);
    proj.set(p.id, q);
    const important = p.id === sel || linked.has(p.id) || S.searchIds.has(p.id) || p.id === S.hover?.id;
    const show = important || (perRingShown[p.ring]!++ < visibleCount(S.loadedPerRing[p.ring] ?? 0, Z));
    if (!onScreen(q)) continue;
    if (!show) { ctx.fillStyle = rgba(colorOf(kindOf(p.ring)), 0.55); ctx.fillRect(q.x, q.y, 1.6, 1.6); continue; }
    drawn.push({ p, q, important });
  }
  // links van het geselecteerde item blijven los zichtbaar
  const pills: { q: Pt; t: string }[] = [];
  if (sel && proj.has(sel)) {
    const a = S.placed.find((p) => p.id === sel)!;
    for (const l of [...(S.selItem?.links ?? []), ...(S.selItem?.backlinks ?? [])].slice(0, 16)) {
      const b = S.placed.find((p) => p.id === l.id);
      if (!b || S.hiddenKinds.has(kindOf(b.ring)) || settings.hiddenLinks.includes(l.type)) continue;
      const m = arc3(ctx, P, [a.pos[0], yOf(a), a.pos[1]], [b.pos[0], yOf(b), b.pos[1]], linkColor(l.type), { lift: 50, w: 2.2, a: 0.9 });
      pills.push({ q: m, t: l.type });
    }
  }
  const rad = 3.6 + 1.6 * Math.min(2, Math.max(0, Z - 1));
  drawn.sort((a, b) => b.q.z - a.q.z).forEach(({ p, q, important }) => {
    const hex = colorOf(kindOf(p.ring)), dim = searching && !S.searchIds.has(p.id);
    ctx.globalAlpha = dim ? 0.25 : 1;
    sphere(ctx, q.x, q.y, p.id === sel ? 8.5 : important ? rad + 1.5 : rad, hex, p.id === sel);
    ctx.globalAlpha = 1;
    if (p.id === sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 16, 0, TAU); ctx.stroke(); }
    S.hits.push({ x: q.x, y: q.y, r: Math.max(9, rad + 5), kind: "item", id: p.id });
  });
  // titels: alleen belangrijke items, en de rest op volgorde van nieuwste zolang er plek is
  const placedTitles: Pt[] = [];
  const budget = titleBudget(Z);
  let n = 0;
  const ordered = [...drawn].sort((a, b) => Number(b.important) - Number(a.important) || a.p.rank - b.p.rank);
  for (const { p, q, important } of ordered) {
    if (!important && n >= budget) break;
    if (!important && Math.hypot(q.x - q0.x, q.y - q0.y) < 70) continue;
    if (!important && placedTitles.some((o) => Math.abs(o.x - q.x) < 130 && Math.abs(o.y - q.y) < 22)) continue;
    placedTitles.push(q);
    if (!important) n++;
    tag(ctx, p.title, q.x, q.y + 20, p.id === sel ? "#fff" : "#cfd3ee");
  }
  pills.forEach((l) => style.linkOn && pill(ctx, l.t, l.q.x, l.q.y, { s: 11, hex: linkColor(l.t), w: 500 }));
  const shown = drawn.length, tot = S.itemTotal;
  pill(ctx, tot > S.placed.length ? `${nl(shown)} los zichtbaar van ${nl(tot)} notities · zoom in, filter of zoek voor de rest` : `${nl(tot)} notities`, S.W / 2, 112, { s: 12, hex: "#7ad7ff", w: 400 });
  ctx.font = `400 12px ${FONT}`;
}

function zoomHint() {
  const el = $("zoomhint"), z = S.layer;
  el.replaceChildren();
  const lv = document.createElement("span");
  lv.className = "lv";
  for (let i = 1; i <= 3; i++) { const b = document.createElement("i"); if (i <= z) b.className = "on"; lv.append(b); }
  const t = document.createElement("span");
  t.textContent = (["Groepen", "Subgroepen", "Items"] as const)[z - 1]!;
  const h = document.createElement("span");
  h.textContent = `Scroll = zoomen · slepen = draaien · Shift+slepen = verschuiven · dubbelklik = openen · Esc = terug${S.layer > 1 ? " · Backspace = omhoog" : ""}`;
  el.append(t, lv, h);
}

// ---------- selectie en zijpaneel ----------
const side = $("side");
async function select(s: Sel, push = true) {
  S.sel = s;
  S.selItem = null;
  if (s?.kind === "item") {
    try {
      let it = itemCache.get(s.id);
      if (!it) { it = await api.item(s.id); itemCache.set(s.id, it); if (itemCache.size > 200) itemCache.delete(itemCache.keys().next().value!); }
      S.selItem = it;
    } catch (e) {
      fail(e);
      S.sel = null;
    }
  }
  showSide();
  if (push) { const r = parse(); const h = new URLSearchParams(Object.entries({ ...r, n: s?.kind === "item" ? s.id : "" }).filter(([, v]) => v) as [string, string][]).toString(); history.replaceState(null, "", "#" + h); }
  redraw();
}
function foldable(p: HTMLElement, key: string, left = false) {
  const b = el("button", { cls: "fold", text: settings.folded[key] ? "+" : "–" });
  b.type = "button";
  b.setAttribute("aria-label", "Menu in- of uitklappen");
  const apply = (f: boolean) => { p.classList.toggle("folded", f); b.textContent = f ? "+" : "–"; b.setAttribute("aria-expanded", String(!f)); };
  b.onclick = () => { settings.folded[key] = !p.classList.contains("folded"); apply(settings.folded[key]!); save(); };
  apply(!!settings.folded[key]);
  const h = el("span", { cls: "rz" + (left ? " left" : "") });
  h.title = "Sleep om te vergroten of verkleinen; dubbelklik = standaard";
  if (settings.widths[key]) p.style.width = settings.widths[key] + "px";
  h.ondblclick = () => { p.style.width = ""; delete settings.widths[key]; save(); };
  h.onpointerdown = (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const w0 = p.getBoundingClientRect().width, x0 = e.clientX;
    h.onpointermove = (m) => { const w = Math.max(220, Math.min(760, w0 + (left ? x0 - m.clientX : m.clientX - x0))); p.style.width = w + "px"; settings.widths[key] = w; };
    h.onpointerup = () => { h.onpointermove = null; h.onpointerup = null; save(); };
  };
  p.append(b, h);
  movable(p, key);
}
/** Menu's en zijpaneel vrij te verslepen (hele scherm, links/rechts en omhoog/omlaag) via de titel; dubbelklik op de titel zet het terug. */
function movable(p: HTMLElement, key: string) {
  const place = (x: number, y: number) => {
    const r = p.getBoundingClientRect(), w = r.width || 300;
    x = Math.max(-w + 90, Math.min(innerWidth - 90, x));
    y = Math.max(0, Math.min(innerHeight - 44, y));
    Object.assign(p.style, { position: "fixed", left: x + "px", top: y + "px", right: "auto", bottom: "auto", width: w + "px", maxHeight: `calc(100vh - ${y}px - 12px)`, zIndex: "8" });
    settings.pos[key] = [x, y];
  };
  const saved = settings.pos[key];
  if (saved) place(saved[0], saved[1]);
  p.onpointerdown = (e) => {
    const head = (e.target as HTMLElement).closest("h2,h3");
    if (!head || !p.contains(head) || e.button !== 0) return;
    e.preventDefault();
    p.setPointerCapture(e.pointerId);
    const r = p.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    p.onpointermove = (m) => place(m.clientX - dx, m.clientY - dy);
    p.onpointerup = (u) => { p.releasePointerCapture(u.pointerId); p.onpointermove = null; p.onpointerup = null; save(); };
  };
  p.ondblclick = (e) => {
    // De aanwijzer is vastgelegd op het paneel, dus e.target is het paneel zelf; kijk daarom waar het dubbelklikken was.
    const r = p.querySelector("h2,h3")?.getBoundingClientRect();
    if (!r || e.clientY < r.top || e.clientY > r.bottom) return;
    for (const k of ["position", "left", "top", "right", "bottom", "maxHeight", "zIndex"] as const) p.style[k] = "";
    p.style.width = settings.widths[key] ? settings.widths[key] + "px" : "";
    delete settings.pos[key];
    save();
  };
}
const relRow = (r: { id: string; title: string; type: string; broken?: boolean }) => {
  const b = el("button", {}, [el("i"), el("span", { text: r.title }), el("small", { text: r.type })]);
  b.type = "button";
  b.style.setProperty("--c", linkColor(r.type));
  if (!r.broken) b.onclick = () => void openId(r.id);
  return b;
};
function showSide() {
  side.replaceChildren();
  side.className = "side glass";
  const s = S.sel;
  side.hidden = !s;
  if (!s) return;
  if (s.kind === "group") {
    const c = (S.layer === 1 ? S.ov?.groups : S.gd?.children)?.find((x) => x.id === s.id);
    if (!c) return;
    const open = el("button", { cls: "btn", text: "Openen" });
    open.type = "button";
    open.onclick = () => go({ g: c.id });
    const del = btn("Verwijderen…", () => void removeItem(c.id), "btn danger");
    side.append(el("h2", { text: c.title }), el("div", { cls: "meta" }, [el("span", { cls: "tg", text: "GROEP" }), el("span", { cls: "tg", text: `${nl(c.count)} items` }), ...(c.groups ? [el("span", { cls: "tg", text: `${c.groups} subgroepen` })] : []), ...(c.direct ? [el("span", { cls: "tg", text: `${nl(c.direct)} eigen notities` })] : [])]), el("p", { cls: "sum", text: c.summary }), el("div", { cls: "actions" }, [open, del]));
    foldable(side, "side", true);
    return;
  }
  const it = S.selItem;
  if (!it) { side.append(el("h2", { text: "Laden…" })); return; }
  side.append(el("h2", { text: it.title }));
  const meta = el("div", { cls: "meta" }, [el("span", { cls: "tg", text: it.kind === "image" ? "AFBEELDING" : it.type.toUpperCase() }), ...(it.status !== "active" ? [el("span", { cls: "tg", text: it.status })] : []), ...it.tags.map((t) => el("span", { cls: "tg", text: "#" + t }))]);
  side.append(meta, el("p", { cls: "sum", text: it.summary }));
  if (it.groupId) { const g = el("button", { cls: "tg", text: `Groep ${it.group}` }); g.type = "button"; g.onclick = () => go({ g: it.groupId! }); g.style.cursor = "pointer"; side.append(g); }
  const md = el("div", { cls: "md" });
  md.append(renderMd(it.body, (id) => void openId(id), api.imageUrl));
  side.append(md);
  const own = new Set(it.body.match(/brain:i_[0-9a-z]{8}/g)?.map((x) => x.slice(6)) ?? []);
  const extra = [...(it.kind === "image" ? [it.id] : []), ...it.images.filter((i) => !own.has(i))];
  if (extra.length) side.append(el("div", { cls: "imgs" }, extra.map((id) => { const im = el("img"); im.src = api.imageUrl(id); im.alt = ""; im.loading = "lazy"; return im; })));
  const rel = (title: string, rows: { id: string; title: string; type: string; broken?: boolean }[]) => rows.length && side.append(el("div", { cls: "rel" }, [el("h4", { text: title }), ...rows.map(relRow)]));
  rel("Links", it.links.filter((l) => l.kind !== "image"));
  rel("Linkt hierheen", it.backlinks);
  rel("Onderliggend", it.children.map((k) => ({ ...k, type: "child" })));
  side.append(el("div", { cls: "actions" }, [el("span"), btn("Verwijderen…", () => void removeItem(it.id), "btn danger")]));
  foldable(side, "side", true);
}

async function removeItem(id: string) {
  if (!(await confirmDelete(id))) return;
  itemCache.clear();
  S.sel = null;
  const cr = S.gd?.crumbs ?? [], at = cr.findIndex((c) => c.id === id);
  if (id === S.groupId || at >= 0) go(at > 0 ? { g: cr[at - 1]!.id } : {});
  else void load(true);
}

/** Navigeer naar een item of groep op id (bijv. vanuit een link of zoekresultaat). */
async function openId(id: string) {
  try {
    if (id.startsWith("g_")) return go({ g: id });
    const it = itemCache.get(id) ?? (await api.item(id));
    itemCache.set(id, it);
    if (it.kind === "image" && !it.groupId) return;
    if (!it.groupId) return toast("Deze notitie hangt in geen groep.");
    go({ g: it.groupId, l: "3", n: id });
  } catch (e) {
    fail(e);
  }
}

// ---------- menu's ----------
const panelsEl = $("panels");
function mkPanel(title: string, key: string, kids: Node[]) {
  const p = el("aside", { cls: "panel glass" }, [el("h3", { text: title }), ...kids]);
  p.setAttribute("aria-label", title);
  foldable(p, key);
  panelsEl.append(p);
  return p;
}
function seg<T extends string>(opts: [T, string][], cur: T, on: (v: T) => void) {
  const d = el("div", { cls: "seg" });
  d.setAttribute("role", "radiogroup");
  opts.forEach(([v, l]) => {
    const b = el("button", { text: l });
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(v === cur));
    b.onclick = () => { d.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); on(v); save(); };
    d.append(b);
  });
  return d;
}
function slider(label: string, val: number, on: (v: number) => void) {
  const out = el("b", { text: val + "%" });
  const inp = el("input");
  Object.assign(inp, { type: "range", min: "0", max: "160", value: String(val) });
  inp.oninput = () => { out.textContent = inp.value + "%"; on(Number(inp.value)); save(); redraw(); };
  return el("label", { cls: "r" }, [el("span", {}, [label + " ", out]), inp]);
}
function check(label: string, on: boolean, f: (v: boolean) => void, extra?: { c: string; n?: string }) {
  const inp = el("input");
  Object.assign(inp, { type: "checkbox", checked: on });
  inp.onchange = () => { f(inp.checked); save(); redraw(); };
  const l = el("label", { cls: "lt" }, [inp, ...(extra ? [Object.assign(el("i"), {})] : []), el("span", { text: label }), ...(extra?.n ? [el("span", { cls: "n", text: extra.n })] : [])]);
  if (extra) (l.querySelector("i") as HTMLElement).style.setProperty("--c", extra.c);
  return l;
}
function syncStyle() {
  style.orbOn = settings.orbOn;
  style.orbA = settings.orbA / 100;
  style.linkOn = settings.linkOn;
  style.linkA = settings.linkA / 100;
}
function buildPanels() {
  panelsEl.replaceChildren();
  syncStyle();
  const re = () => { if (S.layer === 3) void load3(); else { resetCam(); redraw(); } };
  const layoutOpts: [Layout, string][] = S.layer === 1 ? [["banen", "Banen"], ["raster", "Raster"], ["grootte", "Op grootte"]] : [["banen", "Cirkel"], ["raster", "Raster"], ["grootte", "Op grootte"]];
  const view = S.layer === 3
    ? seg<ILayout>([["soort", "Per soort"], ["tijd", "Tijdlijn"], ["vrij", "Vrij"]], settings.iLayout, (v) => { settings.iLayout = v; re(); })
    : seg<Layout>(layoutOpts, settings.layout, (v) => { settings.layout = v; re(); });
  const wp: Node[] = [el("p", { cls: "hint", text: "Indeling" }), view];
  if (S.layer === 3 && S.gd) {
    const rings = kindRings(S.gd.direct.types);
    wp.push(el("p", { cls: "hint", text: "Soorten (klik om te verbergen)" }));
    rings.forEach((rg) => wp.push(check(rg.kind, !S.hiddenKinds.has(rg.kind), (v) => { if (v) S.hiddenKinds.delete(rg.kind); else S.hiddenKinds.add(rg.kind); }, { c: colorOf(rg.kind), n: nl(rg.count) })));
    const tags = [...new Map(S.gd.direct.types.flatMap((t) => t.tags).map((t) => [t.tag, t.count] as const)).entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (tags.length) {
      const sel = el("select");
      sel.append(Object.assign(el("option", { text: "Alle tags" }), { value: "" }), ...tags.map(([t, n]) => Object.assign(el("option", { text: `#${t} (${n})` }), { value: t })));
      sel.value = S.tagFilter;
      sel.onchange = () => { S.tagFilter = sel.value; void load3(); };
      wp.push(el("label", { cls: "r" }, [el("span", { text: "Filter op tag" }), sel]));
    }
  }
  mkPanel("Weergave", "view", wp);
  const look = (label: string, f: () => Partial<Cam>) => { const b = el("button", { text: label }); b.type = "button"; b.onclick = () => tween(f()); return b; };
  mkPanel("Kijkhoek", "angle", [
    el("p", { cls: "hint", text: "Sleep om te draaien. Shift+slepen of pijltjestoetsen verschuift het beeld. Menu's verplaats je met hun titel." }),
    el("div", { cls: "seg" }, [
      look("Boven", () => ({ pitch: PITCH_MAX })),
      look("Voor", () => ({ pitch: 0.3, yaw: near(S.cam.yaw, 0.15) })),
      look("Achter", () => ({ pitch: 0.3, yaw: near(S.cam.yaw, 0.15 + Math.PI) })),
      look("Onder", () => ({ pitch: -PITCH_MAX })),
    ]),
    el("div", { cls: "seg" }, [look("Standaard", () => { const d = defaultCam(); return { ...d, yaw: near(S.cam.yaw, d.yaw) }; })]),
  ]);
  const bundles = S.layer === 1 ? S.ov?.bundles : S.layer === 2 ? S.gd?.bundles : undefined;
  const types = new Map<string, number>();
  bundles?.forEach((b) => types.set(b.type, (types.get(b.type) ?? 0) + b.count));
  if (S.layer === 3 && S.selItem) [...S.selItem.links, ...S.selItem.backlinks].forEach((l) => types.set(l.type, (types.get(l.type) ?? 0) + 1));
  const lp: Node[] = [check("Lijnen tonen", settings.linkOn, (v) => { settings.linkOn = v; syncStyle(); }), slider("Helderheid lijnen", settings.linkA, (v) => { settings.linkA = v; syncStyle(); })];
  if (S.layer < 3) lp.push(seg<"gebundeld" | "geselecteerd">([["gebundeld", "Gebundeld"], ["geselecteerd", "Geselecteerd"]], settings.lineMode, (v) => { settings.lineMode = v; redraw(); }));
  [...types.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => lp.push(check(t, !settings.hiddenLinks.includes(t), (v) => { settings.hiddenLinks = settings.hiddenLinks.filter((x) => x !== t); if (!v) settings.hiddenLinks.push(t); }, { c: linkColor(t), n: nl(n) })));
  lp.push(el("p", { cls: "hint", text: S.layer < 3 ? "Eén lijn per paar groepen; de dikte volgt het aantal links." : "Alleen de links van het geselecteerde item staan los getekend." }));
  mkPanel("Lijnen", "lines", lp);
  mkPanel("Banen", "orbits", [check("Banen tonen", settings.orbOn, (v) => { settings.orbOn = v; syncStyle(); }), slider("Helderheid banen", settings.orbA, (v) => { settings.orbA = v; syncStyle(); })]);
}
async function load3() {
  const my = ++S.token;
  try { await loadItems(my); buildPanels(); resetCam(); redraw(); } catch (e) { fail(e); }
}

// ---------- pad, lijst, zoeken ----------
function buildCrumbs() {
  const c = $("crumbs");
  c.replaceChildren();
  const crumb = (t: string, g?: Route) => { const b = el("button", { text: t }); b.type = "button"; b.onclick = () => go(g ?? {}); return b; };
  if (S.layer === 1) { c.append(el("b", { text: S.ov?.root?.title ?? "Heelal" }), el("span", { text: `· ${nl(S.ov?.total ?? 0)} notities` })); return; }
  c.append(crumb(S.ov?.root?.title ?? S.gd?.crumbs[0]?.title ?? "Heelal"));
  const cr = S.gd!.crumbs.slice(1);
  cr.forEach((x, i) => { c.append("›"); if (i < cr.length - 1 || S.layer === 3) c.append(crumb(x.title, { g: x.id })); else c.append(el("b", { text: x.title })); });
  if (S.layer === 3) c.append("›", el("b", { text: "Items" }));
}
function buildList() {
  const l = $("list");
  l.replaceChildren();
  const row = (title: string, sub: string, f: () => void) => { const b = el("button", {}, [title, el("small", { text: sub })]); b.type = "button"; b.onclick = () => { l.hidden = true; $("listbtn").setAttribute("aria-pressed", "false"); f(); }; return b; };
  if (S.layer === 3) { l.append(el("h3", { text: "Notities in deze groep" }), ...S.placed.map((p) => row(p.title, `${p.type} · ${p.summary}`, () => void select({ kind: "item", id: p.id })))); return; }
  const cards: Card[] = S.layer === 1 ? S.ov?.groups ?? [] : S.gd?.children ?? [];
  l.append(el("h3", { text: "Groepen" }), ...cards.map((c) => row(c.title, `${nl(c.count)} items`, () => go({ g: c.id }))));
}
$("listbtn").onclick = () => { const l = $("list"); l.hidden = !l.hidden; $("listbtn").setAttribute("aria-pressed", String(!l.hidden)); };
let searchT = 0;
const results = $("results"), qin = $<HTMLInputElement>("q");
async function search() {
  const text = qin.value.trim();
  if (!text) { results.hidden = true; S.searchIds = new Set(); return redraw(); }
  try {
    const r = await api.search(text);
    results.replaceChildren();
    if (r.error) results.append(el("div", { cls: "err", text: r.error }));
    else if (!r.hits.length) results.append(el("div", { cls: "hint", text: "Niets gevonden." }));
    else {
      S.searchIds = new Set(r.hits.map((h: Hit) => h.id));
      r.hits.forEach((h: Hit) => { const b = el("button", {}, [h.title, el("small", { text: `${h.group} · ${h.summary}` })]); b.type = "button"; b.onclick = () => { results.hidden = true; void openId(h.id); }; results.append(b); });
      if (r.total > r.hits.length) results.append(el("div", { cls: "hint", text: `${nl(r.total)} treffers; de eerste ${r.hits.length} staan hier. Maak de zoekopdracht specifieker.` }));
    }
    results.hidden = false;
    redraw();
  } catch (e) { fail(e); }
}
qin.oninput = () => { clearTimeout(searchT); searchT = window.setTimeout(() => void search(), 250); };
$("searchform").onsubmit = (e) => { e.preventDefault(); void search(); };
qin.addEventListener("keydown", (e) => { if (e.key === "Escape") { qin.value = ""; results.hidden = true; S.searchIds = new Set(); redraw(); e.stopPropagation(); } });

// ---------- invoer op het canvas ----------
const mouse = (e: { clientX: number; clientY: number }): [number, number] => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const pick = (mx: number, my: number) => { let best: Hit2 | null = null, bd = 1e9; for (const h of S.hits) { const d = Math.hypot(h.x - mx, h.y - my); if (d <= h.r && d < bd) { best = h; bd = d; } } return best; };
function zoomAt(mx: number, my: number, f: number) {
  const s0 = S.cam.scale, s1 = Math.max(S.scale0 * 0.12, Math.min(S.scale0 * 12, s0 * f)), r = s1 / s0;
  S.cam.cx = mx - (mx - S.cam.cx) * r;
  S.cam.cy = my - (my - S.cam.cy) * r;
  S.cam.scale = s1;
}
/** Bijna recht omhoog of omlaag kijken; yaw is onbegrensd, dus elke kant is bereikbaar: boven, onder, voor, achter. */
const PITCH_MAX = 1.5;
/** Dichtstbijzijnde hoek die gelijk is aan `to` (mod 2π), zodat de draai kort blijft. */
const near = (cur: number, to: number) => to + TAU * Math.round((cur - to) / TAU);
let anim = 0;
function tween(to: Partial<Cam>) {
  cancelAnimationFrame(anim);
  const from = { ...S.cam }, t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 320), e = 1 - (1 - k) ** 3;
    for (const key of ["scale", "cx", "cy", "yaw", "pitch"] as const) if (to[key] !== undefined) S.cam[key] = from[key] + (to[key]! - from[key]) * e;
    frame();
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}
let drag: { x: number; y: number; pan: boolean; moved: number } | null = null;
cv.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1, moved: 0 }; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; });
cv.addEventListener("pointerup", (e) => {
  cv.style.cursor = S.hover ? "pointer" : "grab";
  const d = drag;
  drag = null;
  if (!d || d.moved > 4) return;
  const [mx, my] = mouse(e), h = pick(mx, my);
  if (!h) void select(null);
  else void select({ kind: h.kind === "item" ? "item" : "group", id: h.id });
});
cv.addEventListener("contextmenu", (e) => e.preventDefault());
cv.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.pan) { S.cam.cx += dx; S.cam.cy += dy; } else { S.cam.yaw += dx * 0.007; S.cam.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, S.cam.pitch + dy * 0.006)); }
    drag.x = e.clientX; drag.y = e.clientY;
    return redraw();
  }
  const [mx, my] = mouse(e), h = pick(mx, my);
  if (h?.id !== S.hover?.id) { S.hover = h; cv.style.cursor = h ? "pointer" : "grab"; redraw(); }
});
cv.addEventListener("wheel", (e) => { e.preventDefault(); const [mx, my] = mouse(e); zoomAt(mx, my, Math.exp(-e.deltaY * 0.0014)); redraw(); }, { passive: false });
cv.addEventListener("dblclick", (e) => {
  const [mx, my] = mouse(e), h = pick(mx, my);
  if (h) return void (h.kind === "item" ? select({ kind: "item", id: h.id }) : h.kind === "direct" ? go({ g: h.id, l: "3" }) : go({ g: h.id }));
  const s1 = Math.min(S.scale0 * 12, S.cam.scale * 2.2), r = s1 / S.cam.scale;
  tween({ scale: s1, cx: mx - (mx - S.cam.cx) * r, cy: my - (my - S.cam.cy) * r });
});
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
  if (e.key === "Escape") tween(defaultCam());
  const arrow = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
  if (arrow && !document.querySelector(".onpage")) { e.preventDefault(); const k = e.shiftKey ? 3 : 1; S.cam.cx += arrow[0]! * k; S.cam.cy += arrow[1]! * k; redraw(); }
  if (e.key === "Backspace" && S.layer > 1) { e.preventDefault(); const c = S.gd!.crumbs; go(S.layer === 3 && S.gd!.children.length ? { g: S.gd!.group.id } : c.length > 1 ? { g: c[c.length - 2]!.id } : {}); }
  if (e.key === "Enter" && S.sel?.kind === "group") go({ g: S.sel.id });
});
const minall = $("minall");
minall.onclick = () => {
  const on = minall.getAttribute("aria-pressed") !== "true";
  minall.setAttribute("aria-pressed", String(on));
  minall.textContent = on ? "Menu's tonen" : "Menu's minimaliseren";
  document.querySelectorAll<HTMLElement>(".panel,.side").forEach((p) => { p.classList.toggle("folded", on); const f = p.querySelector<HTMLElement>(".fold"); if (f) f.textContent = on ? "+" : "–"; });
};
addEventListener("resize", () => { resize(); resetCam(); redraw(); });
addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".search")) results.hidden = true; });

// ---------- live ----------
let liveT = 0;
function live() {
  const es = new EventSource("/api/events"), dot = $("live");
  es.onopen = () => dot.classList.add("on");
  es.onerror = () => dot.classList.remove("on");
  es.addEventListener("change", () => {
    clearTimeout(liveT);
    liveT = window.setTimeout(() => {
      itemCache.clear();
      if (page === "logs") void reloadLogs?.();
      else void load(true);
    }, 500);
  });
}

resize();
try { if (!location.hash && localStorage.getItem("brain-last")) location.hash = localStorage.getItem("brain-last")!; } catch { /* geen opslag */ }
live();
void load();
