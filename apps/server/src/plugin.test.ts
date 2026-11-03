import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Brain, Writer, compile, rebuild } from "@claude-brain/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool } from "./client";
import { buildServer } from "./server";

// Windows houdt geopende SQLite-bestanden vast tot het testproces stopt; opruimen van tijdelijke mappen mag mislukken.
const rmTmp = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* de map staat in de tijdelijke map van het systeem */
  }
};

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = join(root, "plugin");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p));
const front = (md: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error("geen frontmatter");
  return Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
};

const SKILLS = ["brain-recall", "brain-remember", "brain-organize", "brain-review"];
const COMMANDS = ["brain-remember", "brain-find", "brain-group", "brain-review"];
// Elke query die in een skill wordt voorgesteld moet de querytaal ook echt begrijpen.
const QUERIES = ["tag:proces group:werk/klanten", "kind:image", "has:image", "status:any", "status:archived", "updated:>2026-01-01 sort:updated", "status:broken", "-has:links kind:note", "updated:<2026-01-01 sort:updated", "woord*", '"exacte frase"', "woord -uitsluiten"];

let dir: string;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-plugin-"));
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "vault", "_group.md"), "---\nid: g_00000000\ntitle: Heelal\nsummary: Wortel.\nstatus: active\n---\n");
  rebuild(join(dir, "vault"), join(dir, "index.db"));
  const db = new DatabaseSync(join(dir, "index.db"));
  app = buildServer({ brain: new Brain(db, join(dir, "vault")), writer: new Writer(db, join(dir, "vault")), token: "t".repeat(64), port: 4747 });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmTmp(dir);
});

describe("plugin", () => {
  it("manifesten zijn geldig en wijzen naar elkaar", () => {
    expect(json("plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "brain" });
    const m = json(".claude-plugin/marketplace.json");
    expect(m.plugins[0]).toMatchObject({ name: "brain", source: "./plugin" });
    expect(existsSync(join(plugin, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(json("plugin/.mcp.json").mcpServers["claude-brain"]).toEqual({ command: "brain", args: ["mcp-stdio"] });
    expect(json("apps/server/package.json").bin.brain).toBe("./bin/brain.mjs");
    expect(json("plugin/optional/session-start-hook.json").hooks.SessionStart[0].hooks[0].command).toBe("brain map 1");
  });

  it("elke skill en elk commando heeft frontmatter en de mappen kloppen", () => {
    expect(readdirSync(join(plugin, "skills")).sort()).toEqual([...SKILLS].sort());
    for (const s of SKILLS) {
      const f = front(read(`plugin/skills/${s}/SKILL.md`));
      expect(f.name).toBe(s);
      expect(f.description!.length).toBeGreaterThan(40);
    }
    expect(readdirSync(join(plugin, "commands")).sort()).toEqual(COMMANDS.map((c) => `${c}.md`).sort());
    for (const c of COMMANDS) {
      const md = read(`plugin/commands/${c}.md`);
      expect(front(md).description).toBeTruthy();
      expect(md).toContain("$ARGUMENTS");
      for (const s of md.match(/skill (brain-[a-z]+)/g) ?? []) expect(SKILLS).toContain(s.slice(6));
    }
  });

  it("de tools en acties waar de skills naar verwijzen bestaan echt", async () => {
    const r = await app.inject({ method: "POST", url: "/mcp", headers: { host: "127.0.0.1:4747", authorization: `Bearer ${"t".repeat(64)}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const tools = new Map<string, string>((r.json().result.tools as { name: string; inputSchema: object }[]).map((t) => [t.name, JSON.stringify(t.inputSchema)]));
    const text = SKILLS.map((s) => read(`plugin/skills/${s}/SKILL.md`)).join("\n");
    for (const name of new Set(text.match(/brain_[a-z]+/g))) expect(tools.has(name), name).toBe(true);
    // acties die in de tekst staan (`brain_write append`, `brain_organize move`)
    for (const [, tool, action] of text.matchAll(/(brain_write|brain_organize) `?([a-z_]+)`?/g)) {
      if (!["create", "append", "replace_section", "str_replace", "set_meta", "link", "unlink", "set_parent", "create_group", "rename_group", "move", "archive", "restore", "merge", "delete"].includes(action!)) continue;
      expect(tools.get(tool!), `${tool} ${action}`).toContain(`"${action}"`);
    }
  });

  it("de voorbeeldqueries in de skills zijn geldig", () => {
    const text = SKILLS.map((s) => read(`plugin/skills/${s}/SKILL.md`)).join("\n");
    for (const q of QUERIES) {
      expect(text, q).toContain(q);
      expect(() => compile(q), q).not.toThrow();
    }
  });
});

describe("client", () => {
  it("geeft de tekst van een tool-aanroep terug en meldt fouten", async () => {
    const f = (async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "hallo" }] } }), { status: 200 })) as typeof fetch;
    expect(await callTool("http://x/mcp", "t", "brain_map", {}, 100, f)).toBe("hallo");
    const bad = (async () => new Response("nee", { status: 401 })) as typeof fetch;
    await expect(callTool("http://x/mcp", "t", "brain_map", {}, 100, bad)).rejects.toThrow(/401/);
  });
});
