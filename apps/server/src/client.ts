/** Roept één MCP-tool aan op de draaiende server en geeft de tekst terug. Voor `brain call` en de optionele sessiehook. */
export async function callTool(url: string, token: string, name: string, args: unknown, timeoutMs = 3000, f: typeof fetch = fetch): Promise<string> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`server antwoordde ${res.status}`);
  const body = (await res.json()) as { result?: { content?: { type: string; text?: string }[] }; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return (body.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
