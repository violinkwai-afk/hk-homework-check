// Telegram Bot API helpers for the /telegram-webhook MVP. Deliberately
// minimal: parse an update, fetch/download one photo, send a photo or a
// text message back. No commands, no accounts, no persistence -- the
// orchestration (calling handleMark, then annotateImage) lives in
// worker.js itself, not here, so this file never needs to import
// anything from worker.js (avoiding a circular import between the two).

const TELEGRAM_API = "https://api.telegram.org";

// Picks the largest available PhotoSize by pixel area -- "a reasonable
// larger version" per spec. Deliberately NOT filtered by Telegram's own
// (approximate, sometimes absent) file_size field here; the real memory
// safeguard is the post-download byte-size cap and annotateImage's own
// decoded-megapixel cap, both enforced where the actual bytes are in
// hand, not against this metadata.
export function parseTelegramUpdate(update) {
  const message = update && update.message;
  const chatId = message && message.chat && message.chat.id;
  const photos = message && message.photo;
  if (!chatId || !Array.isArray(photos) || !photos.length) return null;
  const largest = photos.reduce((best, p) => ((p.width || 0) * (p.height || 0) > (best.width || 0) * (best.height || 0) ? p : best));
  if (!largest || !largest.file_id) return null;
  return { chatId: String(chatId), fileId: largest.file_id };
}

// Step 1 of a Telegram file download: resolve a file_id to a file_path.
// Bot API file_ids are not themselves URLs -- getFile must be called
// first, every time (file_paths are not guaranteed stable/cacheable).
export async function telegramGetFile(botToken, fileId) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.ok || !body.result || !body.result.file_path) {
    throw new Error(`telegram getFile failed: HTTP ${res.status}`);
  }
  return body.result.file_path;
}

// Step 2: download the actual bytes from Telegram's file CDN. Capped by
// maxBytes -- checked as the response streams in via its reported
// Content-Length where available, and re-checked against the actual
// decoded length either way, so a missing/lying header can't bypass it.
export async function telegramDownloadFile(botToken, filePath, maxBytes) {
  const res = await fetch(`${TELEGRAM_API}/file/bot${botToken}/${filePath}`);
  if (!res.ok) throw new Error(`telegram file download failed: HTTP ${res.status}`);
  const declaredLength = Number(res.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error(`photo too large: ${declaredLength} bytes > ${maxBytes} cap`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`photo too large: ${buf.length} bytes > ${maxBytes} cap`);
  return buf;
}

// sendPhoto needs a real multipart upload (binary photo bytes), unlike
// sendMessage's plain JSON -- built with the platform's own FormData/Blob
// rather than hand-rolling multipart boundaries.
export async function telegramSendPhoto(botToken, chatId, imageBytes, mediaType, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption);
  form.append("photo", new Blob([imageBytes], { type: mediaType || "image/jpeg" }), "marked.jpg");
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`telegram sendPhoto failed: HTTP ${res.status}`);
}

export async function telegramSendMessage(botToken, chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`telegram sendMessage failed: HTTP ${res.status}`);
}

// Constant-time string compare for the webhook secret-token check (H) --
// a plain === would let a timing side-channel narrow down the secret
// byte-by-byte; not a real risk for a low-traffic bot, but the standard,
// well-understood mitigation costs nothing to apply.
export function constantTimeEqual(a, b) {
  const bufA = new TextEncoder().encode(String(a));
  const bufB = new TextEncoder().encode(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}
