import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { makeIndexer, removeWhere, type Ctx, type RebuildStats } from "./indexer";
import { SIDECAR } from "./schema";

const unix = (p: string) => p.replaceAll("\\", "/");
const dirPath = (rel: string) => (rel === "" || rel === "." ? "/" : `/${unix(rel)}/`);
const emptyStats = (): RebuildStats => ({ items: 0, notes: 0, groups: 0, broken: 0, skipped: 0, sections: 0, links: 0, ms: 0 });
/** Eerste string die na `p` komt in sorteervolgorde, zodat `path >= p AND path < prefixEnd(p)` een prefix-bereik is. */
const prefixEnd = (p: string) => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);

const groupAt = (db: DatabaseSync, groupPath: string): string | null =>
  (db.prepare(`SELECT id FROM items WHERE kind='group' AND status != 'broken' AND group_path = ?`).get(groupPath) as { id: string } | undefined)?.id ?? null;

function indexer(db: DatabaseSync, vault: string) {
  return makeIndexer(db, emptyStats(), {
    // Een id dat al bestaat telt alleen als dubbel als dat andere bestand er nog echt ligt (anders is het een verplaatsing).
    fallback: (id) => {
      const r = db.prepare(`SELECT path FROM items WHERE id = ?`).get(id) as { path: string } | undefined;
      return r && existsSync(join(vault, r.path)) ? r.path : undefined;
    },
    evict: (id) => void removeWhere(db, "id = ?", id),
  });
}

const tx = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};

/** Verwijdert een bestand of een hele map uit de index (de bestanden zelf blijven ongemoeid). */
export function dropPath(db: DatabaseSync, rel: string): number {
  rel = unix(rel);
  return removeWhere(db, "path = ? OR (path >= ? AND path < ?)", rel, `${rel}/`, prefixEnd(`${rel}/`));
}

/** Leest één bestand opnieuw in. Bestaat het niet meer, dan verdwijnt het uit de index. */
export function syncFile(db: DatabaseSync, vault: string, rel: string): void {
  rel = unix(rel);
  const abs = join(vault, rel);
  const base = basename(rel);
  if (!base.endsWith(".md") || base.startsWith(".")) return;
  if (!existsSync(abs)) {
    dropPath(db, rel);
    if (base === "_group.md") syncTree(db, vault, dirname(rel) === "." ? "" : dirname(rel));
    return;
  }
  const isGroup = base === "_group.md";
  const dir = dirname(rel) === "." ? "" : dirname(rel);
  const before = isGroup ? groupAt(db, dirPath(dir)) : null;
  tx(db, () => {
    removeWhere(db, "path = ?", rel);
    const ctx: Ctx = isGroup
      ? { groupId: dir === "" ? null : groupAt(db, dirPath(dirname(dir) === "." ? "" : dirname(dir))), groupPath: dirPath(dir) }
      : { groupId: groupAt(db, dirPath(dir)), groupPath: dirPath(dir) };
    indexer(db, vault).add(isGroup ? "group" : SIDECAR.test(base) ? "image" : "note", rel, abs, ctx);
  });
  // Een nieuwe of andere groep-id verandert `group_id` van alles eronder.
  if (isGroup && before !== groupAt(db, dirPath(dir))) syncTree(db, vault, dir);
}

/** Leest een hele map (met submappen) opnieuw in. */
export function syncTree(db: DatabaseSync, vault: string, relDir: string): void {
  relDir = unix(relDir).replace(/\/+$/, "");
  if (relDir === ".") relDir = "";
  tx(db, () => {
    if (relDir) dropPath(db, relDir);
    else removeWhere(db, "1=1");
    const abs = join(vault, relDir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
    const parent = relDir === "" ? null : groupAt(db, dirPath(dirname(relDir) === "." ? "" : dirname(relDir)));
    indexer(db, vault).walk(abs, relDir, parent);
  });
}

/** Zoals syncFile, maar slaat bestanden over die niet veranderd zijn (mtime + grootte). Voor de watcher. */
export function syncIfChanged(db: DatabaseSync, vault: string, rel: string): boolean {
  rel = unix(rel);
  const row = db.prepare(`SELECT mtime, size FROM items WHERE path = ?`).get(rel) as { mtime: number; size: number } | undefined;
  try {
    const st = statSync(join(vault, rel));
    if (row && row.mtime === Math.round(st.mtimeMs) && row.size === st.size) return false;
  } catch {
    if (!row) return false;
  }
  syncFile(db, vault, rel);
  return true;
}

export type Reconciled = { added: number; changed: number; removed: number };

/**
 * Brengt de index in lijn met de schijf voor `relDir` (standaard de hele kluis): vergelijkt mtime + grootte,
 * leest alleen nieuwe of gewijzigde bestanden en verwijdert wat weg is.
 */
export function reconcile(db: DatabaseSync, vault: string, relDir = ""): Reconciled {
  relDir = unix(relDir).replace(/\/+$/, "");
  const known = new Map<string, { mtime: number; size: number }>();
  const q = relDir
    ? db.prepare(`SELECT path, mtime, size FROM items WHERE path >= ? AND path < ?`).all(`${relDir}/`, prefixEnd(`${relDir}/`))
    : db.prepare(`SELECT path, mtime, size FROM items`).all();
  for (const r of q as { path: string; mtime: number; size: number }[]) known.set(r.path, r);

  const todo: { rel: string; fresh: boolean }[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const k = known.get(r);
        known.delete(r);
        const st = statSync(join(abs, e.name));
        if (!k) todo.push({ rel: r, fresh: true });
        else if (k.mtime !== Math.round(st.mtimeMs) || k.size !== st.size) todo.push({ rel: r, fresh: false });
      }
    }
  };
  walk(join(vault, relDir), relDir);

  // Eerst weg wat weg is (ook de oude plek van verplaatste bestanden), dan groepen vóór notities zodat de context klopt.
  const removed = known.size;
  for (const p of known.keys()) {
    dropPath(db, p);
    if (basename(p) === "_group.md" && existsSync(join(vault, dirname(p)))) syncTree(db, vault, dirname(p));
  }
  todo.sort((a, b) => Number(basename(b.rel) === "_group.md") - Number(basename(a.rel) === "_group.md") || a.rel.split("/").length - b.rel.split("/").length);
  for (const t of todo) syncFile(db, vault, t.rel);
  return { added: todo.filter((t) => t.fresh).length, changed: todo.filter((t) => !t.fresh).length, removed };
}

/**
 * Verplaatsen of hernoemen zonder opnieuw te parsen: de inhoud is niet veranderd, alleen de paden.
 * `oldRel`/`newRel` zijn bestanden (notities) of mappen (groepen), relatief aan de kluis.
 */
export function relocate(db: DatabaseSync, oldRel: string, newRel: string, isDir: boolean): void {
  oldRel = unix(oldRel);
  newRel = unix(newRel);
  const parentOf = (p: string) => (dirname(p) === "." ? "" : dirname(p));
  tx(db, () => {
    if (!isDir) {
      const gp = dirPath(parentOf(newRel));
      db.prepare(`UPDATE items SET path = ?, group_path = ?, group_id = ? WHERE path = ?`).run(newRel, gp, groupAt(db, gp), oldRel);
      return;
    }
    const oldGp = dirPath(oldRel);
    const newGp = dirPath(newRel);
    db.prepare(`UPDATE items SET path = ? || substr(path, ?) WHERE path >= ? AND path < ?`).run(`${newRel}/`, oldRel.length + 2, `${oldRel}/`, prefixEnd(`${oldRel}/`));
    db.prepare(`UPDATE items SET group_path = ? || substr(group_path, ?) WHERE group_path >= ? AND group_path < ?`).run(newGp, oldGp.length + 1, oldGp, prefixEnd(oldGp));
    // Alleen de verplaatste groep zelf krijgt een andere bovenliggende groep; alles eronder verwijst naar dezelfde groepen als eerst.
    db.prepare(`UPDATE items SET group_id = ? WHERE kind = 'group' AND group_path = ?`).run(groupAt(db, dirPath(parentOf(newRel))), newGp);
  });
}
