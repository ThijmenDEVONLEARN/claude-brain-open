import { describe, expect, it } from "vitest";
import { parseGroup, parseNote } from "./parse";

const fm = (extra = "") =>
  `---\nid: n_k7x2m9qa\ntitle: Intake\nsummary: Vijf stappen.\nstatus: active\ncreated: 2026-10-31T00:40:00Z\nupdated: 2026-10-31T00:40:00Z\n${extra}---\n`;

describe("parseNote", () => {
  it("leest frontmatter, defaults en datums als ISO-string", () => {
    const p = parseNote(fm() + "tekst");
    expect(p.meta).toMatchObject({ id: "n_k7x2m9qa", type: "note", tags: [], links: [], status: "active" });
    expect(p.meta.created).toBe("2026-10-31T00:40:00.000Z");
  });

  it("maakt secties met stabiele, uniek gemaakte slugs en offsets", () => {
    const body = "intro\n## Stappen\neen\n## Stappen\ntwee\n### Détails & meer!\nx\n";
    const p = parseNote(fm() + body);
    expect(p.sections.map((s) => [s.heading, s.slug, s.level])).toEqual([
      ["", "", 0],
      ["Stappen", "stappen", 2],
      ["Stappen", "stappen-2", 2],
      ["Détails & meer!", "details-meer", 3],
    ]);
    const s = p.sections[1]!;
    expect(p.body.slice(s.start, s.end)).toBe("## Stappen\neen\n");
  });

  it("slaat koppen en links in fenced code over", () => {
    const body = "```\n## geen kop\n[x](brain:n_aaaaaaaa)\n```\n## Echt\n[y](brain:n_bbbbbbbb#sec) ![z](brain:i_cccccccc)\n";
    const p = parseNote(fm() + body);
    expect(p.sections.map((s) => s.heading)).toEqual(["", "Echt"]);
    expect(p.inline.sort()).toEqual(["i_cccccccc", "n_bbbbbbbb"]);
  });

  it("neemt geen lege intro op en kent geen kopjes zonder tekst", () => {
    expect(parseNote(fm() + "## Alleen kop\n").sections.map((s) => s.heading)).toEqual(["Alleen kop"]);
  });

  it("weigert ontbrekende of ongeldige velden met een leesbare reden", () => {
    expect(() => parseNote(fm().replace("summary: Vijf stappen.\n", ""))).toThrow(/summary/);
    expect(() => parseNote(fm().replace("n_k7x2m9qa", "x_1"))).toThrow(/id/);
    expect(() => parseNote(fm().replace("status: active", "status: weg"))).toThrow(/status/);
    expect(() => parseNote("---\n: : kapot [\n---\n")).toThrow();
  });

  it("verwerkt Windows-regeleinden", () => {
    const p = parseNote((fm() + "## A\r\ntekst\r\n## B\r\nmeer\r\n").replaceAll("\n", "\r\n").replaceAll("\r\r\n", "\r\n"));
    expect(p.sections.map((s) => s.heading)).toEqual(["A", "B"]);
  });
});

describe("parseGroup", () => {
  it("vereist een g_-id", () => {
    const ok = "---\nid: g_m3n4b5v6\ntitle: Klanten\nsummary: x\nstatus: active\n---\n";
    expect(parseGroup(ok).meta.id).toBe("g_m3n4b5v6");
    expect(() => parseGroup(ok.replace("g_m3n4b5v6", "n_m3n4b5v6"))).toThrow(/id/);
  });
});
