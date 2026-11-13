/**
 * 第7表 (利用票別表 service-usage-detail) から 訪問介護の事業所の「計画単位数」(区分支給限度基準内単位数) を決める
 * (2026-11-13 H 依頼。billing-visit/_shared/monthly-info-content.tsx の「別表から取込」から切り出した)
 *
 * なぜ純関数にしたか: 画面の中にあると検査から呼べず、穴が見えないまま残る (作法⑪)。直す前は次の 3 つが眠っていた:
 *   ① その月の第7表を limit(1000) で読んでいた (2026-06 は 2,850 件) → 画面側で全件を読むように直した
 *   ② 人ごとに「最新の 1 件」だけを採用 → 同じ人に第7表が 2 件 (転居月の 2 保険者など) あると もう 1 件を黙って捨てる
 *   ③ within_limit_units をそのまま足す → パーサは「区分支給限度を超える単位数」を読まず 0 固定 (over_limit_units)
 *      なので within_limit_units = サービス単位。限度を超えた人では 計画単位数が大きく入る (= 過大請求の側)
 *
 * 決め方 (★ 決められない人は 書かずに名前を返す。黙って選ばない):
 *   ・自事業所の行 = provider_number が事業所番号 or provider_name が事業所名
 *   ・自事業所の行を持つ第7表が その人に 2 件以上 → multi (書かない)
 *   ・その人の第7表で 限度額対象の単位の合計 > 限度額 → overLimit (書かない。超過の割り振りは第7表画面の GendoAllocationPanel で人が決める)
 *     ★ 2026-11-13 段2: ただし第7表に 行ごとの超過 (over_limit_units / _over_limit_unallocated。段1 のパーサが読む) が入っていれば、
 *       ほのぼのが印字した割り振りが分かるので 自事業所の行の within_limit_units (= サービス単位 − 超過) を足して書く。
 *       自事業所の「割り振れなかった超過」(事業所の合計行にしか印字されない超過) は どの行の分かは決まらないが ★ 自事業所の分なので
 *       合計からは引ける (計画単位数は合計で持つので 行の割り振りは要らない)。2026-06 の 7 名で 7/7 決まった
 *       超過の情報が無い (段1 より前に取り込んだ) 第7表は 従来どおり書かない
 *   ・それ以外 → 自事業所の行の within_limit_units の合計
 */
import { limitSubjectUnitsOfDetail, type DetailItemLike } from "@/lib/usage-limit-total";

export type BeppyoItem = DetailItemLike & {
  provider_number?: string | null;
  provider_name?: string | null;
  within_limit_units?: number | string | null;
  over_limit_units?: number | string | null;
  /** 事業所の合計行にしか印字されず 行に割り振れなかった超過 (段1 のパーサ) */
  _over_limit_unallocated?: number | string | null;
};
export type BeppyoDoc = {
  user_id: string;
  content: { items?: BeppyoItem[] | null; limit_amount?: number | string | null; user_name?: string | null } | null;
};
export type BeppyoPlanResult = {
  /** 書いてよい人: user_id → 計画単位数 */
  units: Map<string, number>;
  /** 自事業所の行を持つ第7表が 2 件以上ある人 (書かない) */
  multi: { userId: string; name: string; docs: number }[];
  /** 第7表で限度額を超えていて 自事業所の基準内が決められない人 (書かない)。reason: no-over-info = 超過の情報が無い (段1 より前に取り込んだ) 第7表 */
  overLimit: { userId: string; name: string; used: number; limit: number; reason: "no-over-info" }[];
};

export function planUnitsFromBeppyo(
  docs: readonly BeppyoDoc[],
  office: { number: string | null; name: string | null },
): BeppyoPlanResult {
  const isOwn = (it: BeppyoItem) =>
    (office.number != null && it.provider_number === office.number) || (office.name != null && it.provider_name === office.name);
  const byUser = new Map<string, BeppyoDoc[]>();
  for (const d of docs) {
    const items = d.content?.items;
    if (!Array.isArray(items) || !items.some(isOwn)) continue;
    const list = byUser.get(d.user_id) ?? [];
    list.push(d);
    byUser.set(d.user_id, list);
  }
  const res: BeppyoPlanResult = { units: new Map(), multi: [], overLimit: [] };
  for (const [userId, list] of byUser) {
    const name = String(list[0].content?.user_name ?? "");
    if (list.length > 1) { res.multi.push({ userId, name, docs: list.length }); continue; }
    const items = list[0].content?.items ?? [];
    const limit = Number(list[0].content?.limit_amount);
    const used = limitSubjectUnitsOfDetail(items);
    if (Number.isFinite(limit) && limit > 0 && used > limit) {
      const hasOverInfo = items.some((it) => Number(it.over_limit_units) > 0 || Number(it._over_limit_unallocated) > 0);
      if (!hasOverInfo) { res.overLimit.push({ userId, name, used, limit, reason: "no-over-info" }); continue; }
    }
    // 自事業所の行の基準内の合計 − 自事業所の合計行にしか出なかった超過 (段1。無ければ 0 で 従来と同じ)
    const own = items.filter(isOwn);
    res.units.set(userId, own.reduce((s, it) => s + (Number(it.within_limit_units) || 0), 0) - own.reduce((s, it) => s + (Number(it._over_limit_unallocated) || 0), 0));
  }
  return res;
}
