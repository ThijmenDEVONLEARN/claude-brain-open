import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TASK = "ClaudeBrain";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * VBS-wrapper: start `node brain.mjs serve` zonder venster, wacht tot hij stopt en start hem zelf opnieuw als hij onverwacht
 * stopt (ook als iemand hem afschiet of de code een fout geeft). Klaar is hij bij exitcode 0 (netjes gestopt) of 3 (er draait al
 * een server). De Taakplanner zelf herstart niet: RestartOnFailure geldt alleen als een taak niet kan STARTEN.
 * Wacht 5 s tussen starts en verdubbelt dat (tot 60 s) zolang de server binnen 2 minuten weer stopt, zodat een kapotte start
 * de log niet volschrijft. Uitvoer gaat naar logs\server.log.
 * shortcut: dat logbestand wordt niet geroteerd; `brain doctor` waarschuwt boven 20 MB, wis het dan met de hand.
 */
export function startVbs(node: string, script: string, logFile: string, root: string): string {
  const q = (s: string) => `""${s}""`; // een " in een VBS-string is ""
  const cmd = `cmd /c ""${q(node)} ${q(script)} serve >> ${q(logFile)} 2>&1""`;
  return [
    `Set sh = CreateObject("WScript.Shell")`,
    `sh.CurrentDirectory = "${root}"`,
    `sh.Environment("Process")("BRAIN_HOME") = "${root}"`,
    `wacht = 5`,
    `Do`,
    `  t = Timer`,
    `  rc = sh.Run("${cmd}", 0, True)`,
    `  If rc = 0 Or rc = 3 Then Exit Do`,
    `  If Timer - t > 120 Or Timer < t Then`,
    `    wacht = 5`,
    `  ElseIf wacht < 60 Then`,
    `    wacht = wacht * 2`,
    `  End If`,
    `  WScript.Sleep wacht * 1000`,
    `Loop`,
    `WScript.Quit rc`,
    ``,
  ].join("\r\n");
}

/** Taakdefinitie: bij aanmelden van jou, geen adminrechten, geen tijdslimiet, ook op batterij. */
export function taskXml(user: string, vbs: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Claude Brain: geheugen voor Claude (alleen 127.0.0.1)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>//B //Nologo "${xml(vbs)}"</Arguments></Exec></Actions>
</Task>
`;
}

const schtasks = (...args: string[]) => execFileSync("schtasks", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function windowsOnly() {
  if (process.platform !== "win32") throw new Error("autostart via de Taakplanner werkt alleen op Windows");
}

export function installAutostart(root: string, node: string, script: string, user: string, startNow = true) {
  windowsOnly();
  const dir = join(root, "autostart");
  mkdirSync(dir, { recursive: true });
  const vbs = join(dir, "start.vbs");
  writeFileSync(vbs, startVbs(node, script, join(root, "logs", "server.log"), root));
  const file = join(dir, "task.xml");
  writeFileSync(file, String.fromCharCode(0xfeff) + taskXml(user, vbs), "utf16le"); // schtasks wil UTF-16 met BOM
  schtasks("/Create", "/TN", TASK, "/XML", file, "/F");
  if (startNow) schtasks("/Run", "/TN", TASK);
}

export function uninstallAutostart(root: string) {
  windowsOnly();
  try {
    schtasks("/End", "/TN", TASK);
  } catch {
    /* draaide niet */
  }
  schtasks("/Delete", "/TN", TASK, "/F");
  rmSync(join(root, "autostart"), { recursive: true, force: true });
}

/** "ingesteld" (met status), "niet ingesteld", of undefined buiten Windows. */
export function autostartStatus(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    return schtasks("/Query", "/TN", TASK, "/FO", "LIST").match(/^(?:Status|Toestand):\s*(.+)$/im)?.[1]?.trim() ?? "ingesteld";
  } catch {
    return "niet ingesteld";
  }
}

/** Opent een URL in de standaardbrowser. */
export function openUrl(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd!, args as string[], { detached: true, stdio: "ignore" }).unref();
}
