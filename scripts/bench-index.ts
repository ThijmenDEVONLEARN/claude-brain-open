// Meet rebuild en typische zoek- en filterqueries op een (nep-)kluis.
// Gebruik: pnpm tsx scripts/bench-index.ts --vault <map> --db <bestand>
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { rebuild } from "../packages/core/src/index";

const { values } = parseArgs({ options: { vault: { type: "string" }, db: { type: "string" } } });
if (!values.vault || !values.db) throw new Error("--vault en --db zijn verplicht");

const s = rebuild(values.vault, values.db);
const mb = (statSync(values.db).size / 1e6).toFixed(0);
console.log(`rebuild: ${s.items} items, ${s.sections} secties, ${s.links} links in ${(s.ms / 1000).toFixed(1)} s, index ${mb} MB`);

const db = new DatabaseSync(values.db, { readOnly: true });
const n = (sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as Record<string, number>);
const rnd = (max: number) => Math.floor(Math.random() * max);
// Prefix-bereik i.p.v. LIKE: LIKE gebruikt de index niet (case-insensitive). '/' + 1 = '0', dus [p, p-met-'0') dekt alles onder p.
const range = (p: string): [string, string] => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];
const total = n("SELECT count(*) c FROM items WHERE kind='note'").c!;
const noteAt = (i: number) => db.prepare("SELECT id, title, group_path FROM items WHERE kind='note' LIMIT 1 OFFSET ?").get(i) as { id: string; title: string; group_path: string };
const pickWord = () => noteAt(rnd(total)).title.split(" ")[rnd(3)]!;

const tag = (db.prepare("SELECT tag FROM tags WHERE tag LIKE 'project/%' LIMIT 1").get() as { tag: string }).tag;
const queries: Record<string, () => unknown> = {
  "tekst, zeldzaam woord (secties)": () => db.prepare(`SELECT s.item_id, s.slug FROM fts_sections f JOIN sections s ON s.id=f.rowid WHERE fts_sections MATCH ? ORDER BY rank LIMIT 10`).all(pickWord()),
  "tekst, titel+samenvatting, actief": () => db.prepare(`SELECT i.id, i.title FROM fts_items f JOIN items i ON i.rowid=f.rowid WHERE fts_items MATCH ? AND i.status='active' ORDER BY rank LIMIT 10`).all(pickWord()),
  "twee woorden (AND)": () => db.prepare(`SELECT s.item_id FROM fts_sections f JOIN sections s ON s.id=f.rowid WHERE fts_sections MATCH ? ORDER BY rank LIMIT 10`).all(`${pickWord()} ${pickWord()}`),
  "groep + subgroepen, recent": () => db.prepare(`SELECT id, title FROM items WHERE group_path >= ? AND group_path < ? AND status='active' ORDER BY updated DESC LIMIT 20`).all(...range(`/groep-${rnd(12)}/`)),
  "tag (incl. subtags) + groep": () => db.prepare(`SELECT i.id FROM tags t JOIN items i ON i.id=t.item_id WHERE (t.tag=? OR (t.tag >= ? AND t.tag < ?)) AND i.group_path >= ? AND i.group_path < ? AND i.status='active' LIMIT 20`).all(tag, ...range(`${tag}/`), ...range(`/groep-${rnd(12)}/`)),
  "backlinks van één item": () => db.prepare(`SELECT src, type FROM links WHERE dst=?`).all(noteAt(rnd(total)).id),
  "children van één item": () => db.prepare(`SELECT id FROM items WHERE parent_id=?`).all(noteAt(rnd(total)).id),
  "kaart: aantallen per groep": () => db.prepare(`SELECT group_path, count(*) c FROM items WHERE kind='note' AND status='active' GROUP BY group_path`).all(),
};

const RUNS = 40;
for (const [name, fn] of Object.entries(queries)) {
  fn(); // opwarmen
  const ts: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    fn();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`${name.padEnd(36)} p50 ${ts[RUNS >> 1]!.toFixed(1).padStart(6)} ms   p95 ${ts[Math.floor(RUNS * 0.95)]!.toFixed(1).padStart(6)} ms`);
}
