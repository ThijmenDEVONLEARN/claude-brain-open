// Typen en aanroepen van de alleen-lezen UI-API (zie apps/server/src/server.ts).
export type Card = { id: string; title: string; summary: string; path: string; color: string | null; count: number; direct: number; groups: number; updated: string | null };
export type Bundle = { a: string; b: string; type: string; count: number };
export type Overview = { root: { id: string; title: string; summary: string } | null; total: number; direct: number; archived: number; groups: Card[]; bundles: Bundle[] };
export type TypeInfo = { type: string; count: number; tags: { tag: string; count: number }[] };
export type GroupData = {
  group: { id: string; title: string; summary: string; path: string; updated: string | null };
  crumbs: { id: string; title: string }[];
  count: number;
  children: Card[];
  bundles: Bundle[];
  direct: { count: number; types: TypeInfo[] };
};
export type ItemRow = { id: string; title: string; summary: string; type: string; updated: string | null; parent: string | null };
export type Rel = { id: string; title: string; kind: string; type: string; broken?: boolean };
export type Item = {
  id: string; kind: string; type: string; title: string; summary: string; status: string; error: string | null; group: string; groupId: string | null;
  parent: string | null; created: string | null; updated: string | null; tags: string[]; body: string; children: { id: string; title: string }[];
  links: Rel[]; backlinks: Rel[]; images: string[];
};
export type Hit = { id: string; title: string; summary: string; group: string; slug: string | null };

export class AuthError extends Error {}
async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new AuthError("Niet ingelogd. Open de UI opnieuw met `brain open`.");
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `fout ${r.status}`);
  return (await r.json()) as T;
}
const q = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
export const api = {
  overview: () => get<Overview>("/api/overview"),
  group: (id: string) => get<GroupData>(`/api/group/${id}`),
  items: (o: { group: string; type?: string; tag?: string; limit?: number }) => get<{ total: number; items: ItemRow[] }>(`/api/items?${q(o)}`),
  item: (id: string) => get<Item>(`/api/item/${id}`),
  search: (text: string) => get<{ total: number; hits: Hit[]; error?: string }>(`/api/search?${q({ q: text, limit: 30 })}`),
  imageUrl: (id: string) => `/api/image/${id}`,
  dashboard: () => get<Dashboard>("/api/dashboard"),
  logs: (o: { q?: string; actor?: string; ok?: string; since?: string; before?: number; reads?: string }) => get<{ rows: LogRow[]; next: number | null }>(`/api/logs?${q({ ...o, limit: 100 })}`),
  deletePreview: (id: string) => get<DeletePreview>(`/api/delete-preview/${id}`),
  async del(id: string) {
    const r = await fetch(`/api/items/${id}`, { method: "DELETE", credentials: "same-origin" });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `verwijderen mislukt (${r.status})`);
  },
};

export type Dashboard = {
  stats: { notes: number; archived: number; images: number; groups: number; broken: number; last30: number; growth: { day: string; n: number }[] };
  tokens: { out: number; full: number };
  groups: Card[];
  recent: { id: number; ts: string; actor: string; tool: string; action: string; ok: boolean; label: string; itemId: string | null; where: string }[];
  searches: string[];
  whereWasI: null | {
    start: string; end: string; calls: number; created: number; changed: number; images: number; archived: number; deleted: number; searches: number; where: string;
    touched: { id: string; title: string; kind: string }[]; last: { id: string; groupId: string | null } | null;
  };
};
export type LogRow = { id: number; ts: string; actor: string; client: string | null; tool: string; args: string | null; ids: string[]; ok: boolean; ms: number | null; tokensOut: number | null; tokensFull: number | null; note: string | null };
export type DeletePreview = { id: string; kind: string; title: string; root: boolean; notes: number; images: number; groups: number; inbound: number };
