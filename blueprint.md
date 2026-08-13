# Blueprint: ระบบยืม-คืนอุปกรณ์ (Return Workflow & QR Deep Link)

## Phase 1 — Discovery & Architecture Design

### 1. Requirement
* ออกแบบและสรุปเปรียบเทียบ Return Workflow (กระบวนการรับคืนอุปกรณ์) ระหว่าง:
  - **Option A (Admin Direct Return — แนะนำ)**: ผู้ดูแลตรวจสภาพอุปกรณ์และกด "รับคืน" ในระบบโดยตรง ( single source of truth )
  - **Option B (Two-Step Self-Return)**: ผู้ยืมกด "แจ้งคืน" ก่อน ➔ ผู้ดูแลกด "อนุมัติรับคืน"
  - **Option C (Fast Return Scan / Hybrid)**: ผู้ยืมเปิด QR/รายการยืม ➔ ผู้ดูแลสแกน QR เพื่อตรวจรับคืนด่วน

### 2. Comparative Analysis & Decision Matrix

| มิติการพิจารณา | Option A: Admin Direct (ปัจจุบัน) | Option B: Borrower Request First | Option C: Fast QR Return (แนะนำอนาคต) |
| :--- | :--- | :--- | :--- |
| **Physical Verification** | 🟢 สูงสุด (ผู้ดูแลตรวจของก่อนกด) | 🔴 เสี่ยง (ผู้ยืมกดก่อนแต่ยังไม่คืนของจริง) | 🟢 สูงสุด (ผู้ดูแลสแกนและตรวจของจริง) |
| **Stock Accuracy** | 🟢 ตรงตามจริงทันที | 🟡 อาจเกิด Stale/Fake Stock | 🟢 ตรงตามจริงทันที |
| **User Friction** | 🟢 ต่ำสุด (ผู้ยืมแค่นำของมาส่ง) | 🔴 สูง (ผู้ยืมต้องเปิดเว็บกดแจ้งคืนอีกรอบ) | 🟢 ต่ำมาก (สแกนคิวอาร์รับคืนด่วน) |
| **System Complexity** | 🟢 ต่ำ (ใช้ Flow เดิม Minimal Change) | 🔴 สูง (ต้องเพิ่ม State `รอตรวจรับคืน`) | 🟡 ปานกลาง (เพิ่ม QR Scan Module) |
| **Auditability / Proof** | 🟢 มีสลิป/อีเมลยืนยันส่งให้ผู้ยืม | 🟡 ผู้ยืมอ้างว่ากดคืนแล้วแต่ของหาย | 🟢 มีสลิป/อีเมล + Log สแกน |

---

## Phase 2 — Recommended Return Workflow (Option A+ Enhanced)

### Core Workflow Principle
**" Physical Verification is Key — การคืนอุปกรณ์สมบูรณ์ต่อเมื่อผู้ดูแลรับและตรวจสภาพของจริง "**

### Flow ขั้นตอนการทำงาน:
1. **ผู้ยืมคืนของจริง**: ผู้ยืมนำอุปกรณ์มาส่ง ณ จุดรับคืน (เจ้าหน้าที่ประจำเคาน์เตอร์)
2. **เจ้าหน้าที่ตรวจสภาพ (Physical Check)**: เจ้าหน้าที่ตรวจสอบความสมบูรณ์และจำนวนอุปกรณ์
3. **เจ้าหน้าที่กดรับคืนในระบบ (Admin Action)**:
   - เจ้าหน้าที่ค้นหาชื่อ/อีเมล/อุปกรณ์ ในตารางผู้ดูแลระบบ
   - กดปุ่ม **"รับคืน"** (สีเขียวเด่นชัด)
   - ปรากฏ **Confirmation Modal**:
     - *หัวข้อ*: ยืนยันการรับคืน
     - *คำถาม*: ตรวจสอบสภาพอุปกรณ์เรียบร้อยแล้วใช่หรือไม่?
     - *หมายเหตุ*: ระบบจะส่งอีเมลยืนยันการรับคืนให้ผู้ยืมโดยอัตโนมัติ
4. **Backend Processing (`code.gs` `returnItem`)**:
   - บันทึก `actualReturnDate` เป็นวันที่ปัจจุบัน
   - เปลี่ยนสถานะเป็น `คืนแล้ว`
   - เพิ่มสต็อกอุปกรณ์กลับคืน (`available` + qty)
   - ส่งอีเมลแจ้งเตือนผู้ยืม (`GmailApp.sendEmail`) เพื่อเป็นหลักฐานอิเล็กทรอนิกส์
5. **Real-time UI Refresh**: ตารางอัปเดตสถานะเป็น `คืนแล้ว` พร้อม Badge สีเขียว

---

## Technical Specifications & Features

### 1. Safety & Idempotence
* **LockService**: ล็อกการแก้ไข Sheet ป้องกัน Race Condition เมื่อมีการรับคืนพร้อมกัน
* **Notification Proof**: อีเมลยืนยันการคืนทำหน้าที่เป็นใบเสร็จ/หลักฐานอิเล็กทรอนิกส์ยืนยันว่าผู้ยืมได้ส่งคืนเรียบร้อยแล้ว

### 2. Future Enhancement (Phase 2.1 Extension)
* **QR Receipt / Fast Return Code**: ในหน้า "ตรวจสอบสถานะการยืม" ของผู้ยืม ให้มีปุ่ม "แสดง QR รับคืน" เพื่อให้ผู้ดูแลใช้กล้องสแกน QR แล้วระบบเด้งหน้าต่างรับคืนให้อัตโนมัติ (ไม่ต้องพิมพ์ค้นหาชื่อ)
