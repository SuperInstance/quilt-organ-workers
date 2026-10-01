/**
 * judge-relay — "compose with some models, test with others", made serverless.
 *
 * Any lane agent (no local model access needed) can fan out a candidate to a
 * panel of judge models on DeepInfra's OpenAI-compatible endpoint and get back
 * per-judge verdicts plus a simple aggregated score. Auth is the same
 * WORKER_UPLOAD_TOKEN as organ-boot-loader (fleet single-token discipline).
 *
 * Bindings (all secrets, set via `wrangler secret put`):
 *   WORKER_UPLOAD_TOKEN  shared upload/judge token (value lives only in gitignored .env.keys)
 *   DEEPINFRA_KEY        DeepInfra API key (alias DEEPINFRA_API_KEY also accepted)
 *
 * POST /judge
 *   {
 *     "candidate": "<text to judge>",
 *     "rubric":    "<what a good verdict looks like>",
 *     "judges": [ {"provider": "deepinfra", "model": "Hermes-3-405B", "max_tokens": 64}, ... ],
 *     "temperature": 0.2        // optional, default 0.2
 *   }
 *   → { ok, judges: [{provider, model, ok, score, content, reasoning_head, usage, latency_ms, error?}],
 *       aggregate: {mean, min, max, spread, n, n_total, providers} }
 *
 * Scoring contract: the relay appends a fixed instruction requiring the judge to
 * BEGIN its verdict with "SCORE: <n>/10" (score-first, so tiny max_tokens budgets
 * still carry a parsable score); the relay parses that line (0..10) and
 * aggregates. Verdict text is always returned raw alongside the parsed score.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-quilt-token",
  "Access-Control-Max-Age": "86400",
};

const DEEPINFRA_BASE = "https://api.deepinfra.com/v1/openai";
const DEFAULT_MAX_TOKENS = 64; // fleet free-tier discipline: small verdicts by default
const MAX_TOKENS_CAP = 256;
const MAX_JUDGES = 8;
const FETCH_TIMEOUT_MS = 60000;

// Short names used in fleet dispatches → DeepInfra model codes (pass-through if "/" present)
const MODEL_ALIASES = {
  "Hermes-3-405B": "NousResearch/Hermes-3-Llama-3.1-405B",
  "Qwen3.5-397B-A17B": "Qwen/Qwen3.5-397B-A17B",
};

const SCORING_CONTRACT =
  "\n\nYou are a judge. Judge ONLY against the rubric above. " +
  "VERY IMPORTANT: make the FIRST line of your reply exactly 'SCORE: <number>/10' (score-first, then at most one short paragraph of justification). " +
  "Scores 0 (fails rubric) to 10 (exemplary).";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function fail(status, error, extraHeaders = {}) {
  return json({ ok: false, error }, status, extraHeaders);
}

async function sha256hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authOk(request, env) {
  if (!env || !env.WORKER_UPLOAD_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = (request.headers.get("x-quilt-token") || "").trim();
  const presented = bearer || alt;
  if (!presented) return false;
  return (await sha256hex(presented)) === (await sha256hex(env.WORKER_UPLOAD_TOKEN));
}

function parseScore(text) {
  if (typeof text !== "string") return { score: null, hasContractLine: false };
  const m =
    text.match(/^\s*SCORE:\s*([0-9]{1,2}(?:\.[0-9]+)?)\s*\/\s*10/i) ||
    text.match(/SCORE:\s*([0-9]{1,2}(?:\.[0-9]+)?)\s*\/\s*10/i);
  if (!m) return { score: null, hasContractLine: false };
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return { score: null, hasContractLine: true };
  n = Math.max(0, Math.min(10, n));
  return { score: n, hasContractLine: true };
}

function resolveModel(model) {
  if (typeof model !== "string" || model.trim() === "") return null;
  const name = model.trim();
  return name.includes("/") ? name : (MODEL_ALIASES[name] ?? name);
}

async function callJudge(judge, rubric, candidate, temperature, env) {
  const t0 = Date.now();
  const provider = (judge.provider || "deepinfra").toLowerCase();
  const model = resolveModel(judge.model);
  if (provider !== "deepinfra") {
    return { provider, model: judge.model ?? null, ok: false, score: null, error: `unsupported provider "${provider}" (this relay serves "deepinfra")`, latency_ms: 0 };
  }
  if (!model) {
    return { provider, model: null, ok: false, score: null, error: "judge.model missing", latency_ms: 0 };
  }
  const apiKey = env.DEEPINFRA_KEY || env.DEEPINFRA_API_KEY;
  if (!apiKey) {
    return { provider, model, ok: false, score: null, error: "DEEPINFRA_KEY secret not configured on this worker", latency_ms: 0 };
  }
  const maxTokens = Math.max(1, Math.min(MAX_TOKENS_CAP, Number(judge.max_tokens) || DEFAULT_MAX_TOKENS));
  // Reasoning models (Qwen3/3.5 family on DeepInfra) burn the token budget on
  // hidden reasoning before emitting any content — off by default for them.
  const qwenFamily = /qwen/i.test(model);
  const noThinking = judge.no_thinking !== undefined ? !!judge.no_thinking : qwenFamily;
  const payload = {
    model,
    messages: [
      { role: "system", content: rubric + SCORING_CONTRACT },
      { role: "user", content: candidate },
    ],
    max_tokens: maxTokens,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
  };
  if (noThinking) payload.chat_template_kwargs = { enable_thinking: false };
  try {
    const resp = await fetch(`${DEEPINFRA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const latency = Date.now() - t0;
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const detail = data && (data.error?.message || data.detail || data.message) || `HTTP ${resp.status}`;
      return { provider, model, ok: false, score: null, error: `deepinfra ${resp.status}: ${String(detail).slice(0, 300)}`, latency_ms: latency };
    }
    const content = data?.choices?.[0]?.message?.content ?? null;
    const reasoning = data?.choices?.[0]?.message?.reasoning_content ?? null;
    const { score } = parseScore(content);
    return {
      provider,
      model,
      ok: true,
      score,
      scoreParsedFromContractLine: score !== null,
      content,
      reasoning_head: reasoning ? String(reasoning).slice(0, 400) : null,
      usage: data?.usage ?? null,
      finish_reason: data?.choices?.[0]?.finish_reason ?? null,
      latency_ms: latency,
    };
  } catch (e) {
    return { provider, model, ok: false, score: null, error: `fetch failed: ${String(e && e.message ? e.message : e).slice(0, 200)}`, latency_ms: Date.now() - t0 };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json({
        service: "judge-relay",
        ok: true,
        auth: "Authorization: Bearer <WORKER_UPLOAD_TOKEN> (or x-quilt-token)",
        endpoint: "POST /judge {candidate, rubric, judges:[{provider, model, max_tokens?}]}",
        providers: ["deepinfra"],
        provider_base: DEEPINFRA_BASE,
        model_aliases: MODEL_ALIASES,
        limits: { default_max_tokens: DEFAULT_MAX_TOKENS, max_tokens_cap: MAX_TOKENS_CAP, max_judges: MAX_JUDGES },
        note: "compose with some models, test with others — callable from any lane without local model access",
      });
    }

    if (method === "POST" && path === "/judge") {
      if (!(await authOk(request, env))) {
        return fail(401, "unauthorized — present WORKER_UPLOAD_TOKEN via 'Authorization: Bearer <token>' or 'x-quilt-token'");
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return fail(400, `body is not valid JSON: ${e.message}`);
      }
      if (typeof body.candidate !== "string" || body.candidate.trim() === "") {
        return fail(400, "candidate must be a non-empty string");
      }
      if (typeof body.rubric !== "string" || body.rubric.trim() === "") {
        return fail(400, "rubric must be a non-empty string");
      }
      if (!Array.isArray(body.judges) || body.judges.length === 0) {
        return fail(400, "judges must be a non-empty array of {provider?, model, max_tokens?}");
      }
      if (body.judges.length > MAX_JUDGES) {
        return fail(400, `judges array too large (${body.judges.length}; max ${MAX_JUDGES})`);
      }
      if (typeof body.candidate !== "string" || body.candidate.length > 256 * 1024) {
        return fail(400, "candidate too large (limit 256 KiB)");
      }

      const verdicts = await Promise.all(
        body.judges.map((j) => callJudge(j, body.rubric, body.candidate, body.temperature, env))
      );

      const scores = verdicts.filter((v) => typeof v.score === "number").map((v) => v.score);
      const aggregate = {
        n: scores.length,
        n_total: verdicts.length,
        mean: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
        min: scores.length ? Math.min(...scores) : null,
        max: scores.length ? Math.max(...scores) : null,
        spread: scores.length ? Math.round((Math.max(...scores) - Math.min(...scores)) * 100) / 100 : null,
      };

      return json({ ok: true, aggregate, judges: verdicts });
    }

    return fail(404, `no route: ${method} ${path}`);
  },
};
