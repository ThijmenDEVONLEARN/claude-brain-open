// Dashboard, logboek en het verwijderdialoog. Alles wat Claude gedaan heeft komt uit het audit log; deze pagina's tonen het alleen.
import { type Dashboard, type LogRow, api } from "./api";
import { $, btn, el, fail, span, toast, when } from "./dom";
import { colorOf, nl } from "./lib";

type Nav = { open: (id: string) => void; search: (q: string) => void };
const root = () => $("page");
const ACTOR: Record<string, string> = { claude: "Claude", ui: "Gebruiker", unknown: "onbekend" };
const DO: Record<string, string> = { create: "aangemaakt", append: "uitgebreid", replace_section: "gewijzigd", str_replace: "gewijzigd", set_meta: "gewijzigd", link: "gelinkt", unlink: "link verwijderd", set_parent: "verplaatst in boom", archive: "gearchiveerd", restore: "hersteld", move: "verplaatst", delete: "verwijderd", merge: "samengevoegd", create_group: "groep aangemaakt", rename_group: "groep hernoemd" };
const what = (tool: string, action: string) => (tool === "brain_image" ? "afbeelding toegevoegd" : tool === "ui_delete" ? "verwijderd (UI)" : DO[action] ?? action ?? tool);
const pill = (a: string) => el("span", { cls: `pill ${a === "claude" ? "claude" : a === "ui" ? "ui" : "err"}`, text: ACTOR[a] ?? a });
const card = (title: string, kids: Node[], cls = "") => el("section", { cls: `glass card ${cls}` }, [el("h3", { text: title }), ...kids]);
const row = (kids: (Node | string)[]) => el("div", { cls: "row" }, kids);

function sparkline(g: { n: number }[]) {
  const ns = "http://www.w3.org/2000/svg", W = 360, H = 56, max = Math.max(1, ...g.map((x) => x.n));
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Nieuwe notities per dag, laatste 30 dagen, ${g.reduce((a, x) => a + x.n, 0)} in totaal`);
  const pl = document.createElementNS(ns, "polyline");
  pl.setAttribute("points", g.map((x, i) => `${(i / (g.length - 1)) * W},${H - 4 - (x.n / max) * (H - 8)}`).join(" "));
  pl.setAttribute("fill", "none");
  pl.setAttribute("stroke", "#7aa2ff");
  pl.setAttribute("stroke-width", "2");
  svg.append(pl);
  return svg;
}

export function renderDashboard(d: Dashboard, nav: Nav) {
  const r = root(), w = d.whereWasI, s = d.stats;
  r.replaceChildren();
  const link = (t: string, id: string) => { const a = el("a", { text: t }); a.href = "#"; a.onclick = (e) => { e.preventDefault(); nav.open(id); }; return a; };
  // Waar was ik
  const where = el("section", { cls: "glass card sun" }, [el("h3", { text: "Waar was ik" })]);
  if (!w) where.append(el("p", { cls: "sub", text: "Nog geen activiteit van Claude. Zodra Claude iets opslaat of opzoekt, staat het hier." }));
  else {
    const bits = [[w.created, "aangemaakt"], [w.changed, "gewijzigd"], [w.images, w.images === 1 ? "afbeelding" : "afbeeldingen"], [w.archived, "gearchiveerd"], [w.deleted, "verwijderd"], [w.searches, w.searches === 1 ? "zoekopdracht" : "zoekopdrachten"]].filter(([n]) => (n as number) > 0).map(([n, t]) => `${n} ${t}`);
    const left = el("div", {}, [el("div", { cls: "big sm", text: w.where || "Heelal" }), el("div", { cls: "sub", text: `Laatste sessie van Claude: ${when(w.start)} – ${when(w.end).replace(/^gisteren /, "")} (${span(w.start, w.end)}) · ${w.calls} aanroepen` }), el("div", { cls: "sub", text: bits.join(" · ") || "Alleen gelezen" })]);
    if (w.last) left.append(btn("Vlieg erheen", () => nav.open(w.last!.id), "btn primary mt"));
    const touched = el("div", {}, [el("div", { cls: "sub mb", text: "Laatst aangeraakt" }), ...w.touched.slice(0, 5).map((t) => row([link(t.title, t.id)]))]);
    if (!w.touched.length) touched.append(el("div", { cls: "sub", text: "Niets gewijzigd in deze sessie" }));
    const sr = el("div", {}, [el("div", { cls: "sub mb", text: "Laatste zoekopdrachten" }), ...d.searches.map((q) => row([btn(q, () => nav.search(q), "code")]))]);
    if (!d.searches.length) sr.append(el("div", { cls: "sub", text: "Nog niet gezocht" }));
    where.append(el("div", { cls: "three" }, [left, touched, sr]));
  }
  // aantallen en tokens
  const items = card("Items", [el("div", { cls: "big", text: nl(s.notes) }), el("div", { cls: "sub", text: `+${nl(s.last30)} in 30 dagen · ${nl(s.archived)} gearchiveerd · ${nl(s.images)} afbeeldingen · ${s.broken} kapot` }), sparkline(s.growth)]);
  const saved = d.tokens.full > 0 ? Math.max(0, Math.round((1 - d.tokens.out / d.tokens.full) * 100)) : null;
  const tokens = card("Tokenbesparing (laatste 7 dagen)", saved === null
    ? [el("p", { cls: "sub", text: "Nog niet genoeg aanroepen om dit te meten." })]
    : [el("div", { cls: "big ok", text: `${saved}% minder` }), el("div", { cls: "sub", text: `Claude kreeg ${nl(d.tokens.out)} tokens terug waar de volledige notities ${nl(d.tokens.full)} waren geweest.` }), (() => { const b = el("div", { cls: "bar" }, [el("i")]); (b.firstChild as HTMLElement).style.width = `${Math.max(1, 100 - saved)}%`; b.setAttribute("role", "img"); b.setAttribute("aria-label", `${100 - saved} procent van de tokens gebruikt`); return b; })(), el("div", { cls: "sub split" }, [el("span", { text: "teruggegeven" }), el("span", { text: "volledige notities" })])]);
  const groups = card("Groepen", d.groups.map((g) => { const sw = el("span", { cls: "sw" }); sw.style.background = colorOf(g.id); return row([sw, link(g.title, g.id), el("span", { cls: "sp", text: nl(g.count) })]); }));
  if (!d.groups.length) groups.append(el("p", { cls: "sub", text: "Nog geen groepen." }));
  const rec = card("Recente activiteit", d.recent.map((e) => row([el("span", { cls: "sp when", text: when(e.ts) }), pill(e.actor), el("span", {}, [`${what(e.tool, e.action)}${e.ok ? "" : " (mislukt)"}: `, e.itemId ? link(e.label, e.itemId) : el("b", { text: e.label || "—" })]), el("span", { cls: "sp", text: e.where })])), "wide");
  if (!d.recent.length) rec.append(el("p", { cls: "sub", text: "Nog niets." }));
  r.append(el("div", { cls: "grid" }, [where, items, tokens, groups, rec]));
}

// ---------- logboek ----------
const compact = (a: string | null) => {
  if (!a) return "";
  try {
    return Object.entries(JSON.parse(a) as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  } catch {
    return a;
  }
};
export function renderLogs(nav: Pick<Nav, "open">) {
  const r = root();
  r.replaceChildren();
  const f = { q: "", actor: "", since: "today", errors: false, reads: false };
  let rows: LogRow[] = [], next: number | null = null, sel: LogRow | undefined;
  const q = el("input"), actor = el("select"), since = el("select");
  Object.assign(q, { type: "search", placeholder: "Zoek in tool, argumenten, id's…", ariaLabel: "Zoeken in het logboek" });
  q.className = "logq";
  for (const [v, t] of [["", "Wie: iedereen"], ["claude", "Claude"], ["ui", "Gebruiker (UI)"], ["unknown", "Onbekend"]]) actor.append(Object.assign(el("option", { text: t }), { value: v }));
  for (const [v, t] of [["today", "Vandaag"], ["week", "7 dagen"], ["all", "Alles"]]) since.append(Object.assign(el("option", { text: t }), { value: v }));
  const chk = (t: string, on: (v: boolean) => void) => { const i = el("input"); i.type = "checkbox"; i.onchange = () => { on(i.checked); void load(); }; return el("label", { cls: "lt" }, [i, el("span", { text: t })]); };
  const tbody = el("tbody"), foot = el("div", { cls: "logfoot" }), more = el("div", { cls: "logmore" });
  const sinceIso = () => (f.since === "today" ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString() : f.since === "week" ? new Date(Date.now() - 7 * 864e5).toISOString() : undefined);
  const draw = () => {
    tbody.replaceChildren(...rows.map((x) => {
      const tr = el("tr", { cls: x === sel ? "sel" : "" }, [el("td", { cls: "m", text: when(x.ts) }), el("td", {}, [pill(x.actor)]), el("td", { text: x.client ?? "" }), el("td", { cls: "m", text: x.tool }), el("td", { cls: "m clip", text: compact(x.args) }), el("td", { cls: "m", text: x.ids.length > 1 ? `${x.ids[0]} +${x.ids.length - 1}` : x.ids[0] ?? "–" }), el("td", { cls: "m", text: x.tokensOut === null ? "–" : nl(x.tokensOut) }), el("td", { cls: "m" + (x.ok ? "" : " bad"), text: x.ok ? `${x.ms ?? 0} ms` : "mislukt" })]);
      tr.tabIndex = 0;
      tr.onclick = () => { sel = x; draw(); };
      tr.onkeydown = (e) => { if (e.key === "Enter") { sel = x; draw(); } };
      return tr;
    }));
    if (!rows.length) tbody.append(el("tr", {}, [Object.assign(el("td", { text: "Geen regels voor deze selectie." }), { colSpan: 8 })]));
    foot.replaceChildren();
    if (sel) {
      const saved = sel.tokensOut !== null && sel.tokensFull ? Math.round((1 - sel.tokensOut / sel.tokensFull) * 100) : null;
      const act = /"action":"([a-z_]+)"/.exec(sel.args ?? "")?.[1];
      foot.append(el("div", {}, [el("div", { cls: "sub", text: "Geselecteerd" }), el("b", { text: act ? `${sel.tool} · ${act}` : sel.tool })]));
      if (sel.tokensOut !== null) foot.append(el("div", {}, [el("div", { cls: "sub", text: "Tokens teruggegeven" }), el("b", { text: nl(sel.tokensOut) })]));
      if (sel.tokensFull) foot.append(el("div", {}, [el("div", { cls: "sub", text: "Tokens van de volledige notitie" }), el("b", { text: nl(sel.tokensFull) }), el("span", { cls: "sub", text: saved !== null ? ` (${saved}% bespaard)` : "" })]));
      if (sel.note) foot.append(el("div", { cls: "note-txt" }, [el("div", { cls: "sub", text: "Notitie" }), el("span", { text: sel.note.slice(0, 300) })]));
      const id = sel.ids[0];
      if (id) { const b = btn("Vlieg naar dit item →", () => nav.open(id), "link-btn"); foot.append(b); }
    }
    more.replaceChildren();
    if (next) more.append(btn("Oudere regels laden", () => void load(next ?? undefined), "chip"));
  };
  const load = async (before?: number) => {
    try {
      const res = await api.logs({ q: f.q || undefined, actor: f.actor || undefined, ok: f.errors ? "0" : undefined, since: sinceIso(), before, reads: f.reads ? "1" : undefined });
      rows = before ? [...rows, ...res.rows] : res.rows;
      next = res.next;
      if (!before) sel = rows[0];
      draw();
    } catch (e) {
      fail(e);
    }
  };
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(() => { f.q = q.value.trim(); void load(); }, 250); };
  actor.onchange = () => { f.actor = actor.value; void load(); };
  since.onchange = () => { f.since = since.value; void load(); };
  const table = el("table", {}, [el("thead", {}, [el("tr", {}, ["Tijd", "Wie", "Client", "Tool", "Argumenten (ingekort)", "Items", "Tokens terug", "Duur"].map((h) => el("th", { text: h })))]), tbody]);
  r.append(el("section", { cls: "glass card logs" }, [
    el("div", { cls: "logbar" }, [since, actor, q, chk("Alleen fouten", (v) => (f.errors = v)), chk("UI-leesverzoeken", (v) => (f.reads = v)), el("span", { cls: "sub hint-r", text: "Het log is alleen-lezen; niets kan worden gewijzigd of gewist." })]),
    el("div", { cls: "tablewrap" }, [table]), more, foot,
  ]));
  void load();
  return () => load();
}

// ---------- verwijderen ----------
/** Vraagt bevestiging en verwijdert. Geeft true terug als het item of de groep echt weg is. */
export async function confirmDelete(id: string): Promise<boolean> {
  let p;
  try {
    p = await api.deletePreview(id);
  } catch (e) {
    fail(e);
    return false;
  }
  if (p.root) { toast("De wortelgroep (het heelal zelf) kan niet verwijderd worden."); return false; }
  const isGroup = p.kind === "group", n = p.notes + p.images, phrase = isGroup && n > 0 ? `verwijder ${n}` : "";
  const li = (...k: (Node | string)[]) => el("li", {}, k);
  const list = el("ul", {}, isGroup
    ? [li(`De groep "${p.title}"${p.groups ? ` en ${p.groups} ${p.groups === 1 ? "subgroep" : "subgroepen"}` : ""}`), li(el("b", { text: `${nl(p.notes)} ${p.notes === 1 ? "notitie" : "notities"}` }), " en ", el("b", { text: `${nl(p.images)} ${p.images === 1 ? "afbeelding" : "afbeeldingen"}` }), " (bestanden en sidecars)")]
    : [li(p.kind === "image" ? "De afbeelding en haar beschrijving" : "De notitie en haar bestand")]);
  if (p.inbound) list.append(li(`Links naar ${isGroup ? "deze items" : "dit item"} uit ${nl(p.inbound)} ${p.inbound === 1 ? "ander item" : "andere items"} worden "kapot" (zichtbaar in `, el("code", { text: "brain doctor" }), ")"));
  const input = el("input"), ok = el("button", { cls: "btn danger", text: "Definitief verwijderen" }), cancel = el("button", { cls: "btn", text: "Annuleren" });
  ok.type = cancel.type = "button";
  const scrim = el("div", { cls: "scrim" }), dlg = el("div", { cls: "modal glass" });
  dlg.setAttribute("role", "alertdialog");
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-labelledby", "dlg-t");
  const title = el("h2", { text: `${isGroup ? "Groep " : ""}"${p.title}" definitief verwijderen?` });
  title.id = "dlg-t";
  dlg.append(title, el("p", { cls: "cf", text: "Dit kan niet ongedaan worden gemaakt. Er is geen prullenbak. Claude kan dit niet zonder jouw uitdrukkelijke opdracht." }), list);
  if (phrase) {
    input.autocomplete = "off";
    input.setAttribute("aria-label", `Typ ${phrase} om te bevestigen`);
    dlg.append(el("label", { cls: "sub" }, ["Typ ", el("b", { text: phrase }), " om te bevestigen"]), input);
  }
  ok.disabled = !!phrase;
  input.oninput = () => (ok.disabled = input.value.trim() !== phrase);
  dlg.append(el("div", { cls: "actions" }, [cancel, ok]));
  document.body.append(scrim, dlg);
  (phrase ? input : cancel).focus();
  return new Promise<boolean>((done) => {
    const close = (v: boolean) => { document.removeEventListener("keydown", key, true); scrim.remove(); dlg.remove(); done(v); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(false); }
      if (e.key === "Tab") { const f = [...dlg.querySelectorAll<HTMLElement>("input,button:not(:disabled)")]; const i = f.indexOf(document.activeElement as HTMLElement); e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length]?.focus(); }
    };
    document.addEventListener("keydown", key, true);
    cancel.onclick = scrim.onclick = () => close(false);
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api.del(id);
        toast(`"${p.title}" is verwijderd.`);
        close(true);
      } catch (e) {
        fail(e);
        close(false);
      }
    };
  });
}
