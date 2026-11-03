import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reconcile, type Writer } from "@claude-brain/core";

export type Finding = { level: "fout" | "let op" | "info"; code: string; msg: string };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const SHOW = 10; // per soort niet meer dan dit tonen, met het totaal erbij

/** Losse afbeeldingen in de kluis (bestand zonder `<bestand>.md`-sidecar). Dotmappen worden overgeslagen, net als bij de indexer. */
function strayImages(vault: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile() && IMAGE_EXT.test(e.name) && !names.has(`${e.name}.md`)) out.push(r);
    }
  };
  walk(vault, "");
  return out;
}

function list(rows: string[], total = rows.length) {
  return rows.slice(0, SHOW).join("\n    ") + (total > SHOW ? `\n    … en ${total - SHOW} meer` : "");
}

/**
 * `brain doctor`: controleert of kluis en index kloppen. Repareert nooit een bestand van jou.
 * Wat hij zelf mag aanpassen: de index (reconcile, altijd) en, alleen met `fix`, een sidecar naast een los plaatje.
 */
export function diagnose(db: DatabaseSync, vault: string, writer?: Writer, fix = false): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding["level"], code: string, msg: string) => out.push({ level, code, msg });
  const n = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n;

  // Zonder writer (de server draait en houdt de index zelf bij): alleen kijken.
  const r = writer ? reconcile(db, vault) : { added: 0, changed: 0, removed: 0 };
  if (r.added + r.changed + r.removed) add("info", "index_drift", `de index liep achter op de kluis en is bijgewerkt (${r.added} nieuw, ${r.changed} gewijzigd, ${r.removed} weg)`);

  const broken = db.prepare(`SELECT path, error FROM items WHERE status='broken' ORDER BY path`).all() as { path: string; error: string }[];
  if (broken.length) add("fout", "broken_files", `${broken.length} bestand(en) zijn kapot en staan niet in zoekresultaten (los ze met de hand op, ik pas ze niet aan):\n    ${list(broken.map((b) => `${b.path}: ${b.error}`), broken.length)}`);

  const dangling = db.prepare(`SELECT l.src, l.dst FROM links l WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = l.dst) ORDER BY l.src`).all() as { src: string; dst: string }[];
  if (dangling.length) add("let op", "dangling_links", `${dangling.length} link(s) wijzen naar een item dat niet bestaat:\n    ${list(dangling.map((d) => `${d.src} → ${d.dst}`))}`);

  const lost = n(`SELECT COUNT(*) n FROM items c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items p WHERE p.id = c.parent_id)`);
  if (lost) add("let op", "missing_parent", `${lost} item(s) hebben een parent die niet bestaat`);

  const sidecars = db.prepare(`SELECT path FROM items WHERE kind='image' AND status != 'broken'`).all() as { path: string }[];
  const gone = sidecars.map((s) => s.path.replace(/\.md$/, "")).filter((p) => !existsSync(join(vault, p)));
  if (gone.length) add("fout", "image_missing", `${gone.length} afbeelding(en) hebben een sidecar maar het bestand zelf ontbreekt:\n    ${list(gone)}`);

  const stray = strayImages(vault);
  if (stray.length && !(fix && writer)) add("let op", "stray_images", `${stray.length} afbeelding(en) staan zonder sidecar in de kluis en worden niet gevonden (\`brain doctor --fix\` maakt er een sidecar bij):\n    ${list(stray)}`);
  if (stray.length && fix && writer) {
    const done = stray.map((p) => ({ p, res: writer.adopt(p) })).filter((x) => !x.res.text.startsWith("ERROR"));
    add("info", "stray_images_fixed", `${done.length} van ${stray.length} afbeelding(en) kregen een sidecar${done.length < stray.length ? "; de rest is geen geldig plaatje of kreeg een fout" : ""}`);
  }
  return out;
}

export const fileMb = (p: string) => (existsSync(p) ? statSync(p).size / 1048576 : 0);
