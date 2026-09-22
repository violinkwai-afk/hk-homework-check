# Methodology: evaluating a new visual (V-tier) question type

Distilled 2026-09-22 from three real attempts in the same session
(fish-length comparison, clock-hand reading, abacus bead-counting) —
this is the repeatable PROCESS, kept separate from
`question-type-library.md`'s per-type findings so it doesn't get lost
inside one table row. Update this file if a future attempt reveals a
step that's missing or wrong; don't silently deviate from it without
recording why.

## The five steps

1. **Establish real ground truth yourself, first.** Look at the actual
   rendered image (not the question's text description) and work out
   the correct answer by eye/hand before writing any code. Every
   attempt in this session that skipped this step had no way to know
   whether a measured/counted result was actually right.

2. **Prototype in Python first, not the production language.** This
   repo's real runtime is JavaScript/Cloudflare Workers, but Python
   (PIL, `opencv-python-headless`) iterates faster for a feasibility
   spike. Prove the TECHNIQUE works before worrying about where it
   runs.

3. **Only port to the real production tool if step 2 clears the bar.**
   This repo already ships `@cf-wasm/photon` (not OpenCV, which cannot
   run on Cloudflare Workers — a full OpenCV.js port is a likely
   non-starter, ~6MB WASM against a ~1MB per-file limit). Porting
   something unproven in Python wastes the port; only do it once the
   Python version genuinely works.

4. **Hold the same bar every verifier in this project holds: 0
   confidently-wrong results.** "Right order of magnitude" or "close"
   is not good enough — an unverifiable/imprecise result must DECLINE
   (return null / defer to a human), never guess and round. If a
   technique can't clear this bar, diagnose the REAL root cause (like
   clock-reading's "no Hough-line-transform equivalent in Photon" —
   found via actual debug output, not assumed) and stop. Try one
   identified concrete next step if one exists (like abacus's
   per-bead-boundary segmentation, which DID work) — but don't loop
   indefinitely on untried variations once a genuine root cause is
   found and no further step is naturally implied.

5. **Never call a technique "solved" from one example.** A single
   successful image is one data point, not proof of generalization —
   different textbooks/worksheets use different illustration styles
   (this project's own fish-length finding: works for solid-fill
   drawings, fails for outline-style ones, and there's no way to know
   which style a new worksheet uses in advance). Before marking a
   V-tier type as genuinely solved, test against more than one
   independently-drawn real example. The 2026-09-22 abacus success is
   explicitly flagged as NOT yet meeting this bar (the page's two
   abacus diagrams turned out to be the same drawing).

## Quick reference: outcomes so far

| Type | Outcome | Why |
|---|---|---|
| Fish-length comparison | Works, ported to Photon | Connected-component measurement — Photon's `edge_detection` handles this cleanly |
| Clock-hand reading | Confirmed non-starter (this technique) | Photon has no Hough-line-transform equivalent; needs connected line SEGMENTS, not scattered edge pixels |
| Abacus bead-counting | Works (Python), not yet ported, not yet generalization-tested | Per-bead boundary segmentation (row-width profile, local maxima) — 5/5 exact on the one real example tested |

See `question-type-library.md` for full per-type detail and real
example citations.
