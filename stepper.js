// Differential test, step by step.
//
// Two copies of lob-engine's matching rules (ported to JS) replay the same
// orders: one is the reference, the other can have one of the bugs I planted
// in the C++ to check that my tests catch them. The page stops at the first
// step where the two books disagree. Nothing moves until you click.
//
// The state is linkable: #bug=2&step=7 opens that bug at that step. It is
// written with history.replaceState, so stepping adds no history entries.

(() => {
  "use strict";
  const root = document.getElementById("stepper");
  if (!root) return;
  root.hidden = false;
  root.tabIndex = -1;   // a click inside keeps focus here, so the arrow keys keep working

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
    taker: "Trades print at the taker’s price",
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
  // Fills summed by price, in the order they printed: "4 @ 101.50".
  const fills = (book) => {
    const by = new Map();
    for (const t of book.trades) by.set(t.px, (by.get(t.px) || 0) + t.qty);
    return [...by].map(([p, q]) => `${q} \u2060@ \u2060${px(p)}`).join(" and ");
  };
  const sideName = (s) => (s === "S" ? "ask" : "bid");

  function diff(a, b) {
    const ta = fills(a), tb = fills(b);
    if (ta !== tb) {
      const mine = ta ? `lob-engine traded ${ta}` : "lob-engine didn’t trade";
      const ref = tb ? `the reference traded ${tb}` : "the reference didn’t";
      return { what: "trades", text: `${mine}; ${ref}.` };
    }
    for (const s of ["S", "B"]) {
      const prices = new Set([...a[s].keys(), ...b[s].keys()]);
      for (const p of [...prices].sort((x, y) => y - x)) {
        const la = a[s].get(p), lb = b[s].get(p);
        const ka = la ? levelKey(la) : "", kb = lb ? levelKey(lb) : "";
        if (ka === kb) continue;
        const at = `${sideName(s)} ${px(p)}`;
        if (!la || !lb) {
          const has = la ? "lob-engine" : "the reference", hasnt = la ? "the reference" : "lob-engine";
          const l = la || lb;
          return { what: "level", side: s, px: p, cell: "total", text: `${has} has a ${at} level, total ${l.total}; ${hasnt} has none.` };
        }
        if (la.total !== lb.total)
          return { what: "level", side: s, px: p, cell: "total", text: `at ${at}, lob-engine’s total is ${la.total}; the reference’s is ${lb.total}.` };
        const q = (l) => l.q.map((o) => "#" + o.id).join(" ");
        return { what: "level", side: s, px: p, cell: "queue", text: `at ${at}, lob-engine’s queue is ${q(la)}; the reference’s is ${q(lb)}.` };
      }
    }
    return null;
  }

  // ---- UI -------------------------------------------------------------------
  const $ = (sel) => root.querySelector(sel);
  const bugSel = $("#bug"), list = $("#ops"), out = $("#verdict");
  const table = $("#book");
  const keys = Object.keys(BUGS);
  const N = OPS.length;
  let step = 0;

  for (const [k, v] of Object.entries(BUGS)) bugSel.add(new Option(v, k));
  list.innerHTML = OPS.map((op, i) => `<li id="op-${i}"><span class="n">${i + 1}</span><span>${opText(op)}</span></li>`).join("");

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
    for (let n = 1; n <= N; n++) if (stateAt(n, bug).first) return n;
    return null;
  }

  // One table: lob-engine on the left, the reference on the right, and a
  // match column between them. Rows are the union of both books' levels.
  const EQ = '<span aria-hidden="true">=</span><span class="vh">matches</span>';
  const NE = '<span aria-hidden="true">≠</span><span class="vh">differs</span>';
  const queue = (l) => (l ? l.q.map((o) => `<span>#${o.id} (${o.qty})</span>`).join(" ") : "–");
  const spread = (b) => {
    const a = bestAskPx(b.S), d = bestPx(b.B);
    return a === null || d === null ? "one-sided" : ((a - d) / 100).toFixed(2);
  };

  function renderTable(mine, ref, d) {
    let first = true;
    const row = (s, p) => {
      const la = mine[s].get(p), lb = ref[s].get(p);
      const same = (la ? levelKey(la) : "") === (lb ? levelKey(lb) : "");
      const hit = d && d.what === "level" && d.side === s && d.px === p;
      const bad = !same && first && hit;
      if (bad) first = false;
      const dt = bad && d.cell === "total" ? ' class="diff"' : "";
      const dq = bad && d.cell === "queue" ? " diff" : "";
      return `<tr${bad ? ' class="bad"' : ""}><th scope="row" class="${sideName(s)}">${sideName(s)}</th><th scope="row">${px(p)}</th>` +
        `<td${dt}>${la ? la.total : "–"}</td><td class="q${dq}">${queue(la)}</td>` +
        `<td class="eq${same ? "" : " ne"}">${same ? EQ : NE}</td>` +
        `<td${dt}>${lb ? lb.total : "–"}</td><td class="q${dq}">${queue(lb)}</td></tr>`;
    };
    const prices = (s) => [...new Set([...mine[s].keys(), ...ref[s].keys()])].sort((a, b) => b - a);
    const asks = prices("S"), bids = prices("B");
    const rows = asks.map((p) => row("S", p));
    if (asks.length || bids.length) {
      const sa = spread(mine), sb = spread(ref);
      rows.push(`<tr class="spread"><th scope="row">spread</th><td></td><td>${sa}</td><td></td>` +
        `<td class="eq${sa === sb ? "" : " ne"}">${sa === sb ? EQ : NE}</td><td>${sb}</td><td></td></tr>`);
    }
    rows.push(...bids.map((p) => row("B", p)));
    table.tBodies[0].innerHTML = rows.join("") || '<tr><td colspan="7" class="mut">Both books are empty.</td></tr>';
    const fa = fills(mine) || "none", fb = fills(ref) || "none";
    const tbad = !!(d && d.what === "trades");
    table.tFoot.innerHTML = `<tr${tbad ? ' class="bad"' : ""}><th scope="row">trades</th><td colspan="3">${fa}</td>` +
      `<td class="eq${fa === fb ? "" : " ne"}">${fa === fb ? EQ : NE}</td><td colspan="2">${fb}</td></tr>`;
  }

    function render(write) {
    const bug = bugSel.value;
    const s = stateAt(step, bug);
    renderTable(s.mine, s.ref, s.last);
    list.querySelectorAll("li").forEach((li, i) => {
      li.classList.toggle("done", i < step);
      if (i === step - 1) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    $("#prev").setAttribute("aria-disabled", String(step === 0));
    $("#reset").setAttribute("aria-disabled", String(step === 0));
    $("#next").setAttribute("aria-disabled", String(step === N));
    const where = step ? `Step ${step} of ${N}. ${opText(OPS[step - 1])}.` : "";
    let text, bad = false;
    if (s.first && s.first.step === step) {
      text = `${where} The books differ: ${s.first.text}`; bad = true;
    } else if (s.first && s.first.step < step) {
      text = `${where} The books first differed at step ${s.first.step}: ${s.first.text}`; bad = true;
    } else if (step === N) {
      text = `${where} ` + (bug === "none" ? `All ${N} steps match the reference.` : `No difference in ${N} steps: this bug survives the scenario.`);
    } else if (step === 0) {
      const what = bug === "none" ? "No bug planted." : `Planted: ${BUGS[bug].charAt(0).toLowerCase() + BUGS[bug].slice(1)}.`;
      text = `${what} Step 0 of ${N}. Press Next or →, or Run to first difference.`;
    } else {
      text = `${where} The books match so far.`;
    }
    out.className = bad ? "verdict bad" : "verdict";
    out.textContent = text;
    if (write) {
      try { history.replaceState(history.state, "", `#bug=${keys.indexOf(bug)}&step=${step}`); } catch (e) { /* file:// in some browsers */ }
    }
  }

  const go = (n) => { step = Math.max(0, Math.min(N, n)); render(true); };
  $("#prev").addEventListener("click", () => go(step - 1));
  $("#next").addEventListener("click", () => go(step + 1));
  $("#reset").addEventListener("click", () => go(0));
  $("#run").addEventListener("click", () => go(firstDivergence(bugSel.value) ?? N));
  bugSel.addEventListener("change", () => go(0));
  root.addEventListener("keydown", (e) => {
    if (e.target === bugSel || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = { ArrowRight: step + 1, ArrowLeft: step - 1, Home: 0, End: N }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    go(to);
  });

  // Read a linked state (#bug=2&step=7) on load, and when such a link is followed on this page.
  function fromHash() {
    const m = /^#bug=(\d+)&step=(\d+)$/.exec(location.hash);
    if (m && keys[+m[1]]) { bugSel.value = keys[+m[1]]; step = Math.min(N, +m[2]); }
    return !!m;
  }
  // Each "caught at step" cell in the static table links to that bug at that step.
  // Added here, not in the HTML: without JavaScript the stepper is hidden and the link would be dead.
  document.querySelectorAll("#bugs tbody tr").forEach((tr) => {
    const k = keys.findIndex((key) => BUGS[key] === tr.cells[0].textContent.trim());
    const cell = tr.cells[1], m = /^(\d+)/.exec(cell.textContent);
    if (k > 0 && m) {
      cell.innerHTML = `<a href="#bug=${k}&step=${m[1]}">${cell.textContent}</a>`;
      // Following the link that is already in the address bar fires no hashchange, so handle it here.
      const a = cell.firstChild;
      a.addEventListener("click", (e) => {
        if (a.hash !== location.hash) return;
        e.preventDefault();
        fromHash(); render(false); root.scrollIntoView({ block: "start" });
      });
    }
  });

  const linked = fromHash();
  render(false);
  if (linked || location.hash === "#stepper") root.scrollIntoView({ block: "start" });
  addEventListener("pageshow", (e) => { if (e.persisted && fromHash()) render(false); });
  addEventListener("hashchange", () => { if (fromHash()) { render(false); root.scrollIntoView({ block: "start" }); } });
})();

// Method notes: keep the open note and its number both on screen, and close the note
// when keyboard focus leaves it or its "Full receipt" link is followed.
document.querySelectorAll(".method").forEach((p) => {
  const b = document.querySelector(`[popovertarget="${p.id}"]`);
  p.addEventListener("toggle", (e) => {
    if (e.newState !== "open") return;
    requestAnimationFrame(() => {
      const s = p.getBoundingClientRect(), r = b.getBoundingClientRect();
      if (getComputedStyle(p).position === "fixed") { if (r.bottom > s.top - 8) scrollBy(0, r.bottom - s.top + 16); }
      else if (s.bottom > innerHeight) scrollBy(0, s.bottom - innerHeight + 16);
    });
  });
  p.addEventListener("focusout", (e) => {
    if (e.relatedTarget && !p.contains(e.relatedTarget) && e.relatedTarget !== b) p.hidePopover();
  });
  p.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener("click", () => p.hidePopover()));
});
