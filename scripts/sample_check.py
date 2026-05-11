import csv, sys
from collections import defaultdict
sys.stdout.reconfigure(encoding="utf-8")
with open(sys.argv[1] if len(sys.argv) > 1 else "service_codes_zaitaku.csv", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))
samples = defaultdict(list)
for r in rows:
    if r["calculation_type"] == "基本":
        samples[r["service_category"]].append(r)
for k in sorted(samples):
    name = samples[k][0]["service_category_name"]
    print(f"--- {k} {name} ---")
    for r in samples[k][:3]:
        print(f"  {r['service_code']} {r['service_name']} = {r['units']} {r['unit_type']}")
