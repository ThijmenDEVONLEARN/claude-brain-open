import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, QueryError } from "./query";
import { Brain } from "./read";
import { rebuild } from "./rebuild";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

const g = (id: string, t: string) => `---\nid: ${id}\ntitle: ${t}\nsummary: Groep ${t}.\nstatus: active\n---\n`;
const n = (id: string, t: string, extra = "", body = "## Kop\ntekst\n", status = "active") =>
  `---\nid: ${id}\ntitle: ${t}\nsummary: Over ${t}.\n${extra}status: ${status}\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\n${body}`;

let dir: string;
let b: Brain;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-read-"));
  const v = join(dir, "vault");
  mkdirSync(join(v, "werk", "klanten"), { recursive: true });
  writeFileSync(join(v, "_group.md"), g("g_00000000", "Heelal"));
  writeFileSync(join(v, "werk", "_group.md"), g("g_00000001", "Werk"));
  writeFileSync(join(v, "werk", "klanten", "_group.md"), g("g_00000002", "Klanten"));
  writeFileSync(join(v, "werk", "klanten", "intake.md"), n("n_00000001", "Intake", "tags: [proces/klant]\nlinks:\n  - { to: n_00000002, type: depends_on }\n", "## Stappen\nkraakhelder plan\n\n## Eind\nklaar\n"));
  writeFileSync(join(v, "werk", "klanten", "offerte.md"), n("n_00000002", "Offerte", "parent: n_00000001\n", "## Velden\nprijzen kraakhelder\n"));
  writeFileSync(join(v, "werk", "klanten", "oud.md"), n("n_00000003", "Oud plan", "", "## X\nkraakhelder\n", "archived"));
  const db = join(dir, "index.db");
  rebuild(v, db);
  b = new Brain(new DatabaseSync(db, { readOnly: true }), v);
});
afterAll(() => rmTmp(dir));

describe("query", () => {
  it("weigert vrije tekst binnen OR en onbekende filters", () => {
    expect(() => compile("a OR b")).toThrow(QueryError);
    expect(() => compile("bestaatniet:x")).toThrow(QueryError);
  });
  it("verbergt archief standaard", () => {
    expect(compile("tag:x").where).toContain("status = 'active'");
    expect(compile("tag:x status:any").statusExplicit).toBe(true);
  });
});

describe("Brain", () => {
  it("map toont groepen met aantallen", () => {
    const r = b.map();
    expect(r.text).toContain("werk");
  });
  it("find: sectietreffer geeft sectie-slug, archief verborgen", () => {
    const r = b.find({ query: "kraakhelder" });
    expect(r.ids.sort()).toEqual(["n_00000001", "n_00000002"]);
    expect(r.text).toContain("§stappen");
    expect(b.find({ query: "kraakhelder status:archived" }).ids).toEqual(["n_00000003"]);
  });
  it("find: filters, uitsluiten en foutmelding", () => {
    expect(b.find({ query: "tag:proces" }).ids).toEqual(["n_00000001"]);
    expect(b.find({ query: "kraakhelder -prijzen" }).ids).toEqual(["n_00000001"]);
    expect(b.find({ query: "parent:n_00000001" }).ids).toEqual(["n_00000002"]);
    expect(b.find({ query: "a OR b" }).text).toMatch(/^ERROR invalid_query/);
    expect(b.find({ query: "x", cursor: "zzz" }).text).toMatch(/^ERROR invalid_cursor/);
  });
  it("find: pagineert met cursor", () => {
    const p1 = b.find({ query: "kraakhelder", limit: 1 });
    expect(p1.text).toContain("cursor:c1");
    expect(b.find({ query: "kraakhelder", limit: 1, cursor: "c1" }).ids).toHaveLength(1);
  });
  it("read: outline, sectie, onbekend en ongeldig id", () => {
    expect(b.read({ ids: ["n_00000001"] }).text).toContain("stappen");
    expect(b.read({ ids: ["n_00000001"], view: "section", section: "eind" }).text).toContain("klaar");
    expect(b.read({ ids: ["n_99999999", "../etc"] }).text).toMatch(/not_found[\s\S]*invalid_id|invalid_id[\s\S]*not_found/);
    expect(b.read({ ids: ["n_00000001"], view: "section" }).text).toMatch(/^ERROR invalid_args/);
  });
  it("related: volgt parent en links", () => {
    const r = b.related({ id: "n_00000001" });
    expect(r.text).toContain("n_00000002");
  });
});
