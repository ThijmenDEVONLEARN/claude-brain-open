// Weergave-instellingen die de gebruiker kiest; ze blijven bewaard in de browser (localStorage), nooit op de server.
import type { ILayout, Layout } from "./lib";
export type Settings = {
  layout: Layout; iLayout: ILayout; lineMode: "gebundeld" | "geselecteerd";
  linkOn: boolean; linkA: number; orbOn: boolean; orbA: number; hiddenLinks: string[];
  folded: Record<string, boolean>; widths: Record<string, number>; pos: Record<string, [number, number]>;
};
const KEY = "brain-ui-v1";
const defaults: Settings = { layout: "banen", iLayout: "soort", lineMode: "gebundeld", linkOn: true, linkA: 100, orbOn: true, orbA: 100, hiddenLinks: [], folded: {}, widths: {}, pos: {} };
let stored: Partial<Settings> = {};
try { stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>; } catch { /* kapotte opslag: begin met de standaard */ }
export const settings: Settings = { ...defaults, ...stored, folded: { ...stored.folded }, widths: { ...stored.widths }, pos: { ...stored.pos } };
export const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* opslag vol of uit: instellingen blijven dan alleen in dit tabblad */ } };
