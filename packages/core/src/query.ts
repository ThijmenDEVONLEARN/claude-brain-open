// Querytaal naar SQL. Alle waarden gaan als parameters mee; geen waarde belandt in de SQL-tekst.

export class QueryError extends Error {}

type Node =
  | { t: "text"; v: string; phrase: boolean; prefix: boolean; neg: boolean }
  | { t: "f"; key: string; val: string; neg: boolean }
  | { t: "and" | "or"; kids: Node[] };

type Tok = { k: "lp" } | { k: "rp" } | { k: "or" } | { k: "text"; v: string; phrase: boolean; prefix: boolean; neg: boolean } | { k: "f"; key: string; val: string; neg: boolean };

const KEYS = ["tag", "group", "kind", "type", "status", "parent", "ancestor", "links-to", "linked-from", "link-type", "has", "created", "updated", "sort"] as const;
const ID = /^[nig]_[0-9a-z]{8}$/;

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const quoted = (): string => {
    const end = q.indexOf('"', i + 1);
    if (end < 0) throw new QueryError("aanhalingsteken niet gesloten");
    const v = q.slice(i + 1, end);
    i = end + 1;
    return v;
  };
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "(") {
      out.push({ k: "lp" });
      i++;
    }
    else if (c === ")") {
      out.push({ k: "rp" });
      i++;
    }
    else if (c === '"' || (c === "-" && q[i + 1] === '"')) {
      const neg = c === "-";
      if (neg) i++;
      out.push({ k: "text", v: quoted(), phrase: true, prefix: false, neg });
    } else {
      const neg = c === "-";
      const start = neg ? i + 1 : i;
      let j = start;
      while (j < q.length && !/[\s()"]/.test(q[j]!)) j++;
      const word = q.slice(start, j);
      const colon = word.indexOf(":");
      if (colon > 0 && /^[a-z-]+$/.test(word.slice(0, colon))) {
        const key = word.slice(0, colon);
        let val = word.slice(colon + 1);
        j = start + colon + 1 + val.length;
        if (!val && q[j] === '"') {
          i = j;
          val = quoted();
          j = i;
        }
        out.push({ k: "f", key, val, neg });
      } else if (word === "OR" && !neg) out.push({ k: "or" });
      else if (word) out.push({ k: "text", v: word.replace(/\*$/, ""), phrase: false, prefix: word.endsWith("*"), neg });
      i = j;
    }
  }
  return out;
}

function parse(toks: Tok[]): Node {
  let p = 0;
  const expr = (): Node => {
    const kids = [and()];
    while (toks[p]?.k === "or") {
      p++;
      kids.push(and());
    }
    return kids.length === 1 ? kids[0]! : { t: "or", kids };
  };
  const and = (): Node => {
    const kids: Node[] = [];
    for (;;) {
      const t = toks[p];
      if (!t || t.k === "rp" || t.k === "or") break;
      p++;
      if (t.k === "lp") {
        kids.push(expr());
        if (toks[p]?.k !== "rp") throw new QueryError("haakje niet gesloten");
        p++;
      } else if (t.k === "text") kids.push({ t: "text", v: t.v, phrase: t.phrase, prefix: t.prefix, neg: t.neg });
      else kids.push({ t: "f", key: t.key, val: t.val, neg: t.neg });
    }
    if (!kids.length) throw new QueryError("lege term (OR of haakje zonder inhoud)");
    return kids.length === 1 ? kids[0]! : { t: "and", kids };
  };
  const n = expr();
  if (p < toks.length) throw new QueryError("onverwacht ')'");
  return n;
}

export type Sort = "relevance" | "updated" | "created" | "title";
export type Plan = { fts: string | null; where: string; params: (string | number)[]; sort: Sort; statusExplicit: boolean };

const prefixRange = (p: string): [string, string] => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];
const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");

export function compile(query: string): Plan {
  const root = parse(tokenize(query));
  const params: (string | number)[] = [];
  const ph = (v: string | number) => `?${params.push(v)}`;
  let sort: Sort = "relevance";
  let statusExplicit = false;
  let linkType: string | undefined;

  const top = root.t === "and" ? root.kids : [root];
  const pos: string[] = [];
  const negs: string[] = [];
  const fts = (n: Extract<Node, { t: "text" }>) => `"${n.v.replaceAll('"', '""')}"${n.prefix ? "*" : ""}`;
  const rest: Node[] = [];
  for (const n of top) {
    if (n.t === "text") (n.neg ? negs : pos).push(fts(n));
    else rest.push(n);
  }
  // link-type: geldt voor alle links-to/linked-from in de query.
  const findLt = (n: Node) => {
    if (n.t === "f" && n.key === "link-type") linkType = n.val;
    else if (n.t === "and" || n.t === "or") n.kids.forEach(findLt);
  };
  rest.forEach(findLt);

  const date = (col: string, v: string): string => {
    const m = /^(>=|<=|>|<)?(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/.exec(v);
    if (!m) throw new QueryError(`datum '${v}' niet begrepen (voorbeeld: >2026-10-01 of 2026-10)`);
    const [, op = "=", d] = m;
    const c = `i.${col}`;
    // '~' sorteert na alle cijfers en 'T', dus `d~` is het einde van die dag/maand/jaar.
    if (op === ">") return `${c} > ${ph(d + "~")}`;
    if (op === ">=") return `${c} >= ${ph(d!)}`;
    if (op === "<") return `${c} < ${ph(d!)}`;
    if (op === "<=") return `${c} <= ${ph(d + "~")}`;
    return `(${c} >= ${ph(d!)} AND ${c} < ${ph(d + "~")})`;
  };
  const id = (key: string, v: string) => {
    if (!ID.test(v)) throw new QueryError(`${key}: '${v}' is geen id (verwacht bijvoorbeeld n_k7x2m9qa)`);
    return v;
  };
  const oneOf = (key: string, v: string, ok: string[]) => {
    if (!ok.includes(v)) throw new QueryError(`${key}: '${v}' onbekend, kies uit ${ok.join(", ")}`);
    return v;
  };

  const filter = (n: Extract<Node, { t: "f" }>): string => {
    const { key, val } = n;
    if (!(KEYS as readonly string[]).includes(key)) throw new QueryError(`onbekend filter '${key}:', kies uit ${KEYS.join(", ")}`);
    if (!val) throw new QueryError(`${key}: heeft een waarde nodig`);
    let s: string;
    switch (key) {
      case "tag": {
        const [lo, hi] = prefixRange(`${val}/`);
        s = `i.id IN (SELECT t.item_id FROM tags t WHERE t.tag = ${ph(val)} OR (t.tag >= ${ph(lo)} AND t.tag < ${ph(hi)}))`;
        break;
      }
      case "group": {
        const exact = val.startsWith("=");
        const p = `/${norm(exact ? val.slice(1) : val)}/`.replace("//", "/");
        if (exact) s = `i.group_path = ${ph(p)}`;
        else {
          const [lo, hi] = prefixRange(p);
          s = `(i.group_path >= ${ph(lo)} AND i.group_path < ${ph(hi)})`;
        }
        break;
      }
      case "kind":
        s = `i.kind = ${ph(oneOf(key, val, ["note", "image", "group"]))}`;
        break;
      case "type":
        s = `i.type = ${ph(val)}`;
        break;
      case "status": {
        statusExplicit = true;
        const v = oneOf(key, val, ["active", "archived", "any", "broken"]);
        s = v === "any" ? `i.status IN ('active','archived')` : `i.status = ${ph(v)}`;
        break;
      }
      case "parent":
        s = `i.parent_id = ${ph(id(key, val))}`;
        break;
      case "ancestor":
        s = `i.id IN (WITH RECURSIVE d(id) AS (SELECT id FROM items WHERE parent_id = ${ph(id(key, val))} UNION SELECT c.id FROM items c JOIN d ON c.parent_id = d.id) SELECT id FROM d)`;
        break;
      case "links-to":
      case "linked-from": {
        const out = key === "links-to";
        s = `i.id IN (SELECT l.${out ? "src" : "dst"} FROM links l WHERE l.${out ? "dst" : "src"} = ${ph(id(key, val))}${linkType ? ` AND l.type = ${ph(linkType)}` : ""})`;
        break;
      }
      case "link-type":
        s = "1";
        break;
      case "has": {
        const h = oneOf(key, val, ["links", "image", "tags", "parent", "children"]);
        s = {
          links: `(EXISTS (SELECT 1 FROM links l WHERE l.src = i.id) OR EXISTS (SELECT 1 FROM links l WHERE l.dst = i.id))`,
          image: `EXISTS (SELECT 1 FROM links l JOIN items t ON t.id = l.dst WHERE l.src = i.id AND t.kind = 'image')`,
          tags: `EXISTS (SELECT 1 FROM tags t WHERE t.item_id = i.id)`,
          parent: `i.parent_id IS NOT NULL`,
          children: `EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id)`,
        }[h]!;
        break;
      }
      case "created":
      case "updated":
        s = date(key, val);
        break;
      default: // sort
        sort = oneOf(key, val, ["relevance", "updated", "created", "title"]) as Sort;
        return "1";
    }
    return n.neg ? `NOT ${s}` : s;
  };

  const tree = (n: Node): string => {
    if (n.t === "text") throw new QueryError("vrije tekst kan niet binnen OR of haakjes; zet de tekst buiten de OR");
    if (n.t === "f") return filter(n);
    return `(${n.kids.map(tree).join(n.t === "and" ? " AND " : " OR ")})`;
  };

  const parts = rest.map(tree);
  if (!statusExplicit) parts.push(`i.status = 'active'`);
  let ftsExpr: string | null = null;
  if (pos.length) ftsExpr = `(${pos.join(" AND ")})${negs.length ? ` NOT (${negs.join(" OR ")})` : ""}`;
  else if (negs.length) throw new QueryError("een uitgesloten woord (-woord) heeft ook een gewoon zoekwoord nodig");
  return { fts: ftsExpr, where: parts.length ? parts.join(" AND ") : "1", params, sort, statusExplicit };
}
