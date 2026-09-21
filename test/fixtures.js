// Synthetic Google Vision DOCUMENT_TEXT_DETECTION-shaped fixtures for
// /api/mark regression tests. No real photos exist in this repo (checked
// before writing this), so these are hand-built word/bbox geometries
// modeling the specific layouts the 2026-09-21 review asked to be covered:
// a two-column page, several items with short/similar numeric prefixes,
// an expression split across multiple OCR word tokens (the real bug
// findBboxForItem was originally written to fix), and a second page (for
// page-attribution testing). They are deliberately readable/hand-verifiable
// rather than realistic noise, so a human can check "does the expected
// mapping actually match the geometry" at a glance.

// One Vision "word" token: x/y/w/h in the same pixel-space googleOcr()
// already returns (top-left origin, y grows downward).
function word(text, x, y, w = 30, h = 30) {
  return { text, x, y, w, h };
}

// PAGE 0: two-column layout.
//   Left column (x ~40-220):   Q1 "4+6="   (top),  Q3 "23+5="  (bottom)
//   Right column (x ~500-700): Q2 "4+60="  (top),  Q4 "23+50=" (bottom)
// "4+6=" and "23+5=" are each split into one token per character/operator,
// mirroring the real split-token case the bridging logic was built for.
// Q2/Q4 share a short numeric prefix with Q1/Q3 ("4".."46" / "23") on
// purpose, to probe whether a short accumulated match can accidentally
// bind to the wrong column.
const PAGE0_WORDS = [
  // Q1, left column, top
  word("4", 40, 40), word("+", 75, 40), word("6", 110, 40), word("=", 145, 40),
  // Q2, right column, top
  word("4", 500, 40), word("+", 535, 40), word("60", 570, 40), word("=", 615, 40),
  // Q3, left column, bottom
  word("23", 40, 300), word("+", 90, 300), word("5", 125, 300), word("=", 160, 300),
  // Q4, right column, bottom
  word("23", 500, 300), word("+", 550, 300), word("50", 585, 300), word("=", 630, 300),
];
const PAGE0 = { width: 800, height: 400, words: PAGE0_WORDS, rotationDeg: 0 };

// PAGE 1: second page, for multi-page attribution testing. Q5/Q6 use
// numeric prefixes that DON'T collide with anything on page 0.
const PAGE1_WORDS = [
  word("7", 40, 40), word("+", 75, 40), word("8", 110, 40), word("=", 145, 40), // Q5
  word("9", 40, 200), word("+", 75, 200), word("2", 110, 200), word("=", 145, 200), // Q6
];
const PAGE1 = { width: 800, height: 400, words: PAGE1_WORDS, rotationDeg: 0 };

// PAGE 2: adversarial short-prefix case. A stray "4" and "6" token pair
// (e.g. noise from a running header/page-number) appears BEFORE the real
// "4+6=" question in scan order, both reducible to the same 2-character
// needle "46" that "4+6=" produces. This is the shortest possible needle
// findBboxForItem accepts (MIN match length is 2) -- exactly the case the
// 2026-09-21 review flagged as collision-prone.
const PAGE2_WORDS = [
  word("4", 10, 5, 15, 15),  // stray, e.g. part of a page header "p.46"
  word("6", 28, 5, 15, 15),  // stray, continues the same coincidence
  word("4", 40, 100), word("+", 75, 100), word("6", 110, 100), word("=", 145, 100), // the REAL "4+6=" question
];
const PAGE2 = { width: 800, height: 400, words: PAGE2_WORDS, rotationDeg: 0 };

module.exports = { word, PAGE0, PAGE1, PAGE2 };
