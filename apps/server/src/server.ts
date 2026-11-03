import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Brain, UiData, Writer } from "@claude-brain/core";
import Fastify from "fastify";
import type { AuditEntry } from "./audit";
import { createMcp } from "./mcp";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const COOKIE = "brain_session";
export type ServerOpts = { brain: Brain; writer: Writer; token: string; port: number; log?: boolean; audit?: (e: AuditEntry) => void; ui?: UiData; webDir?: string };

const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
// Geen inline scripts, geen externe bronnen: de pagina haalt alleen eigen bestanden en eigen afbeeldingen op.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function buildServer(opts: ServerOpts) {
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const app = Fastify({ logger: opts.log ?? false, bodyLimit: 30 * 1024 * 1024 });
  const sink = opts.audit ?? (() => {});
  // Telt wat Claude doet (alles behalve UI-leesverzoeken); de live-stream gebruikt dit om te zien dat er iets nieuws is.
  let activity = 0;
  const audit = (e: AuditEntry) => {
    if (e.actor !== "ui" || e.tool === "ui_delete") activity++;
    sink(e);
  };
  const session = createHmac("sha256", opts.token).update("ui-session").digest("hex");

  // De limiet van 30 MB geldt pas na de controles hieronder: onbekenden kunnen dus geen grote body laten inlezen.
  // §15.2: Host-check tegen DNS-rebinding, Origin-check tegen websites, daarna het verplichte token.
  // Elke weigering komt in het audit log (zonder de waarde van het token of andere headers).
  app.addHook("onRequest", async (req, reply) => {
    const deny = (code: number, reason: string) => {
      audit({ actor: "unknown", client: String(req.headers["user-agent"] ?? ""), tool: "auth_denied", args: { reason, method: req.method, url: req.url.slice(0, 100) }, ok: false, ms: 0 });
      return reply.code(code).send({ error: reason });
    };
    if (!hosts.has(req.headers.host ?? "")) return deny(403, "bad_host");
    const [path = "", query = ""] = req.url.split("?");
    // Browsers vragen zelf om /favicon.ico, zonder cookie; geen icoon, geen ruis in het logboek.
    if (req.method === "GET" && path === "/favicon.ico") return reply.code(204).send();
    const cookieOk = () => {
      const c = /(?:^|;\s*)brain_session=([0-9a-f]+)/.exec(req.headers.cookie ?? "");
      return !!c && same(c[1]!, session);
    };
    // Verwijderen vanuit de UI is de enige schrijfroute van de browser: dáár zijn het sessiecookie (afgeleid van het token)
    // én een Origin van onze eigen pagina allebei verplicht. Een kale token zonder Origin (zoals curl) komt er niet in.
    if (req.method === "DELETE" && path.startsWith("/api/items/")) {
      if (req.headers.origin === undefined || !origins.has(req.headers.origin)) return deny(403, "bad_origin");
      return cookieOk() ? undefined : deny(401, "unauthorized");
    }
    if (req.headers.origin !== undefined) return deny(403, "bad_origin");
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (m && same(m[1]!, opts.token)) return;
    // De browser-UI: `brain open` opent /?token=…, dat wordt een cookie. Het cookie bevat een afgeleide waarde, niet het
    // token zelf (cookies worden ook naar andere localhost-poorten gestuurd), en geldt nooit voor /mcp.
    if (req.method === "GET" && path === "/") {
      const t = new URLSearchParams(query).get("token");
      if (t && same(t, opts.token)) return reply.header("set-cookie", `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`).redirect("/");
    }
    // Het cookie geldt alleen voor de pagina, zijn bestanden en de alleen-lezen /api; nooit voor /mcp.
    if (req.method === "GET" && (path === "/" || path.startsWith("/api/") || path.startsWith("/assets/"))) {
      if (cookieOk()) return;
    }
    return deny(401, "unauthorized");
  });

  const page = async (file: string, reply: import("fastify").FastifyReply) => {
    const ext = file.split(".").pop() ?? "";
    if (!opts.webDir || !/^[\w-]+\.(html|js|css)$/.test(file)) return reply.code(404).send({ error: "niet gevonden" });
    try {
      return reply.header("content-security-policy", CSP).header("x-content-type-options", "nosniff").header("cache-control", "no-cache").type(MIME[ext]!).send(await readFile(join(opts.webDir, file)));
    } catch {
      if (file !== "index.html") return reply.code(404).send({ error: "niet gevonden" });
      return reply.type(MIME.html!).send("<!doctype html><meta charset=utf-8><title>Claude Brain</title><body style=\"font:16px system-ui;margin:3rem\"><h1>Claude Brain draait</h1><p>De server werkt, maar de UI is nog niet gebouwd. Draai <code>pnpm build:web</code>.</p>");
    }
  };
  app.get("/", (_, reply) => page("index.html", reply));
  app.get("/assets/:file", (req, reply) => page((req.params as { file: string }).file, reply));

  // Alleen-lezen gegevens voor de UI; elke aanvraag komt als actor "ui" in het audit log.
  const ui = opts.ui;
  if (ui) {
    const api = async <T>(tool: string, args: Record<string, unknown>, f: () => T | undefined | Promise<T | undefined>, reply: import("fastify").FastifyReply) => {
      const t0 = Date.now();
      const out = await f();
      audit({ actor: "ui", client: "browser", tool, args, ok: out !== undefined, ms: Date.now() - t0 });
      return out === undefined ? reply.code(404).send({ error: "niet gevonden" }) : reply.header("cache-control", "no-store").send(out);
    };
    const q = (req: { query: unknown }) => req.query as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
    app.get("/api/dashboard", (_, reply) => api("ui_dashboard", {}, () => ui.dashboard(), reply));
    app.get("/api/logs", (req, reply) => {
      const a = q(req);
      return api("ui_logs", { ...a }, () => ui.logPage({ q: a.q?.slice(0, 200), actor: a.actor, ok: a.ok === "0" ? false : undefined, since: a.since, before: num(a.before), limit: num(a.limit), reads: a.reads === "1" }), reply);
    });
    app.get("/api/delete-preview/:id", (req, reply) => api("ui_delete_preview", { id: (req.params as { id: string }).id }, () => ui.deletePreview((req.params as { id: string }).id), reply));
    app.delete("/api/items/:id", (req, reply) => {
      const id = (req.params as { id: string }).id, t0 = Date.now(), prev = ui.deletePreview(id);
      if (!prev) return reply.code(404).send({ error: "niet gevonden" });
      if (prev.root) return reply.code(403).send({ error: "de wortelgroep wordt niet verwijderd" });
      const r = opts.writer.organize({ action: "delete", ids: [id], confirm: [id] });
      const ok = !r.text.startsWith("ERROR ");
      audit({ actor: "ui", client: "browser", tool: "ui_delete", args: { id, kind: prev.kind, title: prev.title }, ids: [id], ok, ms: Date.now() - t0, note: r.note ?? r.text });
      return ok ? { ok: true, text: r.text } : reply.code(409).send({ error: r.text });
    });
    // Live: één melding zodra de index of het logboek verandert; de pagina haalt dan zelf opnieuw op.
    const clients = new Set<ServerResponse>();
    let last = "", beat = 0, timer: NodeJS.Timeout | undefined;
    const tick = () => {
      const cur = `${ui.indexVersion()}:${activity}`;
      const changed = cur !== last;
      last = cur;
      for (const c of clients) c.write(changed ? "event: change\ndata: {}\n\n" : ++beat % 20 === 0 ? ": ping\n\n" : "");
    };
    app.get("/api/events", (_, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
      reply.raw.write(": live\n\n");
      if (!clients.size) last = `${ui.indexVersion()}:${activity}`;
      clients.add(reply.raw);
      timer ??= setInterval(tick, 1000);
      reply.raw.on("close", () => {
        clients.delete(reply.raw);
        if (!clients.size && timer) { clearInterval(timer); timer = undefined; }
      });
    });
    app.addHook("preClose", async () => {
      if (timer) clearInterval(timer);
      for (const c of clients) c.end();
      clients.clear();
    });
    app.get("/api/overview", (_, reply) => api("ui_overview", {}, () => ui.overview(), reply));
    app.get("/api/group/:id", (req, reply) => api("ui_group", { id: (req.params as { id: string }).id }, () => ui.group((req.params as { id: string }).id), reply));
    app.get("/api/items", (req, reply) => {
      const a = q(req);
      return api("ui_items", { ...a }, () => ui.items({ group: a.group ?? "", type: a.type, tag: a.tag, limit: num(a.limit), offset: num(a.offset) }), reply);
    });
    app.get("/api/item/:id", (req, reply) => api("ui_item", { id: (req.params as { id: string }).id }, () => ui.item((req.params as { id: string }).id), reply));
    app.get("/api/search", (req, reply) => {
      const a = q(req);
      return api("ui_search", { q: (a.q ?? "").slice(0, 200) }, () => ui.search((a.q ?? "").slice(0, 500), num(a.limit)), reply);
    });
    app.get("/api/image/:id", (req, reply) => {
      const id = (req.params as { id: string }).id;
      const t0 = Date.now();
      const img = ui.image(id);
      audit({ actor: "ui", client: "browser", tool: "ui_image", args: { id }, ok: !!img, ms: Date.now() - t0 });
      if (!img) return reply.code(404).send({ error: "niet gevonden" });
      return reply.header("content-security-policy", "default-src 'none'").header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=300").type(img.mime).send(img.data);
    });
  }

  app.post("/mcp", async (req, reply) => {
    const server = createMcp({ brain: opts.brain, writer: opts.writer, audit, onError: (e) => req.log.error(e) }, String(req.headers["user-agent"] ?? ""));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const no = async (_: unknown, reply: { code(n: number): { header(k: string, v: string): { send(b: unknown): void } } }) => reply.code(405).header("Allow", "POST").send({ error: "stateless: alleen POST" });
  app.get("/mcp", no);
  app.delete("/mcp", no);
  return app;
}
