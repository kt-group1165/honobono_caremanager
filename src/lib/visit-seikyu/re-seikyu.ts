"use client";

/**
 * 月遅れ・返戻の再請求 合流ロジック (Phase 2)
 *
 * ほのぼの の「月遅れ / 返戻」フロー相当。
 *   - kaigo_billing_status で tsukiokure=true または henrei=true かつ
 *     kokuho_target 未立の「過去月」の利用者を検出
 *   - その利用者を **元の提供月で再集計** (aggregate を過去年月で呼ぶ)
 *   - 当月一覧に「月遅れ / 返戻」バッジ付きで合流表示する
 *
 * 明細書・伝送には各自の元提供月 (ym) を反映するため、行に
 *   __origMonthKey (YYYY-MM) / __reasons (月遅れ/返戻) を付与して返す。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateMonthlyVisitSeikyu,
  type UserSeikyuRow,
} from "@/lib/visit-seikyu/aggregate";

/** 再請求の理由 (複数同時に立ちうる) */
export interface ReSeikyuReasons {
  tsukiokure: boolean; // 月遅れ
  henrei: boolean; // 返戻
}

/** 元提供月・再請求理由を付与した請求行 */
export type ReSeikyuRow = UserSeikyuRow & {
  /** 元の提供月 (YYYY-MM)。当月の通常行には付かない */
  __origMonthKey: string;
  /** 伝送・明細書用の元提供年月 (YYYYMM) */
  ym: string;
  /** 再請求の理由 */
  __reasons: ReSeikyuReasons;
};

interface FlaggedRow {
  client_id: string;
  target_month: string; // 'YYYY-MM'
  tsukiokure: boolean;
  henrei: boolean;
}

/**
 * 当月 (currentMonthKey) より前の月で、月遅れ/返戻フラグが立っており
 * まだ国保対象化されていない利用者を、元提供月で再集計して返す。
 *
 * @param currentMonthKey 選択中の請求月 (YYYY-MM)。これより前のみ対象
 */
export async function loadReSeikyuRows(
  supabase: SupabaseClient,
  opts: {
    officeId: string;
    tenantId: string;
    unitPrice?: number;
    appliedFormulaCodes?: string[];
    currentMonthKey: string; // 'YYYY-MM'
  },
): Promise<ReSeikyuRow[]> {
  // 1) 月遅れ/返戻かつ未・国保対象の過去月レコードを取得
  const { data, error } = await supabase
    .from("kaigo_billing_status")
    .select("client_id, target_month, tsukiokure, henrei")
    .eq("kokuho_target", false)
    .or("tsukiokure.eq.true,henrei.eq.true")
    .lt("target_month", opts.currentMonthKey);
  if (error) {
    // table 未作成 (migration 未適用) 等は再請求なしで続行 (呼出側で握る)
    if (error.code === "42P01") return [];
    throw new Error(`再請求対象の取得に失敗: ${error.message}`);
  }

  const flagged = (data ?? []) as FlaggedRow[];
  if (flagged.length === 0) return [];

  // 2) 月ごとにまとめ、client_id → reasons を引けるようにする
  const byMonth = new Map<string, Map<string, ReSeikyuReasons>>();
  for (const f of flagged) {
    if (!byMonth.has(f.target_month)) byMonth.set(f.target_month, new Map());
    byMonth.get(f.target_month)!.set(f.client_id, {
      tsukiokure: !!f.tsukiokure,
      henrei: !!f.henrei,
    });
  }

  // 3) 月ごとに元提供月で再集計 → 該当利用者のみ抽出
  const out: ReSeikyuRow[] = [];
  for (const [monthKey, clientReasons] of byMonth) {
    const [y, m] = monthKey.split("-").map((n) => Number(n));
    if (!y || !m) continue;
    const ym = `${y}${String(m).padStart(2, "0")}`;

    const result = await aggregateMonthlyVisitSeikyu(supabase, {
      officeId: opts.officeId,
      tenantId: opts.tenantId,
      year: y,
      month: m,
      unitPrice: opts.unitPrice,
      appliedFormulaCodes: opts.appliedFormulaCodes ?? [],
    });

    for (const r of result.rows) {
      const reasons = clientReasons.get(r.user_id);
      if (!reasons) continue; // フラグの立っていない利用者は当月分に含めない
      out.push({
        ...r,
        __origMonthKey: monthKey,
        ym,
        __reasons: reasons,
      });
    }
  }

  // 古い提供月 → ふりがな の順
  out.sort((a, b) => {
    if (a.__origMonthKey !== b.__origMonthKey) {
      return a.__origMonthKey < b.__origMonthKey ? -1 : 1;
    }
    return (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    );
  });

  return out;
}
