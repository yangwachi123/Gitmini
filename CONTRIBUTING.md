# การมีส่วนร่วมพัฒนา (Contributing)

ขอบคุณที่สนใจร่วมพัฒนา!

## เริ่มต้น

ไม่มี build step — โคลน repo แล้วโหลดเป็น unpacked extension ได้ทันที
(`chrome://extensions` → Developer mode → Load unpacked)

## ก่อนเปิด Pull Request

รันเช็คเดียวกับ CI ให้ผ่านก่อน:

```bash
python3 -c "import json; json.load(open('manifest.json'))"
git ls-files '*.js' '*.mjs' | xargs -n1 node --check
python3 tools/generate_sounds.py --check
python3 tools/generate_icons.py --check
node tests/e2e/smoke.test.mjs   # ต้องมี playwright + chromium
```

## แนวทาง

- แก้ assets ต้องแก้ผ่าน generator ใน `tools/` แล้วรันใหม่ (CI เทียบไบต์ต่อไบต์)
- ค่าคงที่ message/storage อยู่ที่ `common/messages.js` — ถ้าแก้ ต้องอัปเดต
  string literal ใน `content/content.js` ให้ตรงกันด้วย (content script เป็น
  classic script ใช้ import ไม่ได้)
- เพิ่มฟีเจอร์ควรเพิ่มสถานการณ์ทดสอบใน `tests/e2e/smoke.test.mjs`
- UI ใช้ภาษาไทย ข้อความ error ภาษาไทย
