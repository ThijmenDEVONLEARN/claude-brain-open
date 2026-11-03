import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Brain, UiData, Writer, rebuild } from "@claude-brain/core";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuditEntry, openAudit } from "./audit";
import { buildServer } from "./server";

const TOKEN = "u".repeat(64);
const PORT = 4748;
const COOKIE = `brain_session=${createHmac("sha256", TOKEN).update("ui-session").digest("hex")}`;
const H = { host: `127.0.0.1:${PORT}` };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const note = (id: string, title: string, extra = "", body = "tekst") => `---\nid: ${id}\ntitle: ${title}\nsummary: S ${title}.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n${extra}---\n${body}\n`;

let dir: string;
let app: ReturnType<typeof buildServer>;
let writer: Writer;
let auditDb: ReturnType<typeof openAudit>;
const log: AuditEntry[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-ui-"));
  const v = join(dir, "vault");
  mkdirSync(join(v, "klanten"), { recursive: true });
  mkdirSync(join(v, "tech"));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(dir, "web", "app.js"), "1");
  writeFileSync(join(dir, "secret.txt"), "geheim");
  writeFileSync(join(v, "_group.md"), "---\nid: g_00000000\ntitle: Heelal\nsummary: Wortel.\nstatus: active\n---\n");
  writeFileSync(join(v, "klanten", "_group.md"), "---\nid: g_00000001\ntitle: Klanten\nsummary: K.\nstatus: active\n---\n");
  writeFileSync(join(v, "tech", "_group.md"), "---\nid: g_00000002\ntitle: Tech\nsummary: T.\nstatus: active\n---\n");
  writeFileSync(join(v, "klanten", "a.md"), note("n_00000001", "Alfa", "type: contact\ntags: [vip]\nlinks:\n  - to: n_00000002\n    type: uses\n", "zonnestelsel ![x](brain:i_00000001)"));
  writeFileSync(join(v, "tech", "b.md"), note("n_00000002", "Beta", "type: concept\n"));
  writeFileSync(join(v, "klanten", "i.png"), PNG);
  writeFileSync(join(v, "klanten", "i.png.md"), `---\nid: i_00000001\ntitle: Plaatje\nsummary: Een plaatje.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\nfile: i.png\nmime: image/png\nbytes: ${PNG.length}\nhash: abcdef0123456789\n---\n`);
  rebuild(v, join(dir, "index.db"));
  const db = new DatabaseSync(join(dir, "index.db"));
  const brain = new Brain(db, v);
  writer = new Writer(db, v);
  auditDb = openAudit(join(dir, "logs.db"), db);
  const seed = (e: AuditEntry) => auditDb.log(e);
  seed({ actor: "claude", client: "claude-code", tool: "brain_find", args: { query: "zonnestelsel" }, ids: ["n_00000001", "n_00000002"], ok: true, ms: 3, tokensOut: 40 });
  seed({ actor: "claude", client: "claude-code", tool: "brain_write", args: { action: "create", title: "Alfa" }, ids: ["n_00000001"], ok: true, ms: 9, tokensOut: 50 });
  seed({ actor: "claude", client: "claude-code", tool: "brain_write", args: { action: "append", id: "n_00000002" }, ids: ["n_00000002"], ok: true, ms: 5, tokensOut: 20 });
  seed({ actor: "unknown", client: "curl", tool: "auth_denied", args: { reason: "unauthorized" }, ok: false, ms: 0 });
  app = buildServer({ brain, writer, token: TOKEN, port: PORT, ui: new UiData(db, v, brain, auditDb.db), webDir: join(dir, "web"), audit: (e) => { log.push(e); seed(e); } });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  auditDb.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows houdt SQLite vast */
  }
});
const get = (url: string, headers: Record<string, string> = { cookie: COOKIE }) => app.inject({ method: "GET", url, headers: { ...H, ...headers } });

describe("UI-API", () => {
  it("vereist inlog; cookie werkt voor /api en /assets maar nooit voor /mcp", async () => {
    expect((await get("/api/overview", {})).statusCode).toBe(401);
    expect((await get("/api/overview")).statusCode).toBe(200);
    expect((await get("/mcp")).statusCode).toBe(401);
    expect((await get("/api/overview", { cookie: "brain_session=00" })).statusCode).toBe(401);
    expect((await get("/api/overview", { cookie: COOKIE, origin: "http://evil.com" })).statusCode).toBe(403);
  });

  it("/favicon.ico geeft 204 zonder inlog en komt niet in het logboek", async () => {
    const n = () => log.filter((e) => e.tool === "auth_denied").length;
    const before = n();
    expect((await get("/favicon.ico", {})).statusCode).toBe(204);
    expect(n()).toBe(before);
  });
  it("overzicht: groepen met aantallen en gebundelde links", async () => {
    const o = (await get("/api/overview")).json();
    expect(o.groups.map((g: { title: string; count: number }) => [g.title, g.count]).sort()).toEqual([["Klanten", 1], ["Tech", 1]]);
    expect(o.total).toBe(2);
    expect(o.bundles).toEqual([{ a: "/klanten/", b: "/tech/", type: "uses", count: 1 }]);
  });
  it("gelijktijdige eerste aanvragen krijgen allebei de bundels, ook als er net iets verandert", async () => {
    const fresh = new UiData(new DatabaseSync(join(dir, "index.db")), join(dir, "vault"), new Brain(new DatabaseSync(join(dir, "index.db")), join(dir, "vault")));
    const [a, b] = await Promise.all([fresh.overview(), fresh.overview()]);
    expect(a.bundles).toHaveLength(1);
    expect(b.bundles).toEqual(a.bundles);
  });
  it("groep, items, item met links en afbeelding", async () => {
    const g = (await get("/api/group/g_00000001")).json();
    expect(g.crumbs.map((c: { title: string }) => c.title)).toEqual(["Heelal", "Klanten"]);
    expect(g.direct.types).toEqual([{ type: "contact", count: 1, tags: [{ tag: "vip", count: 1 }] }]);
    const items = (await get("/api/items?group=g_00000001&type=contact")).json();
    expect(items.items.map((i: { id: string }) => i.id)).toEqual(["n_00000001"]);
    const it = (await get("/api/item/n_00000001")).json();
    expect(it.body).toContain("zonnestelsel");
    expect(it.links.map((l: { id: string }) => l.id)).toContain("n_00000002");
    expect(it.images).toEqual(["i_00000001"]);
    expect((await get("/api/item/n_00000002")).json().backlinks.map((l: { id: string }) => l.id)).toEqual(["n_00000001"]);
  });
  it("zoeken laat afbeeldingen buiten beeld en meldt fouten in de querytaal", async () => {
    const s = (await get("/api/search?q=plaatje")).json();
    expect(s.hits).toEqual([]);
    expect((await get("/api/search?q=zonnestelsel")).json().hits.map((h: { id: string }) => h.id)).toEqual(["n_00000001"]);
    expect((await get("/api/search?q=type:")).json().error).toBeTruthy();
  });
  it("afbeelding komt uit de index, met veilige headers; rare ids geven 404", async () => {
    const r = await get("/api/image/i_00000001");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect((await get("/api/image/..%2Fsecret.txt")).statusCode).toBe(404);
    expect((await get("/api/image/n_00000001")).statusCode).toBe(404);
    expect((await get("/api/item/..%2F..%2Fsecret")).statusCode).toBe(404);
  });
  it("serveert alleen bekende statische bestanden, met CSP", async () => {
    const h = await get("/");
    expect(h.statusCode).toBe(200);
    expect(h.headers["content-security-policy"]).toContain("script-src 'self'");
    expect((await get("/assets/app.js")).statusCode).toBe(200);
    expect((await get("/assets/secret.txt")).statusCode).toBe(404);
    expect((await get("/assets/..%2Fsecret.txt")).statusCode).toBe(404);
  });
  it("legt UI-aanvragen vast als actor ui", async () => {
    expect(log.some((e) => e.actor === "ui" && e.tool === "ui_overview" && e.ok)).toBe(true);
  });
});

describe("dashboard en logs", () => {
  it("toont aantallen, tokenbesparing en waar Claude het laatst mee bezig was", async () => {
    const d = (await get("/api/dashboard")).json();
    expect(d.stats).toMatchObject({ notes: 2, images: 1, groups: 3, archived: 0, broken: 0 });
    expect(d.stats.growth).toHaveLength(30);
    expect(d.searches).toEqual(["zonnestelsel"]);
    expect(d.whereWasI).toMatchObject({ calls: 3, created: 1, changed: 1, searches: 1 });
    expect(d.whereWasI.touched.map((t: { id: string }) => t.id)).toEqual(["n_00000002", "n_00000001"]);
    expect(d.whereWasI.touched).toHaveLength(2);
    expect(d.whereWasI.last).toEqual({ id: "n_00000002", groupId: "g_00000002" });
    expect(d.recent.map((r: { label: string }) => r.label)).toContain("Alfa");
    expect(d.groups.map((g: { title: string }) => g.title).sort()).toEqual(["Klanten", "Tech"]);
  });
  it("logboek: standaard zonder UI-leesverzoeken, met zoeken en filteren", async () => {
    const all = (await get("/api/logs")).json();
    expect(all.rows.some((r: { actor: string; tool: string }) => r.actor === "ui" && r.tool !== "ui_delete")).toBe(false);
    expect(all.rows.map((r: { tool: string }) => r.tool)).toEqual(expect.arrayContaining(["brain_find", "brain_write", "auth_denied"]));
    expect((await get("/api/logs?q=zonnestelsel")).json().rows.map((r: { tool: string }) => r.tool)).toEqual(["brain_find"]);
    expect((await get("/api/logs?ok=0")).json().rows.every((r: { tool: string; ok: boolean }) => r.tool === "auth_denied" && !r.ok)).toBe(true);
    expect((await get("/api/logs?actor=claude&limit=2")).json()).toMatchObject({ rows: expect.any(Array), next: expect.any(Number) });
    expect((await get("/api/logs?q=100%25_")).json().rows).toEqual([]);
    expect((await get("/api/logs?reads=1")).json().rows.some((r: { actor: string }) => r.actor === "ui")).toBe(true);
  });
});

describe("verwijderen vanuit de UI", () => {
  const del = (id: string, headers: Record<string, string>) => app.inject({ method: "DELETE", url: `/api/items/${id}`, headers: { ...H, ...headers } });
  const ORIGIN = { origin: `http://127.0.0.1:${PORT}` };
  const mk = (title: string, group?: string) => /n_[0-9a-z]{8}/.exec(writer.write({ action: "create", title, summary: `Over ${title}.`, ...(group ? { group } : {}) }).text)![0];

  it("eist cookie én Origin van onze eigen pagina", async () => {
    const id = mk("Wegwerp");
    expect((await del(id, { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(403);
    expect((await del(id, { cookie: COOKIE })).statusCode).toBe(403);
    expect((await del(id, { cookie: COOKIE, origin: "http://evil.com" })).statusCode).toBe(403);
    expect((await del(id, { authorization: `Bearer ${TOKEN}`, ...ORIGIN })).statusCode).toBe(401);
    expect((await get(`/api/item/${id}`)).statusCode).toBe(200);
  });
  it("verwijdert een notitie definitief en legt id, titel en dader vast", async () => {
    const id = mk("Testnotitie");
    const p = (await get(`/api/delete-preview/${id}`)).json();
    expect(p).toMatchObject({ kind: "note", title: "Testnotitie", notes: 1, root: false });
    const r = await del(id, { cookie: COOKIE, ...ORIGIN });
    expect(r.statusCode).toBe(200);
    expect((await get(`/api/item/${id}`)).statusCode).toBe(404);
    const e = log.find((x) => x.tool === "ui_delete" && x.ids?.[0] === id)!;
    expect(e).toMatchObject({ actor: "ui", ok: true });
    expect(e.note).toContain("Testnotitie");
    expect((await get("/api/logs?actor=ui")).json().rows[0]).toMatchObject({ tool: "ui_delete", ids: [id] });
  });
  it("verwijdert een hele groep met alles erin, en meldt het aantal vooraf", async () => {
    const g = /g_[0-9a-z]{8}/.exec(writer.organize({ action: "create_group", title: "Tijdelijk", summary: "Weg." }).text)![0];
    const a = mk("In tijdelijk 1", g), b = mk("In tijdelijk 2", g);
    expect((await get(`/api/delete-preview/${g}`)).json()).toMatchObject({ kind: "group", notes: 2, images: 0, groups: 0 });
    expect((await del(g, { cookie: COOKIE, ...ORIGIN })).statusCode).toBe(200);
    for (const id of [g, a, b]) expect((await get(`/api/item/${id}`)).statusCode).toBe(404);
  });
  it("weigert de wortelgroep en onbekende of rare id's", async () => {
    expect((await get("/api/delete-preview/g_00000000")).json().root).toBe(true);
    expect((await del("g_00000000", { cookie: COOKIE, ...ORIGIN })).statusCode).toBe(403);
    expect((await del("n_zzzzzzzz", { cookie: COOKIE, ...ORIGIN })).statusCode).toBe(404);
    expect((await del("..%2Fx", { cookie: COOKIE, ...ORIGIN })).statusCode).toBe(404);
  });
});

describe("live", () => {
  it("meldt een wijziging van de index via de stream", async () => {
    await app.listen({ host: "127.0.0.1", port: PORT });
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { cookie: COOKIE }, signal: ctl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader(), dec = new TextDecoder();
    let text = "";
    let pending: Promise<void> | undefined;
    const pump = () => (pending ??= reader.read().then((r) => { pending = undefined; text += dec.decode(r.value ?? new Uint8Array()); }, () => {}));
    const read = async (until: string, ms: number) => {
      const end = Date.now() + ms;
      while (!text.includes(until) && Date.now() < end) await Promise.race([pump(), new Promise((r) => setTimeout(r, 200))]);
    };
    await read(": live", 2000);
    expect(text).toContain(": live");
    writer.write({ action: "create", title: "Live nieuw", summary: "Komt erbij." });
    await read("event: change", 4000);
    expect(text).toContain("event: change");
    ctl.abort();
  });
});
