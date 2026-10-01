/**
 * organ-boot-loader — quilt-organ v1 content-addressed store (Cloudflare Worker, KV-backed)
 *
 * The principal's "saved state bootable by others", made serverless: any agent
 * anywhere can upload a quilt ORGAN bundle (manifest + state + receipt range),
 * and any other agent can boot it after verifying integrity remotely.
 *
 * Organ id = sha256hex(canonicalJSON(manifest))  → the store is content-addressed:
 *   - PUT re-derives the id server-side (client cannot choose an id)
 *   - GET serves immutable responses (ETag = id, Cache-Control immutable)
 *   - /verify recomputes stateHash + receipt chain server-side before boot
 *
 * Bindings:
 *   ORGANS               KV namespace (bundle bytes + meta records)
 *   WORKER_UPLOAD_TOKEN  secret — set via `wrangler secret put WORKER_UPLOAD_TOKEN`
 *                        (value recorded only in gitignored .env.keys, never here)
 *
 * Schema quilt.organ.v1 (see README.md for the full contract):
 * {
 *   "schemaVersion": "quilt.organ.v1",
 *   "manifest": {
 *     "name": str,
 *     "cells": [ {id, kind, ...}, ... ],          // required non-empty array
 *     "receiptRange": [ digest, ... ],            // required array of receipt digests
 *     "stateHash": sha256hex(canonicalJSON(state)),// required, 64 hex
 *     "createdAt": iso8601, "author": str
 *   },
 *   "state": { "cells": {...}, ... },
 *   "receipts": [ {seq, op, cell, prev, payload, digest}, ... ]  // digest = sha256hex(canon(minus digest)), chained by prev
 * }
 */

const SCHEMA_VERSION = "quilt.organ.v1";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB guard (KV value limit is 25 MiB; keep boots lean)
const LIST_LIMIT = 64;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-quilt-token",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function fail(status, reason, extraHeaders = {}) {
  return json({ ok: false, error: reason }, status, extraHeaders);
}

/** Canonical JSON: recursive key-sorted serialization. Identical algorithm in
 *  fixture/make-greeter-organ.mjs and any conforming client. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

async function sha256hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Auth: Authorization: Bearer <token> or x-quilt-token: <token>. Compares
 *  digests (length-independent), never logs or reflects the token. */
async function authOk(request, env) {
  if (!env || !env.WORKER_UPLOAD_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = (request.headers.get("x-quilt-token") || "").trim();
  const presented = bearer || alt;
  if (!presented) return false;
  const a = await sha256hex(presented);
  const b = await sha256hex(env.WORKER_UPLOAD_TOKEN);
  return a === b;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function validateManifestShape(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return "manifest must be an object";
  }
  if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) {
    return "manifest.cells must be a non-empty array";
  }
  for (const c of manifest.cells) {
    if (typeof c !== "object" || c === null || typeof c.id !== "string" || c.id === "") {
      return "every manifest.cells[] entry must be an object with a non-empty string id";
    }
  }
  if (!Array.isArray(manifest.receiptRange) || manifest.receiptRange.length === 0) {
    return "manifest.receiptRange must be a non-empty array of receipt digests";
  }
  if (typeof manifest.stateHash !== "string" || !SHA256_RE.test(manifest.stateHash)) {
    return "manifest.stateHash must be a 64-hex sha256 of canonicalJSON(state)";
  }
  return null;
}

/** Receipt chain: receipts[i].digest = sha256(canon({seq,op,cell,prev,payload})),
 *  receipts[0].prev = "genesis", receipts[i].prev = receipts[i-1].digest.
 *  Recomputes every digest server-side (full re-derivation, not just linkage).
 *  Returns null if chain is sound, else a reason string. */
async function checkReceiptChain(receipts, receiptRange) {
  if (receipts.length !== receiptRange.length) {
    return `receipts.length (${receipts.length}) != manifest.receiptRange.length (${receiptRange.length})`;
  }
  let prev = "genesis";
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (typeof r !== "object" || r === null) return `receipts[${i}] is not an object`;
    if (r.prev !== prev) return `receipts[${i}].prev does not link to ${prev}`;
    const { digest, ...rest } = r;
    if (typeof digest !== "string" || !SHA256_RE.test(digest)) {
      return `receipts[${i}].digest is not 64-hex`;
    }
    if (JSON.stringify(rest.seq) === "undefined") return `receipts[${i}].seq missing`;
    if (rest.seq !== i + 1) return `receipts[${i}].seq out of order (expected ${i + 1})`;
    const recomputed = await sha256hex(canonical(rest));
    if (recomputed !== digest) {
      return `receipts[${i}] digest mismatch: recomputed ${recomputed}, stored ${digest}`;
    }
    if (receiptRange[i] !== digest) return `receipts[${i}].digest != manifest.receiptRange[${i}]`;
    prev = digest;
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ---- GET / → service index -------------------------------------------------
    if (method === "GET" && (path === "/" || path === "")) {
      return json({
        service: "organ-boot-loader",
        schema: SCHEMA_VERSION,
        store: "content-addressed (organ id = sha256hex(canonicalJSON(manifest)))",
        endpoints: {
          "GET /organs": "list uploaded organ bundle ids with schema version + cell count",
          "GET /organ/{sha256}": "serve the organ bundle JSON (manifest + state + receipts); ETag + x-quilt-organ-sha256 headers; immutable cache",
          "GET /organ/{sha256}/verify": "recompute stateHash + receipt chain server-side → {bootable, reason} — check before booting",
          "PUT /organ": "upload a bundle; auth via Authorization: Bearer <WORKER_UPLOAD_TOKEN> or x-quilt-token; server-side schema + hash validation",
        },
        cors: "open — any agent anywhere can boot organs",
      });
    }

    // ---- GET /organs → list ----------------------------------------------------
    if (method === "GET" && path === "/organs") {
      const list = await env.ORGANS.list({ prefix: "meta:", limit: LIST_LIMIT });
      const organs = [];
      for (const key of list.keys) {
        const meta = await env.ORGANS.get(key.name, { type: "json" });
        if (meta) {
          organs.push({
            id: meta.id,
            schemaVersion: meta.schemaVersion,
            cellCount: meta.cellCount,
            receiptCount: meta.receiptCount,
            name: meta.name,
            stateHash: meta.stateHash,
            byteSize: meta.byteSize,
            uploadedAt: meta.uploadedAt,
          });
        }
      }
      return json({ ok: true, count: organs.length, organs });
    }

    // ---- PUT /organ → validate + store ------------------------------------------
    if (method === "PUT" && (path === "/organ" || path === "/organ/")) {
      if (!(await authOk(request, env))) {
        return fail(401, "unauthorized — present WORKER_UPLOAD_TOKEN via 'Authorization: Bearer <token>' or 'x-quilt-token'");
      }
      const declared = Number(request.headers.get("content-length") || "0");
      if (declared > MAX_BODY_BYTES) {
        return fail(413, `body too large (${declared} bytes; limit ${MAX_BODY_BYTES})`);
      }
      let bodyText;
      try {
        bodyText = await request.text();
      } catch {
        return fail(400, "could not read request body");
      }
      if (bodyText.length > MAX_BODY_BYTES) {
        return fail(413, `body too large (${bodyText.length} bytes; limit ${MAX_BODY_BYTES})`);
      }
      let bundle;
      try {
        bundle = JSON.parse(bodyText);
      } catch (e) {
        return fail(400, `body is not valid JSON: ${e.message}`);
      }
      if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
        return fail(400, "bundle must be a JSON object");
      }
      if (bundle.schemaVersion !== SCHEMA_VERSION) {
        return fail(400, `unsupported schemaVersion: expected "${SCHEMA_VERSION}", got ${JSON.stringify(bundle.schemaVersion ?? null)}`);
      }
      const shapeErr = validateManifestShape(bundle.manifest);
      if (shapeErr) return fail(400, `manifest invalid: ${shapeErr}`);

      // stateHash must match sha256(canonicalJSON(state)) — server recomputes, no trust
      if (typeof bundle.state !== "object" || bundle.state === null) {
        return fail(400, "bundle.state must be an object");
      }
      const recomputedStateHash = await sha256hex(canonical(bundle.state));
      if (recomputedStateHash !== bundle.manifest.stateHash) {
        return fail(400, `stateHash mismatch: manifest says ${bundle.manifest.stateHash}, sha256(canonicalJSON(state)) is ${recomputedStateHash}`);
      }

      // Receipt chain (if receipts are included in the bundle, they must be sound)
      if (bundle.receipts !== undefined) {
        if (!Array.isArray(bundle.receipts)) return fail(400, "bundle.receipts must be an array when present");
        const chainErr = await checkReceiptChain(bundle.receipts, bundle.manifest.receiptRange);
        if (chainErr) return fail(400, `receipt chain invalid: ${chainErr}`);
      }

      // Content-addressed id — derived server-side from the manifest bytes
      const id = await sha256hex(canonical(bundle.manifest));

      const now = new Date().toISOString();
      const envelope = {
        schemaVersion: SCHEMA_VERSION,
        id,
        name: bundle.manifest.name ?? "unnamed",
        cellCount: bundle.manifest.cells.length,
        receiptCount: bundle.manifest.receiptRange.length,
        stateHash: bundle.manifest.stateHash,
        uploadedAt: now,
        bundle,
      };
      const meta = {
        id,
        schemaVersion: SCHEMA_VERSION,
        name: envelope.name,
        cellCount: envelope.cellCount,
        receiptCount: envelope.receiptCount,
        stateHash: envelope.stateHash,
        byteSize: bodyText.length,
        uploadedAt: now,
      };
      // Content-addressed → identical re-upload is idempotent, not a conflict
      const existing = await env.ORGANS.get(`organ:${id}`, { type: "json" });
      if (existing) {
        await env.ORGANS.put(`meta:${id}`, JSON.stringify(meta));
        return json({ ok: true, stored: false, alreadyExisted: true, id, verifyPath: `/organ/${id}/verify` }, 200);
      }
      await env.ORGANS.put(`organ:${id}`, JSON.stringify(envelope));
      await env.ORGANS.put(`meta:${id}`, JSON.stringify(meta));
      return json(
        {
          ok: true,
          stored: true,
          id,
          cellCount: envelope.cellCount,
          receiptCount: envelope.receiptCount,
          stateHash: envelope.stateHash,
          paths: { bundle: `/organ/${id}`, verify: `/organ/${id}/verify` },
        },
        201,
        { etag: `"${id}"` }
      );
    }

    // ---- GET /organ/{sha256}[/verify] -------------------------------------------
    const organMatch = path.match(/^\/organ\/([a-f0-9]{64})(\/verify)?$/);
    if (organMatch && (method === "GET" || method === "HEAD")) {
      const id = organMatch[1];
      const wantVerify = Boolean(organMatch[2]);
      const raw = await env.ORGANS.get(`organ:${id}`);
      if (!raw) {
        return fail(404, `no organ with id ${id} in this store`);
      }
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch (e) {
        return fail(500, `stored envelope corrupt: ${e.message}`);
      }
      const bundle = envelope.bundle;
      const commonHeaders = {
        etag: `"${id}"`,
        "x-quilt-organ-sha256": id,
        "cache-control": "public, max-age=31536000, immutable",
      };

      if (wantVerify) {
        // Boot-readiness: recompute everything server-side, trust nothing on arrival
        const checks = {};
        checks.manifestDigestMatchesId = (await sha256hex(canonical(bundle.manifest))) === id;
        checks.stateHashMatchesState =
          (await sha256hex(canonical(bundle.state))) === (bundle.manifest && bundle.manifest.stateHash);
        let receiptReason = null;
        if (Array.isArray(bundle.receipts)) {
          receiptReason = await checkReceiptChain(bundle.receipts, bundle.manifest.receiptRange);
        }
        checks.receiptChain = receiptReason === null;
        const bootable =
          checks.manifestDigestMatchesId && checks.stateHashMatchesState && checks.receiptChain;
        let reason;
        if (bootable) {
          reason =
            "manifest digest == id; sha256(canonicalJSON(state)) == manifest.stateHash; every receipt digest re-derives and the chain links genesis→tip matching receiptRange";
        } else if (!checks.manifestDigestMatchesId) {
          reason = "manifest digest mismatch: stored manifest no longer hashes to the addressed id";
        } else if (!checks.stateHashMatchesState) {
          reason = "stateHash mismatch: stored state does not hash to manifest.stateHash";
        } else {
          reason = `receipt chain invalid: ${receiptReason}`;
        }
        return json(
          {
            ok: true,
            bootable,
            reason,
            checks: { ...checks, receiptReason },
            id,
            schemaVersion: envelope.schemaVersion,
            cellCount: envelope.cellCount,
            receiptCount: envelope.receiptCount,
          },
          200,
          commonHeaders
        );
      }

      return new Response(JSON.stringify(bundle, null, 2) + "\n", {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...CORS_HEADERS,
          ...commonHeaders,
        },
      });
    }

    if (path.startsWith("/organ") || path === "/organs") {
      return fail(404, `no route: ${method} ${path}`);
    }
    return fail(404, `no route: ${method} ${path}`);
  },
};
