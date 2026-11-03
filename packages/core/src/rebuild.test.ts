import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuild } from "./rebuild";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "brain-"))));
afterEach(() => rmTmp(dir));

const group = (id: string, title: string) => `---\nid: ${id}\ntitle: ${title}\nsummary: Groep ${title}.\nstatus: active\n---\n`;
const note = (id: string, title: string, extra = "", body = "## Kop\ntekst\n", status = "active") =>
  `---\nid: ${id}\ntitle: ${title}\nsummary: Over ${title}.\n${extra}status: ${status}\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\n${body}`;

function vault() {
  const v = join(dir, "vault");
  mkdirSync(join(v, "werk", "klanten"), { recursive: true });
  writeFileSync(join(v, "_group.md"), group("g_00000000", "Heelal"));
  writeFileSync(join(v, "werk", "_group.md"), group("g_00000001", "Werk"));
  writeFileSync(join(v, "werk", "klanten", "_group.md"), group("g_00000002", "Klanten"));
  writeFileSync(join(v, "werk", "klanten", "intake--n_00000001.md"), note("n_00000001", "Intake", "tags: [proces/klant, snel]\nlinks:\n  - { to: n_00000002, type: depends_on }\n", "## Stappen\nZie [offerte](brain:n_00000002) en kraakhelder.\n"));
  writeFileSync(join(v, "werk", "klanten", "offerte--n_00000002.md"), note("n_00000002", "Offerte", "parent: n_00000001\n", "## Velden\nprijzen\n", "archived"));
  return v;
}

const open = (p: string) => new DatabaseSync(p, { readOnly: true });

describe("rebuild", () => {
  it("indexeert groepen, notities, secties, tags en links", () => {
    const db = join(dir, "data", "index.db");
    const s = rebuild(vault(), db);
    expect(s).toMatchObject({ notes: 2, groups: 3, broken: 0, sections: 2 });

    const d = open(db);
    const intake = d.prepare("SELECT * FROM items WHERE id='n_00000001'").get() as Record<string, unknown>;
    expect(intake).toMatchObject({ group_id: "g_00000002", group_path: "/werk/klanten/", kind: "note", status: "active" });
    expect(d.prepare("SELECT group_path, group_id FROM items WHERE id='g_00000002'").get()).toMatchObject({ group_path: "/werk/klanten/", group_id: "g_00000001" });
    expect(d.prepare("SELECT group_path, group_id FROM items WHERE id='g_00000000'").get()).toMatchObject({ group_path: "/", group_id: null });
    expect(d.prepare("SELECT dst, type, inline FROM links WHERE src='n_00000001' ORDER BY inline").all().map((r) => ({ ...r }))).toEqual([
      { dst: "n_00000002", type: "depends_on", inline: 0 },
      { dst: "n_00000002", type: "mentions", inline: 1 },
    ]);
    expect(d.prepare("SELECT parent_id FROM items WHERE id='n_00000002'").get()).toMatchObject({ parent_id: "n_00000001" });
    // hiërarchische tag: `proces` vindt `proces/klant`
    expect(d.prepare("SELECT item_id FROM tags WHERE tag='proces' OR tag LIKE 'proces/%'").all()).toHaveLength(1);
    d.close();
  });

  it("zoekt op sectieniveau en negeert accenten", () => {
    const db = join(dir, "index.db");
    rebuild(vault(), db);
    const d = open(db);
    const hit = d.prepare("SELECT s.item_id, s.slug FROM fts_sections f JOIN sections s ON s.id=f.rowid WHERE fts_sections MATCH 'kraakhelder'").all();
    expect(hit.map((r) => ({ ...r }))).toEqual([{ item_id: "n_00000001", slug: "stappen" }]);
    expect(d.prepare("SELECT rowid FROM fts_items WHERE fts_items MATCH 'intake'").all()).toHaveLength(1);
    d.close();
  });

  it("markeert kapotte bestanden met reden, repareert niets en zoekt ze niet", () => {
    const v = vault();
    const bad = join(v, "werk", "kapot.md");
    writeFileSync(bad, "---\ntitle: zonder id\n---\nkraakhelder\n");
    writeFileSync(join(v, "werk", "klanten", "zz-dubbel.md"), note("n_00000001", "Dubbel"));
    const before = readFileSync(bad, "utf8");

    const db = join(dir, "index.db");
    const s = rebuild(v, db);
    expect(s.broken).toBe(2);
    const d = open(db);
    const rows = d.prepare("SELECT path, status, error FROM items WHERE status='broken' ORDER BY path").all() as { path: string; status: string; error: string }[];
    expect(rows.map((r) => r.path)).toEqual(["werk/kapot.md", "werk/klanten/zz-dubbel.md"]);
    expect(rows[0]!.error).toMatch(/frontmatter: id/);
    expect(rows[1]!.error).toBe("dubbele id n_00000001 (eerste: werk/klanten/intake--n_00000001.md)");
    expect(d.prepare("SELECT 1 FROM fts_sections WHERE fts_sections MATCH 'kraakhelder'").all()).toHaveLength(1); // alleen intake, niet het kapotte bestand
    d.close();
    expect(readFileSync(bad, "utf8")).toBe(before);
  });

  it("vervangt een bestaande index atomair en laat die staan bij een fout", () => {
    const v = vault();
    const db = join(dir, "index.db");
    rebuild(v, db);
    expect(rebuild(v, db).notes).toBe(2);

    expect(() => rebuild(join(dir, "bestaat-niet"), db)).toThrow();
    const d = open(db);
    expect(d.prepare("SELECT count(*) c FROM items").get()).toMatchObject({ c: 5 });
    d.close();
  });
});
