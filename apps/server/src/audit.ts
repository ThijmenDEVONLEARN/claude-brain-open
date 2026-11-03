import { existsSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type AuditEntry = { actor: string; client?: string; tool: string; args?: unknown; ids?: string[]; ok: boolean; ms: number; tokensOut?: number; note?: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, client TEXT, tool TEXT NOT NULL, args TEXT,
  ids TEXT, ok INTEGER NOT NULL, ms INTEGER, tokens_out INTEGER, tokens_full INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

/** Lange tekst (notitie-inhoud) komt niet in het log: alleen het begin en de lengte. */
export function shorten(v: unknown, max = 120): unknown {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…(${v.length} tekens)` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => shorten(x, max));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, max)]));
  return v;
}

/**
 * Open `logs.db`. Is hij kapot, dan wordt hij hernoemd en bewaard (hij is niet afgeleid, dus nooit overschreven)
 * en begint er een nieuwe.
 */
export function openAudit(path: string, index?: DatabaseSync) {
  let db: DatabaseSync;
  const open = () => {
    const d = new DatabaseSync(path);
    try {
      d.exec(SCHEMA);
      if ((d.prepare("PRAGMA quick_check(1)").get() as { quick_check: string }).quick_check !== "ok") throw new Error("quick_check");
    } catch (e) {
      d.close(); // Windows laat een geopend bestand niet hernoemen
      throw e;
    }
    return d;
  };
  try {
    db = open();
  } catch {
    if (existsSync(path)) renameSync(path, path.replace(/\.db$/, `.corrupt-${Date.now()}.db`));
    db = open();
  }
  const ins = db.prepare(`INSERT INTO audit(ts,actor,client,tool,args,ids,ok,ms,tokens_out,tokens_full,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  let denials = { minute: 0, n: 0 };
  return {
    db,
    log(e: AuditEntry) {
      // Geweigerde verzoeken van buiten kunnen het log niet laten vollopen: max 60 per minuut.
      if (e.tool === "auth_denied") {
        const m = Math.floor(Date.now() / 60000);
        if (denials.minute !== m) denials = { minute: m, n: 0 };
        if (++denials.n > 60) return;
      }
      let full: number | null = null;
      if (index && e.ids?.length) {
        const q = e.ids.slice(0, 100);
        full = (index.prepare(`SELECT sum(tokens_est) s FROM items WHERE id IN (${q.map(() => "?").join(",")})`).get(...q) as { s: number | null }).s;
      }
      ins.run(new Date().toISOString(), e.actor, e.client?.slice(0, 80) ?? null, e.tool, e.args === undefined ? null : JSON.stringify(shorten(e.args)).slice(0, 1000), e.ids?.length ? JSON.stringify(e.ids.slice(0, 100)) : null, e.ok ? 1 : 0, e.ms, e.tokensOut ?? null, full, e.note?.slice(0, 4000) ?? null);
    },
    close: () => db.close(),
  };
}
export type Audit = ReturnType<typeof openAudit>;
