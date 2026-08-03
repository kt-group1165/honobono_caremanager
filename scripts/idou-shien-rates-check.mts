/**
 * 移動支援 市町村別単価表の検証ハーネス (READ ONLY / DB 不要)
 *
 * src/lib/idou-shien-rates.ts の算定を、市から配布された単価表 PDF の全数値と突合する。
 * 単価表を追加・改定したら必ず回すこと。
 *
 *   npx tsx scripts/idou-shien-rates-check.mts
 *
 * 出典 PDF: サービスコード/移動支援/移動支援(茂原・睦沢).pdf / 移動支援(大多喜).pdf
 */
import { calcIdouAmount, getIdouRates } from "@/lib/idou-shien-rates";

let ng = 0;
const check = (label: string, got: number | null | undefined, want: number) => {
  const ok = got === want;
  if (!ok) ng++;
  console.log(`  ${ok ? "✅" : "✗ "} ${label.padEnd(44)} ${String(got).padStart(7)} / 期待 ${want}`);
};

console.log("=== 茂原市 (円建て) 身体あり — PDF別表 ===");
for (const [min, want] of [[20, 2300], [29, 2300], [59, 4000], [89, 5800], [119, 6550], [149, 7300], [179, 8050]] as const) {
  check(`${min}分 日中`, calcIdouAmount("茂原市", min, "10:00", true)?.yen, want);
}
check("180分 日中 (3時間以上 → 8050+700)", calcIdouAmount("茂原市", 180, "10:00", true)?.yen, 8750);
check("210分 日中 (さらに30分 → 8050+1400)", calcIdouAmount("茂原市", 210, "10:00", true)?.yen, 9450);

console.log("=== 茂原市 身体なし ===");
for (const [min, want] of [[29, 800], [59, 1500], [89, 2250], [119, 2950], [149, 3650], [179, 4350]] as const) {
  check(`${min}分 日中`, calcIdouAmount("茂原市", min, "10:00", false)?.yen, want);
}

console.log("=== 茂原市 時間帯加算 (早朝夜間×1.25 / 深夜×1.5) ===");
check("59分 早朝 4000×1.25", calcIdouAmount("茂原市", 59, "07:00", true)?.yen, 5000);
check("59分 夜間 4000×1.25", calcIdouAmount("茂原市", 59, "19:00", true)?.yen, 5000);
check("59分 深夜 4000×1.5", calcIdouAmount("茂原市", 59, "23:00", true)?.yen, 6000);
check("59分 深夜(早朝5時) 4000×1.5", calcIdouAmount("茂原市", 59, "05:00", true)?.yen, 6000);

console.log("=== 睦沢町 は茂原市と同表 ===");
check("59分 日中", calcIdouAmount("睦沢町", 59, "10:00", true)?.yen, 4000);

console.log("=== 大多喜町 (単位建て 1単位=10円) 身体伴う ===");
for (const [min, want] of [[29, 256], [59, 404], [89, 587], [119, 669], [149, 754], [179, 837]] as const) {
  check(`${min}分 日中 (単位)`, calcIdouAmount("大多喜町", min, "10:00", true)?.units, want);
}
// PDF 末尾の「※参考」行と全件突合 (921+83×n / 345+69×n)
check("180分 = 3時間以上 (表の921行)", calcIdouAmount("大多喜町", 180, "10:00", true)?.units, 921);
for (const [h, want] of [[3.5,1004],[4,1087],[4.5,1170],[5,1253],[5.5,1336],[6,1419],[6.5,1502],[7,1585],[7.5,1668]] as const) {
  check(`${h}h以上 参考行`, calcIdouAmount("大多喜町", h*60, "10:00", true)?.units, want);
}

console.log("=== 大多喜町 身体伴わない ===");
for (const [min, want] of [[29, 106], [59, 197], [89, 275]] as const) {
  check(`${min}分 日中 (単位)`, calcIdouAmount("大多喜町", min, "10:00", false)?.units, want);
}
check("90分 = 1時間30分以上 (表の345行)", calcIdouAmount("大多喜町", 90, "10:00", false)?.units, 345);
for (const [h, want] of [[2,414],[2.5,483],[3,552],[3.5,621],[4,690],[5,828],[6,966],[7.5,1173]] as const) {
  check(`${h}h以上 参考行`, calcIdouAmount("大多喜町", h*60, "10:00", false)?.units, want);
}

console.log("=== 未登録の市町村は null ===");
console.log(`  ${getIdouRates("千葉市") === null ? "✅" : "✗ "} 千葉市 (専用モジュール側) → ${getIdouRates("千葉市")}`);
console.log(`  ${getIdouRates("一宮町") === null ? "✅" : "✗ "} 一宮町 (未登録) → ${getIdouRates("一宮町")}`);

console.log(`\n不一致 ${ng} 件`);
