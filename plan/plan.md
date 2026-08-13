# Rewrite Plan (Minimal Change)

## Trigger
- คำขอปรับ UI + เพิ่ม `borrowRoom` และลายเซ็นผู้ยืมในระบบยืม-คืน (GAS + HTML เดิม)

## Stop Condition
- ส่งคำขอยืมได้พร้อม `borrowRoom` + `signatureData`
- บันทึก `BorrowRoom` และ `SignatureUrl` ในชีต Transactions ต่อท้ายคอลัมน์เดิม
- แสดงข้อมูลห้อง/ลายเซ็นในหน้าจอหลักที่เกี่ยวข้อง + รายงานพิมพ์
- ธีมหลักเปลี่ยนเป็นฟ้า–ขาว โดยไม่เปลี่ยน Business Logic เดิม

## Task Fit
- ใช้แนวทางแก้เฉพาะจุด (patch เฉพาะส่วน): Header/Footer/Theme variables, Borrow form, submit flow, server save flow, report rendering, email/telegram branding
- ไม่ rewrite ทั้งไฟล์, ไม่เปลี่ยนชื่อฟังก์ชันเดิม

## Fact
- โครงสร้าง client อยู่ใน `index.txt` และ server อยู่ใน `code.txt`
- `saveBorrowRequest()` ปัจจุบันตัดสต็อกและ append ทีละรายการใน loop (เสี่ยง partial save)
- `uploadImageToDrive()` รองรับ base64 data:image อยู่แล้ว
- Transactions header ปัจจุบัน 16 คอลัมน์

## Assumption
- `index.txt` จะถูกใช้เป็น `index.html` และ `code.txt` จะถูกใช้เป็น `Code.gs` ตอน deploy
- ระบบเดิมไม่มี field ห้องยืม/ลายเซ็นในทรานแซกชัน

## Missing Information
- ไม่มีหลักฐานหน้า/ไฟล์ Email template อื่นนอก `sendBorrowConfirmationEmail` และ report HTML ที่ฝังใน JS
- ไม่มี test env/runtime log จริงของ GAS ในรอบนี้

## Implementation Steps
1. ปรับ theme variables + branding Header/Footer แบบไม่แตะ flow
2. เพิ่มฟอร์ม `borrowRoom` + canvas signature + validation + disable submit กันกดซ้ำ
3. เพิ่ม payload `borrowRoom/signatureData` ใน `handleBorrowSubmit()`
4. ปรับ `setupDatabase()` ให้รองรับคอลัมน์ 17-18 แบบ append-only
5. ปรับ `saveBorrowRequest()` ให้ validate ก่อน, check stock ทั้งหมดก่อน, upload signature ครั้งเดียว, แล้วค่อยตัด stock + append
6. ขยาย `getData()` ให้คืน `borrowRoom/signatureUrl` รองรับข้อมูลเก่า
7. ปรับ Telegram/Email/ตารางผู้ดูแล/รายงานพิมพ์ให้แสดงห้องและลายเซ็น
8. ตรวจ regression flow เดิม: borrow/return/admin/report/reminder

## Safety Control
- ScriptLock ครอบธุรกรรมทั้งหมด (existing)
- กัน duplicate submit ด้วยสถานะ `isBorrowSubmitting` + disable ปุ่ม submit
- validate ฝั่ง client + server สำหรับ `borrowRoom` และ `signatureData`
- หยุดทันทีเมื่อ upload ลายเซ็นไม่สำเร็จ (ไม่ตัดสต็อก ไม่ append)

## Build/Test Step (ท้ายแผน)
- Smoke test ตาม checklist ผู้ใช้: UI branding/theme, required room/signature, stock safety, schema compatibility 16→18, email/telegram/report output
