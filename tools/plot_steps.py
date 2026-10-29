#!/usr/bin/env python3
"""Mixed-workload throughput per version, as horizontal bars, from the lob-engine README at 2178cef.

    python3 tools/plot_steps.py steps.svg
    python3 tools/plot_steps.py steps-narrow.svg --narrow

Filled bars are sequential ids, outlined bars random-looking ids. v0 is red and v2 blue,
as everywhere on the site; v1 is grey. Direct labels, no legend box.
"""

import sys

ROWS = [  # (version, change, sequential ids, random-looking ids), M ops/s
    ("v0", "std::map levels", 21.2, 20.0, "v0"),
    ("v1", "arrays + bitset", 34.3, 30.4, "v1"),
    ("v2", "+ id table", 67.5, 60.1, "v2"),
]
FONT = "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif"
STYLE = (
    "<style>.txt{fill:#171b20}.mut{fill:#565b62}.grid{stroke:#d5d8db}"
    ".v0{fill:#af2b25}.v1{fill:#565b62}.v2{fill:#175fa4}"
    ".o0{fill:none;stroke:#af2b25;stroke-width:1.5}.o1{fill:none;stroke:#565b62;stroke-width:1.5}.o2{fill:none;stroke:#175fa4;stroke-width:1.5}"
    "@media (prefers-color-scheme: dark){.txt{fill:#e5e8ec}.mut{fill:#a7abb1}.grid{stroke:#2f3338}"
    ".v0{fill:#f2897c}.v1{fill:#a7abb1}.v2{fill:#79b6f4}.o0{stroke:#f2897c}.o1{stroke:#a7abb1}.o2{stroke:#79b6f4}}</style>"
)


def main():
    out, narrow = sys.argv[1], "--narrow" in sys.argv[2:]
    if narrow:
        W, L, R, T, ROW, fs = 360, 12, 50, 8, 72, 14
    else:
        W, L, R, T, ROW, fs = 720, 200, 150, 10, 56, 15
    XMAX = 70.0
    H = T + ROW * len(ROWS) + 44
    x = lambda v: L + v / XMAX * (W - L - R)
    title = ("Mixed-workload throughput by version on an Apple M4, millions of operations a second. "
             "Sequential ids: v0 21.2, v1 34.3, v2 67.5. Random-looking ids: v0 20.0, v1 30.4, v2 60.1.")
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
         f'aria-labelledby="t" font-family="{FONT}" font-size="{fs}">', f'<title id="t">{title}</title>', STYLE]
    base = T + ROW * len(ROWS)
    for v in range(0, 71, 10 if not narrow else 20):
        p.append(f'<line class="grid" x1="{x(v):.1f}" y1="{T}" x2="{x(v):.1f}" y2="{base}"/>')
        p.append(f'<text class="mut" x="{x(v):.1f}" y="{base + fs + 6}" text-anchor="middle">{v}</text>')
    p.append(f'<text class="mut" x="{(L + W - R) / 2:.0f}" y="{H - 6}" text-anchor="middle">'
             f'M operations a second, mixed workload of 1M operations</text>')
    for i, (ver, change, seq, rnd, cls) in enumerate(ROWS):
        n = cls[-1]
        top = T + i * ROW
        if narrow:
            p.append(f'<text class="txt" x="{L}" y="{top + fs}"><tspan font-weight="700">{ver}</tspan> {change}</text>')
            by = top + fs + 6
        else:
            p.append(f'<text class="txt" x="{L - 12}" y="{top + 24}" text-anchor="end"><tspan font-weight="700">{ver}</tspan>  {change}</text>')
            by = top + 9
        p.append(f'<rect class="{cls}" x="{L}" y="{by}" width="{x(seq) - L:.1f}" height="18"/>')
        p.append(f'<rect class="o{n}" x="{L}" y="{by + 22:.1f}" width="{x(rnd) - L:.1f}" height="12"/>')
        s_lab = f"{seq}" + ("" if narrow or i else "  sequential ids")
        r_lab = f"{rnd}" + ("" if narrow or i else "  random-looking ids")
        p.append(f'<text class="txt" x="{x(seq) + 6:.1f}" y="{by + 14}">{s_lab}</text>')
        p.append(f'<text class="mut" x="{x(rnd) + 6:.1f}" y="{by + 32}" font-size="{fs - 1}">{r_lab}</text>')
    p.append("</svg>")
    with open(out, "w") as fh:
        fh.write("\n".join(p) + "\n")


if __name__ == "__main__":
    main()
