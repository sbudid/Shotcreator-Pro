/* ShotCreator web app — vanilla JS.
 * Konfigurasi AI (base_url, model, api_key) diset di server via env vars,
 * bukan oleh user. Frontend cuma kirim {story} ke /api/hooks.
 *
 * API contract:
 *   POST /api/hooks {story}
 *     -> {top_lines[], bot_lines[]}
 *   POST /api/jobs {images[], top_lines[], bot_lines[], audio?}
 *     -> {job_id}
 *   GET  /api/jobs/:id
 *     -> {status: "queued"|"rendering"|"done"|"error", progress?, video_url?, error?}
 */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  images: [],   // {id, name, dataUrl}
  audio: null,  // {name, dataUrl}
  pollTimer: null,
};

/* ---------- password gate (akses buyer berbayar) ---------- */
function getPass() { return sessionStorage.getItem("sc_pass") || ""; }
function apiHeaders(extra) {
  return Object.assign({ "X-App-Password": getPass() }, extra || {});
}
function showLock(bad) {
  if (bad) sessionStorage.removeItem("sc_pass");
  $("lockScreen").classList.remove("hidden");
  $("lockErr").classList.toggle("hidden", !bad);
  $("lockPass").value = "";
  setTimeout(() => $("lockPass").focus(), 100);
}
function hideLock() { $("lockScreen").classList.add("hidden"); }

async function tryUnlock() {
  const pw = $("lockPass").value.trim();
  if (!pw) return;
  $("lockBtn").disabled = true;
  try {
    // Password dicek server duluan untuk semua /api/hooks* → 401 kalau salah.
    const res = await fetch("/api/hooks-vision/__ping__", { headers: { "X-App-Password": pw } });
    if (res.status === 401) { showLock(true); return; }
    sessionStorage.setItem("sc_pass", pw);
    hideLock();
  } catch (err) {
    // Gangguan jaringan: jangan kunci paksa, biarkan request AI yang menentukan.
    sessionStorage.setItem("sc_pass", pw);
    hideLock();
  } finally {
    $("lockBtn").disabled = false;
  }
}

$("lockBtn").addEventListener("click", tryUnlock);
$("lockPass").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
if (!getPass()) showLock(false);

/* ---------- cek backend ---------- */
// Kalau /api/health tidak terjangkau, tampilkan peringatan di seksi AI.
(async function probeBackend() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch("/api/health", { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (e) {
    const hint = $("aiOfflineHint");
    if (hint) hint.hidden = false;
  }
})();

/* ---------- helpers ---------- */
function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
  el.classList.remove("hidden");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearStatus() { $("status").classList.add("hidden"); }

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Gagal membaca file " + file.name));
    r.readAsDataURL(file);
  });
}

function linesOf(id) {
  return $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
}

/* ---------- images ---------- */
$("imageInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    try {
      const dataUrl = await readAsDataURL(f);
      state.images.push({ id: Math.random().toString(36).slice(2), name: f.name, dataUrl });
    } catch (err) {
      setStatus(err.message, "error");
    }
  }
  e.target.value = "";
  renderThumbs();
});

function renderThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  state.images.forEach((img, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    const im = document.createElement("img");
    im.src = img.dataUrl;
    im.alt = img.name;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i + 1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.title = "Hapus gambar ini";
    btn.addEventListener("click", () => {
      state.images = state.images.filter((x) => x.id !== img.id);
      renderThumbs();
    });
    d.append(im, num, btn);
    box.appendChild(d);
  });
}

/* ---------- audio ---------- */
$("audioInput").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const dataUrl = await readAsDataURL(f);
    state.audio = { name: f.name, dataUrl };
    $("audioName").textContent = "🎵 " + f.name;
    $("audioInfo").classList.remove("hidden");
  } catch (err) {
    setStatus(err.message, "error");
  }
});
$("btnClearAudio").addEventListener("click", () => {
  state.audio = null;
  $("audioInfo").classList.add("hidden");
});

/* ---------- generate hooks (otomatis dari screenshot) ---------- */
$("btnGenHooks").addEventListener("click", async () => {
  const btn = $("btnGenHooks");
  btn.disabled = true;
  if (!state.images.length) {
    btn.disabled = false;
    return setStatus("Upload dulu minimal 1 screenshot di bagian 1.", "error");
  }
  // Vision: kirim screenshot, AI yang lihat dan buatkan hook
  setStatus("AI sedang melihat screenshot… (sekitar 1 menit)");
  try {
    const res = await fetch("/api/hooks-vision", {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        images: state.images.map((x) => ({ name: x.name, data_url: x.dataUrl })),
      }),
    });
    if (res.status === 401) {
      btn.disabled = false;
      showLock(true);
      return setStatus("Password salah / sesi berakhir. Masukkan password buyer.", "error");
    }
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try { const ed = await res.json(); if (ed && ed.error) detail += " — " + ed.error; } catch (_) {}
      throw new Error("server: " + detail);
    }
    const data = await res.json();
    if (data.top_lines && data.top_lines.length) {
      $("topLines").value = (data.top_lines || []).join("\n");
      $("botLines").value = (data.bot_lines || []).join("\n");
      setStatus("Hook berhasil dibuat dari screenshot. Cek & edit dulu kalau perlu.", "ok");
      btn.disabled = false;
      return;
    }
    if (data.error || !data.job_id) throw new Error(data.error || "job_id tidak ada");
    await pollVisionHooks(data.job_id);
  } catch (err) {
    setStatus("Gagal membuat hook: " + err.message, "error");
    btn.disabled = false;
  }
});

/* ---------- polling vision ---------- */
async function pollVisionHooks(jobId) {
  const btn = $("btnGenHooks");
  for (let i = 0; i < 40; i++) {  // maks ~2 menit
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch("/api/hooks-vision/" + encodeURIComponent(jobId), {
        headers: apiHeaders(),
      });
      if (res.status === 401) { showLock(true); throw new Error("password salah / sesi berakhir"); }
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === "done") {
        $("topLines").value = (data.top_lines || []).join("\n");
        $("botLines").value = (data.bot_lines || []).join("\n");
        setStatus("Hook berhasil dibuat dari screenshot. Cek & edit dulu kalau perlu.", "ok");
        btn.disabled = false;
        return;
      }
      if (data.status === "error") throw new Error(data.error || "gagal");
      setStatus(`AI sedang melihat screenshot… (${i * 3} detik)`);
    } catch (err) {
      if (err.message && !err.message.includes("HTTP")) throw err;
    }
  }
  setStatus("AI-nya kelamaan. Coba lagi atau pakai mode teks.", "error");
  btn.disabled = false;
}

/* ---------- render job ---------- */
const STATUS_LABEL = {
  queued: "⏳ Menunggu antrean…",
  rendering: "🎞️ Merender video…",
  done: "✅ Selesai!",
  error: "❌ Gagal",
};

$("btnRender").addEventListener("click", async () => {
  clearStatus();
  if (!state.images.length) return setStatus("Upload dulu minimal 1 screenshot.", "error");

  const top = linesOf("topLines");
  const bot = linesOf("botLines");

  if (!top.length || !bot.length) {
    return setStatus(
      "Isi teks hook atas & bawah — ketik manual, atau centang AI lalu klik \u201cBuatkan hook\u201d.",
      "error"
    );
  }

  const btn = $("btnRender");
  btn.disabled = true;
  $("jobCard").classList.remove("hidden");
  $("preview").classList.add("hidden");
  $("btnDownload").classList.add("hidden");
  setJobStatus("rendering", 0);
  setStatus("🎞️ Merender di perangkatmu… jangan tutup tab ini.", "");

  // Render 100% di browser — tanpa server.
  try {
    const { blob, ext } = await crRender({
      images: state.images.map((x) => x.dataUrl),
      topLines: top,
      botLines: bot,
      audioDataUrl: state.audio ? state.audio.dataUrl : null,
      onProgress: (p) => setJobStatus("rendering", Math.round(p * 100)),
    });
    const url = URL.createObjectURL(blob);
    const fname = "shotcreator." + ext;
    $("preview").src = url;
    $("preview").classList.remove("hidden");
    const dl = $("btnDownload");
    dl.href = url;
    dl.download = fname;
    dl.classList.remove("hidden");
    setJobStatus("done", 100);
    setStatus(`Video selesai! Format ${ext.toUpperCase()} — putar preview atau download.`, "ok");
    $("jobCard").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    setJobStatus("error", 0);
    setStatus("Render gagal: " + err.message, "error");
  }
  btn.disabled = false;
});

function setJobStatus(status, progress) {
  $("jobLabel").textContent = STATUS_LABEL[status] || status;
  $("progressBar").style.width = Math.max(0, Math.min(100, progress || 0)) + "%";
}
