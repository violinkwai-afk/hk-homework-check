# Generic Homework Marking Benchmark

Testing/classification only. **Does NOT modify prompt / parser / verifier /
bbox / model.** Goal is a coverage map of what the deployed `/api/mark`
pipeline reliably handles, not a 100%-pass score.

Target under test: production `hk-homework-check.violin-kwai.workers.dev/api/mark`
(the `test/api-mark-e2e` branch was merged to `main` on 2026-09-22, commit
`e948263` — this is now the same code).

## Workflow per batch

1. Receive real homework photo(s) from the user.
2. `node benchmark/run.js <batchId> <photo1.jpg> [photo2.jpg ...]`
   → posts to `/api/mark`, saves full response + latency to
   `benchmark/raw/<batchId>.json`, prints a summary.
3. Manually compare each item's OCR/verdict against the actual photo.
4. Append one row per item to `log.md`'s table (below), classified by
   issue layer (A–H) and 題型. If it worked correctly, record it as
   correct too — the map needs the wins, not just the failures.
5. **Never react to a failure by patching code.** Record only:
   - which layer is implicated (A–H)
   - what's needed to fix it (if guessable) — but do not implement
   - `needs_review` is a correct, safe outcome, not a failure to log as
     wrong — only flag it as an issue if it *should* have resolved but
     didn't (e.g. a single unambiguous blank that still came back null).

## Issue-layer categories (A–H)

| Code | Layer | Examples |
| --- | --- | --- |
| A | OCR / handwriting recognition | digit misread, symbol misread, handwriting misread, printed/handwriting confusion |
| B | Item segmentation | multiple items merged into one, one item split into several, comma/semicolon segmentation, multi-column merge |
| C | Parser | OCR output correct but parser misreads it, question-number/answer-separator issues |
| D | Verifier | OCR correct but verifier can't check it — blank-in-middle, multi-blank, multi-step calc |
| E | Bbox / annotation | verdict correct but ✓/✗ mis-positioned, correct answer location not found |
| F | Subject / semantic marking | Chinese, English, reading/comprehension, open-ended answers |
| G | Image / visual understanding | diagrams, graphs, measuring cups, geometry, clocks, pictures, small printed symbols |
| H | Resolution / image quality | 640px already illegible, small text, light-colored print, tiny handwriting |

## Per-item log table (append rows to `log.md`)

| Batch/ID | 題型 | Layer(s) | OCR result | Student answer | Verdict | Bbox | Latency | Human-confirmed correct? | Notes |

## Final summary target (build once enough batches accumulated)

| Category | 題型 | 測試數量 | Correct | Incorrect | Needs review | Main issue |

Plus a status tag per category:
- **目前已可靠支援**
- **可以安全改善**
- **需要較大架構改動**
- **暫時應該 needs_review**
