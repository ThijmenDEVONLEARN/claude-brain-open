// Kleine DOM-hulpjes die de pagina's delen. Alles gaat via textContent; nooit innerHTML.
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tg: K, o: { cls?: string; text?: string } = {}, kids: (Node | string)[] = []) {
  const e = document.createElement(tg);
  if (o.cls) e.className = o.cls;
  if (o.text !== undefined) e.textContent = o.text;
  e.append(...kids);
  return e;
}
export function btn(text: string, f: () => void, cls = "") {
  const b = el("button", { text, cls });
  b.type = "button";
  b.onclick = f;
  return b;
}
export function toast(msg: string, ms = 5000) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), ms);
}
export const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 9000);

const hm = (d: Date) => d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
/** "10:12", "gisteren 17:02" of "3 nov 09:00". */
export function when(ts: string, now = new Date()): string {
  const d = new Date(ts), day = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 864e5), diff = day(now) - day(d);
  if (diff === 0) return hm(d);
  if (diff === 1) return `gisteren ${hm(d)}`;
  return `${d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" })} ${hm(d)}`;
}
export function span(a: string, b: string): string {
  const min = Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} u ${min % 60} min`;
}
