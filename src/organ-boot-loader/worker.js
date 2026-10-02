/**
 * organ-boot-loader — quilt organ content-addressed store (Cloudflare Worker, KV-backed)
 *
 * The principal's "saved state bootable by others", made serverless: any agent
 * anywhere can upload a quilt ORGAN bundle (manifest + state + receipts),
 * and any other agent can boot it after verifying integrity remotely.
 *
 * Organ id = sha256hex(canonicalJSON(manifest))  → the store is content-addressed:
 *   - PUT re-derives the id server-side (client cannot choose an id)
 *   - GET serves immutable responses (ETag = id, Cache-Control immutable)
 *   - /verify recomputes every commitment server-side before boot
 *
 * Bindings:
 *   ORGANS               KV namespace (bundle bytes + meta records)
 *   WORKER_UPLOAD_TOKEN  secret — set via `wrangler secret put WORKER_UPLOAD_TOKEN`
 *                        (value recorded only in gitignored .env.keys, never here)
 *
 * DIALECTS (L15 unification — registered in schema/organ-manifest.v1.json):
 *   canonical  "quilt.organ.manifest/v1"  bundle.schema carries the string; manifest
 *             body is the quilt-jev-toolkit manifest law verbatim (manifestHash
 *             self-cover, per-cell stateHash, receiptRange {start,end,count},
 *             GENESIS-anchored 0-based receipt chain with hash = sha256 of
 *             canonical {seq, op, prev}, op an OBJECT carrying all effect content);
 *             plus the registered whole-state commitment manifest.stateHash.
 *   legacy     "quilt.organ.v1"  bundle.schemaVersion carries the string (worker
 *             original). STILL ACCEPTED during transition; every response to a
 *             legacy-dialect PUT carries header `x-quilt-schema-deprecated`.
 *   /verify ALWAYS reports which dialect the stored organ was served as (`dialect`).
 *
 * Canonical bundle shape (see schema/organ-manifest.v1.json for the full contract):
 * {
 *   "schema": "quilt.organ.manifest/v1",
 *   "manifest": {
 *     "schema": "quilt.organ.manifest", "schemaVersion": 1,
 *     "organId": "name@16hex", "name": str,
 *     "cells": [ {id, kind, stateHash, ...}, ... ],     // non-empty, unique ids
 *     "edges": [ {from, to}, ... ],
 *     "receiptRange": {start, end, count},
 *     "genesis": {seq, prevHash},                        // seq 0 → prevHash "GENESIS"
 *     "state": { "cellsSha256": hex64 },                 // sha256(canonicalJSON(state.cells))
 *     "stateHash": hex64,                                // sha256(canonicalJSON(state)) — whole state
 *     "supersedes": null | hex64,
 *     "manifestHash": hex64                              // sha256(canonicalJSON(manifest minus manifestHash))
 *   },
 *   "state": { "cells": {...}, ... },
 *   "receipts": [ {seq, op:{type, ...}, prev, hash}, ... ]  // hash = sha256(canonicalJSON({seq, op, prev}))
 * }
 *
 * Validation logic is exported (named exports) so scripts/validate-dialect.mjs
 * runs the EXACT production code against the shared fixture — one dialect, one
 * law, both implementations.
 */

export const CANONICAL_SCHEMA = "quilt.organ.manifest/v1";
export const LEGACY_SCHEMA = "quilt.organ.v1";
const MANIFEST_SCHEMA = "quilt.organ.manifest";
const GENESIS = "GENESIS";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB guard (KV value limit is 25 MiB; keep boots lean)
const LIST_LIMIT = 64;

const DEPRECATION_NOTE =
  `legacy dialect ${LEGACY_SCHEMA} is accepted during transition; the canonical dialect is ${CANONICAL_SCHEMA} (schema/organ-manifest.v1.json in SuperInstance/quilt-organ-workers)`;

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

/** Canonical JSON — THE registered law (identical to quilt-jev-toolkit
 *  canonicalJson on every JSON-representable value; proven by the
 *  cross-canonicalizer battery in scripts/validate-dialect.mjs).
 *  Recursive key-sorted serialization; FAIL-CLOSED on values with no stable
 *  JSON meaning: undefined, NaN/Infinity, bigint, function, symbol. */
export function canonical(value, _path = "$") {
  if (value === undefined) {
    throw new TypeError(`canonical: undefined at ${_path} (fail-closed; JSON has no stable meaning for undefined)`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonical: non-finite number at ${_path}`);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new TypeError(`canonical: bigint at ${_path} (v1 refuses; serialize explicitly as string)`);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonical: ${typeof value} at ${_path} is not serializable (fail-closed)`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonical(v, `${_path}[${i}]`)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k], `${_path}.${k}`)).join(",") + "}";
}

export async function sha256hex(str) {
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
const ORGAN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}@[0-9a-f]{16}$/;

/** Which dialect does this bundle speak? (exported for the harness + /verify) */
export function detectDialect(bundle) {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) return null;
  if (bundle.schema === CANONICAL_SCHEMA) return CANONICAL_SCHEMA;
  if (bundle.schemaVersion === LEGACY_SCHEMA) return LEGACY_SCHEMA;
  return null;
}

// ---------------------------------------------------------------------------
// LEGACY dialect (quilt.organ.v1) — kept for transition, deprecated
// ---------------------------------------------------------------------------

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

/** Legacy receipt chain: receipts[i].digest = sha256(canon({seq,op,cell,prev,payload})),
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

// ---------------------------------------------------------------------------
// CANONICAL dialect (quilt.organ.manifest/v1) — the registered law
// ---------------------------------------------------------------------------

/** Canonical receipt chain — the toolkit's verifyChain law:
 *  receipts[i] = {seq, op (object, non-empty type), prev, hash};
 *  hash = sha256(canon({seq, op, prev})); receipts[0].prev = genesis.prevHash;
 *  receipts[i].prev = receipts[i-1].hash; seq = receiptRange.start + i;
 *  a present chain must be the FULL window (length == receiptRange.count).
 *  Returns null if sound, else a reason string. */
export async function checkCanonicalReceiptChain(receipts, manifest) {
  const rr = manifest.receiptRange;
  if (receipts.length !== rr.count) {
    return `receipts.length (${receipts.length}) != manifest.receiptRange.count (${rr.count}) — a bootable organ carries its full window`;
  }
  let expectedPrev = manifest.genesis.prevHash;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      return `receipts[${i}] is not an object`;
    }
    if (r.seq !== rr.start + i) {
      return `receipts[${i}].seq discontinuity: expected ${rr.start + i}, got ${JSON.stringify(r.seq ?? null)}`;
    }
    if (r.prev !== expectedPrev) {
      return `receipts[${i}].prev does not link to ${expectedPrev}`;
    }
    if (typeof r.op !== "object" || r.op === null || Array.isArray(r.op) || typeof r.op.type !== "string" || r.op.type === "") {
      return `receipts[${i}].op must be an object with a non-empty string type`;
    }
    if (typeof r.hash !== "string" || !SHA256_RE.test(r.hash)) {
      return `receipts[${i}].hash is not 64-hex`;
    }
    const recomputed = await sha256hex(canonical({ seq: r.seq, op: r.op, prev: r.prev }));
    if (recomputed !== r.hash) {
      return `receipts[${i}] hash mismatch: recomputed ${recomputed}, stored ${r.hash}`;
    }
    expectedPrev = r.hash;
  }
  return null;
}

/** Full canonical-dialect validation (the same law the toolkit's
 *  validateManifest + verifyChain + computeManifestHash enforce, plus the
 *  registered whole-state commitment). Returns {ok, errors:[{code, detail}]}.
 *  Exported so the harness runs the EXACT production code. */
export async function validateCanonicalBundle(bundle) {
  const errors = [];
  const bad = (code, detail) => errors.push({ code, detail });

  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    return { ok: false, errors: [{ code: "MANIFEST_INVALID", detail: "bundle must be a JSON object" }] };
  }
  const manifest = bundle.manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { ok: false, errors: [{ code: "MANIFEST_INVALID", detail: "manifest must be an object" }] };
  }

  // --- toolkit manifest law (mirrors validateManifest field-for-field) ---
  if (manifest.schema !== MANIFEST_SCHEMA) {
    bad("SCHEMA_DRIFT", `manifest.schema ${JSON.stringify(manifest.schema ?? null)} !== ${MANIFEST_SCHEMA}`);
  }
  if (manifest.schemaVersion !== 1) {
    bad("SCHEMA_DRIFT", `manifest.schemaVersion ${JSON.stringify(manifest.schemaVersion ?? null)} !== 1`);
  }
  if (errors.some((e) => e.code === "SCHEMA_DRIFT")) {
    return { ok: false, errors }; // drift: refuse before interpreting fields
  }
  if (typeof manifest.organId !== "string" || !ORGAN_ID_RE.test(manifest.organId)) {
    bad("MANIFEST_INVALID", `organId must match name@16hex, got ${JSON.stringify(manifest.organId ?? null)}`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    bad("MANIFEST_INVALID", "name must be a non-empty string");
  }

  const cellIds = new Set();
  const cells = manifest.cells;
  if (!Array.isArray(cells) || cells.length === 0) {
    bad("MANIFEST_INVALID", "cells must be a non-empty array");
  } else {
    for (const c of cells) {
      if (typeof c !== "object" || c === null || Array.isArray(c) || typeof c.id !== "string" || c.id === "") {
        bad("MANIFEST_INVALID", "cell entry missing id"); continue;
      }
      if (cellIds.has(c.id)) bad("MANIFEST_INVALID", `duplicate cell id ${c.id}`);
      cellIds.add(c.id);
      if (typeof c.kind !== "string" || c.kind === "") bad("MANIFEST_INVALID", `cell ${c.id} missing kind`);
      if (typeof c.stateHash !== "string" || !SHA256_RE.test(c.stateHash)) {
        bad("MANIFEST_INVALID", `cell ${c.id} stateHash not sha256 hex`);
      }
    }
  }
  if (!Array.isArray(manifest.edges)) {
    bad("MANIFEST_INVALID", "edges must be an array");
  } else {
    for (const e of manifest.edges) {
      if (typeof e !== "object" || e === null || Array.isArray(e) || typeof e.from !== "string" || typeof e.to !== "string") {
        bad("MANIFEST_INVALID", "edge must be {from,to}"); continue;
      }
      if (!cellIds.has(e.from)) bad("MANIFEST_INVALID", `edge.from ${e.from} is not a known cell`);
      if (!cellIds.has(e.to)) bad("MANIFEST_INVALID", `edge.to ${e.to} is not a known cell`);
    }
  }

  const rr = manifest.receiptRange;
  if (typeof rr !== "object" || rr === null || Array.isArray(rr) ||
      !Number.isInteger(rr.start) || !Number.isInteger(rr.end) || !Number.isInteger(rr.count)) {
    bad("MANIFEST_INVALID", "receiptRange must be {start:int, end:int, count:int}");
  } else if (rr.start < 0 || rr.end < rr.start || rr.count !== rr.end - rr.start + 1) {
    bad("MANIFEST_INVALID", `receiptRange inconsistent: start=${rr.start} end=${rr.end} count=${rr.count}`);
  }

  const g = manifest.genesis;
  if (typeof g !== "object" || g === null || Array.isArray(g) ||
      !Number.isInteger(g.seq) || g.seq < 0 || typeof g.prevHash !== "string" || g.prevHash === "") {
    bad("MANIFEST_INVALID", "genesis must be {seq:int>=0, prevHash:string}");
  } else if (rr && Number.isInteger(rr.start) && g.seq !== rr.start) {
    bad("MANIFEST_INVALID", `genesis.seq ${g.seq} must equal receiptRange.start ${rr.start}`);
  } else if (g.seq === 0 && g.prevHash !== GENESIS) {
    bad("MANIFEST_INVALID", `genesis at seq 0 must anchor to ${GENESIS}, got ${JSON.stringify(g.prevHash)}`);
  } else if (g.seq > 0 && !SHA256_RE.test(g.prevHash)) {
    bad("MANIFEST_INVALID", "genesis.prevHash for seq>0 must be a sha256 checkpoint hash");
  }

  const mstate = manifest.state;
  if (typeof mstate !== "object" || mstate === null || Array.isArray(mstate) ||
      typeof mstate?.cellsSha256 !== "string" || !SHA256_RE.test(mstate?.cellsSha256 ?? "")) {
    bad("MANIFEST_INVALID", "state.cellsSha256 must be sha256 hex");
  }

  if (manifest.supersedes !== null && (typeof manifest.supersedes !== "string" || !SHA256_RE.test(manifest.supersedes))) {
    bad("MANIFEST_INVALID", "supersedes must be null or a sha256 manifestHash");
  }

  if (typeof manifest.manifestHash !== "string" || !SHA256_RE.test(manifest.manifestHash)) {
    bad("MANIFEST_INVALID", "manifestHash missing or not sha256 hex");
  } else {
    const { manifestHash: _ignored, ...rest } = manifest;
    const recomputed = await sha256hex(canonical(rest));
    if (recomputed !== manifest.manifestHash) {
      bad("MANIFESTHASH_MISMATCH", `manifestHash self-cover broken: recomputed ${recomputed}, carried ${manifest.manifestHash}`);
    }
  }

  // --- registered extension: WHOLE-state commitment (worker heritage) ---
  if (typeof manifest.stateHash !== "string" || !SHA256_RE.test(manifest.stateHash)) {
    bad("MANIFEST_INVALID", "stateHash (whole-state commitment) missing or not sha256 hex");
  }
  if (typeof bundle.state !== "object" || bundle.state === null || Array.isArray(bundle.state)) {
    bad("STATE_INVALID", "bundle.state must be an object");
  } else {
    if (typeof manifest.stateHash === "string" && SHA256_RE.test(manifest.stateHash)) {
      const wholeHash = await sha256hex(canonical(bundle.state));
      if (wholeHash !== manifest.stateHash) {
        bad("STATEHASH_MISMATCH", `stateHash mismatch: manifest says ${manifest.stateHash}, sha256(canonicalJSON(state)) is ${wholeHash}`);
      }
    }
    // --- cells-map commitment (toolkit heritage) + per-cell commitments ---
    const stateCells = bundle.state.cells;
    if (typeof stateCells !== "object" || stateCells === null || Array.isArray(stateCells)) {
      bad("STATE_INVALID", "bundle.state.cells must be an object map keyed by cell id");
    } else {
      if (typeof mstate?.cellsSha256 === "string" && SHA256_RE.test(mstate.cellsSha256)) {
        const cellsHash = await sha256hex(canonical(stateCells));
        if (cellsHash !== mstate.cellsSha256) {
          bad("CELLSSHA256_MISMATCH", `cellsSha256 mismatch: manifest says ${mstate.cellsSha256}, sha256(canonicalJSON(state.cells)) is ${cellsHash}`);
        }
      }
      if (Array.isArray(cells)) {
        for (const c of cells) {
          if (typeof c?.id !== "string" || c.id === "") continue;
          if (!Object.prototype.hasOwnProperty.call(stateCells, c.id)) {
            bad("CELL_STATE_MISSING", `state.cells missing entry for cell id ${c.id} (bootable organs carry their cells' state)`);
          } else if (typeof c.stateHash === "string" && SHA256_RE.test(c.stateHash)) {
            const cellHash = await sha256hex(canonical(stateCells[c.id]));
            if (cellHash !== c.stateHash) {
              bad("CELL_STATEHASH_MISMATCH", `cell ${c.id} stateHash mismatch: manifest says ${c.stateHash}, sha256(canonicalJSON(state.cells["${c.id}"])) is ${cellHash}`);
            }
          }
        }
      }
    }
  }

  // --- receipt chain (toolkit law), verified when present ---
  if (bundle.receipts !== undefined) {
    if (!Array.isArray(bundle.receipts)) {
      bad("RECEIPT_INVALID", "bundle.receipts must be an array when present");
    } else if (rr && Number.isInteger(rr.count)) {
      const chainErr = await checkCanonicalReceiptChain(bundle.receipts, manifest);
      if (chainErr) bad("RECEIPT_INVALID", chainErr);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

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
        dialects: {
          canonical: CANONICAL_SCHEMA,
          deprecated: { schemaVersion: LEGACY_SCHEMA, deprecationHeader: "x-quilt-schema-deprecated", status: "accepted-during-transition" },
          schemaDoc: "schema/organ-manifest.v1.json in SuperInstance/quilt-organ-workers (L15 unification registration)",
        },
        schema: CANONICAL_SCHEMA,
        store: "content-addressed (organ id = sha256hex(canonicalJSON(manifest)))",
        endpoints: {
          "GET /organs": "list uploaded organ bundle ids with schema version + cell count",
          "GET /organ/{sha256}": "serve the organ bundle JSON (manifest + state + receipts); ETag + x-quilt-organ-sha256 headers; immutable cache",
          "GET /organ/{sha256}/verify": "recompute every commitment server-side → {bootable, reason, dialect} — check before booting",
          "PUT /organ": "upload a bundle (canonical dialect quilt.organ.manifest/v1; legacy quilt.organ.v1 accepted during transition); auth via Authorization: Bearer <WORKER_UPLOAD_TOKEN> or x-quilt-token; server-side schema + hash validation",
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
      const dialect = detectDialect(bundle);
      if (dialect === null) {
        return fail(
          400,
          `unsupported schema dialect: expected "${CANONICAL_SCHEMA}" (bundle.schema) or legacy "${LEGACY_SCHEMA}" (bundle.schemaVersion), got neither — see schema/organ-manifest.v1.json`
        );
      }
      const legacyHeaders = dialect === LEGACY_SCHEMA ? { "x-quilt-schema-deprecated": LEGACY_SCHEMA } : {};
      const canonicalHeaders = dialect === CANONICAL_SCHEMA ? { "x-quilt-schema": CANONICAL_SCHEMA } : {};
      const dialectHeaders = { ...legacyHeaders, ...canonicalHeaders };

      let manifest, stateHashField, cellCount, receiptCount;
      if (dialect === CANONICAL_SCHEMA) {
        const { ok, errors } = await validateCanonicalBundle(bundle);
        if (!ok) {
          return fail(400, `canonical bundle invalid: ${errors.map((e) => `${e.code}: ${e.detail}`).join("; ")}`, dialectHeaders);
        }
        manifest = bundle.manifest;
        stateHashField = manifest.stateHash;
        cellCount = manifest.cells.length;
        receiptCount = manifest.receiptRange.count;
      } else {
        // legacy path — same law as the original worker, unchanged
        const shapeErr = validateManifestShape(bundle.manifest);
        if (shapeErr) return fail(400, `manifest invalid: ${shapeErr}`, dialectHeaders);
        if (typeof bundle.state !== "object" || bundle.state === null) {
          return fail(400, "bundle.state must be an object", dialectHeaders);
        }
        const recomputedStateHash = await sha256hex(canonical(bundle.state));
        if (recomputedStateHash !== bundle.manifest.stateHash) {
          return fail(400, `stateHash mismatch: manifest says ${bundle.manifest.stateHash}, sha256(canonicalJSON(state)) is ${recomputedStateHash}`, dialectHeaders);
        }
        if (bundle.receipts !== undefined) {
          if (!Array.isArray(bundle.receipts)) return fail(400, "bundle.receipts must be an array when present", dialectHeaders);
          const chainErr = await checkReceiptChain(bundle.receipts, bundle.manifest.receiptRange);
          if (chainErr) return fail(400, `receipt chain invalid: ${chainErr}`, dialectHeaders);
        }
        manifest = bundle.manifest;
        stateHashField = manifest.stateHash;
        cellCount = manifest.cells.length;
        receiptCount = manifest.receiptRange.length;
      }

      // Content-addressed id — derived server-side from the manifest bytes
      const id = await sha256hex(canonical(manifest));

      const now = new Date().toISOString();
      const envelope = {
        schemaVersion: dialect,
        id,
        name: manifest.name ?? "unnamed",
        cellCount,
        receiptCount,
        stateHash: stateHashField,
        uploadedAt: now,
        bundle,
      };
      const meta = {
        id,
        schemaVersion: dialect,
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
        return json(
          { ok: true, stored: false, alreadyExisted: true, id, dialect, verifyPath: `/organ/${id}/verify`, ...(dialect === LEGACY_SCHEMA ? { deprecation: DEPRECATION_NOTE } : {}) },
          200,
          dialectHeaders
        );
      }
      await env.ORGANS.put(`organ:${id}`, JSON.stringify(envelope));
      await env.ORGANS.put(`meta:${id}`, JSON.stringify(meta));
      return json(
        {
          ok: true,
          stored: true,
          id,
          dialect,
          cellCount: envelope.cellCount,
          receiptCount: envelope.receiptCount,
          stateHash: envelope.stateHash,
          paths: { bundle: `/organ/${id}`, verify: `/organ/${id}/verify` },
          ...(dialect === LEGACY_SCHEMA ? { deprecation: DEPRECATION_NOTE } : {}),
        },
        201,
        { etag: `"${id}"`, ...dialectHeaders }
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
      const dialect = detectDialect(bundle) ?? envelope.schemaVersion ?? "unknown";
      const commonHeaders = {
        etag: `"${id}"`,
        "x-quilt-organ-sha256": id,
        "x-quilt-schema": dialect,
        "cache-control": "public, max-age=31536000, immutable",
        ...(dialect === LEGACY_SCHEMA ? { "x-quilt-schema-deprecated": LEGACY_SCHEMA } : {}),
      };

      if (wantVerify) {
        // Boot-readiness: recompute everything server-side, trust nothing on arrival
        const checks = {};
        checks.manifestDigestMatchesId = (await sha256hex(canonical(bundle.manifest))) === id;
        checks.stateHashMatchesState =
          (await sha256hex(canonical(bundle.state))) === (bundle.manifest && bundle.manifest.stateHash);
        let receiptReason = null;
        const firstDetail = (code) => recheckErrs.find((e) => e.code === code)?.detail ?? null;
        let recheckErrs = [];
        if (dialect === CANONICAL_SCHEMA) {
          // canonical: full law re-derivation (delegates to the exported validator)
          const recheck = await validateCanonicalBundle(bundle);
          recheckErrs = recheck.errors;
          checks.manifestHashSelfCover = !recheckErrs.some((e) => e.code === "MANIFESTHASH_MISMATCH");
          checks.cellsSha256MatchesState = !recheckErrs.some((e) => e.code === "CELLSSHA256_MISMATCH");
          checks.perCellStateHashes = !recheckErrs.some(
            (e) => e.code === "CELL_STATEHASH_MISMATCH" || e.code === "CELL_STATE_MISSING"
          );
          if (!Array.isArray(bundle.receipts)) {
            checks.receiptChain = true; // receipts optional in both dialects; verified when present
          }
          const chainErrs = recheckErrs.filter((e) => e.code === "RECEIPT_INVALID");
          if (chainErrs.length > 0) receiptReason = chainErrs.map((e) => e.detail).join("; ");
        } else {
          if (Array.isArray(bundle.receipts)) {
            receiptReason = await checkReceiptChain(bundle.receipts, bundle.manifest.receiptRange);
          }
        }
        if (!("receiptChain" in checks)) checks.receiptChain = receiptReason === null;
        const bootable =
          checks.manifestDigestMatchesId && checks.stateHashMatchesState && checks.receiptChain &&
          checks.manifestHashSelfCover !== false && checks.cellsSha256MatchesState !== false && checks.perCellStateHashes !== false;
        let reason;
        if (bootable) {
          reason =
            dialect === CANONICAL_SCHEMA
              ? "manifest digest == id; manifestHash self-cover holds; sha256(canonicalJSON(state)) == manifest.stateHash; sha256(canonicalJSON(state.cells)) == state.cellsSha256; every cell stateHash re-derives; receipt chain links GENESIS→tip with every hash re-derived (toolkit law)"
              : "manifest digest == id; sha256(canonicalJSON(state)) == manifest.stateHash; every receipt digest re-derives and the chain links genesis→tip matching receiptRange";
        } else if (!checks.manifestDigestMatchesId) {
          reason = "manifest digest mismatch: stored manifest no longer hashes to the addressed id";
        } else if (checks.manifestHashSelfCover === false) {
          reason = firstDetail("MANIFESTHASH_MISMATCH") ?? "manifest no longer hashes to its carried manifestHash";
        } else if (checks.cellsSha256MatchesState === false) {
          reason = firstDetail("CELLSSHA256_MISMATCH") ?? "stored state.cells does not hash to manifest.state.cellsSha256";
        } else if (checks.perCellStateHashes === false) {
          reason = firstDetail("CELL_STATEHASH_MISMATCH") ?? firstDetail("CELL_STATE_MISSING") ?? "a stored cell state no longer hashes to its manifest claim";
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
            dialect,
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
