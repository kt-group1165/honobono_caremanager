// smoke 用 総合事業テスト実績の再シード (市原市 IH_ 版)
//
// 背景 (2026-07-15): smoke の 総合事業 2026-07 (期待 1行/1489単位/16453円) を支えていた
// 完了実績 (旧: 千葉市様式のサービス名) が市原市対応のテスト作業中に消えた。
// 保険者番号→自治体prefix 解決 (4e50066) 後の正しい形 = 市原市 (阿部の保険者 122192)
// の IH_ コード名で 1 行を再投入する。
//   訪問型独自サービス１１ (IH_A21111) 1,176 単位 + 処遇改善Ⅱ２ 26.6% (313) = 1,489 単位
//   × 11.05 円/単位 = 16,453 円 → smoke 期待値と一致 (期待値の変更不要)
//
// 実行:
//   node migrations/seed_sougou_smoke_row.mjs            # DRY RUN
//   node migrations/seed_sougou_smoke_row.mjs --execute  # 本番
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const get = (k) => (env.match(new RegExp(k + "=(.+)")) || [])[1]?.trim();
const SB_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const KEY = get("SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const EXECUTE = process.argv.includes("--execute");

const MARKER = "[fake テスト用-sougou-smoke-ichihara]";
const ROW = {
  user_id: "2e1b6b28-324c-4c9e-817a-c6586da28657", // 阿部 正一 (保険者 122192 = 市原市)
  office_id: "4f14d50c-76b5-4f44-ac41-ed6d01f53a30", // おゆみ野 (smoke 対象事業所)
  tenant_id: "kt-group",
  visit_date: "2026-07-03",
  start_time: "14:00:00",
  end_time: "15:00:00",
  service_type: "訪問型独自サービス１１", // IH_A21111 (1,176 単位/月・市原市)
  status: "completed",
  kinkyu_houmon: false,
  notes: MARKER,
};

const main = async () => {
  // 冪等: マーカー付きの同月行が既にあれば skip
  const exist = await fetch(
    `${SB_URL}/rest/v1/kaigo_visit_schedule?user_id=eq.${ROW.user_id}&visit_date=gte.2026-07-01&visit_date=lte.2026-07-31&notes=eq.${encodeURIComponent(MARKER)}&select=id`,
    { headers: H },
  ).then((r) => r.json());
  if (Array.isArray(exist) && exist.length > 0) {
    console.log(`既にシード済み (${exist.length} 行) — 何もしません`);
    return;
  }
  console.log(`${EXECUTE ? "INSERT" : "[dry] INSERT"} kaigo_visit_schedule:`, JSON.stringify(ROW, null, 1));
  if (!EXECUTE) {
    console.log("\nDRY RUN 終了。実行するには --execute");
    return;
  }
  const res = await fetch(`${SB_URL}/rest/v1/kaigo_visit_schedule`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(ROW),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  console.log(`INSERT 完了: id=${body[0]?.id}`);
  // 件数確認
  const check = await fetch(
    `${SB_URL}/rest/v1/kaigo_visit_schedule?notes=eq.${encodeURIComponent(MARKER)}&select=id,visit_date,service_type,status`,
    { headers: H },
  ).then((r) => r.json());
  console.log("検証:", JSON.stringify(check));
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
