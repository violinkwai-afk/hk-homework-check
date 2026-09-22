#!/usr/bin/env node
// Benchmark runner for /api/mark -- testing/classification only, does
// NOT modify prompt/parser/verifier/bbox/model. Posts one or more real
// homework photos to the deployed worker, records the raw response and
// latency under benchmark/raw/, and prints a quick summary.
//
// Usage: node benchmark/run.js <batchId> <photo1.jpg> [photo2.jpg ...]
// Output: benchmark/raw/<batchId>.json (full request-shape-relevant
//         response + per-call latency), plus a stdout summary to copy
//         into benchmark/log.md.

const fs = require("node:fs");
const path = require("node:path");

const ENDPOINT = process.env.MARK_ENDPOINT || "https://hk-homework-check.violin-kwai.workers.dev/api/mark";

function mediaTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function main() {
  const [batchId, ...photoPaths] = process.argv.slice(2);
  if (!batchId || !photoPaths.length) {
    console.error("Usage: node benchmark/run.js <batchId> <photo1> [photo2 ...]");
    process.exit(1);
  }

  const images = photoPaths.map((p) => ({
    data: fs.readFileSync(p).toString("base64"),
    mediaType: mediaTypeFor(p),
  }));

  const startedAt = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ images }),
  });
  const latencyMs = Date.now() - startedAt;
  const status = res.status;
  let body;
  try {
    body = await res.json();
  } catch (e) {
    body = { parseError: String(e), rawText: await res.text().catch(() => null) };
  }

  const record = {
    batchId,
    photoPaths,
    endpoint: ENDPOINT,
    requestedAt: new Date(startedAt).toISOString(),
    httpStatus: status,
    latencyMs,
    response: body,
  };

  const outDir = path.join(__dirname, "raw");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${batchId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));

  console.log(`\n=== batch ${batchId} ===`);
  console.log(`HTTP ${status}, ${latencyMs}ms, saved -> ${path.relative(process.cwd(), outPath)}`);
  if (status !== 200) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const results = body.results || [];
  console.log(`items: ${results.length}, pageErrors: ${(body.pageErrors || []).length}`);
  results.forEach((r, i) => {
    console.log(
      `  [${i}] page=${r.page} q=${JSON.stringify(r.question)} ans=${JSON.stringify(r.studentAnswer)} ` +
      `verdict=${r.status}(${r.correct}) correctAnswer=${JSON.stringify(r.correctAnswer)} subject=${r.subject} bbox=${r.bbox ? "yes" : "no"}`
    );
  });
  if ((body.pageErrors || []).length) {
    console.log("pageErrors:", JSON.stringify(body.pageErrors, null, 2));
  }
}

main().catch((e) => {
  console.error("benchmark run failed:", e);
  process.exit(1);
});
