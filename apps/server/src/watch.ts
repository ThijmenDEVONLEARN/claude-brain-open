import { statSync, watch } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dropPath, reconcile, syncIfChanged } from "@claude-brain/core";

/**
 * Kijkt naar handmatige wijzigingen in de kluis (Verkenner, editor). Eigen schrijfacties van de server
 * zijn al verwerkt, dus `syncIfChanged` ziet daar geen verschil (mtime + grootte) en doet niets.
 */
export function startWatcher(db: DatabaseSync, vault: string, onError: (e: unknown) => void = () => {}, debounceMs = 300) {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const flush = () => {
    timer = undefined;
    const batch = [...pending];
    pending.clear();
    for (const rel of batch) {
      try {
        let st;
        try {
          st = statSync(join(vault, rel));
        } catch {
          dropPath(db, rel); // weg: bestand of hele map
          continue;
        }
        if (st.isDirectory()) reconcile(db, vault, rel);
        else syncIfChanged(db, vault, rel);
      } catch (e) {
        onError(e); // een kapot bestand mag de watcher nooit stoppen
      }
    }
  };

  const w = watch(vault, { recursive: true }, (_ev, name) => {
    if (!name) return;
    const rel = name.toString().replaceAll("\\", "/");
    // Verborgen bestanden (ook onze .tmp-bestanden) en niet-markdown negeren; mappen hebben geen extensie.
    if (rel.split("/").some((s) => s.startsWith("."))) return;
    if (/\.[a-z0-9]{1,5}$/i.test(rel) && !rel.endsWith(".md")) return;
    pending.add(rel);
    timer ??= setTimeout(flush, debounceMs);
  });
  w.on("error", onError);
  return { close: () => (clearTimeout(timer), w.close()), flush };
}
