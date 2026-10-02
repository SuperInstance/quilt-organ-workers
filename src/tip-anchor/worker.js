// worker.js — quilt-tip-anchor: external tip anchoring for every fleet
// receipt chain (wave-66). Any ledger that admits tail truncation (quilt-nn
// epoch chains, organ receipts, erised-sequencer sessions, oracle chains)
// POSTs its (chain_id, tip, seq) here; the anchor is timestamped, HMAC-signed
// by a worker secret, and stored in KV. Later, anyone can verify a tip was
// anchored at a point in time — an append-only "chain witness" that no
// single repo controls.
//
// Endpoints (Bearer WORKER_UPLOAD_TOKEN on writes, public reads):
//   POST /anchor          {chain_id, tip, seq, note?} -> anchored receipt
//   GET  /anchor/:chain_id            latest anchor for the chain
//   GET  /anchor/:chain_id/:tip       verify that tip was anchored (200/404)
//   GET  /list                        all chain_ids + latest tips (small)
//   GET  /health
//
// KV layout: anchor:<chain_id>:<seq> -> anchor row; latest:<chain_id> -> seq
// (KV is append-per-key; rows are never deleted — never-delete-data law).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const j = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 1),
        { status, headers: { "content-type": "application/json", ...cors } });

    try {
      if (url.pathname === "/health")
        return j({ status: "ready", worker: "quilt-tip-anchor", law: "append-only, fail-closed" });

      // write path: token required
      const auth = request.headers.get("authorization") ?? "";
      const tokenOk = auth === `Bearer ${env.WORKER_UPLOAD_TOKEN}`;

      if (url.pathname === "/anchor" && request.method === "POST") {
        if (!tokenOk) return j({ error: "TOKEN_REQUIRED" }, 401);
        const body = await request.json().catch(() => ({}));
        const { chain_id, tip, seq, note } = body;
        if (!chain_id || !tip || !Number.isInteger(seq))
          return j({ error: "ANCHOR_MALFORMED", need: ["chain_id", "tip", "seq:int"] }, 400);
        const at = new Date().toISOString();
        const sig = await hmacSign(env.WORKER_UPLOAD_TOKEN, `${chain_id}|${tip}|${seq}|${at}`);
        const row = { chain_id, tip, seq, at, note: note ?? "", sig };
        await env.ANCHORS.put(`anchor:${chain_id}:${seq}`, JSON.stringify(row));
        await env.ANCHORS.put(`latest:${chain_id}`, String(seq));
        await env.ANCHORS.put(`index:${chain_id}`, JSON.stringify({
          chain_id, latest_seq: seq, latest_tip: tip, at, sig }));
        return j({ anchored: true, ...row }, 201);
      }

      const m = url.pathname.match(/^\/anchor\/([^/]+)(?:\/([^/]+))?$/);
      if (m && request.method === "GET") {
        const [, chain, tipq] = m;
        const chainId = decodeURIComponent(chain);
        const latestSeq = await env.ANCHORS.get(`latest:${chainId}`);
        if (latestSeq === null)
          return j({ error: "CHAIN_UNANCHORED", chain_id: chainId }, 404);
        if (tipq) {
          const hits = [];
          let cursor;
          do {
            const page = await env.ANCHORS.list({ prefix: `anchor:${chainId}:`, cursor });
            for (const k of page.keys) {
              const row = JSON.parse(await env.ANCHORS.get(k.name));
              if (row.tip === tipq) hits.push(row);
            }
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);
          return hits.length
            ? j({ verified: true, anchors: hits })
            : j({ verified: false, error: "TIP_NOT_ANCHORED", tip: tipq }, 404);
        }
        const row = JSON.parse(await env.ANCHORS.get(`anchor:${chainId}:${latestSeq}`));
        return j({ latest: row });
      }

      if (url.pathname === "/list" && request.method === "GET") {
        const out = [];
        let cursor;
        do {
          const page = await env.ANCHORS.list({ prefix: "index:", cursor });
          for (const k of page.keys) out.push(JSON.parse(await env.ANCHORS.get(k.name)));
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return j({ chains: out, count: out.length });
      }

      return j({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      return j({ error: "ANCHOR_FAULT", detail: String(e).slice(0, 200) }, 500);
    }
  },
};

async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
