"""Debug helper: extract_pdf_text.mjs の出力 (jsonl) を読んで、
y 座標で行を作り直して printed format で表示する"""
import sys, json, subprocess
sys.stdout.reconfigure(encoding="utf-8")

pdf = sys.argv[1]
page = sys.argv[2]
needle = sys.argv[3] if len(sys.argv) > 3 else None

result = subprocess.run(
    ["node", "extract_pdf_text.mjs", pdf, page, page],
    capture_output=True, text=False,
)
out = result.stdout.decode("utf-8", errors="replace")

for line in out.splitlines():
    if not line.strip():
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("event") != "page":
        continue
    items = d["items"]
    # group by y (±2 tol)
    rows = {}
    for it in items:
        if not it["str"].strip():
            continue
        bucket = None
        for k in rows:
            if abs(k - it["y"]) <= 2:
                bucket = k
                break
        if bucket is None:
            bucket = it["y"]
        rows.setdefault(bucket, []).append(it)

    sorted_rows = sorted(rows.items(), key=lambda kv: -kv[0])
    for y, line_items in sorted_rows:
        line_items.sort(key=lambda it: it["x"])
        joined = " ".join(it["str"] for it in line_items)
        if needle and needle not in joined:
            continue
        print(f"y={y:>6.1f}: {joined}")
        # detail
        for it in line_items:
            print(f"        x={it['x']:>6.1f} w={it['w']:>5.1f} {it['str']!r}")
