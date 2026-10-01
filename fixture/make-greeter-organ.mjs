#!/usr/bin/env node
/**
 * make-greeter-organ.mjs — deterministic minimal quilt.organ.v1 fixture.
 * 2 cells, 3 receipts (real hash chain genesis→tip), stateHash = sha256(canonicalJSON(state)).
 * Organ id = sha256(canonicalJSON(manifest)) — the content address the loader derives.
 *
 * Usage: node fixture/make-greeter-organ.mjs > fixture/greeter-organ.json
 * Emits the bundle JSON on stdout and a summary (id/stateHash) on stderr.
 * Deterministic: fixed createdAt so committed fixture bytes are stable.
 */
import { createHash } from "node:crypto";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const createdAt = "2026-10-02T00:00:00Z";

const state = {
  cells: {
    "greet-0": { greetings: 2, last: "quilt" },
    "greet-1": { greetings: 1, last: "organ" },
  },
  emitted: 3,
  schema: "quilt.organ.v1",
};

const receiptsRaw = [
  { seq: 1, op: "EFFECT", cell: "greet-0", prev: "genesis", payload: { text: "hello quilt" } },
  { seq: 2, op: "EFFECT", cell: "greet-1", prev: null, payload: { text: "hello organ" } },
  { seq: 3, op: "EFFECT", cell: "greet-0", prev: null, payload: { text: "hello quilt-organ" } },
];
let prev = "genesis";
const receipts = receiptsRaw.map((r) => {
  const withPrev = { ...r, prev };
  const digest = sha256hex(canonical(withPrev));
  prev = digest;
  return { ...withPrev, digest };
});

const manifest = {
  author: "lane-63-e",
  cells: [
    { id: "greet-0", kind: "greeter", entry: "greet" },
    { id: "greet-1", kind: "greeter", entry: "greet" },
  ],
  createdAt,
  name: "greeter-organ",
  receiptRange: receipts.map((r) => r.digest),
  stateHash: sha256hex(canonical(state)),
};

const bundle = {
  manifest,
  receipts,
  schemaVersion: "quilt.organ.v1",
  state,
};

process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
process.stderr.write(
  [
    `organ id (sha256 of canonical manifest): ${sha256hex(canonical(manifest))}`,
    `stateHash:                                ${manifest.stateHash}`,
    `receipt chain: genesis -> ${receipts.map((r) => r.digest.slice(0, 8)).join(" -> ")}`,
  ].join("\n")
);
