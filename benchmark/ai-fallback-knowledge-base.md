# AI-fallback knowledge base (draft facts, not yet wired into the prompt)

2026-09-30: per the user's request to enhance the AI-fallback layer's
accuracy/speed by feeding it needed knowledge rather than letting it
derive/hallucinate curriculum facts itself, a fork scanned all 67+29
pages of both real P3 maths PDFs (`math34pdf`, `math3xa_pdf`) for
reusable, general curriculum facts (not tied to one question's specific
numbers). This file is the raw output -- **not yet wired into any
prompt**, just captured so the finding isn't lost. Next step: turn the
highest-value entries below into an actual static block injected into
`buildAiFallbackPrompt`/the `/api/check` fallback prompt.

Two facts (triangle T/F hierarchy, days-with-31-months) are already
fully code-solved by Tickets 216/208 and are NOT repeated here.

## Calendar / Date
- Common year = 365 days, leap year (閏年) = 366 days.
- Weekdays cycle in a fixed 7-day repeating sequence.

## Hong Kong Currency
- Coin denominations (7): 10¢, 20¢, 50¢, $1, $2, $5, $10.
- Banknote denominations (6): $10, $20, $50, $100, $500, $1000.
- $1 = 10 角 (10 "ho").

## Number Theory / Arithmetic Conventions
- Order of operations: brackets first; then ×/÷ before +/−; same-precedence left to right.
- Multiplication is commutative/associative (factors can be reordered/regrouped).
- Distributive law: a×c − b×c = (a−b)×c (and the additive form).
- Any integer × an even number is always even.
- Chinese place-value columns (right to left): 個/十/百/千/萬 (萬 = 10,000).
- Smallest n-digit number = 1 followed by (n-1) zeros; largest n-digit number = n nines.
- Estimation convention: round each operand to a convenient place value before combining; order of operations still applies.

## Fractions
- n/n = 1.
- Same denominator → larger numerator = larger fraction.
- Same numerator → smaller denominator = larger fraction.

## Unit Conversion Constants
- Length: 1 km = 1000 m; 1 m = 100 cm; 1 cm = 10 mm.
- Weight: 1 kg = 1000 g.
- Capacity: 1 L = 1000 mL.
- Time: 1 minute = 60 seconds.

## Clock / Time
- Hand speed order: second hand fastest, then minute, then hour slowest.
- 24h conversion: 00:00-11:59 = AM; add 12 to PM hour (except 12:00 noon); 00:00 = midnight (distinct from 12:00 noon).

## 3D Shapes
- Cylinder: two circular bases of equal size.
- Cone: lateral/side surface is curved.
- Prism: all side/lateral faces are quadrilaterals; named by its base shape.
- Pyramid: NOT all pyramids have a triangular base — only the side faces are always triangles; the base can be any polygon.

## Lines
- Perpendicular lines: meet at a right angle (90°).
- Parallel lines: always straight, constant distance apart, never intersect.

## Quadrilaterals
- Parallelogram: two pairs of opposite sides equal AND parallel, two pairs of opposite angles equal (NOT "all 4 sides equal" — that's rhombus-specific).
- Parallelogram angle limits: opposite angles equal, adjacent angles supplementary → at most 2 obtuse angles.
- Rectangle ⊂ parallelogram; square ⊂ parallelogram.
- Trapezoid = quadrilateral with only ONE pair of parallel sides (vs parallelogram's two); can't have all 4 sides equal.
- Right trapezoid: at most 2 right angles.
- Isosceles trapezoid: one pair of parallel sides, two equal non-parallel legs, normally no right angles.
- Regular octagon has 4 pairs of parallel sides.
- Cutting a parallelogram/rectangle along a diagonal produces two congruent right triangles.

## Triangles (beyond what Tickets 216/208 already cover)
- Triangle inequality: sum of any two sides > the third side (appears repeatedly across both books — high value).
- A triangle has at most ONE right angle (angles sum to 180°).
- A triangle has at most ONE obtuse angle.
- An equilateral triangle's three angles are always 60°/acute — never right or obtuse.
- **Needs a dedup check against Tickets 216/208's existing fact table before adding** — close-but-distinct restatements found: "isosceles is not necessarily a right triangle" / "isosceles-right ⊂ right triangle".

## Direction / Compass
- Opposite pairs: East↔West, North↔South.
- A full turn = 4 right angles = 360°.

## Measurement estimation (a pattern, not one fact)
Recurring "which value is reasonable" questions judge real-world
magnitude (child's weight ≈30kg not 30g, milk carton ≈200mL, 100m sprint
≈14s, basketball ≈500g, bag of rice ≈5kg). Worth a small reference table
of typical object magnitudes rather than one KB entry, since the object
changes every time.
