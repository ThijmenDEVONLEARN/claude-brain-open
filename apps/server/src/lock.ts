import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Eén-instantie-slot: `server.lock` met de pid. Een verlaten slot (proces bestaat niet meer) wordt overgenomen. */
export function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) rmSync(path);
        } catch {
          /* al weg */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8"));
      if (pid && pid !== process.pid && alive(pid)) throw new Error(`Claude Brain draait al (pid ${pid})`);
      rmSync(path, { force: true });
    }
  }
  throw new Error("kon het slot niet nemen");
}

export function lockHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    return pid && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
