# Changelog

รูปแบบอิงตาม [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
และโปรเจกต์นี้ใช้ [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [1.0.0] - 2026-07-02

### Added

- โหมดรีเฟรช 2 แบบต่อแท็บ: รีโหลดหน้าเว็บ และตรวจสอบเบื้องหลัง (XHR monitor)
- การตรวจจับ: หลายคำ (any-match, case-sensitive ได้), ความเปลี่ยนแปลงของหน้า (hash
  เทียบ baseline), หรือปิดการตรวจจับ
- ช่วงเวลา: preset 5 วินาที–15 นาที, กำหนดเอง (≥2 วินาที), สุ่มช่วง min–max ทุกรอบ
- เมื่อพบ (ตั้งค่าแยก): หยุด/ไม่หยุดรีเฟรช, เสียงวนจนกดหยุด, desktop notification
  (คลิกโฟกัสแท็บ), ไฮไลต์+เลื่อนจอ, โฟกัสแท็บอัตโนมัติ, คลิกอัตโนมัติ
  (ข้อความปุ่ม / CSS selector / ตรงคำที่พบ)
- เสียงในตัว 4 แบบ + อัปโหลด mp3/wav เอง, ปรับระดับเสียง, ปุ่มทดสอบ/หยุดเสียง
- ตัวจับเวลาลอยบนหน้าเว็บ ลากย้ายได้ จำตำแหน่งต่อ origin
- ตั้งค่าแยกรายแท็บ + บันทึกค่าเริ่มต้นสำหรับแท็บใหม่, UI ภาษาไทยทั้งหมด
- สถาปัตยกรรม MV3: offscreen document + Web Worker เป็นตัวจับเวลากลาง
  (ทน timer throttling), chrome.alarms watchdog กู้คืนอัตโนมัติ,
  state ทั้งหมดอยู่ใน storage.session
- ชุดทดสอบ Playwright e2e 10 สถานการณ์ + เซิร์ฟเวอร์จำลอง, CI ตรวจ manifest/syntax/assets

[1.0.0]: https://github.com/yangwachi123/Gitmini/releases/tag/v1.0.0
