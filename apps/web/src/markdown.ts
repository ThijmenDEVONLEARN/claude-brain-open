// Veilige markdown voor het zijpaneel: we bouwen DOM-knooppunten met textContent, nooit innerHTML.
// Alleen brain:-links (navigatie), https-links en brain:-afbeeldingen komen erdoor; alles anders blijft gewone tekst.
export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "img"; id: string; alt: string };
export type Block =
  | { t: "h"; n: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "code"; v: string }
  | { t: "quote"; c: Inline[] };

const BRAIN = /^brain:([nig]_[0-9a-z]{8})(?:#.*)?$/;
const safeHref = (h: string) => (BRAIN.test(h) || /^https:\/\/[^\s"'<>]+$/.test(h) ? h : null);

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0, buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ t: "code", v: m[1]! });
    } else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest))) {
      const id = BRAIN.exec(m[2]!)?.[1];
      if (id && id.startsWith("i_")) {
        flush();
        out.push({ t: "img", id, alt: m[1]! });
      } else buf += m[1]!;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      const href = safeHref(m[2]!);
      flush();
      out.push(href ? { t: "link", href, c: inline(m[1]!) } : { t: "text", v: m[1]! });
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) {
      flush();
      out.push({ t: "b", c: inline(m[1]!) });
    } else if ((m = /^(?:\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/.exec(rest)) && (i === 0 || /\W/.test(s[i - 1]!))) {
      flush();
      out.push({ t: "i", c: inline((m[1] ?? m[2])!) });
    } else {
      buf += s[i];
      i++;
      continue;
    }
    i += m![0].length;
  }
  flush();
  return out;
}

export function blocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n"), out: Block[] = [];
  let para: string[] = [], list: { t: "ul" | "ol"; items: Inline[][] } | null = null;
  const endPara = () => {
    if (para.length) out.push({ t: "p", c: inline(para.join(" ")) });
    para = [];
  };
  const endList = () => {
    if (list) out.push(list);
    list = null;
  };
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n]!;
    let m: RegExpExecArray | null;
    if (/^```/.test(l)) {
      endPara(); endList();
      const code: string[] = [];
      for (n++; n < lines.length && !/^```/.test(lines[n]!); n++) code.push(lines[n]!);
      out.push({ t: "code", v: code.join("\n") });
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      endPara(); endList();
      out.push({ t: "h", n: m[1]!.length, c: inline(m[2]!) });
    } else if ((m = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(l))) {
      endPara();
      const kind = m[1] ? "ol" : "ul";
      if (!list || list.t !== kind) { endList(); list = { t: kind, items: [] }; }
      list.items.push(inline(m[2]!));
    } else if ((m = /^>\s?(.*)$/.exec(l))) {
      endPara(); endList();
      out.push({ t: "quote", c: inline(m[1]!) });
    } else if (!l.trim()) {
      endPara(); endList();
    } else {
      endList();
      para.push(l.trim());
    }
  }
  endPara(); endList();
  return out;
}

/** Zet de blokken om in DOM; `go` handelt brain:-links af, `imgSrc` bepaalt de bron van een afbeelding. */
export function render(md: string, go: (id: string) => void, imgSrc: (id: string) => string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const el = (tag: string, kids: Node[] = []) => {
    const e = document.createElement(tag);
    e.append(...kids);
    return e;
  };
  const inl = (xs: Inline[]): Node[] =>
    xs.map((x) => {
      switch (x.t) {
        case "text": return document.createTextNode(x.v);
        case "code": return el("code", [document.createTextNode(x.v)]);
        case "b": return el("strong", inl(x.c));
        case "i": return el("em", inl(x.c));
        case "img": {
          const im = document.createElement("img");
          im.src = imgSrc(x.id);
          im.alt = x.alt;
          im.loading = "lazy";
          return im;
        }
        case "link": {
          const a = document.createElement("a");
          a.append(...inl(x.c));
          const id = BRAIN.exec(x.href)?.[1];
          a.href = id ? `#n=${id}` : x.href;
          if (id) a.addEventListener("click", (e) => { e.preventDefault(); go(id); });
          else { a.target = "_blank"; a.rel = "noopener noreferrer"; }
          return a;
        }
      }
    });
  for (const b of blocks(md)) {
    if (b.t === "h") frag.append(el("h" + Math.min(6, b.n + 2), inl(b.c)));
    else if (b.t === "p") frag.append(el("p", inl(b.c)));
    else if (b.t === "quote") frag.append(el("blockquote", inl(b.c)));
    else if (b.t === "code") frag.append(el("pre", [el("code", [document.createTextNode(b.v)])]));
    else frag.append(el(b.t, b.items.map((it) => el("li", inl(it)))));
  }
  return frag;
}
