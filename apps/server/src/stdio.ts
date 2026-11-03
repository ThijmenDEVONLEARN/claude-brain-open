import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Brug voor Claude Desktop: regels JSON-RPC van stdin -> POST /mcp met token -> antwoord naar stdout. */
export async function bridge(input: Readable, output: Writable, url: string, token: string, f: typeof fetch = fetch): Promise<void> {
  const fail = (id: unknown, msg: string) => output.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: msg } }) + "\n");
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue;
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown }).id;
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: line });
      const body = await res.text();
      if (res.status === 202 || !body) continue; // notificatie: geen antwoord
      if (!res.ok) fail(id, `server antwoordde ${res.status}`);
      else output.write(body.trim() + "\n");
    } catch {
      fail(id, "Claude Brain draait niet. Start de server met: brain serve");
    }
  }
}
