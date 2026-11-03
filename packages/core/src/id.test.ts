import { describe, expect, it } from "vitest";
import { kindOf, newId } from "./id";

describe("id", () => {
  it("heeft prefix en 8 tekens base36", () => {
    expect(newId("note")).toMatch(/^n_[0-9a-z]{8}$/);
    expect(newId("image")).toMatch(/^i_[0-9a-z]{8}$/);
    expect(newId("group")).toMatch(/^g_[0-9a-z]{8}$/);
  });

  it("geeft geen dubbelen in 10.000 ids", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId("note")));
    expect(ids.size).toBe(10_000);
  });

  it("herkent de soort aan de id en weigert ongeldige ids", () => {
    expect(kindOf(newId("image"))).toBe("image");
    expect(kindOf("x_12345678")).toBeUndefined();
    expect(kindOf("n_123")).toBeUndefined();
  });
});
