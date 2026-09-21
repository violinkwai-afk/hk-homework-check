// Server-side annotation for the Telegram MVP: stamps the existing
// check/cross PNGs (rasterized from website/index.html's markIcon() hand-
// drawn SVG strokes -- see src/annotation-icons.js) onto a homework photo
// using Photon's watermark(). Never modifies /api/mark's result objects --
// a read-only consumer of its output, not a second source of truth.
import { PhotonImage, resize, watermark, SamplingFilter } from "@cf-wasm/photon/workerd";
import { CHECK_PNG_BASE64, CROSS_PNG_BASE64 } from "./annotation-icons.js";

// Same 128MB Photon memory-cap concern the package's own README warns
// about (see downscaleForCheapTier/cropItem in worker.js for the existing
// precedent): a photo's compressed byte size is a poor proxy for its
// decoded memory footprint, so this gates on actual decoded pixel count,
// not file size. Decoded RGBA alone is ~4 bytes/pixel, so even 40MP is
// ~160MB before Photon's own overhead -- too close to the 128MB cap to
// call safe. 16MP (~64MB decoded) leaves real headroom underneath it
// while still covering a typical phone photo without downscaling first.
export const MAX_ANNOTATION_MEGAPIXELS = 16;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Matches the live website's own placement rule exactly (website/
// index.html's mark rendering: `left:${cx}%; top:${cy}%` where cx/cy are
// the bbox's bottom-right corner, i.e. `bbox.x+bbox.w`/`bbox.y+bbox.h`) --
// not a new convention invented for this.
function markPosition(bbox, width, height) {
  return {
    cx: ((bbox.x + bbox.w) / 100) * width,
    cy: ((bbox.y + bbox.h) / 100) * height,
  };
}

// Which icon (if any) to stamp for one result, chosen to mirror the live
// website's own semantics as closely as this MVP's two-icon asset set
// allows (website/index.html's markClass/markIcon + the "only a non-
// correct item gets a visible mark" hiddenStyle rule):
//   - incorrect (correct === false) -> cross.png, exactly like the
//     website's visible "bad" mark.
//   - needs_review (correct === null) -> the website shows a distinct
//     "?" glyph here, which this MVP has no PNG asset for. Per explicit
//     instruction not to treat needs_review as incorrect, this returns
//     "none" here rather than substituting the cross -- a known,
//     deliberate v1 gap (no visual marker at all for needs_review yet),
//     not a silent misclassification.
//   - correct (correct === true) -> the website itself keeps this
//     invisible by design (a real usability fix -- see markIcon's own
//     comment history about cluttered pages). "none" matches that
//     existing product decision, not a shortcut taken here.
function iconKindFor(result) {
  if (result.correct === false) return "cross";
  return "none";
}

// Icon size scales with the matched text's own bbox height (clamped to a
// sane range) rather than one fixed pixel size, so it reads at a sensible
// scale whether the photo is a tight crop or a full A4 page.
function iconSizeFor(bbox, pageHeightPx) {
  const bboxHeightPx = (bbox.h / 100) * pageHeightPx;
  return Math.max(24, Math.min(160, Math.round(bboxHeightPx * 1.4)));
}

// originalBytes: the untouched photo -- never cropped/mutated; this
// decodes its own fresh PhotonImage from the same bytes the caller holds.
// results: /api/mark's `results` array (or a subset restricted to one
// page) -- read-only.
// Returns { data: Uint8Array, mediaType: "image/jpeg" }.
// Throws (rather than guessing) if originalBytes isn't a decodable image,
// or exceeds MAX_ANNOTATION_MEGAPIXELS -- callers must treat that as a
// real failure, not silently send back an unannotated photo.
export function annotateImage(originalBytes, results) {
  let photonImg;
  const iconCache = new Map(); // "cross"/"check" -> decoded base PhotonImage, reused across items
  try {
    photonImg = PhotonImage.new_from_byteslice(originalBytes);
    const width = photonImg.get_width();
    const height = photonImg.get_height();
    const megapixels = (width * height) / 1_000_000;
    if (megapixels > MAX_ANNOTATION_MEGAPIXELS) {
      throw new Error(`image too large to annotate safely: ${megapixels.toFixed(1)}MP > ${MAX_ANNOTATION_MEGAPIXELS}MP cap`);
    }

    for (const r of results || []) {
      if (!r.bbox) continue;
      const kind = iconKindFor(r);
      if (kind === "none") continue;

      let baseIcon = iconCache.get(kind);
      if (!baseIcon) {
        const iconBytes = base64ToBytes(kind === "cross" ? CROSS_PNG_BASE64 : CHECK_PNG_BASE64);
        baseIcon = PhotonImage.new_from_byteslice(iconBytes);
        iconCache.set(kind, baseIcon);
      }

      const size = iconSizeFor(r.bbox, height);
      const resized = size === baseIcon.get_width() && size === baseIcon.get_height()
        ? null
        : resize(baseIcon, size, size, SamplingFilter.Lanczos3);
      const stamp = resized || baseIcon;
      try {
        const { cx, cy } = markPosition(r.bbox, width, height);
        // watermark() places the TOP-LEFT corner at (x, y) -- offset by
        // half the icon so it's centered on the bbox corner, matching the
        // website's own CSS (which centers the mark on its left/top
        // anchor via transform). Clamped to >=0: a bbox near the photo's
        // own edge must not push the stamp origin negative.
        const x = BigInt(Math.max(0, Math.round(cx - size / 2)));
        const y = BigInt(Math.max(0, Math.round(cy - size / 2)));
        watermark(photonImg, stamp, x, y);
      } finally {
        if (resized) resized.free();
      }
    }

    const outBytes = photonImg.get_bytes_jpeg(90);
    return { data: outBytes, mediaType: "image/jpeg" };
  } finally {
    if (photonImg) photonImg.free();
    for (const img of iconCache.values()) img.free();
  }
}
