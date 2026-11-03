import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Brain, FORMAT, newId, reconcile, rebuild, UiData, Writer } from "@claude-brain/core";
import { openAudit } from "./audit";
import type { Config } from "./config";
import { acquireLock } from "./lock";
import { buildServer } from "./server";
import { startWatcher } from "./watch";

/** De gebouwde web-UI (apps/web/dist), naast de serverbroncode in de repo. */
const webDir = () => fileURLToPath(new URL("../../web/dist", import.meta.url));

/** Maakt de wortelgroep ("het heelal") bij de eerste start, zodat notities zonder groep een thuis hebben. */
function ensureRoot(vault: string) {
  mkdirSync(vault, { recursive: true });
  if (!existsSync(join(vault, "_group.md")) && !readdirSync(vault).some((f) => f.endsWith(".md"))) {
    writeFileSync(join(vault, "_group.md"), `---\nid: ${newId("group")}\ntitle: Heelal\nsummary: Alles wat Claude onthoudt.\nstatus: active\n---\n`);
  }
}

/**
 * Opent de index. Ontbreekt hij, is hij kapot of is het formaat anders, dan wordt hij (hernoemd en) opnieuw
 * opgebouwd uit de kluis. Daarna brengt reconcile hem in lijn met wijzigingen die er sinds de laatste keer zijn.
 */
export function openIndex(dbPath: string, vault: string, say: (m: string) => void = () => {}) {
  const good = (): DatabaseSync | undefined => {
    if (!existsSync(dbPath)) return undefined;
    let d: DatabaseSync | undefined;
    try {
      const db = (d = new DatabaseSync(dbPath));
      const meta = (k: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(k) as { value: string } | undefined)?.value;
      // De volledige controle kost ~8 s op 300k notities, dus alleen na een crash (geen "clean" bij het vorige afsluiten).
      const clean = meta("clean") === "1";
      db.prepare("INSERT OR REPLACE INTO meta VALUES('clean','0')").run();
      if (meta("format") === String(FORMAT) && (clean || (db.prepare("PRAGMA quick_check(1)").get() as { quick_check: string }).quick_check === "ok")) return db;
    } catch {
      /* kapot: hieronder hernoemen en opnieuw bouwen */
    }
    d?.close(); // Windows laat een geopend bestand niet hernoemen
    renameSync(dbPath, dbPath.replace(/\.db$/, `.corrupt-${Date.now()}.db`));
    say("index was kapot of van een ouder formaat: hernoemd en opnieuw opgebouwd");
    return undefined;
  };
  let db = good();
  if (!db) {
    const s = rebuild(vault, dbPath);
    say(`index gebouwd: ${s.items} items in ${(s.ms / 1000).toFixed(1)} s`);
    db = new DatabaseSync(dbPath);
  }
  const r = reconcile(db, vault);
  if (r.added + r.changed + r.removed) say(`reconcile: ${r.added} nieuw, ${r.changed} gewijzigd, ${r.removed} weg`);
  return db;
}

export async function startServer(cfg: Config, say: (m: string) => void = () => {}, log = false) {
  ensureRoot(cfg.vault);
  const release = acquireLock(join(cfg.root, "data", "server.lock"));
  try {
    const db = openIndex(cfg.dbPath, cfg.vault, say);
    const audit = openAudit(join(cfg.root, "data", "logs.db"), db);
    const brain = new Brain(db, cfg.vault);
    const writer = new Writer(db, cfg.vault, undefined, { imageRoots: cfg.imageRoots, exclude: [cfg.root] });
    const watcher = startWatcher(db, cfg.vault, (e) => say(`watcher: ${(e as Error).message}`));
    const ui = new UiData(db, cfg.vault, brain, audit.db);
    const app = buildServer({ brain, writer, ui, webDir: webDir(), token: cfg.token, port: cfg.port, log, audit: (e) => audit.log(e) });
    try {
      await app.listen({ host: "127.0.0.1", port: cfg.port });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`poort ${cfg.port} is bezet door een ander programma; zet een andere poort in config.json`);
      throw e;
    }
    void ui.overview().catch(() => {}); // warm: de eerste keer dat de UI opent is het overzicht dan al berekend
    return {
      app,
      db,
      audit,
      async close() {
        watcher.close();
        await app.close();
        audit.close();
        db.prepare("INSERT OR REPLACE INTO meta VALUES('clean','1')").run();
        db.close();
        release();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}
