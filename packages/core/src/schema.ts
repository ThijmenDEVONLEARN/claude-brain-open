import { z } from "zod";

export const SIDECAR = /\.(png|jpe?g|gif|webp)\.md$/i;
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{8}$`));
const anyId = z.string().regex(/^[nig]_[0-9a-z]{8}$/);
// YAML parst een kale timestamp tot Date; we bewaren altijd een ISO-string.
const date = z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v));
const status = z.enum(["active", "archived"]);

export const noteMeta = z.object({
  id: idOf("n"),
  title: z.string().min(1),
  // Plan: ~200 tekens; we keuren pas af bij 400 zodat een iets te lange samenvatting geen kapot bestand wordt.
  summary: z.string().min(1).max(400),
  type: z.string().default("note"),
  tags: z.array(z.string().min(1)).default([]),
  parent: anyId.optional(),
  links: z.array(z.object({ to: anyId, type: z.string().default("relates_to") })).default([]),
  status,
  created: date,
  updated: date,
});

export const groupMeta = z.object({
  id: idOf("g"),
  title: z.string().min(1),
  summary: z.string().min(1).max(400),
  color: z.string().optional(),
  status,
});

// Sidecar van een afbeelding: dezelfde velden als een notitie, plus wat we van het bestand weten.
export const imageMeta = noteMeta.omit({ id: true, type: true }).extend({
  id: idOf("i"),
  type: z.string().default("image"),
  file: z.string().min(1),
  mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hash: z.string().min(8),
});

export type ImageMeta = z.infer<typeof imageMeta>;
export type NoteMeta = z.infer<typeof noteMeta>;
export type GroupMeta = z.infer<typeof groupMeta>;
