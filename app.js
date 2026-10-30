import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const QUALITY = {
  high: { maxEdge: 2400, jpeg: 0.92 },
  balanced: { maxEdge: 1800, jpeg: 0.78 },
  compact: { maxEdge: 1400, jpeg: 0.62 },
};

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {'original' | 'greyscale' | 'bw' | 'cleanup'} ProcessMode
 * @typedef {{
 *   id: string,
 *   rotation: number,
 *   sourceUrl: string,
 *   objectUrl: string,
 *   displayUrl: string,
 *   mode: ProcessMode,
 *   flattened: boolean,
 *   corners: Point[] | null,
 * }} Page
 */

const PROCESS_MODES = [
  { value: "original", label: "Original", title: "No filter — keep the photo as captured" },
  { value: "greyscale", label: "Greyscale", title: "Convert to greyscale" },
  {
    value: "bw",
    label: "Black & white",
    title: "High-contrast document black & white",
  },
  {
    value: "cleanup",
    label: "Clean paper",
    title: "Whitish background, darker text (heuristic scanner cleanup)",
  },
];

/** @type {Page[]} */
let pages = [];
/** @type {string[]} */
let cropQueue = [];
let cameraStream = null;
/** @type {BeforeInstallPromptEvent | null} */
let deferredInstall = null;

/** @type {Page | null} */
let cropPage = null;
/** @type {Point[]} */
let cropCorners = [];
let dragCorner = -1;
/** Hovered corner for desktop loupe preview (-1 = none). */
let hoverCorner = -1;
/** True while the active loupe drag/hover is from touch/pen (larger finger occlusion). */
let loupeIsTouch = false;
let imageNatural = { w: 1, h: 1 };

const LOUPE_SIZE = 128;
const LOUPE_ZOOM = 3;

const els = {
  emptyState: document.getElementById("emptyState"),
  workspace: document.getElementById("workspace"),
  pageList: document.getElementById("pageList"),
  status: document.getElementById("status"),
  modeSelect: document.getElementById("modeSelect"),
  qualitySelect: document.getElementById("qualitySelect"),
  filenameInput: document.getElementById("filenameInput"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  cameraBtn: document.getElementById("cameraBtn"),
  addCameraBtn: document.getElementById("addCameraBtn"),
  fileInput: document.getElementById("fileInput"),
  addFileInput: document.getElementById("addFileInput"),
  installBtn: document.getElementById("installBtn"),
  cameraDialog: document.getElementById("cameraDialog"),
  liveVideo: document.getElementById("liveVideo"),
  shutterBtn: document.getElementById("shutterBtn"),
  closeCameraBtn: document.getElementById("closeCameraBtn"),
  workCanvas: document.getElementById("workCanvas"),
  cropDialog: document.getElementById("cropDialog"),
  cropStage: document.getElementById("cropStage"),
  cropFrame: document.getElementById("cropFrame"),
  cropImage: document.getElementById("cropImage"),
  cropOverlay: document.getElementById("cropOverlay"),
  cropPoly: document.getElementById("cropPoly"),
  cropApplyBtn: document.getElementById("cropApplyBtn"),
  cropCancelBtn: document.getElementById("cropCancelBtn"),
  cropResetBtn: document.getElementById("cropResetBtn"),
  cropLoupe: document.getElementById("cropLoupe"),
  saveRow: document.getElementById("saveRow"),
  saveLink: document.getElementById("saveLink"),
  openLink: document.getElementById("openLink"),
  shareBtn: document.getElementById("shareBtn"),
};

/** @type {string | null} */
let lastPdfUrl = null;
/** @type {Blob | null} */
let lastPdfBlob = null;
/** @type {string} */
let lastPdfName = "PrivateScan.pdf";

function uid() {
  return crypto.randomUUID?.() ?? `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(message) {
  els.status.textContent = message || "";
}

function syncView() {
  const hasPages = pages.length > 0;
  els.emptyState.hidden = hasPages;
  els.workspace.hidden = !hasPages;
  renderPages();
}

function revokeUrl(url) {
  if (url) URL.revokeObjectURL(url);
}

function revokePage(page) {
  if (page.displayUrl && page.displayUrl !== page.objectUrl && page.displayUrl !== page.sourceUrl) {
    revokeUrl(page.displayUrl);
  }
  if (page.objectUrl && page.objectUrl !== page.sourceUrl) {
    revokeUrl(page.objectUrl);
  }
  revokeUrl(page.sourceUrl);
}

function revokeDisplayOnly(page) {
  if (
    page.displayUrl &&
    page.displayUrl !== page.objectUrl &&
    page.displayUrl !== page.sourceUrl
  ) {
    revokeUrl(page.displayUrl);
  }
  page.displayUrl = page.objectUrl;
}

function defaultCorners(w, h) {
  const ix = w * 0.08;
  const iy = h * 0.08;
  return [
    { x: ix, y: iy },
    { x: w - ix, y: iy },
    { x: w - ix, y: h - iy },
    { x: ix, y: h - iy },
  ];
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function defaultProcessMode() {
  const v = els.modeSelect?.value;
  if (v === "greyscale" || v === "bw" || v === "cleanup" || v === "original") {
    return v;
  }
  return "original";
}

function addImageBlobs(blobs, { openCrop = true } = {}) {
  const newIds = [];
  const mode = defaultProcessMode();
  for (const blob of blobs) {
    const sourceUrl = URL.createObjectURL(blob);
    const page = {
      id: uid(),
      rotation: 0,
      sourceUrl,
      objectUrl: sourceUrl,
      displayUrl: sourceUrl,
      mode,
      flattened: false,
      corners: null,
    };
    pages.push(page);
    newIds.push(page.id);
  }
  syncView();
  setStatus(`${pages.length} page${pages.length === 1 ? "" : "s"} ready — adjust edges on each photo.`);
  if (openCrop) {
    cropQueue.push(...newIds);
    pumpCropQueue();
  }
}

async function filesToPages(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length) {
    setStatus("No images selected.");
    return;
  }
  addImageBlobs(files);
}

function renderPages() {
  els.pageList.innerHTML = "";
  pages.forEach((page, index) => {
    const card = document.createElement("article");
    card.className = `page-card${page.flattened ? "" : " is-raw"}`;
    card.style.animationDelay = `${Math.min(index, 8) * 40}ms`;

    const img = document.createElement("img");
    img.src = page.displayUrl || page.objectUrl;
    img.alt = `Page ${index + 1}`;
    img.style.transform = `rotate(${page.rotation}deg)`;

    const meta = document.createElement("div");
    meta.className = "page-meta";

    const label = document.createElement("span");
    label.innerHTML = `Page ${index + 1}${
      page.flattened ? "" : ' <span class="badge">edges</span>'
    }`;

    const controls = document.createElement("div");
    controls.className = "page-controls";

    const makeBtn = (title, text, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-btn";
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.textContent = text;
      btn.addEventListener("click", onClick);
      return btn;
    };

    controls.append(
      makeBtn("Adjust page edges", "▦", () => openCropEditor(page.id)),
      makeBtn("Move left", "←", () => movePage(index, -1)),
      makeBtn("Move right", "→", () => movePage(index, 1)),
      makeBtn("Rotate", "⟳", () => {
        page.rotation = (page.rotation + 90) % 360;
        renderPages();
      }),
      makeBtn("Delete", "✕", () => {
        revokePage(page);
        pages.splice(index, 1);
        cropQueue = cropQueue.filter((id) => id !== page.id);
        syncView();
        setStatus(pages.length ? `${pages.length} page(s) left.` : "");
      })
    );

    const processRow = document.createElement("div");
    processRow.className = "page-process";
    const processLabel = document.createElement("label");
    processLabel.className = "page-process-label";
    const selectId = `pageMode-${page.id}`;
    processLabel.htmlFor = selectId;
    processLabel.textContent = "Processing";
    const processSelect = document.createElement("select");
    processSelect.id = selectId;
    processSelect.className = "page-mode-select";
    processSelect.setAttribute("aria-label", `Processing for page ${index + 1}`);
    for (const opt of PROCESS_MODES) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.title) option.title = opt.title;
      if (opt.value === page.mode) option.selected = true;
      processSelect.append(option);
    }
    processSelect.addEventListener("change", () => {
      void setPageMode(page.id, /** @type {ProcessMode} */ (processSelect.value));
    });
    processRow.append(processLabel, processSelect);

    meta.append(label, controls);
    card.append(img, meta, processRow);
    els.pageList.append(card);
  });
}

/**
 * Apply processing mode and refresh the on-card preview (on-device canvas).
 * @param {string} pageId
 * @param {ProcessMode} mode
 */
async function setPageMode(pageId, mode) {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return;
  page.mode = mode;
  setStatus(
    mode === "original"
      ? "Showing original (no filter)."
      : `Applying “${PROCESS_MODES.find((m) => m.value === mode)?.label || mode}”…`
  );
  try {
    await refreshPagePreview(page);
    renderPages();
    setStatus(
      mode === "original"
        ? "Page uses original colours — filtration optional."
        : `Page preview updated · ${PROCESS_MODES.find((m) => m.value === mode)?.label}.`
    );
  } catch (err) {
    console.error(err);
    setStatus("Could not update page preview.");
  }
}

async function applyModeToAllPages(mode) {
  for (const page of pages) {
    page.mode = mode;
  }
  setStatus("Updating page previews…");
  try {
    await Promise.all(pages.map((p) => refreshPagePreview(p)));
    renderPages();
    setStatus(
      mode === "original"
        ? "All pages set to Original (no filter)."
        : `All pages set to ${PROCESS_MODES.find((m) => m.value === mode)?.label || mode}.`
    );
  } catch (err) {
    console.error(err);
    setStatus("Could not update all previews.");
    renderPages();
  }
}

/**
 * Build filtered preview blob from the unfiltered objectUrl.
 * @param {Page} page
 */
async function refreshPagePreview(page) {
  revokeDisplayOnly(page);
  if (!page.mode || page.mode === "original") {
    page.displayUrl = page.objectUrl;
    return;
  }
  const img = await loadImage(page.objectUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) {
    page.displayUrl = page.objectUrl;
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  applyMode(ctx, w, h, page.mode);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Preview encode failed"))),
      "image/jpeg",
      0.88
    )
  );
  page.displayUrl = URL.createObjectURL(blob);
}

function movePage(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= pages.length) return;
  const [item] = pages.splice(index, 1);
  pages.splice(next, 0, item);
  renderPages();
}

function pumpCropQueue() {
  if (els.cropDialog.open || !cropQueue.length) return;
  const id = cropQueue.shift();
  openCropEditor(id);
}

async function openCropEditor(pageId) {
  const page = pages.find((p) => p.id === pageId);
  if (!page) {
    pumpCropQueue();
    return;
  }
  cropPage = page;
  dragCorner = -1;
  hoverCorner = -1;
  loupeIsTouch = false;
  hideCropLoupe();
  const img = await loadImage(page.sourceUrl);
  imageNatural = { w: img.naturalWidth, h: img.naturalHeight };
  cropCorners = page.corners
    ? page.corners.map((c) => ({ ...c }))
    : defaultCorners(imageNatural.w, imageNatural.h);

  const paintOverlay = () => {
    layoutCropOverlay();
    drawCropOverlay();
  };
  els.cropImage.onload = () => {
    paintOverlay();
    requestAnimationFrame(() => requestAnimationFrame(paintOverlay));
  };
  els.cropImage.src = page.sourceUrl;
  if (!els.cropDialog.open) els.cropDialog.showModal();
  if (els.cropImage.complete) {
    paintOverlay();
    requestAnimationFrame(() => requestAnimationFrame(paintOverlay));
  }
}

function layoutCropOverlay() {
  const frame = els.cropFrame.getBoundingClientRect();
  els.cropOverlay.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
  els.cropOverlay.setAttribute("width", String(frame.width));
  els.cropOverlay.setAttribute("height", String(frame.height));
}

function getDisplayMetrics() {
  const frame = els.cropFrame.getBoundingClientRect();
  const ok =
    frame.width > 40 &&
    frame.height > 40 &&
    imageNatural.w > 1 &&
    imageNatural.h > 1;
  const scaleX = ok ? frame.width / imageNatural.w : 1;
  const scaleY = ok ? frame.height / imageNatural.h : 1;
  return { scaleX, scaleY, frame, ok };
}

function imageToDisplay(p) {
  const m = getDisplayMetrics();
  return {
    x: p.x * m.scaleX,
    y: p.y * m.scaleY,
  };
}

function displayToImage(x, y) {
  const m = getDisplayMetrics();
  if (!m.ok) return null;
  return {
    x: Math.max(0, Math.min(imageNatural.w, x / m.scaleX)),
    y: Math.max(0, Math.min(imageNatural.h, y / m.scaleY)),
  };
}

function drawCropOverlay() {
  layoutCropOverlay();
  const points = cropCorners.map(imageToDisplay);
  els.cropPoly.setAttribute(
    "points",
    points.map((p) => `${p.x},${p.y}`).join(" ")
  );
  const activeIdx = dragCorner >= 0 ? dragCorner : -1;
  const handles = els.cropOverlay.querySelectorAll(".crop-handle");
  handles.forEach((handle, i) => {
    handle.setAttribute("cx", String(points[i].x));
    handle.setAttribute("cy", String(points[i].y));
    // Dim the handle under the finger so the loupe (not the knob) is the focus.
    handle.classList.toggle("is-occluded", activeIdx === i && loupeIsTouch);
    handle.classList.toggle("is-active", activeIdx === i);
  });
  refreshCropLoupe();
}

function hideCropLoupe() {
  if (!els.cropLoupe) return;
  els.cropLoupe.hidden = true;
  els.cropLoupe.classList.remove("is-touch");
}

/**
 * Lock loupe to the opposite quadrant of the crop frame from the active corner.
 * Never centers on the touch/pointer — finger occlusion stays on the handle.
 * Position is stable for the whole drag (only loupe content tracks the corner).
 */
function loupeOffsetForCorner(cornerIdx, frameW, frameH, isTouch) {
  const size = LOUPE_SIZE;
  // Touch needs more inset from edges / system chrome; mouse can sit tighter.
  const pad = isTouch ? 18 : 10;
  // Keep the loupe fully inside the crop frame when the stage is large enough.
  const maxX = Math.max(0, frameW - size);
  const maxY = Math.max(0, frameH - size);
  const left = Math.min(pad, maxX);
  const top = Math.min(pad, maxY);
  const right = Math.max(0, maxX - Math.min(pad, maxX));
  const bottom = Math.max(0, maxY - Math.min(pad, maxY));
  // Corner → opposite stage quadrant: TL→BR, TR→BL, BR→TL, BL→TR
  const anchors = [
    { x: right, y: bottom },
    { x: left, y: bottom },
    { x: left, y: top },
    { x: right, y: top },
  ];
  const chosen = anchors[cornerIdx] || { x: left, y: top };
  return {
    x: Math.max(0, Math.min(maxX, chosen.x)),
    y: Math.max(0, Math.min(maxY, chosen.y)),
  };
}

function drawCropLoupeContent(corner) {
  const canvas = els.cropLoupe;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const size = LOUPE_SIZE;
  const zoom = LOUPE_ZOOM;
  const img = els.cropImage;

  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = "#05090e";
  ctx.fillRect(0, 0, size, size);

  if (img.complete && imageNatural.w > 1 && imageNatural.h > 1) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      img,
      0,
      0,
      imageNatural.w,
      imageNatural.h,
      size / 2 - corner.x * zoom,
      size / 2 - corner.y * zoom,
      imageNatural.w * zoom,
      imageNatural.h * zoom
    );
  }

  // Crosshair aligned with the exact corner point (canvas center).
  ctx.strokeStyle = "rgba(243, 240, 234, 0.88)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(size / 2, 10);
  ctx.lineTo(size / 2, size / 2 - 7);
  ctx.moveTo(size / 2, size / 2 + 7);
  ctx.lineTo(size / 2, size - 10);
  ctx.moveTo(10, size / 2);
  ctx.lineTo(size / 2 - 7, size / 2);
  ctx.moveTo(size / 2 + 7, size / 2);
  ctx.lineTo(size - 10, size / 2);
  ctx.stroke();

  ctx.fillStyle = "#7ec8d6";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 2.75, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(126, 200, 214, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function refreshCropLoupe() {
  const cornerIdx = dragCorner >= 0 ? dragCorner : hoverCorner;
  if (cornerIdx < 0 || !els.cropLoupe || !els.cropDialog.open) {
    hideCropLoupe();
    return;
  }
  if (!getDisplayMetrics().ok || !cropCorners[cornerIdx]) {
    hideCropLoupe();
    return;
  }

  const corner = cropCorners[cornerIdx];
  const frame = els.cropFrame.getBoundingClientRect();
  const pos = loupeOffsetForCorner(
    cornerIdx,
    frame.width,
    frame.height,
    loupeIsTouch
  );

  drawCropLoupeContent(corner);
  els.cropLoupe.classList.toggle("is-touch", loupeIsTouch);
  els.cropLoupe.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  els.cropLoupe.hidden = false;
}

function pointerPosInStage(event) {
  const frame = els.cropFrame.getBoundingClientRect();
  const src = event.touches ? event.touches[0] : event;
  return { x: src.clientX - frame.left, y: src.clientY - frame.top };
}

function onCropPointerDown(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const handle = target.closest(".crop-handle");
  if (!handle) return;
  if (!getDisplayMetrics().ok) return;
  event.preventDefault();
  dragCorner = Number(handle.getAttribute("data-corner"));
  hoverCorner = dragCorner;
  loupeIsTouch = event.pointerType === "touch" || event.pointerType === "pen";
  try {
    handle.setPointerCapture?.(event.pointerId);
  } catch {
    /* ignore capture failures on older browsers */
  }
  drawCropOverlay();
}

function onCropPointerMove(event) {
  if (dragCorner >= 0) {
    event.preventDefault();
    const pos = pointerPosInStage(event);
    const next = displayToImage(pos.x, pos.y);
    if (!next) return;
    cropCorners[dragCorner] = next;
    drawCropOverlay();
    return;
  }

  // Desktop hover preview while not dragging.
  if (event.pointerType === "mouse" && els.cropDialog.open) {
    loupeIsTouch = false;
    const target = event.target;
    const handle =
      target instanceof Element ? target.closest(".crop-handle") : null;
    const nextHover = handle
      ? Number(handle.getAttribute("data-corner"))
      : -1;
    if (nextHover !== hoverCorner) {
      hoverCorner = nextHover;
      refreshCropLoupe();
    }
  }
}

function onCropPointerUp(event) {
  dragCorner = -1;
  if (event?.pointerType === "touch" || event?.pointerType === "pen") {
    hoverCorner = -1;
    loupeIsTouch = false;
  } else if (event?.pointerType === "mouse") {
    loupeIsTouch = false;
    const target = event.target;
    const handle =
      target instanceof Element ? target.closest(".crop-handle") : null;
    hoverCorner = handle ? Number(handle.getAttribute("data-corner")) : -1;
  } else {
    hoverCorner = -1;
    loupeIsTouch = false;
  }
  drawCropOverlay();
}

function closeCropEditor({ advance = true } = {}) {
  cropPage = null;
  dragCorner = -1;
  hoverCorner = -1;
  loupeIsTouch = false;
  hideCropLoupe();
  if (els.cropDialog.open) els.cropDialog.close();
  if (advance) pumpCropQueue();
}

/**
 * Solve 8x8 system for perspective matrix (homography).
 * Maps src quad -> dst quad. Returns [a,b,c,d,e,f,g,h] for
 * x' = (ax+by+c)/(gx+hy+1), y' = (dx+ey+f)/(gx+hy+1)
 */
function getPerspectiveTransform(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const s = src[i];
    const d = dst[i];
    A.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y]);
    b.push(d.y);
  }
  const h = solveLinearSystem(A, b);
  return h;
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col] || 1e-12;
    for (let c = col; c <= n; c += 1) M[col][c] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function applyHomography(h, x, y) {
  const denom = h[6] * x + h[7] * y + 1;
  return {
    x: (h[0] * x + h[1] * y + h[2]) / denom,
    y: (h[3] * x + h[4] * y + h[5]) / denom,
  };
}

function sampleBilinear(data, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return [255, 255, 255, 255];
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const dx = x - x0;
  const dy = y - y0;
  const idx = (yy, xx) => (yy * w + xx) * 4;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) {
    const v00 = data[idx(y0, x0) + c];
    const v10 = data[idx(y0, x1) + c];
    const v01 = data[idx(y1, x0) + c];
    const v11 = data[idx(y1, x1) + c];
    out[c] =
      v00 * (1 - dx) * (1 - dy) +
      v10 * dx * (1 - dy) +
      v01 * (1 - dx) * dy +
      v11 * dx * dy;
  }
  return out;
}

function cornerSpan(corners) {
  const width = Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2]));
  const height = Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2]));
  return { width, height };
}

/**
 * Target long-edge pixel size for flatten/export. Always scale TO maxEdge
 * (up or down) so PDF pages fill the viewer and quality presets matter.
 */
function estimateOutputSize(corners, maxEdge = 2000) {
  const { width, height } = cornerSpan(corners);
  const scale = maxEdge / Math.max(width, height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Corner drags must be in natural image pixels. If an older session stored
 * display pixels (max coords fit inside the on-screen frame while the source
 * is much larger), remap them before warping — that bug produced ~227×265 PDFs.
 */
function normalizeCornersToImageSpace(corners, srcW, srcH) {
  const pts = corners.map((c) => ({ x: c.x, y: c.y }));
  const maxX = Math.max(...pts.map((c) => c.x));
  const maxY = Math.max(...pts.map((c) => c.y));
  const frame = els.cropFrame?.getBoundingClientRect();
  const frameW = frame?.width || 0;
  const frameH = frame?.height || 0;

  const looksLikeDisplaySpace =
    frameW > 40 &&
    frameH > 40 &&
    srcW > frameW * 1.5 &&
    srcH > frameH * 1.5 &&
    maxX <= frameW + 2 &&
    maxY <= frameH + 2;

  if (looksLikeDisplaySpace) {
    const scaleX = srcW / frameW;
    const scaleY = srcH / frameH;
    return pts.map((c) => ({
      x: Math.max(0, Math.min(srcW, c.x * scaleX)),
      y: Math.max(0, Math.min(srcH, c.y * scaleY)),
    }));
  }

  return pts.map((c) => ({
    x: Math.max(0, Math.min(srcW, c.x)),
    y: Math.max(0, Math.min(srcH, c.y)),
  }));
}

async function warpPerspective(sourceUrl, corners, maxEdge = 2200) {
  const img = await loadImage(sourceUrl);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const normalized = normalizeCornersToImageSpace(corners, srcW, srcH);
  const { width: outW, height: outH } = estimateOutputSize(normalized, maxEdge);
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const srcData = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;

  const dst = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];
  // Inverse: destination pixel -> source
  const hInv = getPerspectiveTransform(dst, normalized);

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  const imageData = octx.createImageData(outW, outH);
  const data = imageData.data;

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const src = applyHomography(hInv, x, y);
      const [r, g, b, a] = sampleBilinear(
        srcData,
        srcCanvas.width,
        srcCanvas.height,
        src.x,
        src.y
      );
      const i = (y * outW + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  octx.putImageData(imageData, 0, 0);

  const blob = await new Promise((resolve, reject) =>
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Flatten JPEG encode failed"))),
      "image/jpeg",
      0.92
    )
  );
  return { blob, corners: normalized, outW, outH };
}

async function applyCrop() {
  if (!cropPage) return;
  const metrics = getDisplayMetrics();
  if (!metrics.ok) {
    setStatus("Crop view is not ready — wait a moment, then try Apply again.");
    return;
  }
  els.cropApplyBtn.disabled = true;
  setStatus("Flattening page…");
  try {
    const quality = QUALITY[els.qualitySelect.value] || QUALITY.balanced;
    const { blob, corners, outW, outH } = await warpPerspective(
      cropPage.sourceUrl,
      cropCorners,
      quality.maxEdge
    );
    revokeDisplayOnly(cropPage);
    if (cropPage.objectUrl !== cropPage.sourceUrl) {
      revokeUrl(cropPage.objectUrl);
    }
    cropPage.objectUrl = URL.createObjectURL(blob);
    cropPage.displayUrl = cropPage.objectUrl;
    cropPage.corners = corners;
    cropCorners = corners.map((c) => ({ ...c }));
    cropPage.flattened = true;
    cropPage.rotation = 0;
    await refreshPagePreview(cropPage);
    syncView();
    setStatus(
      `Page flattened to ${outW}×${outH}px. Choose processing on the card, or adjust edges with ▦.`
    );
    closeCropEditor({ advance: true });
  } catch (err) {
    console.error(err);
    setStatus("Could not flatten this page. Try adjusting corners again.");
  } finally {
    els.cropApplyBtn.disabled = false;
  }
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera API not available in this browser. Use Upload images.");
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    const track = cameraStream.getVideoTracks()[0];
    try {
      await track?.applyConstraints?.({
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      });
    } catch {
      /* keep best-effort stream */
    }
    els.liveVideo.srcObject = cameraStream;
    els.cameraDialog.showModal();
  } catch (err) {
    console.error(err);
    setStatus("Camera permission denied or unavailable. Use Upload images.");
  }
}

function stopCamera() {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  els.liveVideo.srcObject = null;
  if (els.cameraDialog.open) els.cameraDialog.close();
}

function captureFrame() {
  const video = els.liveVideo;
  const track = cameraStream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  const width = Math.max(video.videoWidth || 0, settings.width || 0);
  const height = Math.max(video.videoHeight || 0, settings.height || 0);
  if (!width || !height) {
    setStatus("Camera not ready yet.");
    return;
  }
  // Dedicated canvas — never reuse the PDF work canvas (avoids size races).
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, width, height);
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        setStatus("Could not capture frame.");
        return;
      }
      stopCamera();
      addImageBlobs([blob], { openCrop: true });
      setStatus(`Captured ${width}×${height}px — adjust page edges.`);
    },
    "image/jpeg",
    0.95
  );
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * On-device pixel filters for digitalization. No external deps.
 * - original: no-op
 * - greyscale: luminance
 * - bw: document-style soft threshold / contrast
 * - cleanup: whitish paper + darker text (global paper estimate + stretch)
 */
function applyMode(ctx, width, height, mode) {
  if (!mode || mode === "original") return;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  if (mode === "cleanup") {
    applyCleanupPaper(data);
    ctx.putImageData(imageData, 0, 0);
    return;
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    if (mode === "bw") {
      gray = gray > 150 ? 255 : gray < 110 ? 0 : (gray - 110) * (255 / 40);
      gray = Math.max(0, Math.min(255, gray * 1.15));
    }
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Practical “scanner” cleanup: estimate paper white from bright pixels,
 * stretch luminance so paper → near-white and ink stays darker.
 * Heuristic only — uneven lighting / coloured paper / photos may suffer.
 * @param {Uint8ClampedArray} data
 */
function applyCleanupPaper(data) {
  const n = data.length / 4;
  /** @type {number[]} */
  const samples = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    samples.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  samples.sort((a, b) => a - b);
  const pct = (t) => samples[Math.min(samples.length - 1, Math.floor(samples.length * t))] ?? 200;
  // Bright end ≈ paper; darkish percentile ≈ ink floor for stretch.
  const paper = Math.max(pct(0.92), 160);
  const ink = Math.min(pct(0.12), paper - 40);
  const span = Math.max(paper - ink, 24);

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    // Map [ink, paper] → [0, 255], then crush near-white and deepen mid/dark.
    let v = ((gray - ink) / span) * 255;
    v = Math.max(0, Math.min(255, v));
    // Soft S-curve for readable text without full binary posterize.
    const t = v / 255;
    const contrasted = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    v = contrasted * 255;
    if (v > 228) v = 255;
    else if (v < 28) v = 0;
    else v = Math.max(0, Math.min(255, (v - 28) * (255 / 200)));
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

async function renderPageForPdf(page, mode, maxEdge, jpegQuality) {
  const img = await loadImage(page.objectUrl);
  const rotation = ((page.rotation % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  if (!srcW || !srcH) {
    throw new Error("Page image has no dimensions");
  }
  const outW0 = swapped ? srcH : srcW;
  const outH0 = swapped ? srcW : srcH;
  // Always target the quality preset long-edge (upscale or downscale).
  const scale = maxEdge / Math.max(outW0, outH0);
  const width = Math.max(1, Math.round(outW0 * scale));
  const height = Math.max(1, Math.round(outH0 * scale));

  // Fresh canvas per page — avoids racing with camera capture on #workCanvas.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const drawW = swapped ? height : width;
  const drawH = swapped ? width : height;
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
  applyMode(ctx, width, height, mode);

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))),
      "image/jpeg",
      jpegQuality
    )
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, width, height, srcW, srcH };
}

function revokeLastPdf() {
  if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
  lastPdfUrl = null;
  lastPdfBlob = null;
  els.saveRow.hidden = true;
  els.shareBtn.hidden = true;
}

function canSharePdf(blob, filename) {
  if (!navigator.share || !navigator.canShare) return false;
  try {
    const file = new File([blob], filename, { type: "application/pdf" });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function triggerAnchorDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function trySaveFilePicker(blob, filename) {
  if (!window.showSaveFilePicker) return false;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: "PDF document",
          accept: { "application/pdf": [".pdf"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    if (err?.name === "AbortError") return "cancelled";
    return false;
  }
}

async function presentPdf(blob, filename) {
  revokeLastPdf();
  lastPdfBlob = blob;
  lastPdfName = filename;
  lastPdfUrl = URL.createObjectURL(blob);

  els.saveLink.href = lastPdfUrl;
  els.saveLink.download = filename;
  els.saveLink.textContent = `Save ${filename}`;
  els.openLink.href = lastPdfUrl;
  els.saveRow.hidden = false;

  const shareOk = canSharePdf(blob, filename);
  els.shareBtn.hidden = !shareOk;

  // Prefer the system save dialog on Chromium (Edge/Chrome) when the
  // user gesture is still accepted; otherwise fall back to <a download>.
  const pickerResult = await trySaveFilePicker(blob, filename);
  if (pickerResult === true) {
    setStatus(
      `Saved ${filename} (${formatBytes(blob.size)}). Use the buttons below if you need another copy.`
    );
    return;
  }
  if (pickerResult === "cancelled") {
    setStatus(
      `Save cancelled. Click “Save ${filename}” below to try again.`
    );
    return;
  }

  triggerAnchorDownload(lastPdfUrl, filename);
  setStatus(
    `PDF ready (${formatBytes(blob.size)}). If nothing appeared in Downloads, click “Save ${filename}” below.`
  );
}

function sanitizeFilename(name) {
  const cleaned = (name || "PrivateScan")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "PrivateScan";
}

async function exportPdf() {
  if (!pages.length) return;
  const unflat = pages.filter((p) => !p.flattened).length;
  if (unflat) {
    const ok = confirm(
      `${unflat} page(s) still have no flattened edges. Download anyway?`
    );
    if (!ok) {
      setStatus("Open ▦ on a page to adjust edges first.");
      return;
    }
  }
  els.exportBtn.disabled = true;
  els.saveRow.hidden = true;
  setStatus("Building PDF…");
  try {
    const quality = QUALITY[els.qualitySelect.value] || QUALITY.balanced;
    const pdf = await PDFDocument.create();
    pdf.setProducer("PrivateScan Web");
    pdf.setCreator("PrivateScan Web");

    let lastDims = "";
    for (let i = 0; i < pages.length; i += 1) {
      const pageMode = pages[i].mode || "original";
      setStatus(`Processing page ${i + 1} of ${pages.length}…`);
      const { bytes, width, height, srcW, srcH } = await renderPageForPdf(
        pages[i],
        pageMode,
        quality.maxEdge,
        quality.jpeg
      );
      if (!bytes?.length) {
        throw new Error(`Page ${i + 1} produced an empty image`);
      }
      const image = await pdf.embedJpg(bytes);
      // Size page in PDF points from pixel dims (1px ≈ 1pt at export scale).
      // Long edge matches quality preset (1400–2400), so the viewer fills the window.
      const page = pdf.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
      lastDims = `${width}×${height}px (source ${srcW}×${srcH})`;
    }

    const pdfBytes = await pdf.save();
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    if (blob.size < 500) {
      throw new Error("PDF was empty");
    }
    const filename = `${sanitizeFilename(els.filenameInput.value)}.pdf`;
    await presentPdf(blob, filename);
    setStatus(
      `${els.status.textContent} · ${pages.length} page(s), last ${lastDims}.`
    );
  } catch (err) {
    console.error(err);
    setStatus("PDF export failed. Try fewer/smaller images, or re-add the pages.");
  } finally {
    els.exportBtn.disabled = false;
  }
}

async function shareLastPdf() {
  if (!lastPdfBlob || !canSharePdf(lastPdfBlob, lastPdfName)) {
    setStatus("Sharing isn’t available here — use Save PDF to disk.");
    return;
  }
  try {
    await navigator.share({
      files: [
        new File([lastPdfBlob], lastPdfName, { type: "application/pdf" }),
      ],
      title: lastPdfName,
    });
    setStatus(`Share sheet opened for ${lastPdfName}.`);
  } catch (err) {
    if (err?.name === "AbortError") {
      setStatus("Share cancelled.");
      return;
    }
    console.error(err);
    setStatus("Share failed — use Save PDF to disk instead.");
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function clearAll() {
  pages.forEach(revokePage);
  pages = [];
  cropQueue = [];
  revokeLastPdf();
  closeCropEditor({ advance: false });
  syncView();
  setStatus("");
}

els.cameraBtn.addEventListener("click", openCamera);
els.addCameraBtn.addEventListener("click", openCamera);
els.closeCameraBtn.addEventListener("click", stopCamera);
els.shutterBtn.addEventListener("click", captureFrame);
els.cameraDialog.addEventListener("close", stopCamera);

els.fileInput.addEventListener("change", async (e) => {
  await filesToPages(e.target.files);
  e.target.value = "";
});
els.addFileInput.addEventListener("change", async (e) => {
  await filesToPages(e.target.files);
  e.target.value = "";
});

els.clearBtn.addEventListener("click", clearAll);
els.exportBtn.addEventListener("click", exportPdf);
els.shareBtn.addEventListener("click", shareLastPdf);

els.modeSelect.addEventListener("change", () => {
  const mode = /** @type {ProcessMode} */ (els.modeSelect.value);
  if (!pages.length) {
    setStatus(
      mode === "original"
        ? "New pages will keep original colours (filtration optional)."
        : `New pages will default to ${PROCESS_MODES.find((m) => m.value === mode)?.label}.`
    );
    return;
  }
  void applyModeToAllPages(mode);
});

els.cropApplyBtn.addEventListener("click", applyCrop);
els.cropResetBtn.addEventListener("click", () => {
  cropCorners = defaultCorners(imageNatural.w, imageNatural.h);
  drawCropOverlay();
});
els.cropCancelBtn.addEventListener("click", () => {
  closeCropEditor({ advance: true });
  setStatus("Edge adjust skipped — tap ▦ on a page to do it later.");
});
els.cropDialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeCropEditor({ advance: true });
});

els.cropOverlay.addEventListener("pointerdown", onCropPointerDown);
els.cropOverlay.addEventListener("pointerover", (event) => {
  if (dragCorner >= 0 || event.pointerType !== "mouse") return;
  loupeIsTouch = false;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const handle = target.closest(".crop-handle");
  if (!handle) return;
  const next = Number(handle.getAttribute("data-corner"));
  if (next === hoverCorner) return;
  hoverCorner = next;
  refreshCropLoupe();
});
els.cropStage.addEventListener("pointerleave", () => {
  if (dragCorner >= 0) return;
  if (hoverCorner < 0) return;
  hoverCorner = -1;
  hideCropLoupe();
});
window.addEventListener("pointermove", onCropPointerMove);
window.addEventListener("pointerup", onCropPointerUp);
window.addEventListener("pointercancel", onCropPointerUp);
window.addEventListener("resize", () => {
  if (els.cropDialog.open) drawCropOverlay();
});

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  els.installBtn.hidden = false;
});

els.installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  els.installBtn.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration failed", err);
    });
  });
}

syncView();
