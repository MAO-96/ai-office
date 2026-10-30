// 附件測試：存檔、抽文字（txt / docx / xlsx / pptx）、放進提示詞、防路徑穿越
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createAttachments, safeName } = require('../src/main/attachments');

// 測試用的極簡 zip 產生器
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = Buffer.from(name), raw = Buffer.from(text), data = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const b64 = (x) => Buffer.from(x).toString('base64');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-att-'));
const att = createAttachments({ getWorkspace: () => ws });

const txt = att.save({ name: '需求.md', data: b64('# 記帳 App\n要有月報表') });
assert.ok(txt.readable && txt.id.endsWith('-需求.md'));
const docx = att.save({ name: '報價.docx', data: b64(zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>總價 12,000 元</w:t></w:r></w:p><w:p><w:r><w:t>A&amp;B 公司</w:t></w:r></w:p></w:body></w:document>' })) });
const xlsx = att.save({ name: '預算.xlsx', data: b64(zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="一月" sheetId="1"/></sheets></workbook>',
  'xl/sharedStrings.xml': '<sst><si><t>項目</t></si><si><t>金額</t></si><si><t>房租</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>15000</v></c></row></sheetData></worksheet>',
})) });
const pptx = att.save({ name: '簡報.pptx', data: b64(zip({ 'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>結論</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>' })) });
const png = att.save({ name: '截圖.png', data: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])) });
assert.strictEqual(png.kind, 'image');
assert.ok(!png.readable);

const p = att.withAttachments('幫我檢查', [txt.id, docx.id, xlsx.id, pptx.id, png.id]);
assert.match(p, /^幫我檢查\n\n【附件】共 5 個/);
assert.match(p, /要有月報表/);
assert.match(p, /總價 12,000 元\nA&B 公司/);
assert.match(p, /【工作表：一月】\n項目\t金額\n房租\t15000/);
assert.ok(p.indexOf('封面') < p.indexOf('結論'));
assert.match(p, /截圖\.png[\s\S]*請用你的讀檔工具開啟/);
assert.ok(p.includes(path.join(ws, 'attachments')));
console.log('✓ 文字檔、Word、Excel、PowerPoint 內容放進提示詞；圖片給路徑');

assert.throws(() => att.describe(['../../etc/passwd']), /附件代號不正確/);
assert.throws(() => att.describe(['20260101/abcdef-..\\x']), /附件代號不正確|找不到/);
assert.strictEqual(safeName('..\\..\\evil.txt'), 'evil.txt');
assert.ok(!fs.readdirSync(path.join(ws, 'attachments')).some((d) => d.includes('..')));
console.log('✓ 不會讀到工作目錄以外的檔案');

const big = 'x'.repeat(50000);
const bigId = att.save({ name: 'big.txt', data: b64(big) }).id;
assert.match(att.describe([bigId]), /已截斷/);
assert.throws(() => att.save({ name: 'a.bin', data: '' }), /空的/);
console.log('✓ 太長的內容會截斷、空檔會擋下');

// 接進任務：交辦時夾帶，提示詞裡看得到內容，任務標題不會被附件塞爆
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-att-svc-'));
  const { createService } = require('../src/main/service');
  const svc = createService({ userDataDir: home, defaultsDir: path.join(__dirname, '..', 'config'), emit: () => {} });
  svc.saveSettings({ mockMode: true, workspace: ws });
  const a = svc.uploadAttachment({ name: '規格.txt', data: b64('登入要支援 Google') });
  const { runId } = svc.startRun({ kind: 'single', agentId: 'pm', task: '照附件寫規格', attachments: [a.id] });
  for (let i = 0; i < 300; i++) {
    const r = svc.listRuns().find((x) => x.runId === runId);
    if (r && r.status === 'finished') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const r = svc.getRun(runId);
  assert.strictEqual(r.status, 'finished');
  assert.strictEqual(r.title, '照附件寫規格');
  assert.match(r.task, /登入要支援 Google/);
  const { runId: r2 } = svc.startRun({ kind: 'single', agentId: 'pm', task: '', attachments: [a.id] });
  assert.ok(r2);
  console.log('✓ 交辦時夾帶附件，員工收到的提示詞含檔案內容');
  fs.rmSync(ws, { recursive: true, force: true });
  console.log('\n全部通過');
  process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
