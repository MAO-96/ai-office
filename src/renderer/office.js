/*
 * 避難所剖面辦公室：Canvas 繪製樓層、電梯井、像素角色與動畫。
 * 只負責「看得到的東西」，資料來自協調核心送來的事件。
 */
(function () {
  'use strict';

  const FONT = "'Noto Sans TC','Microsoft JhengHei','PingFang TC','Hiragino Sans',sans-serif";
  const G = { surface: 84, floorH: 168, shaftW: 78, roomW: 440, gap: 10, margin: 34, px: 3, floorStrip: 18 };
  const WALK = 140;
  const RIDE = 230;

  // 固定亂數，讓岩層紋理每次一樣
  function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }

  function shade(hex, amt) {
    const n = parseInt(hex.replace('#', ''), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v + amt)));
    const r = c(n >> 16), g = c((n >> 8) & 255), b = c(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // ---------- 像素角色 ----------
  // 原點為腳底中央；格子 10 寬 x 18 高
  function drawCharacter(ctx, cx, feetY, look, o) {
    const px = (o && o.px) || G.px;
    const L = Object.assign({ skin: '#f2c9a0', hair: '#4a3020', shirt: '#4a78c9', pants: '#333' }, look || {});
    const x0 = Math.round(cx - 5 * px);
    const y0 = Math.round(feetY - 18 * px);
    const R = (col, row, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x0 + col * px, y0 + row * px, w * px, h * px); };
    const facing = (o && o.facing) || 1;
    const phase = (o && o.walkPhase) || 0;
    const walking = o && o.walking;
    const working = o && o.working;
    const t = (o && o.t) || 0;

    // 陰影
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x0 + px, feetY - 2, 8 * px, 3);

    // 腿
    const lift = walking ? Math.round(Math.sin(phase) * 1) : 0;
    R(2, 12, 3, 5 - Math.max(0, lift), L.pants);
    R(5, 12, 3, 5 - Math.max(0, -lift), L.pants);
    R(2, 17 - Math.max(0, lift), 3, 1, '#1d1a18');
    R(5, 17 - Math.max(0, -lift), 3, 1, '#1d1a18');

    // 身體
    R(1, 7, 8, 5, L.shirt);
    R(1, 11, 8, 1, shade(L.shirt, -30));
    R(4, 7, 2, 1, shade(L.shirt, 25)); // 領口

    // 手臂
    if (working) {
      const bob = Math.sin(t * 18) > 0 ? 0 : 1;
      const hx = facing > 0 ? 9 : 0;
      R(facing > 0 ? 8 : 1, 8, 1, 2, shade(L.shirt, -15));
      R(hx, 9 + bob, 1, 1, L.skin);
      R(facing > 0 ? 0 : 9, 8, 1, 3, shade(L.shirt, -15));
      R(facing > 0 ? 0 : 9, 11, 1, 1, L.skin);
    } else {
      const swing = walking ? Math.round(Math.sin(phase)) : 0;
      R(0, 7 + Math.max(0, swing), 1, 4, shade(L.shirt, -15));
      R(9, 7 + Math.max(0, -swing), 1, 4, shade(L.shirt, -15));
      R(0, 11 + Math.max(0, swing), 1, 1, L.skin);
      R(9, 11 + Math.max(0, -swing), 1, 1, L.skin);
    }

    // 頭
    R(4, 6, 2, 1, shade(L.skin, -20)); // 脖子
    R(2, 1, 6, 5, L.skin);
    R(2, 0, 6, 1, L.hair);
    R(1, 1, 8, 1, L.hair);
    R(1, 2, 1, 2, L.hair);
    R(8, 2, 1, 2, L.hair);
    const e = facing > 0 ? 1 : 0;
    const blink = Math.sin(t * 1.3 + cx) > 0.985;
    if (!blink) { R(3 + e, 3, 1, 1, '#1d1a18'); R(5 + e, 3, 1, 1, '#1d1a18'); }
    R(4 + e, 5, 1, 1, shade(L.skin, -45));
  }

  // ---------- 閒暇互動台詞（預寫，不呼叫 AI） ----------
  const CHATS = [
    ['早安！咖啡機修好了嗎？', '修好了，第一杯超香', '我等等也去裝一杯'],
    ['昨天那個任務順利嗎？', '還不錯，審查只挑了兩個問題', 'Rex 今天手下留情欸'],
    ['午餐要吃什麼？', '便當吧，懶得出門', '好，幫我也訂一個'],
    ['我發現一個好用的快捷鍵', '快教我！', 'Ctrl+Shift+P，什麼都找得到'],
    ['最近額度還夠用嗎？', '省著點用 😅', '我改用短一點的提示詞了'],
    ['週末有什麼計畫？', '打算在家追劇', '聽起來很棒'],
    ['這個辦公室越來越熱鬧了', '對啊，還有空位等新同事', ''],
    ['你那個 bug 修好了嗎？', '剛修好，原來少一個逗號', '經典'],
    ['審查官今天心情好嗎？', '還是很愛挑毛病', '但挑得都有道理…'],
    ['下午要不要一起對一下進度？', '好啊，三點會議室', ''],
  ];
  const COFFEE = ['☕ 補充咖啡因', '來杯拿鐵', '餅乾又被吃光了…', '今天的咖啡有點苦', '（倒杯水）'];
  const MUTTER = ['（伸懶腰）', '嗯…', '（整理桌面）', '（喝口水）', '今天進度不錯'];
  const STROLL = ['（看一下白板）', '（澆一下盆栽）', '（印個資料）', '（活動一下筋骨）'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- 辦公室 ----------
  class Office {
    constructor(canvas, state, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.rt = new Map();
      this.time = 0;
      this.running = false;
      this.runs = [];
      this.selected = null;
      this.hover = null;
      this.setState(state);
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      canvas.addEventListener('click', (e) => this.onClick(e));
      canvas.addEventListener('mousemove', (e) => this.onHover(e));
      let last = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        this.update(dt);
        this.draw();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    setState(state) {
      this.state = state;
      this.layout();
      this.syncAgents();
    }

    layout() {
      const floors = this.state.rooms.floors;
      this.rooms = {};
      const shaftX = G.margin;
      const roomsX = shaftX + G.shaftW + G.gap;
      let maxX = roomsX;
      const nAgents = this.state.agents.length;
      floors.forEach((rooms, f) => {
        const y = G.surface + f * G.floorH;
        let x = roomsX;
        rooms.forEach((r) => {
          const w = r.wide ? G.roomW * 2 + G.gap : G.roomW;
          const h = G.floorH - G.gap;
          // 辦公室：至少保留 2 張空桌給新進員工
          const n = r.id === 'office' ? Math.max(r.desks || 0, nAgents + 2) : (r.desks || 0);
          const desks = [];
          const left = x + 120, right = x + w - 70;
          for (let i = 0; i < n; i++) desks.push(Math.round(n === 1 ? (left + right) / 2 : left + i * ((right - left) / (n - 1))));
          this.rooms[r.id] = Object.assign({}, r, { x, y, w, h, floor: f, feet: y + h - G.floorStrip, desks });
          x += w + G.gap;
        });
        maxX = Math.max(maxX, x);
      });
      this.worldW = maxX - G.gap + G.margin;
      this.worldH = G.surface + floors.length * G.floorH + 24;
      this.shaft = { x: shaftX, w: G.shaftW, cx: shaftX + G.shaftW / 2, top: G.surface, bottom: G.surface + floors.length * G.floorH - G.gap };
      const rnd = seeded(42);
      this.rocks = [];
      for (let i = 0; i < 420; i++) this.rocks.push({ x: rnd() * this.worldW, y: G.surface + rnd() * (this.worldH - G.surface), s: 2 + Math.floor(rnd() * 3), l: rnd() > 0.5 });
      this.office = this.rooms.office || Object.values(this.rooms).find((r) => r.desks.length) || Object.values(this.rooms)[0];
      this.lounge = this.rooms.lounge || null;
      this.depts = this.state.rooms.departments || [...new Set(this.state.agents.map((a) => a.room))].map((id) => ({ id, name: id }));
      if (this.carY == null) this.carY = this.office.feet;
    }

    homeRoom() { return this.office; }
    homeX(agent) {
      const i = this.state.agents.findIndex((a) => a.id === agent.id);
      const d = this.office.desks;
      if (i >= 0 && i < d.length) return d[i] - 30;
      return this.office.x + 40 + Math.max(0, i) * 12;
    }
    meetingX(agent) {
      const room = this.rooms.meeting;
      const all = this.state.agents;
      const i = all.findIndex((a) => a.id === agent.id);
      const n = Math.max(2, all.length);
      return Math.round(room.x + 70 + i * ((room.w - 140) / (n - 1)));
    }
    roomAt(r) {
      return Object.values(this.rooms).find((room) => Math.abs(room.feet - r.y) < 3 && r.x >= room.x - 2 && r.x <= room.x + room.w + 2) || null;
    }
    atDesk(r, a) { return !r.path.length && Math.abs(r.y - this.office.feet) < 2 && Math.abs(r.x - this.homeX(a)) < 3; }
    headingHome(r, a) {
      const last = r.path[r.path.length - 1];
      return last && last.x === this.homeX(a) && Math.abs(last.y - this.office.feet) < 2;
    }
    isFree(r) { return r.state === 'idle' && !r.inMeeting && !r.activity && !r.path.length && !r.carrying; }

    syncAgents() {
      const ids = new Set(this.state.agents.map((a) => a.id));
      for (const id of [...this.rt.keys()]) if (!ids.has(id)) this.rt.delete(id);
      for (const a of this.state.agents) {
        let r = this.rt.get(a.id);
        if (!r) {
          // 第一次載入直接坐好；之後新增的員工從地面入口搭電梯報到
          const fresh = !!this.loaded;
          r = {
            id: a.id, x: fresh ? this.shaft.cx : this.homeX(a), y: fresh ? G.surface : this.office.feet,
            path: [], state: 'idle', facing: 1, phase: 0, bubble: null, carrying: false, riding: false,
            inMeeting: false, activity: null, partner: null, nextIdleAt: this.time + 4 + Math.random() * 10,
          };
          this.rt.set(a.id, r);
          if (fresh) {
            this.goTo(a.id, this.office.id, this.homeX(a), [{ wait: 0.2, start: () => { r.bubble = { text: '大家好，我是新來的！請多指教', until: this.time + 4 }; } }]);
          }
        } else if (!r.path.length && !r.inMeeting && !r.activity && !this.atDesk(r, a) && this.roomAt(r) === this.office) {
          this.goTo(a.id, this.office.id, this.homeX(a));
        }
      }
      this.loaded = true;
    }

    agent(id) { return this.state.agents.find((a) => a.id === id); }

    goTo(id, roomId, x, extra) {
      const r = this.rt.get(id);
      const room = this.rooms[roomId];
      if (!r || !room) return;
      const path = [];
      if (Math.abs(r.y - room.feet) > 2) {
        path.push({ x: this.shaft.cx, y: r.y });
        path.push({ x: this.shaft.cx, y: room.feet, ride: true });
      }
      path.push({ x, y: room.feet });
      r.path = path.concat(extra || []);
    }

    endActivity(r) {
      if (!r.activity) return;
      const p = r.partner && this.rt.get(r.partner);
      r.activity = null;
      r.partner = null;
      if (p && p.partner === r.id) { p.activity = null; p.partner = null; }
      r.path = [];
      r.nextIdleAt = this.time + 6 + Math.random() * 8;
    }

    // ---------- 事件 ----------
    onEvent(type, d) {
      if (type === 'run') return;
      const r = d && (d.id || d.from) ? this.rt.get(d.id || d.from) : null;
      if (type === 'agent' && r) {
        r.state = d.state;
        // 有工作就回自己座位（開會中、正在交件的不打斷）
        if (['working', 'thinking', 'talking'].includes(d.state) && !r.inMeeting && !r.carrying) {
          const a = this.agent(r.id);
          this.endActivity(r);
          if (a && !this.atDesk(r, a) && !this.headingHome(r, a)) this.goTo(r.id, this.office.id, this.homeX(a));
        }
      }
      if (type === 'say' && r) {
        // 附近的人先收起泡泡，避免互相蓋住
        this.rt.forEach((o) => { if (o !== r && o.bubble && Math.abs(o.y - r.y) < 3 && Math.abs(o.x - r.x) < 160) o.bubble = null; });
        r.bubble = { text: d.text, until: this.time + 6, work: true };
      }
      if (type === 'move' && r) {
        r.carrying = false;
        this.endActivity(r);
        const a = this.agent(d.id);
        if (d.to === 'meeting' && this.rooms.meeting) { r.inMeeting = true; this.goTo(d.id, 'meeting', this.meetingX(a)); }
        else { r.inMeeting = false; this.goTo(d.id, this.office.id, this.homeX(a)); }
      }
      if (type === 'handoff') {
        const from = this.agent(d.from), to = this.agent(d.to);
        const rf = this.rt.get(d.from);
        if (!from || !to || !rf || rf.inMeeting) return;
        this.endActivity(rf);
        rf.carrying = true;
        // 走到下一位的座位旁，停一下交件，再走回自己座位
        this.goTo(d.from, this.office.id, this.homeX(to) + 38, [
          { wait: 0.8, then: () => {
            rf.carrying = false;
            rf.bubble = { text: `交給你了：${d.label}`, until: this.time + 2.5, work: true };
            const rt2 = this.rt.get(d.to);
            if (rt2) rt2.bubble = { text: '收到！', until: this.time + 2.5, work: true };
            this.goTo(d.from, this.office.id, this.homeX(from));
          } },
        ]);
      }
    }

    // ---------- 閒暇互動（純動畫與預寫台詞，不呼叫 AI） ----------
    idleTick(r) {
      if (!this.isFree(r) || this.time < (r.nextIdleAt || 0)) return;
      r.nextIdleAt = this.time + 9 + Math.random() * 14;
      const a = this.agent(r.id);
      if (!a) return;
      const roll = Math.random();
      const chatting = [...this.rt.values()].filter((x) => x.activity === 'chat').length;
      if (roll < 0.4 && chatting < 4 && this.startChat(r)) return;
      if (roll < 0.62 && this.lounge) return this.startCoffee(r, a);
      if (roll < 0.82) return this.startStroll(r, a);
      if (!r.bubble && Math.random() < 0.35) r.bubble = { text: pick(MUTTER), until: this.time + 2.4 };
    }
    startChat(r) {
      const others = [...this.rt.values()].filter((x) => x !== r && this.isFree(x));
      if (!others.length) return false;
      const p = others[Math.floor(Math.random() * others.length)];
      const room = this.roomAt(p);
      if (!room) return false;
      const side = p.x >= r.x ? -1 : 1;
      const tx = Math.max(room.x + 30, Math.min(room.x + room.w - 30, p.x + side * 32));
      const [q, ans, more] = pick(CHATS);
      r.activity = 'chat'; r.partner = p.id;
      p.activity = 'chat'; p.partner = r.id;
      const say = (who, text, dur) => ({ wait: dur, start: () => {
        r.facing = p.x >= r.x ? 1 : -1;
        p.facing = -r.facing;
        if (text && !(who.bubble && who.bubble.work)) who.bubble = { text, until: this.time + dur - 0.2 };
      } });
      const steps = [say(r, q, 2.8), say(p, ans, 2.8)];
      if (more) steps.push(say(r, more, 2.2));
      steps.push({ wait: 0.1, then: () => {
        if (p.partner === r.id) { p.activity = null; p.partner = null; p.nextIdleAt = this.time + 8 + Math.random() * 10; }
        r.activity = null; r.partner = null;
        const a = this.agent(r.id);
        if (a) this.goTo(r.id, this.office.id, this.homeX(a));
      } });
      this.goTo(r.id, room.id, tx, steps);
      return true;
    }
    startCoffee(r, a) {
      const L = this.lounge;
      r.activity = 'coffee';
      const x = L.x + L.w - 118 + Math.round(Math.random() * 20);
      this.goTo(r.id, L.id, x, [
        { wait: 3.2, start: () => { r.facing = 1; if (!r.bubble) r.bubble = { text: pick(COFFEE), until: this.time + 3 }; } },
        { wait: 0.1, then: () => { r.activity = null; this.goTo(r.id, this.office.id, this.homeX(a)); } },
      ]);
    }
    startStroll(r, a) {
      const room = this.office;
      r.activity = 'stroll';
      const x = Math.max(room.x + 40, Math.min(room.x + room.w - 40, this.homeX(a) + (Math.random() * 260 - 130)));
      this.goTo(r.id, room.id, x, [
        { wait: 2.2, start: () => { if (!r.bubble && Math.random() < 0.6) r.bubble = { text: pick(STROLL), until: this.time + 2 }; } },
        { wait: 0.1, then: () => { r.activity = null; this.goTo(r.id, room.id, this.homeX(a)); } },
      ]);
    }

    // ---------- 更新 ----------
    update(dt) {
      this.time += dt;
      let rideY = null;
      for (const r of this.rt.values()) {
        r.riding = false;
        r.walking = false;
        if (r.path.length) {
          const wp = r.path[0];
          if (wp.wait !== undefined) {
            if (!wp.started) { wp.started = true; if (wp.start) wp.start(); }
            wp.wait -= dt;
            if (wp.wait <= 0) { r.path.shift(); if (wp.then) wp.then(); }
            continue;
          }
          const dx = wp.x - r.x, dy = wp.y - r.y;
          const dist = Math.hypot(dx, dy);
          const sp = (wp.ride ? RIDE : WALK) * dt;
          if (dist <= sp) {
            r.x = wp.x; r.y = wp.y; r.path.shift();
            if (wp.then) wp.then();
          } else {
            r.x += (dx / dist) * sp;
            r.y += (dy / dist) * sp;
          }
          if (Math.abs(dx) > 0.5) { r.facing = dx > 0 ? 1 : -1; r.walking = true; r.phase += dt * 12; }
          if (wp.ride) { r.riding = true; rideY = r.y; }
        } else {
          this.idleTick(r);
          if (r.state === 'working' && !r.activity) r.facing = 1;
        }
      }
      if (rideY !== null) this.carY = rideY;
    }

    // ---------- 繪製 ----------
    resize() {
      const parent = this.canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth, h = parent.clientHeight;
      this.canvas.width = Math.max(1, Math.floor(w * dpr));
      this.canvas.height = Math.max(1, Math.floor(h * dpr));
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      const s = Math.min(w / this.worldW, h / this.worldH);
      this.view = { dpr, s, ox: (w - this.worldW * s) / 2, oy: (h - this.worldH * s) / 2 };
    }

    toWorld(e) {
      const rect = this.canvas.getBoundingClientRect();
      const v = this.view;
      return { x: (e.clientX - rect.left - v.ox) / v.s, y: (e.clientY - rect.top - v.oy) / v.s };
    }

    hit(p) {
      for (const [id, r] of this.rt) if (Math.abs(p.x - r.x) < 18 && p.y < r.y + 4 && p.y > r.y - 62) return id;
      return null;
    }
    hotspotAt(p) {
      return (this.hot || []).find((h) => p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h);
    }
    onClick(e) {
      const p = this.toWorld(e);
      const spot = this.hotspotAt(p);
      if (spot && !this.hit(p)) { if (this.opts.onBoard) this.opts.onBoard(spot.kind, spot.id); return; }
      const id = this.hit(p);
      this.selected = id;
      if (this.opts.onSelect) this.opts.onSelect(id);
    }
    onHover(e) {
      const p = this.toWorld(e);
      this.hover = this.hit(p);
      this.hoverSpot = this.hover ? null : this.hotspotAt(p);
      this.canvas.style.cursor = this.hover || this.hoverSpot ? 'pointer' : 'default';
    }

    draw() {
      const ctx = this.ctx, v = this.view;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#17110d';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(v.s * v.dpr, 0, 0, v.s * v.dpr, v.ox * v.dpr, v.oy * v.dpr);
      ctx.imageSmoothingEnabled = false;

      this.hot = [];
      this.drawSurface(ctx);
      this.drawRock(ctx);
      this.drawShaft(ctx);
      Object.values(this.rooms).forEach((room) => this.drawRoom(ctx, room));
      this.drawCar(ctx);

      const order = [...this.rt.values()].sort((a, b) => a.y - b.y);
      order.forEach((r) => this.drawAgent(ctx, r));
      order.forEach((r) => this.drawOverlay(ctx, r));
    }

    drawSurface(ctx) {
      const W = this.worldW, S = G.surface;
      const g = ctx.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0, '#2c3e5c');
      g.addColorStop(1, '#d99a5e');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, S);
      ctx.fillStyle = '#5a4a5e';
      ctx.beginPath();
      ctx.moveTo(0, S - 10);
      const peaks = [[0.08, 40], [0.2, 22], [0.33, 46], [0.5, 18], [0.66, 38], [0.8, 20], [0.93, 44]];
      peaks.forEach(([fx, h]) => ctx.lineTo(W * fx, S - 10 - h));
      ctx.lineTo(W, S - 10);
      ctx.lineTo(W, S);
      ctx.lineTo(0, S);
      ctx.fill();
      ctx.fillStyle = '#6b8f3e';
      ctx.fillRect(0, S - 10, W, 10);
      ctx.fillStyle = '#4f6e2c';
      for (let x = 0; x < W; x += 9) ctx.fillRect(x, S - 10, 4, 3);
      // 入口
      const ex = this.shaft.x - 6, ew = this.shaft.w + 12;
      ctx.fillStyle = '#3a332c';
      ctx.fillRect(ex, S - 46, ew, 46);
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(ex - 4, S - 52, ew + 8, 10);
      ctx.fillStyle = '#1d1a18';
      ctx.font = `bold 9px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('AI OFFICE', ex + ew / 2, S - 44);
      ctx.fillStyle = '#211c18';
      ctx.fillRect(ex + 12, S - 36, ew - 24, 36);
    }

    drawRock(ctx) {
      ctx.fillStyle = '#3b2a1f';
      ctx.fillRect(0, G.surface, this.worldW, this.worldH - G.surface);
      this.rocks.forEach((k) => { ctx.fillStyle = k.l ? '#4a3627' : '#2e2118'; ctx.fillRect(k.x, k.y, k.s, k.s); });
    }

    drawShaft(ctx) {
      const s = this.shaft;
      ctx.fillStyle = '#16120f';
      ctx.fillRect(s.x, s.top, s.w, s.bottom - s.top);
      ctx.fillStyle = '#2b2520';
      ctx.fillRect(s.x + 8, s.top, 4, s.bottom - s.top);
      ctx.fillRect(s.x + s.w - 12, s.top, 4, s.bottom - s.top);
      Object.values(this.rooms).forEach((r) => {
        ctx.fillStyle = '#4a3d30';
        ctx.fillRect(s.x, r.feet, s.w, 4);
      });
    }

    drawCar(ctx) {
      const s = this.shaft;
      const h = G.floorH - G.gap - 26;
      const y = this.carY - h;
      ctx.fillStyle = 'rgba(201,162,39,0.18)';
      ctx.fillRect(s.x + 4, y, s.w - 8, h + 2);
      ctx.strokeStyle = '#c9a227';
      ctx.lineWidth = 3;
      ctx.strokeRect(s.x + 5.5, y + 1.5, s.w - 11, h);
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(s.cx - 1, s.top, 2, y - s.top);
    }

    drawRoom(ctx, r) {
      // 外框與牆
      ctx.fillStyle = '#120e0b';
      ctx.fillRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      ctx.fillStyle = r.wall;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = shade(r.wall, -12);
      for (let x = r.x + 20; x < r.x + r.w; x += 40) ctx.fillRect(x, r.y + 14, 2, r.h - 32);
      // 天花板與燈
      ctx.fillStyle = '#2a231d';
      ctx.fillRect(r.x, r.y, r.w, 12);
      const lamps = Math.max(1, Math.round(r.w / 220));
      for (let i = 0; i < lamps; i++) {
        const lx = r.x + (r.w / lamps) * (i + 0.5);
        const glow = ctx.createLinearGradient(0, r.y + 12, 0, r.feet);
        glow.addColorStop(0, 'rgba(255,230,160,0.20)');
        glow.addColorStop(1, 'rgba(255,230,160,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.moveTo(lx - 10, r.y + 16);
        ctx.lineTo(lx + 10, r.y + 16);
        ctx.lineTo(lx + 90, r.feet);
        ctx.lineTo(lx - 90, r.feet);
        ctx.fill();
        ctx.fillStyle = '#ffe9a8';
        ctx.fillRect(lx - 10, r.y + 12, 20, 4);
      }
      // 地板
      ctx.fillStyle = '#6b4a2f';
      ctx.fillRect(r.x, r.feet, r.w, G.floorStrip);
      ctx.fillStyle = '#5a3d26';
      for (let x = r.x; x < r.x + r.w; x += 30) ctx.fillRect(x, r.feet + 2, 1, G.floorStrip - 2);
      ctx.fillStyle = '#8a6440';
      ctx.fillRect(r.x, r.feet, r.w, 2);
      // 門（靠電梯那側）
      ctx.fillStyle = shade(r.wall, -30);
      ctx.fillRect(r.x, r.feet - 70, 6, 70);

      this.drawDecor(ctx, r);
      if (r === this.office) this.drawDeptBoards(ctx, r);
      r.desks.forEach((dx, i) => this.drawDesk(ctx, r, dx, i));

      // 名牌
      ctx.font = `bold 13px ${FONT}`;
      const tw = ctx.measureText(r.name).width;
      ctx.fillStyle = 'rgba(18,14,11,0.75)';
      ctx.fillRect(r.x + 12, r.y + 18, tw + 16, 22);
      ctx.fillStyle = '#f3e3c3';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.name, r.x + 20, r.y + 29);
      ctx.textBaseline = 'alphabetic';
    }

    drawDecor(ctx, r) {
      const f = r.feet;
      if (r.id === 'meeting') {
        this.drawOverview(ctx, r);
        ctx.fillStyle = '#5a3a24';
        ctx.fillRect(r.x + 50, f - 24, r.w - 100, 7);
        ctx.fillStyle = '#3e2818';
        ctx.fillRect(r.x + 66, f - 17, 6, 17);
        ctx.fillRect(r.x + r.w - 72, f - 17, 6, 17);
        return;
      }
      if (r.id === 'lounge') {
        const R = r.x + r.w;
        // 吧台與咖啡機
        ctx.fillStyle = '#7a5a3a'; ctx.fillRect(R - 160, f - 30, 120, 30);
        ctx.fillStyle = '#5e4229'; ctx.fillRect(R - 160, f - 30, 120, 4);
        ctx.fillStyle = '#2b2b33'; ctx.fillRect(R - 100, f - 58, 28, 28);
        ctx.fillStyle = '#c94f4f'; ctx.fillRect(R - 94, f - 52, 6, 4);
        ctx.fillStyle = (Math.floor(this.time * 2) % 2) ? '#5cff8a' : '#2f6b44'; ctx.fillRect(R - 82, f - 52, 4, 3);
        ctx.fillStyle = '#f5f0e1'; ctx.fillRect(R - 140, f - 38, 8, 8); ctx.fillRect(R - 128, f - 38, 8, 8);
        // 飲水機
        ctx.fillStyle = '#9fc3e6'; ctx.fillRect(R - 30, f - 62, 16, 18);
        ctx.fillStyle = '#d9d9d9'; ctx.fillRect(R - 32, f - 44, 20, 44);
        // 沙發與小桌
        ctx.fillStyle = '#8f3b4f'; ctx.fillRect(r.x + 70, f - 22, 110, 22); ctx.fillRect(r.x + 64, f - 36, 12, 36); ctx.fillRect(r.x + 174, f - 36, 12, 36);
        ctx.fillStyle = '#a14a5f'; ctx.fillRect(r.x + 76, f - 34, 98, 12);
        ctx.fillStyle = '#5a3a24'; ctx.fillRect(r.x + 210, f - 18, 44, 5); ctx.fillRect(r.x + 228, f - 13, 6, 13);
        // 窗
        ctx.fillStyle = '#20384f'; ctx.fillRect(r.x + 120, r.y + 24, 90, 44);
        ctx.fillStyle = '#e8c27a'; ctx.fillRect(r.x + 126, r.y + 54, 78, 8);
        ctx.fillStyle = '#16120f'; ctx.fillRect(r.x + 164, r.y + 24, 2, 44);
        // 盆栽
        ctx.fillStyle = '#8a4f2f'; ctx.fillRect(r.x + 18, f - 16, 16, 16);
        ctx.fillStyle = '#4f9a5a'; ctx.fillRect(r.x + 14, f - 34, 24, 18); ctx.fillRect(r.x + 20, f - 42, 12, 8);
        return;
      }
      // 辦公室：左邊盆栽、右邊影印機
      ctx.fillStyle = '#8a4f2f'; ctx.fillRect(r.x + 18, f - 16, 16, 16);
      ctx.fillStyle = '#4f9a5a'; ctx.fillRect(r.x + 14, f - 34, 24, 18); ctx.fillRect(r.x + 20, f - 42, 12, 8);
      const R = r.x + r.w;
      ctx.fillStyle = '#c9c9c9'; ctx.fillRect(R - 34, f - 34, 26, 34);
      ctx.fillStyle = '#7a7a82'; ctx.fillRect(R - 34, f - 34, 26, 6);
      ctx.fillStyle = '#f5f0e1'; ctx.fillRect(R - 28, f - 40, 14, 6);
    }

    drawDesk(ctx, r, dx, i) {
      const f = r.feet;
      const owner = this.state.agents[i];
      // 椅子
      ctx.fillStyle = owner ? '#3a3a46' : '#2e2e38';
      ctx.fillRect(dx - 44, f - 22, 14, 4);
      ctx.fillRect(dx - 39, f - 18, 4, 18);
      if (!owner) {
        // 空位：預留給新進員工
        const hov = this.hoverSpot && this.hoverSpot.kind === 'desk' && this.hoverSpot.id === i;
        ctx.fillStyle = '#26262e'; ctx.fillRect(dx - 16, f - 52, 32, 22);
        ctx.fillStyle = '#141820'; ctx.fillRect(dx - 13, f - 49, 26, 16);
        ctx.fillStyle = '#26262e'; ctx.fillRect(dx - 3, f - 30, 6, 4);
        ctx.fillStyle = hov ? '#a8774a' : '#8a5a34'; ctx.fillRect(dx - 30, f - 26, 60, 6);
        ctx.fillStyle = '#5e3d22'; ctx.fillRect(dx - 27, f - 20, 5, 20); ctx.fillRect(dx + 22, f - 20, 5, 20);
        ctx.fillStyle = hov ? '#ffd166' : 'rgba(243,227,195,0.75)';
        ctx.fillRect(dx - 22, f - 70, 44, 14);
        ctx.fillStyle = '#2a211a'; ctx.font = `bold 9px ${FONT}`; ctx.textAlign = 'center';
        ctx.fillText(hov ? '＋新增員工' : '空位', dx, f - 60);
        this.hot.push({ kind: 'desk', id: i, x: dx - 34, y: f - 72, w: 68, h: 72 });
        return;
      }
      const rt = this.rt.get(owner.id);
      const working = rt && this.atDesk(rt, owner) && (rt.state === 'working' || rt.state === 'thinking');
      const eng = this.state.engines[owner.engine];
      ctx.fillStyle = '#26262e';
      ctx.fillRect(dx - 16, f - 52, 32, 22);
      ctx.fillStyle = working ? (eng ? eng.color : '#5cc0ff') : '#1b2430';
      ctx.fillRect(dx - 13, f - 49, 26, 16);
      if (working) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        for (let k = 0; k < 3; k++) ctx.fillRect(dx - 10, f - 46 + k * 4, 6 + ((Math.floor(this.time * 6) + k * 5) % 14), 2);
      }
      ctx.fillStyle = '#26262e';
      ctx.fillRect(dx - 3, f - 30, 6, 4);
      ctx.fillStyle = '#8a5a34';
      ctx.fillRect(dx - 30, f - 26, 60, 6);
      ctx.fillStyle = '#5e3d22';
      ctx.fillRect(dx - 27, f - 20, 5, 20);
      ctx.fillRect(dx + 22, f - 20, 5, 20);
      // 桌上小名牌
      ctx.fillStyle = owner.look && owner.look.shirt ? owner.look.shirt : '#888';
      ctx.fillRect(dx + 8, f - 31, 16, 5);
    }

    drawAgent(ctx, r) {
      const a = this.agent(r.id);
      if (!a) return;
      const working = (r.state === 'working') && !r.path.length;
      drawCharacter(ctx, r.x, r.y, a.look, { facing: r.facing, walkPhase: r.phase, walking: r.walking, working, t: this.time });
      if (r.carrying) {
        ctx.fillStyle = '#f5f0e1';
        ctx.fillRect(r.x + (r.facing > 0 ? 10 : -22), r.y - 34, 12, 15);
        ctx.fillStyle = '#9a9a9a';
        for (let i = 0; i < 3; i++) ctx.fillRect(r.x + (r.facing > 0 ? 12 : -20), r.y - 31 + i * 4, 8, 1);
      }
    }

    drawOverlay(ctx, r) {
      const a = this.agent(r.id);
      if (!a) return;
      const eng = this.state.engines[a.engine] || { color: '#999', label: a.engine };
      const top = r.y - 58;
      // 名牌
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      const label = `${a.name} · ${eng.label}`;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(18,14,11,0.82)';
      ctx.fillRect(r.x - w / 2, top - 16, w, 15);
      ctx.fillStyle = eng.color;
      ctx.fillRect(r.x - w / 2, top - 16, 3, 15);
      ctx.fillStyle = '#f3e3c3';
      ctx.fillText(label, r.x + 1, top - 5);
      const left = this.remainingPct(a.engine);
      if (left != null) {
        ctx.fillStyle = 'rgba(18,14,11,0.82)';
        ctx.fillRect(r.x - w / 2, top - 1, w, 4);
        ctx.fillStyle = left > 50 ? '#6cc16f' : left > 20 ? '#e0b23a' : '#d9614f';
        ctx.fillRect(r.x - w / 2 + 1, top, Math.max(1, (w - 2) * left / 100), 2);
      }

      if (this.selected === r.id || this.hover === r.id) {
        ctx.fillStyle = '#ffd166';
        const by = top - 24 + Math.sin(this.time * 5) * 2;
        ctx.beginPath(); ctx.moveTo(r.x - 6, by); ctx.lineTo(r.x + 6, by); ctx.lineTo(r.x, by + 6); ctx.fill();
      }

      // 狀態
      if (r.state === 'thinking' && !r.bubble) {
        for (let i = 0; i < 3; i++) {
          const yy = top - 24 - Math.max(0, Math.sin(this.time * 6 - i * 0.7)) * 5;
          ctx.fillStyle = '#f3e3c3';
          ctx.beginPath(); ctx.arc(r.x - 8 + i * 8, yy, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (r.state === 'error') {
        ctx.fillStyle = '#e04f4f';
        ctx.beginPath(); ctx.arc(r.x + 16, top - 22, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `bold 12px ${FONT}`; ctx.fillText('!', r.x + 16, top - 18);
      }

      // 對話泡泡
      if (r.bubble && this.time < r.bubble.until) {
        ctx.font = `12px ${FONT}`;
        const lines = this.wrap(ctx, r.bubble.text, 170).slice(0, 3);
        const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
        const bh = lines.length * 16 + 10;
        let bx = Math.max(4, Math.min(this.worldW - bw - 4, r.x - bw / 2));
        const by = top - 24 - bh;
        ctx.fillStyle = '#fffaf0';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = '#120e0b';
        ctx.fillRect(bx, by + bh, bw, 2);
        ctx.fillStyle = '#fffaf0';
        ctx.beginPath(); ctx.moveTo(r.x - 5, by + bh); ctx.lineTo(r.x + 5, by + bh); ctx.lineTo(r.x, by + bh + 7); ctx.fill();
        ctx.fillStyle = '#2a211a';
        ctx.textAlign = 'left';
        lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 18 + i * 16));
      } else if (r.bubble) {
        r.bubble = null;
      }
    }

    // ---------- 任務板 ----------
    setTasks(tasks) { this.tasks = tasks || { projects: [], tasks: [] }; }
    setUsage(usage) { this.usage = usage || {}; }
    remainingPct(engine) {
      const u = this.usage && this.usage[engine];
      if (!u || !u.windows || !u.windows.length) return null;
      const used = Math.max(...u.windows.map((w) => w.usedPct || 0));
      return Math.max(0, 100 - used);
    }
    activeTasks() {
      const t = this.tasks || { projects: [], tasks: [] };
      const done = new Set(t.projects.filter((p) => p.status === 'done').map((p) => p.id));
      return t.tasks.filter((x) => !done.has(x.projectId));
    }
    roomStats(roomId) {
      const ts = this.activeTasks().filter((x) => x.room === roomId);
      const c = { todo: 0, doing: 0, blocked: 0, done: 0 };
      ts.forEach((x) => { c[x.status] = (c[x.status] || 0) + 1; });
      const progress = ts.length ? Math.round(ts.reduce((s, x) => s + (x.status === 'done' ? 100 : x.progress || 0), 0) / ts.length) : 0;
      return { ...c, total: ts.length, progress };
    }
    drawDeptBoards(ctx, r) {
      const n = Math.max(1, this.depts.length);
      const x0 = r.x + 150, avail = r.w - 150 - 20;
      const bw = Math.min(128, Math.floor((avail - (n - 1) * 12) / n));
      const total = n * bw + (n - 1) * 12;
      let x = Math.round(x0 + (avail - total) / 2);
      this.depts.forEach((d) => { this.drawBoard(ctx, x, r.y + 18, bw, d.id, `${d.name}白板`); x += bw + 12; });
    }
    drawBoard(ctx, x, y, w, id, label) {
      const h = 46;
      const st = this.roomStats(id);
      const hov = this.hoverSpot && this.hoverSpot.kind === 'room' && this.hoverSpot.id === id;
      ctx.fillStyle = '#9a8566';
      ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
      ctx.fillStyle = hov ? '#ffffff' : '#ece7da';
      ctx.fillRect(x, y, w, h);
      ctx.font = `bold 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#3a3128';
      ctx.fillText(label, x + 6, y + 13);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#7a6d5c';
      ctx.font = `9px ${FONT}`;
      if (w > 110) ctx.fillText(st.total ? `${st.progress}%` : '', x + w - 6, y + 13);
      const items = [['待辦', st.todo, '#7a6d5c'], ['進行', st.doing, '#3d7fc4'], ['卡住', st.blocked, '#c9483a'], ['完成', st.done, '#3f9a52']];
      ctx.textAlign = 'center';
      const step = (w - 12) / 4;
      items.forEach(([name, n, col], i) => {
        const cx = x + 6 + step * (i + 0.5);
        ctx.fillStyle = n ? col : '#b9b0a0';
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillText(String(n), cx, y + 29);
        ctx.font = `8px ${FONT}`;
        ctx.fillText(name, cx, y + 39);
      });
      ctx.fillStyle = '#d6cfbf';
      ctx.fillRect(x + 6, y + h - 4, w - 12, 2);
      ctx.fillStyle = st.blocked ? '#c9483a' : '#3f9a52';
      ctx.fillRect(x + 6, y + h - 4, (w - 12) * st.progress / 100, 2);
      this.hot.push({ kind: 'room', id, x: x - 3, y: y - 3, w: w + 6, h: h + 6 });
    }
    setRuns(runs) { this.runs = runs || []; }
    drawOverview(ctx, r) {
      const w = Math.min(330, r.w - 80), h = 80;
      const x = Math.round(r.x + r.w / 2 - w / 2 + 20), y = r.y + 18;
      const hov = this.hoverSpot && this.hoverSpot.kind === 'overview';
      ctx.fillStyle = '#2a2a33';
      ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
      ctx.fillStyle = hov ? '#26384a' : '#1c2836';
      ctx.fillRect(x, y, w, h);
      const runs = this.runs || [];
      const live = runs.filter((k) => ['queued', 'running', 'asking'].includes(k.status));
      const asking = live.filter((k) => k.status === 'asking').length;
      const queued = live.filter((k) => k.status === 'queued').length;
      ctx.textAlign = 'left';
      ctx.font = `bold 10px ${FONT}`;
      ctx.fillStyle = '#9fc3e6';
      ctx.fillText('指揮白板', x + 8, y + 13);
      ctx.textAlign = 'right';
      ctx.font = `9px ${FONT}`;
      ctx.fillStyle = asking ? '#ffd166' : '#7f97ad';
      ctx.fillText(`進行中 ${live.length - queued}${queued ? `・排隊 ${queued}` : ''}${asking ? `・待回答 ${asking}` : ''}`, x + w - 8, y + 13);
      const rows = live.slice(0, 3);
      if (!rows.length) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#7f97ad';
        ctx.font = `11px ${FONT}`;
        ctx.fillText('目前沒有進行中的任務', x + w / 2, y + 42);
        ctx.font = `9px ${FONT}`;
        ctx.fillText('點這裡發起任務、管理日常任務', x + w / 2, y + 58);
      }
      rows.forEach((k, i) => {
        const yy = y + 30 + i * 17;
        ctx.textAlign = 'left';
        ctx.font = `10px ${FONT}`;
        ctx.fillStyle = k.status === 'asking' ? '#ffd166' : '#e8eef5';
        let title = k.title || '';
        while (ctx.measureText(title).width > 120 && title.length > 2) title = title.slice(0, -2) + '…';
        ctx.fillText(title, x + 8, yy + 4);
        ctx.fillStyle = '#9fb3c6';
        let st = k.status === 'queued' ? '排隊中' : k.status === 'asking' ? '等你回答' : (k.stepLabel || '');
        while (ctx.measureText(st).width > w - 150 && st.length > 2) st = st.slice(0, -2) + '…';
        ctx.fillText(st, x + 136, yy + 4);
      });
      this.hot.push({ kind: 'overview', id: 'meeting', x: x - 6, y: y - 6, w: w + 12, h: h + 12 });
    }

    wrap(ctx, text, maxW) {
      const out = [];
      let line = '';
      for (const ch of String(text)) {
        if (ch === '\n') { out.push(line); line = ''; continue; }
        if (ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; } else line += ch;
      }
      if (line) out.push(line);
      return out;
    }
  }

  window.Office = Office;
  window.drawCharacter = drawCharacter;
})();
