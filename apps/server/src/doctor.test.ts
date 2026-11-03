import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writer } from "@claude-brain/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startVbs, taskXml } from "./autostart";
import { loadConfig } from "./config";
import { diagnose } from "./doctor";
import { openIndex, startServer } from "./start";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "brain-doctor-"))));
afterEach(() => rmTmp(dir));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const note = (id: string, extra = "") => `---\nid: ${id}\ntitle: Titel ${id}\nsummary: Samenvatting van ${id} die lang genoeg is.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n${extra}---\nTekst\n`;

function setup() {
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const db = openIndex(join(dir, "index.db"), vault);
  return { vault, db, writer: new Writer(db, vault) };
}

describe("brain doctor", () => {
  it("meldt een gezonde kluis niet als fout", () => {
    const { vault, db, writer } = setup();
    writeFileSync(join(vault, "a.md"), note("n_aaaaaaaa"));
    expect(diagnose(db, vault, writer).filter((f) => f.level !== "info")).toEqual([]);
  });

  it("vindt kapotte bestanden, hangende links, een ontbrekende parent en een plaatje zonder bestand", () => {
    const { vault, db, writer } = setup();
    writeFileSync(join(vault, "kapot.md"), "---\nid: n_bbbbbbbb\n---\n"); // geen titel
    writeFileSync(join(vault, "a.md"), note("n_aaaaaaaa", "parent: n_zzzzzzzz\nlinks:\n  - to: n_yyyyyyyy\n    type: relates_to\n"));
    const f = diagnose(db, vault, writer);
    const codes = f.map((x) => x.code);
    expect(codes).toContain("broken_files");
    expect(codes).toContain("dangling_links");
    expect(codes).toContain("missing_parent");
    expect(f.find((x) => x.code === "dangling_links")!.msg).toContain("n_aaaaaaaa → n_yyyyyyyy");
    expect(f.find((x) => x.code === "broken_files")!.level).toBe("fout");
  });

  it("pikt bestanden op die met de hand zijn toegevoegd (index liep achter)", () => {
    const { vault, db, writer } = setup();
    writeFileSync(join(vault, "a.md"), note("n_aaaaaaaa"));
    expect(diagnose(db, vault, writer).map((x) => x.code)).toContain("index_drift");
    expect(db.prepare("SELECT COUNT(*) n FROM items").get()).toEqual({ n: 1 });
  });

  it("vindt een los plaatje en --fix maakt een sidecar zonder het plaatje te wijzigen", () => {
    const { vault, db, writer } = setup();
    mkdirSync(join(vault, "foto"));
    writeFileSync(join(vault, "foto", "mijn-kat.png"), PNG);
    expect(diagnose(db, vault, writer).map((x) => x.code)).toContain("stray_images");
    expect(existsSync(join(vault, "foto", "mijn-kat.png.md"))).toBe(false);

    expect(diagnose(db, vault, writer, true).map((x) => x.code)).toContain("stray_images_fixed");
    expect(existsSync(join(vault, "foto", "mijn-kat.png.md"))).toBe(true);
    expect(db.prepare("SELECT kind, title, group_path FROM items WHERE kind='image'").get()).toMatchObject({ kind: "image", title: "mijn kat" });
    expect(diagnose(db, vault, writer).map((x) => x.code)).not.toContain("stray_images");
  });

  it("zonder writer (server draait) past hij niets aan", () => {
    const { vault, db } = setup();
    writeFileSync(join(vault, "los.png"), PNG);
    const codes = diagnose(db, vault, undefined, true).map((x) => x.code);
    expect(codes).toContain("stray_images");
    expect(existsSync(join(vault, "los.png.md"))).toBe(false);
  });
});

describe("autostart", () => {
  it("maakt een venstervrije wrapper met correcte quotes", () => {
    const v = startVbs("C:\\Program Files\\nodejs\\node.exe", "C:\\code\\brain.mjs", "C:\\Users\\dev\\ClaudeBrain\\logs\\server.log", "C:\\Users\\dev\\ClaudeBrain");
    expect(v).toContain(`rc = sh.Run("cmd /c """"C:\\Program Files\\nodejs\\node.exe"" ""C:\\code\\brain.mjs"" serve >> ""C:\\Users\\dev\\ClaudeBrain\\logs\\server.log"" 2>&1""", 0, True)`);
  });

  it("wrapper start de server zelf opnieuw, behalve na netjes stoppen (0) of 'draait al' (3), en wacht steeds langer", () => {
    const v = startVbs("node.exe", "brain.mjs", "server.log", "C:\\root");
    expect(v).toContain("Do");
    expect(v).toContain("If rc = 0 Or rc = 3 Then Exit Do");
    expect(v).toContain("wacht = wacht * 2");
    expect(v).toContain("WScript.Sleep wacht * 1000");
    expect(v).toMatch(/Loop\r\nWScript\.Quit rc/);
  });

  it("taak: bij aanmelden, zonder adminrechten, XML-veilig", () => {
    const x = taskXml("PC\\dev & co", "C:\\x\\start.vbs");
    expect(x).toContain("<LogonTrigger>");
    expect(x).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(x).toContain("PC\\dev &amp; co");
    expect(x).toContain('//B //Nologo "C:\\x\\start.vbs"');
  });
});

describe("UI-cookie", () => {
  it("?token zet een cookie en stuurt door; het cookie werkt voor / maar nooit voor /mcp", async () => {
    const port = await new Promise<number>((res) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    const cfg = { ...loadConfig(join(dir, "home")), port };
    const srv = await startServer(cfg);
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/`)).status).toBe(401);
      expect((await fetch(`${base}/?token=fout`, { redirect: "manual" })).status).toBe(401);
      const r = await fetch(`${base}/?token=${cfg.token}`, { redirect: "manual" });
      expect(r.status).toBe(302);
      const cookie = r.headers.get("set-cookie")!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).not.toContain(cfg.token);
      const c = cookie.split(";")[0]!;
      expect((await fetch(`${base}/`, { headers: { cookie: c } })).status).toBe(200);
      const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: "{}" });
      expect(mcp.status).toBe(401);
    } finally {
      await srv.close();
    }
  });
});
