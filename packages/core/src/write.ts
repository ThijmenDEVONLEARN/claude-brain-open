import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import matter from "gray-matter";
import { newId } from "./id";
import { sniff } from "./image";
import { estimateTokens, parseGroup, parseImage, parseNote } from "./parse";
import { Brain, type Result } from "./read";
import type { ImageMeta, NoteMeta } from "./schema";
import { dropPath, relocate, syncFile } from "./sync";

const ID = /^[nig]_[0-9a-z]{8}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}/_-]{0,59}$/u;
const MAX_NOTE = 2 * 1024 * 1024;
const MAX_BULK = 500;
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_CASCADE = 2000;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** Fout met een korte code die als `ERROR code melding` naar Claude gaat. */
class Fail extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg);
  }
}
const fail = (code: string, msg: string): never => {
  throw new Fail(code, msg);
};

const kindLetter = (id: string | undefined): "n" | "g" | "i" => (id?.startsWith("g_") ? "g" : id?.startsWith("i_") ? "i" : "n");

export const revOf = (raw: string) => createHash("sha1").update(raw).digest("hex").slice(0, 16);

/** Ascii-slug voor bestands- en mapnamen (veilig op Windows). */
export function slugFile(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return RESERVED.test(s) ? `${s}-x` : s || "item";
}

/** Schrijft naar een tijdelijk bestand in dezelfde map, fsync, en hernoemt: je ziet nooit een half bestand. */
export function atomicWrite(abs: string, content: string | Buffer): void {
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, typeof content === "string" ? Buffer.from(content) : content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

type Row = Record<string, string | number | null>;
export type WriteArgs = {
  action: "create" | "append" | "replace_section" | "str_replace" | "set_meta" | "link" | "unlink" | "set_parent";
  id?: string;
  if_rev?: string;
  title?: string;
  summary?: string;
  body?: string;
  group?: string;
  tags?: string[];
  type?: string;
  parent?: string;
  links?: { to: string; type?: string }[];
  text?: string;
  section?: string;
  old?: string;
  new?: string;
  to?: string;
  link_type?: string;
};
export type ImageArgs = {
  source?: string;
  base64?: string;
  title?: string;
  summary?: string;
  body?: string;
  group?: string;
  tags?: string[];
  parent?: string;
  links?: { to: string; type?: string }[];
};
export type OrganizeArgs = {
  action: "create_group" | "rename_group" | "move" | "archive" | "restore" | "merge" | "delete";
  id?: string;
  ids?: string[];
  query?: string;
  to?: string;
  from?: string;
  title?: string;
  summary?: string;
  confirm?: string[];
};

export class Writer {
  private brain: Brain;
  constructor(
    private db: DatabaseSync,
    private vault: string,
    private now: () => string = () => new Date().toISOString(),
    private opts: { imageRoots?: string[]; exclude?: string[] } = {},
  ) {
    this.brain = new Brain(db, vault);
  }

  // ------------------------------------------------------------ helpers
  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Row | undefined;
  }
  private need(id: string | undefined, kind?: "n" | "g" | "i"): Row {
    if (!id || !ID.test(id)) return fail("invalid_id", String(id));
    const r = this.row(id);
    if (!r) return fail("not_found", id);
    if (kind && !id.startsWith(`${kind}_`)) return fail("invalid_id", `${id} is geen ${kind === "n" ? "notitie" : kind === "g" ? "groep" : "afbeelding"}`);
    return r;
  }
  private abs(rel: string): string {
    const root = resolve(this.vault);
    const a = resolve(root, rel);
    if (a === root || !a.startsWith(root + sep)) return fail("forbidden", "pad buiten de kluis");
    return a;
  }
  /** Groep op id of pad (`werk/klanten`); leeg of `/` is de wortel. Geeft de map relatief aan de kluis. */
  private group(x: string | undefined): { dir: string; id: string | null; title: string } {
    if (!x || x === "/") {
      const r = this.db.prepare(`SELECT id, title FROM items WHERE kind='group' AND group_path='/' AND status != 'broken'`).get() as Row | undefined;
      return { dir: "", id: (r?.id as string) ?? null, title: (r?.title as string) ?? "/" };
    }
    const r = (ID.test(x)
      ? this.db.prepare(`SELECT id, title, group_path p FROM items WHERE id = ? AND kind='group' AND status != 'broken'`).get(x)
      : this.db.prepare(`SELECT id, title, group_path p FROM items WHERE kind='group' AND status != 'broken' AND group_path = ?`).get(`/${x.replace(/^\/+|\/+$/g, "")}/`)) as Row | undefined;
    if (!r) return fail("not_found", `groep ${x}`);
    return { dir: (r.p as string).slice(1, -1), id: r.id as string, title: r.title as string };
  }
  private text(s: unknown, name: string, max: number, min = 1): string {
    if (typeof s !== "string" || s.trim().length < min) return fail("invalid_args", `${name} ontbreekt`);
    if (s.length > max) return fail("too_large", `${name} is ${s.length} tekens (max ${max})`);
    return s.trim();
  }
  private tags(t: string[] | undefined): string[] {
    const out = [...new Set((t ?? []).map((x) => x.trim().toLowerCase()))];
    if (out.length > 30) fail("invalid_args", "max 30 tags");
    for (const x of out) if (!TAG.test(x)) fail("invalid_args", `tag "${x}" mag alleen letters, cijfers, - _ en / bevatten`);
    return out;
  }
  private target(id: string, what: string) {
    if (!ID.test(id) || !this.row(id)) fail("not_found", `${what} ${id}`);
  }

  /** Laadt het bestand van schijf (niet uit de index) en controleert `if_rev`. */
  private load(id: string | undefined, kind: "n" | "g" | "i", ifRev?: string) {
    const item = this.need(id, kind);
    if (item.status === "broken") fail("broken_file", `${id} is kapot: ${item.error}`);
    const abs = this.abs(item.path as string);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      return fail("file_missing", `${id} (${item.path}); draai brain rebuild`);
    }
    const rev = revOf(raw);
    if (ifRev && ifRev !== rev) fail("conflict", `${id} is gewijzigd; huidige rev=${rev}. Lees opnieuw.`);
    try {
      const p = kind === "g" ? parseGroup(raw) : kind === "i" ? parseImage(raw) : parseNote(raw);
      return { item, abs, rev, meta: p.meta as Record<string, unknown> & NoteMeta & ImageMeta, body: p.body, sections: p.sections };
    } catch (e) {
      return fail("broken_file", `${id} ${(e as Error).message}`);
    }
  }

  private serialize(meta: Record<string, unknown>, body: string, k: "n" | "g" | "i"): string {
    const m = meta as unknown as NoteMeta & ImageMeta;
    const group = k === "g";
    const data: Record<string, unknown> = group
      ? { id: m.id, title: m.title, summary: m.summary, ...(meta.color ? { color: meta.color } : {}), status: m.status }
      : {
          id: m.id,
          title: m.title,
          summary: m.summary,
          ...(m.type && m.type !== (k === "i" ? "image" : "note") ? { type: m.type } : {}),
          ...(m.tags?.length ? { tags: m.tags } : {}),
          ...(m.parent ? { parent: m.parent } : {}),
          ...(m.links?.length ? { links: m.links } : {}),
          status: m.status,
          created: m.created,
          updated: m.updated,
          ...(k === "i" ? { file: m.file, mime: m.mime, bytes: m.bytes, ...(m.width ? { width: m.width, height: m.height } : {}), hash: m.hash } : {}),
        };
    const out = matter.stringify(body.endsWith("\n") || body === "" ? body : `${body}\n`, data, {} as never);
    if (out.length > MAX_NOTE) fail("too_large", `bestand wordt ${out.length} bytes (max ${MAX_NOTE})`);
    return out;
  }

  /** Bestand atomisch schrijven en daarna de index bijwerken: in één synchrone stap, zonder gat ertussen. */
  private commit(rel: string, content: string): string {
    atomicWrite(this.abs(rel), content);
    syncFile(this.db, this.vault, rel);
    return revOf(content);
  }

  private ok(verb: string, id: string, rev: string, bodyLen: number, extra: string[] = []): Result {
    return { text: [`OK ${verb} ${id} rev=${rev} ~${estimateTokens(bodyLen)}t`, ...extra].join("\n"), ids: [id] };
  }

  private guard(fn: () => Result): Result {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Fail) return { text: `ERROR ${e.code} ${e.message}`, ids: [] };
      throw e;
    }
  }

  private uniqueName(dir: string, name: string): string {
    let n = name;
    for (let i = 2; existsSync(this.abs(join(dir, n))); i++) n = `${name}-${i}`;
    return n;
  }

  // ------------------------------------------------------------ brain_write
  write(a: WriteArgs): Result {
    return this.guard(() => {
      if (a.action === "create") return this.create(a);
      const k = kindLetter(a.id);
      const g = k === "g";
      if (g && a.action !== "set_meta") return fail("invalid_args", `${a.action} werkt alleen op notities en afbeeldingen`);
      const cur = this.load(a.id, k, a.if_rev);
      const updated = this.now();
      let body = cur.body;
      const meta = { ...cur.meta, updated } as Record<string, unknown> & NoteMeta;
      const pre = (s: string | undefined, name: string) => this.text(s, name, 200_000, 0);

      switch (a.action) {
        case "append": {
          const add = pre(a.text, "text");
          if (!add) fail("invalid_args", "text ontbreekt");
          if (a.section) {
            const s = this.section(cur.sections, a.section);
            const tail = body.slice(s.end).trimStart();
            body = `${body.slice(0, s.end).trimEnd()}\n\n${add}\n${tail ? `\n${tail}` : ""}`;
          } else body = `${body.trimEnd()}\n\n${add}\n`.replace(/^\n+/, "");
          break;
        }
        case "replace_section": {
          const s = this.section(cur.sections, a.section);
          if (!s.slug) fail("invalid_args", "de intro heeft geen kop; gebruik str_replace");
          const headLine = body.slice(s.start, body.indexOf("\n", s.start) < 0 ? s.end : body.indexOf("\n", s.start));
          body = `${body.slice(0, s.start)}${headLine}\n${pre(a.text, "text")}\n${s.end < body.length ? "\n" : ""}${body.slice(s.end)}`;
          break;
        }
        case "str_replace": {
          const old = this.text(a.old, "old", 100_000);
          const n = body.split(old).length - 1;
          if (n === 0) fail("not_found_text", "old komt niet voor in de tekst");
          if (n > 1) fail("ambiguous", `old komt ${n}× voor; maak het langer zodat het uniek is`);
          body = body.replace(old, () => a.new ?? "");
          break;
        }
        case "set_meta": {
          if (a.title !== undefined) meta.title = this.text(a.title, "title", 200);
          if (a.summary !== undefined) meta.summary = this.text(a.summary, "summary", 400);
          if (!g) {
            if (a.tags !== undefined) meta.tags = this.tags(a.tags);
            if (a.type !== undefined) meta.type = this.text(a.type, "type", 40);
          } else if (a.tags !== undefined || a.type !== undefined) fail("invalid_args", "groepen hebben geen tags of type");
          if (a.title === undefined && a.summary === undefined && a.tags === undefined && a.type === undefined) fail("invalid_args", "set_meta vraagt title, summary, tags of type");
          break;
        }
        case "link": {
          const to = a.to ?? "";
          this.target(to, "doel");
          const type = (a.link_type ?? "relates_to").trim();
          if (!/^[a-z][a-z0-9_]{0,39}$/.test(type)) fail("invalid_args", "link_type: kleine letters, cijfers en _");
          if (to === a.id) fail("invalid_args", "een item kan niet naar zichzelf linken");
          if (meta.links.some((l) => l.to === to && l.type === type)) return { text: `OK unchanged ${a.id} (link bestond al)`, ids: [a.id!] };
          meta.links = [...meta.links, { to, type }];
          break;
        }
        case "unlink": {
          const before = meta.links.length;
          meta.links = meta.links.filter((l) => !(l.to === a.to && (!a.link_type || l.type === a.link_type)));
          if (meta.links.length === before) fail("not_found", `geen link naar ${a.to}`);
          break;
        }
        case "set_parent": {
          if (a.parent) {
            this.target(a.parent, "parent");
            if (a.parent === a.id) fail("invalid_args", "een item kan niet zijn eigen parent zijn");
            for (let p: string | undefined = a.parent, i = 0; p && i < 200; i++) {
              if (p === a.id) fail("cycle", `${a.parent} stamt al af van ${a.id}`);
              p = (this.db.prepare(`SELECT parent_id p FROM items WHERE id = ?`).get(p) as { p: string | null } | undefined)?.p ?? undefined;
            }
            meta.parent = a.parent;
          } else delete meta.parent;
          break;
        }
        default:
          fail("invalid_args", `onbekende actie ${String(a.action)}`);
      }
      const content = this.serialize(meta, body, k);
      const rev = this.commit(cur.item.path as string, content);
      return this.ok(a.action, a.id!, rev, body.length);
    });
  }

  private section(sections: { slug: string; ord: number; start: number; end: number }[], key: string | undefined) {
    const s = sections.find((x) => x.slug === key || String(x.ord) === key);
    if (!s) return fail("not_found_section", `§${key} (kies uit: ${sections.map((x) => x.slug || "0").join(", ") || "geen secties"})`);
    return s;
  }

  private create(a: WriteArgs): Result {
    const title = this.text(a.title, "title", 200);
    const summary = this.text(a.summary, "summary", 400);
    const body = a.body ? this.text(a.body, "body", 200_000, 0) : "";
    const tags = this.tags(a.tags);
    const grp = this.group(a.group);
    const type = a.type ? this.text(a.type, "type", 40) : "note";
    if (a.parent) this.target(a.parent, "parent");
    const links = (a.links ?? []).map((l) => {
      this.target(l.to, "link-doel");
      return { to: l.to, type: l.type ?? "relates_to" };
    });
    // Bijna-dubbel? Alleen een waarschuwing: de nieuwe notitie wordt wel gemaakt.
    const similar = this.similar(title);

    let id = newId("note");
    while (this.row(id)) id = newId("note");
    const now = this.now();
    const meta = { id, title, summary, type, tags, parent: a.parent, links, status: "active", created: now, updated: now } as unknown as Record<string, unknown>;
    const rel = (grp.dir ? `${grp.dir}/` : "") + `${slugFile(title)}--${id}.md`;
    const rev = this.commit(rel, this.serialize(meta, body, "n"));
    const extra = [`  in ${grp.dir || "/"}${a.group ? "" : " (geen group opgegeven: wortel)"}`];
    if (summary.length > 200) extra.push("! samenvatting is lang (>200 tekens); korter is zuiniger bij zoeken");
    for (const s of similar) extra.push(`! lijkt op ${s.id} "${s.title}": gebruik daar append/replace_section als het hetzelfde onderwerp is`);
    return this.ok("created", id, rev, body.length, extra);
  }

  /** Bijna-dubbele titels: zoek op de twee zeldzaamste woorden (via de woordfrequenties) en vergelijk dan woordverzamelingen. */
  private similar(title: string): Row[] {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    const words = [...new Set(norm(title))];
    if (!words.length) return [];
    const freq = this.db.prepare(`SELECT term, doc FROM fts_items_v WHERE term IN (${words.map(() => "?").join(",")})`).all(...words) as { term: string; doc: number }[];
    const seen = new Map(freq.map((f) => [f.term, f.doc]));
    // Een woord dat nog nergens voorkomt kan ook nergens dubbel zijn.
    if (words.some((x) => !seen.has(x)) && words.length === 1) return [];
    const rare = [...words].sort((a, b) => (seen.get(a) ?? 0) - (seen.get(b) ?? 0)).slice(0, 2);
    const cands = this.db
      .prepare(`SELECT i.id, i.title FROM fts_items f JOIN items i ON i.rowid = f.rowid WHERE fts_items MATCH ? AND i.kind='note' AND i.status='active' LIMIT 30`)
      .all(`title : (${rare.map((x) => `"${x}"`).join(" AND ")})`) as Row[];
    const mine = new Set(words);
    return cands
      .filter((c) => {
        const theirs = new Set(norm(c.title as string));
        const both = [...mine].filter((x) => theirs.has(x)).length;
        return both / (mine.size + theirs.size - both) >= 0.6; // overlap van woorden (Jaccard)
      })
      .slice(0, 3);
  }

  // ------------------------------------------------------------ brain_image
  /** Een toegestaan bronbestand: binnen een van `imageRoots`, niet in `exclude` (bijv. de ClaudeBrain-map met het token). */
  private readSource(source: string): Buffer {
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const inside = (p: string, root: string) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + sep);
    let real: string;
    try {
      real = realpathSync(source); // volgt symlinks, zodat een koppeling naar buiten niet helpt
    } catch {
      return fail("not_found", `bronbestand ${source}`);
    }
    const roots = (this.opts.imageRoots ?? []).filter(existsSync).map((r) => realpathSync(r));
    if (!roots.some((r) => inside(real, r))) fail("forbidden", "dit pad valt buiten de toegestane mappen (imageRoots in config.json); stuur de afbeelding anders als base64");
    if ((this.opts.exclude ?? []).filter(existsSync).some((x) => inside(real, realpathSync(x)))) fail("forbidden", "dit pad is niet toegestaan");
    const st = statSync(real);
    if (!st.isFile()) fail("invalid_args", "bron is geen bestand");
    if (st.size > MAX_IMAGE) fail("too_large", `afbeelding is ${Math.round(st.size / 1048576)} MB (max 25 MB)`);
    return readFileSync(real);
  }

  image(a: ImageArgs): Result {
    return this.guard(() => {
      if (!a.source === !a.base64) fail("invalid_args", "geef source (pad) óf base64");
      const title = this.text(a.title, "title", 200);
      const summary = this.text(a.summary, "summary", 400); // de beschrijving is wat Claude later doorzoekt
      const tags = this.tags(a.tags);
      const grp = this.group(a.group);
      if (a.parent) this.target(a.parent, "parent");
      const links = (a.links ?? []).map((l) => {
        this.target(l.to, "link-doel");
        return { to: l.to, type: l.type ?? "relates_to" };
      });
      let buf: Buffer;
      if (a.source) buf = this.readSource(a.source);
      else {
        const raw = a.base64!.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
        if (raw.length > Math.ceil((MAX_IMAGE * 4) / 3) + 4) fail("too_large", "afbeelding is groter dan 25 MB");
        buf = Buffer.from(raw, "base64");
      }
      if (!buf.length || buf.length > MAX_IMAGE) fail("too_large", "lege afbeelding of groter dan 25 MB");
      const kind = sniff(buf);
      if (!kind) return fail("invalid_image", "alleen png, jpeg, gif en webp worden herkend (svg kan scripts bevatten en wordt geweigerd)");

      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 32);
      const same = this.db.prepare(`SELECT id, title FROM items WHERE file_hash = ? LIMIT 3`).all(hash) as Row[];
      let id = newId("image");
      while (this.row(id)) id = newId("image");
      const now = this.now();
      const file = `${slugFile(title)}--${id}.${kind.ext}`;
      const rel = (grp.dir ? `${grp.dir}/` : "") + file;
      const meta = { id, title, summary, type: "image", tags, parent: a.parent, links, status: "active", created: now, updated: now, file, mime: kind.mime, bytes: buf.length, width: kind.width, height: kind.height, hash } as unknown as Record<string, unknown>;
      const sidecar = this.serialize(meta, a.body ? this.text(a.body, "body", 200_000, 0) : "", "i");
      atomicWrite(this.abs(rel), buf);
      let rev: string;
      try {
        rev = this.commit(`${rel}.md`, sidecar);
      } catch (e) {
        rmSync(this.abs(rel), { force: true }); // geen los plaatje zonder sidecar achterlaten
        throw e;
      }
      const extra = [`  ${kind.width ?? "?"}×${kind.height ?? "?"} ${kind.ext}, ${Math.round(buf.length / 1024)} kB, in ${grp.dir || "/"}`];
      for (const s of same) extra.push(`! zelfde bestand als ${s.id} "${s.title}"`);
      return this.ok("created", id, rev, 0, extra);
    });
  }

  /**
   * Voor `brain doctor --fix`: een plaatje dat met de hand in de kluis is gezet krijgt een sidecar naast zich.
   * Het plaatje zelf wordt niet aangeraakt; titel en samenvatting zijn een voorlopige tekst die Claude later verbetert.
   */
  adopt(rel: string): Result {
    return this.guard(() => {
      const abs = this.abs(rel);
      if (existsSync(`${abs}.md`)) return fail("conflict", `${rel} heeft al een sidecar`);
      const buf = readFileSync(abs);
      const kind = sniff(buf);
      if (!kind || buf.length > MAX_IMAGE) return fail("invalid_image", `${rel} is geen png, jpeg, gif of webp binnen 25 MB`);
      let id = newId("image");
      while (this.row(id)) id = newId("image");
      const now = this.now();
      const file = basename(rel);
      const title = file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "afbeelding";
      const meta = { id, title, summary: "Nog zonder beschrijving: vraag Claude de afbeelding te bekijken en dit bij te werken.", type: "image", tags: [], status: "active", created: now, updated: now, file, mime: kind.mime, bytes: buf.length, width: kind.width, height: kind.height, hash: createHash("sha256").update(buf).digest("hex").slice(0, 32) } as unknown as Record<string, unknown>;
      return this.ok("created", id, this.commit(`${rel}.md`, this.serialize(meta, "", "i")), 0, [`  sidecar voor ${rel}`]);
    });
  }

  // ------------------------------------------------------------ brain_organize
  organize(a: OrganizeArgs): Result {
    return this.guard(() => {
      switch (a.action) {
        case "create_group":
          return this.createGroup(a);
        case "rename_group":
          return this.renameGroup(a);
        case "move":
          return this.move(a);
        case "archive":
        case "restore":
          return this.setStatus(a, a.action === "archive" ? "archived" : "active");
        case "merge":
          return this.merge(a);
        case "delete":
          return this.remove(a);
        default:
          return fail("invalid_args", `onbekende actie ${String(a.action)}`);
      }
    });
  }

  /** Ids uit `ids`, of uit een zoekopdracht (max 500; archief alleen met status:archived of status:any). */
  private targets(a: OrganizeArgs, allowQuery = true): string[] {
    if (a.ids?.length && a.query) fail("invalid_args", "geef ids of query, niet allebei");
    if (a.ids?.length) {
      if (a.ids.length > MAX_BULK) fail("too_large", `max ${MAX_BULK} ids per aanroep`);
      for (const id of a.ids) this.need(id);
      return [...new Set(a.ids)];
    }
    if (!a.query || !allowQuery) return fail("invalid_args", allowQuery ? "ids of query ontbreekt" : "ids ontbreken");
    const out: string[] = [];
    while (out.length < MAX_BULK) {
      const r = this.brain.find({ query: a.query, limit: 50, cursor: `c${out.length}`, budget: 1_000_000 });
      if (r.text.startsWith("ERROR")) return fail("invalid_query", r.text.replace(/^ERROR \S+ /, ""));
      if (!r.ids.length) break;
      out.push(...r.ids);
    }
    if (!out.length) fail("not_found", "de zoekopdracht vindt niets");
    return out.slice(0, MAX_BULK);
  }

  private createGroup(a: OrganizeArgs): Result {
    const title = this.text(a.title, "title", 200);
    const summary = this.text(a.summary, "summary", 400);
    const parent = this.group(a.to);
    const name = this.uniqueName(parent.dir, slugFile(title));
    const dir = parent.dir ? `${parent.dir}/${name}` : name;
    mkdirSync(this.abs(dir), { recursive: true });
    let id = newId("group");
    while (this.row(id)) id = newId("group");
    const rev = this.commit(`${dir}/_group.md`, this.serialize({ id, title, summary, status: "active" }, "", "g"));
    return this.ok("created_group", id, rev, 0, [`  ${dir}`]);
  }

  private renameGroup(a: OrganizeArgs): Result {
    const g = this.group(a.id);
    if (!g.id) return fail("forbidden", "de wortelgroep heeft geen naam om te wijzigen");
    const title = this.text(a.title, "title", 200);
    const parentDir = dirname(g.dir) === "." ? "" : dirname(g.dir);
    const name = slugFile(title);
    const newDir = (parentDir ? `${parentDir}/` : "") + (name === basename(g.dir) ? name : this.uniqueName(parentDir, name));
    if (newDir !== g.dir) {
      renameSync(this.abs(g.dir), this.abs(newDir));
      relocate(this.db, g.dir, newDir, true);
    }
    const cur = this.load(g.id, "g");
    const rev = this.commit(cur.item.path as string, this.serialize({ ...cur.meta, title, ...(a.summary ? { summary: this.text(a.summary, "summary", 400) } : {}) }, cur.body, "g"));
    return this.ok("renamed_group", g.id, rev, 0, [`  ${newDir}`]);
  }

  private move(a: OrganizeArgs): Result {
    const to = this.group(a.to);
    const ids = this.targets(a);
    const done: string[] = [];
    const problems: string[] = [];
    for (const id of ids) {
      const it = this.need(id);
      try {
        if (it.status === "broken") fail("broken_file", `${id} is kapot`);
        const isGroup = it.kind === "group";
        const from = it.path as string;
        const src = isGroup ? dirname(from) : from;
        const name = basename(src);
        const dest = (to.dir ? `${to.dir}/` : "") + name;
        if (dest === src) continue; // staat er al
        if (isGroup && src === "") fail("forbidden", "de wortelgroep kan niet verplaatst worden");
        if (isGroup && (to.dir === src || to.dir.startsWith(`${src}/`))) fail("invalid_args", `${id} kan niet in zichzelf`);
        if (existsSync(this.abs(dest))) fail("conflict", `${dest} bestaat al`);
        const sibling = it.kind === "image" ? [src.replace(/\.md$/, ""), dest.replace(/\.md$/, "")] : undefined; // het plaatje zelf
        if (sibling) renameSync(this.abs(sibling[0]!), this.abs(sibling[1]!));
        try {
          renameSync(this.abs(src), this.abs(dest));
        } catch (e) {
          if (sibling) renameSync(this.abs(sibling[1]!), this.abs(sibling[0]!)); // niet half verplaatsen
          throw e;
        }
        relocate(this.db, src, dest, isGroup);
        done.push(id);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        problems.push(`${id}: ${e.code} ${e.message}`);
      }
    }
    return { text: [`OK moved ${done.length}/${ids.length} naar ${to.dir || "/"}`, ...problems.map((p) => `! ${p}`)].join("\n"), ids: done };
  }

  private setStatus(a: OrganizeArgs, status: "active" | "archived"): Result {
    const ids = this.targets(a);
    // Een groep archiveren archiveert alles eronder (en terughalen haalt alles terug).
    const all = new Set<string>();
    for (const id of ids) {
      const it = this.need(id);
      if (it.kind === "group") {
        const p = it.group_path as string;
        const rows = this.db.prepare(`SELECT id FROM items WHERE group_path >= ? AND group_path < ? AND status != 'broken'`).all(p, p.slice(0, -1) + "0") as { id: string }[];
        for (const r of rows) all.add(r.id);
      } else all.add(id);
    }
    if (all.size > MAX_CASCADE) fail("too_large", `${all.size} items; kies een kleinere groep of zoekopdracht`);
    let n = 0;
    const problems: string[] = [];
    const updated = this.now();
    for (const id of all) {
      try {
        const k = kindLetter(id);
        const cur = this.load(id, k);
        if (cur.meta.status === status) continue;
        this.commit(cur.item.path as string, this.serialize({ ...cur.meta, status, ...(k === "g" ? {} : { updated }) }, cur.body, k));
        n++;
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        problems.push(`${id}: ${e.code} ${e.message}`);
      }
    }
    return { text: [`OK ${status === "archived" ? "archived" : "restored"} ${n}/${all.size}`, ...problems.slice(0, 5).map((p) => `! ${p}`)].join("\n"), ids: [...all].slice(0, 100) };
  }

  private merge(a: OrganizeArgs): Result {
    const from = this.group(a.from);
    const to = this.group(a.to);
    if (!from.id || !from.dir) return fail("forbidden", "de wortelgroep kan niet samengevoegd worden");
    if (to.dir === from.dir || to.dir.startsWith(`${from.dir}/`)) fail("invalid_args", "kan niet in zichzelf of een eigen subgroep samenvoegen");
    const src = this.abs(from.dir);
    // Alles wat in de map staat gaat mee (ook afbeeldingsbestanden en andere losse bestanden), niet alleen wat in de index staat.
    const names = readdirSync(src).filter((n) => n !== "_group.md" && !n.startsWith("."));
    // Eerst alles controleren; pas dan verplaatsen, zodat een botsing niets half achterlaat.
    for (const n of names) if (existsSync(this.abs((to.dir ? `${to.dir}/` : "") + n))) fail("conflict", `${n} bestaat al in de doelgroep; hernoem eerst`);
    const count = names.length;
    for (const n of names) {
      const dest = (to.dir ? `${to.dir}/` : "") + n;
      renameSync(join(src, n), this.abs(dest));
      relocate(this.db, `${from.dir}/${n}`, dest, statSync(this.abs(dest)).isDirectory());
    }
    // Wat overblijft is alleen de groep zelf. rmdir weigert als er toch iets in staat, dus er gaat niets onbedoeld weg.
    dropPath(this.db, from.dir);
    rmSync(join(src, "_group.md"), { force: true });
    for (const n of readdirSync(src)) if (n.startsWith(".") && n.endsWith(".tmp")) rmSync(join(src, n), { force: true });
    try {
      rmdirSync(src);
    } catch {
      return { text: `OK merged ${from.id} in ${to.id ?? "/"}: ${count} onderdelen verplaatst\n! map ${from.dir} bevat nog bestanden en is blijven staan`, ids: [from.id], note: `groep ${from.id} "${from.title}" opgegaan in ${to.id ?? "/"}` };
    }
    return { text: `OK merged ${from.id} in ${to.id ?? "/"}: ${count} onderdelen verplaatst, lege groep verwijderd`, ids: [from.id, ...(to.id ? [to.id] : [])], note: `groep ${from.id} "${from.title}" opgegaan in ${to.id ?? "/"}` };
  }

  private remove(a: OrganizeArgs): Result {
    const ids = this.targets(a, false);
    const items = ids.map((id) => this.need(id));
    const count = (it: Row) => (it.kind === "group" ? (this.db.prepare(`SELECT count(*) c FROM items WHERE group_path >= ? AND group_path < ?`).get(it.group_path as string, (it.group_path as string).slice(0, -1) + "0") as { c: number }).c : 1);
    const confirm = [...(a.confirm ?? [])].sort().join(",");
    if (confirm !== [...ids].sort().join(",")) {
      const lines = items.map((it) => `  ${it.id}  ${it.title}${it.kind === "group" ? ` (groep met ${count(it)} items)` : ""}`);
      return fail("confirm_required", `verwijderen is definitief. Herhaal met confirm=[${ids.join(", ")}] als de gebruiker dit uitdrukkelijk heeft gevraagd:\n${lines.join("\n")}`);
    }
    const log: string[] = [];
    let n = 0;
    for (const it of items) {
      if (it.kind === "group" && it.group_path === "/") fail("forbidden", "de wortelgroep wordt niet verwijderd");
      const c = count(it);
      log.push(`${it.id} "${it.title}" — ${it.summary ?? ""}${it.kind === "group" ? ` (groep, ${c} items)` : ""}`);
      if (it.kind === "group") rmSync(this.abs(dirname(it.path as string)), { recursive: true, force: true });
      else {
        unlinkSync(this.abs(it.path as string));
        if (it.kind === "image") rmSync(this.abs((it.path as string).replace(/\.md$/, "")), { force: true });
      }
      dropPath(this.db, it.kind === "group" ? dirname(it.path as string) : (it.path as string));
      n += c;
    }
    return { text: `OK deleted ${n} items (definitief)`, ids, note: log.slice(0, 50).join("\n") };
  }
}
