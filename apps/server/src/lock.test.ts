import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stopServer } from "./autostart";
import { lockHolder } from "./lock";

// stopServer doet op Windows ook `schtasks /End`; dat is hier niet te testen, het proces-deel wel.
describe("stopServer", () => {
  it("stopt het proces uit server.lock en meldt de pid; zonder server meldt hij niets", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-stop-"));
    mkdirSync(join(root, "data"));
    try {
      expect(await stopServer(root)).toBeUndefined();
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      const lock = join(root, "data", "server.lock");
      writeFileSync(lock, String(child.pid));
      expect(lockHolder(lock)).toBe(child.pid);
      expect(await stopServer(root)).toBe(child.pid);
      expect(lockHolder(lock)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
