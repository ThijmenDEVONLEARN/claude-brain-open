import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { Brain, Writer, rebuild } from "@claude-brain/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { buildServer } from "./server";
import { bridge } from "./stdio";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

const TOKEN = "t".repeat(64);
const PORT = 4747;
let dir: string;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-srv-"));
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "vault", "_group.md"), "---\nid: g_00000000\ntitle: Heelal\nsummary: Wortel.\nstatus: active\n---\n");
  writeFileSync(join(dir, "vault", "a.md"), "---\nid: n_00000001\ntitle: Alfa\nsummary: Over alfa.\nstatus: active\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n## Kop\nzonnestelsel\n");
  rebuild(join(dir, "vault"), join(dir, "index.db"));
  const db = new DatabaseSync(join(dir, "index.db"));
  app = buildServer({ brain: new Brain(db, join(dir, "vault")), writer: new Writer(db, join(dir, "vault")), token: TOKEN, port: PORT });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmTmp(dir);
});

const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/mcp",
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });

describe("beveiliging", () => {
  it("weigert zonder of met fout token", async () => {
    expect((await rpc("tools/list", {}, { authorization: "" })).statusCode).toBe(401);
    expect((await rpc("tools/list", {}, { authorization: "Bearer fout" })).statusCode).toBe(401);
  });
  it("weigert vreemde Host (DNS-rebinding) en elke Origin (website)", async () => {
    expect((await rpc("tools/list", {}, { host: "evil.com" })).statusCode).toBe(403);
    expect((await rpc("tools/list", {}, { origin: "http://evil.com" })).statusCode).toBe(403);
  });
  it("GET /mcp is niet toegestaan", async () => {
    const r = await app.inject({ method: "GET", url: "/mcp", headers: { host: `localhost:${PORT}`, authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(405);
  });
});

describe("MCP", () => {
  it("lijst de zeven tools", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.statusCode).toBe(200);
    const l = (await rpc("tools/list", {})).json();
    expect(l.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["brain_find", "brain_image", "brain_map", "brain_organize", "brain_read", "brain_related", "brain_write"]);
  });
  it("brain_find en brain_read werken en fouten zijn korte tekst", async () => {
    const f = (await rpc("tools/call", { name: "brain_find", arguments: { query: "zonnestelsel" } })).json();
    expect(f.result.content[0].text).toContain("n_00000001");
    const bad = (await rpc("tools/call", { name: "brain_read", arguments: { ids: ["n_99999999"] } })).json();
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe("ERROR not_found n_99999999");
  });
});

describe("config", () => {
  it("maakt map, config en token aan en hergebruikt ze", () => {
    const root = join(dir, "home");
    const a = loadConfig(root);
    expect(a.token).toHaveLength(64);
    expect(a.port).toBe(4747);
    expect(loadConfig(root).token).toBe(a.token);
  });
});

describe("stdio-brug", () => {
  const run = async (lines: string[], f: typeof fetch) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c) => chunks.push(String(c)));
    const done = bridge(input, output, "http://x/mcp", TOKEN, f);
    input.end(lines.join("\n") + "\n");
    await done;
    return chunks.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  it("stuurt door met token en geeft antwoord terug", async () => {
    let auth = "";
    const f = (async (_u: unknown, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization!;
      return new Response('{"jsonrpc":"2.0","id":7,"result":{}}', { status: 200 });
    }) as typeof fetch;
    const out = await run(['{"jsonrpc":"2.0","id":7,"method":"ping"}'], f);
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(out).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  });
  it("geeft JSON-RPC-fout als de server niet draait, en zwijgt bij notificaties", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const out = await run(['{"jsonrpc":"2.0","id":3,"method":"ping"}'], down);
    expect(out[0]).toMatchObject({ id: 3, error: { message: expect.stringContaining("brain serve") } });
    const accepted = (async () => new Response(null, { status: 202 })) as typeof fetch;
    expect(await run(['{"jsonrpc":"2.0","method":"notifications/initialized"}'], accepted)).toEqual([]);
  });
});
