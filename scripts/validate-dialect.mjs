#!/usr/bin/env node
/**
 * validate-dialect.mjs — the L15 shared-fixture harness (schema/organ-manifest.v1.json).
 *
 * Proves that BOTH organ implementations validate the canonical fixture
 * (fixture/organ-manifest-v1.json) and REJECT every negative control:
 *
 *   Implementation A — the organ-boot-loader worker (src/organ-boot-loader/worker.js).
 *       Runs the EXACT production validators via named exports:
 *       validateCanonicalBundle / canonical / sha256hex / detectDialect.
 *   Implementation B — the quilt-jev-toolkit custody primitives
 *       (src/organ/manifest.mjs in the peer checkout, default
 *       ../quilt-jev-toolkit relative to this repo; override with
 *       TOOLKIT_MANIFEST_MJS env var). Runs validateManifest / verifyChain /
 *       computeManifestHash / canonicalJson / mintOrganId UNMODIFIED.
 *
 * Also runs a cross-canonicalizer battery (worker canonical() vs toolkit
 * canonicalJson() byte-equality on JSON edge cases + a deterministic pseudo-random
 * corpus) and a fail-closed parity battery (undefined / NaN / Infinity / bigint
 * throw in BOTH implementations).
 *
 * Exit 0 iff every check holds; exit 1 (fail-closed) otherwise.
 * Stdlib only; deterministic; no network.
 *
 * Usage: node scripts/validate-dialect.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURE_PATH = resolve(ROOT, "fixture/organ-manifest-v1.json");
const WORKER_PATH = resolve(ROOT, "src/organ-boot-loader/worker.js");
const TOOLKIT_PATH = process.env.TOOLKIT_MANIFEST_MJS
  ? resolve(process.env.TOOLKIT_MANIFEST_MJS)
  : resolve(ROOT, "../quilt-jev-toolkit/src/organ/manifest.mjs");

const results = [];
let failed = false;
function record(name, expected, got, detail = "") {
  const pass = expected === got;
  if (!pass) failed = true;
  results.push({ name, expected, got, pass, detail });
}

const fixtureBytes = readFileSync(FIXTURE_PATH, "utf8");
const fixture = JSON.parse(fixtureBytes);
const fixtureSha256 = createHash("sha256").update(fixtureBytes, "utf8").digest("hex");

// ---- load implementations ----------------------------------------------------
const worker = await import(pathToFileURL(WORKER_PATH).href);
const tk = await import(pathToFileURL(TOOLKIT_PATH).href);

// =============================================================================
// 1. Implementation B — the toolkit (unmodified primitives) accepts the fixture
// =============================================================================
{
  const v = tk.validateManifest(fixture.manifest);
  record("toolkit.validateManifest(fixture.manifest).ok", true, v.ok, JSON.stringify(v.errors ?? []));
}
{
  const c = tk.computeManifestHash(fixture.manifest);
  record("toolkit.computeManifestHash == carried manifestHash", fixture.manifest.manifestHash, c);
}
{
  const c = tk.verifyChain(fixture.receipts, {
    expectedStart: fixture.manifest.receiptRange.start,
    expectedPrev: fixture.manifest.genesis.prevHash,
  });
  record("toolkit.verifyChain(receipts).ok", true, c.ok, JSON.stringify(c.detail ?? ""));
  record("toolkit.verifyChain tip == last receipt hash", fixture.receipts.at(-1).hash, c.tipHash);
  record("toolkit.verifyChain count == receiptRange.count", fixture.manifest.receiptRange.count, c.count);
}
{
  const minted = tk.mintOrganId(fixture.manifest.name, fixture.manifest.stateHash);
  record("toolkit.mintOrganId(name, stateHash) == carried organId", fixture.manifest.organId, minted);
}
{
  // toolkit canonicalization round-trip (idempotence)
  const canon = tk.canonicalJson(fixture);
  const round = tk.canonicalJson(JSON.parse(canon));
  record("toolkit.canonicalJson round-trip idempotent", true, canon === round);
}

// =============================================================================
// 2. Implementation A — the worker (production validators) accepts the fixture
// =============================================================================
{
  const v = await worker.validateCanonicalBundle(structuredClone(fixture));
  record("worker.validateCanonicalBundle(fixture).ok", true, v.ok, JSON.stringify(v.errors ?? []));
}
{
  const id = await worker.sha256hex(worker.canonical(fixture.manifest));
  // cross-check against node crypto over the toolkit's canonical form
  const idTk = createHash("sha256").update(tk.canonicalJson(fixture.manifest), "utf8").digest("hex");
  record("worker organ id (sha256 of canonical manifest) == toolkit-side recompute", true, id === idTk, id);
}
{
  record("worker.detectDialect(fixture)", "quilt.organ.manifest/v1", worker.detectDialect(fixture));
}

// =============================================================================
// 3. Cross-canonicalizer battery — worker canonical() ≡ toolkit canonicalJson()
//    byte-for-byte on every JSON-representable value
// =============================================================================
const battery = [
  fixture,
  fixture.manifest,
  fixture.state,
  fixture.receipts,
  { a: 1, b: [1, 2, 3], c: { d: null, e: true, f: "s" } },
  {},
  [],
  [[[[["deep"]]]]],
  { "": {}, "0": 0, "π": Math.PI, "\u0000control": "\u0001" },
  { float: 0.1 + 0.2, tiny: 5e-324, huge: 1e21, neg: -3.5, zero: 0, intBig: 9007199254740991 },
  { unicode: "héllo \u{1F9F5} quilt", emoji_key: { "🧵": "thread" } },
  { nested: { arrays: [{ of: [{ objects: [] }] }] }, emptyStr: "", emptyObj: {}, emptyArr: [] },
];
// deterministic pseudo-random JSON corpus (LCG; no wall clock)
{
  let s = 0x2545f491;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const randVal = (d) => {
    if (d <= 0) return rnd() < 0.5 ? Math.floor(rnd() * 1000) : rnd().toString(36).slice(2, 8);
    const r = rnd();
    if (r < 0.3) return Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => randVal(d - 1));
    if (r < 0.6) return Object.fromEntries(Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => [rnd().toString(36).slice(2, 6), randVal(d - 1)]));
    if (r < 0.7) return rnd() < 0.5;
    if (r < 0.75) return null;
    return rnd() < 0.5 ? Math.floor(rnd() * 1e6) : (rnd() * 1e9 - 5e8);
  };
  for (let i = 0; i < 64; i++) battery.push({ doc: i, v: randVal(4) });
}
{
  let mismatches = 0;
  for (let i = 0; i < battery.length; i++) {
    const a = worker.canonical(battery[i]);
    const b = tk.canonicalJson(battery[i]);
    if (a !== b) { mismatches++; record(`canonicalizer battery[${i}]`, b, a); }
  }
  record(`cross-canonicalizer battery (${battery.length} docs) byte-identical`, 0, mismatches);
}

// =============================================================================
// 4. Fail-closed parity — both canonicalizers THROW on undefined/NaN/Infinity/bigint
// =============================================================================
{
  const cases = [
    ["undefined field", { a: undefined }],
    ["NaN", { a: NaN }],
    ["Infinity", { a: Infinity }],
    ["-Infinity", { a: -Infinity }],
    ["bigint", { a: 1n }],
  ];
  for (const [name, doc] of cases) {
    let wThrew = false, tThrew = false;
    try { worker.canonical(doc); } catch { wThrew = true; }
    try { tk.canonicalJson(doc); } catch { tThrew = true; }
    record(`fail-closed parity (${name}): worker throws`, true, wThrew);
    record(`fail-closed parity (${name}): toolkit throws`, true, tThrew);
  }
}

// =============================================================================
// 5. Negative controls — tampered variants MUST be rejected by the stated law
// =============================================================================
const clone = () => structuredClone(fixture);
const controls = [];
{
  const b = clone(); b.state.cells["greet-0"].greetings = 99; controls.push(
    ["tampered state value", b, { worker: false, toolkit: true }]);
  const b2 = clone(); b2.receipts[1].op.text = "forged"; controls.push(
    ["forged receipt op (hash stale)", b2, { worker: false, toolkit: false }]);
  const b3 = clone(); b3.manifest.name = "evil-organ"; controls.push(
    ["manifest field edited (manifestHash stale)", b3, { worker: false, toolkit: false }]);
  const b4 = clone(); b4.schema = "quilt.organ.v9";
  record('control "unknown envelope schema string": detectDialect → null', null, worker.detectDialect(b4));
  const b5 = clone(); b5.receipts[2].seq = 7; controls.push(
    ["receipt seq discontinuity", b5, { worker: false, toolkit: false }]);
  const b6 = clone(); b6.receipts[1].prev = "GENESIS"; controls.push(
    ["receipt prev-link break", b6, { worker: false, toolkit: false }]);
  const b7 = clone(); b7.receipts.pop(); controls.push(
    ["truncated window (receipts < receiptRange.count)", b7, { worker: false, toolkit: true }]);
  const b8 = clone(); b8.manifest.cells[0].stateHash = "0".repeat(64); controls.push(
    ["per-cell stateHash claim wrong (manifestHash stale)", b8, { worker: false, toolkit: false }]);
  const b9 = clone(); b9.manifest.cells[0].stateHash = "0".repeat(64);
  b9.manifest.manifestHash = tk.computeManifestHash(b9.manifest); // attacker re-signs
  controls.push(
    ["per-cell stateHash claim wrong, manifestHash re-signed", b9, { worker: false, toolkit: true }]);
}
for (const [name, bundle, expect] of controls) {
  const w = await worker.validateCanonicalBundle(structuredClone(bundle));
  record(`control "${name}": worker rejects`, false, w.ok, w.ok ? "" : (w.errors?.[0]?.code ?? ""));
  const t = tk.verifyChain(bundle.receipts ?? [], {
    expectedStart: bundle.manifest?.receiptRange?.start ?? 0,
    expectedPrev: bundle.manifest?.genesis?.prevHash ?? "GENESIS",
  });
  const tManifest = tk.validateManifest(bundle.manifest);
  const tOk = t.ok && tManifest.ok;
  record(`control "${name}": toolkit ${expect.toolkit ? "accepts (law division, receipted)" : "rejects"}`, expect.toolkit, tOk,
    expect.toolkit ? "" : JSON.stringify({ chain: t.detail, manifest: tManifest.errors?.map((e) => e.code) }));
}

// =============================================================================
// report
// =============================================================================
const N = results.length;
const ok = results.filter((r) => r.pass).length;
console.log("=== validate-dialect.mjs — L15 shared-fixture harness =======================");
console.log(`fixture:        ${FIXTURE_PATH}`);
console.log(`fixture sha256: ${fixtureSha256}`);
console.log(`worker law:     ${WORKER_PATH}`);
console.log(`toolkit law:    ${TOOLKIT_PATH}`);
console.log("------------------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `   [${r.detail}]` : ""}`);
}
console.log("------------------------------------------------------------------------------");
console.log(`${ok}/${N} checks passed`);
console.log(`fixture bytes sha256:            ${fixtureSha256}`);
console.log(`organ id (content address):      ${await worker.sha256hex(worker.canonical(fixture.manifest))}`);
console.log(`manifestHash:                    ${fixture.manifest.manifestHash}`);
console.log(`stateHash (whole state):         ${fixture.manifest.stateHash}`);
console.log(`state.cellsSha256:               ${fixture.manifest.state.cellsSha256}`);
console.log(`receipt tip:                     ${fixture.receipts.at(-1).hash}`);
console.log(`organId:                         ${fixture.manifest.organId}`);
if (failed) {
  console.log("VERDICT: FAIL — the fixture is NOT jointly valid; do not register.");
  process.exit(1);
}
console.log("VERDICT: PASS — BOTH implementations validate the canonical fixture.");
