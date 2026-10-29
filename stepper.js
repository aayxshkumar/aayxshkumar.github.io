// Differential test, step by step.
//
// Two copies of lob-engine's matching rules (ported to JS) replay the same
// orders: one is the reference, the other can have one of the bugs I planted
// in the C++ to check that my tests catch them. The page stops at the first
// step where the two books disagree. Nothing moves until you click.

(() => {
  "use strict";
  const root = document.getElementById("stepper");
  if (!root) return;
  root.hidden = false;

  // A hand-written scenario (prices in ticks of 0.01). The C++ test runs
  // 20,000 random steps; this is short enough to read.
  const OPS = [
    { t: "limit", side: "S", id: 1, px: 10100, qty: 5 },
    { t: "limit", side: "S", id: 2, px: 10100, qty: 3 },
    { t: "limit", side: "B", id: 3, px: 9900, qty: 4 },
    { t: "limit", side: "B", id: 4, px: 9900, qty: 6 },
    { t: "limit", side: "B", id: 5, px: 10000, qty: 2 },
    { t: "limit", side: "B", id: 6, px: 10099, qty: 1 },
    { t: "cancel", id: 3 },
    { t: "modify", id: 1, px: 10100, qty: 8 },
    { t: "limit", side: "B", id: 7, px: 10150, qty: 4 },
    { t: "market", side: "B", id: 8, qty: 2 },
    { t: "limit", side: "S", id: 9, px: 10000, qty: 3 },
  ];

  const BUGS = {
    none: "No bug",
    early: "Limit order crosses one tick early",
    stale: "Cancel leaves a stale level total",
    grow: "Growing an order keeps its queue place",
    taker: "Trades print at the taker's price",
    market: "Market orders obey a zero limit",
  };

  // ---- Engine ---------------------------------------------------------------
  function newBook() {
    return { B: new Map(), S: new Map(), where: new Map(), trades: [] };
  }
  const bestPx = (side) => {
    let b = null;
    for (const p of side.keys()) if (b === null || p > b) b = p;
    return b;
  };
  const bestAskPx = (side) => {
    let b = null;
    for (const p of side.keys()) if (b === null || p < b) b = p;
    return b;
  };

  function match(book, takerId, isBuy, limit, isMarket, qty, bug) {
    const opp = isBuy ? book.S : book.B;
    const tick = bug === "early" ? 1 : 0;
    while (qty > 0) {
      const bp = isBuy ? bestAskPx(opp) : bestPx(opp);
      if (bp === null) break;
      // The planted bug turns "market orders ignore the limit" into
      // "market orders use limit 0", so market buys never fill.
      const ignoreLimit = isMarket && bug !== "market";
      const lim = isMarket && bug === "market" ? 0 : limit;
      if (!ignoreLimit && !(isBuy ? bp <= lim + tick : bp >= lim - tick)) break;
      const lvl = opp.get(bp);
      while (qty > 0 && lvl.q.length) {
        const m = lvl.q[0];
        const fill = Math.min(qty, m.qty);
        book.trades.push({ maker: m.id, taker: takerId, px: bug === "taker" && !isMarket ? limit : bp, qty: fill });
        qty -= fill; m.qty -= fill; lvl.total -= fill;
        if (m.qty === 0) { lvl.q.shift(); book.where.delete(m.id); }
      }
      if (!lvl.q.length) opp.delete(bp);
    }
    return qty;
  }

  function addLimit(book, id, isBuy, px, qty, bug) {
    const rest = match(book, id, isBuy, px, false, qty, bug);
    if (rest > 0) {
      const side = isBuy ? book.B : book.S;
      if (!side.has(px)) side.set(px, { q: [], total: 0 });
      const lvl = side.get(px);
      lvl.q.push({ id, qty: rest });
      lvl.total += rest;
      book.where.set(id, { isBuy, px });
    }
  }

  function cancel(book, id, bug) {
    const w = book.where.get(id);
    if (!w) return;
    const side = w.isBuy ? book.B : book.S;
    const lvl = side.get(w.px);
    const i = lvl.q.findIndex((o) => o.id === id);
    const [o] = lvl.q.splice(i, 1);
    if (bug !== "stale") lvl.total -= o.qty;
    if (!lvl.q.length) side.delete(w.px);
    book.where.delete(id);
  }

  function modify(book, id, px, qty, bug) {
    const w = book.where.get(id);
    if (!w) return;
    const lvl = (w.isBuy ? book.B : book.S).get(w.px);
    const o = lvl.q.find((x) => x.id === id);
    if (px === w.px && (qty <= o.qty || bug === "grow")) {
      lvl.total += qty - o.qty;
      o.qty = qty;
      return;
    }
    cancel(book, id, "none");
    addLimit(book, id, w.isBuy, px, qty, bug);
  }

  function apply(book, op, bug) {
    book.trades = [];
    if (op.t === "limit") addLimit(book, op.id, op.side === "B", op.px, op.qty, bug);
    else if (op.t === "market") match(book, op.id, op.side === "B", 0, true, op.qty, bug);
    else if (op.t === "cancel") cancel(book, op.id, bug);
    else if (op.t === "modify") modify(book, op.id, op.px, op.qty, bug);
  }

  // ---- Comparison -------------------------------------------------------------
  const px = (p) => (p / 100).toFixed(2);
  const opText = (op) => {
    if (op.t === "limit") return `${op.side === "B" ? "Buy" : "Sell"} #${op.id}: ${op.qty} @ ${px(op.px)}`;
    if (op.t === "market") return `Market ${op.side === "B" ? "buy" : "sell"} #${op.id}: ${op.qty}`;
    if (op.t === "cancel") return `Cancel #${op.id}`;
    return `Modify #${op.id} to ${op.qty} @ ${px(op.px)}`;
  };
  const levelKey = (lvl) => `${lvl.total}|${lvl.q.map((o) => o.id + ":" + o.qty).join(",")}`;

  function diff(a, b) {
    const ta = a.trades.map((t) => `#${t.maker}→#${t.taker} ${t.qty}@${px(t.px)}`).join(", ") || "no trades";
    const tb = b.trades.map((t) => `#${t.maker}→#${t.taker} ${t.qty}@${px(t.px)}`).join(", ") || "no trades";
    if (ta !== tb) return { what: "trades", text: `lob-engine printed ${ta}; the reference printed ${tb}.` };
    for (const s of ["S", "B"]) {
      const prices = new Set([...a[s].keys(), ...b[s].keys()]);
      for (const p of [...prices].sort((x, y) => y - x)) {
        const la = a[s].get(p), lb = b[s].get(p);
        const ka = la ? levelKey(la) : "", kb = lb ? levelKey(lb) : "";
        if (ka !== kb) {
          const desc = (l) => (l ? `total ${l.total}, queue ${l.q.map((o) => "#" + o.id).join(" ") || "empty"}` : "no level");
          const cell = la && lb && la.total !== lb.total ? "total" : "queue";
          return { what: "level", side: s, px: p, cell, text: `At ${px(p)}: lob-engine has ${desc(la)}; the reference has ${desc(lb)}.` };
        }
      }
    }
    return null;
  }

  // ---- UI -------------------------------------------------------------------
  const $ = (sel) => root.querySelector(sel);
  const bugSel = $("#bug"), list = $("#ops"), out = $("#verdict");
  const books = { mine: $("#book-mine"), ref: $("#book-ref") };
  let step = 0;

  for (const [k, v] of Object.entries(BUGS)) bugSel.add(new Option(v, k));
  list.innerHTML = OPS.map((op, i) => `<li id="op-${i}">${opText(op)}</li>`).join("");

  function stateAt(n, bug) {
    const mine = newBook(), ref = newBook();
    let first = null;
    for (let i = 0; i < n; i++) {
      apply(mine, OPS[i], bug);
      apply(ref, OPS[i], "none");
      if (!first) {
        const d = diff(mine, ref);
        if (d) first = { step: i + 1, ...d };
      }
    }
    return { mine, ref, first, last: n ? diff(mine, ref) : null };
  }

  function firstDivergence(bug) {
    for (let n = 1; n <= OPS.length; n++) {
      const s = stateAt(n, bug);
      if (s.first) return n;
    }
    return null;
  }

  function renderBook(el, book, d) {
    const rows = [];
    const asks = [...book.S.keys()].sort((a, b) => b - a);
    const bids = [...book.B.keys()].sort((a, b) => b - a);
    const row = (s, p) => {
      const l = book[s].get(p);
      const hit = d && d.what === "level" && d.side === s && d.px === p;
      const bad = hit ? " class=\"bad\"" : "";
      const dt = hit && d.cell === "total" ? " class=\"diff\"" : "";
      const dq = hit && d.cell === "queue" ? " diff" : "";
      return `<tr${bad}><td class="${s === "S" ? "ask" : "bid"}">${s === "S" ? "ask" : "bid"}</td><td>${px(p)}</td><td${dt}>${l.total}</td><td class="q${dq}">${l.q.map((o) => `#${o.id}·${o.qty}`).join(" ")}</td></tr>`;
    };
    for (const p of asks) rows.push(row("S", p));
    if (asks.length && bids.length) rows.push('<tr class="gap"><td colspan="4"></td></tr>');
    for (const p of bids) rows.push(row("B", p));
    const trades = book.trades.length
      ? book.trades.map((t) => `#${t.maker} filled ${t.qty} @ ${px(t.px)}`).join("; ")
      : "none";
    el.querySelector("tbody").innerHTML = rows.join("") || '<tr><td colspan="4" class="mut">empty book</td></tr>';
    const tr = el.querySelector(".trades");
    tr.textContent = `Trades this step: ${trades}`;
    tr.classList.toggle("bad", !!(d && d.what === "trades"));
  }

  function render() {
    const bug = bugSel.value;
    const s = stateAt(step, bug);
    renderBook(books.mine, s.mine, s.last);
    renderBook(books.ref, s.ref, s.last);
    list.querySelectorAll("li").forEach((li, i) => {
      li.classList.toggle("done", i < step);
      if (i === step - 1) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    $("#count").textContent = `Step ${step} of ${OPS.length}`;
    $("#prev").setAttribute("aria-disabled", String(step === 0));
    $("#next").setAttribute("aria-disabled", String(step === OPS.length));
    const where = step ? `Step ${step} of ${OPS.length}, ${opText(OPS[step - 1])}. ` : "";
    if (s.first && s.first.step <= step) {
      out.className = "verdict bad";
      out.textContent = `Step ${s.first.step}, ${opText(OPS[s.first.step - 1])}: the books differ. ${s.first.text}`;
    } else if (step === OPS.length) {
      out.className = "verdict ok";
      out.textContent = where + (bug === "none" ? "All steps match the reference." : "No difference found. This bug survived the scenario.");
    } else {
      out.className = "verdict";
      out.textContent = step === 0 ? "Press Next (or the → key), or Run to first difference." : where + "The books match so far.";
    }
  }

  const go = (n) => { step = Math.max(0, Math.min(OPS.length, n)); render(); };
  $("#prev").addEventListener("click", () => go(step - 1));
  $("#next").addEventListener("click", () => go(step + 1));
  root.addEventListener("keydown", (e) => {
    if (e.target === bugSel || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight") { go(step + 1); e.preventDefault(); }
    if (e.key === "ArrowLeft") { go(step - 1); e.preventDefault(); }
  });
  $("#run").addEventListener("click", () => { step = firstDivergence(bugSel.value) ?? OPS.length; render(); });
  $("#reset").addEventListener("click", () => { step = 0; render(); });
  bugSel.addEventListener("change", () => { step = 0; render(); });
  render();
})();
