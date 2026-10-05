/* ShotCreator client-side renderer — Canvas + MediaRecorder.
 * Render video 1080x1920 langsung di browser, tanpa server.
 * Output: MP4 (H.264) kalau browser mendukung, fallback WebM.
 * Template disamakan dengan engine Python (navy bg, kartu screenshot,
 * teks hook atas/bawah, dwell -> pan -> dwell).
 */
"use strict";

const CR = {
  W: 1080, H: 1920, FPS: 30,
  BG: "#0b1526",
  CARD_X: 48, CARD_Y: 400, CARD_W: 984, CARD_H: 1120, CARD_R: 30,
  TOP_Y: 96, TOP_SIZE: 88,
  BOT_Y: 1568, BOT_SIZE: 62,
  MAX_TEXT_W: 960, LINE_H: 1.22, MIN_FONT: 36,
  DWELL_TOP: 2.0, DWELL_BOT: 2.0, PAN_SECS: 13.0, PAN_FRAC: 0.75,
  FONT: "Arial, 'Segoe UI', sans-serif",
};

/* Pilih mimeType terbaik yang didukung browser ini (MP4 dulu). */
function crPickMime() {
  const cands = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of cands) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return "";
}

function crExtFor(mime) {
  return mime.includes("mp4") ? "mp4" : "webm";
}

function crLoadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Gagal memuat gambar"));
    im.src = dataUrl;
  });
}

function crFitFont(ctx, lines, startSize) {
  let size = startSize;
  while (size > CR.MIN_FONT) {
    ctx.font = `bold ${size}px ${CR.FONT}`;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
    if (widest <= CR.MAX_TEXT_W) break;
    size -= 4;
  }
  return size;
}

function crRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Gambar satu frame: bg + kartu screenshot (crop offsetY) + teks. */
function crDrawFrame(ctx, img, scaledH, offsetY, topLines, botLines, topSize, botSize) {
  const t = CR;
  ctx.fillStyle = t.BG;
  ctx.fillRect(0, 0, t.W, t.H);

  // kartu screenshot dengan sudut membulat
  ctx.save();
  crRoundRect(ctx, t.CARD_X, t.CARD_Y, t.CARD_W, t.CARD_H, t.CARD_R);
  ctx.clip();
  if (scaledH <= t.CARD_H) {
    ctx.fillStyle = "#000";
    ctx.fillRect(t.CARD_X, t.CARD_Y, t.CARD_W, t.CARD_H);
    ctx.drawImage(img, t.CARD_X, t.CARD_Y + (t.CARD_H - scaledH) / 2, t.CARD_W, scaledH);
  } else {
    ctx.drawImage(img, 0, offsetY, img.naturalWidth, img.naturalHeight * (t.CARD_H / scaledH),
      t.CARD_X, t.CARD_Y, t.CARD_W, t.CARD_H);
  }
  ctx.restore();

  // teks hook
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `bold ${topSize}px ${t.FONT}`;
  let y = t.TOP_Y;
  for (const ln of topLines) { ctx.fillText(ln, t.W / 2, y); y += topSize * t.LINE_H; }
  ctx.font = `bold ${botSize}px ${t.FONT}`;
  y = t.BOT_Y;
  for (const ln of botLines) { ctx.fillText(ln, t.W / 2, y); y += botSize * t.LINE_H; }
}

function crEase(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

/* Offset crop vertikal utk waktu t (detik) dalam satu segmen gambar. */
function crOffsetAt(tSec, travel) {
  const t = CR;
  if (tSec < t.DWELL_TOP) return 0;
  const pt = tSec - t.DWELL_TOP;
  if (pt < t.PAN_SECS) return travel * crEase(pt / t.PAN_SECS);
  return travel;
}

/**
 * Render video di browser.
 * @param {Object} opts {images:[dataUrl], topLines:[], botLines:[], audioDataUrl?, onProgress(0..1)}
 * @returns Promise<{blob, ext, mime}>
 */
async function crRender(opts) {
  const t = CR;
  const { images, topLines, botLines, audioDataUrl, onProgress } = opts;
  if (!images.length) throw new Error("Tidak ada gambar.");

  const mime = crPickMime();
  if (!mime) throw new Error("Browser tidak mendukung perekaman video.");
  const ext = crExtFor(mime);

  // muat semua gambar + hitung tinggi skala
  const shots = [];
  for (const du of images) {
    const im = await crLoadImage(du);
    const scaledH = im.naturalHeight * (t.CARD_W / im.naturalWidth);
    const travel = Math.max(0, scaledH - t.CARD_H) * t.PAN_FRAC;
    shots.push({ im, scaledH, travel });
  }

  const segSecs = t.DWELL_TOP + t.PAN_SECS + t.DWELL_BOT;
  const totalSecs = segSecs * shots.length;

  const canvas = document.createElement("canvas");
  canvas.width = t.W; canvas.height = t.H;
  const ctx = canvas.getContext("2d");
  const topSize = crFitFont(ctx, topLines, t.TOP_SIZE);
  const botSize = crFitFont(ctx, botLines, t.BOT_SIZE);

  // siapkan audio (kalau ada): ukur durasi utk perilaku -shortest
  let audioEl = null, audioCtx = null, audioDest = null, audioDur = Infinity;
  if (audioDataUrl) {
    audioEl = new Audio(audioDataUrl);
    audioEl.preload = "auto";
    await new Promise((res) => { audioEl.onloadedmetadata = res; audioEl.onerror = res; });
    if (isFinite(audioEl.duration) && audioEl.duration > 0) audioDur = audioEl.duration;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(audioEl);
      audioDest = audioCtx.createMediaStreamDestination();
      src.connect(audioDest);
      src.connect(audioCtx.destination);
    } catch (e) { audioCtx = null; audioDest = null; }
  }
  const recSecs = Math.min(totalSecs, audioDur);

  const stream = canvas.captureStream(t.FPS);
  const tracks = [...stream.getVideoTracks()];
  if (audioDest) tracks.push(...audioDest.stream.getAudioTracks());
  const recStream = new MediaStream(tracks);
  const rec = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  // loop gambar berbasis waktu
  let rafId = 0, startT = 0, done = false;
  const drawSeg = (el) => {
    // clamp segIdx agar selalu valid (guard negatif & NaN)
    let segIdx = Math.floor(el / segSecs);
    if (!isFinite(segIdx) || segIdx < 0) segIdx = 0;
    if (segIdx >= shots.length) segIdx = shots.length - 1;
    const segT = Math.max(0, el - segIdx * segSecs);
    const s = shots[segIdx];
    // offset dalam px gambar skala: travel dihitung pd skala card, konversi ke crop src
    const offCard = crOffsetAt(segT, s.travel);
    const offSrc = s.scaledH > t.CARD_H ? offCard * (s.im.naturalHeight / s.scaledH) : 0;
    crDrawFrame(ctx, s.im, s.scaledH, offSrc, topLines, botLines, topSize, botSize);
    if (onProgress) onProgress(Math.min(1, Math.max(0, el / recSecs)));
  };
  const draw = (now) => {
    if (done) return;
    const el = (now - startT) / 1000;
    if (el >= recSecs) { done = true; return; }
    drawSeg(Math.max(0, el));
    rafId = requestAnimationFrame(draw);
  };

  // gambar frame pertama langsung (jangan tunggu rAF) agar stream ada isi
  drawSeg(0);
  rec.start(500);
  if (audioEl) { try { await audioCtx?.resume(); audioEl.play().catch(() => {}); } catch (e) {} }
  startT = performance.now();
  rafId = requestAnimationFrame(draw);

  await new Promise((res) => setTimeout(res, recSecs * 1000 + 400));
  done = true;
  cancelAnimationFrame(rafId);
  // pastikan frame terakhir tergambar sebelum recorder berhenti
  try { drawSeg(Math.max(0, recSecs - 0.05)); } catch (e) {}
  if (audioEl) audioEl.pause();
  if (rec.state !== "inactive") rec.stop();
  await stopped;
  if (audioCtx) audioCtx.close().catch(() => {});

  const blob = new Blob(chunks, { type: mime.split(";")[0] });
  if (!blob.size) throw new Error("Hasil rekaman kosong.");
  return { blob, ext, mime: blob.type };
}
