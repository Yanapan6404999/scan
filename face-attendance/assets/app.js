/* =========================
   Face Attendance - app.js
   - แยก Mobile/PC ชัด
   - Mobile มี 3 ขีด + Drawer + Bottom Nav
   - PC ไม่มี 3 ขีด, มี status pill ชิดขวาล่าง hero card
   - ฟีเจอร์ครบ: scan/manual/check/summary/hr login/upload face
========================= */

(() => {
  "use strict";

  // ===== LocalStorage Keys =====
  const LS_API = "attendance_api_url_v2";
  const LS_ADMIN_TOKEN = "attendance_admin_token_v1";
  const LS_LAST_RESULT = "attendance_last_result_v1";

  // ===== State =====
  let stream = null;
  let lastCapturedBlob = null;
  let lastCapturedInfo = null;
  let busy = false;

  // ===== Helpers =====
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const isMobile = () => window.matchMedia("(max-width: 979px)").matches;

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtDT = (d = new Date()) => {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear() + 543} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ===== Toast =====
  function toast(msg) {
    const el = $("toast");
    const msgEl = $("toastMsg");
    if (!el || !msgEl) return alert(msg);
    msgEl.textContent = msg;
    el.style.display = "block";
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => (el.style.display = "none"), 3200);
  }
  $("toastClose")?.addEventListener("click", () => ($("toast").style.display = "none"));

  // ===== Busy Lock =====
  function setBusy(v) {
    busy = v;
    const ids = [
      "btnStartCam","btnStopCam","btnCapture",
      "btnSubmitScan","btnQuickCheck",
      "btnSubmitManual",
      "btnCheckByCode","btnTodaySummary",
      "btnLogin","btnUploadFace",
      "btnSaveUrl","btnResetUrl",
      "btnPingPC","btnPingSide","btnPingDrawer",
      "btnClearPC","btnClearSide","btnClearLocal"
    ];
    ids.forEach(id => {
      const b = $(id);
      if (b && b.tagName === "BUTTON") b.disabled = !!v;
    });
  }

  // ===== API URL =====
  function getApiUrl() {
    return (localStorage.getItem(LS_API) || "").trim();
  }
  function setApiUrl(url) {
    localStorage.setItem(LS_API, (url || "").trim());
    refreshApiStatus();
  }
  function shortUrl(url) {
    if (!url) return "ยังไม่ได้ตั้งค่า";
    try {
      const u = new URL(url);
      return u.hostname + u.pathname.replace(/\/macros\/s\//, "/s/");
    } catch {
      return url.length > 42 ? url.slice(0, 42) + "…" : url;
    }
  }

  function setDotText(dotEl, textEl, okState) {
    if (!dotEl || !textEl) return;
    dotEl.classList.remove("ok", "warn");
    if (okState === "ok") dotEl.classList.add("ok");
    else if (okState === "warn") dotEl.classList.add("warn");
    // default red is base .dot
    textEl.textContent = okState === "ok" ? "พร้อมใช้งาน" : "ยังไม่ได้ตั้งค่า URL";
  }

  function refreshApiStatus() {
    const url = getApiUrl();

    // Mobile
    const mDot = $("mApiDot");
    const mText = $("mApiText");

    // PC
    const pcDot = $("pcApiDot");
    const pcText = $("pcApiText");

    // PC Meta
    $("pcApiUrlShort") && ($("pcApiUrlShort").textContent = shortUrl(url));

    if (!url) {
      setDotText(mDot, mText, "warn");
      setDotText(pcDot, pcText, "warn");
      $("pcApiUrlShort") && ($("pcApiUrlShort").textContent = "ยังไม่ได้ตั้งค่า");
      return;
    }

    // มี URL แล้ว => แสดงเป็น ok (การทดสอบจริงใช้ปุ่มทดสอบ API)
    if (mDot && mText) { mDot.className = "dot ok"; mText.textContent = "พร้อมใช้งาน"; }
    if (pcDot && pcText) { pcDot.className = "dot ok"; pcText.textContent = "พร้อมใช้งาน"; }
  }

  // ===== Drawer =====
  function openDrawer() {
    $("drawerBackdrop").style.display = "block";
    $("drawer").classList.add("open");
    $("apiUrlInput").value = getApiUrl();
  }
  function closeDrawer() {
    $("drawerBackdrop").style.display = "none";
    $("drawer").classList.remove("open");
  }

  $("btnMobileMenu")?.addEventListener("click", openDrawer);
  $("btnOpenDrawerPC")?.addEventListener("click", openDrawer);
  $("btnOpenDrawerSide")?.addEventListener("click", openDrawer);
  $("btnCloseDrawer")?.addEventListener("click", closeDrawer);
  $("drawerBackdrop")?.addEventListener("click", closeDrawer);

  $("btnSaveUrl")?.addEventListener("click", () => {
    const url = $("apiUrlInput").value.trim();
    if (!url) return toast("กรุณาวาง URL ที่ลงท้ายด้วย /exec");
    setApiUrl(url);
    toast("บันทึก URL แล้ว ✅");
    closeDrawer();
  });

  $("btnResetUrl")?.addEventListener("click", () => {
    localStorage.removeItem(LS_API);
    refreshApiStatus();
    toast("Reset URL แล้ว ✅");
  });

  // ===== Navigation =====
  function showSection(id) {
    ["secScan","secManual","secCheck","secHR"].forEach(s => {
      $(s)?.classList.toggle("active", s === id);
    });

    // desktop tabs
    $$("#desktopTabs .tab").forEach(t => {
      t.classList.toggle("active", t.dataset.target === id);
    });

    // mobile bottom nav
    $$("#bottomNav .bnBtn").forEach(b => {
      b.classList.toggle("active", b.dataset.target === id);
    });

    // adjust title (ช่วยให้เหมือนแอปบนมือถือ)
    const titleMap = {
      secScan: "📷 สแกนเข้า-ออก",
      secManual: "📝 บันทึกด้วยมือ",
      secCheck: "🔎 ตรวจสอบวันนี้",
      secHR: "🧰 HR / แอดมิน"
    };
    $("mainTitle") && ($("mainTitle").textContent = titleMap[id] || "📷 โหมดสแกน / บันทึก / ตรวจสอบ");
  }

  $$("#desktopTabs .tab").forEach(t => t.addEventListener("click", () => showSection(t.dataset.target)));
  $$("#bottomNav .bnBtn").forEach(b => b.addEventListener("click", () => showSection(b.dataset.target)));

  // ===== Now / Device badges =====
  function initBadges() {
    $("nowBadge") && ($("nowBadge").textContent = fmtDT());
    $("pcNowText") && ($("pcNowText").textContent = fmtDT());
    $("pcDeviceText") && ($("pcDeviceText").textContent = isMobile() ? "Mobile" : "Desktop");
    $("deviceBadge") && ($("deviceBadge").textContent = isMobile() ? "Mobile" : "Desktop");

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = pad2(today.getMonth() + 1);
    const dd = pad2(today.getDate());
    $("cDate") && ($("cDate").value = `${yyyy}-${mm}-${dd}`);
  }

  // ===== Last Result =====
  function saveLastResult(obj) {
    localStorage.setItem(LS_LAST_RESULT, JSON.stringify(obj));
    renderLastResult();
  }

  function renderLastResult() {
    const raw = localStorage.getItem(LS_LAST_RESULT);
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      $("lastBadge") && ($("lastBadge").textContent = obj.time || "—");
      if ($("lastBox")) {
        $("lastBox").innerHTML = `
          <div class="strong">${escapeHtml(obj.title || "บันทึกสำเร็จ")}</div>
          <div class="smallmuted mt10">${escapeHtml(obj.detail || "")}</div>
        `;
      }
    } catch {}
  }

  // ===== Clear Local =====
  function clearLocal() {
    localStorage.removeItem(LS_ADMIN_TOKEN);
    localStorage.removeItem(LS_LAST_RESULT);
    toast("ล้างค่าเครื่องนี้แล้ว ✅");
    renderLastResult();
    if ($("btnGoAdmin")) {
      $("btnGoAdmin").style.pointerEvents = "none";
      $("btnGoAdmin").style.opacity = ".55";
    }
  }
  $("btnClearPC")?.addEventListener("click", clearLocal);
  $("btnClearSide")?.addEventListener("click", clearLocal);
  $("btnClearLocal")?.addEventListener("click", clearLocal);

  // ===== API Post =====
  async function apiPost(action, payload = {}, fileMap = null) {
    const apiUrl = getApiUrl();
    if (!apiUrl) throw new Error("ยังไม่ได้ตั้งค่า URL (Apps Script)");

    let body;
    let headers = {};

    if (fileMap) {
      body = new FormData();
      body.append("action", action);
      Object.entries(payload || {}).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      });
      Object.entries(fileMap).forEach(([k, file]) => {
        if (file) body.append(k, file);
      });
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ action, ...payload });
    }

    const res = await fetch(apiUrl, { method: "POST", headers, body });
    const text = await res.text();

    let data;
    try { data = JSON.parse(text); }
    catch { data = { ok: res.ok, raw: text }; }

    if (!res.ok) {
      const msg = (data && (data.message || data.error)) ? (data.message || data.error) : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // ===== Ping API =====
  async function pingApi() {
    try {
      setBusy(true);
      await apiPost("getTodaySummary", { ts: Date.now() });
      toast("API ใช้งานได้ ✅");
    } catch (e) {
      toast("ทดสอบไม่ผ่าน: " + e.message);
    } finally {
      setBusy(false);
    }
  }
  $("btnPingPC")?.addEventListener("click", pingApi);
  $("btnPingSide")?.addEventListener("click", pingApi);
  $("btnPingDrawer")?.addEventListener("click", pingApi);

  // ===== GPS =====
  function getGPS() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    });
  }

  // ===== Camera =====
  async function loadCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");

      const sel = $("cameraSelect");
      if (!sel) return;

      sel.innerHTML = cams
        .map((c, i) => `<option value="${c.deviceId}">${escapeHtml(c.label || `Camera ${i + 1}`)}</option>`)
        .join("");

      if (cams.length && !sel.value) sel.value = cams[0].deviceId;
    } catch {}
  }

  async function startCamera() {
    if (busy) return;
    stopCamera();

    const sel = $("cameraSelect");
    const deviceId = sel?.value || undefined;

    try {
      setBusy(true);
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" },
        audio: false
      });

      const v = $("video");
      if (!v) return;

      v.srcObject = stream;
      await v.play();
      v.style.display = "block";
      $("camHint") && ($("camHint").style.display = "none");
      toast("เปิดกล้องแล้ว ✅");
    } catch (err) {
      stopCamera();
      toast("เปิดกล้องไม่สำเร็จ: " + (err?.message || "unknown"));
    } finally {
      setBusy(false);
    }
  }

  function stopCamera() {
    const v = $("video");
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (v) {
      v.pause();
      v.srcObject = null;
      v.style.display = "none";
    }
    $("camHint") && ($("camHint").style.display = "block");
  }

  function capture() {
    const v = $("video");
    if (!stream || !v || v.readyState < 2) {
      toast("กล้องยังไม่พร้อม");
      return;
    }

    const canvas = document.createElement("canvas");
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(v, 0, 0, w, h);

    canvas.toBlob((blob) => {
      if (!blob) return toast("ถ่ายรูปไม่สำเร็จ");
      lastCapturedBlob = blob;
      lastCapturedInfo = { w, h, size: blob.size, time: new Date().toISOString() };

      const thumb = $("thumb");
      const info = $("previewInfo");
      const row = $("previewRow");

      if (thumb) thumb.src = URL.createObjectURL(blob);
      if (info) info.textContent = `ขนาด ${w}×${h} | ${(blob.size / 1024).toFixed(0)} KB`;
      if (row) row.style.display = "flex";

      toast("ถ่ายรูปแล้ว ✅");
    }, "image/jpeg", 0.85);
  }

  $("btnStartCam")?.addEventListener("click", startCamera);
  $("btnStopCam")?.addEventListener("click", () => { stopCamera(); toast("ปิดกล้องแล้ว"); });
  $("btnCapture")?.addEventListener("click", capture);

  // ===== Actions: Submit Scan =====
  $("btnSubmitScan")?.addEventListener("click", async () => {
    try {
      if (busy) return;
      setBusy(true);

      const code = $("scanCode")?.value.trim();
      const type = $("scanType")?.value || "IN";
      const note = $("scanNote")?.value.trim() || "";

      if (!code) { toast("กรุณากรอกรหัสพนักงาน"); return; }

      const gps = ($("useGps")?.value === "1") ? await getGPS() : null;

      const payload = {
        employeeCode: code,
        type,
        note,
        gps,
        source: "scan",
        device: isMobile() ? "mobile" : "desktop",
        captured: lastCapturedInfo || null,
        clientTime: new Date().toISOString()
      };

      const evidenceFile = $("scanEvidence")?.files?.[0] || null;
      const photoFile = lastCapturedBlob
        ? new File([lastCapturedBlob], `capture_${Date.now()}.jpg`, { type: "image/jpeg" })
        : null;

      const res = await apiPost("saveManualLog", payload, { photo: photoFile, evidence: evidenceFile });

      $("resultBadge") && ($("resultBadge").textContent = "สำเร็จ");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong">✅ บันทึกสำเร็จ</div>
          <div class="smallmuted mt10">${escapeHtml(JSON.stringify(res))}</div>
        `;
      }

      saveLastResult({
        time: fmtDT(),
        title: `📌 บันทึก${type === "IN" ? "เข้า" : "ออก"} • รหัส ${code}`,
        detail: note ? `หมายเหตุ: ${note}` : "—"
      });

      toast("บันทึกสำเร็จ ✅");
    } catch (e) {
      $("resultBadge") && ($("resultBadge").textContent = "ผิดพลาด");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong" style="color: var(--bad)">เกิดข้อผิดพลาด</div>
          <div class="smallmuted mt10">${escapeHtml(e.message)}</div>
        `;
      }
      toast("ผิดพลาด: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  $("btnQuickCheck")?.addEventListener("click", () => {
    showSection("secCheck");
    const v = $("scanCode")?.value.trim() || "";
    $("cCode") && ($("cCode").value = v);
    setTimeout(() => $("btnCheckByCode")?.click(), 60);
  });

  // ===== Actions: Manual =====
  $("btnSubmitManual")?.addEventListener("click", async () => {
    try {
      if (busy) return;
      setBusy(true);

      const code = $("mCode")?.value.trim();
      const type = $("mType")?.value || "IN";
      const reason = $("mReason")?.value.trim();

      if (!code) { toast("กรุณากรอกรหัสพนักงาน"); return; }
      if (!reason) { toast("กรุณากรอกเหตุผล/หมายเหตุ"); return; }

      const gps = ($("mUseGps")?.value === "1") ? await getGPS() : null;
      const evidenceFile = $("mEvidence")?.files?.[0] || null;

      const payload = {
        employeeCode: code,
        type,
        note: reason,
        gps,
        source: "manual",
        device: isMobile() ? "mobile" : "desktop",
        clientTime: new Date().toISOString()
      };

      const res = await apiPost("saveManualLog", payload, { evidence: evidenceFile });

      $("resultBadge") && ($("resultBadge").textContent = "สำเร็จ");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong">✅ บันทึกด้วยมือสำเร็จ</div>
          <div class="smallmuted mt10">${escapeHtml(JSON.stringify(res))}</div>
        `;
      }

      saveLastResult({
        time: fmtDT(),
        title: `📝 บันทึกด้วยมือ • ${type === "IN" ? "เข้า" : "ออก"} • รหัส ${code}`,
        detail: reason
      });

      toast("บันทึกด้วยมือสำเร็จ ✅");
      showSection("secCheck");
    } catch (e) {
      toast("ผิดพลาด: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  // ===== Actions: Check By Code =====
  $("btnCheckByCode")?.addEventListener("click", async () => {
    try {
      if (busy) return;
      setBusy(true);

      const code = $("cCode")?.value.trim();
      const date = $("cDate")?.value;

      if (!code) { toast("กรุณากรอกรหัสพนักงาน"); return; }

      const res = await apiPost("getTodayByCode", { employeeCode: code, date });

      $("resultBadge") && ($("resultBadge").textContent = "โหลดแล้ว");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong">🧾 ผลการเช็ค • รหัส ${escapeHtml(code)}</div>
          <pre class="preBox">${escapeHtml(JSON.stringify(res, null, 2))}</pre>
        `;
      }
      toast("ดึงข้อมูลสำเร็จ ✅");
    } catch (e) {
      $("resultBadge") && ($("resultBadge").textContent = "ผิดพลาด");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong" style="color: var(--bad)">เกิดข้อผิดพลาด</div>
          <div class="smallmuted mt10">${escapeHtml(e.message)}</div>
        `;
      }
      toast("ผิดพลาด: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  // ===== Actions: Today Summary =====
  $("btnTodaySummary")?.addEventListener("click", async () => {
    try {
      if (busy) return;
      setBusy(true);

      const res = await apiPost("getTodaySummary", { date: $("cDate")?.value });

      $("resultBadge") && ($("resultBadge").textContent = "สรุปแล้ว");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong">📊 สรุปภาพรวมวันนี้</div>
          <pre class="preBox">${escapeHtml(JSON.stringify(res, null, 2))}</pre>
        `;
      }
      toast("โหลดสรุปสำเร็จ ✅");
    } catch (e) {
      toast("ผิดพลาด: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  // ===== HR: Login =====
  $("btnLogin")?.addEventListener("click", async () => {
    try {
      if (busy) return;
      setBusy(true);

      const username = $("hrUser")?.value.trim();
      const password = $("hrPass")?.value;

      if (!username || !password) { toast("กรุณากรอก Username/Password"); return; }

      const res = await apiPost("loginAdmin", { username, password });

      const token = res?.token || res?.data?.token || "ok";
      localStorage.setItem(LS_ADMIN_TOKEN, token);

      if ($("btnGoAdmin")) {
        $("btnGoAdmin").style.pointerEvents = "auto";
        $("btnGoAdmin").style.opacity = "1";
      }
      toast("เข้าสู่ระบบสำเร็จ ✅");
    } catch (e) {
      toast("เข้าสู่ระบบไม่สำเร็จ: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  // ===== HR: Upload Face =====
  $("btnUploadFace")?.addEventListener("click", async () => {
    try {
      if (busy) return;
      setBusy(true);

      const code = $("regCode")?.value.trim();
      const file = $("regFace")?.files?.[0] || null;

      if (!code) { toast("กรุณากรอกรหัสพนักงาน"); return; }
      if (!file) { toast("กรุณาเลือกรูปใบหน้า"); return; }

      const res = await apiPost("uploadEmployeeFace", { employeeCode: code }, { face: file });

      saveLastResult({
        time: fmtDT(),
        title: `🙂 อัปโหลดใบหน้า • รหัส ${code}`,
        detail: file.name
      });

      toast("อัปโหลดใบหน้าสำเร็จ ✅");
      // แสดงผลไว้ใน result box ด้วย
      $("resultBadge") && ($("resultBadge").textContent = "HR OK");
      if ($("resultBox")) {
        $("resultBox").innerHTML = `
          <div class="strong">🙂 อัปโหลดใบหน้าสำเร็จ</div>
          <pre class="preBox">${escapeHtml(JSON.stringify(res, null, 2))}</pre>
        `;
      }
    } catch (e) {
      toast("อัปโหลดไม่สำเร็จ: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  // ===== Add style for preBox via JS (กันลืม) =====
  function injectPreStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .preBox{
        margin-top:10px;
        background:#0b1220;
        color:#e5e7eb;
        padding:12px;
        border-radius:14px;
        overflow:auto;
        border:1px solid rgba(255,255,255,.10);
        font-size:12px;
        line-height:1.5;
        white-space:pre-wrap;
        word-break:break-word;
      }
    `;
    document.head.appendChild(style);
  }

  // ===== Init =====
  async function init() {
    injectPreStyle();
    refreshApiStatus();
    initBadges();
    renderLastResult();

    // set admin link state
    if (localStorage.getItem(LS_ADMIN_TOKEN) && $("btnGoAdmin")) {
      $("btnGoAdmin").style.pointerEvents = "auto";
      $("btnGoAdmin").style.opacity = "1";
    }

    // camera permission soft request (เพื่อให้ชื่อกล้องโชว์)
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach(t => t.stop());
      } catch {
        // ไม่บังคับ
      }
      await loadCameras();
    } else {
      toast("เบราว์เซอร์นี้ไม่รองรับกล้อง");
    }

    // refresh time periodically
    setInterval(() => {
      $("nowBadge") && ($("nowBadge").textContent = fmtDT());
      $("pcNowText") && ($("pcNowText").textContent = fmtDT());
    }, 10000);

    // sync device badge
    const syncDevice = () => {
      $("deviceBadge") && ($("deviceBadge").textContent = isMobile() ? "Mobile" : "Desktop");
      $("pcDeviceText") && ($("pcDeviceText").textContent = isMobile() ? "Mobile" : "Desktop");
    };
    window.addEventListener("resize", syncDevice);

    // quick open drawer buttons in PC
    // (ป้องกัน null)
    $("btnOpenDrawerPC") && $("btnOpenDrawerPC").addEventListener("click", openDrawer);

    // default section
    showSection("secScan");
  }

  init().catch(e => toast("Init error: " + e.message));
})();
