import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseGroup, parseImage, parseNote, type Parsed } from "./parse";
import { SIDECAR, type GroupMeta, type ImageMeta, type NoteMeta } from "./schema";

export const SCHEMA = `
CREATE TABLE items(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, type TEXT, title TEXT, summary TEXT,
  status TEXT NOT NULL, error TEXT, group_id TEXT, group_path TEXT, parent_id TEXT,
  path TEXT NOT NULL, created TEXT, updated TEXT, mtime INTEGER, size INTEGER,
  hash TEXT, tokens_est INTEGER, width INTEGER, height INTEGER, file_hash TEXT
);
CREATE TABLE tags(item_id TEXT NOT NULL, tag TEXT NOT NULL);
CREATE TABLE links(src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, inline INTEGER NOT NULL);
CREATE TABLE sections(
  id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, ord INTEGER, heading TEXT, slug TEXT,
  level INTEGER, start INTEGER, end INTEGER, tokens_est INTEGER
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE fts_items USING fts5(title, summary, tags, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE fts_sections USING fts5(heading, body, tokenize='unicode61 remove_diacritics 2');
-- Woordfrequenties, zodat we bij schrijven alleen op de zeldzaamste woorden naar bijna-dubbele titels zoeken.
CREATE VIRTUAL TABLE fts_items_v USING fts5vocab(fts_items, 'row');
`;

// Indexen pas na het bulk-laden: veel sneller dan ze tijdens het invoegen bij te houden.
export const INDEXES = `
CREATE INDEX idx_items_group_path ON items(group_path);
CREATE INDEX idx_items_parent ON items(parent_id);
CREATE INDEX idx_items_path ON items(path);
CREATE INDEX idx_items_file_hash ON items(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX idx_items_status_updated ON items(status, updated);
CREATE INDEX idx_items_kind_status_group ON items(kind, status, group_path);
CREATE INDEX idx_items_kind_status_updated ON items(kind, status, updated);
CREATE INDEX idx_tags_tag ON tags(tag, item_id);
CREATE INDEX idx_tags_item ON tags(item_id);
CREATE INDEX idx_links_src ON links(src);
CREATE INDEX idx_links_dst ON links(dst);
CREATE INDEX idx_sections_item ON sections(item_id, ord);
ANALYZE;
`;

export type RebuildStats = {
  items: number;
  notes: number;
  groups: number;
  broken: number;
  skipped: number;
  sections: number;
  links: number;
  ms: number;
};

export type Ctx = { groupId: string | null; groupPath: string };

/**
 * Gedeelde kern van `rebuild` (hele kluis) en de incrementele updates (één bestand of deelboom).
 * `fallback` zoekt een id dat al in de index staat (incrementeel); `evict` ruimt oude rijen van dat id op.
 */
export function makeIndexer(db: DatabaseSync, stats: RebuildStats, opts: { fallback?: (id: string) => string | undefined; evict?: (id: string) => void } = {}) {
  const insItem = db.prepare(
    `INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insTag = db.prepare(`INSERT INTO tags VALUES(?,?)`);
  const insLink = db.prepare(`INSERT INTO links VALUES(?,?,?,?)`);
  const insSection = db.prepare(`INSERT INTO sections(item_id,ord,heading,slug,level,start,end,tokens_est) VALUES(?,?,?,?,?,?,?,?)`);
  const insFtsItem = db.prepare(`INSERT INTO fts_items(rowid,title,summary,tags) VALUES(?,?,?,?)`);
  const insFtsSection = db.prepare(`INSERT INTO fts_sections(rowid,heading,body) VALUES(?,?,?)`);

  const seen = new Map<string, string>(); // id → pad van het bestand dat hem eerst kreeg

  function add(kind: "note" | "group" | "image", rel: string, abs: string, ctx: Ctx): string | null {
    let raw: string;
    let st: ReturnType<typeof statSync>;
    let parsed: Parsed<NoteMeta> | Parsed<GroupMeta> | Parsed<ImageMeta> | undefined;
    let error: string | undefined;
    try {
      raw = readFileSync(abs, "utf8");
      st = statSync(abs);
    } catch (e) {
      return broken(kind, rel, ctx, `lezen mislukt: ${(e as Error).message}`);
    }
    try {
      parsed = kind === "note" ? parseNote(raw) : kind === "image" ? parseImage(raw) : parseGroup(raw);
      const first = seen.get(parsed.meta.id) ?? opts.fallback?.(parsed.meta.id);
      if (first && first !== rel.replaceAll("\\", "/")) error = `dubbele id ${parsed.meta.id} (eerste: ${first})`;
    } catch (e) {
      error = (e as Error).message;
    }
    if (!parsed || error) return broken(kind, rel, ctx, error!, st.mtimeMs, st.size);

    const { meta } = parsed;
    opts.evict?.(meta.id);
    seen.set(meta.id, rel.replaceAll("\\", "/"));
    const note = kind === "group" ? undefined : (meta as NoteMeta | ImageMeta);
    const img = kind === "image" ? (meta as ImageMeta) : undefined;
    const hash = createHash("sha1").update(raw).digest("hex").slice(0, 16);
    const res = insItem.run(
      meta.id, kind, kind === "group" ? "group" : note!.type, meta.title, meta.summary, meta.status, null,
      ctx.groupId, ctx.groupPath, note?.parent ?? null, rel.replaceAll("\\", "/"),
      note?.created ?? null, note?.updated ?? null, Math.round(st.mtimeMs), st.size, hash, parsed.tokens, img?.width ?? null, img?.height ?? null, img?.hash ?? null,
    );
    const rowid = res.lastInsertRowid;
    insFtsItem.run(rowid, meta.title, meta.summary, (note?.tags ?? []).join(" "));
    for (const tag of note?.tags ?? []) insTag.run(meta.id, tag);
    for (const l of note?.links ?? []) { insLink.run(meta.id, l.to, l.type, 0); stats.links++; }
    for (const to of parsed.inline) { insLink.run(meta.id, to, "mentions", 1); stats.links++; }
    for (const s of parsed.sections) {
      const sid = insSection.run(meta.id, s.ord, s.heading, s.slug, s.level, s.start, s.end, s.tokens).lastInsertRowid;
      insFtsSection.run(sid, s.heading, parsed.body.slice(s.start, s.end));
      stats.sections++;
    }
    stats.items++;
    stats[kind === "group" ? "groups" : "notes"]++;
    return meta.id;
  }

  // Kapot = wel in de index (met reden), niet doorzoekbaar, nooit gerepareerd.
  function broken(kind: string, rel: string, ctx: Ctx, error: string, mtime = 0, size = 0): null {
    const relUnix = rel.replaceAll("\\", "/");
    insItem.run(`broken:${relUnix}`, kind, null, basename(rel), null, "broken", error, ctx.groupId, ctx.groupPath, null, relUnix, null, null, Math.round(mtime), size, null, 0, null, null, null);
    stats.items++;
    stats.broken++;
    return null;
  }

  function walk(absDir: string, relDir: string, parentGroupId: string | null) {
    const entries = readdirSync(absDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const groupPath = relDir ? `/${relDir.replaceAll("\\", "/")}/` : "/";

    let groupId: string | null = null;
    if (entries.some((e) => e.isFile() && e.name === "_group.md")) {
      groupId = add("group", join(relDir, "_group.md"), join(absDir, "_group.md"), { groupId: parentGroupId, groupPath });
    }
    const ctx: Ctx = { groupId, groupPath };
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md") && e.name !== "_group.md") {
        add(SIDECAR.test(e.name) ? "image" : "note", join(relDir, e.name), join(absDir, e.name), ctx);
      }
    }
    for (const e of entries) if (e.isDirectory()) walk(join(absDir, e.name), join(relDir, e.name), groupId);
  }

  return { add, broken, walk };
}

/** Verwijdert items (met secties, tags, uitgaande links en zoekrijen) die aan `where` voldoen. Geeft het aantal terug. */
export function removeWhere(db: DatabaseSync, where: string, ...params: (string | number)[]): number {
  const rows = db.prepare(`SELECT rowid r, id FROM items WHERE ${where}`).all(...params) as { r: number; id: string }[];
  for (const { r, id } of rows) {
    db.prepare(`DELETE FROM fts_items WHERE rowid = ?`).run(r);
    db.prepare(`DELETE FROM fts_sections WHERE rowid IN (SELECT id FROM sections WHERE item_id = ?)`).run(id);
    db.prepare(`DELETE FROM sections WHERE item_id = ?`).run(id);
    db.prepare(`DELETE FROM tags WHERE item_id = ?`).run(id);
    db.prepare(`DELETE FROM links WHERE src = ?`).run(id);
    db.prepare(`DELETE FROM items WHERE rowid = ?`).run(r);
  }
  return rows.length;
}
