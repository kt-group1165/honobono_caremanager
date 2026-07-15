"use client";

/**
 * 障害福祉の月遅れ・返戻・過誤 再請求 合流ロジック (2026-07-15)
 *
 * 介護の lib/visit-seikyu/re-seikyu.ts と対称:
 *   - shogai_billing_status で tsukiokure / henrei / kago のいずれかが true かつ
 *     densou_target=false (= まだ伝送対象化していない) の「過去月」利用者を検出
 *   - その利用者を **元の提供月で再集計** (aggregateMonthlyShogaiSeikyu を過去年月で呼ぶ)
 *   - 当月一覧に「月遅れ / 返戻 / 過誤」バッジ付きで合流表示する
 *
 * 伝送 (J11/J61) は元提供月ごとの別ファイルにする必要があるため、行に
 *   __origMonthKey (YYYY-MM) / ym (YYYYMM) / __reasons を付与して返す
 *   (呼出側で元提供月ごとに buildShogaiDensou を分けて出力する)。
 *
 * ★ money-safety: 金額は aggregateMonthlyShogaiSeikyu (集計) をそのまま使う。
 *   本モジュールは再集計の呼び回しとフラグ付与のみで、金額計算には一切触れない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateMonthlyShogaiSeikyu,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";

/** 再請求の理由 (複数同時に立ちうる) */
export interface ShogaiReSeikyuReasons {
  tsukiokure: boolean; // 月遅れ
  henrei: boolean; // 返戻
  kago: boolean; // 過誤 (支払済の取下げ後の再請求)
}

/** 過誤申立の付帯情報 (kago=true の行のみ) */
export interface ShogaiKagoInfo {
  moushitateDate: string | null;
  jiyuCode: string | null;
  dougetsu: boolean;
}

/** 元提供月・再請求理由を付与した障害請求行 */
export type ShogaiReSeikyuRow = ShogaiSeikyuRow & {
  __origMonthKey: string; // 'YYYY-MM'
  ym: string; // 'YYYYMM'
  __reasons: ShogaiReSeikyuReasons;
  __kago: ShogaiKagoInfo | null;
};

export interface ShogaiReSeikyuResult {
  rows: ShogaiReSeikyuRow[];
  /** 元提供月ごとの再集計 warnings (「[再請求 R8/5] …」形式) */
  warnings: string[];
}

interface FlaggedRow {
  client_id: string;
  target_month: string;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
  kago_moushitate_date?: string | null;
  kago_jiyu_code?: string | null;
  kago_dougetsu?: boolean;
}

/**
 * currentMonthKey より前の月で、月遅れ/返戻/過誤フラグが立っており、まだ伝送対象化
 * (densou_target) されていない利用者を、元提供月で再集計して返す。
 */
export async function loadReSeikyuShogai(
  supabase: SupabaseClient,
  opts: {
    officeId: string;
    unitPrice?: number;
    currentMonthKey: string; // 'YYYY-MM'
  },
): Promise<ShogaiReSeikyuResult> {
  // 1) 月遅れ/返戻/過誤かつ未・伝送対象の過去月レコード。過誤付帯列は未適用環境で
  //    欠落しうるので 42703 で基本列にフォールバックする
  const SELECT_BASE = "client_id, target_month, tsukiokure, henrei, kago";
  const SELECT_EXT = `${SELECT_BASE}, kago_moushitate_date, kago_jiyu_code, kago_dougetsu`;
  const query = (cols: string) =>
    supabase
      .from("shogai_billing_status")
      .select(cols)
      .eq("office_id", opts.officeId)
      .eq("densou_target", false)
      .or("tsukiokure.eq.true,henrei.eq.true,kago.eq.true")
      .lt("target_month", opts.currentMonthKey);

  let res = await query(SELECT_EXT);
  if (res.error && res.error.code === "42703") {
    res = await query(SELECT_BASE);
  }
  if (res.error) {
    // フラグ列・テーブル未作成 (migration 未適用) は再請求なしで続行
    if (
      res.error.code === "42703" ||
      res.error.code === "PGRST204" ||
      res.error.code === "42P01" ||
      res.error.code === "PGRST205"
    ) {
      return { rows: [], warnings: [] };
    }
    throw new Error(`障害 再請求対象の取得に失敗: ${res.error.message}`);
  }

  const flagged = (res.data ?? []) as unknown as FlaggedRow[];
  if (flagged.length === 0) return { rows: [], warnings: [] };

  // 2) 月ごとにまとめ、client_id → reasons / 過誤付帯情報 を引けるようにする
  const byMonth = new Map<
    string,
    Map<string, { reasons: ShogaiReSeikyuReasons; kago: ShogaiKagoInfo | null }>
  >();
  for (const f of flagged) {
    if (!byMonth.has(f.target_month)) byMonth.set(f.target_month, new Map());
    byMonth.get(f.target_month)!.set(f.client_id, {
      reasons: {
        tsukiokure: !!f.tsukiokure,
        henrei: !!f.henrei,
        kago: !!f.kago,
      },
      kago: f.kago
        ? {
            moushitateDate: f.kago_moushitate_date ?? null,
            jiyuCode: f.kago_jiyu_code ?? null,
            dougetsu: !!f.kago_dougetsu,
          }
        : null,
    });
  }

  // 3) 月ごとに元提供月で再集計 → 該当利用者のみ抽出
  const out: ShogaiReSeikyuRow[] = [];
  const warnings: string[] = [];
  for (const [monthKey, clientFlags] of byMonth) {
    const [y, m] = monthKey.split("-").map((n) => Number(n));
    if (!y || !m) continue;
    const ym = `${y}${String(m).padStart(2, "0")}`;

    const result = await aggregateMonthlyShogaiSeikyu(supabase, {
      officeId: opts.officeId,
      year: y,
      month: m,
      unitPrice: opts.unitPrice,
    });

    // 再集計 warnings は再請求フラグの立っている利用者分のみに絞る (ノイズ除去)
    const flaggedNames = new Set<string>();
    for (const r of result.rows) {
      if (clientFlags.has(r.user_id)) flaggedNames.add(r.user_name);
    }
    warnings.push(
      ...result.warnings
        .filter((w) => [...flaggedNames].some((n) => w.includes(n)))
        .map((w) => `[再請求 R${y - 2018}/${m}] ${w}`),
    );

    for (const r of result.rows) {
      const flags = clientFlags.get(r.user_id);
      if (!flags) continue; // フラグの立っていない利用者は含めない
      out.push({
        ...r,
        __origMonthKey: monthKey,
        ym,
        __reasons: flags.reasons,
        __kago: flags.kago,
      });
    }
  }

  // 古い提供月 → ふりがな順
  out.sort((a, b) => {
    if (a.__origMonthKey !== b.__origMonthKey) {
      return a.__origMonthKey < b.__origMonthKey ? -1 : 1;
    }
    return (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    );
  });

  return { rows: out, warnings };
}
