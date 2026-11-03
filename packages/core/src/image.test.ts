import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sniff } from "./image";
import { Brain } from "./read";
import { rebuild } from "./rebuild";
import { reconcile } from "./sync";
import { Writer } from "./write";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const pad = (b: number[], n = 40) => Buffer.from([...b, ...new Array(Math.max(0, n - b.length)).fill(0)]);
const JPG = pad([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), pad([3, 0, 2, 0])]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("VP8X"), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([4, 0, 0]), Buffer.from([2, 0, 0]), Buffer.alloc(8)]);

let dir: string;
let vault: string;
let db: DatabaseSync;
let w: Writer;
let b: Brain;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-img-"));
  vault = join(dir, "vault");
  home = join(dir, "home");
  mkdirSync(vault);
  mkdirSync(join(home, "Pictures"), { recursive: true });
  mkdirSync(join(home, "ClaudeBrain"), { recursive: true });
  writeFileSync(join(vault, "_group.md"), "---\nid: g_00000000\ntitle: Heelal\nsummary: Wortel.\nstatus: active\n---\n");
  rebuild(vault, join(dir, "index.db"));
  db = new DatabaseSync(join(dir, "index.db"));
  w = new Writer(db, vault, undefined, { imageRoots: [home], exclude: [join(home, "ClaudeBrain")] });
  b = new Brain(db, vault);
});
afterEach(() => {
  db.close();
  rmTmp(dir);
});
const idOf = (r: { text: string }) => /[nig]_[0-9a-z]{8}/.exec(r.text)![0];
const add = (title: string, extra: Record<string, unknown> = {}) => w.image({ base64: PNG.toString("base64"), title, summary: `Plaatje van ${title}.`, ...extra });
const all = () => (readdirSync(vault, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).sort();

describe("sniff", () => {
  it("leest type en afmetingen uit de header en weigert de rest", () => {
    expect(sniff(PNG)).toMatchObject({ mime: "image/png", width: 1, height: 1 });
    expect(sniff(JPG)).toMatchObject({ mime: "image/jpeg", width: 32, height: 16 });
    expect(sniff(GIF)).toMatchObject({ mime: "image/gif", width: 3, height: 2 });
    expect(sniff(WEBP)).toMatchObject({ mime: "image/webp", width: 5, height: 3 });
    expect(sniff(Buffer.from("<svg onload=alert(1)></svg>"))).toBeUndefined();
    expect(sniff(Buffer.from("gewoon tekst"))).toBeUndefined();
    expect(sniff(PNG.subarray(0, 10))).toBeUndefined();
  });
});

describe("brain_image", () => {
  it("voegt toe als base64: bestand + sidecar, vindbaar op beschrijving, pixels op te halen", () => {
    w.organize({ action: "create_group", title: "Foto's", summary: "s" });
    const r = add("Flowchart intake", { group: "foto-s", tags: ["proces"] });
    expect(r.text).toMatch(/^OK created i_[0-9a-z]{8} rev=/);
    const id = idOf(r);
    expect(all()).toEqual(expect.arrayContaining([`foto-s/flowchart-intake--${id}.png`, `foto-s/flowchart-intake--${id}.png.md`]));
    expect(b.find({ query: "kind:image flowchart" }).ids).toEqual([id]);
    expect(b.find({ query: "tag:proces kind:image" }).ids).toEqual([id]);
    expect(b.read({ ids: [id], view: "meta" }).text).toContain("[image 1×1]");
    const img = b.read({ ids: [id], view: "image" });
    expect(img.image).toMatchObject({ mime: "image/png" });
    expect(Buffer.from(img.image!.data, "base64").equals(PNG)).toBe(true);
    expect(b.read({ ids: [idOf(w.write({ action: "create", title: "n", summary: "s" }))], view: "image" }).text).toMatch(/^ERROR invalid_args/);
  });

  it("weigert svg, tekst met .png-naam en te grote of dubbele invoer netjes", () => {
    expect(w.image({ base64: Buffer.from("<svg onload=alert(1)/>").toString("base64"), title: "x", summary: "y" }).text).toMatch(/^ERROR invalid_image/);
    expect(w.image({ base64: PNG.toString("base64"), source: "/x", title: "x", summary: "y" }).text).toMatch(/^ERROR invalid_args/);
    expect(w.image({ title: "x", summary: "y" }).text).toMatch(/^ERROR invalid_args/);
    expect(w.image({ base64: PNG.toString("base64"), title: "x" }).text).toMatch(/^ERROR invalid_args/);
    expect(all().filter((f) => f.endsWith(".png"))).toEqual([]);
    add("Eerste");
    expect(add("Tweede").text).toMatch(/! zelfde bestand als i_/);
  });

  it("leest een pad alleen binnen imageRoots, volgt symlinks en sluit de ClaudeBrain-map uit", () => {
    writeFileSync(join(home, "Pictures", "a.png"), PNG);
    writeFileSync(join(home, "ClaudeBrain", "geheim.png"), PNG);
    writeFileSync(join(dir, "buiten.png"), PNG);
    let linked = true;
    try {
      symlinkSync(join(dir, "buiten.png"), join(home, "Pictures", "link.png"));
    } catch {
      linked = false; // Windows zonder ontwikkelaarsmodus mag geen symlinks maken
    }
    const ok = w.image({ source: join(home, "Pictures", "a.png"), title: "Pad", summary: "s" });
    expect(ok.text).toMatch(/^OK created i_/);
    expect(w.image({ source: join(dir, "buiten.png"), title: "x", summary: "s" }).text).toMatch(/^ERROR forbidden/);
    if (linked) expect(w.image({ source: join(home, "Pictures", "link.png"), title: "x", summary: "s" }).text).toMatch(/^ERROR forbidden/);
    expect(w.image({ source: join(home, "ClaudeBrain", "geheim.png"), title: "x", summary: "s" }).text).toMatch(/^ERROR forbidden/);
    expect(w.image({ source: join(home, "Pictures", "weg.png"), title: "x", summary: "s" }).text).toMatch(/^ERROR not_found/);
    writeFileSync(join(home, "Pictures", "tekst.png"), "dit is geen plaatje");
    expect(w.image({ source: join(home, "Pictures", "tekst.png"), title: "x", summary: "s" }).text).toMatch(/^ERROR invalid_image/);
  });

  it("een afbeelding kan alles wat een notitie kan: linken, parent, archiveren", () => {
    const img = idOf(add("Plaat"));
    const n = idOf(w.write({ action: "create", title: "Notitie", summary: "s" }));
    expect(w.write({ action: "link", id: n, to: img, link_type: "illustrated_by" }).text).toMatch(/^OK/);
    expect(b.find({ query: "has:image" }).ids).toEqual([n]);
    expect(w.write({ action: "set_meta", id: img, tags: ["x"], summary: "Nieuwe beschrijving." }).text).toMatch(/^OK/);
    expect(w.write({ action: "set_parent", id: img, parent: n }).text).toMatch(/^OK/);
    expect(w.organize({ action: "archive", ids: [img] }).text).toMatch(/^OK archived 1\/1/);
    expect(b.find({ query: "kind:image" }).ids).toEqual([]);
    expect(b.find({ query: "kind:image status:archived beschrijving" }).ids).toEqual([img]);
    // dimensies en hash blijven na bewerken in de sidecar staan
    expect(b.read({ ids: [img], view: "meta" }).text).toContain("1×1");
  });

  it("verplaatst, voegt samen en verwijdert het plaatje samen met zijn sidecar", () => {
    const g1 = idOf(w.organize({ action: "create_group", title: "Een", summary: "s" }));
    const g2 = idOf(w.organize({ action: "create_group", title: "Twee", summary: "s" }));
    const img = idOf(add("Plaat", { group: g1 }));
    expect(w.organize({ action: "move", ids: [img], to: g2 }).text).toMatch(/^OK moved 1\/1/);
    expect(all()).toEqual(expect.arrayContaining([`twee/plaat--${img}.png`, `twee/plaat--${img}.png.md`]));
    expect(all().some((f) => f.startsWith("een/plaat"))).toBe(false);
    expect(b.read({ ids: [img], view: "image" }).image).toBeDefined();

    expect(w.organize({ action: "merge", from: g2, to: g1 }).text).toMatch(/^OK merged/);
    expect(all()).toEqual(expect.arrayContaining([`een/plaat--${img}.png`, `een/plaat--${img}.png.md`]));
    expect(existsSync(join(vault, "twee"))).toBe(false);
    expect(b.read({ ids: [img], view: "image" }).image).toBeDefined();

    expect(w.organize({ action: "delete", ids: [img], confirm: [img] }).text).toMatch(/^OK deleted 1/);
    expect(all().some((f) => f.includes(img))).toBe(false);
  });

  it("een groep verwijderen neemt de afbeeldingen mee; reconcile pikt een met de hand gezet plaatje + sidecar op", () => {
    const g = idOf(w.organize({ action: "create_group", title: "Weg", summary: "s" }));
    add("Binnen", { group: g });
    expect(w.organize({ action: "delete", ids: [g], confirm: [g] }).text).toMatch(/^OK deleted 2/);
    expect(all().filter((f) => f.includes("binnen"))).toEqual([]);

    writeFileSync(join(vault, "hand.png"), PNG);
    writeFileSync(join(vault, "hand.png.md"), `---\nid: i_hand0001\ntitle: Handmatig\nsummary: Zelf neergezet.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\nfile: hand.png\nmime: image/png\nbytes: ${PNG.length}\nhash: abcdef0123456789\n---\n`);
    expect(reconcile(db, vault).added).toBe(1);
    expect(b.find({ query: "kind:image zelf" }).ids).toEqual(["i_hand0001"]);
  });

  it("een kapotte sidecar wordt als kapot gemarkeerd en nergens gerepareerd", () => {
    writeFileSync(join(vault, "slecht.png.md"), "---\nid: i_slecht01\ntitle: x\n---\n");
    reconcile(db, vault);
    expect(db.prepare("SELECT status FROM items WHERE path='slecht.png.md'").get()).toMatchObject({ status: "broken" });
  });
});
