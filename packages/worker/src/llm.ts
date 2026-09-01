/**
 * LLM proxy for the rival bidder agents.
 *
 * Provider keys live in Worker secrets and never appear in a client bundle.
 * This is not optional hygiene: any key shipped to the browser is public, and
 * the client-side deployment surfaces used in this hackathon (ChatGPT Sites
 * included) make that explicit in their own documentation.
 *
 * If no key is configured the endpoint reports that plainly, and the rival
 * agents fall back to their deterministic heuristic policy — the demo still
 * runs, it simply runs without model-driven bidding.
 */

interface LlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  model?: string;
  max_tokens?: number;
}

const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
]);

export async function handleLlm(request: Request, apiKey?: string): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  if (!apiKey) {
    return json(
      {
        error: "no_api_key",
        message:
          "No ANTHROPIC_API_KEY configured on the Worker. Rival agents will use their " +
          "heuristic policy instead of model-driven bidding.",
      },
      503,
    );
  }

  let body: LlmRequest;
  try {
    body = (await request.json()) as LlmRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const model = body.model && ALLOWED_MODELS.has(body.model) ? body.model : "claude-haiku-4-5-20251001";

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(body.max_tokens ?? 512, 1024),
      system: body.system,
      messages: body.messages,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error("llm upstream error", upstream.status, detail);
    // Upstream error text is not forwarded — it can carry content that would
    // land straight in an agent's context.
    return json({ error: "upstream_error", status: upstream.status }, 502);
  }

  const data = (await upstream.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();

  return json({ text });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
