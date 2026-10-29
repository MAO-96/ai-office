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

  // ---------- 辦公室 ----------
  class Office {
    constructor(canvas, state, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.rt = new Map();
      this.time = 0;
      this.running = false;
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
      floors.forEach((rooms, f) => {
        const y = G.surface + f * G.floorH;
        let x = roomsX;
        rooms.forEach((r) => {
          const w = r.wide ? G.roomW * 2 + G.gap : G.roomW;
          const h = G.floorH - G.gap;
          const n = r.desks || 0;
          const desks = [];
          for (let i = 0; i < n; i++) desks.push(Math.round(x + 110 + i * ((w - 150) / Math.max(1, n))));
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
      this.carY = this.rooms[Object.keys(this.rooms)[0]].feet;
    }

    homeRoom(agent) {
      if (this.rooms[agent.room] && agent.room !== 'meeting') return this.rooms[agent.room];
      return Object.values(this.rooms).find((r) => r.id !== 'meeting');
    }

    homeX(agent) {
      const room = this.homeRoom(agent);
      const mates = this.state.agents.filter((a) => this.homeRoom(a) === room);
      const i = mates.findIndex((a) => a.id === agent.id);
      if (i < room.desks.length) return room.desks[i] - 30;
      return room.x + 50 + (i - room.desks.length) * 46;
    }

    meetingX(agent) {
      const room = this.rooms.meeting;
      const all = this.state.agents;
      const i = all.findIndex((a) => a.id === agent.id);
      const n = Math.max(2, all.length);
      return Math.round(room.x + 120 + i * ((room.w - 240) / (n - 1)));
    }

    syncAgents() {
      const ids = new Set(this.state.agents.map((a) => a.id));
      for (const id of [...this.rt.keys()]) if (!ids.has(id)) this.rt.delete(id);
      for (const a of this.state.agents) {
        const room = this.homeRoom(a);
        let r = this.rt.get(a.id);
        if (!r) {
          r = { id: a.id, x: this.homeX(a), y: room.feet, path: [], state: 'idle', facing: 1, phase: 0, bubble: null, carrying: false, wanderAt: Math.random() * 6, riding: false };
          this.rt.set(a.id, r);
        } else if (!this.running && r.path.length === 0) {
          this.goTo(a.id, room.id, this.homeX(a));
        }
      }
    }

    agent(id) { return this.state.agents.find((a) => a.id === id); }

    floorOfY(y) {
      let best = 0, d = Infinity;
      Object.values(this.rooms).forEach((r) => { const k = Math.abs(r.feet - y); if (k < d) { d = k; best = r.floor; } });
      return best;
    }

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

    // ---------- 事件 ----------
    onEvent(type, d) {
      if (type === 'run') {
        if (d.status === 'started') this.running = true;
        if (d.status === 'finished' || d.status === 'failed' || d.status === 'stopped') this.running = false;
        return;
      }
      const r = d && (d.id || d.from) ? this.rt.get(d.id || d.from) : null;
      if (type === 'agent' && r) r.state = d.state;
      if (type === 'say' && r) {
        // 同一時間只留一個發言泡泡，避免會議時互相蓋住
        this.rt.forEach((o) => { if (o !== r) o.bubble = null; });
        r.bubble = { text: d.text, until: this.time + 6 };
      }
      if (type === 'move' && r) {
        r.carrying = false;
        const a = this.agent(d.id);
        if (d.to === 'meeting' && this.rooms.meeting) this.goTo(d.id, 'meeting', this.meetingX(a));
        else this.goTo(d.id, this.homeRoom(a).id, this.homeX(a));
      }
      if (type === 'handoff') {
        const from = this.agent(d.from), to = this.agent(d.to);
        const rf = this.rt.get(d.from);
        if (!from || !to || !rf) return;
        rf.carrying = true;
        const toRoom = this.homeRoom(to);
        const targetX = this.homeX(to) + 38;
        const home = this.homeRoom(from);
        // 走到下一位的座位旁，停一下交件，再走回自己座位
        this.goTo(d.from, toRoom.id, targetX, [
          { wait: 0.8, then: () => {
            rf.carrying = false;
            rf.bubble = { text: `交給你了：${d.label}`, until: this.time + 2.5 };
            const rt2 = this.rt.get(d.to);
            if (rt2) rt2.bubble = { text: '收到！', until: this.time + 2.5 };
            this.goTo(d.from, home.id, this.homeX(from));
          } },
        ]);
      }
    }

    // ---------- 更新 ----------
    update(dt) {
      this.time += dt;
      let rideY = null;
      for (const [id, r] of this.rt) {
        r.riding = false;
        r.walking = false;
        if (r.path.length) {
          const wp = r.path[0];
          if (wp.wait !== undefined) {
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
        } else if (!this.running && r.state === 'idle' && this.time > r.wanderAt) {
          // 閒置時在自己房間小範圍走動
          const a = this.agent(id);
          if (a) {
            const room = this.homeRoom(a);
            if (Math.abs(r.y - room.feet) < 2) {
              const hx = this.homeX(a);
              const nx = Math.max(room.x + 30, Math.min(room.x + room.w - 30, hx + (Math.random() * 120 - 60)));
              r.path = [{ x: nx, y: room.feet }, { wait: 1.5 + Math.random() * 2 }, { x: hx, y: room.feet }];
            }
          }
          r.wanderAt = this.time + 6 + Math.random() * 10;
        }
        if (r.state === 'working' && !r.path.length) {
          const a = this.agent(id);
          if (a) r.facing = 1;
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
        glow.addColorStop(0, 'rgba(255,230,160,0.22)');
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
      if (r.id !== 'meeting') this.drawBoard(ctx, r);
      r.desks.forEach((dx) => this.drawDesk(ctx, r, dx));

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
      const right = r.x + r.w - 36;
      if (r.id === 'meeting') {
        // 長桌 + 大螢幕
        this.drawOverview(ctx, r);
        ctx.fillStyle = '#5a3a24';
        ctx.fillRect(r.x + 80, f - 24, r.w - 160, 7);
        ctx.fillStyle = '#3e2818';
        ctx.fillRect(r.x + 96, f - 17, 6, 17);
        ctx.fillRect(r.x + r.w - 102, f - 17, 6, 17);
        return;
      }
      if (r.id === 'planning') {
        // 檔案櫃
        ctx.fillStyle = '#8a6f4a'; ctx.fillRect(right - 16, f - 58, 34, 58);
        ctx.fillStyle = '#6e573a'; ctx.fillRect(right - 12, f - 52, 26, 22); ctx.fillRect(right - 12, f - 26, 26, 22);
        ctx.fillStyle = '#d9c9a3'; ctx.fillRect(right - 3, f - 43, 8, 3); ctx.fillRect(right - 3, f - 17, 8, 3);
      } else if (r.id === 'research') {
        ctx.fillStyle = '#4a3020'; ctx.fillRect(right - 30, f - 90, 50, 90);
        const cols = ['#c94f4f', '#4f7ac9', '#d9a43b', '#4f9a5a', '#8a5ab0'];
        for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) {
          ctx.fillStyle = cols[(i + row) % cols.length];
          ctx.fillRect(right - 26 + i * 7, f - 84 + row * 28, 5, 22);
        }
      } else if (r.id === 'dev') {
        ctx.fillStyle = '#1e1e26'; ctx.fillRect(right - 14, f - 100, 36, 100);
        for (let i = 0; i < 8; i++) {
          ctx.fillStyle = (Math.floor(this.time * 4 + i) % 3 === 0) ? '#5cff8a' : '#2f6b44';
          ctx.fillRect(right - 8, f - 94 + i * 11, 4, 3);
          ctx.fillStyle = '#33333f'; ctx.fillRect(right, f - 94 + i * 11, 18, 6);
        }
      } else if (r.id === 'review') {
        ctx.fillStyle = '#6e7380'; ctx.fillRect(right - 20, f - 72, 40, 72);
        for (let i = 0; i < 3; i++) { ctx.fillStyle = '#4e525c'; ctx.fillRect(right - 16, f - 66 + i * 23, 32, 18); ctx.fillStyle = '#c9c9c9'; ctx.fillRect(right - 4, f - 59 + i * 23, 8, 3); }
      }
      // 盆栽
      ctx.fillStyle = '#8a4f2f'; ctx.fillRect(r.x + 18, f - 16, 16, 16);
      ctx.fillStyle = '#4f9a5a'; ctx.fillRect(r.x + 14, f - 34, 24, 18); ctx.fillRect(r.x + 20, f - 42, 12, 8);
    }

    drawDesk(ctx, r, dx) {
      const f = r.feet;
      const user = [...this.rt.values()].find((a) => Math.abs(a.y - f) < 3 && Math.abs(a.x - (dx - 30)) < 8 && !a.path.length);
      const working = user && (user.state === 'working' || user.state === 'thinking');
      const ag = user && this.agent(user.id);
      const eng = ag && this.state.engines[ag.engine];
      // 螢幕
      ctx.fillStyle = '#26262e';
      ctx.fillRect(dx - 16, f - 52, 32, 22);
      ctx.fillStyle = working ? (eng ? eng.color : '#5cc0ff') : '#1b2430';
      ctx.fillRect(dx - 13, f - 49, 26, 16);
      if (working) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        for (let i = 0; i < 3; i++) ctx.fillRect(dx - 10, f - 46 + i * 4, 6 + ((Math.floor(this.time * 6) + i * 5) % 14), 2);
      }
      ctx.fillStyle = '#26262e';
      ctx.fillRect(dx - 3, f - 30, 6, 4);
      // 桌子
      ctx.fillStyle = '#8a5a34';
      ctx.fillRect(dx - 30, f - 26, 60, 6);
      ctx.fillStyle = '#5e3d22';
      ctx.fillRect(dx - 27, f - 20, 5, 20);
      ctx.fillRect(dx + 22, f - 20, 5, 20);
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
    drawBoard(ctx, r) {
      const w = 132, h = 48;
      const x = Math.round(r.x + r.w / 2 - w / 2), y = r.y + 16;
      const st = this.roomStats(r.id);
      const hov = this.hoverSpot && this.hoverSpot.id === r.id;
      ctx.fillStyle = '#9a8566';
      ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
      ctx.fillStyle = hov ? '#ffffff' : '#ece7da';
      ctx.fillRect(x, y, w, h);
      ctx.font = `bold 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#3a3128';
      ctx.fillText('白板', x + 6, y + 13);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#7a6d5c';
      ctx.font = `9px ${FONT}`;
      ctx.fillText(st.total ? `進度 ${st.progress}%` : '點我新增任務', x + w - 6, y + 13);
      const items = [['待辦', st.todo, '#7a6d5c'], ['進行', st.doing, '#3d7fc4'], ['卡住', st.blocked, '#c9483a'], ['完成', st.done, '#3f9a52']];
      ctx.textAlign = 'center';
      items.forEach(([name, n, col], i) => {
        const cx = x + 18 + i * 32;
        ctx.fillStyle = n ? col : '#b9b0a0';
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillText(String(n), cx, y + 30);
        ctx.font = `8px ${FONT}`;
        ctx.fillText(name, cx, y + 40);
      });
      ctx.fillStyle = '#d6cfbf';
      ctx.fillRect(x + 6, y + h - 5, w - 12, 2);
      ctx.fillStyle = st.blocked ? '#c9483a' : '#3f9a52';
      ctx.fillRect(x + 6, y + h - 5, (w - 12) * st.progress / 100, 2);
      this.hot.push({ kind: 'room', id: r.id, x: x - 3, y: y - 3, w: w + 6, h: h + 6 });
    }
    drawOverview(ctx, r) {
      const w = 300, h = 76;
      const x = Math.round(r.x + r.w / 2 - w / 2), y = r.y + 20;
      const hov = this.hoverSpot && this.hoverSpot.kind === 'overview';
      ctx.fillStyle = '#2a2a33';
      ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
      ctx.fillStyle = hov ? '#26384a' : '#1c2836';
      ctx.fillRect(x, y, w, h);
      const t = this.tasks || { projects: [], tasks: [] };
      const active = t.projects.filter((p) => p.status !== 'done');
      const doneN = t.projects.length - active.length;
      ctx.textAlign = 'left';
      ctx.font = `bold 10px ${FONT}`;
      ctx.fillStyle = '#9fc3e6';
      ctx.fillText('專案總覽', x + 8, y + 13);
      ctx.textAlign = 'right';
      ctx.font = `9px ${FONT}`;
      ctx.fillStyle = '#7f97ad';
      ctx.fillText(`進行中 ${active.length}・已完成 ${doneN}${this.running ? '・執行中…' : ''}`, x + w - 8, y + 13);
      const rows = active.slice(0, 3);
      if (!rows.length) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#7f97ad';
        ctx.font = `11px ${FONT}`;
        ctx.fillText('目前沒有進行中的專案', x + w / 2, y + 46);
      }
      rows.forEach((p, i) => {
        const ts = t.tasks.filter((k) => k.projectId === p.id);
        const prog = ts.length ? Math.round(ts.reduce((s, k) => s + (k.status === 'done' ? 100 : k.progress || 0), 0) / ts.length) : 0;
        const yy = y + 28 + i * 16;
        ctx.textAlign = 'left';
        ctx.font = `10px ${FONT}`;
        ctx.fillStyle = p.status === 'blocked' ? '#ff9b8a' : '#e8eef5';
        let title = p.title;
        while (ctx.measureText(title).width > 130 && title.length > 2) title = title.slice(0, -2) + '…';
        ctx.fillText(title, x + 8, yy + 4);
        ctx.fillStyle = '#33465a';
        ctx.fillRect(x + 146, yy - 3, 110, 6);
        ctx.fillStyle = p.status === 'blocked' ? '#d9614f' : '#6cc16f';
        ctx.fillRect(x + 146, yy - 3, 110 * prog / 100, 6);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#c9d6e3';
        ctx.fillText(p.status === 'blocked' ? '卡住' : `${prog}%`, x + w - 8, yy + 4);
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
