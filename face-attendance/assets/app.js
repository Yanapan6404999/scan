/**************************************************
 * CONFIG
 **************************************************/
const STORAGE_KEY = 'attendance_api_url_v2';
const MODEL_URL = './models';

const FACE_MATCH_THRESHOLD = 0.55;
const STABLE_MATCH_COUNT = 3;

const SNAP_MAX_W = 640;
const SNAP_JPEG_QUALITY = 0.72;

const API_TIMEOUT_MS = 15000;

/**************************************************
 * STORAGE
 **************************************************/
function getApiUrl() { return localStorage.getItem(STORAGE_KEY) || ''; }
function setApiUrl(url) {
  if (url) localStorage.setItem(STORAGE_KEY, url);
  else localStorage.removeItem(STORAGE_KEY);
}

/**************************************************
 * API HELPER (เพิ่มความทนทาน: รองรับ response หลายรูปแบบ)
 **************************************************/
const api = {
  async call(action, params = {}) {
    const apiUrl = getApiUrl();
    if (!apiUrl) throw new Error('ยังไม่ได้ตั้งค่า URL API');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const body = new URLSearchParams({ action, ...params }).toString();
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        signal: controller.signal
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch (e) {
        console.error('API response is not JSON:', text);
        throw new Error('API ส่งผลลัพธ์ไม่ใช่ JSON (ตรวจสอบ URL ว่าถูกตัว exec หรือไม่)');
      }

      const ok = (data.ok ?? data.success ?? (data.status === 'success') ?? false);
      if (!ok) throw new Error(data.error || data.message || 'ไม่ทราบสาเหตุจากเซิร์ฟเวอร์');

      return (data.result ?? data.data ?? data.payload ?? data);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('เรียก API นานเกินไป (timeout) ลองใหม่อีกครั้ง');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
};

/**************************************************
 * STATE
 **************************************************/
let employeesCache = [];
let faceReady = false;
let modelsLoaded = false;

let camStream = null;
let scanning = false;

let lastBest = { code: '', fullName: '', distance: 999 };
let stableHit = 0;
let lockedMatch = null;

let enrollAuthed = false;

/**************************************************
 * DOM UTILS
 **************************************************/
function $(id) { return document.getElementById(id); }
function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }

function showModal(id) { const el = $(id); if (el) el.classList.add('show'); }
function hideModal(id) { const el = $(id); if (el) el.classList.remove('show'); }

function showSheet(id){ const el = $(id); if(el) el.classList.add('show'); }
function hideSheet(id){ const el = $(id); if(el) el.classList.remove('show'); }

function setConnectionStatus(online, msg) {
  const badge = $('connectionBadge');
  const text  = $('connectionText');
  if (!badge || !text) return;
  if (online) { badge.classList.remove('offline'); text.textContent = msg || 'เชื่อมต่อสำเร็จ'; }
  else { badge.classList.add('offline'); text.textContent = msg || 'ยังไม่ได้เชื่อมต่อ'; }
}

function statusBadgeHtml(status) {
  if (!status) return '<span class="badge-status badge-absent">ขาด</span>';
  let cls = 'badge-other';
  if (status === 'ปกติ') cls = 'badge-normal';
  else if (String(status).includes('สาย')) cls = 'badge-late';
  else if (status === 'ขาด') cls = 'badge-absent';
  return '<span class="badge-status ' + cls + '">' + status + '</span>';
}

/**************************************************
 * FILE → BASE64
 **************************************************/
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

/**************************************************
 * GPS
 **************************************************/
function getCurrentPositionPromise(options = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง (GPS) กรุณาเปิดจากมือถือหรือใช้ Chrome / Edge'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos),
      err => {
        let msg = 'ไม่สามารถดึงพิกัด GPS ได้';
        if (err.code === err.PERMISSION_DENIED) msg = 'ระบบต้องการสิทธิ์เข้าถึงตำแหน่งก่อนบันทึกเวลา กรุณาเปิด Location และกด "อนุญาต" ในเบราว์เซอร์';
        else if (err.code === err.POSITION_UNAVAILABLE) msg = 'ไม่พบสัญญาณตำแหน่ง กรุณาลองใหม่อีกครั้ง หรือออกนอกอาคาร';
        else if (err.code === err.TIMEOUT) msg = 'ดึงพิกัดนานเกินไป กรุณาลองใหม่อีกครั้ง';
        reject(new Error(msg));
      },
      options
    );
  });
}

/**************************************************
 * FACE: LOAD MODELS
 **************************************************/
async function ensureModelsLoaded() {
  if (modelsLoaded) return true;
  const line = $('faceStatusLine');
  line.textContent = 'กำลังโหลดโมเดลสแกนใบหน้า (models)...';

  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    faceReady = true;
    line.textContent = 'พร้อมสแกนใบหน้าแล้ว ✅';
    return true;
  } catch (err) {
    console.error(err);
    line.textContent = 'โหลดโมเดลไม่สำเร็จ ❌ ตรวจสอบโฟลเดอร์ models/ และเปิดผ่าน https';
    faceReady = false;
    return false;
  }
}

/**************************************************
 * CAMERA
 **************************************************/
async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const sel = $('cameraSelect');
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = cams.length ? 'เลือกกล้อง (แนะนำ: กล้องหน้า)' : 'ไม่พบกล้อง';
    sel.appendChild(opt0);

    cams.forEach((c, idx) => {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${idx + 1}`;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.warn('enumerateDevices error', e);
  }
}

async function startCamera(preferDeviceId = '') {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับกล้อง');
  }

  stopCamera();

  const constraints = {
    audio: false,
    video: preferDeviceId
      ? { deviceId: { exact: preferDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
  };

  camStream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = $('camVideo');
  video.srcObject = camStream;
  await video.play();

  $('cameraPlaceholder').style.display = 'none';
  video.style.display = 'block';
  $('camOverlay').style.display = 'block';
  $('scanHud').style.display = 'flex';

  await listCameras();
}

function stopCamera() {
  const video = $('camVideo');
  if (video) {
    try { video.pause(); } catch(e){}
    video.srcObject = null;
    video.style.display = 'none';
  }
  const overlay = $('camOverlay');
  if (overlay) overlay.style.display = 'none';

  const hud = $('scanHud');
  if (hud) hud.style.display = 'none';

  const ph = $('cameraPlaceholder');
  if (ph) ph.style.display = 'flex';

  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
}

/**************************************************
 * FACE: PARSE & MATCH
 **************************************************/
function safeParseFaceData(faceDataRaw) {
  if (!faceDataRaw) return null;
  try {
    const parsed = typeof faceDataRaw === 'string' ? JSON.parse(faceDataRaw) : faceDataRaw;
    if (Array.isArray(parsed) && parsed.length >= 64) return new Float32Array(parsed);
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.descriptor)) return new Float32Array(parsed.descriptor);
      if (Array.isArray(parsed.data)) return new Float32Array(parsed.data);
    }
  } catch (e) {}
  return null;
}

function euclideanDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function findBestMatch(queryDescriptor) {
  let best = { code: '', fullName: '', distance: 999 };
  for (const emp of employeesCache) {
    const code = String(emp.code || '').trim();
    const fullName = String(emp.fullName || emp.fullname || '').trim();
    const desc = safeParseFaceData(emp.faceData);
    if (!code || !desc) continue;
    const dist = euclideanDistance(queryDescriptor, desc);
    if (dist < best.distance) best = { code, fullName, distance: dist };
  }
  return best;
}

function setScanPills(statusText, foundText) {
  $('scanPillLeft').innerHTML = `<strong>สถานะ:</strong> ${statusText}`;
  $('scanPillRight').innerHTML = `<strong>พบ:</strong> ${foundText}`;
}

function clearOverlay() {
  const canvas = $('camOverlay');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBox(box) {
  const canvas = $('camOverlay');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(34,197,94,0.95)';
  ctx.strokeRect(box.x, box.y, box.width, box.height);
}

async function scanTick() {
  if (!scanning) return;
  const video = $('camVideo');
  const canvas = $('camOverlay');
  if (!video || video.readyState < 2) return;

  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw;
    canvas.height = vh;
  }

  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

  try {
    const result = await faceapi
      .detectSingleFace(video, opts)
      .withFaceLandmarks()
      .withFaceDescriptor();

    clearOverlay();

    if (!result) {
      stableHit = 0;
      lockedMatch = null;
      $('btnScanSubmit').disabled = true;
      setScanPills('กำลังหาใบหน้า...', '-');
      return;
    }

    const resized = faceapi.resizeResults(result, { width: vw, height: vh });
    drawBox(resized.detection.box);

    const best = findBestMatch(result.descriptor);

    if (!best.code || best.distance > FACE_MATCH_THRESHOLD) {
      stableHit = 0;
      lockedMatch = null;
      $('btnScanSubmit').disabled = true;

      const msg = best.code
        ? `${best.code} ${best.fullName ? '- ' + best.fullName : ''} (ไกลไป: ${best.distance.toFixed(2)})`
        : 'ยังไม่มีข้อมูลใบหน้าพนักงาน (faceData)';

      setScanPills('พบใบหน้า แต่ยังจับคู่ไม่ได้', msg);
      return;
    }

    const sameAsLast = best.code === lastBest.code;
    lastBest = best;

    if (sameAsLast) stableHit++;
    else stableHit = 1;

    if (stableHit >= STABLE_MATCH_COUNT) {
      lockedMatch = best;
      $('btnScanSubmit').disabled = false;
      setScanPills('พร้อมบันทึก ✅', `${best.code} - ${best.fullName} (dist ${best.distance.toFixed(2)})`);
    } else {
      $('btnScanSubmit').disabled = true;
      setScanPills(`กำลังยืนยัน... (${stableHit}/${STABLE_MATCH_COUNT})`, `${best.code} - ${best.fullName} (dist ${best.distance.toFixed(2)})`);
    }

  } catch (err) {
    console.error(err);
    setScanPills('สแกนผิดพลาด (ดู console)', '-');
  }
}

function startScanLoop() {
  if (scanning) return;
  scanning = true;
  stableHit = 0;
  lockedMatch = null;
  lastBest = { code:'', fullName:'', distance: 999 };

  $('btnStopScan').disabled = false;
  $('btnStartScan').disabled = true;
  $('btnScanSubmit').disabled = true;

  setScanPills('เริ่มสแกนแล้ว', '-');

  const loop = async () => {
    if (!scanning) return;
    await scanTick();
    setTimeout(loop, 250);
  };
  loop();
}

function stopScanLoop() {
  scanning = false;
  $('btnStopScan').disabled = true;
  $('btnStartScan').disabled = false;
  $('btnScanSubmit').disabled = true;
  lockedMatch = null;
  stableHit = 0;
  setScanPills('หยุดแล้ว', '-');
  clearOverlay();
}

function captureFrameBase64({ maxW = SNAP_MAX_W, quality = SNAP_JPEG_QUALITY } = {}) {
  const video = $('camVideo');
  const srcW = video.videoWidth || 1280;
  const srcH = video.videoHeight || 720;

  const scale = Math.min(1, maxW / srcW);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);

  return c.toDataURL('image/jpeg', quality);
}

/**************************************************
 * INITIAL DATA (เพิ่ม fallback)
 **************************************************/
async function init() {
  const apiUrl = getApiUrl();
  $('apiUrlDisplay').textContent = apiUrl ? 'API: ' + apiUrl : 'ยังไม่ได้ตั้งค่า URL';

  if (!apiUrl) {
    setConnectionStatus(false, 'ยังไม่ได้ตั้งค่า URL');
    return;
  }

  try {
    let result = null;

    try {
      result = await api.call('getInitialData');
    } catch (e) {
      console.warn('getInitialData failed -> fallback to getEmployees/getTodaySummary', e);

      const [emps, today] = await Promise.allSettled([
        api.call('getEmployees'),
        api.call('getTodaySummary'),
      ]);

      result = {
        employees: emps.status === 'fulfilled' ? emps.value : [],
        todaySummary: today.status === 'fulfilled' ? today.value : []
      };
    }

    employeesCache = result.employees || [];
    setConnectionStatus(true, 'เชื่อมต่อสำเร็จ');
    loadTodaySummaryFromResult(result.todaySummary);
    rebuildDatalist();

    ensureModelsLoaded();
  } catch (err) {
    console.error(err);
    setConnectionStatus(false, err.message);
  }
}

function rebuildDatalist() {
  const dl = $('empDatalist');
  if (!dl) return;
  dl.innerHTML = '';
  for (const e of employeesCache) {
    const code = String(e.code || '').trim();
    if (!code) continue;
    const name = String(e.fullName || e.fullname || '').trim();
    const opt = document.createElement('option');
    opt.value = code;
    opt.label = name ? `${code} - ${name}` : code;
    dl.appendChild(opt);
  }
}

function loadTodaySummaryFromResult(summary) {
  const tbody = $('todaySummaryBody');
  if (!tbody) return;

  const rows = Array.isArray(summary) ? summary : [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:12px 8px;" class="text-muted">ยังไม่มีข้อมูลของวันนี้</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${row.code || ''}</td>
      <td>${row.fullName || ''}</td>
      <td>${row.branch || ''}</td>
      <td>${row.level || ''}</td>
      <td>${row.t1 || ''}</td>
      <td>${row.t2 || ''}</td>
      <td>${row.t3 || ''}</td>
      <td>${row.t4 || ''}</td>
      <td>${statusBadgeHtml(row.status || '')}</td>
    </tr>
  `).join('');
}

async function loadTodaySummary() {
  try {
    const result = await api.call('getTodaySummary');
    loadTodaySummaryFromResult(result);
  } catch (err) {
    alert('โหลดภาพรวมวันนี้ไม่สำเร็จ: ' + err.message);
  }
}

/**************************************************
 * MANUAL MODAL
 **************************************************/
function findEmployeeByCode(code) {
  return employeesCache.find(e => String(e.code) === String(code));
}

function updateManualEmpInfo() {
  const code = $('manualCode').value.trim();
  const infoEl = $('manualEmpInfo');
  if (!code) {
    infoEl.textContent = 'กรอกรหัสแล้วระบบจะแสดงชื่อ-สกุล / แผนก / ระดับ';
    return;
  }
  const emp = findEmployeeByCode(code);
  if (!emp) infoEl.textContent = 'ไม่พบพนักงานรหัสนี้ในชีต Employees';
  else infoEl.textContent = `${emp.fullName || ''} | แผนก: ${emp.branch || '-'} | ระดับ: ${emp.level || '-'}`;
}

async function submitManual() {
  const code   = $('manualCode').value.trim();
  const type   = $('manualType').value;
  const fileEl = $('manualFile');
  const resultEl = $('manualResult');
  const errEl = $('manualError');
  const sucEl = $('manualSuccess');
  const submitBtn = $('btnManualSubmit');

  errEl.style.display = 'none';
  sucEl.style.display = 'none';
  resultEl.value = '';

  if (!code) {
    errEl.textContent = 'กรุณากรอกรหัสพนักงาน';
    errEl.style.display = 'block';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'กำลังบันทึก...';
  resultEl.value = 'กำลังขอสิทธิ์และดึงพิกัด GPS จากอุปกรณ์...';

  try {
    const position = await getCurrentPositionPromise({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    const { latitude, longitude } = position.coords;

    const file = fileEl.files[0];
    const base64 = await fileToBase64(file);

    const payload = { code, lat: latitude, lng: longitude, manualType: type };
    if (base64) {
      payload.evidenceBase64 = base64;
      payload.evidenceName   = file ? file.name : ('evidence-' + code + '.png');
    }

    const res = await api.call('saveManualLog', payload);

    const lines = [];
    lines.push(`บันทึกสำเร็จ: เวลา ${res.time} (${res.slot})`);
    if (res.employee) {
      lines.push(`รหัส: ${res.employee.code}`);
      lines.push(`ชื่อ: ${res.employee.fullName || ''}`);
      lines.push(`แผนก: ${res.employee.branch || ''}`);
      lines.push(`ระดับ: ${res.employee.level || ''}`);
    }
    lines.push(`สถานะวันนี้: ${res.status || ''}`);

    if (res.location) {
      const loc = res.location;
      if (loc.locationText) lines.push(`สถานที่โดยประมาณ: ${loc.locationText}`);
      if (loc.lat && loc.lng) {
        lines.push(`พิกัด: ${loc.lat}, ${loc.lng}`);
        lines.push(`แผนที่: https://www.google.com/maps?q=${loc.lat},${loc.lng}`);
      }
    }

    if (res.locationZone) {
      if (res.locationZone === 'IN') lines.push(`โซนตำแหน่ง: ในเขตบริษัท`);
      else if (res.locationZone === 'OUT') lines.push(`โซนตำแหน่ง: นอกเขตบริษัท (กรุณาตรวจสอบ)`);
    }

    if (res.evidenceUrl) lines.push(`หลักฐาน: ${res.evidenceUrl}`);
    resultEl.value = lines.join('\n');

    sucEl.textContent = 'บันทึกเรียบร้อยแล้ว';
    sucEl.style.display = 'block';

    updateLatestFromManual(res);
    loadTodaySummary();

    setTimeout(() => hideModal('modalManual'), 1500);

  } catch (err) {
    console.error(err);
    errEl.textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
    errEl.style.display = 'block';
    resultEl.value = '';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'ยืนยันบันทึก';
  }
}

function updateLatestFromManual(res) {
  const box = $('latestContent');
  if (!box) return;
  const emp = res.employee || {};
  const statusHtml = statusBadgeHtml(res.status || '');
  const loc = res.location || {};
  let zoneText = '';
  if (res.locationZone === 'IN') zoneText = ' (ในเขตบริษัท)';
  else if (res.locationZone === 'OUT') zoneText = ' (นอกเขตบริษัท - กรุณาตรวจสอบ)';

  let locationHtml = '';
  if (loc.lat && loc.lng) {
    const mapUrl = 'https://www.google.com/maps?q=' + encodeURIComponent(loc.lat + ',' + loc.lng);
    const locText = loc.locationText ? loc.locationText + '<br>' : '';
    locationHtml = `
      <div class="latest-row mt-8">
        <span class="label">สถานที่</span>
        <span>${locText}<a href="${mapUrl}" target="_blank">เปิดแผนที่ (Google Maps)</a>${zoneText}</span>
      </div>`;
  }

  box.innerHTML = `
    <div class="latest-row">
      <span class="label">พนักงาน</span>
      <span>${emp.code || ''} - ${emp.fullName || ''}</span>
    </div>
    <div class="latest-row mt-8">
      <span class="label">เวลา</span>
      <span>${res.time || ''} (ลงช่อง ${res.slot || '-'})</span>
    </div>
    <div class="latest-row mt-8">
      <span class="label">สถานะวันนี้</span>
      <span>${statusHtml}</span>
    </div>
    ${locationHtml}
    ${res.evidenceUrl ? `
    <div class="latest-row mt-8">
      <span class="label">หลักฐาน</span>
      <span><a href="${res.evidenceUrl}" target="_blank">เปิดรูปหลักฐาน</a></span>
    </div>` : ''}
  `;
}

/**************************************************
 * CHECK TODAY
 **************************************************/
async function submitCheckToday() {
  const code = $('checkCode').value.trim();
  const resultEl = $('checkResult');
  const errEl = $('checkError');

  errEl.style.display = 'none';
  resultEl.value = '';

  if (!code) {
    errEl.textContent = 'กรุณากรอกรหัสพนักงาน';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res = await api.call('checkTodayByCode', { code });
    if (!res.found) {
      resultEl.value = res.message || 'วันนี้ยังไม่มีการบันทึกเวลา';
      return;
    }

    const emp = res.employee || {};
    const log = res.log || {};
    const lines = [];
    lines.push(`รหัส: ${emp.code || ''}`);
    lines.push(`ชื่อ: ${emp.fullName || ''}`);
    lines.push(`แผนก: ${emp.branch || ''}`);
    lines.push(`ระดับ: ${emp.level || ''}`);
    lines.push('-----------------------------');
    lines.push(`เข้าเช้า (t1): ${log.t1 || '-'}`);
    lines.push(`ออกเที่ยง (t2): ${log.t2 || '-'}`);
    lines.push(`เข้าเที่ยง (t3): ${log.t3 || '-'}`);
    lines.push(`ออกเย็น (t4): ${log.t4 || '-'}`);
    lines.push(`Extra1: ${log.tExtra1 || '-'}`);
    lines.push(`Extra2: ${log.tExtra2 || '-'}`);
    lines.push('-----------------------------');
    lines.push(`สถานะวันนี้: ${log.status || '-'}`);
    if (log.evidenceUrl) lines.push(`หลักฐาน: ${log.evidenceUrl}`);

    if (log.locationText || (log.lat && log.lng)) {
      lines.push('-----------------------------');
      if (log.locationText) lines.push(`สถานที่โดยประมาณ: ${log.locationText}`);
      if (log.lat && log.lng) {
        lines.push(`พิกัด: ${log.lat}, ${log.lng}`);
        lines.push(`แผนที่: https://www.google.com/maps?q=${log.lat},${log.lng}`);
      }
    }

    resultEl.value = lines.join('\n');

  } catch (err) {
    console.error(err);
    errEl.textContent = 'ตรวจสอบไม่สำเร็จ: ' + err.message;
    errEl.style.display = 'block';
  }
}

/**************************************************
 * URL MODAL
 **************************************************/
function openUrlModal() {
  $('inputApiUrl').value = getApiUrl();
  $('urlError').style.display = 'none';
  showModal('modalUrl');
}

function saveUrl() {
  const url = $('inputApiUrl').value.trim();
  const errEl = $('urlError');
  errEl.style.display = 'none';

  if (!url) {
    errEl.textContent = 'กรุณากรอก URL';
    errEl.style.display = 'block';
    return;
  }

  if (!/^https:\/\/script\.google\.com\/macros\/s\//.test(url)) {
    if (!confirm('URL ดูเหมือนจะไม่ใช่ Web App ของ Apps Script แน่ใจหรือไม่ว่าจะใช้ URL นี้?')) return;
  }

  setApiUrl(url);
  $('apiUrlDisplay').textContent = 'API: ' + url;
  hideModal('modalUrl');
  init();
}

function resetUrl() {
  if (confirm('ต้องการลบ URL ที่ตั้งค่าไว้หรือไม่?')) {
    setApiUrl('');
    $('apiUrlDisplay').textContent = 'ยังไม่ได้ตั้งค่า URL';
    setConnectionStatus(false, 'ยังไม่ได้ตั้งค่า URL');

    stopScanLoop();
    stopCamera();
  }
}

/**************************************************
 * FACE: CLOCK-IN FROM SCAN
 **************************************************/
async function submitFromScan() {
  if (!lockedMatch || !lockedMatch.code) {
    alert('ยังไม่พบพนักงานจากการสแกน');
    return;
  }
  const code = lockedMatch.code;

  if (!confirm(`ยืนยันบันทึกเวลาให้: ${code} - ${lockedMatch.fullName} ?`)) return;

  try {
    const position = await getCurrentPositionPromise({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    const { latitude, longitude } = position.coords;

    const evidenceBase64 = captureFrameBase64();

    const payload = {
      code,
      lat: latitude,
      lng: longitude,
      manualType: 'FACE_SCAN',
      evidenceBase64,
      evidenceName: `scan-${code}-${Date.now()}.jpg`
    };

    const res = await api.call('saveManualLog', payload);

    updateLatestFromManual(res);
    loadTodaySummary();

    alert(`บันทึกสำเร็จ: ${res.time} (${res.slot})\nสถานะ: ${res.status || '-'}`);

    lockedMatch = null;
    stableHit = 0;
    $('btnScanSubmit').disabled = true;
    setScanPills('สแกนต่อได้', '-');

  } catch (err) {
    console.error(err);
    alert('บันทึกจากการสแกนไม่สำเร็จ: ' + err.message);
  }
}

/**************************************************
 * ENROLL FACE (PC modal)
 **************************************************/
function openEnrollModalPC() {
  $('enrollLoginError').style.display = 'none';
  $('enrollDoError').style.display = 'none';
  $('enrollDoSuccess').style.display = 'none';

  $('enrollStepLogin').style.display = enrollAuthed ? 'none' : 'block';
  $('enrollStepDo').style.display = enrollAuthed ? 'block' : 'none';

  $('enrollInfo').textContent = 'ถ้ากล้องยังไม่เปิด ให้กด “เปิดกล้อง”';
  showModal('modalEnroll');
}

async function enrollLoginPC() {
  const u = $('enrollUser').value.trim();
  const p = $('enrollPass').value.trim();
  const err = $('enrollLoginError');

  err.style.display = 'none';

  try {
    const res = await api.call('loginAdmin', { username: u, password: p });
    if (!res || !res.success) throw new Error('เข้าสู่ระบบไม่สำเร็จ');
    enrollAuthed = true;

    $('enrollStepLogin').style.display = 'none';
    $('enrollStepDo').style.display = 'block';

  } catch (e) {
    err.textContent = e.message || String(e);
    err.style.display = 'block';
  }
}

async function enrollStartCameraPC() {
  const info = $('enrollInfo');
  try {
    const ok = await ensureModelsLoaded();
    if (!ok) throw new Error('โมเดลไม่พร้อม');

    const deviceId = $('cameraSelect').value;
    await startCamera(deviceId || '');
    info.textContent = 'กล้องพร้อมแล้ว ✅ (จัดหน้าตรง ๆ แล้วกด “ถ่ายและบันทึกใบหน้า”)';
  } catch (e) {
    console.error(e);
    info.textContent = 'เปิดกล้องไม่สำเร็จ: ' + e.message;
  }
}

async function enrollCaptureAndUploadPC() {
  const code = $('enrollCode').value.trim();
  const err = $('enrollDoError');
  const suc = $('enrollDoSuccess');
  err.style.display = 'none';
  suc.style.display = 'none';

  if (!code) {
    err.textContent = 'กรุณากรอกรหัสพนักงาน';
    err.style.display = 'block';
    return;
  }

  if (!camStream) {
    err.textContent = 'ยังไม่ได้เปิดกล้อง กรุณากด “เปิดกล้อง”';
    err.style.display = 'block';
    return;
  }

  const ok = await ensureModelsLoaded();
  if (!ok) {
    err.textContent = 'โมเดลไม่พร้อม ตรวจสอบโฟลเดอร์ models/';
    err.style.display = 'block';
    return;
  }

  try {
    const video = $('camVideo');
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

    const result = await faceapi
      .detectSingleFace(video, opts)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!result) {
      throw new Error('ไม่พบใบหน้าในภาพ กรุณาขยับเข้าใกล้/ปรับแสง แล้วลองใหม่');
    }

    const faceData = JSON.stringify(Array.from(result.descriptor));
    const photoBase64 = captureFrameBase64();

    const payload = {
      code,
      faceData,
      photoBase64,
      fileName: `face-${code}-${Date.now()}.jpg`
    };

    const res = await api.call('uploadEmployeeFace', payload);

    suc.textContent = `บันทึกใบหน้าสำเร็จ ✅ (${res.code})`;
    suc.style.display = 'block';

    const fresh = await api.call('getEmployees');
    employeesCache = fresh || [];
    rebuildDatalist();

  } catch (e) {
    console.error(e);
    err.textContent = e.message || String(e);
    err.style.display = 'block';
  }
}

/**************************************************
 * ENROLL FACE (Mobile Sheet)
 **************************************************/
function openEnrollMobileSheet() {
  setTab('scan');

  $('mEnrollLoginError').style.display = 'none';
  $('mEnrollDoError').style.display = 'none';
  $('mEnrollDoSuccess').style.display = 'none';

  $('mEnrollStepLogin').style.display = enrollAuthed ? 'none' : 'block';
  $('mEnrollStepDo').style.display = enrollAuthed ? 'block' : 'none';

  $('mEnrollInfo').textContent = 'ถ้ากล้องยังไม่เปิด ให้กด “เปิดกล้อง”';
  showSheet('enrollSheetBackdrop');
}

async function enrollLoginMobile() {
  const u = $('mEnrollUser').value.trim();
  const p = $('mEnrollPass').value.trim();
  const err = $('mEnrollLoginError');
  err.style.display = 'none';

  try {
    const res = await api.call('loginAdmin', { username: u, password: p });
    if (!res || !res.success) throw new Error('เข้าสู่ระบบไม่สำเร็จ');
    enrollAuthed = true;

    $('mEnrollStepLogin').style.display = 'none';
    $('mEnrollStepDo').style.display = 'block';

  } catch (e) {
    err.textContent = e.message || String(e);
    err.style.display = 'block';
  }
}

async function enrollStartCameraMobile() {
  const info = $('mEnrollInfo');
  try {
    const ok = await ensureModelsLoaded();
    if (!ok) throw new Error('โมเดลไม่พร้อม');

    const deviceId = $('cameraSelect').value;
    await startCamera(deviceId || '');
    info.textContent = 'กล้องพร้อมแล้ว ✅ (ดูหน้าคุณบนการ์ดกล้องด้านบน แล้วกด “ถ่ายและบันทึกใบหน้า”)';
  } catch (e) {
    console.error(e);
    info.textContent = 'เปิดกล้องไม่สำเร็จ: ' + e.message;
  }
}

async function enrollCaptureAndUploadMobile() {
  const code = $('mEnrollCode').value.trim();
  const err = $('mEnrollDoError');
  const suc = $('mEnrollDoSuccess');
  err.style.display = 'none';
  suc.style.display = 'none';

  if (!code) {
    err.textContent = 'กรุณากรอกรหัสพนักงาน';
    err.style.display = 'block';
    return;
  }

  if (!camStream) {
    err.textContent = 'ยังไม่ได้เปิดกล้อง กรุณากด “เปิดกล้อง”';
    err.style.display = 'block';
    return;
  }

  const ok = await ensureModelsLoaded();
  if (!ok) {
    err.textContent = 'โมเดลไม่พร้อม ตรวจสอบโฟลเดอร์ models/';
    err.style.display = 'block';
    return;
  }

  try {
    const video = $('camVideo');
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

    const result = await faceapi
      .detectSingleFace(video, opts)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!result) throw new Error('ไม่พบใบหน้าในภาพ กรุณาจัดหน้าตรง/ปรับแสง แล้วลองใหม่');

    const faceData = JSON.stringify(Array.from(result.descriptor));
    const photoBase64 = captureFrameBase64();

    const payload = {
      code,
      faceData,
      photoBase64,
      fileName: `face-${code}-${Date.now()}.jpg`
    };

    const res = await api.call('uploadEmployeeFace', payload);

    suc.textContent = `บันทึกใบหน้าสำเร็จ ✅ (${res.code})`;
    suc.style.display = 'block';

    const fresh = await api.call('getEmployees');
    employeesCache = fresh || [];
    rebuildDatalist();

  } catch (e) {
    console.error(e);
    err.textContent = e.message || String(e);
    err.style.display = 'block';
  }
}

/**************************************************
 * TAB CONTROL (Mobile)
 **************************************************/
function setTab(tabName){
  document.body.dataset.tab = tabName;
  const nav = $('mobileBottomNav');
  if(!nav) return;
  nav.querySelectorAll('.nav-item').forEach(item=>{
    item.classList.toggle('active', item.getAttribute('data-tab') === tabName);
  });
}

/**************************************************
 * MENU SHEET (Mobile)
 **************************************************/
function openMenuSheet(){ showSheet('menuSheetBackdrop'); }
function closeMenuSheet(){ hideSheet('menuSheetBackdrop'); }
function closeEnrollSheet(){ hideSheet('enrollSheetBackdrop'); }

/**************************************************
 * EVENT BINDING + CLEANUP
 **************************************************/
document.addEventListener('DOMContentLoaded', async () => {
  if (isMobile()) setTab('scan');

  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    await listCameras();
  }

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close-modal');
      hideModal(id);
      if (id === 'modalEnroll') { stopScanLoop(); stopCamera(); }
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) {
        backdrop.classList.remove('show');
        if (backdrop.id === 'modalEnroll') { stopScanLoop(); stopCamera(); }
      }
    });
  });

  $('menuSheetBackdrop').addEventListener('click', (e)=>{
    if(e.target === $('menuSheetBackdrop')) closeMenuSheet();
  });
  $('enrollSheetBackdrop').addEventListener('click', (e)=>{
    if(e.target === $('enrollSheetBackdrop')) closeEnrollSheet();
  });

  $('btnSetUrl').addEventListener('click', openUrlModal);
  $('btnSaveUrl').addEventListener('click', saveUrl);
  $('btnResetUrl').addEventListener('click', resetUrl);

  $('btnGoAdmin').addEventListener('click', () => { window.location.href = 'admin.html'; });

  $('btnOpenManualModal').addEventListener('click', () => {
    $('manualCode').value = '';
    $('manualFile').value = '';
    $('manualType').value = 'AUTO';
    $('manualResult').value = '';
    $('manualError').style.display = 'none';
    $('manualSuccess').style.display = 'none';
    $('manualEmpInfo').textContent = 'กรอกรหัสแล้วระบบจะแสดงชื่อ-สกุล / แผนก / ระดับ';
    showModal('modalManual');
  });
  $('manualCode').addEventListener('input', updateManualEmpInfo);
  $('btnManualSubmit').addEventListener('click', submitManual);

  $('btnOpenCheckToday').addEventListener('click', () => {
    $('checkCode').value = '';
    $('checkResult').value = '';
    $('checkError').style.display = 'none';
    showModal('modalCheckToday');
  });
  $('btnCheckTodaySubmit').addEventListener('click', submitCheckToday);

  $('btnRefreshToday').addEventListener('click', loadTodaySummary);

  $('btnEnrollFace').addEventListener('click', () => {
    if (isMobile()) openEnrollMobileSheet();
    else openEnrollModalPC();
  });

  $('btnEnrollLogin').addEventListener('click', enrollLoginPC);
  $('btnEnrollStartCam').addEventListener('click', enrollStartCameraPC);
  $('btnEnrollCapture').addEventListener('click', enrollCaptureAndUploadPC);

  $('cameraSelect').addEventListener('change', async () => {
    if (!camStream) return;
    try {
      const id = $('cameraSelect').value;
      await startCamera(id || '');
    } catch (e) {
      console.error(e);
    }
  });

  $('btnStartScan').addEventListener('click', async () => {
    try {
      const apiUrl = getApiUrl();
      if (!apiUrl) return alert('กรุณาตั้งค่า URL API ก่อน');

      const ok = await ensureModelsLoaded();
      if (!ok) return alert('โหลดโมเดลไม่สำเร็จ ตรวจสอบโฟลเดอร์ models/ และ https');

      const deviceId = $('cameraSelect').value;
      await startCamera(deviceId || '');
      startScanLoop();
    } catch (e) {
      console.error(e);
      alert('เริ่มสแกนไม่ได้: ' + (e.message || e));
    }
  });

  $('btnStopScan').addEventListener('click', () => {
    stopScanLoop();
    stopCamera();
  });

  $('btnScanSubmit').addEventListener('click', submitFromScan);

  const nav = $('mobileBottomNav');
  if(nav){
    nav.querySelectorAll('.nav-item').forEach(item=>{
      item.addEventListener('click', ()=>{
        const tab = item.getAttribute('data-tab');
        setTab(tab);
      });
    });
  }

  $('btnHamburger').addEventListener('click', openMenuSheet);
  $('btnCloseMenuSheet').addEventListener('click', closeMenuSheet);

  $('mBtnSetUrl').addEventListener('click', ()=>{ closeMenuSheet(); openUrlModal(); });
  $('mBtnResetUrl').addEventListener('click', ()=>{ closeMenuSheet(); resetUrl(); });
  $('mBtnEnrollFace').addEventListener('click', ()=>{ closeMenuSheet(); openEnrollMobileSheet(); });
  $('mBtnGoAdmin').addEventListener('click', ()=>{ closeMenuSheet(); window.location.href='admin.html'; });

  $('btnCloseEnrollSheet').addEventListener('click', closeEnrollSheet);
  $('mBtnEnrollCancelLogin').addEventListener('click', closeEnrollSheet);
  $('mBtnEnrollLogin').addEventListener('click', enrollLoginMobile);
  $('mBtnEnrollClose').addEventListener('click', closeEnrollSheet);
  $('mBtnEnrollStartCam').addEventListener('click', enrollStartCameraMobile);
  $('mBtnEnrollCapture').addEventListener('click', enrollCaptureAndUploadMobile);

  init();
});

window.addEventListener('beforeunload', () => {
  try { stopScanLoop(); } catch(e){}
  try { stopCamera(); } catch(e){}
});
