#!/usr/bin/env node
/**
 * make-organ-manifest-fixture.mjs — deterministic CANONICAL quilt.organ.manifest/v1 fixture.
 *
 * This is the greeter organ from receipts/DEPLOYMENT.md (2 cells / 3 EFFECT receipts:
 * "hello quilt" / "hello organ" / "hello quilt-organ") re-expressed in the canonical
 * dialect registered in schema/organ-manifest.v1.json (L15 dialect unification).
 * The legacy-dialect fixture fixture/greeter-organ.json stays untouched as the
 * transition exemplar.
 *
 * Canonical laws used here (identical to quilt-jev-toolkit canonicalJson — the
 * toolkit's unmodified validateManifest/computeManifestHash/verifyChain accept the
 * emitted fixture, proven by scripts/validate-dialect.mjs):
 *   - canonical JSON: recursive key-sorted, no whitespace, fail-closed on
 *     undefined / NaN / Infinity / bigint / function / symbol
 *   - manifestHash = sha256(canonicalJSON(manifest minus manifestHash))
 *   - receipt hash = sha256(canonicalJSON({seq, op, prev})), GENESIS-anchored,
 *     0-based seq, all effect content inside op
 *   - organId = name@16hex, 16hex = sha256(canonicalJSON({name, material})).slice(0,16)
 *     with material = the whole-state hash (registered binding)
 *   - store content address (organ id) = sha256(canonicalJSON(manifest)) — derived
 *     server-side by the organ-boot-loader, printed here only for cross-checking
 *
 * Usage: node fixture/make-organ-manifest-fixture.mjs > fixture/organ-manifest-v1.json
 * Emits the bundle JSON on stdout and a hash summary on stderr. Deterministic:
 * fixed createdAt so committed fixture bytes are stable.
 */
import { createHash } from "node:crypto";

function canonical(value, _path = "$") {
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
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sha256Json = (v) => sha256hex(canonical(v));

const createdAt = "2026-10-02T00:00:00Z";

// ---- state: same cell contents as the legacy greeter fixture (2 cells, 3 emitted) ----
const state = {
  cells: {
    "greet-0": { greetings: 2, last: "quilt" },
    "greet-1": { greetings: 1, last: "organ" },
  },
  emitted: 3,
};

// ---- receipts: toolkit receipt law — seq 0-based, op OBJECT carries all content,
// ---- GENESIS anchor, hash = sha256(canonical({seq, op, prev})) ----
const receiptsRaw = [
  { type: "EFFECT", cell: "greet-0", text: "hello quilt" },
  { type: "EFFECT", cell: "greet-1", text: "hello organ" },
  { type: "EFFECT", cell: "greet-0", text: "hello quilt-organ" },
];
let prev = "GENESIS";
const receipts = receiptsRaw.map((op, i) => {
  const core = { seq: i, op, prev };
  const hash = sha256Json(core);
  prev = hash;
  return { ...core, hash };
});

// ---- state commitments ----
const cellsSha256 = sha256Json(state.cells);
const stateHash = sha256Json(state);
const perCellHash = Object.fromEntries(
  Object.entries(state.cells).map(([id, s]) => [id, sha256Json(s)])
);

// ---- manifest: toolkit manifest law VERBATIM + registered extensions ----
const manifestBase = {
  author: "lane-64-c", // canonical re-expression authored by lane 64-c; content derives from the lane-63-e greeter
  cells: [
    { id: "greet-0", kind: "greeter", entry: "greet", stateHash: perCellHash["greet-0"] },
    { id: "greet-1", kind: "greeter", entry: "greet", stateHash: perCellHash["greet-1"] },
  ],
  createdAt,
  edges: [],
  genesis: { seq: 0, prevHash: "GENESIS" },
  name: "greeter-organ",
  receiptRange: { start: 0, end: receipts.length - 1, count: receipts.length },
  schema: "quilt.organ.manifest",
  schemaVersion: 1,
  state: { cellsSha256 },
  stateHash, // registered extension: WHOLE-state commitment (worker heritage)
  supersedes: null,
};
const organId = `${manifestBase.name}@${sha256Json({ name: manifestBase.name, material: stateHash }).slice(0, 16)}`;
const manifest = { ...manifestBase, organId };
manifest.manifestHash = sha256Json(manifest); // self-cover over everything above

const bundle = {
  schema: "quilt.organ.manifest/v1",
  manifest,
  state,
  receipts,
};

process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
process.stderr.write(
  [
    `organ id (store content address, sha256 of canonical manifest incl. manifestHash): ${sha256Json(manifest)}`,
    `manifestHash (sha256 of canonical manifest minus manifestHash):                     ${manifest.manifestHash}`,
    `stateHash (whole state):                                                            ${stateHash}`,
    `state.cellsSha256:                                                                  ${cellsSha256}`,
    `receipt chain: GENESIS -> ${receipts.map((r) => r.hash.slice(0, 8)).join(" -> ")}`,
  ].join("\n")
);
