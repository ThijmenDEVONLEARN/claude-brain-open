import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { rebuild, Writer } from "@claude-brain/core";
import { autostartStatus, installAutostart, openUrl, stopServer, uninstallAutostart } from "./autostart";
import { diagnose, fileMb } from "./doctor";
import { loadConfig } from "./config";
import { callTool } from "./client";
import { lockHolder } from "./lock";
import { openIndex, startServer } from "./start";
import { bridge } from "./stdio";

const root = process.env.BRAIN_HOME ?? join(homedir(), "ClaudeBrain");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { fix: { type: "boolean" }, vault: { type: "string", default: join(root, "vault") }, db: { type: "string", default: join(root, "data", "index.db") } },
});

if (positionals[0] === "rebuild") {
  const pid = lockHolder(join(root, "data", "server.lock"));
  if (pid) {
    console.error(`de server draait (pid ${pid}); stop hem eerst, of herstart hem: hij bouwt zelf opnieuw op als de index kapot is`);
    process.exit(1);
  }
  const s = rebuild(values.vault!, values.db!);
  console.log(`${s.items} items (${s.notes} notities, ${s.groups} groepen, ${s.broken} kapot, ${s.skipped} overgeslagen), ${s.sections} secties, ${s.links} links, ${(s.ms / 1000).toFixed(1)} s`);
  console.log(`index: ${values.db}`);
} else if (positionals[0] === "serve") {
  const cfg = loadConfig(root);
  try {
    const stamp = () => new Date().toISOString();
    const srv = await startServer(cfg, (m) => console.log(m), true);
    console.log(`${stamp()} server gestart (pid ${process.pid})`);
    // Zo zie je in logs\server.log waarom hij stopte. Een harde kill (taskkill /F, Stop-Process) laat geen sporen na.
    process.on("exit", (code) => console.log(`${stamp()} server gestopt (code ${code})`));
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        console.log(`${stamp()} signaal ${sig} ontvangen`);
        void srv.close().then(() => process.exit(0));
      });
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`kon niet starten: ${msg}`);
    process.exit(/draait al/.test(msg) ? 3 : 1); // 3 = er draait al een server: start.vbs probeert het dan niet opnieuw
  }
} else if (positionals[0] === "mcp-stdio") {
  const cfg = loadConfig(root);
  await bridge(process.stdin, process.stdout, `http://127.0.0.1:${cfg.port}/mcp`, cfg.token);
} else if (positionals[0] === "call" || positionals[0] === "map") {
  // brain call <tool> '<json>'   |   brain map [diepte]: stil en met exitcode 0 als de server niet draait (voor hooks)
  const cfg = loadConfig(root);
  const [tool, args] = positionals[0] === "map" ? ["brain_map", { depth: Number(positionals[1] ?? 1) }] : [positionals[1] ?? "", JSON.parse(positionals[2] ?? "{}")];
  try {
    console.log(await callTool(`http://127.0.0.1:${cfg.port}/mcp`, cfg.token, tool as string, args, 1500));
  } catch (e) {
    if (positionals[0] === "call") {
      console.error(`mislukt: ${(e as Error).message}`);
      process.exit(1);
    }
  }
} else if (positionals[0] === "doctor") {
  const cfg = loadConfig(root);
  const pid = lockHolder(join(root, "data", "server.lock"));
  const say = (level: string, msg: string) => console.log(`${level === "fout" ? "✗" : level === "let op" ? "!" : "·"} ${msg}`);
  say("info", pid ? `server draait (pid ${pid}, poort ${cfg.port})` : "server draait niet");
  const auto = autostartStatus();
  if (auto !== undefined) say(auto === "niet ingesteld" ? "let op" : "info", `autostart: ${auto}${auto === "niet ingesteld" ? " (zet aan met: brain install-autostart)" : ""}`);
  const mb = fileMb(join(root, "logs", "server.log"));
  if (mb > 20) say("let op", `logs\\server.log is ${Math.round(mb)} MB; stop de server en wis het bestand`);
  let found;
  if (pid) {
    // De server houdt de index zelf bij: alleen lezen, niets aanpassen.
    const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=3000");
    found = diagnose(db, cfg.vault);
    db.close();
    if (values.fix) say("let op", "--fix doet niets zolang de server draait; stop hem en probeer opnieuw");
  } else {
    const db = openIndex(cfg.dbPath, cfg.vault, (m) => say("info", m));
    found = diagnose(db, cfg.vault, new Writer(db, cfg.vault, undefined, { imageRoots: cfg.imageRoots, exclude: [cfg.root] }), values.fix);
    db.prepare("INSERT OR REPLACE INTO meta VALUES('clean','1')").run();
    db.close();
  }
  for (const f of found) say(f.level, f.msg);
  if (!found.length) say("info", "kluis en index kloppen");
  process.exit(found.some((f) => f.level === "fout") ? 1 : 0);
} else if (positionals[0] === "install-autostart") {
  try {
    installAutostart(root, process.execPath, fileURLToPath(new URL("../bin/brain.mjs", import.meta.url)), `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(/^\\/, ""));
    console.log(`taak "ClaudeBrain" aangemaakt: start bij aanmelden, zonder venster, herstart bij een crash. Log: ${join(root, "logs", "server.log")}`);
  } catch (e) {
    console.error(`mislukt: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (positionals[0] === "uninstall-autostart") {
  try {
    await uninstallAutostart(root);
    console.log("taak verwijderd en server gestopt; hij start niet meer bij aanmelden");
  } catch (e) {
    console.error(`mislukt: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (positionals[0] === "stop") {
  try {
    const pid = await stopServer(root);
    console.log(pid ? `server gestopt (pid ${pid}); start weer met: schtasks /Run /TN ClaudeBrain` : "er draait geen server");
  } catch (e) {
    console.error(`mislukt: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (positionals[0] === "open") {
  const cfg = loadConfig(root);
  openUrl(`http://127.0.0.1:${cfg.port}/?token=${cfg.token}`);
  console.log(`geopend: http://127.0.0.1:${cfg.port}/ (draait de server? controleer met: brain doctor)`);
} else if (positionals[0] === "token") {
  console.log(loadConfig(root).token);
} else {
  console.error("gebruik: brain serve | mcp-stdio | map [diepte] | call <tool> [json] | token | doctor [--fix] | open | stop | install-autostart | uninstall-autostart | rebuild [--vault <map>] [--db <bestand>]");
  process.exit(2);
}
