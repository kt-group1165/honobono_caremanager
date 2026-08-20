/**
 * 居宅介護支援の「事業所からの売上報告」(Excel) と当方の集計を突き合わせる。
 *
 *   MONTH=2026-06 npx tsx scripts/uriage-kyotaku-diff.mts
 *
 * ── なぜ Excel を直接読むか ────────────────────────────────────────────
 *   売上（事業所から）/<提供年月>/売上/<n 拠点名>/売上報告.xls に現場の集計がある。
 *   訪問介護のほうは紙 (スキャン PDF) だったが居宅は Excel なので機械で読める。
 *   転記ミスが混ざらないので、こちらは自動で突合できる。
 *
 * ── 予防は比較しない ──────────────────────────────────────────────────
 *   予防プラン (地域包括からの委託) は国保連を通らず包括から直接支払われるため
 *   当方の請求集計には入らない。**介護プランだけ**を比べる。
 *   report 側の「介護プラン 総額」と、当方の yoboShienKubun が予防でない行の合計。
 *
 * ── 月遅れは「足す」 ──────────────────────────────────────────────────
 *   報告書の列は **提供年月**である (当方の提供月ベース集計と 6 事業所で
 *   1 円一致したことで確認)。したがって同じ列の「月遅れ」は
 *   *その月に提供したが当月請求できなかった分* を意味する。
 *     四街道 6 月: 介護プラン 2,496,047 + 月遅れ 40,774 = 2,536,821
 *       = 利用票から起こした北原武夫・小池美乃里 (20,387 × 2) を含む当方の集計
 *
 *   よって比較の相手は **介護プラン総額 + 月遅れ総額**。
 *   介護プラン総額だけと一致する事業所は、月遅れの利用者が当方に
 *   入っていない (= 請求漏れ) ことを意味する。
 *
 * ── 予防は比較しない ──────────────────────────────────────────────────
 *   予防プラン (地域包括からの委託) は国保連を通らず包括から直接支払われる。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { fetchKyotakuClaimRows } from "@/app/(authenticated)/billing/seikyu/_seikyu-context";

const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);
const YM = MONTH.replace("-", "");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SALES_DIR = path.join(ROOT, "売上（事業所から）", YM, "売上");

function loadEnv() {
  const t = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const e: Record<string, string> = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** Excel は python (xlrd) で読む。Node に xls リーダを足したくないため */
interface ReportRow {
  dir: string;
  officeName: string;
  kaigoCount: number;
  kaigoAmount: number;
  lateCount: number;
  lateAmount: number;
  yoboAmount: number;
  total: number;
}
function readReports(): ReportRow[] {
  const py = `
import xlrd, json, os, sys
base = sys.argv[1]; col = int(sys.argv[2]); year = sys.argv[3]
out = []
for d in sorted(os.listdir(base)):
    f = os.path.join(base, d, '売上報告.xls')
    if not os.path.exists(f): continue
    b = xlrd.open_workbook(f, encoding_override='cp932')
    tgt = [n for n in b.sheet_names() if year[-2:] in n]
    s = b.sheet_by_name(tgt[-1]) if tgt else b.sheet_by_index(len(b.sheet_names()) - 1)
    office = ''
    for r in range(3):
        for c in range(s.ncols):
            v = str(s.cell_value(r, c))
            if '事業所名' in v:
                office = v.split('事業所名')[-1].strip()
    def num(label):
        for r in range(s.nrows):
            lab = str(s.cell_value(r, 0)).replace(' ', '').replace('　', '')
            if lab == label:
                v = s.cell_value(r, col)
                return int(v) if isinstance(v, (int, float)) and v != '' else 0
        return 0
    out.append({
        'dir': d, 'officeName': office,
        'kaigoCount': num('介護プラン件数'), 'kaigoAmount': num('介護プラン総額'),
        'lateCount': num('月遅れ件数'), 'lateAmount': num('月遅れ総額'), 'yoboAmount': num('予防プラン総額'),
        'total': num('合計'),
    })
print(json.dumps(out, ensure_ascii=False))
`;
  // ⚠ Windows の python は既定で cp932 に出力するため JSON が文字化けする。
  //   PYTHONIOENCODING を明示しないと事業所名がすべて壊れる。
  const raw = execFileSync("python", ["-c", py, SALES_DIR, String(M), String(Y)], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw) as ReportRow[];
}

if (!existsSync(SALES_DIR)) {
  console.error(`✗ ${SALES_DIR} がありません`);
  process.exit(1);
}
const reports = readReports();

const { data: offices, error } = await sb.from("offices").select("id, name, service_type");
if (error) {
  console.error(`✗ 事業所取得失敗: ${error.message}`);
  process.exit(1);
}
type Off = { id: string; name: string; service_type: string | null };
// ⚠ 名前で絞ってはいけない。「ケアプランＨａｎａ船橋」「ＫＴ在宅サポートセンター」は
//   名前に「居宅」を含まないので落ちる。service_type で絞る。
const kyotaku = ((offices ?? []) as Off[]).filter((o) => o.service_type === "居宅介護支援");

/** 「14 茂原」→「茂原」 */
const shortOf = (dir: string) => dir.replace(/^\d+\s*/, "").trim();
const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "");

/**
 * 報告書のフォルダ名 (拠点の通称) → offices.name。
 * 通称と事業所名が繋がらないものが多く (ＫＴ姉崎 = ＫＴ在宅サポートセンター、
 * 五井 = ケイ・ティ・サービス、花見川 = ケアプランＨａｎａ)、文字列一致では引けない。
 * 全件、報告書の「介護プラン件数」と当方の利用者数が一致することを確認済み。
 */
const OFFICE_BY_DIR: Record<string, string> = {
  船橋: "ケアプランＨａｎａ船橋",                            // 247
  八千代: "ケアプランＨａｎａ八千代",                        // 177
  花見川: "ケアプランＨａｎａ",                              // 132
  四街道: "Ｈａｎａ居宅支援センター四街道",                   // 135
  高品: "Ｈａｎａ居宅支援センター高品",                       // 135
  おゆみ野: "Ｈａｎａ居宅支援センターおゆみ野",               // 282
  ちはら台: "ケイ・ティ・グループ居宅支援センターちはら台",   // 108
  五井: "ケイ・ティ・サービス居宅介護支援事業所",             // 177
  ＫＴ姉崎: "ＫＴ在宅サポートセンター",                      // 247
  姉ム: "ムツミ居宅介護支援事業所",                          // 205
  袖ム: "袖ヶ浦ムツミ居宅支援センター",                      // 250
  木更津: "木更津ムツミ居宅支援センター",                    // 138
  大網: "リンクス居宅介護支援事業所大網白里",                // 139
  茂原: "リンクス居宅介護支援事業所",                        // 117
  いすみ: "リンクス居宅介護支援事業所いすみ",                // 271
};

const yen = (n: number) => n.toLocaleString("ja-JP");
const pad = (s: string, n: number) => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, n - w));
};

console.log(`\n===== 事業所報告 vs 当方集計  居宅 介護プラン (${MONTH}) =====`);
console.log("  ※ 予防プラン (包括からの委託) は国保連を通らないため比較対象外\n");
console.log(`  ${pad("拠点", 12)}${"報告(介護+月遅れ)".padStart(12)}${"当方".padStart(12)}   差        (参考) 予防 / 月遅れ`);

let ok = 0;
for (const r of reports) {
  const short = shortOf(r.dir);
  const wanted = OFFICE_BY_DIR[short];
  const off = wanted ? kyotaku.find((o) => norm(o.name) === norm(wanted)) : undefined;
  if (!off) {
    console.log(`  ${pad(short, 12)} ✗ 居宅事業所を特定できず (OFFICE_BY_DIR に "${short}" を足してください)`);
    continue;
  }
  let mine = 0;
  try {
    const rows = await fetchKyotakuClaimRows(sb, MONTH, off.id);
    // 予防 (包括委託) は請求対象外なので除く
    mine = rows
      .filter((x) => x.yoboShienKubun !== "itaku")
      .reduce((s, x) => s + x.totalAmount, 0);
  } catch (e) {
    console.log(`  ${pad(shortOf(r.dir), 12)} ✗ 集計失敗: ${(e as Error).message}`);
    continue;
  }
  const target = r.kaigoAmount + r.lateAmount;
  const d = mine - target;
  if (d === 0) ok++;
  // 月遅れちょうど不足 = 月遅れの利用者が当方に入っていない (請求漏れ)
  const hint = d === 0 ? "一致" : d === -r.lateAmount ? `月遅れ${r.lateCount}名分が不足` : (d > 0 ? "+" : "") + yen(d);
  console.log(
    `  ${pad(shortOf(r.dir), 12)}${yen(target).padStart(12)}${yen(mine).padStart(12)}   ` +
      hint.padEnd(22) +
      `  (内 月遅れ ${yen(r.lateAmount)} / 予防 ${yen(r.yoboAmount)})`,
  );
}
console.log(`\n  一致 ${ok} / ${reports.length} 事業所`);
