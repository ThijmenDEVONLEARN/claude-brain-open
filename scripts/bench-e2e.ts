/**
 * Eindcontrole voor een release: start de echte server op een bestaande (grote) kluis en meet via HTTP wat Claude en de UI merken.
 *   BRAIN_HOME=/pad/naar/map pnpm tsx scripts/bench-e2e.ts
 * De map moet al een gebouwde index hebben (zie scripts/gen-fixtures.ts en `brain rebuild`).
 * Schrijft alleen in de groep "bench-e2e" en ruimt die aan het eind op. Exit-code 1 als een doel niet gehaald wordt.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { callTool } from "../apps/server/src/client";

const root = process.env.BRAIN_HOME;
if (!root) throw new Error("zet BRAIN_HOME");
const port = JSON.parse(readFileSync(join(root, "config.json"), "utf8")).port ?? 4747;
const token = readFileSync(join(root, ".token"), "utf8").trim();
const base = `http://127.0.0.1:${port}`;
const mcp = (name: string, args: unknown) => callTool(`${base}/mcp`, token, name, args, 30_000);

// Een zeldzaam en een heel gewoon woord uit de kluis zelf, zodat de meting op elke kluis werkt.
const probe = new DatabaseSync(join(root, "data", "index.db"), { readOnly: true });
const total = (probe.prepare("SELECT count(*) n FROM items").get() as { n: number }).n;
const mid = probe.prepare("SELECT id, title FROM items WHERE kind='note' LIMIT 1 OFFSET ?").get(Math.floor(total / 2)) as { id: string; title: string };
const rare = mid.title.split(/\s+/).sort((a, b) => b.length - a.length)[0]!.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
probe.close();

const results: { name: string; cold: number; p50: number; p95: number; goal: number }[] = [];
async function measure(name: string, goal: number, n: number, f: () => Promise<unknown>) {
  const t: number[] = [];
  const c = performance.now();
  await f(); // de eerste aanroep (koude caches) wordt apart gemeld, niet meegeteld in p50/p95
  const cold = performance.now() - c;
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await f();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  results.push({ name, cold, p50: t[Math.floor(n / 2)]!, p95: t[Math.min(n - 1, Math.floor(n * 0.95))]!, goal });
}

const t0 = performance.now();
const srv = spawn("node", ["--import", "tsx", "apps/server/src/cli.ts", "serve"], { env: { ...process.env, BRAIN_HOME: root }, stdio: "ignore" });
let startup = 0;
let coldMs = 0;
try {
  for (;;) {
    try {
      await mcp("brain_map", {});
      break;
    } catch {
      if (performance.now() - t0 > 120_000) throw new Error("server start niet binnen 2 minuten");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  startup = performance.now() - t0;

  const cookie = (await fetch(`${base}/?token=${token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
  const ui = (path: string) => fetch(`${base}${path}`, { headers: { cookie } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${path}: ${r.status}`))));

  const cold = performance.now();
  await ui("/api/overview"); // eerste aanroep wacht op de linkbundels (eenmalig); de server rekent ze bij het opstarten al uit
  coldMs = performance.now() - cold;

  await measure("brain_map", 100, 20, () => mcp("brain_map", {}));
  await measure("brain_find (zeldzaam woord)", 100, 30, () => mcp("brain_find", { query: rare }));
  await measure("brain_find (kind:note, tag/sort)", 100, 20, () => mcp("brain_find", { query: "kind:note sort:updated", limit: 10 }));
  await measure("brain_read (outline)", 50, 30, () => mcp("brain_read", { ids: [mid.id] }));
  await measure("/api/overview (warm)", 50, 20, () => ui("/api/overview"));
  await measure("/api/search", 100, 20, () => ui(`/api/search?q=${encodeURIComponent(rare)}`));
  await measure("/api/dashboard (warm)", 100, 20, () => ui("/api/dashboard"));

  const made: string[] = [];
  const gid = (await mcp("brain_organize", { action: "create_group", title: "bench-e2e", summary: "tijdelijk, door scripts/bench-e2e.ts" })).match(/\bg_[0-9a-z]{8}\b/)?.[0];
  await measure("brain_write create", 100, 60, async () => {
    const out = await mcp("brain_write", { action: "create", title: `Bench ${made.length}`, summary: "meting", group: "bench-e2e", body: "# Meting\n\nwat tekst" });
    made.push(out.match(/\bn_[0-9a-z]{8}\b/)?.[0] ?? "");
  });
  const ids = [...made.filter(Boolean), ...(gid ? [gid] : [])];
  if (ids.length) {
    await mcp("brain_organize", { action: "delete", ids });
    await mcp("brain_organize", { action: "delete", ids, confirm: ids });
  }
} finally {
  srv.kill("SIGTERM");
}

console.log(`eerste /api/overview ${(coldMs / 1000).toFixed(1)} s`);
console.log(`${total} items, kluis ${root}, server klaar na ${(startup / 1000).toFixed(1)} s (doel < 20 s)`);
let bad = startup > 20_000;
for (const r of results) {
  const ok = r.p95 <= r.goal;
  bad ||= !ok;
  console.log(`${ok ? "ok  " : "TE TRAAG"} ${r.name.padEnd(36)} p50 ${r.p50.toFixed(1).padStart(7)} ms   p95 ${r.p95.toFixed(1).padStart(7)} ms   eerste ${r.cold.toFixed(0).padStart(4)} ms   doel < ${r.goal} ms`);
}
process.exit(bad ? 1 : 0);
