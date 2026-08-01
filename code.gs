const SHEET_ID = '1RKs6zj-_wAlv7t6LKgNA9CwuevHkbHOaarRbzuHyUBg';
const SHEET_EQUIPMENT = 'Equipment';
const SHEET_TRANSACTIONS = 'Transactions';
const SHEET_CONTACT = 'Contact';
const SHEET_USERS = 'Users';
const EQUIPMENT_CATEGORIES = ['audiovisual', 'kitchen', 'general'];
const LEGACY_EQUIPMENT_CATEGORY_MAP = {
  audiovisual: 'audiovisual',
  Projector: 'audiovisual',
  Camera: 'audiovisual',
  Microphone: 'audiovisual',
  Speaker: 'audiovisual',
  Computer: 'audiovisual',
  audiovisualOther: 'audiovisual',
  kitchen: 'kitchen',
  'ภาชนะขนาดใหญ่': 'kitchen',
  'อุปกรณ์เตรียมวัตถุดิบ': 'kitchen',
  'อุปกรณ์ตักอาหาร': 'kitchen',
  'ถาดและภาชนะจัดเสิร์ฟ': 'kitchen',
  general: 'general',
  Other: 'general',
  General: 'general'
};
const IMAGE_FOLDER_ID = '1O-7Z0PNoCMz7OPi9c35gPCN3S1mV-0G-';
const TELEGRAM_BOT_TOKEN = '8657585379:AAFTkj81WMXpqCTcHTRnJly49RKybsLvrTE';
const TELEGRAM_CHAT_ID = '-5183472427';

// ==========================================
// API Router & Response Wrappers
// ==========================================
function createJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function createErrorResponse(code, safeMessage) {
  return createJsonResponse({
    success: false,
    error: {
      code: code || 'INTERNAL_ERROR',
      message: safeMessage || 'เกิดข้อผิดพลาดในการประมวลผล'
    }
  });
}

function parseRequestData(e) {
  let action = '';
  let payload = {};

  if (e && e.parameter && e.parameter.action) {
    action = e.parameter.action;
  }
  if (e && e.parameter && e.parameter.payload) {
    try {
      payload = JSON.parse(e.parameter.payload);
    } catch (err) {
      payload = {};
    }
  }

  if (e && e.postData && e.postData.contents) {
    try {
      const parsed = JSON.parse(e.postData.contents);
      if (parsed.action) action = parsed.action;
      if (parsed.payload !== undefined) payload = parsed.payload;
    } catch (err) {
      // Fallback if form encoded
      if (e.parameter) {
        if (e.parameter.action) action = e.parameter.action;
      }
    }
  }

  return { action: String(action || '').trim(), payload: payload || {} };
}

const ACTION_ALLOWLIST = {
  // Read Operations (GET/POST)
  getData: { method: 'GET', handler: handleGetData },
  getUsers: { method: 'GET', handler: handleGetUsers },
  getLogoUrl: { method: 'GET', handler: handleGetLogoUrl },
  getReportData: { method: 'GET', handler: handleGetReportData },

  // Write / Sensitive Operations (POST)
  verifyAdminPin: { method: 'POST', handler: handleVerifyAdminPin },
  saveUser: { method: 'POST', handler: handleSaveUser },
  updateUser: { method: 'POST', handler: handleUpdateUser },
  deleteUser: { method: 'POST', handler: handleDeleteUser },
  saveBorrowRequest: { method: 'POST', handler: handleSaveBorrowRequest },
  returnEquipment: { method: 'POST', handler: handleReturnEquipment },
  approveBorrowRequest: { method: 'POST', handler: handleApproveBorrowRequest },
  rejectBorrowRequest: { method: 'POST', handler: handleRejectBorrowRequest },
  saveEquipment: { method: 'POST', handler: handleSaveEquipment },
  deleteEquipment: { method: 'POST', handler: handleDeleteEquipment },
  saveContactForm: { method: 'POST', handler: handleSaveContactForm }
};

function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    if (params.view === 'report') {
      const type = params.type || 'all';
      const reportRes = getReportData(type);
      return createJsonResponse({ success: true, data: reportRes });
    }

    if (!params.action) {
      return serveFrontend();
    }

    const req = parseRequestData(e);
    const actionKey = req.action;
    const route = ACTION_ALLOWLIST[actionKey];

    if (!route) {
      return createErrorResponse('INVALID_ACTION', 'ไม่พบ Action ที่ร้องขอ');
    }

    return route.handler(req.payload);
  } catch (err) {
    return createErrorResponse('SERVER_ERROR', 'เกิดข้อผิดพลาดภายในระบบ');
  }
}

function serveFrontend() {
  const apiUrl = getCleanWebAppUrl();
  let html = HtmlService.createTemplateFromFile('index').getRawContent();
  const css = HtmlService.createTemplateFromFile('style.css').getRawContent();
  const js = HtmlService.createTemplateFromFile('app.js').getRawContent();
  const configScript =
    '<script>window.APP_CONFIG=window.APP_CONFIG||{};window.APP_CONFIG.apiUrl=' +
    JSON.stringify(apiUrl) +
    ';</script>';

  html = html
    .replace('<link rel="stylesheet" href="./style.css">', '<style>' + css + '</style>')
    .replace(/<script>\s*window\.APP_CONFIG[\s\S]*?<\/script>/, configScript)
    .replace('<script src="./app.js" defer></script>', '<script>' + js + '</script>');

  return HtmlService.createHtmlOutput(html)
    .setTitle('ระบบยืม-คืนอุปกรณ์')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    const req = parseRequestData(e);
    const actionKey = req.action;
    const route = ACTION_ALLOWLIST[actionKey];

    if (!route) {
      return createErrorResponse('INVALID_ACTION', 'ไม่พบ Action ที่ร้องขอ');
    }

    return route.handler(req.payload);
  } catch (err) {
    return createErrorResponse('SERVER_ERROR', 'เกิดข้อผิดพลาดภายในระบบ');
  }
}

// ==========================================
// Action Handlers with Input Validation & Error Sanitization
// ==========================================
function handleGetData() {
  const result = getData();
  if (result.status === 'error') {
    return createErrorResponse('DATA_ERROR', 'ไม่สามารถโหลดข้อมูลระบบได้');
  }
  return createJsonResponse({ success: true, data: result });
}

function handleVerifyAdminPin(payload) {
  const inputId = payload ? payload.inputId : '';
  const inputPin = payload ? payload.inputPin : '';
  const res = verifyAdminPin(inputId, inputPin);
  return createJsonResponse({ success: res.success, data: res });
}

function handleGetUsers() {
  const res = getUsers();
  if (res.status === 'error') {
    return createErrorResponse('USER_ERROR', 'ไม่สามารถอ่านข้อมูลผู้ใช้ได้');
  }
  return createJsonResponse({ success: true, data: res });
}

function handleSaveUser(payload) {
  try {
    const res = saveUser(payload);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('SAVE_USER_ERROR', err.message || 'ไม่สามารถบันทึกข้อมูลผู้ใช้ได้');
  }
}

function handleUpdateUser(payload) {
  try {
    const res = updateUser(payload);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('UPDATE_USER_ERROR', err.message || 'ไม่สามารถแก้ไขข้อมูลผู้ใช้ได้');
  }
}

function handleDeleteUser(payload) {
  try {
    const targetUserId = payload ? payload.targetUserId : '';
    const currentUserId = payload ? payload.currentUserId : '';
    const res = deleteUser(targetUserId, currentUserId);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('DELETE_USER_ERROR', err.message || 'ไม่สามารถลบผู้ใช้ได้');
  }
}

function handleSaveBorrowRequest(payload) {
  try {
    const res = saveBorrowRequest(payload);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('BORROW_ERROR', err.message || 'ไม่สามารถบันทึกการยืมได้');
  }
}

function handleReturnEquipment(payload) {
  try {
    const transId = payload ? payload.transId : '';
    const equipId = payload ? payload.equipId : '';
    const qty = payload ? payload.qty : 1;
    const res = returnEquipment(transId, equipId, qty);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('RETURN_ERROR', err.message || 'ไม่สามารถคืนอุปกรณ์ได้');
  }
}

function handleApproveBorrowRequest(payload) {
  try {
    const transId = payload ? payload.transId : '';
    const res = approveBorrowRequest(transId);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('APPROVE_ERROR', err.message || 'ไม่สามารถอนุมัติรายการได้');
  }
}

function handleRejectBorrowRequest(payload) {
  try {
    const transId = payload ? payload.transId : '';
    const reason = payload ? payload.reason : '';
    const res = rejectBorrowRequest(transId, reason);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('REJECT_ERROR', err.message || 'ไม่สามารถปฏิเสธรายการได้');
  }
}

function handleSaveEquipment(payload) {
  try {
    const res = saveEquipment(payload);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('EQUIPMENT_SAVE_ERROR', err.message || 'ไม่สามารถบันทึกข้อมูลอุปกรณ์ได้');
  }
}

function handleDeleteEquipment(payload) {
  try {
    const id = payload ? payload.id : '';
    const res = deleteEquipment(id);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('EQUIPMENT_DELETE_ERROR', err.message || 'ไม่สามารถลบอุปกรณ์ได้');
  }
}

function handleSaveContactForm(payload) {
  try {
    const res = saveContactForm(payload);
    return createJsonResponse({ success: true, data: res });
  } catch (err) {
    return createErrorResponse('CONTACT_ERROR', err.message || 'ไม่สามารถบันทึกข้อความติดต่อได้');
  }
}

function handleGetLogoUrl() {
  const url = getLogoUrl();
  return createJsonResponse({ success: true, data: url });
}

function handleGetReportData(payload) {
  const reportType = payload ? payload.reportType || payload.type : 'all';
  const res = getReportData(reportType);
  return createJsonResponse({ success: true, data: res });
}

// ==========================================
// Core Business Logic Functions
// ==========================================
function normalizeAdminPin(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFKC')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function verifyAdminPin(inputId, inputPin) {
  const normalizedId = String(inputId || '').trim();
  const normalizedPin = String(inputPin || '').trim();

  if (!normalizedId) return { success: false, message: 'กรุณากรอกไอดีผู้ใช้' };
  if (!normalizedPin) return { success: false, message: 'กรุณากรอกรหัสผ่าน' };

  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const userSheet = ss.getSheetByName(SHEET_USERS);
    if (userSheet && userSheet.getLastRow() > 1) {
      // Use getDisplayValues() to get exact formatted strings (prevents numeric PIN type mismatch)
      const data = userSheet.getDataRange().getDisplayValues();
      for (let i = 1; i < data.length; i++) {
        const rowId = String(data[i][0] || '').trim();
        const rowPin = String(data[i][2] || '').trim();
        if (rowId && rowId.toLowerCase() === normalizedId.toLowerCase()) {
          if (rowPin === normalizedPin) {
            return {
              success: true,
              message: 'เข้าสู่ระบบสำเร็จ',
              user: {
                userId: data[i][0],
                name: data[i][1] || data[i][0],
                role: data[i][3] || 'Staff'
              }
            };
          } else {
            return { success: false, message: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง' };
          }
        }
      }
    }
  } catch (e) {
    Logger.log('Error reading Users sheet: ' + e.toString());
  }

  const props = PropertiesService.getScriptProperties();
  const storedIdRaw = props.getProperty('ADMIN_ID') || props.getProperty('ADMIN_USER');
  const storedPinRaw = props.getProperty('ADMIN_PIN');

  if (storedIdRaw && storedPinRaw) {
    const storedId = String(storedIdRaw).trim();
    const storedPin = String(storedPinRaw).trim();

    if (normalizedId.toLowerCase() === storedId.toLowerCase() && normalizedPin === storedPin) {
      return {
        success: true,
        message: 'เข้าสู่ระบบสำเร็จ',
        user: {
          userId: storedId,
          name: 'ผู้ดูแลระบบสูงสุด',
          role: 'Super Admin'
        }
      };
    }
  }

  // Fallback default admin if no users configured
  if (normalizedId.toLowerCase() === 'admin' && normalizedPin === '123456') {
    return {
      success: true,
      message: 'เข้าสู่ระบบสำเร็จ (Default Admin)',
      user: {
        userId: 'admin',
        name: 'ผู้ดูแลระบบ',
        role: 'Super Admin'
      }
    };
  }

  return { success: false, message: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง' };
}

function setupDatabase() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let equipSheet = ss.getSheetByName(SHEET_EQUIPMENT);
  if (!equipSheet) {
    equipSheet = ss.insertSheet(SHEET_EQUIPMENT);
    equipSheet.appendRow(['ID', 'Name', 'Total', 'Available', 'Location', 'Image1', 'Image2', 'Category', 'Description', 'QRCode']);
    equipSheet.appendRow(['E001', 'โปรเจคเตอร์ Epson', 5, 5, 'ห้องโสตฯ 1', '', '', 'audiovisual', 'โปรเจคเตอร์ความสว่าง 3000 lumens', '']);
    equipSheet.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#0284c7');
  }

  let transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
  if (!transSheet) {
    transSheet = ss.insertSheet(SHEET_TRANSACTIONS);
    transSheet.appendRow([
      'TransID', 'BorrowerName', 'Email', 'Phone', 'EquipID', 'EquipName',
      'Qty', 'DateBorrow', 'DateReturn', 'Reason', 'Status', 'ActualReturnDate',
      'EmailNotified', 'CreatedBy', 'Notes', 'ScanMethod', 'BorrowRoom', 'SignatureUrl'
    ]);
    transSheet.getRange(1, 1, 1, 18).setFontWeight('bold').setBackground('#0284c7');
  }

  let contactSheet = ss.getSheetByName(SHEET_CONTACT);
  if (!contactSheet) {
    contactSheet = ss.insertSheet(SHEET_CONTACT);
    contactSheet.appendRow(['Timestamp', 'Name', 'Email', 'Phone', 'Subject', 'Message', 'Status']);
    contactSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#4B5563');
  }

  let userSheet = ss.getSheetByName(SHEET_USERS);
  if (!userSheet) {
    userSheet = ss.insertSheet(SHEET_USERS);
    userSheet.appendRow(['UserID', 'Name', 'Pin', 'Role', 'CreatedAt']);
    userSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#0284c7');
  }
}

function formatDate(date) {
  if (!date) return '';
  let d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) {
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
      const parts = date.split('T')[0].split('-');
      const day = parseInt(parts[2], 10);
      const month = parseInt(parts[1], 10);
      const year = parseInt(parts[0], 10) + 543;
      return `${day}/${month}/${year}`;
    }
    return String(date);
  }
  const day = d.getDate();
  const month = d.getMonth() + 1;
  let year = d.getFullYear();
  if (year < 2400) year += 543;
  return `${day}/${month}/${year}`;
}

function formatThaiDate(dateInput, includeTime = false) {
  if (!dateInput) return '-';
  let d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateInput)) {
      const parts = dateInput.split('T')[0].split('-');
      const day = parseInt(parts[2], 10);
      const month = parseInt(parts[1], 10);
      const year = parseInt(parts[0], 10) + 543;
      return `${day}/${month}/${year}`;
    }
    return String(dateInput);
  }

  const day = d.getDate();
  const month = d.getMonth() + 1;
  let year = d.getFullYear();
  if (year < 2400) year += 543;

  if (includeTime) {
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes} น.`;
  }
  return `${day}/${month}/${year}`;
}

const PUBLIC_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzAJRYOIvx7x3Q-iMP2DF2sVHZ-y5lXw3u8XncxuGHQuXzJklrjG_eUQExCCETrn2cw/exec';

function getCleanWebAppUrl() {
  try {
    const url = ScriptApp.getService().getUrl();
    if (url && !url.includes('script.googleusercontent.com') && !url.includes('userCodeAppPanel')) {
      return url;
    }
  } catch (e) {}
  return PUBLIC_WEB_APP_URL;
}

function normalizeReportType(reportType) {
  return ['all', 'monthly', 'borrowing', 'daily', 'yearly'].includes(reportType) ? reportType : 'all';
}

function getReportUrl(reportType) {
  return `${getCleanWebAppUrl()}?view=report&type=${encodeURIComponent(normalizeReportType(reportType))}`;
}

function getReportData(reportType) {
  try {
    const type = normalizeReportType(reportType);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    const now = new Date();
    const transactions = [];

    if (transSheet && transSheet.getLastRow() > 1) {
      const data = transSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (!data[i][0] || !data[i][1] || !data[i][5]) continue;

        const borrowDate = data[i][7] instanceof Date ? data[i][7] : new Date(data[i][7]);
        const isCurrentMonth = !isNaN(borrowDate.getTime()) &&
          borrowDate.getMonth() === now.getMonth() &&
          borrowDate.getFullYear() === now.getFullYear();
        const isToday = !isNaN(borrowDate.getTime()) &&
          borrowDate.getDate() === now.getDate() &&
          borrowDate.getMonth() === now.getMonth() &&
          borrowDate.getFullYear() === now.getFullYear();
        const isCurrentYear = !isNaN(borrowDate.getTime()) &&
          borrowDate.getFullYear() === now.getFullYear();
        const isBorrowing = data[i][10] === 'กำลังยืม';

        if (type === 'monthly' && !isCurrentMonth) continue;
        if (type === 'daily' && !isToday) continue;
        if (type === 'yearly' && !isCurrentYear) continue;
        if (type === 'borrowing' && !isBorrowing) continue;

        transactions.push({
          transId: data[i][0],
          borrowerName: data[i][1],
          email: data[i][2],
          equipName: data[i][5],
          qty: data[i][6],
          dateBorrow: formatDate(data[i][7]),
          dateReturn: formatDate(data[i][8]),
          borrowRoom: data[i][16] || '',
          signatureUrl: data[i][17] || '',
          status: data[i][10]
        });
      }
      transactions.reverse();
    }

    const monthNames = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
    const reportTitles = {
      all: 'รายงานสรุปทั้งหมด',
      monthly: `รายงานประจำเดือน ${monthNames[now.getMonth()]} ${now.getFullYear() + 543}`,
      daily: `รายงานประจำวันที่ ${formatThaiDate(now)}`,
      yearly: `รายงานประจำปี ${now.getFullYear() + 543}`,
      borrowing: 'รายงานอุปกรณ์ที่กำลังถูกยืม'
    };

    return {
      status: 'success',
      title: reportTitles[type] || 'รายงานสรุประบบยืม-คืน',
      reportType: type,
      generatedAt: formatThaiDate(now, true),
      logoUrl: getLogoUrl(),
      transactions: transactions
    };
  } catch (e) {
    Logger.log('Error getting report data: ' + e.toString());
    return { status: 'error', message: 'ไม่สามารถสร้างรายงานได้' };
  }
}

function generateQRCode(equipId, equipName) {
  const webAppUrl = getCleanWebAppUrl();
  const borrowUrl = `${webAppUrl}?action=borrow&id=${encodeURIComponent(equipId)}`;
  return `https://chart.googleapis.com/chart?chs=300x300&cht=qr&chl=${encodeURIComponent(borrowUrl)}&choe=UTF-8`;
}

function uploadImageToDrive(base64Data, fileName) {
  try {
    if (!base64Data || !base64Data.startsWith('data:image')) {
      return base64Data;
    }

    const folder = DriveApp.getFolderById(IMAGE_FOLDER_ID);
    const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error('รูปแบบ base64 ไม่ถูกต้อง');

    const contentType = matches[1];
    const base64String = matches[2];

    const sizeInBytes = (base64String.length * 3) / 4;
    if (sizeInBytes > 5 * 1024 * 1024) {
      throw new Error('ไฟล์รูปภาพมีขนาดเกิน 5MB');
    }

    const decodedBytes = Utilities.base64Decode(base64String, Utilities.Charset.UTF_8);
    const blob = Utilities.newBlob(decodedBytes, contentType, fileName);

    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const fileId = file.getId();
    return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w800';
  } catch (e) {
    Logger.log('Error uploading image: ' + e.toString());
    throw new Error('ไม่สามารถอัพโหลดภาพได้: ' + e.message);
  }
}

function getData() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);

    const equipSheet = ss.getSheetByName(SHEET_EQUIPMENT);
    let equipment = [];
    if (equipSheet && equipSheet.getLastRow() > 1) {
      const data = equipSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (!data[i][0] || !data[i][1]) continue;
        const equipId = data[i][0];
        const equipName = data[i][1];
        let qrCode = data[i][9] || '';

        if (!qrCode) {
          qrCode = generateQRCode(equipId, equipName);
          equipSheet.getRange(i + 1, 10).setValue(qrCode);
        }

        equipment.push({
          id: data[i][0],
          name: data[i][1],
          total: data[i][2],
          available: data[i][3],
          location: data[i][4],
          image1: data[i][5] || '',
          image2: data[i][6] || '',
          category: data[i][7] || 'general',
          description: data[i][8] || '',
          qrCode: qrCode
        });
      }
    }

    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    let transactions = [];
    if (transSheet && transSheet.getLastRow() > 1) {
      const data = transSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (!data[i][0] || !data[i][1] || !data[i][5]) continue;
        transactions.push({
          transId: data[i][0],
          borrowerName: data[i][1],
          email: data[i][2],
          phone: data[i][3],
          equipId: data[i][4],
          equipName: data[i][5],
          qty: data[i][6],
          dateBorrow: formatDate(data[i][7]),
          dateReturn: formatDate(data[i][8]),
          reason: data[i][9],
          status: data[i][10],
          actualReturnDate: formatDate(data[i][11]),
          emailNotified: data[i][12] || false,
          createdBy: data[i][13] || '',
          notes: data[i][14] || '',
          scanMethod: data[i][15] || 'manual',
          borrowRoom: data[i][16] || '',
          signatureUrl: data[i][17] || ''
        });
      }
      transactions.reverse();
    }

    return {
      status: 'success',
      equipment: equipment,
      transactions: transactions
    };
  } catch (e) {
    return {
      status: 'error',
      message: e.toString(),
      equipment: [],
      transactions: []
    };
  }
}

function saveBorrowRequest(form) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const equipSheet = ss.getSheetByName(SHEET_EQUIPMENT);
    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);

    const transId = 'T-' + new Date().getTime();
    const today = new Date();
    const userEmail = Session.getActiveUser().getEmail() || 'System';
    const scanMethod = form.scanMethod || 'manual';

    if (!form || !form.borrowerName || !form.email || !form.phone) {
      throw new Error('ข้อมูลผู้ยืมไม่ครบถ้วน');
    }
    form.borrowRoom = String(form.borrowRoom || '').trim();
    if (!form.borrowRoom) {
      throw new Error('กรุณาเลือกห้องที่ใช้ยืมให้ถูกต้อง');
    }
    if (!form.signatureData || typeof form.signatureData !== 'string' || !form.signatureData.startsWith('data:image')) {
      throw new Error('กรุณาลงลายเซ็นก่อนยืนยันการยืม');
    }

    const signatureMatch = form.signatureData.match(/^data:([^;]+);base64,(.+)$/);
    if (!signatureMatch) throw new Error('กรุณาลงลายเซ็นก่อนยืนยันการยืม');
    const signatureBase64 = signatureMatch[2];
    const signatureSizeInBytes = (signatureBase64.length * 3) / 4;
    if (signatureSizeInBytes < 800) {
      throw new Error('กรุณาลงลายเซ็นก่อนยืนยันการยืม');
    }
    if (!Array.isArray(form.equipId) || !Array.isArray(form.equipName) || !Array.isArray(form.qty) || form.equipId.length === 0) {
      throw new Error('ไม่พบรายการอุปกรณ์ที่ยืม');
    }

    const equipData = equipSheet.getDataRange().getValues();
    const pendingRows = [];

    for (let i = 0; i < form.equipId.length; i++) {
      const equipId = form.equipId[i];
      const equipName = form.equipName[i];
      const qty = Number(form.qty[i]);
      let rowIndex = -1;
      let currentStock = 0;

      if (!qty || qty <= 0) throw new Error(`จำนวนยืมไม่ถูกต้อง: ${equipName}`);

      for (let j = 1; j < equipData.length; j++) {
        if (String(equipData[j][0]) === String(equipId)) {
          rowIndex = j + 1;
          currentStock = Number(equipData[j][3]);
          break;
        }
      }

      if (rowIndex === -1) throw new Error(`ไม่พบรหัสอุปกรณ์: ${equipId}`);
      if (currentStock < qty) throw new Error(`สินค้า ${equipName} หมด หรือไม่เพียงพอในขณะนี้`);

      pendingRows.push([
        transId,
        form.borrowerName,
        form.email,
        form.phone,
        equipId,
        equipName,
        qty,
        today,
        form.returnDate,
        form.reason,
        'รออนุมัติ',
        '',
        false,
        userEmail,
        '',
        scanMethod,
        form.borrowRoom,
        ''
      ]);
    }

    const signatureFileName = 'signature_' + transId + '_' + Date.now() + '.png';
    const signatureUrl = uploadImageToDrive(form.signatureData, signatureFileName);
    if (!signatureUrl) throw new Error('ไม่สามารถอัปโหลดลายเซ็นได้');

    for (let i = 0; i < pendingRows.length; i++) {
      pendingRows[i][17] = signatureUrl;
      transSheet.appendRow(pendingRows[i]);
    }

    sendBorrowConfirmationEmail(form, transId, form.equipName, today, form.returnDate, signatureUrl);
    sendBorrowTelegramNotification(form, transId);

    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function returnEquipment(transId, equipId, qty) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const equipSheet = ss.getSheetByName(SHEET_EQUIPMENT);
    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);

    const transData = transSheet.getDataRange().getValues();
    let foundTrans = false;
    let borrowerEmail = '';
    let equipName = '';

    for (let i = 1; i < transData.length; i++) {
      if (transData[i][0] == transId && transData[i][4] == equipId && transData[i][10] == 'กำลังยืม') {
        transSheet.getRange(i + 1, 11).setValue('คืนแล้ว');
        transSheet.getRange(i + 1, 12).setValue(new Date());
        borrowerEmail = transData[i][2];
        equipName = transData[i][5];
        foundTrans = true;
      }
    }

    if (!foundTrans) throw new Error("ไม่พบรายการยืม หรือถูกคืนไปแล้ว");

    const equipData = equipSheet.getDataRange().getValues();
    for (let i = 1; i < equipData.length; i++) {
      if (equipData[i][0] == equipId) {
        const currentStock = equipData[i][3];
        equipSheet.getRange(i + 1, 4).setValue(Number(currentStock) + Number(qty));
        break;
      }
    }

    sendReturnConfirmationEmail(borrowerEmail, equipName, qty);
    sendReturnTelegramNotification(transId, borrowerEmail, equipName, qty);

    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function approveBorrowRequest(transId) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    const equipSheet = ss.getSheetByName(SHEET_EQUIPMENT);

    const transData = transSheet.getDataRange().getValues();
    const equipData = equipSheet.getDataRange().getValues();

    const matchedRows = [];
    for (let i = 1; i < transData.length; i++) {
      if (String(transData[i][0]) === String(transId) && String(transData[i][10]) === 'รออนุมัติ') {
        matchedRows.push({
          rowIndex: i + 1,
          borrowerName: transData[i][1],
          borrowerEmail: transData[i][2],
          equipId: transData[i][4],
          equipName: transData[i][5],
          qty: Number(transData[i][6])
        });
      }
    }

    if (matchedRows.length === 0) {
      throw new Error('ไม่พบรายการยืมที่รออนุมัติ หรือถูกดำเนินการไปแล้ว');
    }

    const stockDeductions = [];
    for (const item of matchedRows) {
      let equipRowIndex = -1;
      let currentStock = 0;
      for (let j = 1; j < equipData.length; j++) {
        if (String(equipData[j][0]) === String(item.equipId)) {
          equipRowIndex = j + 1;
          currentStock = Number(equipData[j][3]);
          break;
        }
      }
      if (equipRowIndex === -1) throw new Error(`ไม่พบรหัสอุปกรณ์: ${item.equipId}`);
      if (currentStock < item.qty) throw new Error(`อุปกรณ์ ${item.equipName} คงเหลือไม่เพียงพอในระบบ (${currentStock} ชิ้น)`);

      stockDeductions.push({ rowIndex: equipRowIndex, newStock: currentStock - item.qty });
    }

    for (const d of stockDeductions) {
      equipSheet.getRange(d.rowIndex, 4).setValue(d.newStock);
    }

    for (const item of matchedRows) {
      transSheet.getRange(item.rowIndex, 11).setValue('กำลังยืม');
    }

    const firstItem = matchedRows[0];
    const equipNames = matchedRows.map(m => m.equipName);
    const totalQtys = matchedRows.map(m => m.qty);

    sendApprovalTelegramNotification(transId, firstItem.borrowerName, firstItem.borrowerEmail, equipNames, totalQtys);
    sendApprovalEmail(firstItem.borrowerEmail, firstItem.borrowerName, transId, equipNames, totalQtys);

    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function rejectBorrowRequest(transId, reason) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    const transData = transSheet.getDataRange().getValues();

    const matchedRows = [];
    for (let i = 1; i < transData.length; i++) {
      if (String(transData[i][0]) === String(transId) && String(transData[i][10]) === 'รออนุมัติ') {
        matchedRows.push({
          rowIndex: i + 1,
          borrowerName: transData[i][1],
          borrowerEmail: transData[i][2],
          equipName: transData[i][5],
          qty: Number(transData[i][6])
        });
      }
    }

    if (matchedRows.length === 0) {
      throw new Error('ไม่พบรายการยืมที่รออนุมัติ หรือถูกดำเนินการไปแล้ว');
    }

    const rejectReason = String(reason || 'ไม่ระบุเหตุผล').trim();

    for (const item of matchedRows) {
      transSheet.getRange(item.rowIndex, 11).setValue('ไม่อนุมัติ');
      transSheet.getRange(item.rowIndex, 15).setValue('เหตุผลไม่อนุมัติ: ' + rejectReason);
    }

    const firstItem = matchedRows[0];
    const equipNames = matchedRows.map(m => m.equipName);
    const totalQtys = matchedRows.map(m => m.qty);

    sendRejectionTelegramNotification(transId, firstItem.borrowerName, firstItem.borrowerEmail, equipNames, totalQtys, rejectReason);
    sendRejectionEmail(firstItem.borrowerEmail, firstItem.borrowerName, transId, equipNames, totalQtys, rejectReason);

    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function saveEquipment(data) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
    const category = String(data.category || '').trim();
    if (!EQUIPMENT_CATEGORIES.includes(category)) {
      throw new Error('กรุณาเลือกหมวดหมู่ที่กำหนด');
    }
    const sheet = ss.getSheetByName(SHEET_EQUIPMENT);
    const allData = sheet.getDataRange().getValues();

    let image1Url = data.image1 || '';
    let image2Url = data.image2 || '';

    if (image1Url.startsWith('data:image')) {
      image1Url = uploadImageToDrive(image1Url, 'equip_' + data.id + '_img1_' + Date.now() + '.jpg');
    }

    if (image2Url.startsWith('data:image')) {
      image2Url = uploadImageToDrive(image2Url, 'equip_' + data.id + '_img2_' + Date.now() + '.jpg');
    }

    if (data.action === 'add') {
      for (let i = 1; i < allData.length; i++) {
        if (String(allData[i][0]) === String(data.id)) {
          throw new Error('รหัสอุปกรณ์นี้มีอยู่ในระบบแล้ว');
        }
      }

      const qrCode = generateQRCode(data.id, data.name);
      sheet.appendRow([
        data.id, data.name, data.total, data.available, data.location,
        image1Url, image2Url, category, data.description || '', qrCode
      ]);

    } else {
      let found = false;
      for (let i = 1; i < allData.length; i++) {
        if (String(allData[i][0]) === String(data.id)) {
          sheet.getRange(i + 1, 2).setValue(data.name);
          sheet.getRange(i + 1, 3).setValue(data.total);
          sheet.getRange(i + 1, 4).setValue(data.available);
          sheet.getRange(i + 1, 5).setValue(data.location);
          sheet.getRange(i + 1, 6).setValue(image1Url);
          sheet.getRange(i + 1, 7).setValue(image2Url);
          sheet.getRange(i + 1, 8).setValue(category);
          sheet.getRange(i + 1, 9).setValue(data.description || '');

          const newQrCode = generateQRCode(data.id, data.name);
          sheet.getRange(i + 1, 10).setValue(newQrCode);

          found = true;
          break;
        }
      }
      if (!found) throw new Error('ไม่พบรหัสอุปกรณ์ที่ต้องการแก้ไข');
    }

    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function deleteEquipment(id) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
    const sheet = ss.getSheetByName(SHEET_EQUIPMENT);
    const data = sheet.getDataRange().getValues();

    let found = false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        sheet.deleteRow(i + 1);
        found = true;
        break;
      }
    }

    if (!found) throw new Error('ไม่พบอุปกรณ์ที่ต้องการลบ');
    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function saveContactForm(data) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    let contactSheet = ss.getSheetByName(SHEET_CONTACT);
    if (!contactSheet) {
      contactSheet = ss.insertSheet(SHEET_CONTACT);
      contactSheet.appendRow(['Timestamp', 'Name', 'Email', 'Phone', 'Subject', 'Message', 'Status']);
      contactSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#4B5563');
    }

    contactSheet.appendRow([new Date(), data.name, data.email, data.phone, data.subject, data.message, 'New']);
    sendTelegramNotification(data);

    return "Success";
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function sendBorrowTelegramNotification(form, transId) {
  let itemList = '';
  if (Array.isArray(form.equipName)) {
    for (let i = 0; i < form.equipName.length; i++) {
      itemList += `• ${form.equipName[i]} (${form.qty[i]} ชิ้น)\n`;
    }
  } else {
    itemList = `• ${form.equipName} (${form.qty} ชิ้น)\n`;
  }

  const message =
`🟡 มีคำขอยืมอุปกรณ์ใหม่ (รอการอนุมัติ)

👤 ผู้ยืม: ${form.borrowerName}
📧 Email: ${form.email}
📱 โทร: ${form.phone || '-'}
🏫 ห้องที่ใช้ยืม: ${form.borrowRoom || '-'}

🧾 รหัสรายการ:
${transId}

📋 รายการอุปกรณ์:
${itemList}
📅 วันที่ยืม: ${formatThaiDate(new Date())}
⌛ กำหนดคืน: ${formatThaiDate(form.returnDate)}

📝 เหตุผล:
${form.reason || '-'}
📌 สถานะ: รออนุมัติ`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    muteHttpExceptions: true
  });
}

function sendReturnTelegramNotification(transId, borrowerEmail, equipName, qty) {
  const message =
`✅ มีการคืนอุปกรณ์เรียบร้อย

🧾 รหัสรายการ: ${transId}
👤 ผู้คืน (Email): ${borrowerEmail || '-'}
📦 อุปกรณ์ที่คืน: ${equipName} (${qty} ชิ้น)
⏰ วันที่-เวลาที่คืนจริง: ${formatThaiDate(new Date(), true)}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    muteHttpExceptions: true
  });
}

function sendTelegramNotification(data) {
  const message =
`📩 ติดต่อสอบถามใหม่

👤 ชื่อ: ${data.name}
📧 Email: ${data.email}
📱 โทร: ${data.phone || '-'}
📌 หัวข้อ: ${data.subject || '-'}

💬 ข้อความ:
${data.message}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    muteHttpExceptions: true
  });
}

function sendApprovalTelegramNotification(transId, borrowerName, borrowerEmail, equipNames, qtys) {
  let itemList = '';
  if (Array.isArray(equipNames)) {
    for (let i = 0; i < equipNames.length; i++) {
      itemList += `• ${equipNames[i]} (${qtys[i]} ชิ้น)\n`;
    }
  } else {
    itemList = `• ${equipNames} (${qtys} ชิ้น)\n`;
  }

  const message =
`✅ คำขอยืมได้รับการอนุมัติ

🧾 รหัสรายการ: ${transId}
👤 ผู้ยืม: ${borrowerName} (${borrowerEmail})
📋 รายการอุปกรณ์:
${itemList}
📌 สถานะ: อนุมัติแล้ว (กำลังยืม)`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    muteHttpExceptions: true
  });
}

function sendRejectionTelegramNotification(transId, borrowerName, borrowerEmail, equipNames, qtys, reason) {
  let itemList = '';
  if (Array.isArray(equipNames)) {
    for (let i = 0; i < equipNames.length; i++) {
      itemList += `• ${equipNames[i]} (${qtys[i]} ชิ้น)\n`;
    }
  } else {
    itemList = `• ${equipNames} (${qtys} ชิ้น)\n`;
  }

  const message =
`❌ คำขอยืมไม่ได้รับการอนุมัติ

🧾 รหัสรายการ: ${transId}
👤 ผู้ยืม: ${borrowerName} (${borrowerEmail})
📋 รายการอุปกรณ์:
${itemList}
📝 เหตุผลไม่อนุมัติ: ${reason || '-'}
📌 สถานะ: ไม่อนุมัติ`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    muteHttpExceptions: true
  });
}

function sendApprovalEmail(email, borrowerName, transId, equipNames, qtys) {
  try {
    const subject = '✅ คำขอยืมอุปกรณ์ได้รับการอนุมัติ - ' + (Array.isArray(equipNames) ? equipNames.join(', ') : equipNames);
    let equipmentList = '';
    if (Array.isArray(equipNames)) {
      equipNames.forEach((name, index) => {
        equipmentList += `<li>${name} (${qtys[index]} ชิ้น)</li>`;
      });
    } else {
      equipmentList = `<li>${equipNames} (${qtys} ชิ้น)</li>`;
    }

    const body = `
      <div style="font-family: 'Sarabun', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
        <div style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">ระบบยืม-คืนอุปกรณ์</h1>
          <p style="color: #e0f2fe; margin: 10px 0 0 0;">มหาวิทยาลัยสวนดุสิต ศูนย์การศึกษา ลำปาง</p>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #059669; margin-top: 0;">คำขอยืมได้รับการอนุมัติแล้ว ✅</h2>
          <p>สวัสดีครับคุณ <strong>${borrowerName}</strong></p>
          <p>ผู้ดูแลระบบได้อนุมัติคำขอยืมอุปกรณ์ของคุณเรียบร้อยแล้ว คุณสามารถติดต่อขอรับอุปกรณ์ได้ตามสถานที่ที่ระบุ</p>
          <div style="background: #ecfdf5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
            <p><strong>รหัสรายการ:</strong> ${transId}</p>
            <p><strong>รายการอุปกรณ์:</strong></p>
            <ul style="margin: 5px 0; padding-left: 20px;">${equipmentList}</ul>
          </div>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">ขอบคุณครับ<br><br>ระบบยืม-คืนอุปกรณ์</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({ to: email, subject: subject, htmlBody: body });
  } catch (e) {
    Logger.log('Error sending approval email: ' + e.toString());
  }
}

function sendRejectionEmail(email, borrowerName, transId, equipNames, qtys, reason) {
  try {
    const subject = '❌ แจ้งผลคำขอยืมอุปกรณ์ (ไม่อนุมัติ) - ' + (Array.isArray(equipNames) ? equipNames.join(', ') : equipNames);
    let equipmentList = '';
    if (Array.isArray(equipNames)) {
      equipNames.forEach((name, index) => {
        equipmentList += `<li>${name} (${qtys[index]} ชิ้น)</li>`;
      });
    } else {
      equipmentList = `<li>${equipNames} (${qtys} ชิ้น)</li>`;
    }

    const body = `
      <div style="font-family: 'Sarabun', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
        <div style="background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">ระบบยืม-คืนอุปกรณ์</h1>
          <p style="color: #fee2e2; margin: 10px 0 0 0;">มหาวิทยาลัยสวนดุสิต ศูนย์การศึกษา ลำปาง</p>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #dc2626; margin-top: 0;">คำขอยืมไม่ได้รับการอนุมัติ ❌</h2>
          <p>สวัสดีครับคุณ <strong>${borrowerName}</strong></p>
          <p>ระบบขออภัยในความไม่สะดวก คำขอยืมอุปกรณ์ของคุณไม่ได้รับการอนุมัติ</p>
          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
            <p><strong>รหัสรายการ:</strong> ${transId}</p>
            <p><strong>รายการอุปกรณ์:</strong></p>
            <ul style="margin: 5px 0; padding-left: 20px;">${equipmentList}</ul>
            <p style="color: #b91c1c; margin-top: 10px;"><strong>เหตุผลไม่อนุมัติ:</strong> ${reason || '-'}</p>
          </div>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">ขอบคุณครับ<br><br>ระบบยืม-คืนอุปกรณ์</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({ to: email, subject: subject, htmlBody: body });
  } catch (e) {
    Logger.log('Error sending rejection email: ' + e.toString());
  }
}

function sendBorrowConfirmationEmail(form, transId, equipNames, borrowDate, returnDate, signatureUrl) {
  try {
    const subject = '✅ ยืนยันการยืมอุปกรณ์ - ' + (Array.isArray(equipNames) ? equipNames.join(', ') : equipNames);

    let equipmentList = '';
    if (Array.isArray(equipNames)) {
      equipNames.forEach((name, index) => {
        equipmentList += `<li>${name} (${form.qty[index]} ชิ้น)</li>`;
      });
    } else {
      equipmentList = `<li>${equipNames} (${form.qty} ชิ้น)</li>`;
    }

    const body = `
      <div style="font-family: 'Sarabun', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
        <div style="background: linear-gradient(135deg, #075985 0%, #0284c7 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">ระบบยืม-คืนอุปกรณ์</h1>
          <p style="color: #e0f2fe; margin: 10px 0 0 0;">มหาวิทยาลัยสวนดุสิต ศูนย์การศึกษา ลำปาง</p>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #075985; margin-top: 0;">การยืมอุปกรณ์สำเร็จ ✅</h2>
          <p>สวัสดีครับคุณ <strong>${form.borrowerName}</strong></p>
          <p>ระบบได้บันทึกการยืมอุปกรณ์ของคุณเรียบร้อยแล้ว</p>
          <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #0284c7;">
            <h3 style="margin-top: 0; color: #075985;">📋 รายละเอียดการยืม</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0;"><strong>รหัสธุรกรรม:</strong></td><td style="padding: 8px 0;">${transId}</td></tr>
              <tr><td style="padding: 8px 0;"><strong>อุปกรณ์:</strong></td><td style="padding: 8px 0;"><ul style="margin: 0; padding-left: 20px;">${equipmentList}</ul></td></tr>
              <tr><td style="padding: 8px 0;"><strong>วันที่ยืม:</strong></td><td style="padding: 8px 0;">${formatThaiDate(borrowDate)}</td></tr>
              <tr><td style="padding: 8px 0;"><strong>กำหนดคืน:</strong></td><td style="padding: 8px 0; color: #d97706; font-weight: bold;">${formatThaiDate(new Date(returnDate))}</td></tr>
              <tr><td style="padding: 8px 0;"><strong>เบอร์ติดต่อ:</strong></td><td style="padding: 8px 0;">${form.phone}</td></tr>
              <tr><td style="padding: 8px 0;"><strong>ห้องที่ใช้ยืม:</strong></td><td style="padding: 8px 0;">${form.borrowRoom || '-'}</td></tr>
              <tr>
                <td style="padding: 8px 0; vertical-align: top;"><strong>ลายเซ็นผู้ยืม:</strong></td>
                <td style="padding: 8px 0;">${signatureUrl ? `<img src="${signatureUrl}" alt="ลายเซ็นผู้ยืม" style="max-width: 160px; max-height: 80px; border: 1px solid #bae6fd; background: #fff;">` : '-'}</td>
              </tr>
            </table>
          </div>
          <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #fbbf24;">
            <p style="margin: 0;"><strong>⏰ แจ้งเตือน:</strong> คุณจะได้รับอีเมล์เตือนก่อนกำหนดคืน 1 วัน</p>
          </div>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">ขอบคุณที่ใช้บริการครับ<br><br>ระบบยืม-คืนอุปกรณ์</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({ to: form.email, subject: subject, htmlBody: body });
  } catch (e) {
    Logger.log('Error sending email: ' + e.toString());
  }
}

function sendReturnConfirmationEmail(email, equipName, qty) {
  try {
    const subject = '✅ ยืนยันการคืนอุปกรณ์ - ' + equipName;
    const body = `
      <div style="font-family: 'Sarabun', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
        <div style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">✅ คืนอุปกรณ์เรียบร้อย</h1>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #059669; margin-top: 0;">ขอบคุณที่คืนอุปกรณ์ตรงเวลา 🎉</h2>
          <div style="background: #ecfdf5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
            <p style="margin: 0;"><strong>อุปกรณ์:</strong> ${equipName}</p>
            <p style="margin: 10px 0 0 0;"><strong>จำนวน:</strong> ${qty} ชิ้น</p>
            <p style="margin: 10px 0 0 0;"><strong>วันที่คืน:</strong> ${formatThaiDate(new Date(), true)}</p>
          </div>
          <p>ระบบได้บันทึกการคืนอุปกรณ์เรียบร้อยแล้ว</p>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">ขอบคุณที่ใช้บริการครับ<br><br>ระบบยืม-คืนอุปกรณ์</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({ to: email, subject: subject, htmlBody: body });
  } catch (e) {
    Logger.log('Error sending return email: ' + e.toString());
  }
}

function sendReminderEmails() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const transSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    if (!transSheet || transSheet.getLastRow() <= 1) return;

    const data = transSheet.getDataRange().getValues();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 1; i < data.length; i++) {
      const status = data[i][10];
      const returnDate = new Date(data[i][8]);
      const emailNotified = data[i][12];

      if (status === 'กำลังยืม' && !emailNotified) {
        returnDate.setHours(0, 0, 0, 0);
        const daysDiff = Math.ceil((returnDate - today) / (1000 * 60 * 60 * 24));

        if (daysDiff === 1) {
          sendReminderEmail(data[i][2], data[i][1], data[i][5], data[i][6], returnDate, data[i][0]);
          transSheet.getRange(i + 1, 13).setValue(true);
        }
      }
    }
  } catch (e) {
    Logger.log('Error in sendReminderEmails: ' + e.toString());
  }
}

function sendReminderEmail(email, borrowerName, equipName, qty, returnDate, transId) {
  try {
    const subject = '⏰ แจ้งเตือน: ใกล้ครบกำหนดคืนอุปกรณ์ - ' + equipName;
    const body = `
      <div style="font-family: 'Sarabun', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
        <div style="background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">⏰ แจ้งเตือนคืนอุปกรณ์</h1>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #d97706; margin-top: 0;">กำหนดคืนอุปกรณ์พรุ่งนี้! 📅</h2>
          <p>สวัสดีครับคุณ <strong>${borrowerName}</strong></p>
          <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
            <p style="margin: 0; font-size: 16px;"><strong>⚠️ อุปกรณ์ของคุณจะครบกำหนดคืนในวันพรุ่งนี้</strong></p>
          </div>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">ขอบคุณที่ใช้บริการครับ<br><br>ระบบยืม-คืนอุปกรณ์</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({ to: email, subject: subject, htmlBody: body });
  } catch (e) {
    Logger.log('Error sending reminder email: ' + e.toString());
  }
}

function setupDailyReminderTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'sendReminderEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('sendReminderEmails')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
}

function getLogoUrl() {
  try {
    const folder = DriveApp.getFolderById(IMAGE_FOLDER_ID);
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName().toLowerCase();
      if (name.includes('borrow')) {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800';
      }
    }
  } catch (e) {
    Logger.log('Error getting logo URL: ' + e.toString());
  }
  return '';
}

function getUsers() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let userSheet = ss.getSheetByName(SHEET_USERS);
    if (!userSheet) {
      setupDatabase();
      userSheet = ss.getSheetByName(SHEET_USERS);
    }

    let users = [];
    if (userSheet && userSheet.getLastRow() > 1) {
      const data = userSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (!data[i][0]) continue;
        users.push({
          userId: data[i][0],
          name: data[i][1],
          pin: data[i][2] ? String(data[i][2]) : '',
          role: data[i][3] || 'Staff',
          createdAt: formatDate(data[i][4])
        });
      }
    }
    return { status: 'success', users: users };
  } catch (e) {
    return { status: 'error', message: e.toString(), users: [] };
  }
}

function saveUser(userData) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!userData || !userData.userId || !userData.name || !userData.pin || !userData.role) {
      throw new Error('กรอกข้อมูลผู้ใช้งานไม่ครบถ้วน');
    }

    const userId = String(userData.userId).trim();
    const name = String(userData.name).trim();
    const pin = String(userData.pin).trim();
    const role = String(userData.role).trim();

    if (!/^[a-zA-Z0-9_.-]+$/.test(userId)) {
      throw new Error('ไอดีต้องเป็นตัวอักษรภาษาอังกฤษ ตัวเลข หรือเครื่องหมาย _ . - เท่านั้น');
    }

    const ss = SpreadsheetApp.openById(SHEET_ID);
    let userSheet = ss.getSheetByName(SHEET_USERS);
    if (!userSheet) {
      setupDatabase();
      userSheet = ss.getSheetByName(SHEET_USERS);
    }

    const data = userSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === userId.toLowerCase()) {
        throw new Error(`ไอดี ${userId} มีอยู่ในระบบแล้ว`);
      }
    }

    userSheet.appendRow([userId, name, pin, role, new Date()]);
    return { status: 'success', message: 'เพิ่มผู้ใช้งานเรียบร้อยแล้ว' };
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function updateUser(userData) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!userData || !userData.userId) {
      throw new Error('ระบุผู้ใช้งานไม่ถูกต้อง');
    }

    const userId = String(userData.userId).trim();
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const userSheet = ss.getSheetByName(SHEET_USERS);
    if (!userSheet || userSheet.getLastRow() <= 1) {
      throw new Error('ไม่พบข้อมูลผู้ใช้งาน');
    }

    const data = userSheet.getDataRange().getValues();
    let rowIndex = -1;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === userId.toLowerCase()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) throw new Error('ไม่พบผู้ใช้งานนี้ในระบบ');

    if (userData.name !== undefined) userSheet.getRange(rowIndex, 2).setValue(String(userData.name).trim());
    if (userData.pin !== undefined) userSheet.getRange(rowIndex, 3).setValue(String(userData.pin).trim());
    if (userData.role !== undefined) userSheet.getRange(rowIndex, 4).setValue(String(userData.role).trim());

    return { status: 'success', message: 'อัปเดตข้อมูลผู้ใช้งานเรียบร้อยแล้ว' };
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}

function deleteUser(targetUserId, currentUserId) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!targetUserId) throw new Error('ไม่ระบุผู้ใช้งานที่ต้องการลบ');

    if (String(targetUserId).toLowerCase() === String(currentUserId).toLowerCase()) {
      throw new Error('ไม่สามารถลบบัญชีของตนเองที่กำลังใช้งานอยู่ได้');
    }

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const userSheet = ss.getSheetByName(SHEET_USERS);
    if (!userSheet || userSheet.getLastRow() <= 1) {
      throw new Error('ไม่พบข้อมูลผู้ใช้งาน');
    }

    const data = userSheet.getDataRange().getValues();
    let rowIndex = -1;
    let targetRole = '';
    let superAdminCount = 0;

    for (let i = 1; i < data.length; i++) {
      const uId = String(data[i][0]);
      const uRole = String(data[i][3]);
      if (uRole === 'Super Admin') superAdminCount++;
      if (uId.toLowerCase() === String(targetUserId).toLowerCase()) {
        rowIndex = i + 1;
        targetRole = uRole;
      }
    }

    if (rowIndex === -1) throw new Error('ไม่พบบัญชีผู้ใช้งานนี้ในระบบ');

    if (targetRole === 'Super Admin' && superAdminCount <= 1) {
      throw new Error('ไม่สามารถลบ Super Admin คนสุดท้ายในระบบได้');
    }

    userSheet.deleteRow(rowIndex);
    return { status: 'success', message: 'ลบผู้ใช้งานเรียบร้อยแล้ว' };
  } catch (e) {
    throw new Error(e.message);
  } finally {
    lock.releaseLock();
  }
}
