// 介護 (要介護) / 予防 (要支援・事業対象者) の様式判定。
//
// 居宅介護支援では認定区分によって使う帳票様式が排他的に決まる:
//   要介護1〜5      → アセスメント / 居宅サービス計画書 第1〜3表
//   要支援1・2      → 介護予防のためのアセスメント / 介護予防サービス・支援計画書
//   事業対象者      → 同上 (総合事業)
// つまり「介護版か予防版か」は操作者が選ぶものではなく利用者 (正確には認定期間) の
// 属性なので、メニューを 2 本に分けず認定区分から導出する。この module はその
// 唯一の判定元。"use client" を付けず Server / Client 両方から import できるように
// 独立させている (reports/[type]/report-config.ts と同流儀)。

/** 予防様式を使う区分か (要支援1・2 / 事業対象者) */
export function isYoboLevel(careLevel: string | null | undefined): boolean {
  return !!careLevel && /要支援|事業対象者/.test(careLevel);
}

export type KaigoFormKind = "kaigo" | "yobo";

/**
 * care_level から使用する様式を決める。
 * 認定が未登録 (null / 空) のときは介護版を既定にする — 新規利用者は要介護での
 * 依頼が大半で、予防なら認定登録後に自動で予防様式へ切り替わる。
 */
export function formKindForCareLevel(careLevel: string | null | undefined): KaigoFormKind {
  return isYoboLevel(careLevel) ? "yobo" : "kaigo";
}

/** 様式の表示名 (バッジ・注意文で使う) */
export const FORM_KIND_LABEL: Record<KaigoFormKind, string> = {
  kaigo: "介護",
  yobo: "予防",
};
