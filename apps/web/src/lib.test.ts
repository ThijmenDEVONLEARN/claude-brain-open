import { describe, expect, it } from "vitest";
import { MAX_RINGS, galaxyBudget, groupPositions, itemPos, kindRings, ringRadius, titleBudget, visibleCount } from "./lib";

describe("indeling van groepen", () => {
  it("verdeelt groepen over meerdere banen, binnenste het kleinst in aantal", () => {
    const { pos, rings } = groupPositions(40, "banen");
    expect(pos).toHaveLength(40);
    expect(rings.length).toBeGreaterThan(2);
    expect(rings).toEqual([...rings].sort((a, b) => a - b));
    const first = Math.hypot(...pos[0]!);
    expect(first).toBeCloseTo(rings[0]!, 5);
  });
  it("geeft elke groep een eigen plek in alle indelingen", () => {
    for (const l of ["banen", "raster", "grootte"] as const) {
      const { pos } = groupPositions(30, l);
      expect(new Set(pos.map(([x, z]) => `${Math.round(x)},${Math.round(z)}`)).size).toBe(30);
    }
  });
  it("kan met 0 en 1 groep omgaan", () => {
    expect(groupPositions(0, "banen").pos).toEqual([]);
    expect(groupPositions(1, "raster").pos).toHaveLength(1);
  });
});

describe("banen per soort", () => {
  it("houdt hooguit 8 banen en voegt de rest samen tot overig", () => {
    const types = Array.from({ length: 12 }, (_, i) => ({ type: `t${i}`, count: 100 - i }));
    const r = kindRings(types);
    expect(r).toHaveLength(MAX_RINGS);
    expect(r.at(-1)).toMatchObject({ kind: "overig", count: types.slice(7).reduce((a, t) => a + t.count, 0) });
    expect(r.at(-1)!.types).toHaveLength(5);
    expect(r[0]!.kind).toBe("t0");
  });
  it("laat een klein aantal soorten ongemoeid", () => {
    expect(kindRings([{ type: "a", count: 1 }, { type: "b", count: 5 }]).map((r) => r.kind)).toEqual(["b", "a"]);
  });
});

describe("items", () => {
  it("per soort ligt elk item op de straal van zijn baan", () => {
    for (let i = 0; i < 20; i++) expect(Math.hypot(...itemPos("soort", "n_x", 2, i, i))).toBeCloseTo(ringRadius(2), 5);
  });
  it("zelfde id geeft altijd dezelfde plek (vrij)", () => {
    expect(itemPos("vrij", "n_abcdefgh", 0, 0, 0)).toEqual(itemPos("vrij", "n_abcdefgh", 3, 9, 9));
  });
  it("tijdlijn zet nieuwere items dichter bij het midden", () => {
    expect(Math.hypot(...itemPos("tijd", "a", 0, 0, 2))).toBeLessThan(Math.hypot(...itemPos("tijd", "b", 0, 0, 200)));
  });
});

describe("zoomniveaus (LOD)", () => {
  it("toont weinig items los en meer naarmate je inzoomt, nooit meer dan er zijn", () => {
    expect(visibleCount(10, 1)).toBe(10);
    expect(visibleCount(200, 1)).toBe(40);
    expect(visibleCount(200, 2)).toBeGreaterThan(visibleCount(200, 1));
    expect(visibleCount(200, 50)).toBe(200);
    expect(visibleCount(200, 0.2)).toBe(40);
  });
  it("beperkt titels en melkwegen, en laat ze bij inzoomen groeien", () => {
    expect(titleBudget(1)).toBe(8);
    expect(titleBudget(3)).toBeGreaterThan(8);
    expect(titleBudget(100)).toBe(30);
    expect(galaxyBudget(500, 1)).toBe(24);
    expect(galaxyBudget(500, 3)).toBeGreaterThan(24);
    expect(galaxyBudget(5, 1)).toBe(5);
  });
});

import { itemLift, lift } from "./lib";
describe("hoogte", () => {
  it("is vast per id en blijft binnen de ruimte", () => {
    expect(lift("g_1", 300)).toBe(lift("g_1", 300));
    for (let i = 0; i < 200; i++) expect(Math.abs(lift(`g_${i}`, 300))).toBeLessThanOrEqual(150);
    expect(itemLift("n_1", 0, true)).not.toBe(itemLift("n_2", 0, true));
  });
});
