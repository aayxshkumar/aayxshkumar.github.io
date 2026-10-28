// A tiny price-time-priority order book, the same matching rules as
// lob-engine (github.com/aayxshkumar/lob-engine), fed with simulated flow.
// It runs at a calm ~7 updates/s, pauses when off-screen or in a hidden tab,
// and stays still for prefers-reduced-motion.

(() => {
  "use strict";

  const TICK = 0.01;      // price display: ticks -> currency
  const LEVELS = 6;       // levels shown per side
  const ladder = document.getElementById("ladder");
  if (!ladder) return;

  // ---- Book ----------------------------------------------------------------
  // Each side: Map<price, Array<{id, qty}>> (FIFO queue per level).
  const bids = new Map();
  const asks = new Map();
  let nextId = 1, ops = 0, fills = 0;
  let lastTradePx = null;
  const tape = [];

  const best = (side) => {
    let b = null;
    for (const p of side.keys()) if (b === null || (side === bids ? p > b : p < b)) b = p;
    return b;
  };

  function addLimit(isBuy, px, qty) {
    ops++;
    const book = isBuy ? asks : bids;
    while (qty > 0) {
      const bp = best(book);
      if (bp === null || (isBuy ? bp > px : bp < px)) break;
      const q = book.get(bp);
      while (qty > 0 && q.length) {
        const maker = q[0];
        const fill = Math.min(qty, maker.qty);
        qty -= fill; maker.qty -= fill;
        trade(isBuy, bp, fill);
        if (maker.qty === 0) q.shift();
      }
      if (!q.length) book.delete(bp);
    }
    if (qty > 0) {
      const side = isBuy ? bids : asks;
      if (!side.has(px)) side.set(px, []);
      side.get(px).push({ id: nextId++, qty });
    }
  }

  function cancelRandom() {
    ops++;
    const side = Math.random() < 0.5 ? bids : asks;
    const prices = [...side.keys()];
    if (!prices.length) return;
    const px = prices[(Math.random() * prices.length) | 0];
    const q = side.get(px);
    q.splice((Math.random() * q.length) | 0, 1);
    if (!q.length) side.delete(px);
  }

  function trade(isBuy, px, qty) {
    fills++;
    lastTradePx = px;
    tape.unshift({ isBuy, px, qty });
    if (tape.length > 4) tape.pop();
  }

  // ---- Simulated flow ------------------------------------------------------
  // The fair value drifts as a random walk; makers quote passively around it,
  // takers occasionally cross. Enough to look and behave like a real book.
  let fair = 10_000;
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const size = () => [1, 2, 5, 10, 10, 20, 25, 50, 100][rnd(0, 8)];

  function step() {
    fair += Math.random() < 0.5 ? -1 : 1;
    for (let i = 0; i < 6; i++) {
      const r = Math.random();
      const isBuy = Math.random() < 0.5;
      if (r < 0.55) {
        const off = rnd(1, 7);
        addLimit(isBuy, isBuy ? fair - off : fair + off, size());
      } else if (r < 0.88) {
        cancelRandom();
      } else {
        // Aggressive order that crosses one or two levels.
        addLimit(isBuy, isBuy ? fair + rnd(1, 3) : fair - rnd(1, 3), size());
      }
    }
    // Keep the book bounded so stale far levels don't pile up.
    for (const side of [bids, asks]) {
      for (const p of side.keys()) if (Math.abs(p - fair) > 25) side.delete(p);
    }
  }

  // ---- Rendering -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const midEl = $("mid"), spEl = $("spread"), opsEl = $("ops"), fillsEl = $("fills"), tapeEl = $("tape");
  const fmt = (p) => (p * TICK).toFixed(2);
  const total = (q) => q.reduce((s, o) => s + o.qty, 0);
  const nf = new Intl.NumberFormat("en-US");

  // Build fixed rows once (asks on top, gap, bids below) and update in place.
  const rows = [];
  function makeRow(cls) {
    const li = document.createElement("li");
    li.className = "lvl " + cls;
    li.innerHTML = '<span class="lvl__bar"></span><span class="lvl__bq"></span><span class="lvl__px"></span><span class="lvl__aq"></span>';
    ladder.appendChild(li);
    return li;
  }
  for (let i = 0; i < LEVELS; i++) rows.push(makeRow("lvl--ask"));
  const gap = document.createElement("li");
  gap.className = "lvl lvl--gap";
  gap.setAttribute("aria-hidden", "true");
  ladder.appendChild(gap);
  for (let i = 0; i < LEVELS; i++) rows.push(makeRow("lvl--bid"));

  let lastMid = null;
  const prevQty = new Map();

  function render() {
    const askPx = [...asks.keys()].sort((a, b) => a - b).slice(0, LEVELS).reverse();
    const bidPx = [...bids.keys()].sort((a, b) => b - a).slice(0, LEVELS);
    const depths = [...askPx.map((p) => total(asks.get(p))), ...bidPx.map((p) => total(bids.get(p)))];
    const max = Math.max(1, ...depths);

    const paint = (row, px, qty, isAsk, isBest) => {
      const [bar, bq, pxEl, aq] = row.children;
      if (px === undefined) {
        bar.style.setProperty("--w", 0); bq.textContent = ""; pxEl.textContent = ""; aq.textContent = "";
        row.removeAttribute("aria-label");
        return;
      }
      bar.style.setProperty("--w", (qty / max).toFixed(3));
      bq.textContent = isAsk ? "" : nf.format(qty);
      aq.textContent = isAsk ? nf.format(qty) : "";
      pxEl.textContent = fmt(px);
      row.classList.toggle("lvl--best", isBest);
      row.setAttribute("aria-label", `${isAsk ? "Ask" : "Bid"} ${fmt(px)}, size ${qty}`);
      const key = (isAsk ? "a" : "b") + px;
      if (prevQty.has(key) && prevQty.get(key) !== qty) {
        row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
      }
      prevQty.set(key, qty);
    };

    // Asks: pad from the top so the best ask sits right above the gap.
    const pad = LEVELS - askPx.length;
    for (let i = 0; i < LEVELS; i++) {
      const p = askPx[i - pad];
      paint(rows[i], p, p === undefined ? 0 : total(asks.get(p)), true, i === LEVELS - 1);
    }
    for (let i = 0; i < LEVELS; i++) {
      const p = bidPx[i];
      paint(rows[LEVELS + i], p, p === undefined ? 0 : total(bids.get(p)), false, i === 0);
    }
    if (prevQty.size > 400) prevQty.clear();

    const bb = bidPx[0], ba = askPx[askPx.length - 1];
    if (bb !== undefined && ba !== undefined) {
      const mid = (bb + ba) / 2;
      midEl.textContent = (mid * TICK).toFixed(3);
      spEl.textContent = fmt(ba - bb);
      midEl.classList.toggle("up", lastMid !== null && mid > lastMid);
      midEl.classList.toggle("dn", lastMid !== null && mid < lastMid);
      lastMid = mid;
    }
    opsEl.textContent = nf.format(ops);
    fillsEl.textContent = nf.format(fills);

    tapeEl.innerHTML = tape
      .map((t) => `<li><span class="${t.isBuy ? "b" : "s"}">${t.isBuy ? "BUY " : "SELL"}</span><span>${nf.format(t.qty)}</span><span>@ ${fmt(t.px)}</span></li>`)
      .join("");
  }

  // ---- Loop control ----------------------------------------------------------
  const bookEl = document.querySelector(".book");
  const toggle = $("book-toggle");
  const status = $("book-status");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let userPaused = reduced.matches, visible = true, timer = null;

  function setRunning() {
    const run = !userPaused && visible && !document.hidden;
    if (run && !timer) timer = setInterval(() => { step(); render(); }, 140);
    if (!run && timer) { clearInterval(timer); timer = null; }
    bookEl.classList.toggle("is-paused", !run);
    status.textContent = run ? "Live" : "Paused";
    toggle.textContent = userPaused ? "Resume" : "Pause";
  }

  toggle.addEventListener("click", () => {
    userPaused = !userPaused;
    if (userPaused) { step(); render(); } // let a paused user still see one fresh frame
    setRunning();
  });
  document.addEventListener("visibilitychange", setRunning);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; setRunning(); }).observe(bookEl);
  }

  // Warm the book up so the first frame already has depth.
  for (let i = 0; i < 120; i++) step();
  render();
  setRunning();

  // ---- Theme toggle ----------------------------------------------------------
  const themeBtn = document.querySelector(".theme");
  themeBtn?.addEventListener("click", () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = isDark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (e) {}
  });

  const y = $("year");
  if (y) y.textContent = new Date().getFullYear();
})();
