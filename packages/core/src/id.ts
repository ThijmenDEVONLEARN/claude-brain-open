import { randomInt } from "node:crypto";

export type Kind = "note" | "image" | "group";

const PREFIX: Record<Kind, string> = { note: "n", image: "i", group: "g" };
const ID_RE = /^([nig])_[0-9a-z]{8}$/;

/** Korte id: prefix + 8 tekens base36. */
export function newId(kind: Kind): string {
  let tail = "";
  for (let i = 0; i < 8; i++) tail += randomInt(36).toString(36);
  return `${PREFIX[kind]}_${tail}`;
}

export function kindOf(id: string): Kind | undefined {
  const prefix = ID_RE.exec(id)?.[1];
  return (Object.keys(PREFIX) as Kind[]).find((k) => PREFIX[k] === prefix);
}
