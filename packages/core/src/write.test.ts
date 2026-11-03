import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "./read";
import { rebuild } from "./rebuild";
import { dropPath, reconcile, syncFile } from "./sync";
import { Writer, revOf } from "./write";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

let dir: string;
let vault: string;
let db: DatabaseSync;
let w: Writer;
let b: Brain;
let t = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-write-"));
  vault = join(dir, "vault");
  mkdirSync(vault);
  writeFileSync(join(vault, "_group.md"), "---\nid: g_00000000\ntitle: Heelal\nsummary: Wortel.\nstatus: active\n---\n");
  rebuild(vault, join(dir, "index.db"));
  db = new DatabaseSync(join(dir, "index.db"));
  w = new Writer(db, vault, () => `2026-02-01T00:00:${String(t++ % 60).padStart(2, "0")}Z`);
  b = new Brain(db, vault);
});
afterEach(() => {
  db.close();
  rmTmp(dir);
});

const idOf = (r: { text: string }) => /(?:n|g)_[0-9a-z]{8}/.exec(r.text)![0];
const mk = (title: string, extra: Record<string, unknown> = {}) => w.write({ action: "create", title, summary: `Over ${title}.`, ...extra });
const files = () => (readdirSync(vault, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).filter((f) => f.endsWith(".md")).sort();

describe("brain_write", () => {
  it("create schrijft bestand + index en is direct vindbaar", () => {
    const g = w.organize({ action: "create_group", title: "Klanten Werk", summary: "Alles over klanten." });
    expect(g.text).toMatch(/^OK created_group g_/);
    const r = mk("Intake proces", { group: "klanten-werk", tags: ["Proces/Klant"], body: "## Stappen\neerst bellen\n" });
    expect(r.text).toMatch(/^OK created n_[0-9a-z]{8} rev=[0-9a-f]{16}/);
    const id = idOf(r);
    expect(files()).toContain(`klanten-werk/intake-proces--${id}.md`);
    expect(b.find({ query: "bellen" }).ids).toEqual([id]);
    expect(b.find({ query: "tag:proces group:klanten-werk" }).ids).toEqual([id]);
    expect(b.read({ ids: [id], view: "section", section: "stappen" }).text).toContain("eerst bellen");
    // geen .tmp achtergelaten
    expect(readdirSync(join(vault, "klanten-werk")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("create waarschuwt bij bijna-dubbele titel en weigert slechte invoer", () => {
    mk("Intake proces");
    expect(mk("Intake proces").text).toMatch(/! lijkt op n_/);
    expect(w.write({ action: "create", title: "x", summary: "" }).text).toMatch(/^ERROR invalid_args/);
    expect(mk("Slecht", { tags: ["a b"] }).text).toMatch(/^ERROR invalid_args tag/);
    expect(mk("Nergens", { group: "bestaat/niet" }).text).toMatch(/^ERROR not_found/);
    expect(mk("Link", { links: [{ to: "n_99999999" }] }).text).toMatch(/^ERROR not_found/);
  });

  it("append, replace_section en str_replace passen kleine stukken aan", () => {
    const id = idOf(mk("Plan", { body: "intro\n\n## A\naaa\n\n## B\nbbb\n" }));
    expect(w.write({ action: "append", id, section: "a", text: "meer a" }).text).toMatch(/^OK/);
    expect(w.write({ action: "replace_section", id, section: "b", text: "nieuw b" }).text).toMatch(/^OK/);
    expect(w.write({ action: "str_replace", id, old: "intro", new: "begin" }).text).toMatch(/^OK/);
    const full = b.read({ ids: [id], view: "full" }).text;
    expect(full).toContain("begin\n\n## A\naaa\n\nmeer a\n\n## B\nnieuw b");
    expect(full).not.toContain("bbb");
    expect(w.write({ action: "str_replace", id, old: "a", new: "z" }).text).toMatch(/^ERROR ambiguous/);
    expect(w.write({ action: "str_replace", id, old: "nope", new: "z" }).text).toMatch(/^ERROR not_found_text/);
    expect(w.write({ action: "replace_section", id, section: "zzz", text: "x" }).text).toMatch(/^ERROR not_found_section/);
  });

  it("if_rev geeft conflict als het bestand intussen veranderd is", () => {
    const r = mk("Conflict");
    const id = idOf(r);
    const rev = /rev=(\w+)/.exec(r.text)![1]!;
    expect(w.write({ action: "append", id, text: "een", if_rev: rev }).text).toMatch(/^OK/);
    const c = w.write({ action: "append", id, text: "twee", if_rev: rev });
    expect(c.text).toMatch(/^ERROR conflict .*rev=[0-9a-f]{16}/);
    expect(b.read({ ids: [id], view: "full" }).text).not.toContain("twee");
  });

  it("set_meta, link, unlink en set_parent houden de index kloppend", () => {
    const a = idOf(mk("A"));
    const c = idOf(mk("C"));
    expect(w.write({ action: "set_meta", id: a, tags: ["x"], summary: "Nieuw." }).text).toMatch(/^OK/);
    expect(b.find({ query: "tag:x" }).ids).toEqual([a]);
    expect(w.write({ action: "link", id: a, to: c, link_type: "depends_on" }).text).toMatch(/^OK/);
    expect(b.find({ query: `links-to:${c}` }).ids).toEqual([a]);
    expect(w.write({ action: "link", id: a, to: c, link_type: "depends_on" }).text).toMatch(/unchanged/);
    expect(w.write({ action: "unlink", id: a, to: c }).text).toMatch(/^OK/);
    expect(b.find({ query: `links-to:${c}` }).ids).toEqual([]);
    expect(w.write({ action: "set_parent", id: c, parent: a }).text).toMatch(/^OK/);
    expect(b.find({ query: `parent:${a}` }).ids).toEqual([c]);
    expect(w.write({ action: "set_parent", id: a, parent: c }).text).toMatch(/^ERROR cycle/);
    expect(w.write({ action: "set_parent", id: c, parent: "" }).text).toMatch(/^OK/);
    expect(b.find({ query: `parent:${a}` }).ids).toEqual([]);
  });

  it("YAML-tekens in titel en samenvatting blijven heel", () => {
    const id = idOf(mk('Titel: met "quotes" # en: dubbele punt', { body: "---\nnog een streep\n" }));
    const r = b.read({ ids: [id], view: "meta" });
    expect(r.text).toContain('Titel: met "quotes" # en: dubbele punt');
    expect(db.prepare("SELECT status FROM items WHERE id=?").get(id)).toMatchObject({ status: "active" });
  });
});

describe("brain_organize", () => {
  it("verplaatst notities en groepen; paden en group_path volgen", () => {
    const g1 = idOf(w.organize({ action: "create_group", title: "Eén", summary: "s" }));
    const g2 = idOf(w.organize({ action: "create_group", title: "Twee", summary: "s" }));
    const n = idOf(mk("Ding", { group: g1 }));
    expect(w.organize({ action: "move", ids: [n], to: g2 }).text).toMatch(/^OK moved 1\/1/);
    expect(b.find({ query: "group:twee kind:note" }).ids).toEqual([n]);
    expect(w.organize({ action: "move", ids: [g2], to: g1 }).text).toMatch(/^OK moved 1\/1/);
    expect(b.find({ query: "group:een/twee kind:note" }).ids).toEqual([n]);
    expect(existsSync(join(vault, "een", "twee", `ding--${n}.md`))).toBe(true);
    expect(w.organize({ action: "move", ids: [g1], to: g2 }).text).toMatch(/kan niet in zichzelf/);
    expect(db.prepare("SELECT count(*) c FROM items WHERE path LIKE 'twee%'").get()).toMatchObject({ c: 0 });
  });

  it("verplaatst alles dat bij een zoekopdracht hoort", () => {
    const g = idOf(w.organize({ action: "create_group", title: "Doel", summary: "s" }));
    const a = idOf(mk("A", { tags: ["x"] }));
    mk("B");
    expect(w.organize({ action: "move", query: "tag:x", to: g }).text).toMatch(/^OK moved 1\/1/);
    expect(b.find({ query: "group:doel kind:note" }).ids).toEqual([a]);
  });

  it("hernoemt een groep (map + titel) zonder items kwijt te raken", () => {
    const g = idOf(w.organize({ action: "create_group", title: "Oud", summary: "s" }));
    const n = idOf(mk("In groep", { group: g }));
    expect(w.organize({ action: "rename_group", id: g, title: "Nieuw" }).text).toMatch(/^OK renamed_group/);
    expect(existsSync(join(vault, "oud"))).toBe(false);
    expect(b.find({ query: "group:nieuw kind:note" }).ids).toEqual([n]);
    expect(b.map({ group: "nieuw" }).text).toContain("Nieuw");
  });

  it("archiveert (ook een hele groep) en haalt terug", () => {
    const g = idOf(w.organize({ action: "create_group", title: "Oud", summary: "s" }));
    const n = idOf(mk("In groep", { group: g }));
    expect(w.organize({ action: "archive", ids: [g] }).text).toMatch(/^OK archived 2\/2/);
    expect(b.find({ query: "groep" }).ids).toEqual([]);
    expect(b.find({ query: "status:archived kind:note" }).ids).toEqual([n]);
    expect(w.organize({ action: "restore", query: "status:archived group:oud" }).text).toMatch(/^OK restored/);
    expect(b.find({ query: "kind:note" }).ids).toEqual([n]);
  });

  it("voegt groepen samen en weigert bij naamsbotsing zonder iets te verplaatsen", () => {
    const a = idOf(w.organize({ action: "create_group", title: "A", summary: "s" }));
    const c = idOf(w.organize({ action: "create_group", title: "C", summary: "s" }));
    const n = idOf(mk("Ding", { group: a }));
    w.organize({ action: "create_group", title: "Sub", summary: "s", to: a });
    w.organize({ action: "create_group", title: "Sub", summary: "s", to: c });
    expect(w.organize({ action: "merge", from: a, to: c }).text).toMatch(/^ERROR conflict/);
    expect(existsSync(join(vault, "a", `ding--${n}.md`))).toBe(true);
    rmSync(join(vault, "c", "sub"), { recursive: true });
    syncFile(db, vault, "c/_group.md");
    reconcile(db, vault);
    expect(w.organize({ action: "merge", from: a, to: c }).text).toMatch(/^OK merged/);
    expect(existsSync(join(vault, "a"))).toBe(false);
    expect(b.find({ query: "group:c kind:note" }).ids).toContain(n);
  });

  it("verwijdert alleen met confirm en de exacte id's", () => {
    const n = idOf(mk("Weg"));
    const keep = idOf(mk("Blijft"));
    const pre = w.organize({ action: "delete", ids: [n] });
    expect(pre.text).toMatch(/^ERROR confirm_required/);
    expect(w.organize({ action: "delete", ids: [n], confirm: [keep] }).text).toMatch(/^ERROR confirm_required/);
    expect(files().some((f) => f.includes(n))).toBe(true);
    const r = w.organize({ action: "delete", ids: [n], confirm: [n] });
    expect(r.text).toMatch(/^OK deleted 1/);
    expect(r.note).toContain("Weg");
    expect(files().some((f) => f.includes(n))).toBe(false);
    expect(b.find({ query: "weg" }).ids).toEqual([]);
    expect(w.organize({ action: "delete", query: "blijft", confirm: [keep] }).text).toMatch(/^ERROR invalid_args/);
  });

  it("verwijdert een groep met inhoud en telt mee; de wortel is beschermd", () => {
    const g = idOf(w.organize({ action: "create_group", title: "Weg", summary: "s" }));
    mk("In", { group: g });
    expect(w.organize({ action: "delete", ids: [g], confirm: [g] }).text).toMatch(/^OK deleted 2/);
    expect(existsSync(join(vault, "weg"))).toBe(false);
    expect(w.organize({ action: "delete", ids: ["g_00000000"], confirm: ["g_00000000"] }).text).toMatch(/^ERROR forbidden/);
  });
});

describe("sync", () => {
  it("reconcile pikt handmatige wijzigingen op: nieuw, gewijzigd, verplaatst, weg", () => {
    const a = idOf(mk("Alfa", { body: "oud woord\n" }));
    const bId = idOf(mk("Beta"));
    const fa = files().find((f) => f.includes(a))!;
    // handmatig bewerkt (andere tekst + mtime)
    writeFileSync(join(vault, fa), readFileSync(join(vault, fa), "utf8").replace("oud woord", "nieuw woord"));
    utimesSync(join(vault, fa), new Date(), new Date(Date.now() + 5000));
    // handmatig nieuw bestand
    writeFileSync(join(vault, "hand.md"), "---\nid: n_hand0001\ntitle: Hand\nsummary: Met de hand.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\ntekst\n");
    // handmatig verwijderd
    rmSync(join(vault, files().find((f) => f.includes(bId))!));
    expect(reconcile(db, vault)).toEqual({ added: 1, changed: 1, removed: 1 });
    expect(b.find({ query: "nieuw" }).ids).toEqual([a]);
    expect(b.find({ query: "oud" }).ids).toEqual([]);
    expect(b.find({ query: "hand" }).ids).toEqual(["n_hand0001"]);
    expect(b.find({ query: "beta" }).ids).toEqual([]);
    expect(reconcile(db, vault)).toEqual({ added: 0, changed: 0, removed: 0 });
  });

  it("een bestand dat in de Verkenner is verplaatst blijft hetzelfde item; een kopie is dubbel (kapot)", () => {
    const g = idOf(w.organize({ action: "create_group", title: "Doel", summary: "s" }));
    const n = idOf(mk("Reiziger"));
    const f = files().find((x) => x.includes(n))!;
    writeFileSync(join(vault, "doel", `reiziger--${n}.md`), readFileSync(join(vault, f)));
    rmSync(join(vault, f));
    reconcile(db, vault);
    expect(db.prepare("SELECT group_path, status FROM items WHERE id=?").get(n)).toMatchObject({ group_path: "/doel/", status: "active" });
    // kopie
    writeFileSync(join(vault, `kopie--${n}.md`), readFileSync(join(vault, "doel", `reiziger--${n}.md`)));
    reconcile(db, vault);
    expect(db.prepare("SELECT count(*) c FROM items WHERE status='broken'").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT path FROM items WHERE id=?").get(n)).toMatchObject({ path: `doel/reiziger--${n}.md` });
    void g;
  });

  it("dropPath en revOf", () => {
    const n = idOf(mk("Los"));
    expect(dropPath(db, files().find((f) => f.includes(n))!)).toBe(1);
    expect(revOf("abc")).toHaveLength(16);
  });
});
