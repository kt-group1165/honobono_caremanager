import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK, mapChunksParallel } from "./chunk-parallel";

/**
 * 「いま実際に稼働している利用者」に絞り込む。アラートの母数を決めるのに使う。
 *
 * ── なぜ要るか (2026-09-03 実測) ──────────────────────────────────────────
 *   アラートの母集団は仕様上「自事業所 (client_office_assignments.end_date IS NULL)」
 *   だが、**end_date は 8,252 行すべて NULL** だった。割当は一度作ると閉じられない
 *   運用なので、この条件は**何も絞っていない**。結果:
 *
 *     母数 7,650 名 に対し 実稼働は 2,283〜2,957 名 (業態による)
 *     認定の期限切れ  母数ベース 1,355 名 / 実稼働ベース 78 名
 *
 *   全事業所のダッシュボードを開けば通知が 1,355 件に向かって積み上がり、
 *   本物が埋もれる (= 狼少年)。実際、既存の認定アラート 220 件は **全件未読**。
 *
 * ── なぜ「シフトの有無」だけではダメか ────────────────────────────────────
 *   ⚠ 居宅介護支援の利用者は kaigo_visit_schedule に行を持たない。
 *     実測: 居宅 5,465 名のうちシフトがあるのは **466 名 (8.5%)** だけ。
 *     シフトだけで絞ると **居宅の 91.5% が沈黙する**。
 *   → シフト **または** 居宅介護支援のレセプトで判定する。
 *     実測: 居宅 54.1% / 訪問介護 86.3% が実稼働。
 *     居宅 2,957 名は 2026-06 のレセプト実績 2,806 件とも整合する。
 *
 *   ⚠ 障害の訪問も kaigo_visit_schedule に入る (system 列で制度を分ける) ので、
 *     シフト側で拾える。障害専用のシグナルは足していない。
 *
 * ── 判定 ──────────────────────────────────────────────────────────────
 *   直近 ACTIVITY_MONTHS_BACK ヶ月に
 *     kaigo_visit_schedule.visit_date        (訪問介護・障害)  … いずれか、または
 *     kaigo_care_support_claims.billing_month (居宅介護支援)
 *   がある利用者を「実稼働」とする。
 *
 *   ⚠ 取込が止まっている月があると実稼働が過少になる。**期間を短くしすぎない**こと。
 */

/** 実稼働とみなす遡り月数。短くすると取込の遅れで利用者が落ちる。 */
export const ACTIVITY_MONTHS_BACK = 3;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 'YYYY-MM-DD' (ローカル日付。toISOString は JST で前日になるので使わない) */
function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 遡り開始日 / 開始月 ('YYYY-MM') を返す */
export function activityCutoff(
  today: Date = new Date(),
  monthsBack: number = ACTIVITY_MONTHS_BACK,
): { sinceDate: string; sinceMonth: string } {
  const d = new Date(today.getFullYear(), today.getMonth() - monthsBack, 1);
  return { sinceDate: dateToIso(d), sinceMonth: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` };
}

const PAGE = 1000;

/**
 * clientIds のうち「直近に稼働がある」ものだけを Set で返す。
 *
 * ⚠ 呼出側は **Set が空でも通常どおり扱う**こと。ここで空になるのは
 *   「その事業所に稼働が無い」という正しい結果でもあり得る。
 */
export async function filterRecentlyActiveClients(
  supabase: SupabaseClient,
  clientIds: string[],
  today: Date = new Date(),
): Promise<Set<string>> {
  const active = new Set<string>();
  if (clientIds.length === 0) return active;
  const { sinceDate, sinceMonth } = activityCutoff(today);

  // 訪問介護・障害のシフト
  const schChunks = await mapChunksParallel(clientIds, ID_IN_CHUNK, async (chunk) => {
    const out: { user_id: string }[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("user_id")
        .in("user_id", chunk)
        .gte("visit_date", sinceDate)
        .order("user_id") // page-loop の安定順序 (無いと行が抜ける)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`シフトの取得に失敗: ${error.message}`);
      const rows = (data ?? []) as { user_id: string }[];
      out.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  });
  for (const rows of schChunks) for (const r of rows) active.add(r.user_id);

  // 居宅介護支援のレセプト (シフトを持たない業態のため必須)
  const claimChunks = await mapChunksParallel(clientIds, ID_IN_CHUNK, async (chunk) => {
    const out: { user_id: string }[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("kaigo_care_support_claims")
        .select("user_id")
        .in("user_id", chunk)
        .gte("billing_month", sinceMonth)
        .order("user_id")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`居宅レセプトの取得に失敗: ${error.message}`);
      const rows = (data ?? []) as { user_id: string }[];
      out.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  });
  for (const rows of claimChunks) for (const r of rows) active.add(r.user_id);

  return active;
}
