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
    const text = `（模擬 ${agent.engine}）${pick(agent)}`;
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
