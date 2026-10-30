/*
 * 模擬轉接器：不呼叫任何 AI，依角色職稱回傳示範內容並逐字串流。
 * 用來在沒有 CLI / API Key 時先跑通畫面與流程。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MockAdapter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CANNED = {
    企劃: ['目標：先做出最小可用版本，確認流程可行。', '規格：1) 輸入任務 2) 角色依序處理 3) 輸出彙整報告。', '驗收：每一步都有紀錄，失敗可重試。'],
    工程: ['已依規格完成主要模組，拆成輸入、處理、輸出三層。', '補上錯誤處理與逾時機制。', '附上單元測試，涵蓋正常與例外路徑。'],
    研究: ['整理了三個可行方案：A 速度快、B 成本低、C 擴充性最好。', '建議先用 A 驗證，再逐步換成 C。', '介面上建議把狀態用顏色區分，降低閱讀負擔。'],
    審查: ['發現兩個問題：缺少輸入驗證、錯誤訊息不夠具體。', '建議把設定檔讀取集中管理，避免重複。', '結論：需修正後再上線。'],
  };

  function pick(agent) {
    const key = Object.keys(CANNED).find((k) => (agent.title || '').includes(k));
    const pool = CANNED[key] || ['收到，我來處理。', '已整理好我的看法。', '這部分可以再討論。'];
    const n = 1 + Math.floor(Math.random() * pool.length);
    return pool.slice(0, n).join('\n');
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
  }

  async function run(agent, prompt, { signal, onChunk, speed = 1 } = {}) {
    let text = `（模擬 ${agent.engine}）${pick(agent)}`;
    if (String(prompt).includes('【釐清需求】')) {
      text = String(prompt).includes('已經問過') ? '{"questions":[]}'
        : JSON.stringify({ questions: [
          { q: '這個成品主要是給誰用？', options: ['只有我自己', '團隊內部', '對外客戶'] },
          { q: '第一版希望多快完成？', options: ['今天先出雛形', '一週內', '不急，做完整'] },
        ] });
    }
    const P = String(prompt);
    if (P.includes('【審查討論】')) {
      const round = Number((P.match(/第 (\d+) 輪/) || [])[1] || 1);
      if (P.includes('最後一行只寫「立場：同意」')) {
        text = round < 2
          ? '1. 問題：沒有說明資料要存在哪裡 → 換電腦會遺失 → 建議加上匯出功能。\n2. 問題：沒有錯誤處理 → 輸入錯誤會當掉 → 建議加上檢查。\n立場：有異議'
          : '上一輪的兩個問題都已處理，匯出與檢查都補上了。\n立場：同意';
      } else if (P.includes('以「【修訂版】」開頭')) {
        text = P.includes('最終裁決') ? '整理分歧後的最佳做法如下。\n【修訂版】（模擬）最終版本：含匯出與輸入檢查。'
          : '1. 接受，加上匯出。\n2. 接受，加上輸入檢查。\n【修訂版】（模擬）修訂後成果：記帳 App，含匯出與輸入檢查。';
      } else {
        text = '第 1 點成立，第 2 點優先度較低但值得做。';
      }
    }
    await sleep(600 / speed, signal);
    let out = '';
    for (const ch of text) {
      out += ch;
      if (onChunk) onChunk(ch);
      await sleep(35 / speed, signal);
    }
    return out;
  }

  return { run };
});
