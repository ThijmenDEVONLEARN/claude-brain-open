import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = { root: string; vault: string; dbPath: string; port: number; token: string; imageRoots: string[] };

/** Maakt %USERPROFILE%\ClaudeBrain\ (vault, data, logs, config.json, .token) aan als ze er nog niet zijn. */
export function loadConfig(root = process.env.BRAIN_HOME ?? join(homedir(), "ClaudeBrain")): Config {
  for (const d of ["vault", "data", "logs"]) mkdirSync(join(root, d), { recursive: true });
  const cfgFile = join(root, "config.json");
  if (!existsSync(cfgFile)) writeFileSync(cfgFile, JSON.stringify({ port: 4747 }, null, 2));
  const file = JSON.parse(readFileSync(cfgFile, "utf8")) as { port?: number; imageRoots?: string[] };
  const port = Number(file.port ?? 4747);
  // Waar brain_image bronbestanden mag lezen. Standaard je gebruikersmap; zet hier een kleinere map als je dat wilt.
  const imageRoots = Array.isArray(file.imageRoots) && file.imageRoots.length ? file.imageRoots : [homedir()];
  const tokenFile = join(root, ".token");
  // mode 0600 geldt op Unix; op Windows beschermt de ACL van je gebruikersmap het bestand.
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const token = readFileSync(tokenFile, "utf8").trim();
  return { root, vault: join(root, "vault"), dbPath: join(root, "data", "index.db"), port, token, imageRoots };
}
