/**
 * ==========================================================================
 * ระบบยืม-คืนอุปกรณ์ — Application JavaScript (app.js)
 * Architecture: Static Frontend + GAS JSON API Backend
 * ==========================================================================
 */

const DEFAULT_API_URL =
  'https://script.google.com/macros/s/AKfycbzAJRYOIvx7x3Q-iMP2DF2sVHZ-y5lXw3u8XncxuGHQuXzJklrjG_eUQExCCETrn2cw/exec';
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
const API_DEFAULT_TIMEOUT_MS = 90000;
const API_HEAVY_TIMEOUT_MS = 120000;
const ADMIN_SESSION_MS = 6 * 60 * 60 * 1000;
const ADMIN_SESSION_CHECK_MS = 15000;
const ADMIN_SESSION_EXPIRY_KEY = 'adminSessionExpiry';
const ADMIN_USER_KEY = 'adminUser';

async function apiRequest(action, payload = {}, options = {}) {
  const timeoutMs = options.timeout || API_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const apiUrl = resolveApiUrl();

  try {
    const isPost = options.method === 'POST' || [
      'verifyAdminPin', 'saveUser', 'updateUser', 'deleteUser',
      'saveBorrowRequest', 'returnEquipment', 'approveBorrowRequest',
      'rejectBorrowRequest', 'saveEquipment', 'deleteEquipment', 'saveContactForm'
    ].includes(action);

    let response;
    if (isPost) {
      // Use text/plain body to prevent CORS preflight OPTIONS block on script.google.com
      const postBody = JSON.stringify({ action, payload });
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: postBody,
        signal: controller.signal
      });
    } else {
      const queryParams = new URLSearchParams({
        action: action,
        payload: JSON.stringify(payload)
      });
      response = await fetch(`${apiUrl}?${queryParams.toString()}`, {
        method: 'GET',
        signal: controller.signal
      });
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('ไม่พบ Backend API (404) กรุณา Deploy Google Apps Script ใหม่และตรวจสอบ URL ใน APP_CONFIG');
      }
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (!text || text.trim() === '') {
      throw new Error('ได้รับข้อมูลว่างเปล่าจากเซิร์ฟเวอร์');
    }

    // Detect Google Apps Script HTML Redirect/Login Page
    if (text.includes('<!DOCTYPE html>') || text.includes('<html') || text.includes('google-site-verification')) {
      throw new Error('ระบบเซิร์ฟเวอร์ส่งกลับหน้า HTML ล็อกอิน กรุณาตั้งค่า GAS Web App Access เป็น Anyone');
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('รูปแบบข้อมูล JSON จากเซิร์ฟเวอร์ไม่ถูกต้อง');
    }

    if (json.success === false) {
      const errMsg = json.error?.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์';
      throw new Error(errMsg);
    }

    return json.data !== undefined ? json.data : json;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('การเชื่อมต่อหมดเวลา (Timeout) กรุณาลองใหม่อีกครั้ง');
    }
    throw error;
  }
}

// ==========================================
// Global Application State
// ==========================================
let equipmentData = [];
let transactionData = [];
let adminUsersData = [];
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

let signatureCanvas = null;
let signatureCtx = null;
let isDrawingSignature = false;
let hasSignature = false;
let signatureModalTrigger = null;

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
  if (typeof dateInput === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(dateInput)) {
    const p = dateInput.split('/');
    if (p.length === 3) {
      const dd = String(p[0]).padStart(2, '0');
      const mm = String(p[1]).padStart(2, '0');
      return `${dd}/${mm}/${p[2]}`;
    }
    return dateInput;
  }
  let d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateInput)) {
      const parts = dateInput.split('T')[0].split('-');
      const day = String(parts[2]).padStart(2, '0');
      const month = String(parts[1]).padStart(2, '0');
      const year = parseInt(parts[0], 10) + 543;
      return `${day}/${month}/${year}`;
    }
    return String(dateInput);
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

function handleEquipmentImageError(img) {
  if (!img) return;
  img.onerror = null;
  img.src = EQUIPMENT_IMAGE_FALLBACK;
}

// ==========================================
// Initialization & Navigation
// ==========================================
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
      setTimeout(() => {
        openBorrowModalSingle(equipId);
      }, 800);
    }
  }
});

function toggleMobileMenu() {
  const nav = document.getElementById('desktop-nav');
  if (nav) nav.classList.toggle('mobile-menu-open');
}

function switchTab(tabName) {
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
  const spinner = document.getElementById('loading-spinner');
  if (spinner) spinner.style.display = 'flex';

  try {
    const res = await apiRequest('getData');
    if (spinner) spinner.style.display = 'none';

    if (res && res.status === 'success') {
      equipmentData = res.equipment || [];
      transactionData = res.transactions || [];
      updateDashboardStats();
      renderCategoryFilters();
      filterEquipment();
      document.getElementById('borrow-section')?.classList.remove('hidden-section');
    } else {
      throw new Error(res.message || 'ไม่สามารถโหลดข้อมูลได้');
    }
  } catch (err) {
    if (spinner) spinner.style.display = 'none';
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: err.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้'
    });
  }
}

function updateDashboardStats() {
  const total = equipmentData.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const available = equipmentData.reduce((sum, item) => sum + (Number(item.available) || 0), 0);
  const borrowed = total - available;

  const todayStr = formatThaiDate(new Date());
  const todayCount = transactionData.filter(t => t.dateBorrow === todayStr).length;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-available').textContent = available;
  document.getElementById('stat-borrowed').textContent = borrowed;
  document.getElementById('stat-today').textContent = todayCount;
}

function getCategoryLabel(cat) {
  const categoryLabels = {
    audiovisual: 'โสตทัศนูปกรณ์ & คอมพิวเตอร์',
    kitchen: 'ห้องครัว & ประกอบอาหาร',
    general: 'ทั่วไป'
  };
  return categoryLabels[cat] || cat || 'ทั่วไป';
}

function renderCategoryFilters() {
  const container = document.getElementById('category-filter-container');
  if (!container) return;

  const categories = [
    { id: 'all', label: 'ทั้งหมด', icon: 'fa-list' },
    { id: 'audiovisual', label: 'โสตทัศนูปกรณ์ & คอมพิวเตอร์', icon: 'fa-laptop' },
    { id: 'kitchen', label: 'ห้องครัว & ประกอบอาหาร', icon: 'fa-utensils' },
    { id: 'general', label: 'ทั่วไป', icon: 'fa-boxes-stacked' }
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

function formatImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const url = rawUrl.trim();
  if (!url) return '';
  if (url.startsWith('data:image')) return url;

  // Convert Google Drive view/share URLs to direct thumbnail URLs
  const driveMatch = url.match(/(?:file\/d\/|id=|\/d\/)([a-zA-Z0-9_-]{25,})/);
  if (driveMatch && driveMatch[1]) {
    return `https://drive.google.com/thumbnail?id=${driveMatch[1]}&sz=w800`;
  }
  return url;
}

function getSampleEquipmentImage(item) {
  if (!item) return '';
  const formatted1 = formatImageUrl(item.image1);
  if (formatted1 && formatted1.length > 5 && !formatted1.includes('fallbackSvg')) return formatted1;

  const name = (item.name || '').toLowerCase();
  const cat = (item.category || '').toLowerCase();

  if (name.includes('ฟอกอากาศ') || name.includes('air purifier')) {
    return 'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('แม็ค') || name.includes('macbook') || name.includes('mac')) {
    return 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('ตั้งโต๊ะ') || name.includes('pc') || name.includes('ชุดคอมพิวเตอร์')) {
    return 'https://images.unsplash.com/photo-1587831990711-23ca6441447b?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('โน้ตบุ๊ก') || name.includes('notebook') || name.includes('laptop') || name.includes('lenovo')) {
    return 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('กล้อง') || name.includes('cannon') || name.includes('canon') || name.includes('camera')) {
    return 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('โปรเจคเตอร์') || name.includes('projector')) {
    return 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('เลเซอร์') || name.includes('kress') || name.includes('วัดระดับ')) {
    return 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('หม้อ') || name.includes('ต้ม')) {
    return 'https://images.unsplash.com/photo-1584992236310-6edddc08acff?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('กระทะก้นลึก')) {
    return 'https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('กระทะ') || name.includes('สแตนเลส')) {
    return 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('กระบวย')) {
    return 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('ตะหลิว')) {
    return 'https://images.unsplash.com/photo-1584269600464-37b1b58a9fe7?w=800&auto=format&fit=contain&q=80';
  }
  if (name.includes('ทัพพี')) {
    return 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800&auto=format&fit=contain&q=80';
  }

  if (cat === 'audiovisual') {
    return 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&auto=format&fit=contain&q=80';
  }
  if (cat === 'kitchen') {
    return 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800&auto=format&fit=contain&q=80';
  }
  return 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=800&auto=format&fit=contain&q=80';
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

  grid.innerHTML = pageItems.map(item => {
    const available = Number(item.available) || 0;
    const total = Number(item.total) || 0;
    const isAvailable = available > 0;
    const isCartAdded = cart.some(c => c.id === item.id);

    const catLabel = getCategoryLabel(item.category);
    const imgUrl = getSampleEquipmentImage(item) || EQUIPMENT_IMAGE_FALLBACK;

    return `
      <div class="equipment-card">
        <div class="image-gallery" data-src="${escapeHtml(imgUrl)}" data-equip-name="${escapeHtml(item.name)}" data-equip-id="${escapeHtml(item.id)}" onclick="openEquipmentImageFromGallery(this)" role="button" tabindex="0" aria-label="ดูภาพอุปกรณ์ขนาดเต็ม: ${escapeHtml(item.name)}" title="ดูภาพอุปกรณ์ขนาดเต็ม" onkeydown="handleEquipmentImageGalleryKeydown(event, this)">
          <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(item.name)}" class="equipment-image" loading="lazy" decoding="async" onerror="handleEquipmentImageError(this)">
          <div class="qr-badge" onclick="event.stopPropagation(); showQRCode('${escapeHtml(item.id)}', '${escapeHtml(item.name)}')" title="ดู QR Code" aria-label="ดู QR Code">
            <i class="fa-solid fa-qrcode" aria-hidden="true"></i>
          </div>
        </div>
        <div class="p-5 equipment-card-content">
          <div class="flex items-center justify-between mb-2">
            <span class="category-badge">${escapeHtml(catLabel)}</span>
            <span class="text-xs font-mono font-bold text-sky-800 bg-sky-50 px-2 py-1 rounded-md border border-sky-200">${escapeHtml(item.id)}</span>
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
            <button onclick="addToCart('${escapeHtml(item.id)}')" ${!isAvailable ? 'disabled' : ''} class="flex-1 ${isCartAdded ? 'bg-amber-500 text-white' : 'btn-olive'} py-2.5 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2">
              <i class="fa-solid ${isCartAdded ? 'fa-check' : 'fa-cart-plus'}"></i>
              ${isCartAdded ? 'ในตะกร้า' : 'ใส่ตะกร้า'}
            </button>
            <button onclick="openBorrowModalSingle('${escapeHtml(item.id)}')" ${!isAvailable ? 'disabled' : ''} class="btn-success py-2.5 px-4 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2">
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
  const equipName = String(el?.dataset?.equipName || '').trim();
  const equipId = String(el?.dataset?.equipId || '').trim();
  if (url) zoomImage(url, equipName, equipId);
}

function handleEquipmentImageGalleryKeydown(event, el) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openEquipmentImageFromGallery(el);
  }
}

function buildEquipmentImageLabel(equipName, equipId) {
  const name = String(equipName || '').trim();
  const id = String(equipId || '').trim();
  if (name && id) return `${name} (${id})`;
  return name || id || 'ภาพอุปกรณ์';
}

function zoomImage(url, equipName, equipId) {
  const modal = document.getElementById('image-zoom-modal');
  const img = document.getElementById('zoomed-image');
  const caption = document.getElementById('imageZoomCaption');
  if (!modal || !img) return;

  const label = buildEquipmentImageLabel(equipName, equipId);
  img.src = url;
  img.alt = label;
  if (caption) caption.textContent = label;
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
  modal?.classList.remove('show');
  if (img) {
    img.src = '';
    img.alt = '';
  }
  if (caption) caption.textContent = '';
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
  const target = img || canvas || table;
  if (!target) return;

  if (canvas && img) {
    canvas.classList.add('is-qr-hidden');
    canvas.style.display = 'none';
  }

  target.style.width = `${size}px`;
  target.style.height = `${size}px`;
  target.style.aspectRatio = '1 / 1';
  target.style.objectFit = 'contain';
  target.style.display = 'block';
  target.style.margin = '0';
  if (target.tagName === 'CANVAS' || target.tagName === 'IMG') {
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
    cart.push({ id: item.id, name: item.name, image: getSampleEquipmentImage(item), qty: 1, maxQty: available });
  }

  updateCartBadge();
  renderCart();
  renderEquipmentGrid();
  Swal.fire({ icon: 'success', title: 'เพิ่มลงตะกร้าเรียบร้อย', timer: 1000, showConfirmButton: false });
}

function updateCartBadge() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  const badge = document.getElementById('cartBadge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
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

  function resizeCanvas() {
    const rect = signatureCanvas.getBoundingClientRect();
    signatureCanvas.width = rect.width || 400;
    signatureCanvas.height = 160;
    clearSignature();
  }
  resizeCanvas();

  function getPos(e) {
    const rect = signatureCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function startDrawing(e) {
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
  if (returnInput && typeof flatpickr !== 'undefined') {
    flatpickr(returnInput, {
      locale: 'th',
      dateFormat: 'Y-m-d',
      minDate: 'today'
    });
  }
}

function openBorrowModalSingle(equipId) {
  const item = equipmentData.find(e => e.id === equipId);
  if (!item) return;
  cart = [{ id: item.id, name: item.name, image: item.image1 || '', qty: 1, maxQty: Number(item.available) || 1 }];
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
  clearSignature();
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

  const payload = {
    borrowerName: form.borrowerName.value,
    email: form.email.value,
    phone: form.phone.value,
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
      closeModal();
      clearCart();
      Swal.fire({
        icon: 'success',
        title: 'ยื่นคำขอยืมสำเร็จ',
        text: 'ระบบได้ส่งคำขอยืมของท่านเรียบร้อยแล้ว รอการอนุมัติจากผู้ดูแล'
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
function persistAdminSession(user) {
  try {
    localStorage.setItem(ADMIN_SESSION_EXPIRY_KEY, String(Date.now() + ADMIN_SESSION_MS));
    if (user) localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(user));
  } catch (e) { /* ignore quota/private mode */ }
}

function clearAdminSessionStorage() {
  try {
    localStorage.removeItem(ADMIN_SESSION_EXPIRY_KEY);
    localStorage.removeItem(ADMIN_USER_KEY);
  } catch (e) { /* ignore */ }
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
  } catch (e) {
    return;
  }
  if (!sessionExpiry) return;

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
  clearAdminSessionStorage();
  isAdminMode = false;
  currentUser = null;

  if (wasAdmin || adminVisible) {
    document.getElementById('admin-sidebar-overlay')?.classList.add('hidden');
    document.getElementById('admin-sidebar')?.classList.remove('show-mobile');
    switchTab('borrow');
    Swal.fire({
      icon: 'warning',
      title: 'หมดเวลาการใช้งาน',
      text: 'เซสชันการใช้งานผู้ดูแลระบบหมดอายุแล้ว (6 ชั่วโมง) กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
      confirmButtonText: 'ตกลง',
      confirmButtonColor: '#0284c7'
    });
  }
}

function openAdminLoginModal() {
  Swal.fire({
    title: '<i class="fas fa-lock text-sky-700 mr-2"></i>เข้าสู่ระบบผู้ดูแลระบบ',
    html: `
      <div class="text-left space-y-4 pt-2">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">ไอดีผู้ใช้ (UserID)</label>
          <input type="text" id="swal-admin-id" class="swal2-input" style="width: 100%; margin: 0;" placeholder="กรอก UserID">
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">รหัสผ่าน (PIN)</label>
          <input type="password" id="swal-admin-pin" class="swal2-input" style="width: 100%; margin: 0;" placeholder="กรอกรหัสผ่าน">
        </div>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'เข้าสู่ระบบ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#0284c7',
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
    if (!result.isConfirmed || !result.value) return;
    try {
      Swal.showLoading();
      const res = await apiRequest('verifyAdminPin', result.value);
      if (res && res.success) {
        applyAdminSessionUser(res.user);
        persistAdminSession(res.user);

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

function confirmLogoutAdmin() {
  closeLogoutConfirmModal();
  clearAdminSessionStorage();
  isAdminMode = false;
  currentUser = null;
  switchTab('borrow');
  Swal.fire({ icon: 'success', title: 'ออกจากระบบแล้ว', timer: 1200, showConfirmButton: false });
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
  const todayStr = formatThaiDate(new Date());
  const todayCount = transactionData.filter(t => t.dateBorrow === todayStr).length;

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
    <table class="w-full text-sm text-left">
      <thead class="bg-gray-100 text-gray-700">
        <tr>
          <th class="p-3">รหัส</th>
          <th class="p-3">ผู้ยืม</th>
          <th class="p-3">อุปกรณ์</th>
          <th class="p-3">สถานะ</th>
        </tr>
      </thead>
      <tbody>
        ${recent.map(t => `
          <tr class="border-b">
            <td class="p-3 font-mono font-semibold">${escapeHtml(t.transId)}</td>
            <td class="p-3">${escapeHtml(t.borrowerName)}</td>
            <td class="p-3">${escapeHtml(t.equipName)}</td>
            <td class="p-3"><span class="status-badge ${t.status === 'กำลังยืม' ? 'status-borrowed' : t.status === 'คืนแล้ว' ? 'status-returned' : 'status-pending'}">${escapeHtml(t.status)}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
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
        <button onclick="openEquipModal('edit', '${escapeHtml(item.id)}')" class="btn-action-edit mr-2">
          <i class="fa-solid fa-pen-to-square"></i> แก้ไข
        </button>
        <button onclick="deleteEquipmentConfirm('${escapeHtml(item.id)}')" class="btn-action-delete">
          <i class="fa-solid fa-trash-can"></i> ลบ
        </button>
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

function renderAdminTransactionsTable() {
  const tbody = document.getElementById('admin-trans-tbody');
  const search = (document.getElementById('admin-trans-search')?.value || '').toLowerCase().trim();
  const showAll = document.getElementById('admin-show-all')?.checked;

  if (!tbody) return;

  const filtered = transactionData.filter(t => {
    const matchSearch = !search ||
      (t.borrowerName || '').toLowerCase().includes(search) ||
      (t.equipName || '').toLowerCase().includes(search) ||
      (t.transId || '').toLowerCase().includes(search);
    const matchStatus = showAll || t.status === 'รออนุมัติ' || t.status === 'กำลังยืม';
    return matchSearch && matchStatus;
  });

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  const startIndex = (adminTransCurrentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  tbody.innerHTML = pageItems.map(t => {
    const sigCell = t.signatureUrl
      ? `<button type="button" class="signature-button" data-trans-id="${escapeHtml(t.transId)}" data-borrower="${escapeHtml(t.borrowerName)}" data-date="${escapeHtml(t.dateBorrow)}" data-sig-url="${escapeHtml(t.signatureUrl)}" onclick="showSignatureModalFromData(this)" aria-label="ดูภาพลายเซ็น"><img class="signature" src="${escapeHtml(t.signatureUrl)}" alt="ลายเซ็น"></button>`
      : '-';

    let actionBtns = '';
    if (t.status === 'รออนุมัติ') {
      actionBtns = `
        <button onclick="approveBorrowConfirm('${t.transId}')" class="btn-approve mr-1"><i class="fas fa-check"></i> อนุมัติ</button>
        <button onclick="rejectBorrowConfirm('${t.transId}')" class="btn-reject"><i class="fas fa-times"></i> ปฏิเสธ</button>`;
    } else if (t.status === 'กำลังยืม') {
      actionBtns = `
        <button onclick="returnEquipmentConfirm('${t.transId}', '${t.equipId}', ${t.qty})" class="btn-approve"><i class="fas fa-undo"></i> คืนอุปกรณ์</button>`;
    } else {
      actionBtns = `<span class="text-xs text-gray-400">เสร็จสิ้น</span>`;
    }

    return `
      <tr class="table-row">
        <td class="px-6 py-4">
          <p class="font-bold text-gray-800">${escapeHtml(t.borrowerName)}</p>
          <p class="text-xs text-gray-500">${escapeHtml(t.email)}</p>
        </td>
        <td class="px-6 py-4 font-semibold text-gray-800">${escapeHtml(t.equipName)}</td>
        <td class="px-6 py-4 text-center font-bold">${t.qty}</td>
        <td class="px-6 py-4">${escapeHtml(t.dateBorrow)}</td>
        <td class="px-6 py-4">${escapeHtml(t.dateReturn)}</td>
        <td class="px-6 py-4 text-center">${sigCell}</td>
        <td class="px-6 py-4"><span class="status-badge ${t.status === 'กำลังยืม' ? 'status-borrowed' : t.status === 'คืนแล้ว' ? 'status-returned' : t.status === 'รออนุมัติ' ? 'status-pending' : 'status-rejected'}">${escapeHtml(t.status)}</span></td>
        <td class="px-6 py-4 text-center">${actionBtns}</td>
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
  const result = await Swal.fire({
    title: 'ยืนยันการอนุมัติ?',
    text: `ต้องการอนุมัติคำขอยืมรหัส ${transId} หรือไม่`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'อนุมัติ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#059669'
  });

  if (result.isConfirmed) {
    try {
      Swal.showLoading();
      await apiRequest('approveBorrowRequest', { transId });
      Swal.fire({ icon: 'success', title: 'อนุมัติเรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadData();
    } catch (err) {
      Swal.fire('อนุมัติไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการอนุมัติ', 'error');
    }
  }
}

async function rejectBorrowConfirm(transId) {
  const { value: reason } = await Swal.fire({
    title: 'ปฏิเสธคำขอยืม',
    input: 'text',
    inputLabel: 'เหตุผลการไม่อนุมัติ',
    inputPlaceholder: 'กรอกเหตุผล...',
    showCancelButton: true,
    confirmButtonText: 'ยืนยันปฏิเสธ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626'
  });

  if (reason !== undefined) {
    try {
      Swal.showLoading();
      await apiRequest('rejectBorrowRequest', { transId, reason });
      Swal.fire({ icon: 'success', title: 'ปฏิเสธคำขอเรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadData();
    } catch (err) {
      Swal.fire('ทำรายการไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการปฏิเสธ', 'error');
    }
  }
}

async function returnEquipmentConfirm(transId, equipId, qty) {
  const result = await Swal.fire({
    title: 'ยืนยันการคืนอุปกรณ์?',
    text: `รับคืนอุปกรณ์สำหรับธุรกรรม ${transId}`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'รับคืน',
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
function openEquipModal(action, equipId = null) {
  const modal = document.getElementById('equipModal');
  const form = document.getElementById('equipForm');
  const title = document.getElementById('equipModalTitle');
  document.getElementById('manageAction').value = action;

  if (!modal || !form) return;

  form.reset();
  document.getElementById('preview1Container')?.classList.add('hidden');
  document.getElementById('preview2Container')?.classList.add('hidden');

  if (action === 'edit' && equipId) {
    const item = equipmentData.find(e => e.id === equipId);
    if (!item) return;
    title.innerHTML = `<i class="fa-solid fa-edit mr-2"></i>แก้ไขอุปกรณ์ (${item.id})`;
    document.getElementById('manageId').value = item.id;
    document.getElementById('manageId').readOnly = true;
    document.getElementById('manageName').value = item.name;
    document.getElementById('manageCategory').value = item.category || 'general';
    document.getElementById('manageDescription').value = item.description || '';
    document.getElementById('manageLocation').value = item.location || '';
    document.getElementById('manageTotal').value = item.total;
    document.getElementById('manageAvailable').value = item.available;

    const sampleImg = getSampleEquipmentImage(item);
    const img1Src = item.image1 || sampleImg;
    if (img1Src) {
      const p1 = document.getElementById('preview1');
      if (p1) { p1.src = img1Src; document.getElementById('preview1Container').classList.remove('hidden'); }
      document.getElementById('image1Url').value = item.image1 || '';
    }
    if (item.image2) {
      const p2 = document.getElementById('preview2');
      if (p2) { p2.src = item.image2; document.getElementById('preview2Container').classList.remove('hidden'); }
      document.getElementById('image2Url').value = item.image2 || '';
    }
  } else {
    title.innerHTML = `<i class="fa-solid fa-plus mr-2"></i>เพิ่มอุปกรณ์ใหม่`;
    document.getElementById('manageId').readOnly = false;
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

function previewImage(input, previewId) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = document.getElementById(previewId);
      const container = document.getElementById(`${previewId}Container`);
      if (img && container) {
        img.src = e.target.result;
        container.classList.remove('hidden');
      }
    };
    reader.readAsDataURL(input.files[0]);
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
  if (fileInput) fileInput.value = '';
  if (hiddenUrl) hiddenUrl.value = '';
}

async function handleEquipSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const action = document.getElementById('manageAction').value;

  let locationVal = form.location.value;
  if (locationVal === '__OTHER__') {
    locationVal = (form.locationOther.value || '').trim();
  }

  const p1Img = document.getElementById('preview1')?.src || '';
  const p2Img = document.getElementById('preview2')?.src || '';

  const payload = {
    action: action,
    id: form.id.value.trim(),
    name: form.name.value.trim(),
    category: form.category.value,
    description: form.description.value.trim(),
    location: locationVal,
    total: Number(form.total.value),
    available: Number(form.available.value),
    image1: p1Img.startsWith('data:image') ? p1Img : form.image1Url.value,
    image2: p2Img.startsWith('data:image') ? p2Img : form.image2Url.value
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
async function loadAdminUsersData() {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;

  try {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>กำลังโหลดข้อมูล...</td></tr>';
    const res = await apiRequest('getUsers');
    adminUsersData = res.users || [];
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

  tbody.innerHTML = filtered.map(u => `
    <tr class="table-row">
      <td class="px-6 py-4 font-mono font-bold text-sky-800">${escapeHtml(u.userId)}</td>
      <td class="px-6 py-4 font-semibold text-gray-800">${escapeHtml(u.name)}</td>
      <td class="px-6 py-4"><span class="px-3 py-1 rounded-full text-xs font-bold ${u.role === 'Super Admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}">${escapeHtml(u.role)}</span></td>
      <td class="px-6 py-4 text-gray-500">${escapeHtml(u.createdAt || '-')}</td>
      <td class="px-6 py-4 text-center">
        <button onclick="editUserRoleHandler('${escapeHtml(u.userId)}')" class="btn-action-edit mr-2">
          <i class="fa-solid fa-user-pen"></i> สิทธิ์
        </button>
        <button onclick="deleteUserHandler('${escapeHtml(u.userId)}')" class="btn-action-delete">
          <i class="fa-solid fa-user-minus"></i> ลบ
        </button>
      </td>
    </tr>
  `).join('');
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
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">รหัสผ่าน (PIN)</label>
          <input type="password" id="swal-user-pin" class="swal2-input" style="width:100%;margin:0;" placeholder="ตั้งรหัสผ่าน">
        </div>
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
      loadAdminUsersData();
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
      loadAdminUsersData();
    } catch (err) {
      Swal.fire('อัปเดตไม่สำเร็จ', err.message || 'เกิดข้อผิดพลาดในการอัปเดตสิทธิ์', 'error');
    }
  });
}

async function deleteUserHandler(targetUserId) {
  const currentU = currentUser ? currentUser.userId : '';
  if (currentU && String(targetUserId).toLowerCase() === String(currentU).toLowerCase()) {
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
      await apiRequest('deleteUser', { targetUserId, currentUserId: currentU });
      Swal.fire({ icon: 'success', title: 'ลบผู้ใช้เรียบร้อยแล้ว', timer: 1200, showConfirmButton: false });
      loadAdminUsersData();
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
          <span class="text-gray-700 flex items-center gap-2"><i class="fas fa-check-circle text-emerald-500"></i> คืนแล้ว</span>
          <span class="text-emerald-700 font-bold">${returned} รายการ (${returnedPct}%)</span>
        </div>
        <div class="usage-progress-bar">
          <div class="usage-progress-fill bg-gradient-to-r from-emerald-500 to-teal-400" style="width: ${returnedPct}%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between items-center text-sm font-semibold mb-1.5">
          <span class="text-gray-700 flex items-center gap-2"><i class="fas fa-hourglass-half text-amber-500"></i> กำลังยืม</span>
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
          <div class="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition border border-transparent hover:border-slate-100">
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
  const ctx = document.getElementById('borrowChart')?.getContext('2d');
  if (!ctx) return;

  if (borrowChart) borrowChart.destroy();

  const days = [];
  const counts = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = formatThaiDate(d);
    days.push(dateStr);
    counts.push(transactionData.filter(t => t.dateBorrow === dateStr).length);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, 240);
  gradient.addColorStop(0, 'rgba(2, 132, 199, 0.35)');
  gradient.addColorStop(1, 'rgba(2, 132, 199, 0.0)');

  borrowChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: days,
      datasets: [{
        label: 'จำนวนการยืม (รายการ)',
        data: counts,
        borderColor: '#0284c7',
        borderWidth: 3,
        pointBackgroundColor: '#ffffff',
        pointBorderColor: '#0284c7',
        pointBorderWidth: 3,
        pointRadius: 5,
        pointHoverRadius: 7,
        backgroundColor: gradient,
        fill: true,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
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
async function openReportView(reportType = 'all') {
  const mainApp = document.getElementById('mainAppContainer');
  const reportView = document.getElementById('reportViewContainer');
  const reportContent = document.getElementById('reportContent');

  if (mainApp) mainApp.classList.add('hidden-section');
  if (reportView) reportView.classList.remove('hidden-section');
  if (reportContent) reportContent.innerHTML = '<div class="empty">กำลังโหลดข้อมูลรายงาน...</div>';

  try {
    const reportData = await apiRequest('getReportData', { reportType });
    renderReportContent(reportData);
  } catch (err) {
    if (reportContent) {
      reportContent.innerHTML = `<div class="error">ไม่สามารถดึงข้อมูลรายงานได้: ${escapeHtml(err.message)}</div>`;
    }
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
