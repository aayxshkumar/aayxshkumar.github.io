#!/usr/bin/env python3
"""Optional pre-commit build for the site. Python standard library only; the
output is committed, and GitHub Pages serves the files as they are.

    python3 build.py           # the ledger from receipts.json, atom.xml, sitemap.xml, the weight line
    python3 build.py --og      # og.png from og/home-card.html, og-order-book-3x.png from og/order-book-3x.html
    python3 build.py --pdf     # order-book-3x.pdf, A4, from the page's print styles
    python3 build.py --check   # exit 1 on a stale block, a banned string, an old figure, a dead ledger
                               # link or a missing image size
    python3 build.py --all

--og and --pdf need a Chrome or Chromium binary: set CHROME, or it uses
Google Chrome in /Applications. Each run gets a throwaway profile directory,
never your own.

receipts.json is the list of every number on the site and what backs it.
claims.html is generated from it; --check fails when a page carries a number
string this site has retracted, so a correction can't be half-made. The figures
replaced on 30 October 2026 (OLD below) may stay only as history: in a post's
<ol class="revisions"> or in a ledger row's "Earlier figure" line.
"""

import gzip
import html
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = "https://aayxshkumar.github.io/"
UPDATED = "2026-10-30"
TZ = "+05:30"

# The feed: posts, then Log notes that point into them. An optional fifth field is the
# date an entry was last updated, when that differs from the date it was published.
ENTRIES = [
    ("From 21M to 65M ops/s: two changes to a C++ order book", "order-book-3x.html", "2026-10-29",
     "Flat price-level arrays and an open-addressing id table took a C++20 order book from 20.9M to 65.2M ops/s; one step was slower first.",
     "2026-10-30"),
    ("Replaying 20 minutes of Binance BTCUSDT", "#real-data", "2026-10-29",
     "562,850 order operations: v2 at 79.4M ops/s against 14.7M for std::map, on a book of at most 4,203 orders, small enough to fit in cache. Speeds from the 30 October rerun at e12cc5d.",
     "2026-10-30"),
    ("v2: an open-addressing id table, and the 32 MB table that hid its gain", "#id-table", "2026-10-29",
     "Sized for 1M orders the table didn't fit in cache; sized for the workload, v2 is 1.8× as fast as v1. Speeds from the 30 October reruns at e12cc5d and, for v1, 752c2cf.",
     "2026-10-30"),
    ("A benchmark found a full-band scan in my “faster” version", "#full-band-scan", "2026-10-28",
     "Clearing the last ask scanned all 65,536 ticks: 22.5 µs a sweep against 2.0 µs for std::map, as the benchmark timed it then.",
     "2026-10-30"),
    ("Apple Silicon’s steady_clock ticks every 41.7 ns", "#steady-clock", "2026-10-28",
     "My p50 came out at exactly one tick of a 24 MHz clock."),
    ("My first differential test passed with a planted bug in it", "#first-differential-test", "2026-10-28",
     "Queues never formed, so priority bugs had nothing to break."),
]
PAGES = ["", "order-book-3x.html", "claims.html", "now.html", "colophon.html"]
HTML = ["index.html", "order-book-3x.html", "claims.html", "now.html", "colophon.html", "404.html"]


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def feed():
    out = ['<?xml version="1.0" encoding="utf-8"?>',
           '<feed xmlns="http://www.w3.org/2005/Atom">',
           "  <title>Aayush Kumar</title>",
           f"  <id>{SITE}</id>",
           f'  <link rel="self" href="{SITE}atom.xml"/>',
           f'  <link href="{SITE}"/>',
           f"  <updated>{UPDATED}T00:00:00{TZ}</updated>",
           "  <author><name>Aayush Kumar</name></author>"]
    for title, href, date, summary, *upd in ENTRIES:
        url = SITE + href
        out += ["  <entry>",
                f"    <title>{esc(title)}</title>",
                f"    <id>{url}</id>",
                f'    <link href="{url}"/>',
                f"    <published>{date}T00:00:00{TZ}</published>",
                f"    <updated>{(upd or [date])[0]}T00:00:00{TZ}</updated>",
                f"    <summary>{esc(summary)}</summary>",
                "  </entry>"]
    out.append("</feed>")
    (ROOT / "atom.xml").write_text("\n".join(out) + "\n", encoding="utf-8")


def sitemap():
    rows = "\n".join(f"  <url><loc>{SITE}{p}</loc><lastmod>{UPDATED}</lastmod></url>" for p in PAGES)
    (ROOT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + rows + "\n</urlset>\n",
        encoding="utf-8")


def gz(path):
    return len(gzip.compress((ROOT / path).read_bytes(), 9))


def weight():
    """Compressed weight of the home page: HTML, CSS, JS, then the images it loads."""
    code = sum(gz(p) for p in ("index.html", "style.css", "stepper.js"))
    imgs = sum(gz(p) for p in ("latency-cdf-add_limit.svg", "favicon.svg"))
    line = (f"<!-- weight -->The home page is {code / 1024:.1f} KB of HTML, CSS and JavaScript, "
            f"compressed, plus {imgs / 1024:.1f} KB for its chart and icon. It loads no fonts.<!-- /weight -->")
    col = ROOT / "colophon.html"
    col.write_text(re.sub(r"<!-- weight -->.*?<!-- /weight -->", line, col.read_text(encoding="utf-8"), flags=re.S),
                   encoding="utf-8")
    return code, imgs


# ---- The ledger -------------------------------------------------------------
DATA = json.loads((ROOT / "receipts.json").read_text(encoding="utf-8"))
REPO = DATA["source"]["repo"]
# Ledger history lines start with this, and only these lines may quote an OLD figure.
EARLIER = "Earlier figure, replaced on 30 October 2026: "


def link(path, sha):
    kind = "tree" if path.endswith("/") else "blob"
    return f'<a href="{REPO}/{kind}/{sha}/{path}"><code>{esc(path.rstrip("/")).replace("/", "/<wbr>")}</code> at {sha}</a>'


def evidence(c):
    ev = []
    if "bench" in c:
        at = f' at <a href="{REPO}/tree/{c["at"]}">{c["at"]}</a>' if "at" in c else ""
        names = [f"<code>{esc(b).replace('/', '/<wbr>')}</code>" for b in c["bench"]]
        ev.append(", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1] + at)
    elif "command" in c:
        ev.append(f"<code>{esc(c['command'])}</code>")
    if "sizing" in c:
        ev.append(esc(c["sizing"]))
    if "statistic" in c:
        ev.append(c["statistic"])
    if "data" in c:
        ev.append(link(*c["data"]))
    if "published" in c:
        ev.append("published in the " + link(*c["published"]))
    found = False
    for run in DATA.get("raw", []):
        if any(b in run["benches"] for b in c.get("bench", [])):
            name = "bench.json"
        elif c.get("raw_file") in run["files"]:
            name = c["raw_file"]
        else:
            continue
        found = True
        ev.append(f'raw output of {esc(run["note"])}: {link(run["path"] + "/" + name, run["sha"])}')
    if not found and ("bench" in c or c.get("command", "").startswith("./build/lob_replay")):
        ev.append('raw output <span class="missing">not committed yet</span>')
    if "missing" in c:
        ev.append(f'<span class="missing">{esc(c["missing"])}</span>')
    out = "".join(f'<span class="ev">{e}</span>' for e in ev)
    if "earlier" in c:
        out += f'<span class="ev history">{esc(EARLIER + c["earlier"])}</span>'
    return out or "none can be published"


def ledger():
    rows = []
    for cid, c in DATA["claims"].items():
        used = ", ".join(f'<a href="{h}">{w}</a>' for w, h in c["used"])
        rows.append(f'<tr id="{cid}"><th scope="row">{esc(c["label"])}<span class="used">On {used}</span></th>'
                    f'<td class="t val" data-label="Value">{esc(c["value"])}</td>'
                    f'<td class="t" data-label="Evidence">{evidence(c)}</td>'
                    f'<td class="t" data-label="Status">{esc(c["status"])}</td></tr>')
    return "\n".join(rows)


def conditions():
    return esc(f'Every benchmark ran on an {DATA["machine"]}; each figure is the {DATA["statistic"]}. '
               + DATA["conditions"])


def blocks(src):
    src = re.sub(r"(<!-- num:conditions -->).*?(<!-- /num -->)", lambda m: m[1] + conditions() + m[2], src, flags=re.S)
    return re.sub(r"(<!-- num:ledger -->).*?(<!-- /num -->)", lambda m: m[1] + "\n" + ledger() + "\n" + m[2], src, flags=re.S)


def numbers():
    path = ROOT / "claims.html"
    src = path.read_text(encoding="utf-8")
    out = blocks(src)
    if out != src:
        path.write_text(out, encoding="utf-8")


# Strings this site has retracted or never wants again.
BANNED = [
    ("40% faster", "no committed run gives it"),
    ("256k orders", "the books are sized for 262,144"),
    ("Book sized for 256k", "the books are sized for 262,144"),
    ("56%", "the CDF share is 55.5%"),
    ("16.5%", "the CDF share is 16.4%"),
    ('class="draft"', "a placeholder is still on the page"),
    (" · ", "no middots"),
    ("#111", "ink is #171b20"),
    ("lost a quarter of its speed", "two v1 runs disagree and neither is committed"),
    ("within the first clock tick", "0-tick readings are not 'finished within' a tick"),
    ("no faster with sequential ids", "the committed rerun is 1.1x"),
    ("whole book after every step", "say what the test compares"),
]

# The median-of-3 figures whose raw output wasn't kept, replaced on 30 October 2026 by the
# committed runs at e12cc5d and 752c2cf. Bare decimals are matched too, for table cells.
OLD_FIGURES = ("21.2", "34.3", "67.5", "81.9", "15.9", "60.1", "30.4", "37.7", "34.4", "8.6")
OLD = re.compile(r"(?<![\w.,])(?:(?:" + "|".join(map(re.escape, OLD_FIGURES)) + r")(?!\d)"
                 r"|68M|[35]\.2(?:\s|&#8288;|&nbsp;|\u2060|\u202f)*(?:×|&times;|x\b|times\b))")
# Where an OLD figure may stay: a post's list of revisions and a ledger row's history line.
HISTORY = re.compile(r'<ol class="revisions">.*?</ol>|<span class="ev history">' + re.escape(esc(EARLIER))
                     + r'[^<]*</span>', re.S)


def old_figures(name, text, history=True):
    """Every OLD figure in text outside the places history may live, as 'file:line: ...' strings."""
    allowed = [m.span() for m in HISTORY.finditer(text)] if history else []
    return [f"{name}:{text.count(chr(10), 0, m.start()) + 1}: {m[0]!r} (an old figure outside Revisions)"
            for m in OLD.finditer(text) if not any(a <= m.start() < b for a, b in allowed)]


def json_strings(node, skip):
    if isinstance(node, dict):
        return [s for k, v in node.items() if k not in skip for s in json_strings(v, skip)]
    if isinstance(node, list):
        return [s for v in node for s in json_strings(v, skip)]
    return [node] if isinstance(node, str) else []


def check():
    bad = []
    claims = (ROOT / "claims.html").read_text(encoding="utf-8")
    if blocks(claims) != claims:
        bad.append("claims.html: the ledger is stale; run build.py")
    for page in HTML:
        src = (ROOT / page).read_text(encoding="utf-8")
        for n, line in enumerate(src.splitlines(), 1):
            for s, why in BANNED:
                if s in line:
                    bad.append(f"{page}:{n}: {s!r} ({why})")
            for tag in re.findall(r"<(?:img|source)\b[^>]*>", line):
                if "width=" not in tag or "height=" not in tag:
                    bad.append(f"{page}:{n}: image without width and height")
        for m in re.finditer(r'<span id="([\w-]+)" popover class="method"[^>]*>.*?</span>', src, re.S):
            if 'popovertargetaction="hide"' not in m[0]:
                bad.append(f"{page}: popover {m[1]} has no Close button")
        for t in re.findall(r"<table.*?</table>", src, re.S):
            if 'class="num"' in t:
                bad.append(f"{page}: a method popover inside a table")
        bad += old_figures(page, src)
    bad += old_figures("atom.xml", (ROOT / "atom.xml").read_text(encoding="utf-8"), history=False)
    for svg in sorted(ROOT.glob("*.svg")):  # what the chart says, not its coordinates
        bad += old_figures(svg.name, re.sub(r"<[^>]*>", " ", svg.read_text(encoding="utf-8")), history=False)
    bad += [f"receipts.json: {m[0]!r} (an old figure outside an \"earlier\" field)"
            for s in json_strings(DATA, {"earlier"}) for m in OLD.finditer(s)]
    for cid, c in DATA["claims"].items():
        for _, href in c["used"]:
            page, _, frag = href.partition("#")
            if frag and f'id="{frag}"' not in (ROOT / page).read_text(encoding="utf-8"):
                bad.append(f"receipts.json: {cid} points at {href}, which doesn't exist")
    ai = re.search(r'<h2 id="ai">.*?</h2>\s*<p>(.*?)</p>', (ROOT / "colophon.html").read_text(encoding="utf-8"), re.S)
    if not ai or len(re.sub(r"<[^>]+>", "", ai[1]).split()) < 40:
        bad.append("colophon.html: the AI note is missing or under 40 words")
    pdfb = (ROOT / "order-book-3x.pdf").read_bytes()
    for host in (b"127.0.0.1", b"localhost", b"file://"):
        if host in pdfb:
            bad.append(f"order-book-3x.pdf: a link to {host.decode()}")
    for b in bad:
        print(b)
    return not bad


def chrome(*args):
    exe = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    with tempfile.TemporaryDirectory() as prof:
        cmd = [exe, "--headless", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
               f"--user-data-dir={prof}", *args]
        subprocess.run(cmd, check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def og():
    # og.png, the home card, comes from og/home-card.html; og/home-candidate.png (from og/home.html)
    # is an unpublished alternative and isn't rendered here.
    for src, out in (("og/home-card.html", "og.png"), ("og/order-book-3x.html", "og-order-book-3x.png")):
        chrome("--window-size=1200,630", "--force-device-scale-factor=1",
               f"--screenshot={ROOT / out}", (ROOT / src).as_uri())


def pdf():
    # Print a copy whose relative links point at the live site, so the PDF never carries
    # file:// or a preview server's address. CSS, SVGs and #footnote links stay local.
    src = (ROOT / "order-book-3x.html").read_text(encoding="utf-8")
    src = re.sub(r'(<a\b[^>]*?\bhref=")(?!https?:|mailto:|#)(?:\./|/)?', r"\1" + SITE, src)
    tmp = ROOT / "_print.html"
    tmp.write_text(src, encoding="utf-8")
    try:
        chrome("--no-pdf-header-footer", "--force-prefers-reduced-motion",
               f"--print-to-pdf={ROOT / 'order-book-3x.pdf'}", tmp.as_uri())
    finally:
        tmp.unlink()


def main(argv):
    if argv == ["--check"]:
        sys.exit(0 if check() else 1)
    numbers()
    feed()
    sitemap()
    code, imgs = weight()
    print(f"atom.xml, sitemap.xml; home weight {code} B code + {imgs} B images, gzipped")
    if "--og" in argv or "--all" in argv:
        og()
        print("og.png, og-order-book-3x.png")
    if "--pdf" in argv or "--all" in argv:
        pdf()
        print("order-book-3x.pdf")
    if "--all" in argv and not check():
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
