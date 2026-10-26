/* Image Squeeze — every image is decoded and re-encoded locally with <canvas>. Nothing is uploaded. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  // Browsers refuse canvases past ~16k px a side (and iOS past ~16 MP); stay well inside.
  const MAX_SIDE = 16384, MAX_AREA = 40e6;
  const MIME = { jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", png: "image/png" };
  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
  const saved = S3.store("squeeze") || {};
  const opts = { format: saved.format || "keep", quality: saved.quality || 80, max: saved.max || "", keepSmaller: saved.keepSmaller !== false };
  const enc = { "image/jpeg": true, "image/png": true, "image/webp": false, "image/avif": false };
  let items = [], run = 0, queue = Promise.resolve(), selected = null, nextId = 1;

  // ---------- pipeline (pure, used by the UI and the self-test) ----------
  function canEncode(type) {
    return new Promise(res => { const c = document.createElement("canvas"); c.width = c.height = 2; c.toBlob(b => res(!!b && b.type === type), type, 0.5); });
  }
  function loadImage(blob) {
    const url = URL.createObjectURL(blob), img = new Image();
    img.src = url;
    return img.decode().then(() => {
      if (!img.naturalWidth) throw new Error("empty");
      img._url = url; return img;
    }).catch(() => { URL.revokeObjectURL(url); throw new Error("Can't read this image (unsupported or damaged)"); });
  }
  function fitSize(w, h, max) {
    let s = 1, note = "";
    if (max && Math.max(w, h) > max) s = max / Math.max(w, h);
    if (w * h * s * s > MAX_AREA) { s = Math.sqrt(MAX_AREA / (w * h)); note = "scaled to fit the browser's canvas limit"; }
    if (Math.max(w, h) * s > MAX_SIDE) { s = MAX_SIDE / Math.max(w, h); note = "scaled to fit the browser's canvas limit"; }
    return { w: Math.max(1, Math.floor(w * s + 1e-6)), h: Math.max(1, Math.floor(h * s + 1e-6)), note };
  }
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  // High-quality downscale: halve step by step, then one final smooth draw.
  function resample(src, sw, sh, tw, th, bg) {
    let cur = src, cw = sw, ch = sh;
    while (cw / 2 >= tw && ch / 2 >= th) {
      const c = canvas(Math.round(cw / 2), Math.round(ch / 2)), x = c.getContext("2d");
      x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; cw = c.width; ch = c.height;
    }
    const out = canvas(tw, th), x = out.getContext("2d");
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, tw, th); }
    x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, tw, th);
    return out;
  }
  function toBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("The browser could not encode this image (too large?)")), type, q));
  }
  function outType(inType, format) {
    if (format !== "keep") return MIME[format];
    if (enc[inType]) return inType;
    return inType === "image/avif" && enc["image/webp"] ? "image/webp" : "image/png";
  }
  async function squeeze(file, img, o) {
    const type = outType(file.type, o.format);
    const nw = img.naturalWidth, nh = img.naturalHeight, f = fitSize(nw, nh, +o.max || 0);
    const c = resample(img, nw, nh, f.w, f.h, type === "image/jpeg" ? "#ffffff" : null);
    const blob = await toBlob(c, type, o.quality / 100);
    if (blob.type !== type) throw new Error("This browser can't write " + (EXT[type] || type).toUpperCase());
    const same = o.keepSmaller && type === file.type && f.w === nw && f.h === nh && blob.size >= file.size;
    return { blob: same ? file : blob, type, w: f.w, h: f.h, kept: same, note: f.note };
  }
  function outName(name, type) { return name.replace(/\.[^.]+$/, "") + "." + EXT[type]; }

  // ---------- UI ----------
  const list = $("#list"), viewer = $("#viewer"), before = $("#before"), after = $("#after");

  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
    });
  }
  function save() { S3.store("squeeze", opts); }
  function pct(a, b) { return Math.round((1 - b / a) * 100); }

  function addFiles(files) {
    const fresh = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name)).map(f => ({ id: nextId++, file: f }));
    if (!fresh.length) return Promise.resolve();
    items = items.concat(fresh);
    fresh.forEach(it => { it.el = S3.h("li", { "class": "sq-item", tabindex: "0" }); list.appendChild(it.el); renderItem(it); });
    refresh();
    return Promise.all(fresh.map(it => enqueue(it, run)));
  }
  function enqueue(it, myRun) { queue = queue.then(() => processItem(it, myRun)); return queue; }
  async function processItem(it, myRun) {
    if (myRun !== run || items.indexOf(it) < 0 || it.bad) return;
    it.busy = true; renderItem(it);
    try {
      if (!it.img) it.img = await loadImage(it.file);
      const r = await squeeze(it.file, it.img, opts);
      if (myRun !== run || items.indexOf(it) < 0) return;
      if (it.res) URL.revokeObjectURL(it.res.url);
      r.url = URL.createObjectURL(r.blob); it.res = r; it.err = null;
      if (!selected) select(it); else if (selected === it) showCompare();
    } catch (e) {
      it.err = e.message || "Failed"; it.bad = !it.img;
    } finally { it.busy = false; renderItem(it); refresh(); }
  }
  function reprocess() {
    save(); run++;
    const my = run;
    items.forEach(it => { if (!it.bad) { it.busy = true; renderItem(it); } });
    return Promise.all(items.map(it => enqueue(it, my))).then(() => { if (items.some(it => it.res)) S3.done(); });
  }

  function renderItem(it) {
    const r = it.res, f = it.file, el = it.el;
    el.classList.toggle("is-sel", it === selected);
    let meta, size, chip;
    if (it.err) {
      meta = '<span class="faint">' + S3.esc(it.err) + "</span>"; size = ""; chip = '<span class="chip bad">Error</span>';
    } else if (!r || it.busy) {
      meta = '<span class="faint">Squeezing…</span>'; size = '<span class="faint">' + S3.fmtBytes(f.size) + "</span>"; chip = '<span class="chip">…</span>';
    } else {
      const p = pct(f.size, r.blob.size);
      meta = '<span class="faint">' + (it.img.naturalWidth === r.w ? r.w + "×" + r.h : it.img.naturalWidth + "×" + it.img.naturalHeight + " → " + r.w + "×" + r.h) +
        " · " + EXT[r.type].toUpperCase() + (r.kept ? " · original kept" : "") + (r.note ? " · " + S3.esc(r.note) : "") + "</span>";
      size = '<span class="faint">' + S3.fmtBytes(f.size) + " →</span><b>" + S3.fmtBytes(r.blob.size) + "</b>";
      chip = '<span class="chip ' + (p > 0 ? "ok" : p < 0 ? "warn" : "") + '">' + (p > 0 ? "−" + p + "%" : p < 0 ? "+" + -p + "%" : "0%") + "</span>";
    }
    el.innerHTML = (it.img ? '<img class="sq-thumb" alt="" src="' + it.img._url + '">' : '<span class="sq-thumb"></span>') +
      '<div class="sq-info"><b title="' + S3.esc(f.name) + '">' + S3.esc(f.name) + "</b>" + meta + "</div>" +
      '<div class="sq-size">' + size + "</div>" + chip +
      '<button class="btn small icon" data-dl aria-label="Download ' + S3.esc(f.name) + '"' + (r && !it.busy ? "" : " disabled") + '><svg class="i"><use href="#i-download"/></svg></button>' +
      '<button class="btn ghost small icon" data-rm aria-label="Remove ' + S3.esc(f.name) + '"><svg class="i"><use href="#i-x"/></svg></button>';
  }
  function refresh() {
    const done = items.filter(it => it.res && !it.err);
    $("#empty").hidden = items.length > 0;
    $("#count").textContent = items.length ? items.length + (items.length === 1 ? " image" : " images") : "";
    $("#zip").disabled = !done.length; $("#clear").disabled = !items.length;
    const tb = $("#totals");
    tb.hidden = !done.length;
    if (done.length) {
      const a = done.reduce((s, it) => s + it.file.size, 0), b = done.reduce((s, it) => s + it.res.blob.size, 0);
      tb.innerHTML = stat("before", S3.fmtBytes(a)) + stat("after", S3.fmtBytes(b)) + stat("saved", (pct(a, b) > 0 ? pct(a, b) : 0) + "%");
    }
    viewer.hidden = !selected || !selected.res;
  }
  function stat(label, v) { return '<div class="stat"><b>' + S3.esc(v) + "</b><span>" + label + "</span></div>"; }
  function select(it) {
    const old = selected; selected = it;
    if (old && old.el) renderItem(old);
    if (it) { renderItem(it); showCompare(); }
    refresh();
  }
  function showCompare() {
    if (!selected || !selected.res) return;
    before.src = selected.img._url; after.src = selected.res.url;
  }
  function setSplit(p) {
    p = Math.max(0, Math.min(100, p));
    before.style.clipPath = "inset(0 " + (100 - p) + "% 0 0)";
    $("#bar").style.left = p + "%"; $("#cmpRange").value = p;
  }
  function remove(it) {
    items = items.filter(x => x !== it); it.el.remove();
    if (it.img) URL.revokeObjectURL(it.img._url);
    if (it.res) URL.revokeObjectURL(it.res.url);
    if (selected === it) { selected = null; select(items.filter(x => x.res)[0] || null); }
    refresh();
  }

  list.addEventListener("click", e => {
    const li = e.target.closest(".sq-item"); if (!li) return;
    const it = items.filter(x => x.el === li)[0]; if (!it) return;
    if (e.target.closest("[data-rm]")) return remove(it);
    if (e.target.closest("[data-dl]")) { S3.download(it.res.blob, outName(it.file.name, it.res.type)); S3.done(); return; }
    if (it.res) select(it);
  });
  list.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("sq-item")) { e.preventDefault(); e.target.click(); } });

  const cmpIn = $("#cmpIn");
  function fromPointer(e) { const r = cmpIn.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width * 100); }
  cmpIn.addEventListener("pointerdown", e => { cmpIn.setPointerCapture(e.pointerId); fromPointer(e); });
  cmpIn.addEventListener("pointermove", e => { if (cmpIn.hasPointerCapture(e.pointerId)) fromPointer(e); });
  $("#cmpRange").addEventListener("input", e => setSplit(+e.target.value));

  S3.drop($("#drop"), addFiles, { accept: "image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif", multiple: true });
  document.addEventListener("paste", e => {
    const fs = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (fs.length) { e.preventDefault(); addFiles(fs.map((f, i) => f.name && f.name !== "image.png" ? f : new File([f], "pasted-" + (i + 1) + "." + (f.type.split("/")[1] || "png"), { type: f.type }))); }
  });

  const q = $("#quality"), qv = $("#qv"), redo = S3.debounce(reprocess, 300);
  q.value = opts.quality; qv.textContent = opts.quality + "%";
  q.addEventListener("input", () => { opts.quality = +q.value; qv.textContent = q.value + "%"; redo(); });
  $("#max").value = opts.max;
  $("#max").addEventListener("change", e => { opts.max = e.target.value; reprocess(); });
  $("#keepSmaller").checked = opts.keepSmaller;
  $("#keepSmaller").addEventListener("change", e => { opts.keepSmaller = e.target.checked; reprocess(); });
  $("#clear").addEventListener("click", () => { items.slice().forEach(remove); run++; });
  $("#zip").addEventListener("click", async () => {
    const used = {}, files = [];
    for (const it of items) {
      if (!it.res || it.err) continue;
      let n = outName(it.file.name, it.res.type);
      while (used[n.toLowerCase()]) n = n.replace(/(\.[^.]+)$/, "-" + (used[n.toLowerCase()]++) + "$1");
      used[n.toLowerCase()] = 1;
      files.push({ name: n, data: new Uint8Array(await it.res.blob.arrayBuffer()) });
    }
    S3.download(S3.zip(files), "squeezed-images.zip"); S3.done();
  });

  // Feature-detect encoders, then show AVIF only where the browser can really write it.
  const ready = Promise.all(Object.keys(enc).map(t => canEncode(t).then(ok => { enc[t] = ok; }))).then(() => {
    $("#format [data-v=avif]").hidden = !enc["image/avif"];
    $("#format [data-v=webp]").hidden = !enc["image/webp"];
    if (!enc[MIME[opts.format]] && opts.format !== "keep") opts.format = "keep";
    seg($("#format"), opts.format, v => { opts.format = v; reprocess(); });
  });

  // ---------- sample image (drawn locally, no remote files) ----------
  function sampleCanvas(w, h, alpha) {
    const c = canvas(w, h), x = c.getContext("2d");
    const sky = x.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#14204f"); sky.addColorStop(0.5, "#d85c7f"); sky.addColorStop(1, "#ffb56b");
    x.fillStyle = sky; x.fillRect(0, 0, w, h);
    x.fillStyle = "#ffe3a1"; x.beginPath(); x.arc(w * 0.68, h * 0.56, h * 0.13, 0, Math.PI * 2); x.fill();
    [["#3b2c5e", 0.64, 5], ["#2a2049", 0.74, 8], ["#151231", 0.86, 12]].forEach((m, i) => {
      x.fillStyle = m[0]; x.beginPath(); x.moveTo(0, h);
      for (let k = 0, px = 0; k <= 60; k++, px = w * k / 60) x.lineTo(px, h * m[1] - Math.abs(Math.sin(px / w * m[2] + i)) * h * (0.16 - i * 0.04));
      x.lineTo(w, h); x.fill();
    });
    const d = x.getImageData(0, 0, w, h), p = d.data;
    let s = 7;
    for (let i = 0; i < p.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s % 17) - 8; p[i] += n; p[i + 1] += n; p[i + 2] += n;
      if (alpha && (i / 4) % w < w / 3) p[i + 3] = 0;
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  async function sampleFile(name, w, h, type, alpha) { return new File([await toBlob(sampleCanvas(w, h, alpha), type, 0.95)], name, { type }); }

  window.S3_DEMO = async function () {
    await ready;
    const wb = $("#format [data-v=webp]"); if (!wb.hidden) wb.click();
    await addFiles([await sampleFile("sunset-beach.png", 1600, 1000, "image/png"), await sampleFile("mountain-trip.jpg", 2400, 1500, "image/jpeg"), await sampleFile("hero-banner.png", 1200, 600, "image/png")]);
    setSplit(42);
  };

  // Self-test run by scripts/smoke.py: real encode round-trips on generated images.
  window.S3_SELFTEST = async function () {
    await ready;
    const png = await sampleFile("t.png", 1200, 800, "image/png");
    const img = await loadImage(png);
    // 1) JPEG at max 600 px: right size, real JPEG bytes, smaller than the PNG.
    const a = await squeeze(png, img, { format: "jpeg", quality: 70, max: 600, keepSmaller: true });
    const ab = new Uint8Array(await a.blob.arrayBuffer());
    const aImg = await loadImage(a.blob);
    const ok1 = a.type === "image/jpeg" && ab[0] === 0xFF && ab[1] === 0xD8 && aImg.naturalWidth === 600 && aImg.naturalHeight === 400 && a.blob.size < png.size;
    // 2) Transparency: PNG kept as PNG keeps alpha; JPEG gets a white background.
    const tp = await sampleFile("a.png", 300, 200, "image/png", true), tImg = await loadImage(tp);
    const k = await squeeze(tp, tImg, { format: "keep", quality: 80, max: "", keepSmaller: false });
    const j = await squeeze(tp, tImg, { format: "jpeg", quality: 90, max: "", keepSmaller: false });
    const px = async b => { const im = await loadImage(b), c = canvas(im.naturalWidth, im.naturalHeight), x = c.getContext("2d"); x.drawImage(im, 0, 0); return x.getImageData(10, 100, 1, 1).data; };
    const kp = await px(k.blob), jp = await px(j.blob);
    const ok2 = k.type === "image/png" && kp[3] === 0 && jp[0] > 245 && jp[1] > 245 && jp[2] > 245;
    // 3) Size maths and the "keep original if smaller" rule.
    const f = fitSize(30000, 20000, 0);
    const big = await squeeze(a.blob.size ? new File([a.blob], "x.jpg", { type: "image/jpeg" }) : png, aImg, { format: "keep", quality: 100, max: "", keepSmaller: true });
    const ok3 = f.w * f.h <= MAX_AREA && f.note && fitSize(4000, 3000, 1000).w === 1000 && fitSize(4000, 3000, 1000).h === 750 &&
      big.kept && big.blob.size === a.blob.size && outName("my.photo.PNG", "image/webp") === "my.photo.webp";
    return (ok1 && ok2 && ok3) || { ok1, ok2, ok3, a: [a.type, aImg.naturalWidth, aImg.naturalHeight, a.blob.size, png.size], kp: [].slice.call(kp), jp: [].slice.call(jp), big: [big.kept, big.blob.size] };
  };
})();
