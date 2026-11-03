import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import matter from "gray-matter";
import { sniff } from "./image";
import type { Brain } from "./read";

/**
 * Gegevens voor de web-UI (alleen lezen, JSON). Het heelal toont alleen notities en groepen: afbeeldingen zitten
 * wel in de leesweergave van een item, maar nooit als punt in het heelal en niet in de zoekresultaten ervan.
 */
type Row = Record<string, string | number | null>;
export type GroupCard = { id: string; title: string; summary: string; path: string; color: string | null; count: number; direct: number; groups: number; updated: string | null };
export type Bundle = { a: string; b: string; type: string; count: number };

const ID = /^[nig]_[0-9a-z]{8}$/;
const range = (p: string): [string, string] => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];
const depthOf = (p: string) => (p === "/" ? 0 : p.split("/").length - 2);
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export class UiData {
  private cache = new Map<string, { v: number; val: unknown; pending?: Promise<unknown> }>();
  constructor(
    private db: DatabaseSync,
    private vault: string,
    private brain: Brain,
    private logs?: DatabaseSync,
  ) {}

  private all(sql: string, ...p: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private one(sql: string, ...p: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  // De zware aggregaten (aantallen en linkbundels) worden per wijziging van de index één keer berekend. Is de index
  // inmiddels veranderd, dan geven we het oude antwoord meteen terug en berekenen we op de achtergrond een nieuw.
  private version(): number {
    return this.one(`SELECT total_changes() v`)!.v as number;
  }
  private async cached<T>(key: string, f: () => Promise<T>): Promise<T> {
    const v = this.version(), hit = this.cache.get(key);
    if (hit?.pending) return hit.val === undefined ? ((await hit.pending) as T) : (hit.val as T);
    if (hit && hit.v === v) return hit.val as T;
    const pending = f().then((val) => {
      this.cache.set(key, { v, val });
      return val;
    }, (e) => {
      this.cache.delete(key);
      throw e;
    });
    this.cache.set(key, { v, val: hit?.val, pending });
    return hit?.val !== undefined ? (hit.val as T) : pending;
  }

  private groupRow(id: string): Row | undefined {
    return ID.test(id) ? this.one(`SELECT id, title, summary, group_path p, updated FROM items WHERE id=? AND kind='group' AND status='active'`, id) : undefined;
  }

  /** Notities per groepspad, plus het totaal in elke bovenliggende groep. */
  private countsAt?: { v: number; m: Map<string, number> };
  private counts() {
    const v = this.version();
    if (this.countsAt?.v === v) return this.countsAt.m;
    const m = new Map<string, number>();
    for (const r of this.all(`SELECT group_path p, count(*) c FROM items WHERE kind='note' AND status='active' GROUP BY group_path`)) m.set(r.p as string, r.c as number);
    this.countsAt = { v, m };
    return m;
  }
  private total(path: string): number {
    let n = 0;
    for (const [p, c] of this.counts()) if (p.startsWith(path)) n += c;
    return n;
  }

  private cards(base: string): GroupCard[] {
    const [lo, hi] = range(base);
    const d = depthOf(base) + 1;
    const rows = this.all(`SELECT id, title, summary, group_path p, updated FROM items WHERE kind='group' AND status='active' AND group_path > ? AND group_path < ? ORDER BY group_path`, lo, hi);
    const direct = this.counts();
    const kids = rows.filter((r) => depthOf(r.p as string) === d);
    return kids.map((r) => {
      const p = r.p as string;
      const prefix = range(p);
      return {
        id: r.id as string,
        title: r.title as string,
        summary: r.summary as string,
        path: p,
        color: null,
        count: this.total(p),
        direct: direct.get(p) ?? 0,
        groups: rows.filter((x) => (x.p as string) > prefix[0] && (x.p as string) < prefix[1] && depthOf(x.p as string) === d + 1).length,
        updated: r.updated as string | null,
      };
    });
  }

  /**
   * Links gebundeld per paar kinderen van `base`: het heelal tekent één lijn per paar, nooit één per link.
   * We rekenen groep voor groep (elke berekening is klein) en geven tussendoor de ruimte aan andere aanvragen,
   * zodat een grote index de server niet seconden laat hangen.
   */
  private bundles(base: string): Promise<Bundle[]> {
    return this.cached(`bundles:${base}`, async () => {
      const [lo, hi] = range(base), L = base.length;
      const keyOf = (p: string) => {
        const i = p.indexOf("/", L);
        return i < 0 ? base : p.slice(0, i + 1);
      };
      const slice = this.db.prepare(
        `SELECT d.group_path dp, CASE l.inline WHEN 1 THEN 'mentions' ELSE l.type END t, count(*) c
           FROM links l JOIN items s ON s.id = l.src JOIN items d ON d.id = l.dst
          WHERE s.group_path = ?1 AND s.kind='note' AND s.status='active' AND d.kind='note' AND d.status='active'
            AND d.group_path >= ?2 AND d.group_path < ?3
          GROUP BY d.group_path, t`,
      );
      const agg = new Map<string, Bundle>();
      for (const p of [...this.counts().keys()].filter((x) => x >= lo && x < hi).sort()) {
        const a = keyOf(p);
        for (const r of slice.all(p, lo, hi) as Row[]) {
          const b = keyOf(r.dp as string);
          if (a === b) continue;
          const k = `${a}\t${b}\t${r.t}`, cur = agg.get(k);
          if (cur) cur.count += r.c as number;
          else agg.set(k, { a, b, type: r.t as string, count: r.c as number });
        }
        await yieldLoop();
      }
      return [...agg.values()].sort((x, y) => y.count - x.count).slice(0, 400);
    });
  }

  async overview() {
    const root = this.one(`SELECT id, title, summary FROM items WHERE kind='group' AND group_path='/' AND status='active'`);
    const archived = (this.one(`SELECT count(*) c FROM items WHERE kind='note' AND status='archived'`)!.c as number) ?? 0;
    return { root: root ?? null, total: this.total("/"), direct: this.counts().get("/") ?? 0, archived, groups: this.cards("/"), bundles: await this.bundles("/") };
  }

  async group(id: string) {
    const g = this.groupRow(id);
    if (!g) return undefined;
    const path = g.p as string;
    const crumbs: { id: string; title: string }[] = [];
    for (let p = path; p !== "/"; ) {
      const row = this.one(`SELECT id, title FROM items WHERE kind='group' AND group_path=? AND status='active'`, p);
      if (row) crumbs.unshift({ id: row.id as string, title: row.title as string });
      p = p.replace(/[^/]+\/$/, "");
    }
    const root = this.one(`SELECT id, title FROM items WHERE kind='group' AND group_path='/'`);
    if (root && path !== "/") crumbs.unshift({ id: root.id as string, title: root.title as string });
    const types = this.all(`SELECT type, count(*) c FROM items WHERE kind='note' AND status='active' AND group_path=? GROUP BY type ORDER BY c DESC`, path);
    const tagRows = this.all(
      `SELECT i.type ty, t.tag, count(*) c FROM items i JOIN tags t ON t.item_id=i.id WHERE i.kind='note' AND i.status='active' AND i.group_path=? GROUP BY i.type, t.tag ORDER BY c DESC LIMIT 400`,
      path,
    );
    return {
      group: { id: g.id as string, title: g.title as string, summary: g.summary as string, path, updated: g.updated as string | null },
      crumbs,
      count: this.total(path),
      children: this.cards(path),
      bundles: await this.bundles(path),
      direct: {
        count: this.counts().get(path) ?? 0,
        types: types.map((t) => ({ type: t.type as string, count: t.c as number, tags: tagRows.filter((x) => x.ty === t.type).slice(0, 8).map((x) => ({ tag: x.tag as string, count: x.c as number })) })),
      },
    };
  }

  /** De notities van één groep (direct erin), voor de banen van het itemniveau. */
  items(args: { group: string; type?: string; tag?: string; limit?: number; offset?: number }) {
    const g = this.groupRow(args.group);
    if (!g) return undefined;
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    const offset = Math.max(args.offset ?? 0, 0);
    const where = [`i.kind='note'`, `i.status='active'`, `i.group_path=?1`];
    const params: SQLInputValue[] = [g.p as string];
    if (args.type) where.push(`i.type=?${params.push(args.type)}`);
    if (args.tag) where.push(`EXISTS (SELECT 1 FROM tags t WHERE t.item_id=i.id AND t.tag=?${params.push(args.tag)})`);
    const total = this.one(`SELECT count(*) c FROM items i WHERE ${where.join(" AND ")}`, ...params)!.c as number;
    const rows = this.all(`SELECT i.id, i.title, i.summary, i.type, i.updated, i.parent_id FROM items i WHERE ${where.join(" AND ")} ORDER BY i.updated DESC, i.id LIMIT ${limit} OFFSET ${offset}`, ...params);
    return {
      total,
      items: rows.map((r) => ({ id: r.id as string, title: r.title as string, summary: r.summary as string, type: r.type as string, updated: r.updated as string | null, parent: r.parent_id as string | null })),
    };
  }

  private fileOf(rel: string): string {
    const root = resolve(this.vault);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error("pad buiten kluis");
    return abs;
  }

  /** Eén item voor het zijpaneel: tekst (markdown, ruw; de browser maakt er veilig HTML van), tags, links en afbeeldingen. */
  item(id: string) {
    if (!ID.test(id)) return undefined;
    const it = this.one(`SELECT * FROM items WHERE id=?`, id);
    if (!it) return undefined;
    const title = (r: Row | undefined) => (r ? { id: r.id as string, title: r.title as string, kind: r.kind as string } : null);
    const out: { id: string; title: string; kind: string; type: string; broken?: boolean }[] = [];
    const inc: { id: string; title: string; kind: string; type: string }[] = [];
    for (const l of this.all(`SELECT l.dst id, l.type, l.inline FROM links l WHERE l.src=? ORDER BY l.inline, l.type LIMIT 100`, id)) {
      const t = title(this.one(`SELECT id, title, kind FROM items WHERE id=?`, l.id as string));
      out.push({ id: l.id as string, title: t?.title ?? "(bestaat niet meer)", kind: t?.kind ?? "note", type: l.inline ? "mentions" : (l.type as string), ...(t ? {} : { broken: true }) });
    }
    for (const l of this.all(`SELECT i.id, i.title, i.kind, l.type, l.inline FROM links l JOIN items i ON i.id=l.src WHERE l.dst=? ORDER BY l.inline, l.type LIMIT 100`, id)) {
      inc.push({ id: l.id as string, title: l.title as string, kind: l.kind as string, type: l.inline ? "mentions" : (l.type as string) });
    }
    let body = "";
    if (it.status !== "broken") {
      try {
        body = matter(readFileSync(this.fileOf(it.path as string), "utf8"), {}).content;
      } catch {
        body = "";
      }
    }
    const tags = this.all(`SELECT tag FROM tags WHERE item_id=?`, id).map((t) => t.tag as string);
    const kids = this.all(`SELECT id, title FROM items WHERE parent_id=? AND status!='broken' ORDER BY title LIMIT 50`, id).map((k) => ({ id: k.id as string, title: k.title as string }));
    return {
      id,
      kind: it.kind as string,
      type: it.type as string,
      title: it.title as string,
      summary: it.summary as string,
      status: it.status as string,
      error: it.error as string | null,
      group: it.group_path as string,
      groupId: (this.one(`SELECT id FROM items WHERE kind='group' AND group_path=? AND status='active'`, it.group_path as string)?.id as string | undefined) ?? null,
      parent: it.parent_id as string | null,
      created: it.created as string | null,
      updated: it.updated as string | null,
      width: it.width as number | null,
      height: it.height as number | null,
      tags,
      body,
      children: kids,
      links: out,
      backlinks: inc,
      images: out.filter((l) => l.kind === "image").map((l) => l.id),
    };
  }

  // ---------- dashboard en logs ----------
  /** Wijzigt zodra de index verandert; de live-stream vergelijkt dit. */
  indexVersion() {
    return this.version();
  }

  private pathTitle(path: string): string {
    const parts: string[] = [];
    for (let p = path; p !== "/" && p; p = p.replace(/[^/]+\/$/, "")) {
      const t = this.one(`SELECT title FROM items WHERE kind='group' AND group_path=? AND status='active'`, p)?.title as string | undefined;
      if (t) parts.unshift(t);
    }
    return parts.join(" › ");
  }
  private logRows(sql: string, ...p: SQLInputValue[]): Row[] {
    return (this.logs?.prepare(sql).all(...p) ?? []) as Row[];
  }

  // De groeigrafiek leest alle notities (geen index op `created`): hooguit elke 60 s opnieuw, ook als de index vaker verandert.
  private growthAt?: { t: number; g: { day: string; n: number }[] };
  private growth() {
    if (this.growthAt && Date.now() - this.growthAt.t < 60_000) return this.growthAt.g;
    const since = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const per = new Map<string, number>();
    for (const r of this.all(`SELECT substr(created,1,10) d, count(*) n FROM items WHERE kind='note' AND created >= ? GROUP BY d`, since)) per.set(r.d as string, r.n as number);
    const g = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10);
      return { day: d, n: per.get(d) ?? 0 };
    });
    this.growthAt = { t: Date.now(), g };
    return g;
  }

  /** Eén blik: aantallen, groei, tokenbesparing, groepen, recente activiteit en "waar was ik" (uit het audit log). */
  dashboard() {
    const stats = (() => {
      const c = new Map<string, number>();
      for (const r of this.all(`SELECT kind || ':' || status k, count(*) n FROM items GROUP BY kind, status`)) c.set(r.k as string, r.n as number);
      const growth = this.growth();
      return {
        notes: c.get("note:active") ?? 0,
        archived: c.get("note:archived") ?? 0,
        images: c.get("image:active") ?? 0,
        groups: c.get("group:active") ?? 0,
        broken: [...c].filter(([k]) => k.endsWith(":broken")).reduce((a, [, n]) => a + n, 0),
        last30: growth.reduce((a, g) => a + g.n, 0),
        growth,
      };
    })();
    const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
    const tok = this.logRows(`SELECT sum(tokens_out) o, sum(tokens_full) f FROM audit WHERE ts >= ? AND tokens_full IS NOT NULL AND tokens_out IS NOT NULL`, since7)[0];
    const groups = this.cards("/").sort((a, b) => b.count - a.count).slice(0, 8);
    return { stats, tokens: { out: (tok?.o as number | null) ?? 0, full: (tok?.f as number | null) ?? 0 }, groups, recent: this.recent(), whereWasI: this.whereWasI(), searches: this.lastSearches() };
  }

  private parseArgs(s: unknown): Record<string, unknown> {
    try {
      const v = JSON.parse(String(s)) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  private idsOf(s: unknown): string[] {
    try {
      return (JSON.parse(String(s ?? "[]")) as string[]).filter((x) => ID.test(x));
    } catch {
      return [];
    }
  }
  private titleOf(id: string) {
    const r = this.one(`SELECT id, title, kind, group_path p FROM items WHERE id=?`, id);
    return r ? { id, title: r.title as string, kind: r.kind as string, path: r.p as string } : undefined;
  }

  private recent() {
    const rows = this.logRows(
      `SELECT id, ts, actor, tool, args, ids, ok, note FROM audit WHERE tool IN ('brain_write','brain_organize','brain_image','ui_delete') ORDER BY id DESC LIMIT 12`,
    );
    return rows.map((r) => {
      const a = this.parseArgs(r.args), ids = this.idsOf(r.ids), first = ids[0] ? this.titleOf(ids[0]) : undefined;
      const label = (a.title as string | undefined) ?? first?.title ?? String(r.note ?? "").split("\n")[0]!.replace(/^[nig]_[0-9a-z]{8} "/, "").replace(/".*$/, "") ?? "";
      return { id: r.id as number, ts: r.ts as string, actor: r.actor as string, tool: r.tool as string, action: (a.action as string | undefined) ?? "", ok: r.ok === 1, label, itemId: first?.id ?? null, where: first ? this.pathTitle(first.path) : "" };
    });
  }
  private lastSearches() {
    const seen = new Set<string>();
    for (const r of this.logRows(`SELECT args FROM audit WHERE tool='brain_find' AND actor='claude' ORDER BY id DESC LIMIT 60`)) {
      const q = this.parseArgs(r.args).query;
      if (typeof q === "string" && q.trim()) seen.add(q.trim());
      if (seen.size >= 5) break;
    }
    return [...seen];
  }
  /** De laatste sessie van Claude: een reeks aanroepen met nooit meer dan 30 minuten tussen twee aanroepen. */
  private whereWasI() {
    const rows = this.logRows(`SELECT ts, tool, args, ids, ok FROM audit WHERE actor='claude' ORDER BY id DESC LIMIT 3000`);
    if (!rows.length) return null;
    const GAP = 30 * 60_000;
    const sess = [rows[0]!];
    for (let i = 1; i < rows.length && Date.parse(rows[i - 1]!.ts as string) - Date.parse(rows[i]!.ts as string) <= GAP; i++) sess.push(rows[i]!);
    const out = { start: sess.at(-1)!.ts as string, end: sess[0]!.ts as string, calls: sess.length, created: 0, changed: 0, images: 0, archived: 0, deleted: 0, searches: 0 };
    const touched: string[] = [], paths = new Map<string, number>();
    for (const r of sess) {
      if (r.ok !== 1) continue;
      const a = this.parseArgs(r.args).action;
      if (r.tool === "brain_find") {
        out.searches++;
        continue; // gevonden items zijn niet "aangeraakt"
      } else if (r.tool === "brain_image") out.images++;
      else if (r.tool === "brain_write") out[a === "create" ? "created" : "changed"]++;
      else if (r.tool === "brain_organize") out[a === "archive" ? "archived" : a === "delete" ? "deleted" : "changed"]++;
      else continue;
      for (const id of this.idsOf(r.ids)) if (!touched.includes(id)) touched.push(id);
    }
    const items = touched.map((id) => this.titleOf(id)).filter((x) => x !== undefined).slice(0, 6);
    for (const it of items) paths.set(it.path, (paths.get(it.path) ?? 0) + 1);
    const top = [...paths].sort((a, b) => b[1] - a[1])[0]?.[0];
    const last = items.find((i) => i.kind !== "group") ?? items[0];
    const groupId = last ? ((this.one(`SELECT id FROM items WHERE kind='group' AND group_path=?`, last.path)?.id as string | undefined) ?? null) : null;
    return { ...out, where: top ? this.pathTitle(top) : "", touched: items.map((i) => ({ id: i.id, title: i.title, kind: i.kind })), last: last ? { id: last.id, groupId } : null };
  }

  /** Doorzoekbaar, alleen-lezen logboek (nieuwste eerst). UI-leesverzoeken staan er standaard niet bij. */
  logPage(o: { q?: string; actor?: string; ok?: boolean; since?: string; before?: number; limit?: number; reads?: boolean }) {
    const where: string[] = [], p: SQLInputValue[] = [];
    if (!o.reads) where.push(`NOT (actor='ui' AND tool != 'ui_delete')`);
    if (o.actor) { where.push(`actor = ?`); p.push(o.actor); }
    if (o.ok === false) where.push(`ok = 0`);
    if (o.since) { where.push(`ts >= ?`); p.push(o.since); }
    if (o.before) { where.push(`id < ?`); p.push(o.before); }
    if (o.q) {
      const like = `%${o.q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(`(tool LIKE ? ESCAPE '\\' OR args LIKE ? ESCAPE '\\' OR ids LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR client LIKE ? ESCAPE '\\')`);
      p.push(like, like, like, like, like);
    }
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    const rows = this.logRows(`SELECT id, ts, actor, client, tool, args, ids, ok, ms, tokens_out, tokens_full, note FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit + 1}`, ...p);
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => ({ id: r.id as number, ts: r.ts as string, actor: r.actor as string, client: r.client as string | null, tool: r.tool as string, args: r.args as string | null, ids: this.idsOf(r.ids), ok: r.ok === 1, ms: r.ms as number | null, tokensOut: r.tokens_out as number | null, tokensFull: r.tokens_full as number | null, note: r.note as string | null }));
    return { rows: page, next: more ? page.at(-1)!.id : null };
  }

  /** Wat er met dit item of deze groep verdwijnt, voor de bevestiging vóór het verwijderen. */
  deletePreview(id: string) {
    const it = ID.test(id) ? this.one(`SELECT id, kind, title, group_path p, status FROM items WHERE id=?`, id) : undefined;
    if (!it) return undefined;
    const isGroup = it.kind === "group", path = it.p as string;
    const [lo, hi] = range(path);
    const inGroup = isGroup ? this.one(`SELECT sum(kind='note') notes, sum(kind='image') images, sum(kind='group') groups FROM items WHERE group_path >= ? AND group_path < ?`, lo, hi) : undefined;
    const inbound = (isGroup
      ? this.one(`SELECT count(DISTINCT l.src) n FROM links l JOIN items d ON d.id = l.dst JOIN items s ON s.id = l.src WHERE d.group_path >= ?1 AND d.group_path < ?2 AND NOT (s.group_path >= ?1 AND s.group_path < ?2)`, lo, hi)
      : this.one(`SELECT count(DISTINCT src) n FROM links WHERE dst = ?`, id))!.n as number;
    return {
      id, kind: it.kind as string, title: it.title as string, root: isGroup && path === "/",
      notes: isGroup ? (inGroup!.notes as number) ?? 0 : it.kind === "note" ? 1 : 0,
      images: isGroup ? (inGroup!.images as number) ?? 0 : it.kind === "image" ? 1 : 0,
      groups: isGroup ? Math.max(0, ((inGroup!.groups as number) ?? 1) - 1) : 0,
      inbound,
    };
  }

  /** Zoeken met dezelfde querytaal als Claude; afbeeldingen horen niet in het heelal en blijven buiten beeld. */
  search(q: string, limit = 30) {
    const r = this.brain.rows({ query: `kind:note ${q}`.trim(), limit: Math.min(Math.max(limit, 1), 100) });
    if ("text" in r) return { error: r.text.replace(/^ERROR\s+/, ""), total: 0, hits: [] };
    return {
      total: r.total,
      hits: r.rows.map((x) => ({ id: x.id as string, title: x.title as string, summary: x.summary as string, group: x.group_path as string, slug: (x.slug as string | null) ?? null })),
    };
  }

  /** Afbeelding voor de leesweergave: pad uit de index (nooit uit de aanvraag), type uit de bytes zelf. */
  image(id: string): { data: Buffer; mime: string } | undefined {
    if (!ID.test(id)) return undefined;
    const it = this.one(`SELECT path, kind, status FROM items WHERE id=?`, id);
    if (!it || it.kind !== "image" || it.status === "broken") return undefined;
    try {
      const data = readFileSync(this.fileOf((it.path as string).replace(/\.md$/, "")));
      const k = sniff(data);
      return k ? { data, mime: k.mime } : undefined;
    } catch {
      return undefined;
    }
  }
}
