import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INDEXES, makeIndexer, SCHEMA, type RebuildStats } from "./indexer";

export const FORMAT = 3;
export type { RebuildStats };

/**
 * Bouwt de index volledig opnieuw uit de kluis. Schrijft naar `<db>.tmp` en hernoemt aan het eind,
 * dus een crash of fout laat de bestaande index ongemoeid. Bestanden worden nooit aangepast.
 */
export function rebuild(vaultDir: string, dbPath: string): RebuildStats {
  const t0 = Date.now();
  const tmp = `${dbPath}.tmp`;
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });

  const db = new DatabaseSync(tmp);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;");
  db.exec(SCHEMA);

  const stats: RebuildStats = { items: 0, notes: 0, groups: 0, broken: 0, skipped: 0, sections: 0, links: 0, ms: 0 };
  const { walk } = makeIndexer(db, stats);

  db.exec("BEGIN");
  try {
    walk(vaultDir, "", null);
    db.prepare(`INSERT INTO meta VALUES('format',?),('vault',?),('built_at',?)`).run(String(FORMAT), vaultDir, new Date().toISOString());
    db.exec("COMMIT");
    db.exec(INDEXES);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  } catch (e) {
    db.close();
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    throw e;
  }
  db.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  renameSync(tmp, dbPath);
  stats.ms = Date.now() - t0;
  return stats;
}
