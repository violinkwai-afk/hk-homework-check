// JS/Photon port of the Python per-bead-segmentation abacus reader.
// Reference: scratchpad/abacus_bead_count.py (5/5 exact on this image).
const { PhotonImage } = require("@cf-wasm/photon/node");
const fs = require("fs");

const filePath = process.argv[2] || "/tmp/claude-115/-var-www-my-project/270950ff-ce7e-4c37-9365-c951ebe958ad/scratchpad/abacus_photon_test.png";
const bytes = fs.readFileSync(filePath);
const img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
const w = img.get_width();
const h = img.get_height();
const px = img.get_raw_pixels(); // RGBA

function luminance(x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
}

function findPeaks(signal, minHeight = 5, minDistance = 12, minProminence = 3) {
  const peaks = [];
  const n = signal.length;
  let i = 1;
  while (i < n - 1) {
    if (signal[i] >= signal[i - 1] && signal[i] >= signal[i + 1] && signal[i] >= minHeight) {
      let leftMin = signal[i];
      let j = i;
      while (j > 0 && signal[j] <= signal[i]) {
        leftMin = Math.min(leftMin, signal[j]);
        j--;
        if (signal[j] > signal[i]) break;
      }
      let rightMin = signal[i];
      let k = i;
      while (k < n - 1 && signal[k] <= signal[i]) {
        rightMin = Math.min(rightMin, signal[k]);
        k++;
        if (signal[k] > signal[i]) break;
      }
      if (signal[i] - Math.max(leftMin, rightMin) >= minProminence) {
        if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDistance) {
          peaks.push(i);
        } else if (signal[i] > signal[peaks[peaks.length - 1]]) {
          peaks[peaks.length - 1] = i;
        }
      }
    }
    i++;
  }
  return peaks;
}

// Same algorithm as count_beads() in abacus_bead_count.py: per-row dark-pixel
// width within [x0,x1), minus a constant rod-line baseline, smoothed, then
// real local-maxima/prominence peak detection (one peak = one bead).
function countBeads(x0, x1, y0, y1, threshold = 200) {
  const widths = [];
  for (let y = y0; y < y1; y++) {
    let count = 0;
    for (let x = x0; x < x1; x++) {
      if (luminance(x, y) < threshold) count++;
    }
    widths.push(count);
  }
  let nonzeroEnd = widths.length;
  for (let i = 20; i < widths.length; i++) {
    if (widths[i] > 65 && widths[Math.max(0, i - 3)] < 55) {
      nonzeroEnd = i;
      break;
    }
  }
  const trimmed = widths.slice(0, nonzeroEnd);
  const first15 = trimmed.slice(0, 15).slice().sort((a, b) => a - b);
  const baseline = first15[Math.floor(first15.length / 2)];
  const signal = trimmed.map((v) => Math.max(0, v - baseline));
  const smooth = signal.map((_, i) => {
    const a = signal[i - 1] ?? signal[i];
    const b = signal[i];
    const c = signal[i + 1] ?? signal[i];
    return (a + b + c) / 3;
  });
  return findPeaks(smooth).length;
}

// Rod x-ranges detected directly from this real image (dark-column grouping
// in the bead band, y=380..520) -- 10Th, Th, H, T, U left to right.
const rods = [
  { name: "10Th", x0: 176, x1: 235, expected: 4 },
  { name: "Th", x0: 273, x1: 334, expected: 3 },
  { name: "H", x0: 371, x1: 433, expected: 5 },
  { name: "T", x0: 470, x1: 529, expected: 1 },
  { name: "U", x0: 567, x1: 626, expected: 2 },
];

let allCorrect = true;
for (const rod of rods) {
  const count = countBeads(rod.x0, rod.x1, 380, 525);
  const ok = count === rod.expected;
  if (!ok) allCorrect = false;
  console.log(`${rod.name}: got ${count}, expected ${rod.expected} -> ${ok ? "OK" : "WRONG"}`);
}
console.log(allCorrect ? "ALL 5 CORRECT" : "MISMATCH FOUND");
