import Anthropic from "@anthropic-ai/sdk";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

export type ExecTool = (name: string, input: Record<string, unknown>) => Promise<string>;
export type OnText = (text: string) => void;

export interface Provider {
  readonly name: string;
  run(system: string, task: string, tools: ToolSpec[], exec: ExecTool, onText: OnText): Promise<string>;
}

const MAX_TURNS = 12;

export class AnthropicProvider implements Provider {
  readonly name: string;
  #client: Anthropic;
  #model: string;
  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.#client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.#model = opts.model ?? "claude-sonnet-5-5";
    this.name = `anthropic:${this.#model}`;
  }

  async #create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    // Server-side refusal fallback is enabled by default; retry without it if the account or model rejects the beta.
    try {
      return (await this.#client.beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as never)) as unknown as Anthropic.Message;
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) return this.#client.messages.create(params);
      throw e;
    }
  }

  async run(system: string, task: string, tools: ToolSpec[], exec: ExecTool, onText: OnText): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
    const defs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));
    let finalText = "";
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await this.#create({ model: this.#model, max_tokens: 16000, system, tools: defs, messages });
      if (res.stop_reason === "refusal") throw new Error("Model declined the request");
      // Keep the full content (including thinking blocks) so the conversation stays valid.
      messages.push({ role: "assistant", content: res.content });
      const texts = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        finalText = texts.join("\n\n");
        if (res.stop_reason === "pause_turn") continue;
        return finalText;
      }
      texts.forEach(onText);
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        try {
          results.push({ type: "tool_result", tool_use_id: u.id, content: await exec(u.name, u.input as Record<string, unknown>) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: String((e as Error).message), is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return finalText || "Stopped after too many steps.";
  }
}

/** OpenAI Chat Completions or any compatible server (Ollama, LM Studio, vLLM). */
export class OpenAICompatProvider implements Provider {
  readonly name: string;
  readonly opts: { baseUrl: string; model: string; apiKey?: string; label: string };
  constructor(opts: { baseUrl: string; model: string; apiKey?: string; label: string }) {
    this.opts = opts;
    this.name = `${opts.label}:${opts.model}`;
  }

  async run(system: string, task: string, tools: ToolSpec[], exec: ExecTool, onText: OnText): Promise<string> {
    type Msg = { role: string; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };
    const messages: Msg[] = [
      { role: "system", content: system },
      { role: "user", content: task },
    ];
    const defs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.opts.model, messages, tools: defs }),
      });
      if (!res.ok) throw new Error(`${this.name} -> ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { choices: { message: Msg }[] };
      const msg = json.choices[0].message;
      messages.push(msg);
      if (!msg.tool_calls?.length) return (msg.content ?? "").trim();
      if (msg.content?.trim()) onText(msg.content.trim());
      for (const call of msg.tool_calls) {
        let out: string;
        try {
          out = await exec(call.function.name, JSON.parse(call.function.arguments || "{}"));
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }
    return "Stopped after too many steps.";
  }
}

/**
 * No-key fallback so the payment flow can be demonstrated without any LLM account.
 * It follows a fixed plan through the same tools; it is not an AI model.
 */
export class ScriptedProvider implements Provider {
  readonly name = "scripted (no LLM key set)";
  readonly apiOrigin: string;
  constructor(apiOrigin: string) {
    this.apiOrigin = apiOrigin;
  }

  async run(_system: string, task: string, _tools: ToolSpec[], exec: ExecTool, onText: OnText): Promise<string> {
    const target = parseTargetMinutes(task);
    onText(`Plan: discover priced endpoints on ${this.apiOrigin}, buy a fee estimate for ~${target} min and a mempool summary.`);
    const disc = JSON.parse(await exec("discover_apis", { origin: this.apiOrigin })) as { routes?: { route: string }[] };
    const path = (needle: string) => disc.routes?.find((r) => r.route.includes(needle))?.route.split(" ")[1];
    const feesUrl = `${this.apiOrigin}${path("fees") ?? "/api/fees/recommend"}?target=${target}`;
    const mempoolUrl = `${this.apiOrigin}${path("mempool") ?? "/api/mempool/summary"}`;

    const get = async (url: string) => {
      let r = JSON.parse(await exec("call_api", { url }));
      if (r.status === 402) r = JSON.parse(await exec("pay_and_call", { url, option: "per_call" }));
      return r;
    };
    const fees = await get(feesUrl);
    const mem = await get(mempoolUrl);
    const f = fees.data as { recommended?: { satPerVb: number; targetMinutes: number }; fastest?: number; hour?: number; economy?: number } | undefined;
    const m = mem.data as { count?: number; vsizeMB?: number; totalFeeBtc?: number; blocksToClear?: number; feeBands?: { label: string; vsizeMB: number }[] } | undefined;
    if (!f?.recommended || !m) return `Could not buy the data: ${JSON.stringify(fees.payment ?? fees.error ?? mem.payment ?? mem.error ?? "unknown")}`;
    return [
      `Pay about ${f.recommended.satPerVb} sat/vB to confirm within ~${f.recommended.targetMinutes} minutes (fastest ${f.fastest}, 1h ${f.hour}, economy ${f.economy}).`,
      `Mempool: ${m.count?.toLocaleString()} txs, ${m.vsizeMB} MvB (~${m.blocksToClear} blocks to clear), ${m.totalFeeBtc} BTC in pending fees.`,
    ].join("\n");
  }
}

export function parseTargetMinutes(task: string): number {
  const t = task.toLowerCase();
  const m = t.match(/(\d+)\s*(min|minute)/);
  if (m) return Math.max(10, Math.min(1440, Number(m[1])));
  const h = t.match(/(\d+)\s*(h|hour)/);
  if (h) return Math.max(10, Math.min(1440, Number(h[1]) * 60));
  if (/next block|asap|fast/.test(t)) return 10;
  if (/an hour|one hour|1 hour/.test(t)) return 60;
  if (/day|cheap|no rush/.test(t)) return 1440;
  return 60;
}

export function providerFromEnv(env = process.env, apiOrigin = "http://localhost:4021"): Provider {
  if (env.ANTHROPIC_API_KEY || env.AI_PROVIDER === "anthropic") {
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5" });
  }
  if (env.OPENAI_API_KEY) {
    return new OpenAICompatProvider({ baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.OPENAI_MODEL || "gpt-4.1-mini", apiKey: env.OPENAI_API_KEY, label: "openai" });
  }
  if (env.OLLAMA_URL) {
    return new OpenAICompatProvider({ baseUrl: `${env.OLLAMA_URL.replace(/\/$/, "")}/v1`, model: env.OLLAMA_MODEL || "llama3.1", label: "ollama" });
  }
  return new ScriptedProvider(apiOrigin);
}
