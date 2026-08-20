/**
 * 事業所から報告された売上 (紙) と、当方の集計を突き合わせる。
 *
 *   MONTH=2026-06 npx tsx scripts/uriage-report-diff.mts
 *
 * 報告値は 売上（事業所から）/202606/*.pdf を目視で起こしたもの (REPORTED)。
 * PDF がスキャンでテキストを持たないため機械で読めない。数字を直したら
 * ここを直す — 出典が紙であることを忘れないように表に残す。
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";
import { getShogaiHomonUnitPrice } from "@/lib/shogai-seikyu/unit-price";

const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 事業所から報告された 6 月の値 (紙の集計表から転記) */
interface Reported {
  office: string;       // offices.name と突合するための手掛かり
  kaigoKokuho: number;  // 介護 国保連
  shogaiTotal: number;  // 障害 総額
  shogaiCount: number;  // 障害 件数
}
const REPORTED: Reported[] = [
  { office: "リンクスヘルパーステーション山武", kaigoKokuho: 2877383, shogaiTotal: 2038193, shogaiCount: 32 },
  { office: "ＫＴ姉崎ヘルパーステーション", kaigoKokuho: 4011001, shogaiTotal: 1657900, shogaiCount: 17 },
  { office: "Ｈａｎａヘルパーステーション花見川", kaigoKokuho: 3088685, shogaiTotal: 2084263, shogaiCount: 36 },
  { office: "ＫＴ五井ヘルパーステーション", kaigoKokuho: 3825114, shogaiTotal: 2990472, shogaiCount: 29 },
  { office: "Ｈａｎａヘルパーステーションおゆみ野", kaigoKokuho: 4681431, shogaiTotal: 11600044, shogaiCount: 63 },
  { office: "Ｈａｎａヘルパーステーション高品", kaigoKokuho: 3032096, shogaiTotal: 3477770, shogaiCount: 38 },
  { office: "袖ヶ浦ムツミヘルパーステーション", kaigoKokuho: 4148656, shogaiTotal: 4071492, shogaiCount: 30 },
  { office: "Ｈａｎａヘルパーステーションさつきが丘", kaigoKokuho: 2970607, shogaiTotal: 1802030, shogaiCount: 23 },
  { office: "リンクスヘルパーステーションいすみ", kaigoKokuho: 6697381, shogaiTotal: 2885720, shogaiCount: 36 },
  { office: "リンクスヘルパーステーション東郷", kaigoKokuho: 5057446, shogaiTotal: 2148359, shogaiCount: 22 },
  { office: "君津ムツミヘルパーステーション", kaigoKokuho: 2561934, shogaiTotal: 1586761, shogaiCount: 14 },
  { office: "ＫＴやわたヘルパーステーション", kaigoKokuho: 2405205, shogaiTotal: 2965222, shogaiCount: 32 },
  { office: "ムツミヘルパーステーション", kaigoKokuho: 5673030, shogaiTotal: 564104, shogaiCount: 13 },
  { office: "市原ムツミヘルパーステーション", kaigoKokuho: 3784695, shogaiTotal: 1315990, shogaiCount: 26 },
  { office: "木更津ムツミヘルパーステーション", kaigoKokuho: 6595271, shogaiTotal: 2479386, shogaiCount: 20 },
  { office: "Ｈａｎａ船橋ヘルパーステーション", kaigoKokuho: 3883226, shogaiTotal: 1294279, shogaiCount: 18 },
  { office: "ケイ・ティ・グループヘルパーステーションＨａｎａちはら台", kaigoKokuho: 6602886, shogaiTotal: 1890997, shogaiCount: 23 },
  { office: "Ｈａｎａヘルパーステーション中央", kaigoKokuho: 1915113, shogaiTotal: 9531691, shogaiCount: 57 },
  { office: "Ｈａｎａ八千代ヘルパーステーション", kaigoKokuho: 1987748, shogaiTotal: 840765, shogaiCount: 14 },
  { office: "Ｈａｎａヘルパーステーション四街道", kaigoKokuho: 1448152, shogaiTotal: 696441, shogaiCount: 8 },
  { office: "リンクスヘルパーステーション", kaigoKokuho: 9066050, shogaiTotal: 3109019, shogaiCount: 33 },
  { office: "リンクスヘルパーステーション大網白里", kaigoKokuho: 4687518, shogaiTotal: 1348906, shogaiCount: 33 },
];

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

const { data: offices, error } = await sb.from("offices").select("id, name, area_category");
if (error) {
  console.error(`✗ 事業所取得失敗: ${error.message}`);
  process.exit(1);
}
// ⚠ 障害の単価は事業所の級地で決まる。渡さないと 10.00 円で計算されて 1 割ほど下振れする
const byName = new Map(
  (offices ?? []).map((o) => [
    o.name as string,
    { id: o.id as string, unitPrice: getShogaiHomonUnitPrice((o.area_category as string | null) ?? null) },
  ]),
);

const yen = (n: number) => n.toLocaleString("ja-JP");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

console.log(`\n===== 事業所報告 vs 当方集計  障害 (${MONTH}) =====\n`);
console.log("事業所                     報告(件/円)          当方(件/円)          差");

let okC = 0;
const rows: string[] = [];
for (const r of REPORTED) {
  const off = byName.get(r.office);
  if (!off) {
    rows.push(`${pad(r.office.slice(0, 24), 26)} ✗ offices に無い`);
    continue;
  }
  const res = await aggregateMonthlyShogaiSeikyu(sb, {
    year: Y,
    month: M,
    officeId: off.id,
    unitPrice: off.unitPrice,
  });
  const mine = res.rows.reduce((s, x) => s + x.totalAmount, 0);
  const cnt = res.rows.length;
  const d = mine - r.shogaiTotal;
  if (d === 0) okC++;
  const short = r.office.replace(/^(Ｈａｎａ|ＫＴ|リンクス|ケイ・ティ・グループ)?/, "").replace(/ヘルパーステーション/, "");
  rows.push(
    `${pad(short || r.office, 14)} ${String(r.shogaiCount).padStart(3)}名 ${yen(r.shogaiTotal).padStart(11)}   ` +
      `${String(cnt).padStart(3)}名 ${yen(mine).padStart(11)}   ${d === 0 ? "一致" : (d > 0 ? "+" : "") + yen(d)}`,
  );
}
for (const l of rows) console.log("  " + l);
console.log(`\n  金額一致 ${okC} / ${REPORTED.length} 事業所`);
