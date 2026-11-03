import { describe, expect, it } from "vitest";
import { blocks, inline } from "./markdown";

describe("veilige markdown", () => {
  it("laat HTML als gewone tekst staan (nooit uitvoeren)", () => {
    expect(inline("<script>alert(1)</script> en <img src=x onerror=alert(1)>")).toEqual([{ t: "text", v: "<script>alert(1)</script> en <img src=x onerror=alert(1)>" }]);
    expect(blocks("<b>hoi</b>")).toEqual([{ t: "p", c: [{ t: "text", v: "<b>hoi</b>" }] }]);
  });
  it("weigert gevaarlijke linkdoelen", () => {
    for (const bad of ["javascript:void0", "data:text/html,x", "http://evil.com", "//evil.com", "file:///etc/passwd", "brain:../../x"]) {
      expect(inline(`[klik](${bad})`)).toEqual([{ t: "text", v: "klik" }]);
    }
  });
  it("staat brain- en https-links toe", () => {
    expect(inline("[a](brain:n_00000001)")).toEqual([{ t: "link", href: "brain:n_00000001", c: [{ t: "text", v: "a" }] }]);
    expect(inline("[a](https://example.com/x?y=1)")[0]).toMatchObject({ t: "link", href: "https://example.com/x?y=1" });
  });
  it("laat alleen afbeeldingen uit de eigen kluis toe", () => {
    expect(inline("![plaat](brain:i_00000001)")).toEqual([{ t: "img", id: "i_00000001", alt: "plaat" }]);
    expect(inline("![x](https://evil.com/track.png)")).toEqual([{ t: "text", v: "x" }]);
    expect(inline("![x](brain:n_00000001)")).toEqual([{ t: "text", v: "x" }]);
  });
  it("herkent koppen, lijsten, code en opmaak", () => {
    const b = blocks("# Kop\n\ntekst met **vet** en `code`\nnog een regel\n\n- een\n- twee\n\n1. a\n2. b\n\n```\n<b>raw</b>\n```\n> citaat");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "code", "quote"]);
    expect(b[1]).toMatchObject({ c: [{ t: "text", v: "tekst met " }, { t: "b" }, { t: "text", v: " en " }, { t: "code", v: "code" }, { t: "text", v: " nog een regel" }] });
    expect(b[4]).toEqual({ t: "code", v: "<b>raw</b>" });
  });
  it("snakeCase blijft heel en onvolledige opmaak crasht niet", () => {
    expect(inline("snake_case_naam")).toEqual([{ t: "text", v: "snake_case_naam" }]);
    expect(() => inline("**open [link( ![x](")).not.toThrow();
  });
});
