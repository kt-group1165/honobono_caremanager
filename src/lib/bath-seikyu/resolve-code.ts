// 訪問入浴介護 記録作成時のサービスコード解決 — 純関数として一本化 (2026-09-05・B-1w対応)
//
// 元は下記2箇所に同じ実装が別々にコピーされていた:
//   - src/app/(authenticated)/bath-records/bath-records-content.tsx
//   - src/app/(authenticated)/bath-shift/bath-shift-content.tsx
//
// ⚠⚠⚠ 既知の欠陥だった (2026-09-03 サンプル検証で発見・2026-09-05 修正) ⚠⚠⚠
//   旧実装は要介護度を見ずに常に種類12 (121xxx, 介護給付) のコードを返していた。
//   訪問入浴介護には予防給付 (介護予防訪問入浴介護 = 種類62, 621xxx) が別途存在し、
//   要支援1・2 / 事業対象者は本来こちらで算定すべき。121xxx (要介護者用) を使うと
//   1.48倍の過大請求 (例: 全身浴 121111=1,266単位 のところ 621111=856単位 が正しい)
//   になり、資格 (予防給付) と種類 (介護給付) が合わず返戻になる。
//   実データでの該当は 0 件 (稼働前) の段階で修正した。
import { isYoboLevel } from "@/lib/yobo-kubun";

/**
 * 入浴種別 × 職員のみ × 要介護度 → 算定コード。
 * careLevel が予防給付区分 (要支援1・2 / 事業対象者) なら種類62 (621xxx)、
 * それ以外 (要介護1-5 / 未設定) は種類12 (121xxx) を返す。
 * ★ 予防/介護の判定は lib/yobo-kubun.ts (唯一の判定元) に必ず委ねること。
 *   ここで新しい判定を作らない。
 */
export function resolveBathCode(
  bathType: "全身浴" | "部分浴",
  staffOnly: boolean,
  careLevel: string | null | undefined,
): string {
  if (isYoboLevel(careLevel)) {
    if (bathType === "全身浴") return staffOnly ? "621121" : "621111";
    return staffOnly ? "621122" : "621112"; // 予防・部分浴・清拭
  }
  if (bathType === "全身浴") return staffOnly ? "121121" : "121111";
  return staffOnly ? "121122" : "121112"; // 部分浴・清拭
}

// ── 加算コード (2026-09-05 追加・B-1w続き) ──────────────────────────────────
// ⚠⚠⚠ B-1w修正で基本コードだけ62系に直したことで、加算コードが12xxx固定の
//   ままだと「基本は予防給付・加算は介護給付」の制度混在明細になる。
//   予防給付側の並行マスタ (624001/626133/626134/628110 等) が
//   kaigo_service_codes に実在し、2026-06-01〜(valid_until無し)で
//   2026-12時点も有効であることを実データで確認済み (2026-09-05)。
//
//   src/lib/bath-seikyu/aggregate.ts が参照する。判定は isYoboLevel のみ。
export interface BathAddonCodes {
  shokai: string; // 初回加算
  ninchiI: string; // 認知症専門ケア加算Ⅰ
  ninchiII: string; // 認知症専門ケア加算Ⅱ
  chuusankan: string; // 中山間地域等提供加算 (率加算)
  tokubetsu: string; // 特別地域訪問入浴介護加算 (率加算)
  shokibo: string; // 小規模事業所加算 (率加算)
}

export const BATH_ADDON_CODES_KAIGO: BathAddonCodes = {
  shokai: "124113", ninchiI: "126133", ninchiII: "126134",
  chuusankan: "128110", tokubetsu: "128000", shokibo: "128100",
};
export const BATH_ADDON_CODES_YOBO: BathAddonCodes = {
  shokai: "624001", ninchiI: "626133", ninchiII: "626134",
  chuusankan: "628110", tokubetsu: "628000", shokibo: "628100",
};

/** careLevel から使うべき加算コード一式を返す (isYoboLevel のみで判定) */
export function bathAddonCodesFor(careLevel: string | null | undefined): BathAddonCodes {
  return isYoboLevel(careLevel) ? BATH_ADDON_CODES_YOBO : BATH_ADDON_CODES_KAIGO;
}

/** 基本サービスコードが介護給付(121)/予防給付(621)のどちらの体系か (%加算の母数集計用) */
export function isBathBaseCode(serviceCode: string | null | undefined): boolean {
  return /^(121|621)/.test(serviceCode ?? "");
}
