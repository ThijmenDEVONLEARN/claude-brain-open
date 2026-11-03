import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import matter from "gray-matter";
import { sniff } from "./image";
import { estimateTokens, parseGroup, parseImage, parseNote, type Section } from "./parse";
import { compile, QueryError } from "./query";

export { QueryError };
/** Tekst voor Claude (kort, geen JSON) plus de id's die geraakt zijn, voor de audit log. */
export type Result = { text: string; ids: string[]; note?: string; image?: { data: string; mime: string } };

const ID = /^[nig]_[0-9a-z]{8}$/;
const COUNT_CAP = 1000;
// shortcut: bij zeer algemene woorden ranken we alleen de beste FTS_CAP treffers per index (snelheid op 300k notities); verfijn de zoekterm of voeg filters toe.
const FTS_CAP = 200;

type Row = Record<string, string | number | null>;
const err = (code: string, msg: string): Result => ({ text: `ERROR ${code} ${msg}`, ids: [] });
const prefixRange = (p: string): [string, string] => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const groupLabel = (p: string) => (p === "/" ? "/" : p.replace(/^\/|\/$/g, ""));

export class Brain {
  constructor(
    private db: DatabaseSync,
    private vaultDir: string,
  ) {}

  private all(sql: string, ...p: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private one(sql: string, ...p: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }

  // ---------------------------------------------------------------- brain_map
  map(args: { group?: string; depth?: number } = {}): Result {
    const depth = Math.min(Math.max(args.depth ?? 1, 1), 5);
    const counts = new Map<string, number>();
    for (const r of this.all(`SELECT group_path p, count(*) c FROM items WHERE kind='note' AND status='active' GROUP BY group_path`)) counts.set(r.p as string, r.c as number);
    const archived = (this.one(`SELECT count(*) c FROM items WHERE kind='note' AND status='archived'`)!.c as number) ?? 0;
    const total = (path: string) => {
      let n = 0;
      for (const [p, c] of counts) if (p.startsWith(path)) n += c;
      return n;
    };
    const groups = this.all(`SELECT id, title, summary, group_path p FROM items WHERE kind='group' AND status='active' ORDER BY group_path`);
    const lines: string[] = [];
    const ids: string[] = [];

    let base = "/";
    const want = args.group;
    if (want) {
      const g = ID.test(want) ? groups.find((x) => x.id === want) : groups.find((x) => x.p === `/${want.replace(/^\/+|\/+$/g, "")}/`);
      if (!g) return err("not_found", `groep ${want}`);
      base = g.p as string;
      ids.push(g.id as string);
      lines.push(`${groupLabel(base)}  ${g.id}  ${g.title} · ${total(base)} notities (${counts.get(base) ?? 0} direct)`, `  ${g.summary}`);
    } else {
      lines.push(`/ · ${total("/")} notities actief, ${archived} in archief`);
    }

    const baseDepth = base === "/" ? 0 : base.split("/").length - 2;
    const subs = groups.filter((x) => {
      const p = x.p as string;
      if (p === base || !p.startsWith(base)) return false;
      return p.split("/").length - 2 - baseDepth <= depth;
    });
    const MAX = 30;
    for (const s of subs.slice(0, MAX)) {
      const p = s.p as string;
      const indent = "  ".repeat(p.split("/").length - 2 - baseDepth);
      ids.push(s.id as string);
      lines.push(`${indent}${groupLabel(p)}  ${s.id}  ${s.title} · ${total(p)} — ${cut(s.summary as string, 60)}`);
    }
    if (subs.length > MAX) lines.push(`… nog ${subs.length - MAX} groepen niet getoond (geef group= of een kleinere depth=)`);

    if (args.group) {
      const [lo, hi] = prefixRange(base);
      const tags = this.all(
        `SELECT t.tag, count(*) c FROM tags t JOIN items i ON i.id=t.item_id WHERE i.group_path >= ? AND i.group_path < ? AND i.status='active' GROUP BY t.tag ORDER BY c DESC LIMIT 8`,
        lo, hi,
      );
      if (tags.length) lines.push(`tags: ${tags.map((t) => `${t.tag}(${t.c})`).join(" ")}`);
      const recent = this.all(
        `SELECT id, title, updated FROM items WHERE kind='note' AND status='active' AND group_path >= ? AND group_path < ? ORDER BY updated DESC LIMIT 5`,
        lo, hi,
      );
      if (recent.length) lines.push("recent:", ...recent.map((r) => `  ${r.id}  ${cut(r.title as string, 60)}  ${(r.updated as string).slice(0, 10)}`));
    }
    return { text: lines.join("\n"), ids };
  }

  // --------------------------------------------------------------- brain_find
  /** De gedeelde zoekstap van brain_find en de UI: de rijen die bij een query horen, of een foutmelding. */
  rows(args: { query: string; limit?: number; cursor?: string; budget?: number }) {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const budgetChars = (args.budget ?? 1500) * 4;
    let offset = 0;
    if (args.cursor) {
      const m = /^c(\d{1,7})$/.exec(args.cursor);
      if (!m) return err("invalid_cursor", args.cursor);
      offset = Number(m[1]);
    }
    let plan;
    try {
      plan = compile(args.query);
    } catch (e) {
      if (e instanceof QueryError) return err("invalid_query", e.message);
      throw e;
    }

    const params: SQLInputValue[] = [...plan.params];
    const ph = (v: SQLInputValue) => `?${params.push(v)}`;
    const order = {
      relevance: plan.fts ? "best.score, i.id" : "i.updated DESC, i.id",
      updated: "i.updated DESC, i.id",
      created: "i.created DESC, i.id",
      title: "i.title COLLATE NOCASE, i.id",
    }[plan.sort];

    let from: string;
    let cols = "NULL AS slug";
    if (plan.fts) {
      const m = ph(plan.fts);
      from = `WITH hits AS (
          SELECT * FROM (SELECT s.item_id AS id, s.slug AS slug, f.rank AS score FROM fts_sections f JOIN sections s ON s.id = f.rowid WHERE fts_sections MATCH ${m} ORDER BY f.rank LIMIT ${FTS_CAP})
          UNION ALL
          SELECT * FROM (SELECT i.id, NULL, f.rank * 1.5 FROM fts_items f JOIN items i ON i.rowid = f.rowid WHERE fts_items MATCH ${m} ORDER BY f.rank LIMIT ${FTS_CAP})
        ), best AS (SELECT id, slug, min(score) AS score FROM hits GROUP BY id)
        SELECT %COLS% FROM best JOIN items i ON i.id = best.id`;
      cols = "best.slug AS slug";
    } else from = `SELECT %COLS% FROM items i`;

    const select = (c: string) => from.replace("%COLS%", c);
    const colsAll = `i.id, i.kind, i.title, i.summary, i.group_path, i.tokens_est, ${cols}`;
    let rows: Row[];
    let total: number;
    try {
      if (plan.fts) {
        // Max 2×FTS_CAP kandidaten: alles ophalen en in JS pagineren is sneller dan een tweede telquery.
        const all = this.all(`${select(colsAll)} WHERE ${plan.where} ORDER BY ${order}`, ...params);
        total = all.length;
        rows = all.slice(offset, offset + limit);
      } else {
        rows = this.all(`${select(colsAll)} WHERE ${plan.where} ORDER BY ${order} LIMIT ${ph(limit)} OFFSET ${ph(offset)}`, ...params);
        const cp = params.slice(0, params.length - 2);
        total = this.one(`SELECT count(*) c FROM (${select("1")} WHERE ${plan.where} LIMIT ${COUNT_CAP + 1})`, ...cp)!.c as number;
      }
    } catch (e) {
      if (/fts5|syntax/i.test((e as Error).message)) return err("invalid_query", "zoekterm niet bruikbaar");
      throw e;
    }
    return { rows, total, offset, plan, budgetChars };
  }

  find(args: { query: string; limit?: number; cursor?: string; budget?: number }): Result {
    const q = this.rows(args);
    if ("text" in q) return q;
    const { rows, total, offset, plan, budgetChars } = q;
    const head = (to: number, more: boolean, truncated: boolean) =>
      `${total > COUNT_CAP ? `${COUNT_CAP}+` : total} resultaten${rows.length ? ` (${offset + 1}–${to})` : ""}${more ? ` · cursor:c${to}` : ""}${truncated ? " · gekapt op budget" : ""}${plan.statusExplicit ? "" : " · archief verborgen"}`;
    const out: string[] = [];
    const ids: string[] = [];
    let used = 0;
    let shown = 0;
    for (const r of rows) {
      const kind = r.kind === "note" ? "" : ` [${r.kind}]`;
      const line = `${r.id}  ${r.title}${kind}  ${groupLabel(r.group_path as string)}${r.slug ? `  §${r.slug}` : ""}  ~${r.tokens_est}t\n  ${cut(r.summary as string, 160)}`;
      if (shown > 0 && used + line.length > budgetChars) break;
      used += line.length;
      out.push(line);
      ids.push(r.id as string);
      shown++;
    }
    const to = offset + shown;
    const more = shown < rows.length || total > to;
    return { text: [head(to, more && shown > 0, shown < rows.length), ...out].join("\n"), ids };
  }

  // --------------------------------------------------------------- brain_read
  read(args: { ids: string[]; view?: "meta" | "outline" | "section" | "full" | "image"; section?: string }): Result {
    const view = args.view ?? "outline";
    if (view === "image") return this.readImage(args.ids);
    if (view === "section" && !args.section) return err("invalid_args", "view=section heeft section= nodig (slug of nummer)");
    const blocks: string[] = [];
    const ids: string[] = [];
    for (const id of args.ids.slice(0, 10)) {
      if (!ID.test(id)) {
        blocks.push(`ERROR invalid_id ${id}`);
        continue;
      }
      const item = this.one(`SELECT * FROM items WHERE id = ?`, id);
      if (!item) {
        blocks.push(`ERROR not_found ${id}`);
        continue;
      }
      ids.push(id);
      blocks.push(this.readOne(item, view, args.section));
    }
    return { text: blocks.join("\n---\n"), ids };
  }

  /** De pixels zelf, als MCP-afbeelding. Max 5 MB, want Claude betaalt tokens naar afmeting. */
  private readImage(ids: string[]): Result {
    if (ids.length !== 1) return err("invalid_args", "view=image werkt met precies één id");
    const id = ids[0]!;
    const item = ID.test(id) ? this.one(`SELECT * FROM items WHERE id = ?`, id) : undefined;
    if (!item) return err("not_found", id);
    if (item.kind !== "image" || item.status === "broken") return err("invalid_args", `${id} is geen afbeelding`);
    const MAX = 5 * 1024 * 1024;
    let buf: Buffer;
    try {
      const file = this.fileOf({ path: (item.path as string).replace(/\.md$/, "") });
      if (statSync(file).size > MAX) return err("too_large", `${id} is ${item.width}×${item.height}, groter dan 5 MB; lees de beschrijving (view=meta)`);
      buf = readFileSync(file);
    } catch {
      return err("file_missing", `${id}: het afbeeldingsbestand ontbreekt`);
    }
    const kind = sniff(buf);
    if (!kind) return err("broken_file", `${id} is geen herkenbare afbeelding`);
    return { text: `${id}  ${item.title}  [image ${item.width ?? "?"}×${item.height ?? "?"}, ${Math.round(buf.length / 1024)} kB]
  ${item.summary}`, ids: [id], image: { data: buf.toString("base64"), mime: kind.mime } };
  }

  private fileOf(item: Row): string {
    const root = resolve(this.vaultDir);
    const abs = resolve(root, item.path as string);
    // Het pad komt uit de index, maar we lezen nooit buiten de kluis.
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error("pad buiten kluis");
    return abs;
  }

  private readOne(item: Row, view: string, section?: string): string {
    const id = item.id as string;
    if (item.status === "broken") return `${id}  KAPOT  ${item.path}\n  ${item.error}`;

    let raw: string;
    try {
      raw = readFileSync(this.fileOf(item), "utf8");
    } catch {
      return `ERROR file_missing ${id} (${item.path}); draai brain rebuild`;
    }
    const rev = createHash("sha1").update(raw).digest("hex").slice(0, 16);
    const stale = rev !== item.hash;
    // Gewijzigd sinds de index? Dan lezen we de bestaande secties live, tot de index is bijgewerkt.
    let body = matter(raw, {}).content;
    let sections: Section[];
    if (stale) {
      try {
        const p = item.kind === "group" ? parseGroup(raw) : item.kind === "image" ? parseImage(raw) : parseNote(raw);
        body = p.body;
        sections = p.sections;
      } catch (e) {
        return `ERROR broken_file ${id} ${(e as Error).message}`;
      }
    } else {
      sections = this.all(`SELECT ord, heading, slug, level, start, end, tokens_est tokens FROM sections WHERE item_id = ? ORDER BY ord`, id) as unknown as Section[];
    }

    const staleNote = stale ? "\n! bestand is gewijzigd sinds de index (nog niet bijgewerkt)" : "";
    const dims = item.kind === "image" ? ` ${item.width ?? "?"}×${item.height ?? "?"}` : "";
    const head = `${id}  ${item.title}  [${item.kind}${dims}${item.status === "archived" ? ", archief" : ""}]  rev:${rev}  ~${estimateTokens(body.length)}t${staleNote}`;

    if (view === "full") return `${head}\n${body.trimEnd()}`;
    if (view === "section") {
      const s = sections.find((x) => x.slug === section || String(x.ord) === section);
      if (!s) return `ERROR not_found_section ${id} §${section} (kies uit: ${sections.map((x) => x.slug || "0").join(", ") || "geen secties"})`;
      return `${head}  §${s.slug || "intro"}\n${body.slice(s.start, s.end).trimEnd()}`;
    }

    const lines = [head, `  ${item.summary}`];
    if (view === "meta") {
      const tags = this.all(`SELECT tag FROM tags WHERE item_id = ?`, id).map((t) => t.tag);
      const out = this.all(`SELECT dst, type FROM links WHERE src = ? AND inline = 0`, id);
      lines.push(
        `groep: ${groupLabel(item.group_path as string)}${item.parent_id ? `  parent: ${item.parent_id}` : ""}`,
        `tags: ${tags.join(" ") || "-"}`,
        `links: ${out.map((l) => `${l.type}→${l.dst}`).join(" ") || "-"}`,
        `aangemaakt: ${item.created ?? "-"}  bijgewerkt: ${item.updated ?? "-"}`,
      );
    } else {
      lines.push(...sections.map((s) => `  ${"  ".repeat(Math.max(s.level - 1, 0))}§${s.slug || "intro"}  ${s.heading || "(intro)"}  ~${s.tokens}t`));
    }
    return lines.join("\n");
  }

  // ------------------------------------------------------------ brain_related
  related(args: { id: string; depth?: number; types?: string[] }): Result {
    if (!ID.test(args.id)) return err("invalid_id", args.id);
    const me = this.one(`SELECT id, title, parent_id FROM items WHERE id = ?`, args.id);
    if (!me) return err("not_found", args.id);
    const depth = Math.min(Math.max(args.depth ?? 1, 1), 3);
    const types = args.types?.length ? args.types : null;
    const typeSql = types ? ` AND l.type IN (${types.map(() => "?").join(",")})` : "";
    const tp = types ?? [];
    const line = (r: Row, extra = "") => `  ${r.id}  ${cut((r.title as string) ?? "(kapot)", 60)}${extra}`;
    const LIM = 20;
    const ids = [args.id];
    const lines = [`${me.id}  ${me.title}`];

    const parent = me.parent_id ? this.one(`SELECT id, title FROM items WHERE id = ?`, me.parent_id as string) : undefined;
    if (parent) lines.push("parent:", line(parent));
    const kids = this.all(`SELECT id, title FROM items WHERE parent_id = ? AND status != 'broken' ORDER BY title LIMIT ${LIM + 1}`, args.id);
    if (kids.length) lines.push(`children${kids.length > LIM ? " (eerste 20)" : ""}:`, ...kids.slice(0, LIM).map((k) => line(k)));
    const outL = this.all(
      `SELECT i.id, i.title, l.type, l.inline FROM links l LEFT JOIN items i ON i.id = l.dst WHERE l.src = ?${typeSql} ORDER BY l.inline, l.type LIMIT ${LIM + 1}`,
      args.id, ...tp,
    );
    if (outL.length) lines.push(`uitgaand${outL.length > LIM ? " (eerste 20)" : ""}:`, ...outL.slice(0, LIM).map((r) => line(r, `  [${r.type}]`)));
    const inL = this.all(
      `SELECT i.id, i.title, l.type FROM links l JOIN items i ON i.id = l.src WHERE l.dst = ?${typeSql} ORDER BY l.type LIMIT ${LIM + 1}`,
      args.id, ...tp,
    );
    if (inL.length) lines.push(`backlinks${inL.length > LIM ? " (eerste 20)" : ""}:`, ...inL.slice(0, LIM).map((r) => line(r, `  [${r.type}]`)));

    // Verder weg: breadth-first over links (beide richtingen) en parent/child.
    if (depth > 1) {
      const seen = new Set<string>([args.id]);
      let frontier = [args.id];
      for (let d = 1; d <= depth; d++) {
        const next: string[] = [];
        for (const f of frontier) {
          const nb = this.all(
            `SELECT dst x FROM links l WHERE src = ?${typeSql} UNION SELECT src FROM links l WHERE dst = ?${typeSql} UNION SELECT id FROM items WHERE parent_id = ? UNION SELECT parent_id FROM items WHERE id = ? AND parent_id IS NOT NULL`,
            f, ...tp, f, ...tp, f, f,
          );
          for (const n of nb) if (!seen.has(n.x as string)) {
            seen.add(n.x as string);
            next.push(n.x as string);
          }
        }
        if (d >= 2 && next.length) {
          lines.push(`diepte ${d}: ${next.length} items`);
          for (const nid of next.slice(0, 15)) {
            const it = this.one(`SELECT id, title FROM items WHERE id = ?`, nid);
            if (it) lines.push(line(it));
          }
          if (next.length > 15) lines.push(`  … +${next.length - 15} meer`);
        }
        frontier = next;
        if (seen.size > 500) break;
      }
      ids.push(...[...seen].slice(0, 50).filter((x) => x !== args.id));
    }
    if (lines.length === 1) lines.push("(geen relaties)");
    return { text: lines.join("\n"), ids };
  }
}

export const joinVault = (vault: string, rel: string) => join(vault, rel);
