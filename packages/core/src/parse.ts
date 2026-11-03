import matter from "gray-matter";
import type { z } from "zod";
import { groupMeta, imageMeta, noteMeta, type GroupMeta, type ImageMeta, type NoteMeta } from "./schema";

export type Section = {
  ord: number;
  heading: string;
  slug: string;
  level: number;
  start: number;
  end: number;
  tokens: number;
};

export type Parsed<M> = { meta: M; body: string; sections: Section[]; inline: string[]; tokens: number };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE_LINK = /\]\(brain:([nig]_[0-9a-z]{8})(?:#[^)\s]*)?\)/g;

export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

const slugify = (h: string) =>
  h
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-") || "sectie";

/** Koppen en `brain:`-links, met overslaan van fenced code. Secties zijn plat: elke kop begint er een. */
function scan(body: string): { sections: Section[]; inline: string[] } {
  const sections: Section[] = [];
  const inline = new Set<string>();
  const used = new Map<string, number>();
  let inFence = false;
  let current: Omit<Section, "end" | "tokens"> = { ord: 0, heading: "", slug: "", level: 0, start: 0 };

  const close = (end: number) => {
    // De intro (voor de eerste kop) telt alleen mee als er tekst staat.
    if (current.ord === 0 && !body.slice(current.start, end).trim()) return;
    sections.push({ ...current, end, tokens: estimateTokens(end - current.start) });
  };

  let offset = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const h = HEADING.exec(line);
      if (h) {
        close(offset);
        const base = slugify(h[2]!);
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        current = { ord: current.ord + 1, heading: h[2]!, slug: n === 1 ? base : `${base}-${n}`, level: h[1]!.length, start: offset };
      }
      for (const m of line.matchAll(INLINE_LINK)) inline.add(m[1]!);
    }
    offset += rawLine.length + 1;
  }
  close(body.length);
  return { sections, inline: [...inline] };
}

function parse<S extends z.ZodTypeAny>(raw: string, schema: S): Parsed<z.output<S>> {
  // `{}` als opties: zonder opties cachet gray-matter elke inhoud voor altijd (geheugenlek bij 300k bestanden).
  const fm = matter(raw, {});
  const result = schema.safeParse(fm.data);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new Error(`frontmatter: ${first.path.join(".") || "(leeg)"}: ${first.message}`);
  }
  const body = fm.content;
  return { meta: result.data, body, ...scan(body), tokens: estimateTokens(body.length) };
}

export const parseNote = (raw: string): Parsed<NoteMeta> => parse(raw, noteMeta);
export const parseGroup = (raw: string): Parsed<GroupMeta> => parse(raw, groupMeta);
export const parseImage = (raw: string): Parsed<ImageMeta> => parse(raw, imageMeta);
