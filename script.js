// script.js - full drop-in replacement
// Works with your HTML (canvas id="c", upload id="upload", etc.)

/* -----------------------
   Element refs
   ----------------------- */
const canvas = document.getElementById('c'),
      ctx = canvas.getContext('2d'),
      upload = document.getElementById('upload'),
      modeEl = document.getElementById('mode'),
      startEl = document.getElementById('start'),
      resetBtn = document.getElementById('reset'),
      undoBtn = document.getElementById('undo'),
      cropToggle = document.getElementById('cropToggle'),
      controlsDiv = document.getElementById('controls'),
      yminEl = document.getElementById('ymin'),
      ymaxEl = document.getElementById('ymax'),
      setCalibBtn = document.getElementById('setCalib'),
      resultsTable = document.getElementById('results'),
      annualLabel = document.getElementById('annual'),
      pointCounter = document.getElementById('pointCounter'),
      cropRect = document.getElementById('crop-rect'),
      canvasContainer = document.getElementById('canvas-container'),
      applyCropBtn = document.getElementById('applyCrop');

/* -----------------------
   State
   ----------------------- */
let origImg = null;          // original (full-res) Image object
let origW = 0, origH = 0;    // original image dims
let img = null;              // image currently used to draw onto canvas (may be same as origImg)
let calib = [], monthPts = [], affine = null, mode, startIdx;

/* Crop state (canvas-pixel coordinates) */
let cropStart = null,
    isCropping = false,
    isDragging = false,
    dragOffset = null;

let cropBox = { x: 0, y: 0, w: 0, h: 0 }; // in canvas pixels

/* -----------------------
   Helpers - coordinates
   ----------------------- */
function getCanvasRect(){ return canvas.getBoundingClientRect(); }

function getCanvasPointFromClient(clientX, clientY){
  const rect = getCanvasRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = cssX * scaleX;
  const cy = cssY * scaleY;
  return { cx, cy, cssX, cssY, rect, scaleX, scaleY };
}

function clampCanvasBox(box){
  const x = Math.max(0, Math.min(canvas.width, Math.round(box.x)));
  const y = Math.max(0, Math.min(canvas.height, Math.round(box.y)));
  const w = Math.max(0, Math.min(canvas.width - x, Math.round(box.w)));
  const h = Math.max(0, Math.min(canvas.height - y, Math.round(box.h)));
  return { x, y, w, h };
}

/* -----------------------
   Drawing utilities
   ----------------------- */
function drawPoint(x, y, color){
  // x,y are canvas pixel coords
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, 2*Math.PI);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function redrawAll(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  calib.forEach(([x,y]) => drawPoint(x,y,'blue'));
  monthPts.forEach(([x,y]) => drawPoint(x,y,'red'));
  pointCounter.textContent = `Red Points: ${monthPts.length}/12`;
}

/* -----------------------
   Upload logic
   ----------------------- */
upload.onchange = async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    const src = ev.target.result;
    const loaded = new Image();
    loaded.src = src;
    await loaded.decode();
    // store original full resolution
    origImg = loaded;
    origW = loaded.naturalWidth || loaded.width;
    origH = loaded.naturalHeight || loaded.height;

    // For display we keep canvas internal resolution as-is (your canvas width/height attributes),
    // but set img to the orig image to allow high-quality cropping from origImg later.
    img = origImg;

    // draw scaled into canvas
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // reset state
    calib = [];
    monthPts = [];
    affine = null;
    controlsDiv.style.display = 'none';
    resultsTable.innerHTML = '';
    annualLabel.textContent = '';
    pointCounter.textContent = 'Red Points: 0/12';
    cropRect.style.display = 'none';
    if (applyCropBtn) applyCropBtn.style.display = 'none';
  };
  reader.readAsDataURL(file);
};

/* -----------------------
   Reset
   ----------------------- */
resetBtn.onclick = () => {
  calib = []; monthPts = []; affine = null;
  controlsDiv.style.display = 'none';
  resultsTable.innerHTML = '';
  annualLabel.textContent = '';
  pointCounter.textContent = 'Red Points: 0/12';
  cropRect.style.display = 'none';
  if (applyCropBtn) applyCropBtn.style.display = 'none';
  isCropping = false;
  cropBox = {x:0,y:0,w:0,h:0};
  cropStart = null; isDragging = false; dragOffset = null;
  // redraw orig (if present)
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (img) ctx.drawImage(img,0,0,canvas.width,canvas.height);
};

/* -----------------------
   Undo
   ----------------------- */
undoBtn.onclick = () => {
  if (monthPts.length > 0){
    monthPts.pop();
    redrawAll();
  }
};

/* -----------------------
   Canvas click -> calibration / red points
   ----------------------- */
canvas.addEventListener('click', e => {
  // ignore clicks if cropping active and user is drawing/manipulating
  if (isCropping && (cropStart || cropRect.style.display === 'block')) return;

  const { cx, cy } = getCanvasPointFromClient(e.clientX, e.clientY);
  if (calib.length < 2){
    calib.push([cx, cy]);
    drawPoint(cx, cy, 'blue');
    if (calib.length === 2) controlsDiv.style.display = 'block';
  } else if (affine && monthPts.length < 12){
    monthPts.push([cx, cy]);
    drawPoint(cx, cy, 'red');
    pointCounter.textContent = `Red Points: ${monthPts.length}/12`;
    if (monthPts.length === 12) computeResults();
  }
});

/* -----------------------
   Calibration set
   ----------------------- */
setCalibBtn.onclick = () => {
  if (calib.length < 2) { alert('Select two calibration points (bottom then top) first.'); return; }
  const [[xb,yb],[xt,yt]] = calib;
  const vmin = parseFloat(yminEl.value), vmax = parseFloat(ymaxEl.value);
  if (Number.isNaN(vmin) || Number.isNaN(vmax)) { alert('Enter numeric Y-min and Y-max'); return; }
  const pixelRange = yb - yt;
  if (Math.abs(pixelRange) < 1e-6) { alert('Calibration points too close vertically.'); return; }
  const dataRange = vmax - vmin;
  affine = (x,y) => vmin + ((yb - y) / pixelRange) * dataRange;
  mode = modeEl.value;
  startIdx = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(startEl.value);
};

/* -----------------------
   Compute results
   ----------------------- */
function computeResults(){
  if (!affine || monthPts.length < 12) return;
  resultsTable.innerHTML = '<tr><th>Month</th><th>Axis Value</th><th>kWh</th></tr>';
  let total = 0;
  for (let i=0;i<12;i++){
    const [x,y] = monthPts[i];
    const axisVal = affine(x,y);
    let finalVal = axisVal;
    if (mode === 'Daily average'){
      const days = [31,28,31,30,31,30,31,31,30,31,30,31][(startIdx + i) % 12];
      finalVal *= days;
    }
    total += finalVal;
    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(startIdx+i)%12];
    resultsTable.innerHTML += `<tr><td>${monthName}</td><td>${axisVal.toFixed(2)}</td><td>${finalVal.toFixed(2)}</td></tr>`;
  }
  annualLabel.textContent = `Annual usage: ${total.toFixed(2)} kWh`;
}

/* -----------------------
   Crop toggle
   ----------------------- */
cropToggle.onclick = () => {
  isCropping = !isCropping;
  cropToggle.textContent = isCropping ? 'Cancel Crop' : 'Crop Mode';
  cropRect.style.display = isCropping ? 'block' : 'none';
  if (applyCropBtn) applyCropBtn.style.display = isCropping ? 'inline' : 'none';
  cropBox = {x:0,y:0,w:0,h:0};
  cropStart = null; isDragging = false; dragOffset = null;
};

/* -----------------------
   Crop interactions (CSS rect <-> canvas pixels mapping)
   ----------------------- */
canvas.addEventListener('mousedown', e => {
  if (!isCropping) return;
  const { cx, cy, cssX, cssY, rect } = getCanvasPointFromClient(e.clientX, e.clientY);

  const cssLeft = parseFloat(cropRect.style.left || '0');
  const cssTop  = parseFloat(cropRect.style.top  || '0');
  const cssW = parseFloat(cropRect.style.width || '0');
  const cssH = parseFloat(cropRect.style.height || '0');

  const inside = cssW > 0 && cssH > 0 &&
                 cssX >= cssLeft && cssX <= cssLeft + cssW &&
                 cssY >= cssTop  && cssY <= cssTop  + cssH;

  if (inside){
    isDragging = true;
    dragOffset = { cssDx: cssX - cssLeft, cssDy: cssY - cssTop };
  } else {
    cropStart = { cssX, cssY, cx, cy };
    cropBox = { x: cx, y: cy, w: 0, h: 0 };
    cropRect.style.display = 'block';
    cropRect.style.left = `${cssX}px`;
    cropRect.style.top  = `${cssY}px`;
    cropRect.style.width = '0px';
    cropRect.style.height = '0px';
  }
  e.preventDefault();
});

canvas.addEventListener('mousemove', e => {
  if (!isCropping) return;
  const { cx, cy, cssX, cssY, rect } = getCanvasPointFromClient(e.clientX, e.clientY);

  if (isDragging){
    const newCssLeft = cssX - dragOffset.cssDx;
    const newCssTop  = cssY - dragOffset.cssDy;
    const cssMaxLeft = rect.width;
    const cssMaxTop  = rect.height;
    const rectW = parseFloat(cropRect.style.width || '0');
    const rectH = parseFloat(cropRect.style.height || '0');
    const clampedLeft = Math.max(0, Math.min(newCssLeft, cssMaxLeft - rectW));
    const clampedTop  = Math.max(0, Math.min(newCssTop, cssMaxTop - rectH));
    cropRect.style.left = `${clampedLeft}px`;
    cropRect.style.top  = `${clampedTop}px`;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    cropBox.x = Math.round(clampedLeft * scaleX);
    cropBox.y = Math.round(clampedTop * scaleY);
  } else if (cropStart){
    const leftCss = Math.min(cropStart.cssX, cssX);
    const topCss  = Math.min(cropStart.cssY, cssY);
    const widthCss = Math.abs(cssX - cropStart.cssX);
    const heightCss = Math.abs(cssY - cropStart.cssY);
    cropRect.style.left = `${leftCss}px`;
    cropRect.style.top  = `${topCss}px`;
    cropRect.style.width = `${widthCss}px`;
    cropRect.style.height = `${heightCss}px`;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    cropBox.x = Math.round(leftCss * scaleX);
    cropBox.y = Math.round(topCss * scaleY);
    cropBox.w = Math.round(widthCss * scaleX);
    cropBox.h = Math.round(heightCss * scaleY);
  }
});

canvas.addEventListener('mouseup', e => {
  if (!isCropping) return;
  isDragging = false;
  cropStart = null;
  cropBox = clampCanvasBox(cropBox);

  // reflect back to CSS so visible box matches clamped data
  const rect = getCanvasRect();
  const cssLeft = cropBox.x * (rect.width / canvas.width);
  const cssTop  = cropBox.y * (rect.height / canvas.height);
  const cssW = cropBox.w * (rect.width / canvas.width);
  const cssH = cropBox.h * (rect.height / canvas.height);
  cropRect.style.left = `${cssLeft}px`;
  cropRect.style.top  = `${cssTop}px`;
  cropRect.style.width = `${cssW}px`;
  cropRect.style.height = `${cssH}px`;
});

canvas.addEventListener('mouseleave', () => { if (!isCropping) return; isDragging=false; cropStart=null; });

/* -----------------------
   Apply crop - LOSSLESS using original image pixels
   ----------------------- */
if (applyCropBtn){
  applyCropBtn.onclick = () => {
    if (!origImg || cropRect.style.display === 'none') return;
    const cb = clampCanvasBox(cropBox);
    if (cb.w <= 0 || cb.h <= 0) { alert('Select a valid crop area first.'); return; }

    // Map canvas-pixel cropBox to original image pixel coordinates
    // (origImg may be larger than canvas display scale)
    const sx = Math.round(cb.x * (origW / canvas.width));
    const sy = Math.round(cb.y * (origH / canvas.height));
    const sw = Math.round(cb.w * (origW / canvas.width));
    const sh = Math.round(cb.h * (origH / canvas.height));

    if (sw <= 0 || sh <= 0) { alert('Crop too small.'); return; }

    // Create offscreen canvas at original crop resolution and draw from original image
    const off = document.createElement('canvas');
    off.width = sw;
    off.height = sh;
    const offCtx = off.getContext('2d');

    // Draw directly from the original image (lossless)
    offCtx.drawImage(origImg, sx, sy, sw, sh, 0, 0, sw, sh);

    // Replace origImg and img with the cropped image (encoded PNG)
    const dataURL = off.toDataURL('image/png');
    const newImage = new Image();
    newImage.onload = () => {
      // update originals
      origImg = newImage;
      origW = newImage.naturalWidth || newImage.width;
      origH = newImage.naturalHeight || newImage.height;
      img = origImg;

      // optionally resize canvas to the cropped size for accurate coordinate picking later
      canvas.width = sw;
      canvas.height = sh;

      // draw new image full-size in canvas
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // clear crop UI + reset state
      cropRect.style.display = 'none';
      applyCropBtn.style.display = 'none';
      cropToggle.textContent = 'Crop Mode';
      isCropping = false;

      calib = []; monthPts = []; affine = null;
      controlsDiv.style.display = 'none';
      resultsTable.innerHTML = '';
      annualLabel.textContent = '';
      pointCounter.textContent = 'Red Points: 0/12';
    };
    newImage.src = dataURL;
  };
}

/* -----------------------
   Modal logic
   ----------------------- */
const modal = document.getElementById('helpModal');
const helpBtn = document.getElementById('helpBtn');
const closeModal = document.getElementById('closeModal');
if (helpBtn && modal && closeModal){
  helpBtn.onclick = () => modal.style.display = 'flex';
  closeModal.onclick = () => modal.style.display = 'none';
  window.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
}

/* -----------------------
   Initialize blank canvas
   ----------------------- */
ctx.clearRect(0,0,canvas.width,canvas.height);
