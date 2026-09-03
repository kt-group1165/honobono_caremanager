// buildIdouMeisaiLines の純関数テスト (DB なし)。期待値は千葉市 R6.4.1 から手計算。
import { buildIdouMeisaiLines, type CodeInfoEntry } from "@/lib/idou-billing-lines";
const info = new Map<string, CodeInfoEntry>([
  ["023115", { name: "移動1日中1.0", unit: 441 }], ["023116", { name: "移動1日中1.0・2人", unit: 441 }],
  ["027111", { name: "移動2日中0.5", unit: 116 }],
  ["024701", { name: "移動1初回加算", unit: 218 }], ["027701", { name: "移動2初回加算", unit: 218 }],
  ["024801", { name: "移動1緊急時対応加算", unit: 109 }],
  ["041110", { name: "訪問入浴", unit: 1380 }], ["041701", { name: "訪問入浴初回加算", unit: 218 }],
]);
const idou = (o: Partial<Parameters<typeof buildIdouMeisaiLines>[0][0]> = {}) => ({
  client_id: "A", service_code: "023115", staff_count: 1, with_body_care: true,
  addon_shokai: false, addon_kinkyu: false, ...o,
});
let ok = 0, ng = 0;
const chk = (label: string, a: unknown, e: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { ok += 1; console.log(`  ✓ ${label}: ${JSON.stringify(a)}`); }
  else { ng += 1; console.log(`  ✗ ${label}\n      期待 ${JSON.stringify(e)}\n      実際 ${JSON.stringify(a)}`); }
};
const total = (m: Map<string, { total: number }[]>, k = "A") => (m.get(k) ?? []).reduce((s, l) => s + l.total, 0);
const codes = (m: Map<string, { code: string; count: number }[]>, k = "A") =>
  (m.get(k) ?? []).map((l) => `${l.code}×${l.count}`).sort();

console.log("=== buildIdouMeisaiLines 純関数テスト ===");
chk("初回は月1回に丸まる (3回付け)", codes(buildIdouMeisaiLines([idou({ addon_shokai: true }), idou({ addon_shokai: true }), idou({ addon_shokai: true })], [], info)), ["023115×3", "024701×1"]);
chk("緊急は月2回に丸まる (4回付け)", codes(buildIdouMeisaiLines(Array.from({ length: 4 }, () => idou({ addon_kinkyu: true })), [], info)), ["023115×4", "024801×2"]);
chk("身体なしは緊急が付かない", codes(buildIdouMeisaiLines([idou({ service_code: "027111", with_body_care: false, addon_kinkyu: true })], [], info)), ["027111×1"]);
chk("身体なしの初回は 027701", codes(buildIdouMeisaiLines([idou({ service_code: "027111", with_body_care: false, addon_shokai: true })], [], info)), ["027111×1", "027701×1"]);
chk("2人派遣は +1 コードで別行", codes(buildIdouMeisaiLines([idou({ staff_count: 2 })], [], info)), ["023115×1", "023116×1"]);
chk("訪問入浴の初回加算 041701 が出る", codes(buildIdouMeisaiLines([], [{ client_id: "A", service_code: "041110", addon_shokai: true }], info)), ["041110×1", "041701×1"]);
chk("訪問入浴の初回も月1回", codes(buildIdouMeisaiLines([], [{ client_id: "A", service_code: "041110", addon_shokai: true }, { client_id: "A", service_code: "041110", addon_shokai: true }], info)), ["041110×2", "041701×1"]);
chk("合計単位 (初回+緊急2回)", total(buildIdouMeisaiLines([idou({ addon_shokai: true, addon_kinkyu: true }), idou({ addon_kinkyu: true })], [], info)), 441 * 2 + 218 + 109 * 2);
chk("マスタに無いコードは 0 単位で行だけ出す", codes(buildIdouMeisaiLines([idou({ service_code: "999999" })], [], info)), ["999999×1"]);
console.log(`\n=== ${ok} 一致 / ${ng} 不一致 ===`);
