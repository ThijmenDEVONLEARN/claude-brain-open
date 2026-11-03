// Maakt een nep-kluis voor tests en metingen. Deterministisch: zelfde --count en --seed = zelfde bestanden.
// Gebruik: pnpm tsx scripts/gen-fixtures.ts --out <map> --count 300000 [--seed 1]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string" }, count: { type: "string", default: "1000" }, seed: { type: "string", default: "1" } } });
if (!values.out) throw new Error("--out is verplicht");
const count = Number(values.count);
let state = Number(values.seed) >>> 0;
// mulberry32
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

// Pseudo-woorden uit lettergrepen; kwadrateren van rnd() geeft een Zipf-achtige verdeling zoals echte tekst.
const SYL = ["ka", "lo", "mi", "ren", "tu", "sa", "vi", "do", "pe", "an", "ber", "clo", "dex", "fi", "gra", "hu", "jo", "la", "no", "pri"];
const VOCAB = Array.from({ length: 5000 }, (_, i) => `${SYL[i % 20]}${SYL[Math.floor(i / 20) % 20]}${SYL[Math.floor(i / 400) % 20]}${i % 7 === 0 ? "ing" : ""}`);
const word = () => VOCAB[Math.floor(rnd() * rnd() * VOCAB.length)]!;
const sentence = () => Array.from({ length: 6 + Math.floor(rnd() * 10) }, word).join(" ") + ".";
const TAGS = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `project/${VOCAB[i]}` : VOCAB[i]!));

const idOf = (p: string, i: number) => `${p}_${i.toString(36).padStart(8, "0")}`;
const GROUPS = 12;
const SUBS = 8;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "_group.md"), `---\nid: ${idOf("g", 0)}\ntitle: Heelal\nsummary: De root van de nep-kluis.\nstatus: active\n---\n`);
let gid = 1;
const dirs: string[] = [];
for (let g = 0; g < GROUPS; g++) {
  const gdir = join(values.out, `groep-${g}`);
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "_group.md"), `---\nid: ${idOf("g", gid++)}\ntitle: Groep ${g}\nsummary: ${sentence()}\nstatus: active\n---\n`);
  for (let s = 0; s < SUBS; s++) {
    const sdir = join(gdir, `sub-${s}`);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "_group.md"), `---\nid: ${idOf("g", gid++)}\ntitle: Groep ${g}.${s}\nsummary: ${sentence()}\nstatus: active\n---\n`);
    dirs.push(sdir);
  }
}

for (let i = 0; i < count; i++) {
  const dir = dirs[i % dirs.length]!;
  const links: string[] = [];
  // Link naar eerdere notities in hetzelfde cluster (i - k * dirs.length zit in dezelfde map).
  for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
    const j = i - Math.ceil(rnd() * 20) * dirs.length;
    if (j >= 0) links.push(`  - { to: ${idOf("n", j)}, type: relates_to }`);
  }
  const parent = i >= dirs.length * 5 && rnd() < 0.3 ? `parent: ${idOf("n", i - dirs.length * (1 + Math.floor(rnd() * 5)))}\n` : "";
  const tags = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(TAGS));
  const sections = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
    const body = Array.from({ length: 2 + Math.floor(rnd() * 5) }, sentence).join(" ");
    const ref = i > 0 && rnd() < 0.3 ? ` Zie [${word()}](brain:${idOf("n", Math.floor(rnd() * i))}).` : "";
    return `## ${word()} ${word()}\n${body}${ref}\n`;
  }).join("\n");
  const status = rnd() < 0.1 ? "archived" : "active";
  writeFileSync(
    join(dir, `${word()}-${word()}--${idOf("n", i)}.md`),
    `---\nid: ${idOf("n", i)}\ntitle: ${word()} ${word()} ${word()}\nsummary: ${sentence()}\ntags: [${tags.join(", ")}]\n${parent}${links.length ? `links:\n${links.join("\n")}\n` : ""}status: ${status}\ncreated: ${iso(i)}\nupdated: ${iso(i + 1)}\n---\n\n${sections}`,
  );
}
console.log(`${count} notities, ${gid} groepen in ${values.out}`);
