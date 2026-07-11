/**
 * 訪問介護 同一建物減算 — 設定と実態の突合チェック (提案・警告のみ。自動書換なし)
 *
 * ── 制度要件 (令和6年度改定後。根拠: 指定居宅サービス介護給付費単位数表
 *    (平成12年厚生省告示第19号) 訪問介護費 注、留意事項通知 (老企第36号)、
 *    令和6年度介護報酬改定 Q&A Vol.1 (令和6年3月15日)) ─────────────────────
 *
 * 減算1 (所定単位数の 10% 減算, コード 114114):
 *   イ) 事業所と同一敷地内建物等 (構造上又は外形上一体の建築物、および
 *       同一敷地内・隣接する敷地内に所在し効率的なサービス提供が可能な建物)
 *       に居住する利用者に提供した場合 (人数要件なし)
 *   ロ) イ以外の建物 (同一建物) に居住する利用者が 1 月あたり 20 人以上の場合、
 *       その建物の居住者に提供した場合
 *
 * 減算2 (15% 減算, コード 114115):
 *   事業所と同一敷地内建物等のうち、当該建物に居住する利用者が 1 月あたり
 *   50 人以上の場合。「1 月あたりの利用者数」は当月の日ごとの当該建物居住
 *   利用者数の合計を当月日数で除した平均 (小数点以下切捨て) で判定する
 *   (本チェックは当月の実利用者数 (実人員) で近似 → 注記あり)。
 *
 * 減算3 (12% 減算, コード 114116。令和6年度新設):
 *   正当な理由なく、判定期間 (前 6 月) に指定訪問介護を提供した利用者 (実人員)
 *   のうち、同一敷地内建物等に居住する利用者 (実人員) の占める割合が 90% 以上の
 *   場合 (減算2 (50 人以上) の対象建物の居住者を除く)。
 *   判定期間と適用期間:
 *     前期判定 3/1〜8/31  → 適用 10/1〜翌 3/31 (届出は 9/15 まで)
 *     後期判定 9/1〜2月末 → 適用 4/1〜9/30   (届出は 3/15 まで)
 *   正当な理由の例: 特別地域訪問介護加算の対象事業所 / 判定期間の 1 月あたり
 *   延べ訪問回数 200 回以下等の小規模事業所 / 通常の事業実施地域内に同一敷地内
 *   建物等以外に居住する要介護高齢者が少数である場合 等。
 *   ※ 12% 判定の分子は「同一敷地内建物等」(イ・減算2の建物) の居住者であり、
 *     減算1ロ (それ以外の建物 20 人以上) は本来含まれないが、tier 設定 ('1') からは
 *     イとロを区別できないため本チェックでは tier '1'/'2' を分子として近似する。
 *
 * ── 自動化の範囲 ──────────────────────────────────────────────────────────
 * 建物マスタが無いため完全自動判定はできない。clients.address の正規化文字列で
 * 「同一建物らしき集団」を推定し、client_office_assignments.same_building_tier の
 * 手動設定と突合して提案・警告を返す。判定はあくまで参考情報 (誤検知あり):
 *   - 表記ゆれ (丁目/番/号 と ハイフン、漢数字、建物名の省略) で別グループになる
 *   - 番地のみ同じ別建物 (号室無し表記) を同一建物と誤推定しうる
 *   - 事業所と同一敷地内・隣接かどうか (減算1イ) は住所からは判定できない
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SameBuildingTier } from "./same-building";

// ─── 型 ───────────────────────────────────────────────────────────────────────

export interface BuildingMember {
  clientId: string;
  name: string;
  /** clients.address の生値 */
  address: string | null;
  /** client_office_assignments.same_building_tier (自事業所)。null = 未設定 */
  tier: SameBuildingTier | null;
}

export interface BuildingGroup {
  /** 正規化住所 (グルーピングキー) */
  key: string;
  /** 代表表示用の生住所 (最初のメンバーのもの) */
  displayAddress: string;
  /** 当月利用者のメンバー */
  members: BuildingMember[];
  /** グループへの提案 (null = 提案なし) */
  suggestion: { tier: SameBuildingTier; reason: string } | null;
  /** メンバー間で tier 設定が不一致 (同一建物なのに一部だけ設定等) */
  inconsistent: boolean;
}

export interface Tier3Check {
  /** 判定期間 'YYYY-MM-DD' */
  periodFrom: string;
  periodTo: string;
  /** 「前期判定 (3/1〜8/31) → 適用 10/1〜3/31」等 */
  periodLabel: string;
  /** 判定期間の実利用者数 (分母)。取得失敗時は当月実人員 */
  totalUsers: number;
  /** うち同一建物等居住者 (tier '1'/'2' 設定者で近似) (分子) */
  sameBuildingUsers: number;
  /** 割合 (0〜1)。分母 0 は 0 */
  ratio: number;
  /** ratio >= 90% なのに tier '3' でない当月の対象者 (tier '1' 設定者) */
  shouldBeTier3: BuildingMember[];
  /** ratio < 90% なのに tier '3' が付いている当月利用者 */
  staleTier3: BuildingMember[];
  /** 判定期間の月平均延べ訪問回数 (200 回以下は正当な理由に該当しうる)。不明は null */
  avgMonthlyVisits: number | null;
  /** 判定方法の注記 (6 ヶ月取得失敗→当月のみ 等) */
  notes: string[];
}

export interface SameBuildingCheckResult {
  /** 対象月 'YYYY-MM' */
  monthKey: string;
  /** 当月の実利用者数 (チェック対象) */
  monthUserCount: number;
  /** 住所未登録で建物推定から除外した当月利用者 */
  noAddressMembers: BuildingMember[];
  /** 同一建物らしき集団 (2 人以上) + tier 設定済みの単独者 (人数降順) */
  groups: BuildingGroup[];
  /** 減算3 (90% ルール) チェック */
  tier3: Tier3Check;
  /** 画面上部に出す警告文 */
  warnings: string[];
  /** same_building_tier 列が未適用 (migration 未適用) → tier は全員未設定扱い */
  tierColumnMissing: boolean;
}

// ─── 住所の正規化 (単純な表記ゆれ吸収 + 号室除去) ──────────────────────────────

const toHankakuAlnum = (s: string) =>
  s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );

/**
 * グルーピング用の住所正規化。
 *   - 全角英数字 → 半角、英字は大文字化
 *   - 空白 (全角/半角) 除去
 *   - 各種ハイフン (ー − ‐ ― 〜 等) を '-' に統一
 *   - 末尾の部屋番号を除去:
 *       「101号室」は常に除去。
 *       「101号」は直前が数字・「番」・'-' でない場合のみ除去
 *       (= 「2番3号」「1-2-3号」の番地表記は保持、「コーポ田中2号」は除去)
 * 漢数字・建物名の省略などの表記ゆれは吸収しない (限界として UI に注記)。
 */
export function normalizeAddressForGrouping(raw: string): string {
  let s = toHankakuAlnum(raw.trim()).toUpperCase();
  s = s.replace(/[\s　]+/g, "");
  s = s.replace(/[ー−‐―－˗‑–—~〜]/g, "-");
  s = s.replace(/[0-9]{1,4}号室$/, "");
  s = s.replace(/(?<![0-9番-])[0-9]{1,4}号$/, "");
  return s;
}

// ─── 減算3 の判定期間 (対象月が属する適用期間に対応する前 6 月) ────────────────

export function judgmentPeriodForMonth(
  year: number,
  month: number,
): { from: string; to: string; label: string } {
  const fmt = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (month >= 4 && month <= 9) {
    // 適用期間 4/1〜9/30 ← 後期判定 前年9/1〜当年2月末
    const febLast = new Date(year, 2, 0).getDate(); // 当年2月の末日
    return {
      from: fmt(year - 1, 9, 1),
      to: fmt(year, 2, febLast),
      label: `後期判定 (${year - 1}/9/1〜${year}/2/${febLast}) → 適用 ${year}/4/1〜9/30`,
    };
  }
  // 適用期間 10/1〜翌3/31 ← 前期判定 3/1〜8/31 (10〜12月は当年、1〜3月は前年)
  const jy = month >= 10 ? year : year - 1;
  return {
    from: fmt(jy, 3, 1),
    to: fmt(jy, 8, 31),
    label: `前期判定 (${jy}/3/1〜8/31) → 適用 ${jy}/10/1〜${jy + 1}/3/31`,
  };
}

// ─── fetch helpers (error は握らず check。列/テーブル未適用のみフォールバック) ──

const isColumnMissing = (code: string | null | undefined) =>
  code === "42703" || code === "PGRST204";

/** clients の氏名・住所 (chunk .in) */
async function fetchClients(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, { name: string; address: string | null }>> {
  const map = new Map<string, { name: string; address: string | null }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, address")
      .in("id", chunk);
    if (error) throw new Error(`利用者住所の取得失敗: ${error.message}`);
    for (const c of (data ?? []) as {
      id: string;
      name: string;
      address: string | null;
    }[]) {
      map.set(c.id, { name: c.name, address: c.address });
    }
  }
  return map;
}

/**
 * 自事業所の same_building_tier (chunk .in)。
 * 列未適用 (42703/PGRST204) は { map: 空, columnMissing: true } でフォールバック。
 */
async function fetchTiers(
  supabase: SupabaseClient,
  officeId: string,
  ids: string[],
): Promise<{ map: Map<string, SameBuildingTier>; columnMissing: boolean }> {
  const map = new Map<string, SameBuildingTier>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { data, error } = await supabase
      .from("client_office_assignments")
      .select("client_id, same_building_tier")
      .eq("office_id", officeId)
      .in("client_id", chunk);
    if (error) {
      if (isColumnMissing(error.code)) return { map: new Map(), columnMissing: true };
      throw new Error(`同一建物減算区分の取得失敗: ${error.message}`);
    }
    for (const r of (data ?? []) as {
      client_id: string;
      same_building_tier: string | null;
    }[]) {
      const t = r.same_building_tier;
      if (t === "1" || t === "2" || t === "3") map.set(r.client_id, t);
    }
  }
  return { map, columnMissing: false };
}

/**
 * 判定期間の実績 (completed) から実利用者と延べ訪問回数を取得 (page-loop)。
 * office_id 列未適用 (42703) は全事業所実績にフォールバック (note 付き)。
 */
async function fetchPeriodUsage(
  supabase: SupabaseClient,
  officeId: string,
  from: string,
  to: string,
): Promise<{ userIds: Set<string>; totalVisits: number; note: string | null }> {
  const PAGE = 1000;
  const load = async (withOffice: boolean) => {
    const userIds = new Set<string>();
    let totalVisits = 0;
    let offset = 0;
    while (true) {
      let q = supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id")
        .eq("status", "completed")
        .gte("visit_date", from)
        .lte("visit_date", to);
      if (withOffice) {
        // aggregate.ts と同じ C5 基準: 自事業所 + office_id 未設定 (移行期データ)
        q = q.or(`office_id.eq.${officeId},office_id.is.null`);
      }
      const { data, error } = await q
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as { id: string; user_id: string }[];
      for (const r of rows) userIds.add(r.user_id);
      totalVisits += rows.length;
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return { userIds, totalVisits };
  };
  try {
    return { ...(await load(true)), note: null };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "42703") {
      // office_id 列未適用 → 全事業所の実績で判定 (aggregate と同じフォールバック)
      const r = await load(false);
      return {
        ...r,
        note: "kaigo_visit_schedule.office_id 未適用のため全事業所の実績で判定しています",
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`判定期間の実績取得失敗: ${msg}`);
  }
}

// ─── 本体 ─────────────────────────────────────────────────────────────────────

export interface SameBuildingCheckOpts {
  officeId: string;
  year: number;
  month: number;
  /** 対象月の実利用者 id (請求集計の rows から渡す) */
  monthUserIds: string[];
}

export async function runSameBuildingCheck(
  supabase: SupabaseClient,
  opts: SameBuildingCheckOpts,
): Promise<SameBuildingCheckResult> {
  const { officeId, year, month } = opts;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const monthUserIds = Array.from(new Set(opts.monthUserIds));
  const warnings: string[] = [];

  // ── 当月利用者の住所・tier ──
  const [clientMap, tierRes] = await Promise.all([
    fetchClients(supabase, monthUserIds),
    fetchTiers(supabase, officeId, monthUserIds),
  ]);
  const tierMap = tierRes.map;
  if (tierRes.columnMissing) {
    warnings.push(
      "same_building_tier 列が未適用のため、全員「未設定」として突合しています (migrations/kaigo_visit_same_building.sql を適用してください)",
    );
  }

  const members: BuildingMember[] = monthUserIds.map((id) => {
    const c = clientMap.get(id);
    return {
      clientId: id,
      name: c?.name ?? id,
      address: c?.address ?? null,
      tier: tierMap.get(id) ?? null,
    };
  });

  // ── 住所正規化でグルーピング ──
  const byKey = new Map<string, BuildingMember[]>();
  const noAddressMembers: BuildingMember[] = [];
  for (const m of members) {
    const addr = m.address?.trim();
    if (!addr) {
      noAddressMembers.push(m);
      continue;
    }
    const key = normalizeAddressForGrouping(addr);
    if (!key) {
      noAddressMembers.push(m);
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(m);
  }

  // 2 人以上のグループ + tier 設定済みの単独者 (設定の見落とし確認用) を表示対象に
  const groups: BuildingGroup[] = [];
  for (const [key, ms] of byKey) {
    if (ms.length < 2 && !ms.some((m) => m.tier !== null)) continue;
    const size = ms.length;
    const tiersInGroup = new Set(ms.map((m) => m.tier ?? ""));
    let suggestion: BuildingGroup["suggestion"] = null;
    if (size >= 50 && ms.some((m) => m.tier !== "2")) {
      suggestion = {
        tier: "2",
        reason: `当月 ${size} 人が同一建物と推定 — 月 50 人以上なら減算2 (15%) の対象です (正確には日ごと平均 (小数点以下切捨て) で判定)`,
      };
    } else if (size >= 20 && ms.some((m) => m.tier === null)) {
      suggestion = {
        tier: "1",
        reason: `当月 ${size} 人が同一建物と推定 — 事業所と同一敷地内・隣接でない建物でも月 20 人以上なら減算1 (10%) の対象です`,
      };
    }
    groups.push({
      key,
      displayAddress: ms[0].address ?? key,
      members: ms,
      suggestion,
      // 2 人以上で設定がバラバラ (一部のみ設定 / tier 混在) は要確認
      inconsistent: size >= 2 && tiersInGroup.size > 1,
    });
  }
  groups.sort((a, b) => b.members.length - a.members.length);

  for (const g of groups) {
    if (g.inconsistent) {
      warnings.push(
        `「${g.displayAddress}」の ${g.members.length} 人で同一建物減算の設定が不一致です (同一建物なら原則同じ区分になります)`,
      );
    }
    if (g.suggestion) {
      warnings.push(`「${g.displayAddress}」: ${g.suggestion.reason}`);
    }
  }
  if (noAddressMembers.length > 0) {
    warnings.push(
      `住所未登録の利用者が ${noAddressMembers.length} 人います (建物推定の対象外)`,
    );
  }

  // ── 減算3 (90% ルール): 判定期間 (前 6 月) の実人員ベース ──
  const period = judgmentPeriodForMonth(year, month);
  const tier3Notes: string[] = [];
  let periodUserIds: string[];
  let avgMonthlyVisits: number | null = null;
  try {
    const usage = await fetchPeriodUsage(supabase, officeId, period.from, period.to);
    if (usage.note) tier3Notes.push(usage.note);
    periodUserIds = Array.from(usage.userIds);
    avgMonthlyVisits = Math.round(usage.totalVisits / 6);
  } catch (e) {
    // 6 ヶ月分の取得に失敗しても当月実人員で参考値を出す (注記付き)
    console.error(
      "同一建物チェック: 判定期間の実績取得に失敗:",
      e instanceof Error ? e.message : String(e),
    );
    periodUserIds = monthUserIds;
    tier3Notes.push(
      "判定期間 (前 6 月) の実績取得に失敗したため、当月の実利用者のみで割合を計算しています (参考値)",
    );
  }

  // 判定期間利用者の tier (当月分は取得済なので差分のみ)
  let periodTierMap = tierMap;
  if (!tierRes.columnMissing) {
    const extra = periodUserIds.filter((id) => !clientMap.has(id));
    if (extra.length > 0) {
      const extraRes = await fetchTiers(supabase, officeId, extra);
      periodTierMap = new Map([...tierMap, ...extraRes.map]);
    }
  }

  const totalUsers = periodUserIds.length;
  // 分子 = 同一敷地内建物等の居住者。tier '1'/'2' 設定者で近似
  // (減算1ロ (別建物 20 人以上) は本来分子に含まれないが tier からは区別不能 — ヘッダコメント参照)
  const sameBuildingUsers = periodUserIds.filter((id) => {
    const t = periodTierMap.get(id);
    return t === "1" || t === "2";
  }).length;
  const ratio = totalUsers > 0 ? sameBuildingUsers / totalUsers : 0;

  const shouldBeTier3: BuildingMember[] = [];
  const staleTier3: BuildingMember[] = [];
  if (ratio >= 0.9) {
    // 90% 以上 → 同一建物等居住者は 10% ではなく 12% (減算3)。
    // 減算2 ('2' = 50 人以上) の対象者は 15% のままで除外。
    for (const m of members) {
      if (m.tier === "1") shouldBeTier3.push(m);
    }
    if (shouldBeTier3.length > 0) {
      warnings.push(
        `同一建物等居住者の割合が ${(ratio * 100).toFixed(1)}% (90% 以上) です — 減算1 (10%) 設定の ${shouldBeTier3.length} 人は減算3 (12%) が正しい可能性があります (正当な理由がある場合を除く)`,
      );
    }
  } else {
    for (const m of members) {
      if (m.tier === "3") staleTier3.push(m);
    }
    if (staleTier3.length > 0) {
      warnings.push(
        `同一建物等居住者の割合が ${(ratio * 100).toFixed(1)}% (90% 未満) です — 減算3 (12%) 設定の ${staleTier3.length} 人は減算1 (10%) 等への見直しが必要な可能性があります`,
      );
    }
  }
  if (avgMonthlyVisits !== null && avgMonthlyVisits <= 200 && ratio >= 0.9) {
    tier3Notes.push(
      `判定期間の月平均延べ訪問回数が ${avgMonthlyVisits} 回 (200 回以下) のため、小規模事業所として「正当な理由」に該当し減算3 が適用されない可能性があります (保険者に確認)`,
    );
  }
  if (tierRes.columnMissing) {
    tier3Notes.push("tier 列未適用のため分子 (同一建物等居住者) は 0 として計算");
  }

  return {
    monthKey,
    monthUserCount: monthUserIds.length,
    noAddressMembers,
    groups,
    tier3: {
      periodFrom: period.from,
      periodTo: period.to,
      periodLabel: period.label,
      totalUsers,
      sameBuildingUsers,
      ratio,
      shouldBeTier3,
      staleTier3,
      avgMonthlyVisits,
      notes: tier3Notes,
    },
    warnings,
    tierColumnMissing: tierRes.columnMissing,
  };
}
