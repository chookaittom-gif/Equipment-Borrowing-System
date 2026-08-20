/**
 * ==========================================================================
 * ระบบยืม-คืนอุปกรณ์ — Application JavaScript (app.js)
 * Architecture: Static Frontend + GAS JSON API Backend
 * ==========================================================================
 */

const DEFAULT_API_URL =
  'https://script.google.com/macros/s/AKfycbw3_b4wgORPU3_adSboZbe5XOJAFUYSPx1JpiQk8FaZICOWB-qDI0YPVUaZVvoTYax2/exec';
const DEFAULT_FRONTEND_URL = 'https://equipment-borrowing-system-seven.vercel.app';

function resolveApiUrl() {
  const candidate = String(window.APP_CONFIG?.apiUrl || '').trim();
  if (/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(candidate)) {
    return candidate;
  }
  return DEFAULT_API_URL;
}

function resolveFrontendUrl() {
  const candidate = String(window.APP_CONFIG?.frontendUrl || '').trim().replace(/\/$/, '');
  if (/^https:\/\/.+/i.test(candidate)) {
    return candidate;
  }
  const path = window.location.pathname.replace(/\/$/, '');
  return window.location.origin + (path === '' ? '' : path);
}

// ==========================================
// Centralized API Client (Fetch + AbortController + Timeout + Retries)
// ==========================================
const API_DEFAULT_TIMEOUT_MS = 30000;
const API_HEAVY_TIMEOUT_MS = 120000;
const API_MAX_GET_ATTEMPTS = 3;
const API_RETRYABLE_HTTP = new Set([404, 429, 500, 502, 503, 504]);
const API_RETRYABLE_CODES = new Set(['SYSTEM_BUSY', 'TEMPORARY_ERROR', 'RATE_LIMITED']);
const API_READ_ONLY_POST_ACTIONS = new Set(['getUsers', 'getReportData']);
const ADMIN_USERS_CACHE_MS = 2 * 60 * 1000;
const ADMIN_SESSION_CHECK_MS = 15000;
const ADMIN_SESSION_EXPIRY_KEY = 'adminSessionExpiry';
const ADMIN_USER_KEY = 'adminUser';
const ADMIN_SESSION_TOKEN_KEY = 'adminSessionToken';
const ADMIN_AUTH_ERROR_CODES = new Set(['UNAUTHORIZED', 'SESSION_EXPIRED']);

function createApiError(message, fields) {
  const err = new Error(message);
  err.action = fields.action || null;
  err.httpStatus = fields.httpStatus != null ? fields.httpStatus : null;
  err.errorCode = fields.errorCode || null;
  err.attempt = fields.attempt || 1;
  return err;
}

function getAdminSessionToken() {
  try {
    return localStorage.getItem(ADMIN_SESSION_TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function isNetworkFetchError(error) {
  if (!error) return false;
  if (error instanceof TypeError) return true;
  const msg = String(error.message || '');
  return /Failed to fetch|NetworkError|network|Load failed/i.test(msg);
}

async function waitApiRetry(attemptIndex, retryAfterHeader) {
  if (retryAfterHeader != null && retryAfterHeader !== '') {
    const sec = parseInt(retryAfterHeader, 10);
    if (!isNaN(sec) && sec >= 0) {
      await new Promise(resolve => setTimeout(resolve, sec * 1000));
      return;
    }
  }
  const baseMs = attemptIndex === 0 ? 500 : 1000;
  const jitterMs = Math.floor(Math.random() * 200);
  await new Promise(resolve => setTimeout(resolve, baseMs + jitterMs));
}

async function apiRequest(action, payload = {}, options = {}) {
  const timeoutMs = options.timeout || API_DEFAULT_TIMEOUT_MS;
  const apiUrl = resolveApiUrl();
  const isPost = options.method === 'POST' || [
    'verifyAdminPin', 'saveUser', 'updateUser', 'deleteUser',
    'saveBorrowRequest', 'returnEquipment', 'returnAllEquipment', 'approveBorrowRequest',
    'rejectBorrowRequest', 'saveEquipment', 'deleteEquipment', 'saveContactForm',
    'getUsers', 'getReportData', 'logoutAdmin'
  ].includes(action);

  const canRetry = !isPost || API_READ_ONLY_POST_ACTIONS.has(action);
  const maxAttempts = canRetry ? API_MAX_GET_ATTEMPTS : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let onExternalAbort = null;

    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutId);
        throw createApiError('คำขอถูกยกเลิก', {
          action,
          errorCode: 'REQUEST_ABORTED',
          attempt
        });
      }
      onExternalAbort = () => controller.abort();
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      let response;
      if (isPost) {
        // Use text/plain body to prevent CORS preflight OPTIONS block on script.google.com
        const postBody = JSON.stringify({
          action,
          payload,
          sessionToken: getAdminSessionToken()
        });
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: postBody,
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal
        });
      } else {
        const queryParams = new URLSearchParams({
          action: action,
          payload: JSON.stringify(payload),
          _ts: `${Date.now()}_${attempt}`
        });
        response = await fetch(`${apiUrl}?${queryParams.toString()}`, {
          method: 'GET',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal
        });
      }

      if (!response.ok) {
        let errorCode = 'HTTP_ERROR';
        let message = `HTTP Error: ${response.status} ${response.statusText}`;
        if (response.status === 404) {
          errorCode = 'NOT_FOUND';
          message = 'ไม่พบ Backend API (404) กรุณา Deploy Google Apps Script ใหม่และตรวจสอบ URL ใน APP_CONFIG';
        } else if (response.status === 429) {
          errorCode = 'RATE_LIMITED';
          message = 'คำขอถูกจำกัดชั่วคราว กรุณาลองใหม่อีกครั้ง';
        } else if (API_RETRYABLE_HTTP.has(response.status)) {
          errorCode = 'TEMPORARY_ERROR';
          message = `เซิร์ฟเวอร์ไม่พร้อมชั่วคราว (${response.status}) กรุณาลองใหม่อีกครั้ง`;
        }

        const httpErr = createApiError(message, {
          action,
          httpStatus: response.status,
          errorCode,
          attempt
        });

        if (canRetry && API_RETRYABLE_HTTP.has(response.status) && attempt < maxAttempts) {
          lastError = httpErr;
          await waitApiRetry(attempt - 1, response.headers.get('Retry-After'));
          continue;
        }
        throw httpErr;
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        throw createApiError('ได้รับข้อมูลว่างเปล่าจากเซิร์ฟเวอร์', {
          action,
          httpStatus: response.status,
          errorCode: 'EMPTY_RESPONSE',
          attempt
        });
      }

      // Bug #4 fix: Detect GAS HTML redirect/login page using anchored checks only.
      // Previously used text.includes('<html') which false-positives on equipment names containing 'html'.
      // Now matches: DOCTYPE at string start (trimmed), or <html as a full opening tag, or Google login markers.
      const trimmedText = text.trimStart();
      const isHtmlResponse =
        /^<!DOCTYPE\s+html/i.test(trimmedText) ||
        /^<html[\s>]/i.test(trimmedText) ||
        text.includes('accounts.google.com') ||
        text.includes('ServiceLogin') ||
        text.includes('google-site-verification');
      if (isHtmlResponse) {
        throw createApiError('ระบบเซิร์ฟเวอร์ส่งกลับหน้า HTML ล็อกอิน กรุณาตั้งค่า GAS Web App Access เป็น Anyone', {
          action,
          httpStatus: response.status,
          errorCode: 'HTML_RESPONSE',
          attempt
        });
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw createApiError('รูปแบบข้อมูล JSON จากเซิร์ฟเวอร์ไม่ถูกต้อง', {
          action,
          httpStatus: response.status,
          errorCode: 'INVALID_JSON',
          attempt
        });
      }

      if (json.success === false) {
        const code = json.error?.code || json.data?.errorCode || 'SERVER_ERROR';
        const errMsg = json.error?.message || json.data?.message || json.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์';
        if (ADMIN_AUTH_ERROR_CODES.has(code)) {
          handleAdminAuthorizationError();
        }
        const apiErr = createApiError(errMsg, {
          action,
          httpStatus: response.status,
          errorCode: code,
          attempt
        });

        if (canRetry && API_RETRYABLE_CODES.has(code) && attempt < maxAttempts) {
          lastError = apiErr;
          await waitApiRetry(attempt - 1, null);
          continue;
        }
        throw apiErr;
      }

      return json.data !== undefined ? json.data : json;
    } catch (error) {
      if (error && error.errorCode === 'REQUEST_ABORTED') {
        throw error;
      }

      if (error && error.errorCode && !isNetworkFetchError(error) && error.name !== 'AbortError') {
        throw error;
      }

      const abortedByTimeout = error && error.name === 'AbortError' && !(options.signal && options.signal.aborted);
      const abortedByCaller = error && error.name === 'AbortError' && options.signal && options.signal.aborted;

      if (abortedByCaller) {
        throw createApiError('คำขอถูกยกเลิก', {
          action,
          errorCode: 'REQUEST_ABORTED',
          attempt
        });
      }

      const retryable = canRetry && (abortedByTimeout || isNetworkFetchError(error)) && attempt < maxAttempts;
      let userFriendlyMessage = error.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้';
      if (isNetworkFetchError(error)) {
        userFriendlyMessage = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ (หากล็อกอินบัญชี Google หลายบัญชีพร้อมกัน ให้ลองเปิดหน้าเว็บใน โหมดไม่ระบุตัวตน / Incognito Window)';
      }
      const wrapped = createApiError(
        abortedByTimeout
          ? 'การเชื่อมต่อหมดเวลา (Timeout) กรุณาลองใหม่อีกครั้ง'
          : userFriendlyMessage,
        {
          action,
          httpStatus: error.httpStatus != null ? error.httpStatus : null,
          errorCode: abortedByTimeout ? 'TIMEOUT' : (error.errorCode || 'NETWORK_ERROR'),
          attempt
        }
      );

      if (retryable) {
        lastError = wrapped;
        await waitApiRetry(attempt - 1, null);
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(timeoutId);
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  throw lastError || createApiError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', {
    action,
    errorCode: 'TEMPORARY_ERROR',
    attempt: maxAttempts
  });
}

// ==========================================
// Global Application State
// ==========================================
let equipmentData = [];
let transactionData = [];
let adminUsersData = [];
let adminUsersLoadedAt = 0;
let currentUser = null;
let isAdminMode = false;
const ITEMS_PER_PAGE = 10;
let currentPage = 1;
let adminEquipCurrentPage = 1;
let adminTransCurrentPage = 1;
let filteredEquipment = [];
let activeCategory = 'all';
let borrowChart = null;
let cart = [];
let cartModalOpen = false;
let imageZoomItems = [];
let imageZoomIndex = 0;
let imageZoomTrigger = null;

let signatureCanvas = null;
let signatureCtx = null;
let isDrawingSignature = false;
let hasSignature = false;
let signatureModalTrigger = null;
let loadDataSeq = 0;
let loadDataController = null;
let borrowSubmitRequestId = null;
const GET_DATA_CLIENT_CACHE_KEY = 'getDataClientCache';
const GET_DATA_CLIENT_CACHE_MS = 5 * 60 * 1000;

function readClientGetDataCache() {
  try {
    const raw = sessionStorage.getItem(GET_DATA_CLIENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.savedAt || !parsed.data || parsed.data.status !== 'success') return null;
    if (Date.now() - parsed.savedAt > GET_DATA_CLIENT_CACHE_MS) return null;
    return parsed.data;
  } catch (e) {
    return null;
  }
}

function writeClientGetDataCache(data) {
  try {
    if (!data || data.status !== 'success') return;
    sessionStorage.setItem(GET_DATA_CLIENT_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      data: {
        status: 'success',
        equipment: data.equipment || [],
        transactions: data.transactions || []
      }
    }));
  } catch (e) { /* ignore quota / private mode */ }
}

function applyLoadedData(res) {
  equipmentData = res.equipment || [];
  transactionData = (res.transactions || []).map(t => ({
    ...t,
    dateBorrow: formatThaiDate(t.dateBorrow),
    dateReturn: formatThaiDate(t.dateReturn)
  }));
  updateDashboardStats();
  renderCategoryFilters();
  filterEquipment();
  document.getElementById('borrow-section')?.classList.remove('hidden-section');

  const adminLayout = document.getElementById('admin-layout');
  if (adminLayout && !adminLayout.classList.contains('hidden-section')) {
    if (!document.getElementById('admin-equipment')?.classList.contains('hidden-section')) {
      renderAdminEquipmentTable();
    }
    if (!document.getElementById('admin-transactions')?.classList.contains('hidden-section')) {
      renderAdminTransactionsTable();
    }
    if (!document.getElementById('admin-dashboard')?.classList.contains('hidden-section')) {
      renderAdminDashboard();
    }
    if (!document.getElementById('admin-reports')?.classList.contains('hidden-section')) {
      renderAdminReports();
    }
  }

  if (pendingBorrowEquipId) {
    const borrowEquipId = pendingBorrowEquipId;
    pendingBorrowEquipId = null;
    try {
      if (window.history && window.history.replaceState) {
        const cleanUrl = window.location.pathname + (window.location.hash || '');
        window.history.replaceState({}, document.title, cleanUrl);
      }
    } catch (e) { /* ignore state error */ }
    openBorrowModalSingle(borrowEquipId);
  }
}

function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

// ==========================================
// Helper Functions
// ==========================================
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatThaiDate(dateInput, includeTime = false) {
  if (!dateInput) return '-';
  const str = String(dateInput).trim();
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (dmyMatch) {
    const dd = String(dmyMatch[1]).padStart(2, '0');
    const mm = String(dmyMatch[2]).padStart(2, '0');
    let year = parseInt(dmyMatch[3], 10);
    if (year < 2400) year += 543;
    if (includeTime && dmyMatch[4] !== undefined && dmyMatch[5] !== undefined) {
      const hh = String(dmyMatch[4]).padStart(2, '0');
      const min = String(dmyMatch[5]).padStart(2, '0');
      return `${dd}/${mm}/${year} ${hh}:${min} น.`;
    }
    return `${dd}/${mm}/${year}`;
  }

  let d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
      const parts = str.split('T')[0].split('-');
      const day = String(parts[2]).padStart(2, '0');
      const month = String(parts[1]).padStart(2, '0');
      let year = parseInt(parts[0], 10);
      if (year < 2400) year += 543;
      return `${day}/${month}/${year}`;
    }
    return str;
  }

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  let year = d.getFullYear();
  if (year < 2400) year += 543;

  if (includeTime) {
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes} น.`;
  }
  return `${day}/${month}/${year}`;
}

/** Normalize Thai date strings so "2/8/2569", "02/08/2569", and "13/8/2026" compare equal. */
function normalizeThaiDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return '';

  const matched = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (matched) {
    let year = parseInt(matched[3], 10);
    if (year < 2400) year += 543;
    return `${String(matched[1]).padStart(2, '0')}/${String(matched[2]).padStart(2, '0')}/${year}`;
  }

  return formatThaiDate(value);
}

function toJavaScriptString(value) {
  return JSON.stringify(String(value === null || value === undefined ? '' : value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027');
}

// Use %22 (not raw quotes) so this URL is safe inside HTML/JS attribute handlers.
const EQUIPMENT_IMAGE_FALLBACK =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22250%22 viewBox=%220 0 400 250%22%3E%3Crect width=%22400%22 height=%22250%22 fill=%22%23f1f5f9%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 font-family=%22Sarabun%2C%20sans-serif%22 font-size=%2216%22 fill=%22%2394a3b8%22%3E%E0%B9%84%E0%B8%A1%E0%B9%88%E0%B8%A1%E0%B8%B5%E0%B8%A3%E0%B8%B9%E0%B8%9B%E0%B8%A0%E0%B8%B2%E0%B8%9E%E0%B8%AD%E0%B8%B8%E0%B8%9B%E0%B8%81%E0%B8%A3%E0%B8%93%E0%B9%8C%3C/text%3E%3C/svg%3E";

function getLegacyDriveThumbnailUrl(url) {
  const match = String(url || '').match(/https:\/\/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]{25,})=w(\d+)/i);
  return match ? `https://drive.google.com/thumbnail?id=${match[1]}&sz=w${match[2]}` : '';
}

function handleEquipmentImageError(img) {
  if (!img) return;

  const fallbackUrl = getLegacyDriveThumbnailUrl(img.currentSrc || img.src);
  if (fallbackUrl && img.dataset.driveFallbackTried !== 'true') {
    img.dataset.driveFallbackTried = 'true';
    img.src = fallbackUrl;
    return;
  }

  img.onerror = null;
  img.src = EQUIPMENT_IMAGE_FALLBACK;
}

// ==========================================
// Initialization & Navigation
// ==========================================
let pendingBorrowEquipId = null;

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const view = urlParams.get('view');
  const reportType = urlParams.get('type') || 'all';

  if (view === 'report') {
    openReportView(reportType);
  } else {
    checkAdminSession();
    setInterval(checkAdminSession, ADMIN_SESSION_CHECK_MS);
    loadData();
    initSignatureCanvas();
    initFlatpickr();

    const action = urlParams.get('action');
    const equipId = urlParams.get('id');
    if (action === 'borrow' && equipId) {
      pendingBorrowEquipId = equipId;
    }
  }
});

function closeMobileMenu() {
  const nav = document.getElementById('desktop-nav');
  const btn = document.getElementById('mobile-menu-button');
  if (nav) nav.classList.remove('mobile-menu-open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleMobileMenu() {
  const nav = document.getElementById('desktop-nav');
  const btn = document.getElementById('mobile-menu-button');
  if (!nav) return;
  const open = nav.classList.toggle('mobile-menu-open');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function switchTab(tabName) {
  closeMobileMenu();
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('nav-active'));
  document.getElementById('borrow-section')?.classList.add('hidden-section');
  document.getElementById('history-section')?.classList.add('hidden-section');
  document.getElementById('user-layout')?.classList.remove('hidden-section');
  document.getElementById('admin-layout')?.classList.add('hidden-section');

  if (tabName === 'borrow') {
    document.getElementById('btn-borrow')?.classList.add('nav-active');
    document.getElementById('borrow-section')?.classList.remove('hidden-section');
  } else if (tabName === 'history') {
    document.getElementById('btn-history')?.classList.add('nav-active');
    document.getElementById('history-section')?.classList.remove('hidden-section');
  } else if (tabName === 'admin') {
    document.getElementById('btn-admin')?.classList.add('nav-active');
    if (isAdminMode) {
      document.getElementById('user-layout')?.classList.add('hidden-section');
      document.getElementById('admin-layout')?.classList.remove('hidden-section');
    } else {
      openAdminLoginModal();
    }
  }
}

// ==========================================
// Load Data & Render Public UI
// ==========================================
async function loadData() {
  const seq = ++loadDataSeq;
  if (loadDataController) {
    try { loadDataController.abort(); } catch (e) { /* ignore */ }
  }
  loadDataController = new AbortController();
  const signal = loadDataController.signal;

  const spinner = document.getElementById('loading-spinner');
  const cached = readClientGetDataCache();
  if (cached) {
    applyLoadedData(cached);
    if (spinner) spinner.style.display = 'none';
  } else if (spinner) {
    spinner.style.display = 'flex';
  }

  try {
    // GAS cold start / Sheets read can exceed 30s; keep spinner until heavy timeout.
    const res = await apiRequest('getData', {}, { signal, timeout: API_HEAVY_TIMEOUT_MS });
    if (seq !== loadDataSeq) return;

    if (res && res.status === 'success') {
      applyLoadedData(res);
      writeClientGetDataCache(res);
    } else {
      throw new Error(res.message || 'ไม่สามารถโหลดข้อมูลได้');
    }
  } catch (err) {
    if (seq !== loadDataSeq) return;
    if (err && (err.errorCode === 'REQUEST_ABORTED' || err.name === 'AbortError')) return;
    if (cached) return;
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: err.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้'
    });
  } finally {
    if (seq === loadDataSeq && spinner) spinner.style.display = 'none';
  }
}

function updateDashboardStats() {
  const total = equipmentData.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const available = equipmentData.reduce((sum, item) => sum + (Number(item.available) || 0), 0);
  const borrowed = total - available;

  const todayKey = normalizeThaiDateKey(formatThaiDate(new Date()));
  const todayCount = transactionData.filter(t => normalizeThaiDateKey(t.dateBorrow) === todayKey).length;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-available').textContent = available;
  document.getElementById('stat-borrowed').textContent = borrowed;
  document.getElementById('stat-today').textContent = todayCount;
}

function getCategoryLabel(cat) {
  const categoryLabels = {
    audiovisual: 'โสตทัศนูปกรณ์ & คอมพิวเตอร์',
    kitchen: 'ห้องครัว & ประกอบอาหาร',
    general: 'อุปกรณ์ทั่วไป'
  };
  return categoryLabels[cat] || cat || 'อุปกรณ์ทั่วไป';
}

function renderCategoryFilters() {
  const container = document.getElementById('category-filter-container');
  if (!container) return;

  const categories = [
    { id: 'all', label: 'ทั้งหมด', icon: 'fa-list' },
    { id: 'audiovisual', label: 'โสตทัศนูปกรณ์ & คอมพิวเตอร์', icon: 'fa-laptop' },
    { id: 'kitchen', label: 'ห้องครัว & ประกอบอาหาร', icon: 'fa-utensils' },
    { id: 'general', label: 'อุปกรณ์ทั่วไป', icon: 'fa-boxes-stacked' }
  ];

  container.innerHTML = categories.map(c => `
    <button onclick="setCategoryFilter('${c.id}')" class="px-4 py-2 rounded-xl text-sm font-semibold transition-all whitespace-nowrap border ${activeCategory === c.id ? 'bg-sky-600 text-white border-sky-600 shadow-md' : 'bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200'}">
      <i class="fa-solid ${c.icon} mr-2"></i>${c.label}
    </button>
  `).join('');
}

function setCategoryFilter(catId) {
  activeCategory = catId;
  renderCategoryFilters();
  filterEquipment();
}

function filterEquipment() {
  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();

  filteredEquipment = equipmentData.filter(item => {
    const matchCat = activeCategory === 'all' || item.category === activeCategory;
    const matchSearch = !searchTerm ||
      (item.name || '').toLowerCase().includes(searchTerm) ||
      (item.id || '').toLowerCase().includes(searchTerm) ||
      (item.location || '').toLowerCase().includes(searchTerm);
    return matchCat && matchSearch;
  });

  currentPage = 1;
  renderEquipmentGrid();
}

const EQUIPMENT_IMAGE_LISTING_WIDTH = 400;
const EQUIPMENT_IMAGE_FULL_WIDTH = 800;

function normalizeEquipmentImageWidth(url, width) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('data:image')) return url;
  const w = Number(width) || EQUIPMENT_IMAGE_FULL_WIDTH;
  if (/[?&]sz=w\d+/i.test(url)) {
    return url.replace(/([?&]sz=)w\d+/i, `$1w${w}`);
  }
  if (/[?&]w=\d+/i.test(url)) {
    return url.replace(/([?&]w=)\d+/i, `$1${w}`);
  }
  return url;
}

function formatImageUrl(rawUrl, width = EQUIPMENT_IMAGE_FULL_WIDTH) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const url = rawUrl.trim();
  if (!url) return '';
  if (url.startsWith('data:image')) return url;

  const w = Number(width) || EQUIPMENT_IMAGE_FULL_WIDTH;

  // Convert Google Drive view/share URLs to direct thumbnail URLs
  const driveMatch = url.match(/(?:file\/d\/|id=|\/d\/)([a-zA-Z0-9_-]{25,})/);
  if (driveMatch && driveMatch[1]) {
    return `https://lh3.googleusercontent.com/d/${driveMatch[1]}=w${w}`;
  }
  return normalizeEquipmentImageWidth(url, w);
}

function getUploadedEquipmentImageUrl(rawUrl, width = EQUIPMENT_IMAGE_FULL_WIDTH) {
  if (typeof rawUrl !== 'string' || !/^https:\/\/(?:drive\.google\.com|lh3\.googleusercontent\.com)\//i.test(rawUrl.trim())) return '';
  const formatted = formatImageUrl(rawUrl, width);
  return /^https:\/\/lh3\.googleusercontent\.com\/d\//i.test(formatted) ? formatted : '';
}

function getSampleEquipmentImage(item, width = EQUIPMENT_IMAGE_LISTING_WIDTH) {
  if (!item) return '';
  const formatted1 = formatImageUrl(item.image1, width);
  if (formatted1 && formatted1.length > 5 && !formatted1.includes('fallbackSvg')) return formatted1;

  const name = (item.name || '').toLowerCase();
  const cat = (item.category || '').toLowerCase();
  let sample = '';

  if (name.includes('ฟอกอากาศ') || name.includes('air purifier')) {
    sample = 'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('แม็ค') || name.includes('macbook') || name.includes('mac')) {
    sample = 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('ตั้งโต๊ะ') || name.includes('pc') || name.includes('ชุดคอมพิวเตอร์')) {
    sample = 'https://images.unsplash.com/photo-1587831990711-23ca6441447b?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('โน้ตบุ๊ก') || name.includes('notebook') || name.includes('laptop') || name.includes('lenovo')) {
    sample = 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('กล้อง') || name.includes('cannon') || name.includes('canon') || name.includes('camera')) {
    sample = 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('โปรเจคเตอร์') || name.includes('projector')) {
    sample = 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('เลเซอร์') || name.includes('kress') || name.includes('วัดระดับ')) {
    sample = 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('หม้อ') || name.includes('ต้ม')) {
    sample = 'https://images.unsplash.com/photo-1584992236310-6edddc08acff?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('กระทะก้นลึก')) {
    sample = 'https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('กระทะ') || name.includes('สแตนเลส')) {
    sample = 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('กระบวย')) {
    sample = 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('ตะหลิว')) {
    sample = 'https://images.unsplash.com/photo-1584269600464-37b1b58a9fe7?w=800&auto=format&fit=contain&q=80';
  } else if (name.includes('ทัพพี')) {
    sample = 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800&auto=format&fit=contain&q=80';
  } else if (cat === 'audiovisual') {
    sample = 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&auto=format&fit=contain&q=80';
  } else if (cat === 'kitchen') {
    sample = 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800&auto=format&fit=contain&q=80';
  } else {
    sample = 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=800&auto=format&fit=contain&q=80';
  }

  return normalizeEquipmentImageWidth(sample, width);
}

function renderEquipmentGrid() {
  const grid = document.getElementById('equipment-grid');
  if (!grid) return;

  if (filteredEquipment.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full text-center py-12 text-gray-500 bg-white rounded-2xl p-8 shadow">
        <i class="fa-solid fa-box-open text-4xl mb-3 text-gray-300"></i>
        <p class="text-lg font-medium">ไม่พบอุปกรณ์ที่ค้นหา</p>
      </div>`;
    updatePagination(0);
    return;
  }

  const totalPages = Math.ceil(filteredEquipment.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filteredEquipment.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  const priorityImageCount = window.matchMedia('(min-width: 1024px)').matches ? 3
    : window.matchMedia('(min-width: 768px)').matches ? 2
      : 1;

  grid.innerHTML = pageItems.map((item, index) => {
    const available = Number(item.available) || 0;
    const total = Number(item.total) || 0;
    const isAvailable = available > 0;
    const isCartAdded = cart.some(c => c.id === item.id);
    const isPriorityImage = index < priorityImageCount;

    const catLabel = getCategoryLabel(item.category);
    const listingImgUrl = getSampleEquipmentImage(item, EQUIPMENT_IMAGE_LISTING_WIDTH) || EQUIPMENT_IMAGE_FALLBACK;
    const fullImgUrl = getSampleEquipmentImage(item, EQUIPMENT_IMAGE_FULL_WIDTH) || EQUIPMENT_IMAGE_FALLBACK;
    const secondaryFullImgUrl = getUploadedEquipmentImageUrl(item.image2, EQUIPMENT_IMAGE_FULL_WIDTH);

    return `
      <div class="equipment-card">
        <div class="image-gallery">
          <button type="button" class="equipment-image-trigger" data-src="${escapeHtml(fullImgUrl)}" data-secondary-src="${escapeHtml(secondaryFullImgUrl)}" data-equip-name="${escapeHtml(item.name)}" data-equip-id="${escapeHtml(item.id)}" onclick="openEquipmentImageFromGallery(this)" aria-label="ดูภาพอุปกรณ์ขนาดเต็ม: ${escapeHtml(item.name)}" title="ดูภาพอุปกรณ์ขนาดเต็ม">
            <img src="${escapeHtml(listingImgUrl)}" alt="${escapeHtml(item.name)}" class="equipment-image" loading="${isPriorityImage ? 'eager' : 'lazy'}" fetchpriority="${isPriorityImage ? 'high' : 'auto'}" decoding="async" onerror="handleEquipmentImageError(this)">
          </button>
          <button type="button" class="qr-badge" onclick="event.stopPropagation(); showQRCode('${escapeHtml(item.id)}', '${escapeHtml(item.name)}')" title="ดู QR Code ของ ${escapeHtml(item.name)}" aria-label="ดู QR Code ของ ${escapeHtml(item.name)}">
            <i class="fa-solid fa-qrcode" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-5 equipment-card-content">
          <div class="flex items-start justify-between gap-2 mb-2">
            <span class="category-badge">${escapeHtml(catLabel)}</span>
            <span class="text-xs font-mono font-bold text-sky-800 bg-sky-50 px-2 py-1 rounded-md border border-sky-200 shrink-0">${escapeHtml(item.id)}</span>
          </div>
          <h3 class="text-lg font-bold text-gray-800 equipment-card-title mb-1">${escapeHtml(item.name)}</h3>
          <p class="text-xs text-gray-500 equipment-card-meta mb-3">
            <i class="fa-solid fa-location-dot text-rose-500 mr-1"></i>${escapeHtml(item.location || '-')}
          </p>
          <dl class="equipment-stock mb-4">
            <div>
              <dt>ทั้งหมด</dt>
              <dd>${total}</dd>
            </div>
            <div>
              <dt>คงเหลือ</dt>
              <dd class="${isAvailable ? '' : 'is-empty'}">${available}</dd>
            </div>
          </dl>
          <div class="flex gap-2 equipment-card-action">
            <button type="button" onclick="addToCart('${escapeHtml(item.id)}')" ${!isAvailable ? 'disabled' : ''} aria-pressed="${isCartAdded}" class="flex-1 btn-cart-secondary ${isCartAdded ? 'is-added' : ''} py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2">
              <i class="fa-solid ${isCartAdded ? 'fa-check' : 'fa-cart-plus'}"></i>
              ${isCartAdded ? 'ในตะกร้า' : 'ใส่ตะกร้า'}
            </button>
            <button type="button" onclick="openBorrowModalSingle('${escapeHtml(item.id)}')" ${!isAvailable ? 'disabled' : ''} class="btn-olive py-2.5 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2">
              ยืมเลย
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  updatePagination(totalPages);
}

function updatePagination(totalPages) {
  document.getElementById('current-page').textContent = currentPage;
  document.getElementById('total-pages').textContent = Math.max(1, totalPages);
  document.getElementById('btn-prev-page').disabled = currentPage <= 1;
  document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
}

function changePage(direction) {
  currentPage += direction;
  renderEquipmentGrid();
}

function openEquipmentImageFromGallery(el) {
  const url = String(el?.dataset?.src || '').trim();
  const secondaryUrl = String(el?.dataset?.secondarySrc || '').trim();
  const equipName = String(el?.dataset?.equipName || '').trim();
  const equipId = String(el?.dataset?.equipId || '').trim();
  imageZoomTrigger = el instanceof HTMLElement ? el : null;
  if (url) zoomImage(url, equipName, equipId, secondaryUrl);
}

function buildEquipmentImageLabel(equipName, equipId) {
  const name = String(equipName || '').trim();
  const id = String(equipId || '').trim();
  if (name && id) return `${name} (${id})`;
  return name || id || 'ภาพอุปกรณ์';
}

function renderImageZoomGallery() {
  const modal = document.getElementById('image-zoom-modal');
  const gallery = document.getElementById('imageZoomGallery');
  if (!gallery) return;

  if (imageZoomItems.length < 2) {
    gallery.hidden = true;
    gallery.innerHTML = '';
    return;
  }

  const equipmentLabel = buildEquipmentImageLabel(modal?.dataset?.equipName, modal?.dataset?.equipId);
  gallery.hidden = false;
  gallery.innerHTML = imageZoomItems.map((item, index) => {
    const isActive = index === imageZoomIndex;
    const buttonLabel = `${item.label}: ${equipmentLabel}`;
    return `
      <button type="button" class="imageZoomThumbnail${isActive ? ' isActive' : ''}" onclick="selectImageZoom(${index})" aria-label="${escapeHtml(buttonLabel)}" aria-pressed="${isActive}">
        <img src="${escapeHtml(item.url)}" alt="" loading="lazy" decoding="async" onerror="handleEquipmentImageError(this)">
        <span>${escapeHtml(item.label)}</span>
      </button>
    `;
  }).join('');
}

function updateImageZoomFrame() {
  const modal = document.getElementById('image-zoom-modal');
  const img = document.getElementById('zoomed-image');
  const caption = document.getElementById('imageZoomCaption');
  const currentItem = imageZoomItems[imageZoomIndex];
  if (!modal || !img || !currentItem) return;

  const equipmentLabel = buildEquipmentImageLabel(modal.dataset.equipName, modal.dataset.equipId);
  const label = `${equipmentLabel} — ${currentItem.label}`;
  img.src = currentItem.url;
  img.alt = label;
  img.onerror = () => handleEquipmentImageError(img);
  if (caption) caption.textContent = label;
  document.querySelectorAll('#imageZoomGallery .imageZoomThumbnail').forEach((button, index) => {
    const isActive = index === imageZoomIndex;
    button.classList.toggle('isActive', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function selectImageZoom(index) {
  const nextIndex = Number(index);
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= imageZoomItems.length) return;
  imageZoomIndex = nextIndex;
  updateImageZoomFrame();
}

function zoomImage(url, equipName, equipId, secondaryUrl = '') {
  const modal = document.getElementById('image-zoom-modal');
  const img = document.getElementById('zoomed-image');
  if (!modal || !img) return;

  imageZoomItems = [{ url: String(url).trim(), label: 'ภาพหลัก' }];
  if (String(secondaryUrl || '').trim()) {
    imageZoomItems.push({ url: String(secondaryUrl).trim(), label: 'อุปกรณ์ร่วม' });
  }
  imageZoomIndex = 0;
  modal.dataset.equipName = String(equipName || '').trim();
  modal.dataset.equipId = String(equipId || '').trim();
  renderImageZoomGallery();
  updateImageZoomFrame();
  modal.classList.add('show');
  modal.querySelector('.image-zoom-close')?.focus();
}

function handleImageZoomKeydown(event) {
  if (event.key === 'Escape') closeImageZoom();
}

function closeImageZoom() {
  const modal = document.getElementById('image-zoom-modal');
  const img = document.getElementById('zoomed-image');
  const caption = document.getElementById('imageZoomCaption');
  const gallery = document.getElementById('imageZoomGallery');
  modal?.classList.remove('show');
  if (modal) {
    delete modal.dataset.equipName;
    delete modal.dataset.equipId;
  }
  if (img) {
    img.src = '';
    img.alt = '';
    img.onerror = null;
  }
  if (caption) caption.textContent = '';
  if (gallery) {
    gallery.hidden = true;
    gallery.innerHTML = '';
  }
  imageZoomItems = [];
  imageZoomIndex = 0;
  const trigger = imageZoomTrigger;
  imageZoomTrigger = null;
  if (trigger?.isConnected) trigger.focus();
}

document.addEventListener('keydown', (event) => {
  const zoomModal = document.getElementById('image-zoom-modal');
  if (zoomModal?.classList.contains('show')) handleImageZoomKeydown(event);

  const logoutModal = document.getElementById('logoutConfirmModal');
  if (!logoutModal?.hasAttribute('hidden') && event.key === 'Escape') {
    closeLogoutConfirmModal();
  }
});

function normalizeQrOutput(container, size) {
  if (!container) return;
  const img = container.querySelector(':scope > img');
  const canvas = container.querySelector(':scope > canvas');
  const table = container.querySelector(':scope > table');
  const target = canvas || img || table;
  if (!target) return;

  if (canvas) {
    canvas.classList.remove('is-qr-hidden');
    canvas.style.display = 'block';
    if (img) img.classList.add('is-qr-hidden');
  }

  target.style.width = `${size}px`;
  target.style.height = `${size}px`;
  target.style.aspectRatio = '1 / 1';
  target.style.objectFit = 'contain';
  target.style.display = 'block';
  target.style.margin = '0';
  if (target.tagName === 'IMG') {
    target.setAttribute('width', String(size));
    target.setAttribute('height', String(size));
  }
}

function showQRCode(id, name) {
  const container = document.getElementById('qr-canvas-container');
  const nameEl = document.getElementById('qr-modal-name');
  const modal = document.getElementById('qr-modal');
  const qrSize = 200;

  if (container) {
    container.innerHTML = '';
    const borrowUrl = `${resolveFrontendUrl()}?action=borrow&id=${encodeURIComponent(id)}`;
    new QRCode(container, {
      text: borrowUrl,
      width: qrSize,
      height: qrSize,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: typeof QRCode !== 'undefined' && QRCode.CorrectLevel ? QRCode.CorrectLevel.H : 2
    });
    normalizeQrOutput(container, qrSize);
  }
  if (nameEl) nameEl.textContent = `${id} - ${name}`;
  if (modal) modal.classList.add('show');
}

function closeQRModal() {
  document.getElementById('qr-modal')?.classList.remove('show');
}

// ==========================================
// Cart Logic
// ==========================================
function toggleCart() {
  const modal = document.getElementById('cartModal');
  cartModalOpen = !cartModalOpen;
  if (modal) {
    if (cartModalOpen) modal.classList.add('open');
    else modal.classList.remove('open');
  }
  renderCart();
}

function addToCart(equipId) {
  const item = equipmentData.find(e => e.id === equipId);
  if (!item) return;

  const available = Number(item.available) || 0;
  if (available <= 0) {
    Swal.fire('อุปกรณ์หมด', 'อุปกรณ์นี้ไม่มีคงเหลือให้ยืมขณะนี้', 'warning');
    return;
  }

  const existing = cart.find(c => c.id === equipId);
  if (existing) {
    if (existing.qty < available) existing.qty += 1;
  } else {
    cart.push({ id: item.id, name: item.name, image: getSampleEquipmentImage(item, EQUIPMENT_IMAGE_LISTING_WIDTH), qty: 1, maxQty: available });
  }

  updateCartBadge();
  renderCart();
  renderEquipmentGrid();
  Swal.fire({ icon: 'success', title: 'เพิ่มลงตะกร้าเรียบร้อย', timer: 1000, showConfirmButton: false });
}

function updateCartBadge() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  const badge = document.getElementById('cartBadge');
  const cartButton = document.getElementById('cartButton');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
  if (cartButton) cartButton.style.display = count > 0 ? 'flex' : 'none';
}

function renderCart() {
  const empty = document.getElementById('cartEmpty');
  const itemsContainer = document.getElementById('cartItems');
  const checkoutBtn = document.getElementById('checkoutButton');

  if (cart.length === 0) {
    if (empty) empty.style.display = 'block';
    if (itemsContainer) itemsContainer.classList.add('hidden-section');
    if (checkoutBtn) checkoutBtn.disabled = true;
    return;
  }

  if (empty) empty.style.display = 'none';
  if (itemsContainer) {
    itemsContainer.classList.remove('hidden-section');
    itemsContainer.innerHTML = cart.map(item => `
      <div class="cart-item">
        <img src="${escapeHtml(item.image || 'https://via.placeholder.com/50')}" alt="${escapeHtml(item.name)}">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(item.name)}</div>
          <div class="cart-item-details">
            <div class="cart-item-qty">
              <button onclick="changeCartQty('${item.id}', -1)">-</button>
              <span>${item.qty}</span>
              <button onclick="changeCartQty('${item.id}', 1)">+</button>
            </div>
            <i class="fa-solid fa-trash cart-item-remove" onclick="removeFromCart('${item.id}')"></i>
          </div>
        </div>
      </div>
    `).join('');
  }
  if (checkoutBtn) checkoutBtn.disabled = false;
}

function changeCartQty(id, delta) {
  const item = cart.find(c => c.id === id);
  if (!item) return;

  item.qty += delta;
  if (item.qty <= 0) {
    removeFromCart(id);
    return;
  }
  if (item.qty > item.maxQty) {
    item.qty = item.maxQty;
  }
  updateCartBadge();
  renderCart();
}

function removeFromCart(id) {
  cart = cart.filter(c => c.id !== id);
  updateCartBadge();
  renderCart();
  renderEquipmentGrid();
}

function clearCart() {
  cart = [];
  updateCartBadge();
  renderCart();
  renderEquipmentGrid();
}

// ==========================================
// Borrow Form Modal & Signature Pad
// ==========================================
function initSignatureCanvas() {
  signatureCanvas = document.getElementById('signatureCanvas');
  if (!signatureCanvas) return;
  signatureCtx = signatureCanvas.getContext('2d');

  function getPos(e) {
    const rect = signatureCanvas.getBoundingClientRect();
    const point = e.touches && e.touches[0] ? e.touches[0] : e;
    const scaleX = signatureCanvas.width / (rect.width || 1);
    const scaleY = signatureCanvas.height / (rect.height || 1);
    return {
      x: (point.clientX - rect.left) * scaleX,
      y: (point.clientY - rect.top) * scaleY
    };
  }

  function startDrawing(e) {
    if (e.cancelable) e.preventDefault();
    isDrawingSignature = true;
    hasSignature = true;
    const pos = getPos(e);
    signatureCtx.beginPath();
    signatureCtx.moveTo(pos.x, pos.y);
    signatureCtx.lineWidth = 2.5;
    signatureCtx.lineCap = 'round';
    signatureCtx.strokeStyle = '#075985';
  }

  function draw(e) {
    if (!isDrawingSignature) return;
    e.preventDefault();
    const pos = getPos(e);
    signatureCtx.lineTo(pos.x, pos.y);
    signatureCtx.stroke();
  }

  function stopDrawing() {
    isDrawingSignature = false;
  }

  signatureCanvas.addEventListener('mousedown', startDrawing);
  signatureCanvas.addEventListener('mousemove', draw);
  signatureCanvas.addEventListener('mouseup', stopDrawing);
  signatureCanvas.addEventListener('mouseleave', stopDrawing);

  signatureCanvas.addEventListener('touchstart', startDrawing, { passive: false });
  signatureCanvas.addEventListener('touchmove', draw, { passive: false });
  signatureCanvas.addEventListener('touchend', stopDrawing);
}

function clearSignature() {
  if (!signatureCtx || !signatureCanvas) return;
  signatureCtx.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
  hasSignature = false;
}

function initFlatpickr() {
  const returnInput = document.querySelector('input[name="returnDate"]');
  if (!returnInput || typeof flatpickr === 'undefined') return;
  if (returnInput._flatpickr) return;

  const updateCalendarThaiYear = (instance) => {
    if (!instance || !instance.currentYearElement) return;
    const beYear = instance.currentYear + 543;
    instance.currentYearElement.value = beYear;
  };

  flatpickr(returnInput, {
    locale: (typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.th) ? 'th' : 'default',
    dateFormat: 'Y-m-d',
    altInput: true,
    altInputClass: 'form-input',
    altFormat: 'd/m/Y',
    minDate: 'today',
    formatDate: function(date, format, locale) {
      if (format === 'd/m/Y') {
        const d = String(date.getDate()).padStart(2, '0');
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const y = date.getFullYear() + 543;
        return `${d}/${m}/${y}`;
      }
      return flatpickr.formatDate(date, format);
    },
    parseDate: function(dateStr, format) {
      if (typeof dateStr === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr.trim())) {
        const parts = dateStr.trim().split('/');
        let y = parseInt(parts[2], 10);
        if (y > 2400) y -= 543;
        return new Date(y, parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
      }
      return flatpickr.parseDate(dateStr, format);
    },
    onReady: function(selectedDates, dateStr, instance) {
      updateCalendarThaiYear(instance);
      if (instance.currentYearElement) {
        instance.currentYearElement.addEventListener('input', function(e) {
          const inputVal = parseInt(e.target.value, 10);
          if (!isNaN(inputVal) && inputVal > 2400) {
            instance.currentYear = inputVal - 543;
            instance.redraw();
            updateCalendarThaiYear(instance);
          }
        });
      }
    },
    onOpen: function(selectedDates, dateStr, instance) {
      updateCalendarThaiYear(instance);
    },
    onMonthChange: function(selectedDates, dateStr, instance) {
      setTimeout(() => updateCalendarThaiYear(instance), 0);
    },
    onYearChange: function(selectedDates, dateStr, instance) {
      setTimeout(() => updateCalendarThaiYear(instance), 0);
    }
  });
}

function openBorrowModalSingle(equipId) {
  const item = equipmentData.find(e => e.id === equipId);
  if (!item) {
    if (typeof Swal !== 'undefined') {
      Swal.fire('ไม่พบข้อมูลอุปกรณ์', `ไม่พบอุปกรณ์รหัส "${escapeHtml(equipId)}" ในระบบ`, 'warning');
    }
    return;
  }

  const available = Number(item.available) || 0;
  if (available <= 0) {
    if (typeof Swal !== 'undefined') {
      Swal.fire('อุปกรณ์หมด', `"${escapeHtml(item.name)}" ไม่มีคงเหลือให้ยืมในขณะนี้`, 'warning');
    }
    return;
  }

  cart = [{ id: item.id, name: item.name, image: getSampleEquipmentImage(item, EQUIPMENT_IMAGE_LISTING_WIDTH), qty: 1, maxQty: available }];
  updateCartBadge();
  openBorrowModalFromCart();
}

function openBorrowModalFromCart() {
  if (cart.length === 0) {
    Swal.fire('ตะกร้าว่างเปล่า', 'กรุณาเลือกอุปกรณ์ที่ต้องการยืมก่อน', 'warning');
    return;
  }
  const modal = document.getElementById('borrowModal');
  const container = document.getElementById('selectedItemsContainer');

  const cartIds = cart.map(c => c.id);
  const matchedEquipment = equipmentData.filter(e => cartIds.includes(e.id));
  const equipmentById = Object.fromEntries(matchedEquipment.map(e => [e.id, e]));
  const storageLocations = [...new Set(matchedEquipment.map(e => String(e.location || '').trim()).filter(Boolean))];
  const showStorageLocation = storageLocations.length > 1;

  if (container) {
    container.innerHTML = cart.map(c => {
      const storageLocation = equipmentById[c.id]?.location;
      const storageLine = showStorageLocation && storageLocation
        ? `<div class="text-xs text-gray-500 mt-0.5"><i class="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>เก็บที่: ${escapeHtml(storageLocation)}</div>`
        : '';
      return `
      <div class="flex justify-between items-start border-b py-2 text-sm">
        <div class="min-w-0 flex-1 pr-3">
          <span class="font-semibold text-gray-800">${escapeHtml(c.name)}</span>
          ${storageLine}
        </div>
        <span class="bg-sky-100 text-sky-800 px-3 py-1 rounded-full font-bold shrink-0">${c.qty} ชิ้น</span>
      </div>
    `;
    }).join('');
  }

  prefillBorrowRoomFromCart();
  if (modal) modal.classList.remove('hidden');
  initFlatpickr();
  requestAnimationFrame(() => {
    resizeSignatureCanvasForDisplay();
    clearSignature();
  });
}

function resizeSignatureCanvasForDisplay() {
  if (!signatureCanvas || !signatureCtx) return;
  const rect = signatureCanvas.getBoundingClientRect();
  const displayWidth = Math.max(1, Math.round(rect.width) || 400);
  if (signatureCanvas.width !== displayWidth || signatureCanvas.height !== 160) {
    signatureCanvas.width = displayWidth;
    signatureCanvas.height = 160;
  }
}

function closeModal() {
  document.getElementById('borrowModal')?.classList.add('hidden');
}

function toggleBorrowRoomOther(selectEl) {
  const container = document.getElementById('borrowRoomOtherContainer');
  if (container) {
    if (selectEl.value === '__OTHER__') container.classList.remove('hidden');
    else container.classList.add('hidden');
  }
}

/** Prefill borrowRoom from equipment.location only when all cart items share one location. */
function prefillBorrowRoomFromCart() {
  const borrowRoomSelect = document.querySelector('#borrowModal select[name="borrowRoom"]');
  const hintEl = document.getElementById('borrowRoomHint');
  const otherInput = document.getElementById('borrowRoomOther');
  if (!borrowRoomSelect || cart.length === 0) return;

  const cartIds = cart.map(c => c.id);
  const matched = equipmentData.filter(e => cartIds.includes(e.id));
  const locations = [...new Set(matched.map(e => String(e.location || '').trim()).filter(Boolean))];

  const setHint = (show) => {
    if (!hintEl) return;
    if (show) hintEl.classList.remove('hidden');
    else hintEl.classList.add('hidden');
  };

  if (locations.length !== 1) {
    borrowRoomSelect.value = '';
    if (otherInput) otherInput.value = '';
    toggleBorrowRoomOther(borrowRoomSelect);
    setHint(locations.length > 1);
    return;
  }

  const defaultRoom = locations[0];
  const optionValues = Array.from(borrowRoomSelect.options).map(o => o.value);

  if (optionValues.includes(defaultRoom)) {
    borrowRoomSelect.value = defaultRoom;
    if (otherInput) otherInput.value = '';
  } else {
    borrowRoomSelect.value = '__OTHER__';
    if (otherInput) otherInput.value = defaultRoom;
  }
  toggleBorrowRoomOther(borrowRoomSelect);
  setHint(false);
}

async function handleBorrowSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = document.getElementById('borrowSubmitButton');

  if (submitBtn && submitBtn.disabled) {
    return;
  }

  if (!hasSignature) {
    Swal.fire('กรุณาลงลายเซ็น', 'โปรดลงลายเซ็นก่อนยืนยันการยืมอุปกรณ์', 'warning');
    return;
  }

  const signatureData = signatureCanvas.toDataURL('image/png');
  let roomVal = form.borrowRoom.value;
  if (roomVal === '__OTHER__') {
    roomVal = (form.borrowRoomOther.value || '').trim();
    if (!roomVal) {
      Swal.fire('กรุณาระบุห้อง', 'กรุณากรอกชื่อห้องที่ใช้ยืม', 'warning');
      return;
    }
  }

  if (!borrowSubmitRequestId) {
    borrowSubmitRequestId = generateRequestId();
  }

  const payload = {
    requestId: borrowSubmitRequestId,
    borrowerName: form.borrowerName.value,
    email: form.email.value,
    phone: String(form.phone.value || '').trim(),
    returnDate: form.returnDate.value,
    borrowRoom: roomVal,
    reason: form.reason.value,
    signatureData: signatureData,
    equipId: cart.map(c => c.id),
    equipName: cart.map(c => c.name),
    qty: cart.map(c => c.qty)
  };

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>กำลังบันทึก...';
    }

    const res = await apiRequest('saveBorrowRequest', payload);
    if (res === 'Success' || res.status === 'success') {
      borrowSubmitRequestId = null;
      closeModal();
      clearCart();
      let successText = 'ระบบได้ส่งคำขอยืมของท่านเรียบร้อยแล้ว รอการอนุมัติจากผู้ดูแล';
      if (res && Array.isArray(res.notificationWarnings) && res.notificationWarnings.length > 0) {
        successText += ' (แจ้งเตือนบางช่องทางอาจล่าช้า)';
      }
      Swal.fire({
        icon: 'success',
        title: 'ยื่นคำขอยืมสำเร็จ',
        text: successText
      });
      loadData();
    } else {
      throw new Error(res.message || 'บันทึกการยืมไม่สำเร็จ');
    }
  } catch (err) {
    Swal.fire('เกิดข้อผิดพลาด', err.message || 'ไม่สามารถยื่นคำขอยืมได้', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-check mr-2"></i>ยืนยันการยืม';
    }
  }
}

// ==========================================
// History Search Logic
// ==========================================
function searchHistory() {
  const emailInput = (document.getElementById('studentSearchEmail')?.value || '').trim().toLowerCase();
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;

  if (!emailInput) {
    Swal.fire('กรุณากรอกอีเมล์', 'โปรดป้อนอีเมล์ที่ใช้ยืมเพื่อค้นหา', 'warning');
    return;
  }

  const matched = transactionData.filter(t => (t.email || '').toLowerCase() === emailInput);
  if (matched.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-8 text-gray-500">
          <i class="fa-solid fa-circle-exclamation mb-2 text-2xl text-amber-500"></i>
          <p>ไม่พบประวัติการยืมสำหรับอีเมล์นี้</p>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = matched.map(item => {
    const statusClass = item.status === 'กำลังยืม' ? 'status-borrowed' : item.status === 'คืนแล้ว' ? 'status-returned' : 'status-pending';
    const sigCell = item.signatureUrl
      ? `<button type="button" class="signature-button" data-trans-id="${escapeHtml(item.transId)}" data-borrower="${escapeHtml(item.borrowerName)}" data-date="${escapeHtml(item.dateBorrow)}" data-sig-url="${escapeHtml(item.signatureUrl)}" onclick="showSignatureModalFromData(this)" aria-label="ดูภาพลายเซ็น"><img class="signature" src="${escapeHtml(item.signatureUrl)}" alt="ลายเซ็น"></button>`
      : '-';

    return `
      <tr>
        <td class="px-6 py-4">${escapeHtml(item.dateBorrow)}</td>
        <td class="px-6 py-4 font-semibold">${escapeHtml(item.equipName)}</td>
        <td class="px-6 py-4 text-center font-bold">${item.qty}</td>
        <td class="px-6 py-4">${escapeHtml(item.dateReturn)}</td>
        <td class="px-6 py-4 text-center">${sigCell}</td>
        <td class="px-6 py-4"><span class="status-badge ${statusClass}">${escapeHtml(item.status)}</span></td>
      </tr>
    `;
  }).join('');
}

function showSignatureModalFromData(btn) {
  if (!btn) return;
  const transId = btn.getAttribute('data-trans-id') || '';
  const borrower = btn.getAttribute('data-borrower') || '';
  const date = btn.getAttribute('data-date') || '';
  const sigUrl = btn.getAttribute('data-sig-url') || '';
  showSignatureDetail(transId, borrower, date, sigUrl);
}

function showSignatureDetail(transId, borrower, date, sigUrl) {
  const modal = document.getElementById('signatureModal');
  const transEl = document.getElementById('sigModalTransId');
  const borrowerEl = document.getElementById('sigModalBorrower');
  const dateEl = document.getElementById('sigModalDate');
  const imgEl = document.getElementById('sigModalImg');
  const safeUrl = String(sigUrl || '').trim();

  if (!modal) return;
  if (transEl) transEl.textContent = transId || '-';
  if (borrowerEl) borrowerEl.textContent = borrower || '-';
  if (dateEl) dateEl.textContent = date || '-';
  if (imgEl) {
    imgEl.onerror = () => {
      imgEl.onerror = null;
      imgEl.removeAttribute('src');
      imgEl.alt = 'ไม่สามารถโหลดรูปภาพลายเซ็นได้';
    };
    if (safeUrl) {
      imgEl.src = safeUrl;
      imgEl.alt = borrower ? `ลายเซ็นของ ${borrower}` : 'ลายเซ็น';
    } else {
      imgEl.removeAttribute('src');
      imgEl.alt = 'ไม่มีข้อมูลลายเซ็น';
    }
  }
  modal.hidden = false;
}

function closeSignatureModal() {
  const modal = document.getElementById('signatureModal');
  const imgEl = document.getElementById('sigModalImg');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (imgEl) imgEl.removeAttribute('src');
}

// ==========================================
// Admin Login & Panel Management
// ==========================================
function persistAdminSession(user, sessionToken, expiresAt) {
  try {
    localStorage.setItem(ADMIN_SESSION_EXPIRY_KEY, String(expiresAt));
    if (user) localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(user));
    localStorage.setItem(ADMIN_SESSION_TOKEN_KEY, sessionToken);
  } catch (e) { /* ignore quota/private mode */ }
}

function clearAdminSessionStorage() {
  try {
    localStorage.removeItem(ADMIN_SESSION_EXPIRY_KEY);
    localStorage.removeItem(ADMIN_USER_KEY);
    localStorage.removeItem(ADMIN_SESSION_TOKEN_KEY);
  } catch (e) { /* ignore */ }
}

function handleAdminAuthorizationError() {
  const wasAdmin = isAdminMode;
  const adminLayout = document.getElementById('admin-layout');
  const adminVisible = adminLayout && !adminLayout.classList.contains('hidden-section');
  clearAdminSessionStorage();
  isAdminMode = false;
  currentUser = null;

  if (wasAdmin || adminVisible) {
    document.getElementById('admin-sidebar-overlay')?.classList.add('hidden');
    document.getElementById('admin-sidebar')?.classList.remove('show-mobile');
    switchTab('borrow');
  }
}

function applyAdminSessionUser(user) {
  currentUser = user || null;
  isAdminMode = true;
  const nameEl = document.getElementById('admin-user-name');
  const roleEl = document.getElementById('admin-user-role');
  if (nameEl) nameEl.textContent = (user && user.name) || '';
  if (roleEl) roleEl.textContent = (user && user.role) || '';
}

function checkAdminSession() {
  let sessionExpiry = null;
  let storedUser = null;
  try {
    sessionExpiry = localStorage.getItem(ADMIN_SESSION_EXPIRY_KEY);
    storedUser = localStorage.getItem(ADMIN_USER_KEY);
    const sessionToken = localStorage.getItem(ADMIN_SESSION_TOKEN_KEY);
    if (!sessionExpiry || !sessionToken) {
      clearAdminSessionStorage();
      return;
    }
  } catch (e) {
    return;
  }

  const expiryTime = parseInt(sessionExpiry, 10);
  if (!Number.isFinite(expiryTime)) {
    clearAdminSessionStorage();
    return;
  }

  if (Date.now() < expiryTime) {
    if (!isAdminMode || !currentUser) {
      let user = null;
      if (storedUser) {
        try { user = JSON.parse(storedUser); } catch (e) { user = null; }
      }
      applyAdminSessionUser(user);
    }
    return;
  }

  const wasAdmin = isAdminMode;
  const adminLayout = document.getElementById('admin-layout');
  const adminVisible = adminLayout && !adminLayout.classList.contains('hidden-section');
  handleAdminAuthorizationError();

  if (wasAdmin || adminVisible) {
    Swal.fire({
      icon: 'warning',
      title: 'หมดเวลาการใช้งาน',
      text: 'เซสชันการใช้งานผู้ดูแลระบบหมดอายุแล้ว (6 ชั่วโมง) กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
      confirmButtonText: 'ตกลง',
      confirmButtonColor: '#0284c7'
    });
  }
}

function buildPasswordFieldHtml(inputId, toggleId, label, placeholder, autocomplete = 'current-password') {
  return `
    <div class="password-field">
      <label class="block text-sm font-semibold text-gray-700 mb-1">${label}</label>
      <div class="password-field-wrap">
        <input type="password" id="${inputId}" class="swal2-input password-field-input" style="width:100%;margin:0;" placeholder="${placeholder}" autocomplete="${autocomplete}">
        <button type="button" id="${toggleId}" class="password-toggle-btn" aria-label="แสดงรหัสผ่าน" aria-pressed="false">
          <i class="fa-solid fa-eye" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;
}

function bindPasswordToggle(inputId, toggleId) {
  const input = document.getElementById(inputId);
  const toggleBtn = document.getElementById(toggleId);
  if (!input || !toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggleBtn.setAttribute('aria-pressed', showing ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', showing ? 'แสดงรหัสผ่าน' : 'ซ่อนรหัสผ่าน');
    toggleBtn.innerHTML = showing
      ? '<i class="fa-solid fa-eye" aria-hidden="true"></i>'
      : '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>';
  });
}

function openAdminLoginModal() {
  Swal.fire({
    title: '<i class="fas fa-lock text-sky-700 mr-2"></i>เข้าสู่ระบบผู้ดูแลระบบ',
    html: `
      <div class="text-left space-y-4 pt-2">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">ไอดีผู้ใช้ (UserID)</label>
          <input type="text" id="swal-admin-id" class="swal2-input" style="width: 100%; margin: 0;" placeholder="กรอก UserID" autocomplete="username">
        </div>
        ${buildPasswordFieldHtml('swal-admin-pin', 'swal-admin-pin-toggle', 'รหัสผ่าน (PIN)', 'กรอกรหัสผ่าน')}
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'เข้าสู่ระบบ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#0284c7',
    didOpen: () => {
      bindPasswordToggle('swal-admin-pin', 'swal-admin-pin-toggle');
      document.getElementById('swal-admin-id')?.focus();
    },
    preConfirm: () => {
      const inputId = document.getElementById('swal-admin-id').value;
      const inputPin = document.getElementById('swal-admin-pin').value;
      if (!inputId || !inputPin) {
        Swal.showValidationMessage('กรุณากรอกไอดีผู้ใช้และรหัสผ่านให้ครบถ้วน');
        return false;
      }
      return { inputId, inputPin };
    }
  }).then(async (result) => {
    if (!result.isConfirmed || !result.value) {
      switchTab('borrow');
      return;
    }
    try {
      Swal.showLoading();
      const res = await apiRequest('verifyAdminPin', result.value);
      if (res && res.success && res.user && res.sessionToken && res.expiresAt) {
        applyAdminSessionUser(res.user);
        persistAdminSession(res.user, res.sessionToken, res.expiresAt);

        document.getElementById('user-layout')?.classList.add('hidden-section');
        document.getElementById('admin-layout')?.classList.remove('hidden-section');

        renderAdminDashboard();
        Swal.fire({ icon: 'success', title: 'เข้าสู่ระบบสำเร็จ', timer: 1200, showConfirmButton: false });
      } else {
        throw new Error(res.message || 'ไอดีหรือรหัสผ่านไม่ถูกต้อง');
      }
    } catch (err) {
      Swal.fire('เข้าสู่ระบบไม่สำเร็จ', err.message || 'ไอดีหรือรหัสผ่านไม่ถูกต้อง', 'error');
    }
  });
}

function openLogoutConfirmModal() {
  const modal = document.getElementById('logoutConfirmModal');
  const nameEl = document.getElementById('logoutConfirmUserName');
  const displayName = currentUser?.name
    || document.getElementById('admin-user-name')?.textContent?.trim()
    || 'ผู้ดูแลระบบ';
  if (nameEl) nameEl.textContent = displayName;
  if (!modal) return;
  modal.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
  modal.querySelector('.logout-confirm-btn-cancel')?.focus();
}

function closeLogoutConfirmModal() {
  const modal = document.getElementById('logoutConfirmModal');
  if (modal) modal.setAttribute('hidden', '');
  document.body.style.overflow = '';
}

async function confirmLogoutAdmin() {
  closeLogoutConfirmModal();
  try {
    await apiRequest('logoutAdmin');
    clearAdminSessionStorage();
    isAdminMode = false;
    currentUser = null;
    switchTab('borrow');
    Swal.fire({ icon: 'success', title: 'ออกจากระบบแล้ว', timer: 1200, showConfirmButton: false });
  } catch (err) {
    if (!ADMIN_AUTH_ERROR_CODES.has(err.errorCode)) {
      Swal.fire('ออกจากระบบไม่สำเร็จ', err.message || 'ไม่สามารถยกเลิกเซสชันบนเซิร์ฟเวอร์ได้', 'error');
    }
  }
}

function logoutAdmin() {
  openLogoutConfirmModal();
}

function toggleAdminSidebar() {
  const sidebar = document.getElementById('admin-sidebar');
  const overlay = document.getElementById('admin-sidebar-overlay');
  if (sidebar) sidebar.classList.toggle('show-mobile');
  if (overlay) overlay.classList.toggle('hidden');
}

function showAdminSection(sectionName, element) {
  document.querySelectorAll('.admin-section').forEach(sec => sec.classList.add('hidden-section'));
  document.querySelectorAll('.sidebar-menu .menu-item').forEach(mi => mi.classList.remove('active'));

  const target = document.getElementById(`admin-${sectionName}`);
  if (target) target.classList.remove('hidden-section');
  if (element) element.classList.add('active');

  if (sectionName === 'dashboard') renderAdminDashboard();
  else if (sectionName === 'equipment') renderAdminEquipmentTable();
  else if (sectionName === 'transactions') renderAdminTransactionsTable();
  else if (sectionName === 'reports') renderAdminReports();
  else if (sectionName === 'users') loadAdminUsersData();

  toggleAdminSidebar();
}

// ==========================================
// Admin Views Rendering
// ==========================================
function renderAdminDashboard() {
  const total = equipmentData.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const available = equipmentData.reduce((sum, item) => sum + (Number(item.available) || 0), 0);
  const borrowed = total - available;
  const todayKey = normalizeThaiDateKey(formatThaiDate(new Date()));
  const todayCount = transactionData.filter(t => normalizeThaiDateKey(t.dateBorrow) === todayKey).length;

  document.getElementById('admin-stat-total').textContent = total;
  document.getElementById('admin-stat-available').textContent = available;
  document.getElementById('admin-stat-borrowed').textContent = borrowed;
  document.getElementById('admin-stat-today').textContent = todayCount;

  const recent = transactionData.slice(0, 5);
  const container = document.getElementById('admin-recent-transactions');
  if (!container) return;

  if (recent.length === 0) {
    container.innerHTML = '<p class="text-gray-500 py-4 text-center">ไม่มีรายการยืม-คืนล่าสุด</p>';
    return;
  }

  container.innerHTML = `
    <div class="admin-table-scroll overflow-x-auto">
      <table class="w-full text-sm text-left">
        <thead class="bg-gray-100 text-gray-700">
          <tr>
            <th class="p-3 whitespace-nowrap">รหัส</th>
            <th class="p-3 whitespace-nowrap">ผู้ยืม</th>
            <th class="p-3 whitespace-nowrap">อุปกรณ์</th>
            <th class="p-3 whitespace-nowrap">สถานะ</th>
          </tr>
        </thead>
        <tbody>
          ${recent.map(t => `
            <tr class="border-b">
              <td class="p-3 font-mono font-semibold whitespace-nowrap">${escapeHtml(t.transId)}</td>
              <td class="p-3">${escapeHtml(t.borrowerName)}</td>
              <td class="p-3">${escapeHtml(t.equipName)}</td>
              <td class="p-3 whitespace-nowrap"><span class="status-badge ${t.status === 'กำลังยืม' ? 'status-borrowed' : t.status === 'คืนแล้ว' ? 'status-returned' : 'status-pending'}">${escapeHtml(t.status)}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderAdminEquipmentTable() {
  const tbody = document.getElementById('admin-equipment-tbody');
  const search = (document.getElementById('admin-equipment-search')?.value || '').toLowerCase().trim();

  if (!tbody) return;

  const filtered = equipmentData.filter(e =>
    !search || (e.name || '').toLowerCase().includes(search) || (e.id || '').toLowerCase().includes(search)
  );

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  const startIndex = (adminEquipCurrentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  tbody.innerHTML = pageItems.map(item => `
    <tr class="table-row">
      <td class="px-6 py-4 font-mono font-bold text-sky-800">${escapeHtml(item.id)}</td>
      <td class="px-6 py-4 font-semibold text-gray-800">${escapeHtml(item.name)}</td>
      <td class="px-6 py-4"><span class="category-badge">${escapeHtml(getCategoryLabel(item.category))}</span></td>
      <td class="px-6 py-4">${escapeHtml(item.location || '-')}</td>
      <td class="px-6 py-4 text-center font-bold">${item.total}</td>
      <td class="px-6 py-4 text-center font-bold ${Number(item.available) > 0 ? 'text-green-600' : 'text-red-600'}">${item.available}</td>
      <td class="px-6 py-4 text-center">
        <div class="table-action-btns">
          <button onclick="openEquipModal('edit', '${escapeHtml(item.id)}')" class="btn-action-edit">
            <i class="fa-solid fa-pen-to-square"></i> แก้ไข
          </button>
          <button onclick="deleteEquipmentConfirm('${escapeHtml(item.id)}')" class="btn-action-delete">
            <i class="fa-solid fa-trash-can"></i> ลบ
          </button>
        </div>
      </td>
    </tr>
  `).join('');

  document.getElementById('admin-equip-current-page').textContent = adminEquipCurrentPage;
  document.getElementById('admin-equip-total-pages').textContent = Math.max(1, totalPages);
  document.getElementById('btn-admin-equip-prev').disabled = adminEquipCurrentPage <= 1;
  document.getElementById('btn-admin-equip-next').disabled = adminEquipCurrentPage >= totalPages;
}

function changeAdminEquipPage(dir) {
  adminEquipCurrentPage += dir;
  renderAdminEquipmentTable();
}

function groupTransactionsByTicket(transactions) {
  const groupsMap = new Map();
  transactions.forEach(t => {
    const key = t.transId || ('single_' + Math.random());
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        transId: t.transId || '-',
        borrowerName: t.borrowerName || '-',
        email: t.email || '',
        phone: t.phone || '',
        borrowRoom: t.borrowRoom || '',
        dateBorrow: t.dateBorrow || '-',
        dateReturn: t.dateReturn || '-',
        signatureUrl: t.signatureUrl || '',
        reason: t.reason || '',
        items: []
      });
    }
    groupsMap.get(key).items.push(t);
  });
  return Array.from(groupsMap.values());
}

function getGroupStatusInfo(items) {
  const hasPending = items.some(it => it.status === 'รออนุมัติ');
  const hasBorrowing = items.some(it => it.status === 'กำลังยืม');
  const hasReturned = items.some(it => it.status === 'คืนแล้ว');
  const hasRejected = items.some(it => it.status === 'ไม่อนุมัติ');

  if (hasPending) {
    return { label: 'รออนุมัติ', badgeClass: 'status-pending', state: 'pending' };
  }
  if (hasBorrowing && hasReturned) {
    return { label: 'กำลังยืม (คืนบางส่วน)', badgeClass: 'status-borrowed', state: 'borrowing_partial' };
  }
  if (hasBorrowing) {
    return { label: 'กำลังยืม', badgeClass: 'status-borrowed', state: 'borrowing' };
  }
  if (hasReturned && !hasRejected) {
    return { label: 'คืนแล้ว', badgeClass: 'status-returned', state: 'returned' };
  }
  if (hasRejected && !hasReturned) {
    return { label: 'ไม่อนุมัติ', badgeClass: 'status-rejected', state: 'rejected' };
  }
  return { label: 'เสร็จสิ้น', badgeClass: 'status-returned', state: 'done' };
}

function toggleTransDetails(transId) {
  const detailRow = document.getElementById(`trans-details-${transId}`);
  const textIcon = document.getElementById(`toggle-text-icon-${transId}`);
  if (!detailRow) return;
  const isHidden = detailRow.classList.contains('hidden');
  if (isHidden) {
    detailRow.classList.remove('hidden');
    if (textIcon) {
      textIcon.classList.remove('fa-chevron-down');
      textIcon.classList.add('fa-chevron-up');
    }
  } else {
    detailRow.classList.add('hidden');
    if (textIcon) {
      textIcon.classList.remove('fa-chevron-up');
      textIcon.classList.add('fa-chevron-down');
    }
  }
}

function renderAdminTransactionsTable() {
  const tbody = document.getElementById('admin-trans-tbody');
  const search = (document.getElementById('admin-trans-search')?.value || '').toLowerCase().trim();
  const showAll = document.getElementById('admin-show-all')?.checked;

  if (!tbody) return;

  const allGroups = groupTransactionsByTicket(transactionData);
  const filtered = allGroups.filter(g => {
    const matchSearch = !search ||
      (g.borrowerName || '').toLowerCase().includes(search) ||
      (g.email || '').toLowerCase().includes(search) ||
      (g.transId || '').toLowerCase().includes(search) ||
      (g.borrowRoom || '').toLowerCase().includes(search) ||
      g.items.some(it => (it.equipName || '').toLowerCase().includes(search) || (it.equipId || '').toLowerCase().includes(search));

    const statusInfo = getGroupStatusInfo(g.items);
    const matchStatus = showAll || statusInfo.state === 'pending' || statusInfo.state === 'borrowing' || statusInfo.state === 'borrowing_partial';
    return matchSearch && matchStatus;
  });

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  const startIndex = (adminTransCurrentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  if (pageItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-8 text-gray-500">
          <i class="fas fa-inbox text-3xl mb-2 text-gray-300"></i>
          <p>ไม่พบรายการยืม-คืนอุปกรณ์</p>
        </td>
      </tr>
    `;
    document.getElementById('admin-trans-current-page').textContent = 1;
    document.getElementById('admin-trans-total-pages').textContent = 1;
    document.getElementById('btn-admin-trans-prev').disabled = true;
    document.getElementById('btn-admin-trans-next').disabled = true;
    return;
  }

  tbody.innerHTML = pageItems.map(g => {
    const statusInfo = getGroupStatusInfo(g.items);
    const totalQty = g.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
    const sigCell = g.signatureUrl
      ? `<button type="button" class="signature-button" data-trans-id="${escapeHtml(g.transId)}" data-borrower="${escapeHtml(g.borrowerName)}" data-date="${escapeHtml(g.dateBorrow)}" data-sig-url="${escapeHtml(g.signatureUrl)}" onclick="showSignatureModalFromData(this)" aria-label="ดูภาพลายเซ็น"><img class="signature" src="${escapeHtml(g.signatureUrl)}" alt="ลายเซ็น"></button>`
      : '-';

    let equipDisplay = '';
    if (g.items.length === 1) {
      equipDisplay = `<div class="font-semibold text-gray-800">${escapeHtml(g.items[0].equipName)}</div>`;
    } else {
      const firstFew = g.items.slice(0, 2).map(it => escapeHtml(it.equipName)).join(', ');
      const moreCount = g.items.length - 2;
      equipDisplay = `
        <div>
          <div class="font-semibold text-gray-800">${firstFew}${moreCount > 0 ? ` และอีก ${moreCount} รายการ` : ''}</div>
          <button type="button" onclick="toggleTransDetails('${escapeHtml(g.transId)}')" class="text-xs text-blue-600 hover:text-blue-800 font-semibold mt-1 inline-flex items-center gap-1">
            <span>รวม ${g.items.length} รายการ</span> <i class="fas fa-chevron-down text-[10px]" id="toggle-text-icon-${escapeHtml(g.transId)}"></i>
          </button>
        </div>
      `;
    }

    let actionBtns = '';
    if (statusInfo.state === 'pending') {
      actionBtns = `
        <div class="table-action-btns">
          <button onclick="approveBorrowConfirm('${escapeHtml(g.transId)}')" class="btn-approve" title="อนุมัติทั้งคำขอ"><i class="fas fa-check"></i> อนุมัติ</button>
          <button onclick="rejectBorrowConfirm('${escapeHtml(g.transId)}')" class="btn-reject" title="ปฏิเสธทั้งคำขอ"><i class="fas fa-times"></i> ปฏิเสธ</button>
        </div>`;
    } else if (statusInfo.state === 'borrowing' || statusInfo.state === 'borrowing_partial') {
      actionBtns = `
        <div class="table-action-btns">
          <button onclick="returnAllEquipmentConfirm('${escapeHtml(g.transId)}')" class="btn-approve" title="คืนอุปกรณ์ทั้งหมดในคำขอนี้"><i class="fas fa-undo"></i> คืนทั้งหมด</button>
          <button type="button" onclick="toggleTransDetails('${escapeHtml(g.transId)}')" class="btn-details" title="ดู/คืนแยกชิ้น"><i class="fas fa-list"></i> รายการ (${g.items.length})</button>
        </div>`;
    } else {
      actionBtns = `
        <div class="table-action-btns">
          <span class="text-xs text-gray-400">เสร็จสิ้น</span>
          <button type="button" onclick="toggleTransDetails('${escapeHtml(g.transId)}')" class="btn-details" title="ดูรายละเอียด"><i class="fas fa-eye"></i> ดู (${g.items.length})</button>
        </div>`;
    }

    return `
      <tr class="table-row">
        <td class="px-6 py-4">
          <div class="flex items-center gap-1.5 mb-1">
            <span class="font-mono text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-semibold border border-slate-200">${escapeHtml(g.transId)}</span>
          </div>
          <p class="font-bold text-gray-800">${escapeHtml(g.borrowerName)}</p>
          <p class="text-xs text-gray-500">${escapeHtml(g.email)}</p>
        </td>
        <td class="px-6 py-4">${equipDisplay}</td>
        <td class="px-6 py-4 text-center font-bold text-gray-800">${totalQty}</td>
        <td class="px-6 py-4 text-gray-700">${escapeHtml(g.dateBorrow)}</td>
        <td class="px-6 py-4 text-gray-700">${escapeHtml(g.dateReturn)}</td>
        <td class="px-6 py-4 text-center">${sigCell}</td>
        <td class="px-6 py-4"><span class="status-badge ${statusInfo.badgeClass}">${escapeHtml(statusInfo.label)}</span></td>
        <td class="px-6 py-4 text-center">${actionBtns}</td>
      </tr>
      <tr id="trans-details-${escapeHtml(g.transId)}" class="hidden bg-slate-50 border-y border-slate-200">
        <td colspan="8" class="px-6 py-4">
          <div class="bg-white rounded-xl p-4 border border-slate-200 shadow-sm space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-2.5 text-xs text-gray-600">
              <div><strong class="text-gray-700">ห้องที่ใช้:</strong> ${escapeHtml(g.borrowRoom || '-')}</div>
              <div><strong class="text-gray-700">เบอร์โทรศัพท์:</strong> ${escapeHtml(g.phone || '-')}</div>
              <div><strong class="text-gray-700">เหตุผลการยืม:</strong> ${escapeHtml(g.reason || '-')}</div>
            </div>
            <div class="space-y-2">
              <div class="text-xs font-bold text-gray-700 uppercase tracking-wider">
                รายการอุปกรณ์ในคำขอนี้ (${g.items.length} รายการ):
              </div>
              <div class="grid grid-cols-1 gap-2">
                ${g.items.map((item, idx) => `
                  <div class="flex flex-wrap items-center justify-between gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div class="flex items-center gap-3">
                      <span class="w-6 h-6 rounded-full bg-slate-200 text-slate-700 text-xs flex items-center justify-center font-bold">${idx + 1}</span>
                      <div>
                        <div class="font-semibold text-gray-800 text-sm">${escapeHtml(item.equipName)}</div>
                        <div class="text-xs text-gray-500">รหัสอุปกรณ์: <span class="font-mono">${escapeHtml(item.equipId)}</span> | จำนวน: <strong>${item.qty}</strong> ชิ้น</div>
                      </div>
                    </div>
                    <div class="flex items-center gap-3">
                      <span class="status-badge ${item.status === 'กำลังยืม' ? 'status-borrowed' : item.status === 'คืนแล้ว' ? 'status-returned' : item.status === 'รออนุมัติ' ? 'status-pending' : 'status-rejected'}">${escapeHtml(item.status)}</span>
                      ${item.status === 'กำลังยืม' ? `
                        <button onclick="returnEquipmentConfirm('${escapeHtml(item.transId)}', '${escapeHtml(item.equipId)}', ${item.qty})" class="btn-approve text-xs py-1.5 px-3 min-h-[36px]" title="คืนเฉพาะอุปกรณ์ชิ้นนี้">
                          <i class="fas fa-undo"></i> คืนชิ้นนี้
                        </button>
                      ` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('admin-trans-current-page').textContent = adminTransCurrentPage;
  document.getElementById('admin-trans-total-pages').textContent = Math.max(1, totalPages);
  document.getElementById('btn-admin-trans-prev').disabled = adminTransCurrentPage <= 1;
  document.getElementById('btn-admin-trans-next').disabled = adminTransCurrentPage >= totalPages;
}

function changeAdminTransPage(dir) {
  adminTransCurrentPage += dir;
  renderAdminTransactionsTable();
}

async function approveBorrowConfirm(transId) {
  const groupItems = transactionData.filter(t => t.transId === transId && t.status === 'รออนุมัติ');
  const borrowerName = groupItems[0]?.borrowerName || '';
  const itemSummaryHtml = groupItems.map(it => `<li style="text-align:left;">• <strong>${escapeHtml(it.equipName)}</strong> (${it.qty} ชิ้น)</li>`).join('');

  const result = await Swal.fire({
    title: 'ยืนยันการอนุมัติ?',
    html: `
      <div style="text-align:left; font-size:14px; margin-top:10px;">
        <p><strong>รหัสคำขอ:</strong> ${escapeHtml(transId)}</p>
        <p><strong>ผู้ยืม:</strong> ${escapeHtml(borrowerName)}</p>
        <p style="margin-top:8px;"><strong>รายการอุปกรณ์ที่อนุมัติ (${groupItems.length} รายการ):</strong></p>
        <ul style="padding-left:15px; margin-top:4px; color:#374151;">${itemSummaryHtml}</ul>
      </div>
    `,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'อนุมัติทั้งคำขอ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#059669'
  });

  if (result.isConfirmed) {
    try {
      Swal.showLoading();
      const res = await apiRequest('approveBorrowRequest', { transId });
      const hasNotificationWarnings = Array.isArray(res?.notificationWarnings) && res.notificationWarnings.length > 0;
      Swal.fire({
        icon: 'success',
        title: 'อนุมัติเรียบร้อยแล้ว',
        text: hasNotificationWarnings ? 'บันทึกข้อมูลสำเร็จแล้ว แต่การแจ้งเตือนบางช่องทางไม่สำเร็จ' : undefined,
        timer: hasNotificationWarnings ? undefined : 1200,
        showConfirmButton: hasNotificationWarnings
      });
      loadData();
    } catch (err) {
      Swal.fire('อนุมัติไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการอนุมัติ', 'error');
    }
  }
}

async function rejectBorrowConfirm(transId) {
  const groupItems = transactionData.filter(t => t.transId === transId && t.status === 'รออนุมัติ');
  const borrowerName = groupItems[0]?.borrowerName || '';
  const itemSummaryHtml = groupItems.map(it => `<li style="text-align:left;">• <strong>${escapeHtml(it.equipName)}</strong> (${it.qty} ชิ้น)</li>`).join('');

  const { value: reason } = await Swal.fire({
    title: 'ปฏิเสธคำขอยืม',
    html: `
      <div style="text-align:left; font-size:14px; margin-bottom:12px;">
        <p><strong>รหัสคำขอ:</strong> ${escapeHtml(transId)}</p>
        <p><strong>ผู้ยืม:</strong> ${escapeHtml(borrowerName)}</p>
        <ul style="padding-left:15px; margin-top:4px; color:#374151;">${itemSummaryHtml}</ul>
      </div>
    `,
    input: 'text',
    inputLabel: 'เหตุผลการไม่อนุมัติ',
    inputPlaceholder: 'กรอกเหตุผล...',
    showCancelButton: true,
    confirmButtonText: 'ยืนยันปฏิเสธทั้งคำขอ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626'
  });

  if (reason !== undefined) {
    try {
      Swal.showLoading();
      const res = await apiRequest('rejectBorrowRequest', { transId, reason });
      const hasNotificationWarnings = Array.isArray(res?.notificationWarnings) && res.notificationWarnings.length > 0;
      Swal.fire({
        icon: 'success',
        title: 'ปฏิเสธคำขอเรียบร้อยแล้ว',
        text: hasNotificationWarnings ? 'บันทึกข้อมูลสำเร็จแล้ว แต่การแจ้งเตือนบางช่องทางไม่สำเร็จ' : undefined,
        timer: hasNotificationWarnings ? undefined : 1200,
        showConfirmButton: hasNotificationWarnings
      });
      loadData();
    } catch (err) {
      Swal.fire('ทำรายการไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการปฏิเสธ', 'error');
    }
  }
}

async function returnAllEquipmentConfirm(transId) {
  const groupItems = transactionData.filter(t => t.transId === transId && t.status === 'กำลังยืม');
  const borrowerName = groupItems[0]?.borrowerName || '';
  const itemSummaryHtml = groupItems.map(it => `<li style="text-align:left;">• <strong>${escapeHtml(it.equipName)}</strong> (${it.qty} ชิ้น)</li>`).join('');

  const result = await Swal.fire({
    title: 'ยืนยันคืนอุปกรณ์ทั้งหมด?',
    html: `
      <div style="text-align:left; font-size:14px; margin-top:10px;">
        <p><strong>รหัสคำขอ:</strong> ${escapeHtml(transId)}</p>
        <p><strong>ผู้ยืม:</strong> ${escapeHtml(borrowerName)}</p>
        <p style="margin-top:8px;"><strong>รายการที่จะรับคืน (${groupItems.length} รายการ):</strong></p>
        <ul style="padding-left:15px; margin-top:4px; color:#374151;">${itemSummaryHtml}</ul>
      </div>
    `,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'รับคืนทั้งหมด',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#059669'
  });

  if (result.isConfirmed) {
    try {
      Swal.showLoading();
      await apiRequest('returnAllEquipment', { transId });
      Swal.fire({ icon: 'success', title: 'รับคืนอุปกรณ์ทั้งหมดเรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadData();
    } catch (err) {
      Swal.fire('รับคืนไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการรับคืน', 'error');
    }
  }
}

async function returnEquipmentConfirm(transId, equipId, qty) {
  const targetItem = transactionData.find(t => t.transId === transId && t.equipId === equipId);
  const equipName = targetItem?.equipName || equipId;
  const result = await Swal.fire({
    title: 'ยืนยันการคืนอุปกรณ์?',
    html: `
      <div style="text-align:left; font-size:14px; margin-top:10px;">
        <p><strong>รหัสคำขอ:</strong> ${escapeHtml(transId)}</p>
        <p><strong>อุปกรณ์:</strong> ${escapeHtml(equipName)}</p>
        <p><strong>จำนวน:</strong> ${qty} ชิ้น</p>
      </div>
    `,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'รับคืนชิ้นนี้',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#0284c7'
  });

  if (result.isConfirmed) {
    try {
      Swal.showLoading();
      await apiRequest('returnEquipment', { transId, equipId, qty });
      Swal.fire({ icon: 'success', title: 'รับคืนเรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadData();
    } catch (err) {
      Swal.fire('รับคืนไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการรับคืน', 'error');
    }
  }
}

// ==========================================
// Admin Equipment Add / Edit / Delete
// ==========================================
function getNextEquipmentId(category) {
  const categoryPrefixes = {
    audiovisual: 'A',
    kitchen: 'B',
    general: 'C'
  };
  const prefix = categoryPrefixes[category];
  if (!prefix) return '';

  const idPattern = new RegExp(`^${prefix}(\\d+)$`, 'i');
  const highestSequence = equipmentData.reduce((highest, item) => {
    const match = String(item.id || '').trim().match(idPattern);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);

  return `${prefix}${String(highestSequence + 1).padStart(3, '0')}`;
}

function updateAutoEquipmentId() {
  if (document.getElementById('manageAction')?.value !== 'add') return;
  const idInput = document.getElementById('manageId');
  const category = document.getElementById('manageCategory')?.value;
  if (idInput) idInput.value = getNextEquipmentId(category);
}

function openEquipModal(action, equipId = null) {
  const modal = document.getElementById('equipModal');
  const form = document.getElementById('equipForm');
  const title = document.getElementById('equipModalTitle');
  document.getElementById('manageAction').value = action;

  if (!modal || !form) return;

  form.reset();
  ['preview1', 'preview2'].forEach(previewId => {
    const preview = document.getElementById(previewId);
    if (preview) {
      preview.src = '';
      preview.onerror = null;
      delete preview.dataset.driveFallbackTried;
    }
  });
  document.getElementById('image1Url').value = '';
  document.getElementById('image2Url').value = '';
  document.querySelectorAll('#imageInput1, #imageInput2').forEach(input => {
    input.dataset.imageProcessing = 'false';
  });
  document.getElementById('preview1Container')?.classList.add('hidden');
  document.getElementById('preview2Container')?.classList.add('hidden');

  if (action === 'edit' && equipId) {
    const item = equipmentData.find(e => e.id === equipId);
    if (!item) return;
    title.innerHTML = `<i class="fa-solid fa-edit mr-2"></i>แก้ไขอุปกรณ์ (${escapeHtml(item.id)})`;
    document.getElementById('manageOriginalId').value = item.id;
    document.getElementById('manageId').value = item.id;
    document.getElementById('manageId').readOnly = false;
    document.getElementById('manageId').placeholder = '';
    document.getElementById('manageName').value = item.name;
    document.getElementById('manageCategory').value = item.category || 'general';
    document.getElementById('manageDescription').value = item.description || '';

    const locationSelect = document.getElementById('manageLocation');
    const locationOther = document.getElementById('locationOther');
    const locationValue = String(item.location || '').trim();
    const knownLocations = Array.from(locationSelect.options).map(o => o.value).filter(v => v && v !== '__OTHER__');
    if (locationValue && knownLocations.includes(locationValue)) {
      locationSelect.value = locationValue;
      if (locationOther) locationOther.value = '';
    } else if (locationValue) {
      locationSelect.value = '__OTHER__';
      if (locationOther) locationOther.value = locationValue;
    } else {
      locationSelect.value = '';
      if (locationOther) locationOther.value = '';
    }
    updateStorageLocationOtherVisibility();

    document.getElementById('manageTotal').value = item.total;
    document.getElementById('manageAvailable').value = item.available;

    const sampleImg = getSampleEquipmentImage(item, EQUIPMENT_IMAGE_FULL_WIDTH);
    const img1Src = formatImageUrl(item.image1, EQUIPMENT_IMAGE_FULL_WIDTH) || sampleImg;
    if (img1Src) {
      const p1 = document.getElementById('preview1');
      if (p1) {
        p1.dataset.driveFallbackTried = 'false';
        p1.onerror = () => handleEquipmentImageError(p1);
        p1.src = img1Src;
        document.getElementById('preview1Container').classList.remove('hidden');
      }
      document.getElementById('image1Url').value = item.image1 || '';
    }
    const img2Src = getUploadedEquipmentImageUrl(item.image2, EQUIPMENT_IMAGE_FULL_WIDTH);
    if (img2Src) {
      const p2 = document.getElementById('preview2');
      if (p2) {
        p2.dataset.driveFallbackTried = 'false';
        p2.onerror = () => handleEquipmentImageError(p2);
        p2.src = img2Src;
        document.getElementById('preview2Container').classList.remove('hidden');
      }
      document.getElementById('image2Url').value = item.image2 || '';
    }
  } else {
    title.innerHTML = `<i class="fa-solid fa-plus mr-2"></i>เพิ่มอุปกรณ์ใหม่`;
    document.getElementById('manageOriginalId').value = '';
    document.getElementById('manageId').readOnly = true;
    document.getElementById('manageId').placeholder = 'เลือกหมวดเพื่อสร้างรหัสอัตโนมัติ';
  }

  modal.classList.remove('hidden');
}

function closeEquipModal() {
  document.getElementById('equipModal')?.classList.add('hidden');
}

function updateStorageLocationOtherVisibility() {
  const select = document.getElementById('manageLocation');
  const container = document.getElementById('storageLocationOtherContainer');
  if (container) {
    if (select.value === '__OTHER__') container.classList.remove('hidden');
    else container.classList.add('hidden');
  }
}

function convertImageToWebp(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
    reader.onload = () => {
      const source = new Image();
      source.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
      source.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = source.naturalWidth;
        canvas.height = source.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('เบราว์เซอร์ไม่รองรับการแปลงรูปภาพ'));
          return;
        }

        // ponytail: browser-native conversion avoids adding a GAS image dependency.
        try {
          context.drawImage(source, 0, 0);
          const webpData = canvas.toDataURL('image/webp', 0.85);
          resolve(webpData.startsWith('data:image/webp') ? webpData : String(reader.result || ''));
        } catch (error) {
          reject(new Error('ไม่สามารถแปลงรูปภาพเป็น WebP ได้'));
        }
      };
      source.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function previewImage(input, previewId) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    input.value = '';
    Swal.fire('อัปโหลดไม่สำเร็จ', 'กรุณาเลือกไฟล์รูปภาพ', 'error');
    return;
  }

  input.dataset.imageProcessing = 'true';
  try {
    const imageData = await convertImageToWebp(file);
    if (input.files?.[0] !== file) return;

    input.dataset.imageProcessing = 'false';
    const img = document.getElementById(previewId);
    const container = document.getElementById(`${previewId}Container`);
    if (img && container) {
      img.src = imageData;
      container.classList.remove('hidden');
    }
  } catch (error) {
    if (input.files?.[0] !== file) return;
    input.dataset.imageProcessing = 'false';
    input.value = '';
    Swal.fire('อัปโหลดไม่สำเร็จ', error.message || 'ไม่สามารถเตรียมรูปภาพได้', 'error');
  }
}

function removeImage(previewId) {
  const img = document.getElementById(previewId);
  const container = document.getElementById(`${previewId}Container`);
  const inputNum = previewId.replace('preview', '');
  const fileInput = document.getElementById(`imageInput${inputNum}`);
  const hiddenUrl = document.getElementById(`image${inputNum}Url`);

  if (img) img.src = '';
  if (container) container.classList.add('hidden');
  if (fileInput) {
    fileInput.value = '';
    fileInput.dataset.imageProcessing = 'false';
  }
  if (hiddenUrl) hiddenUrl.value = '';
}

async function handleEquipSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const action = document.getElementById('manageAction').value;

  let locationVal = form.location.value;
  if (locationVal === '__OTHER__') {
    locationVal = (form.locationOther.value || '').trim();
    if (!locationVal) {
      Swal.fire('กรุณาระบุสถานที่เก็บ', 'กรอกชื่อสถานที่เก็บอื่นๆ ให้ครบ', 'warning');
      return;
    }
  }

  const p1Img = document.getElementById('preview1')?.src || '';
  const p2Img = document.getElementById('preview2')?.src || '';
  const imageInput1 = document.getElementById('imageInput1');
  const imageInput2 = document.getElementById('imageInput2');
  const hasNewImage1 = Boolean(imageInput1?.files?.[0]);
  const hasNewImage2 = Boolean(imageInput2?.files?.[0]);
  const isImageProcessing = imageInput1?.dataset.imageProcessing === 'true'
    || imageInput2?.dataset.imageProcessing === 'true';
  if (isImageProcessing) {
    Swal.fire('กำลังเตรียมรูปภาพ', 'โปรดรอการเตรียมรูปภาพให้เสร็จก่อนบันทึก', 'info');
    return;
  }
  const newId = form.id.value.trim();
  const originalId = (document.getElementById('manageOriginalId')?.value || '').trim() || newId;

  if (!newId) {
    Swal.fire('กรุณากรอกรหัสอุปกรณ์', 'รหัสอุปกรณ์ต้องไม่ว่าง', 'warning');
    return;
  }

  const payload = {
    action: action,
    id: newId,
    originalId: action === 'edit' ? originalId : newId,
    name: form.name.value.trim(),
    category: form.category.value,
    description: form.description.value.trim(),
    location: locationVal,
    total: Number(form.total.value),
    available: Number(form.available.value),
    image1: hasNewImage1 && p1Img.startsWith('data:image') ? p1Img : form.image1Url.value,
    image2: hasNewImage2 && p2Img.startsWith('data:image') ? p2Img : form.image2Url.value
  };

  try {
    Swal.showLoading();
    await apiRequest('saveEquipment', payload, { timeout: API_HEAVY_TIMEOUT_MS });
    closeEquipModal();
    Swal.fire({ icon: 'success', title: 'บันทึกอุปกรณ์สำเร็จ', timer: 1200, showConfirmButton: false });
    loadData();
  } catch (err) {
    Swal.fire('บันทึกไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการบันทึกอุปกรณ์', 'error');
  }
}

async function deleteEquipmentConfirm(id) {
  const result = await Swal.fire({
    title: 'ยืนยันการลบอุปกรณ์?',
    text: `ต้องการลบอุปกรณ์รหัส ${id} หรือไม่`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'ลบข้อมูล',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626'
  });

  if (result.isConfirmed) {
    try {
      Swal.showLoading();
      await apiRequest('deleteEquipment', { id });
      Swal.fire({ icon: 'success', title: 'ลบอุปกรณ์เรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadData();
    } catch (err) {
      Swal.fire('ลบไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการลบอุปกรณ์', 'error');
    }
  }
}

// ==========================================
// Admin Users Management
// ==========================================
async function loadAdminUsersData(options = {}) {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh && adminUsersLoadedAt && Date.now() - adminUsersLoadedAt < ADMIN_USERS_CACHE_MS) {
    renderAdminUsersTable();
    return;
  }

  try {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>กำลังโหลดข้อมูล...</td></tr>';
    const res = await apiRequest('getUsers');
    adminUsersData = res.users || [];
    adminUsersLoadedAt = Date.now();
    renderAdminUsersTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 text-red-500">ไม่สามารถโหลดผู้ใช้: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderAdminUsersTable() {
  const tbody = document.getElementById('admin-users-tbody');
  const search = (document.getElementById('admin-user-search')?.value || '').toLowerCase().trim();
  if (!tbody) return;

  const filtered = adminUsersData.filter(u =>
    !search || (u.userId || '').toLowerCase().includes(search) || (u.name || '').toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-gray-500">ไม่พบผู้ใช้งานในระบบ</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(u => {
    return `
      <tr class="table-row">
        <td class="px-6 py-4 font-mono font-bold text-sky-800">${escapeHtml(u.userId)}</td>
        <td class="px-6 py-4 font-semibold text-gray-800">${escapeHtml(u.name)}</td>
        <td class="px-6 py-4"><span class="px-3 py-1 rounded-full text-xs font-bold ${u.role === 'Super Admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}">${escapeHtml(u.role)}</span></td>
        <td class="px-6 py-4 text-gray-500">${escapeHtml(formatThaiDate(u.createdAt, true))}</td>
        <td class="px-6 py-4 text-center">
          <div class="table-action-btns">
            <button type="button" onclick="viewUserPasswordHandler('${escapeHtml(u.userId)}')" class="btn-action-view" aria-label="ดูรหัสผ่าน ${escapeHtml(u.userId)}">
              <i class="fa-solid fa-key"></i> รหัส
            </button>
            <button type="button" onclick="editUserRoleHandler('${escapeHtml(u.userId)}')" class="btn-action-edit" aria-label="แก้ไขสิทธิ์ ${escapeHtml(u.userId)}">
              <i class="fa-solid fa-user-pen"></i> สิทธิ์
            </button>
            <button type="button" onclick="deleteUserHandler('${escapeHtml(u.userId)}')" class="btn-action-delete" aria-label="ลบผู้ใช้ ${escapeHtml(u.userId)}">
              <i class="fa-solid fa-user-minus"></i> ลบ
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function viewUserPasswordHandler(targetUserId) {
  const user = adminUsersData.find(u => u.userId === targetUserId);
  if (!user) return;

  const pinText = user.pin ? String(user.pin) : 'ไม่มีข้อมูลรหัสผ่าน';
  const roleBadge = user.role === 'Super Admin'
    ? '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-800">Super Admin</span>'
    : '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800">Staff</span>';

  Swal.fire({
    title: '<i class="fa-solid fa-key text-sky-600 mr-2"></i>ข้อมูลรหัสผ่านผู้ใช้งาน',
    html: `
      <div class="text-left space-y-4 pt-2">
        <div class="bg-gray-50 p-3.5 rounded-xl border border-gray-200">
          <div class="flex justify-between items-center mb-1">
            <span class="text-xs text-gray-500 font-medium">ไอดีผู้ใช้ (UserID):</span>
            <span class="font-mono font-bold text-sky-800">${escapeHtml(user.userId)}</span>
          </div>
          <div class="flex justify-between items-center mb-1">
            <span class="text-xs text-gray-500 font-medium">ชื่อ-นามสกุล:</span>
            <span class="font-semibold text-gray-800">${escapeHtml(user.name)}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-xs text-gray-500 font-medium">สิทธิ์การใช้งาน:</span>
            <span>${roleBadge}</span>
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold text-gray-600 mb-1.5">
            <i class="fa-solid fa-lock text-sky-600 mr-1"></i>รหัสผ่าน (PIN)
          </label>
          <div class="relative flex items-center">
            <input type="password" id="swal-view-pin" value="${escapeHtml(pinText)}" readonly class="swal2-input font-mono font-bold tracking-widest text-center text-lg text-gray-800 select-all" style="width:100%;margin:0;padding-right:85px;background-color:#f8fafc;cursor:default;">
            <div class="absolute right-2 flex items-center gap-1">
              <button type="button" id="swal-view-pin-toggle" class="p-2 text-gray-500 hover:text-sky-700 rounded-lg hover:bg-gray-200 transition" title="เปิด/ปิดการซ่อนรหัสผ่าน" aria-label="แสดงหรือซ่อนรหัสผ่าน">
                <i class="fa-solid fa-eye"></i>
              </button>
              <button type="button" id="swal-view-pin-copy" class="p-2 text-gray-500 hover:text-emerald-700 rounded-lg hover:bg-gray-200 transition" title="คัดลอกรหัสผ่าน" aria-label="คัดลอกรหัสผ่าน">
                <i class="fa-solid fa-copy"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `,
    confirmButtonText: '<i class="fa-solid fa-check mr-1"></i>ปิดหน้าต่าง',
    confirmButtonColor: '#0284c7',
    didOpen: () => {
      const pinInput = document.getElementById('swal-view-pin');
      const toggleBtn = document.getElementById('swal-view-pin-toggle');
      const copyBtn = document.getElementById('swal-view-pin-copy');

      if (toggleBtn && pinInput) {
        toggleBtn.addEventListener('click', () => {
          const isHidden = pinInput.type === 'password';
          pinInput.type = isHidden ? 'text' : 'password';
          toggleBtn.innerHTML = isHidden ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
        });
      }

      if (copyBtn && pinInput) {
        copyBtn.addEventListener('click', async () => {
          if (!user.pin) {
            Swal.showValidationMessage('ไม่มีข้อมูลรหัสผ่านให้คัดลอก');
            return;
          }
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(String(user.pin));
            } else {
              pinInput.select();
              document.execCommand('copy');
            }
            copyBtn.innerHTML = '<i class="fa-solid fa-check text-emerald-600"></i>';
            setTimeout(() => {
              copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
            }, 1500);
          } catch (e) {
            pinInput.select();
          }
        });
      }
    }
  });
}

function openUserModal() {
  Swal.fire({
    title: '<i class="fas fa-user-plus text-sky-700 mr-2"></i>เพิ่มผู้ใช้งานใหม่',
    html: `
      <div class="text-left space-y-3 pt-2">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">ไอดีผู้ใช้ (UserID)</label>
          <input type="text" id="swal-user-id" class="swal2-input" style="width:100%;margin:0;" placeholder="ภาษาอังกฤษ/ตัวเลข">
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">ชื่อ-นามสกุล</label>
          <input type="text" id="swal-user-name" class="swal2-input" style="width:100%;margin:0;" placeholder="กรอกชื่อ-นามสกุล">
        </div>
        ${buildPasswordFieldHtml('swal-user-pin', 'swal-user-pin-toggle', 'รหัสผ่าน (PIN)', 'ตั้งรหัสผ่าน', 'new-password')}
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">สิทธิ์การใช้งาน (Role)</label>
          <select id="swal-user-role" class="swal2-input" style="width:100%;margin:0;">
            <option value="Staff">Staff (ยืม-คืน / อนุมัติรายการ)</option>
            <option value="Super Admin">Super Admin (ผู้ดูแลระบบสูงสุด)</option>
          </select>
        </div>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'บันทึกผู้ใช้',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#059669',
    didOpen: () => {
      bindPasswordToggle('swal-user-pin', 'swal-user-pin-toggle');
    },
    preConfirm: () => {
      const userId = document.getElementById('swal-user-id').value.trim();
      const name = document.getElementById('swal-user-name').value.trim();
      const pin = document.getElementById('swal-user-pin').value.trim();
      const role = document.getElementById('swal-user-role').value;

      if (!userId || !name || !pin || !role) {
        Swal.showValidationMessage('กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง');
        return false;
      }
      return { userId, name, pin, role };
    }
  }).then(async (result) => {
    if (!result.isConfirmed || !result.value) return;
    try {
      Swal.showLoading();
      await apiRequest('saveUser', result.value);
      Swal.fire({ icon: 'success', title: 'เพิ่มผู้ใช้งานสำเร็จ', timer: 1200, showConfirmButton: false });
      loadAdminUsersData({ forceRefresh: true });
    } catch (err) {
      Swal.fire('เพิ่มผู้ใช้ไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการบันทึกผู้ใช้', 'error');
    }
  });
}

function editUserRoleHandler(targetUserId) {
  const user = adminUsersData.find(u => u.userId === targetUserId);
  if (!user) return;

  Swal.fire({
    title: `<i class="fas fa-user-shield text-purple-600 mr-2"></i>แก้ไขสิทธิ์ ${escapeHtml(targetUserId)}`,
    html: `
      <div class="text-left space-y-3 pt-2">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">สิทธิ์การใช้งานใหม่</label>
          <select id="swal-edit-role" class="swal2-input" style="width:100%;margin:0;">
            <option value="Staff" ${user.role === 'Staff' ? 'selected' : ''}>Staff (ยืม-คืน / อนุมัติรายการ)</option>
            <option value="Super Admin" ${user.role === 'Super Admin' ? 'selected' : ''}>Super Admin (ผู้ดูแลระบบสูงสุด)</option>
          </select>
        </div>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'บันทึกสิทธิ์',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#7c3aed',
    preConfirm: () => {
      const role = document.getElementById('swal-edit-role').value;
      return { userId: targetUserId, role: role };
    }
  }).then(async (result) => {
    if (!result.isConfirmed || !result.value) return;
    try {
      Swal.showLoading();
      await apiRequest('updateUser', result.value);
      Swal.fire({ icon: 'success', title: 'อัปเดตสิทธิ์สำเร็จ', timer: 1200, showConfirmButton: false });
      loadAdminUsersData({ forceRefresh: true });
    } catch (err) {
      Swal.fire('อัปเดตไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการอัปเดตสิทธิ์', 'error');
    }
  });
}

async function deleteUserHandler(targetUserId) {
  const currentUserId = currentUser ? currentUser.userId : '';
  if (currentUserId && String(targetUserId).toLowerCase() === String(currentUserId).toLowerCase()) {
    Swal.fire('ไม่สามารถลบได้', 'ไม่สามารถลบบัญชีตนเองที่กำลังใช้งานอยู่ได้', 'warning');
    return;
  }

  const result = await Swal.fire({
    title: 'ยืนยันการลบผู้ใช้?',
    text: `ต้องการลบผู้ใช้ไอดี ${targetUserId} หรือไม่`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'ลบผู้ใช้งาน',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626'
  });

  if (result.isConfirmed) {
    try {
      Swal.showLoading();
      await apiRequest('deleteUser', { targetUserId });
      Swal.fire({ icon: 'success', title: 'ลบผู้ใช้เรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadAdminUsersData({ forceRefresh: true });
    } catch (err) {
      Swal.fire('ลบไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการลบผู้ใช้', 'error');
    }
  }
}

// ==========================================
// Admin Reports & Chart Logic
// ==========================================
function renderAdminReports() {
  const total = transactionData.length;
  const returned = transactionData.filter(t => t.status === 'คืนแล้ว').length;
  const borrowing = transactionData.filter(t => t.status === 'กำลังยืม').length;

  document.getElementById('report-total-trans').textContent = total;
  document.getElementById('report-returned').textContent = returned;
  document.getElementById('report-borrowing').textContent = borrowing;
  document.getElementById('report-overdue').textContent = 0;

  // Render Usage Stats Progress Bars
  const usageStatsContainer = document.getElementById('usage-stats');
  if (usageStatsContainer) {
    const returnedPct = total > 0 ? Math.round((returned / total) * 100) : 0;
    const borrowingPct = total > 0 ? Math.round((borrowing / total) * 100) : 0;
    
    usageStatsContainer.innerHTML = `
      <div>
        <div class="flex justify-between items-center text-sm font-semibold mb-1.5">
          <span class="text-gray-700 flex items-center gap-3"><i class="fas fa-check-circle text-emerald-500"></i> คืนแล้ว</span>
          <span class="text-emerald-700 font-bold">${returned} รายการ (${returnedPct}%)</span>
        </div>
        <div class="usage-progress-bar">
          <div class="usage-progress-fill bg-gradient-to-r from-emerald-500 to-teal-400" style="width: ${returnedPct}%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between items-center text-sm font-semibold mb-1.5">
          <span class="text-gray-700 flex items-center gap-3"><i class="fas fa-hourglass-half text-amber-500"></i> กำลังยืม</span>
          <span class="text-amber-700 font-bold">${borrowing} รายการ (${borrowingPct}%)</span>
        </div>
        <div class="usage-progress-bar">
          <div class="usage-progress-fill bg-gradient-to-r from-amber-500 to-orange-400" style="width: ${borrowingPct}%"></div>
        </div>
      </div>
    `;
  }

  // Render Popular Equipment (Top 5)
  const popularContainer = document.getElementById('popular-equipment');
  if (popularContainer) {
    const countsMap = {};
    transactionData.forEach(t => {
      const name = t.equipName || 'ไม่ระบุชื่อ';
      countsMap[name] = (countsMap[name] || 0) + 1;
    });

    const sorted = Object.entries(countsMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (sorted.length === 0) {
      popularContainer.innerHTML = '<div class="text-sm text-gray-500 py-3 text-center">ยังไม่มีข้อมูลการยืมอุปกรณ์</div>';
    } else {
      const maxCount = sorted[0][1] || 1;
      popularContainer.innerHTML = sorted.map(([name, count], idx) => {
        const rankClass = idx === 0 ? 'popular-rank-1' : idx === 1 ? 'popular-rank-2' : idx === 2 ? 'popular-rank-3' : 'popular-rank-other';
        const rankLabel = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : (idx + 1);
        const barWidth = Math.round((count / maxCount) * 100);
        return `
          <div class="flex items-center gap-4 p-3 rounded-xl hover:bg-slate-50 transition border border-transparent hover:border-slate-100">
            <div class="popular-rank-badge ${rankClass}">${rankLabel}</div>
            <div class="flex-1 min-w-0">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-gray-800 text-sm truncate">${escapeHtml(name)}</span>
                <span class="text-xs font-semibold text-sky-700 bg-sky-50 px-2.5 py-0.5 rounded-full border border-sky-200/80">${count} ครั้ง</span>
              </div>
              <div class="usage-progress-bar">
                <div class="usage-progress-fill bg-gradient-to-r from-sky-500 to-indigo-500" style="width: ${barWidth}%"></div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  renderBorrowChart();
}

function renderBorrowChart() {
  const container = document.getElementById('chart-container');
  if (!container) return;

  if (borrowChart) {
    borrowChart.destroy();
    borrowChart = null;
  }

  const days = [];
  const counts = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = normalizeThaiDateKey(formatThaiDate(d));
    days.push(dateKey);
    counts.push(transactionData.filter(t => normalizeThaiDateKey(t.dateBorrow) === dateKey).length);
  }

  const totalInWindow = counts.reduce((sum, n) => sum + n, 0);
  if (totalInWindow === 0) {
    container.innerHTML = `
      <div class="chart-empty-state" role="status">
        <i class="fas fa-chart-column chart-empty-icon" aria-hidden="true"></i>
        <p class="chart-empty-title">ยังไม่มีการยืมใน 7 วันล่าสุด</p>
        <p class="chart-empty-hint">เมื่อมีการยืมในช่วงนี้ กราฟแท่งจะแสดงจำนวนรายการรายวัน</p>
      </div>`;
    return;
  }

  container.innerHTML = '<canvas id="borrowChart"></canvas>';
  const ctx = document.getElementById('borrowChart')?.getContext('2d');
  if (!ctx) return;

  borrowChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'จำนวนการยืม (รายการ)',
        data: counts,
        backgroundColor: 'rgba(2, 132, 199, 0.85)',
        hoverBackgroundColor: 'rgba(3, 105, 161, 0.95)',
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: 8,
        borderSkipped: false,
        maxBarThickness: 48
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 600,
        easing: 'easeOutQuart'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          padding: 12,
          cornerRadius: 8,
          titleFont: { family: 'Sarabun', weight: '600' },
          bodyFont: { family: 'Sarabun' },
          callbacks: {
            label: (ctx) => ` ${ctx.parsed.y} รายการ`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Sarabun' } } },
        y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0, font: { family: 'Sarabun' } } }
      }
    }
  });
}

// ==========================================
// Contact Modal Logic
// ==========================================
function openContactModal() {
  document.getElementById('contactModal')?.classList.remove('hidden');
}

function closeContactModal() {
  document.getElementById('contactModal')?.classList.add('hidden');
}

async function handleContactSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const payload = {
    name: form.name.value.trim(),
    phone: form.phone.value.trim(),
    email: form.email.value.trim(),
    subject: form.subject.value.trim(),
    message: form.message.value.trim()
  };

  try {
    Swal.showLoading();
    await apiRequest('saveContactForm', payload);
    closeContactModal();
    form.reset();
    Swal.fire({ icon: 'success', title: 'ส่งข้อความสำเร็จ', text: 'ระบบได้รับข้อความติดต่อของท่านเรียบร้อยแล้ว', timer: 1500, showConfirmButton: false });
  } catch (err) {
    Swal.fire('ส่งข้อความไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการส่งข้อความ', 'error');
  }
}

// ==========================================
// Standalone Report View Integration (Report.html merged)
// ==========================================
function getReportEmptyMessage(reportType) {
  const type = String(reportType || 'all');
  if (type === 'monthly') return 'ไม่มีรายการยืม-คืนในเดือนนี้ ไม่ต้องเปิดรายงาน';
  if (type === 'borrowing') return 'ไม่มีรายการที่กำลังยืม ไม่ต้องเปิดรายงาน';
  if (type === 'daily') return 'ไม่มีรายการยืม-คืนในวันนี้ ไม่ต้องเปิดรายงาน';
  if (type === 'yearly') return 'ไม่มีรายการยืม-คืนในปีนี้ ไม่ต้องเปิดรายงาน';
  return 'ยังไม่มีรายการยืม-คืนในระบบ ไม่ต้องเปิดรายงาน';
}

async function openReportView(reportType = 'all') {
  const mainApp = document.getElementById('mainAppContainer');
  const reportView = document.getElementById('reportViewContainer');

  try {
    Swal.fire({
      title: 'กำลังตรวจสอบรายงาน...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    const reportData = await apiRequest('getReportData', { reportType });
    Swal.close();

    const transactions = reportData?.transactions || [];
    if (reportData?.status !== 'success' || transactions.length === 0) {
      Swal.fire({
        icon: 'info',
        title: 'ไม่มีรายงาน',
        text: getReportEmptyMessage(reportType),
        confirmButtonText: 'ตกลง'
      });
      if (reportView) reportView.classList.add('hidden-section');
      if (mainApp) mainApp.classList.remove('hidden-section');
      return;
    }

    if (mainApp) mainApp.classList.add('hidden-section');
    if (reportView) reportView.classList.remove('hidden-section');
    renderReportContent(reportData);
  } catch (err) {
    Swal.close();
    if (reportView) reportView.classList.add('hidden-section');
    if (mainApp) mainApp.classList.remove('hidden-section');
    Swal.fire('ไม่สามารถโหลดรายงาน', err.message || 'เกิดข้อผิดพลาดในการดึงข้อมูลรายงาน', 'error');
  }
}

function closeReportView() {
  const mainApp = document.getElementById('mainAppContainer');
  const reportView = document.getElementById('reportViewContainer');

  if (reportView) reportView.classList.add('hidden-section');
  if (mainApp) mainApp.classList.remove('hidden-section');
}

function renderReportContent(report) {
  if (!report || report.status !== 'success') {
    document.getElementById('reportContent').innerHTML = `<div class="error">${escapeHtml((report && report.message) || 'ไม่สามารถโหลดข้อมูลรายงานได้')}</div>`;
    return;
  }

  document.title = report.title;
  document.getElementById('reportTitle').textContent = report.title;
  document.getElementById('generatedAt').textContent = 'วันที่พิมพ์: ' + report.generatedAt;

  if (report.logoUrl) {
    const logo = document.getElementById('logo');
    logo.onerror = () => document.getElementById('logoFrame').hidden = true;
    logo.src = report.logoUrl;
    document.getElementById('logoFrame').hidden = false;
  }

  const transactions = report.transactions || [];
  const borrowingCount = transactions.filter(item => item.status === 'กำลังยืม').length;
  const returnedCount = transactions.filter(item => item.status === 'คืนแล้ว').length;

  const summary = `
    <table class="summary-table" aria-label="สรุปรายงาน"><tbody><tr>
      <td><span class="summary-label">จำนวนรายการ</span><span class="summary-value">${transactions.length}</span></td>
      <td><span class="summary-label">กำลังยืม</span><span class="summary-value">${borrowingCount}</span></td>
      <td><span class="summary-label">คืนแล้ว</span><span class="summary-value">${returnedCount}</span></td>
      <td><span class="summary-label">ประเภทรายงาน</span><span class="summary-value">${escapeHtml(report.reportType === 'monthly' ? 'รายเดือน' : report.reportType === 'borrowing' ? 'กำลังยืม' : 'ทั้งหมด')}</span></td>
    </tr></tbody></table>`;

  if (!transactions.length) {
    document.getElementById('reportContent').innerHTML = summary + '<div class="empty">ไม่พบรายการสำหรับรายงานนี้</div>';
    return;
  }

  const rows = transactions.map((item, index) => {
    const signatureUrl = String(item.signatureUrl || '').trim();
    const signatureCell = signatureUrl
      ? `<button type="button" class="signature-button" data-trans-id="${escapeHtml(item.transId)}" data-borrower="${escapeHtml(item.borrowerName)}" data-date="${escapeHtml(item.dateBorrow)}" data-sig-url="${escapeHtml(signatureUrl)}" onclick="showSignatureModalFromData(this)" aria-label="ดูภาพลายเซ็น"><img class="signature" src="${escapeHtml(signatureUrl)}" alt="ลายเซ็น"></button>`
      : '-';

    return `
      <tr>
        <td class="center">${index + 1}</td>
        <td>${escapeHtml(item.transId)}</td>
        <td>${escapeHtml(item.borrowerName)}<br><small>${escapeHtml(item.email)}</small></td>
        <td>${escapeHtml(item.equipName)}</td>
        <td class="center">${escapeHtml(item.qty)}</td>
        <td>${escapeHtml(item.dateBorrow)}</td>
        <td>${escapeHtml(item.dateReturn)}</td>
        <td>${escapeHtml(item.borrowRoom || '-')}</td>
        <td class="center">${signatureCell}</td>
        <td><span class="status ${item.status === 'กำลังยืม' ? 'status-borrowing' : 'status-returned'}">${escapeHtml(item.status)}</span></td>
      </tr>`;
  }).join('');

  document.getElementById('reportContent').innerHTML = summary + `
    <div class="table-wrap">
      <table class="report-table">
        <thead>
          <tr>
            <th style="width:5%" class="center">ลำดับ</th>
            <th style="width:12%">รหัสธุรกรรม</th>
            <th style="width:17%">ผู้ยืม</th>
            <th style="width:15%">อุปกรณ์</th>
            <th style="width:7%" class="center">จำนวน</th>
            <th style="width:10%">วันที่ยืม</th>
            <th style="width:10%">กำหนดคืน</th>
            <th style="width:10%">ห้องที่ใช้ยืม</th>
            <th style="width:7%" class="center">ลายเซ็น</th>
            <th style="width:10%">สถานะ</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
