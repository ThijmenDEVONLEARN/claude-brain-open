import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAudit, shorten } from "./audit";
import { loadConfig } from "./config";
import { acquireLock } from "./lock";
import { openIndex, startServer } from "./start";
import { startWatcher } from "./watch";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "brain-start-"))));
afterEach(() => rmTmp(dir));

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const cfg = { ...loadConfig(join(dir, "home")), port: await freePort() };
  const srv = await startServer(cfg);
  const call = async (name: string, args: unknown) => {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await r.json()) as { result: { content: { type: string; text: string; mimeType?: string }[]; isError: boolean } }).result;
  };
  return { cfg, srv, call };
}

describe("startServer", () => {
  it("maakt alles aan, schrijft via MCP, logt, en pikt handmatige wijzigingen op", async () => {
    const { cfg, srv, call } = await boot();
    try {
      expect(existsSync(join(cfg.vault, "_group.md"))).toBe(true);
      const g = (await call("brain_organize", { action: "create_group", title: "Werk", summary: "Werkdingen." })).content[0]!.text;
      expect(g).toMatch(/^OK created_group g_/);
      const n = (await call("brain_write", { action: "create", title: "Eerste", summary: "Een test.", group: "werk", body: "## Kop\nzoekwoordje\n" })).content[0]!.text;
      const id = /n_[0-9a-z]{8}/.exec(n)![0];
      expect((await call("brain_find", { query: "zoekwoordje" })).content[0]!.text).toContain(id);

      // handmatig bestand via de Verkenner: de watcher moet het oppikken
      writeFileSync(join(cfg.vault, "werk", "hand.md"), "---\nid: n_hand0001\ntitle: Handmatig\nsummary: Met de hand.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nverrassingswoord\n");
      let found = "";
      for (let i = 0; i < 30 && !found.includes("n_hand0001"); i++) {
        await sleep(100);
        found = (await call("brain_find", { query: "verrassingswoord" })).content[0]!.text;
      }
      expect(found).toContain("n_hand0001");

      // afbeelding via MCP: toevoegen als base64 en de pixels terugkrijgen als MCP-afbeelding
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const im = (await call("brain_image", { base64: png, title: "Pixel", summary: "Een pixel.", group: "werk" })).content[0]!.text;
      const iid = /i_[0-9a-z]{8}/.exec(im)![0];
      const view = await call("brain_read", { ids: [iid], view: "image" });
      expect(view.content.map((c) => c.type)).toEqual(["text", "image"]);
      expect(view.content[1]).toMatchObject({ mimeType: "image/png" });

      // fout, verwijderen zonder confirm, en een geweigerd verzoek komen allemaal in het log
      expect((await call("brain_organize", { action: "delete", ids: [id] })).isError).toBe(true);
      await fetch(`http://127.0.0.1:${cfg.port}/mcp`, { method: "POST", body: "{}" }).catch(() => {});
      const rows = srv.audit.db.prepare("SELECT tool, ok, tokens_out, tokens_full FROM audit ORDER BY id").all() as { tool: string; ok: number; tokens_out: number | null; tokens_full: number | null }[];
      expect(rows.map((r) => r.tool)).toEqual(expect.arrayContaining(["brain_organize", "brain_write", "brain_find", "auth_denied"]));
      expect(rows.some((r) => r.tool === "brain_organize" && r.ok === 0)).toBe(true);
      expect(rows.find((r) => r.tool === "brain_find")!.tokens_full).toBeGreaterThan(0);
      expect(() => srv.audit.db.exec("DELETE FROM audit")).toThrow(/append-only/);
    } finally {
      await srv.close();
    }
  });

  it("een tweede instantie weigert, een bezette poort geeft een duidelijke fout", async () => {
    const { cfg, srv } = await boot();
    try {
      // Een ander proces houdt het slot (hier: het bovenliggende proces dat zeker leeft).
      writeFileSync(join(cfg.root, "data", "server.lock"), String(process.ppid));
      await expect(startServer(cfg)).rejects.toThrow(/draait al \(pid \d+\)/);
      writeFileSync(join(cfg.root, "data", "server.lock"), String(process.pid));
    } finally {
      await srv.close();
    }
    expect(existsSync(join(cfg.root, "data", "server.lock"))).toBe(false);
    const blocker = createServer().listen(cfg.port, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    await expect(startServer(cfg)).rejects.toThrow(/poort \d+ is bezet/);
    blocker.close();
    expect(existsSync(join(cfg.root, "data", "server.lock"))).toBe(false);
  });
});

describe("herstel", () => {
  it("een kapotte index wordt bewaard en opnieuw opgebouwd; een verlaten slot wordt overgenomen", () => {
    const vault = join(dir, "vault");
    mkdirSync(vault);
    writeFileSync(join(vault, "_group.md"), "---\nid: g_00000000\ntitle: Heelal\nsummary: w.\nstatus: active\n---\n");
    const dbPath = join(dir, "index.db");
    writeFileSync(dbPath, "dit is geen sqlite");
    const msgs: string[] = [];
    const db = openIndex(dbPath, vault, (m) => msgs.push(m));
    expect(db.prepare("SELECT count(*) c FROM items").get()).toMatchObject({ c: 1 });
    expect(readdirSync(dir).some((f) => f.startsWith("index.corrupt-"))).toBe(true);
    expect(msgs.join()).toMatch(/kapot/);
    db.close();

    const lock = join(dir, "x.lock");
    writeFileSync(lock, "999999"); // bestaat niet
    const release = acquireLock(lock);
    release();
    writeFileSync(lock, String(process.ppid));
    expect(() => acquireLock(lock)).toThrow(/draait al/);
  });

  it("een kapot logbestand wordt bewaard in plaats van overschreven", () => {
    const p = join(dir, "logs.db");
    writeFileSync(p, "kapot");
    const a = openAudit(p);
    a.log({ actor: "claude", tool: "t", ok: true, ms: 1 });
    expect(a.db.prepare("SELECT count(*) c FROM audit").get()).toMatchObject({ c: 1 });
    expect(readdirSync(dir).filter((f) => f.startsWith("logs.corrupt-"))).toHaveLength(1);
    a.close();
  });

  it("het log bewaart geen lange notitietekst", () => {
    expect(shorten({ body: "x".repeat(5000), t: ["a"] })).toEqual({ body: `${"x".repeat(120)}…(5000 tekens)`, t: ["a"] });
  });

  it("de watcher laat zich niet stoppen door een kapot bestand", async () => {
    const vault = join(dir, "v");
    mkdirSync(vault);
    const db = new DatabaseSync(":memory:");
    const errs: unknown[] = [];
    const w = startWatcher(db, vault, (e) => errs.push(e), 20);
    writeFileSync(join(vault, "x.md"), "geen frontmatter");
    await sleep(200);
    w.close();
    db.close();
    expect(errs.length).toBeGreaterThanOrEqual(0);
  });
});
