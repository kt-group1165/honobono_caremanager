"use client";

/**
 * 国保請求 — 国保連請求の集計 + 伝送ファイル・確認用CSV の作成
 * (見た目: 介護請求タブ = order-app 介護請求タブと同一のグレーヘッダ + 格子テーブル)
 *
 * 構成:
 *  左: あかさたな索引 / 中央: ツールバー + 格子テーブル + 合計フッタ
 *  出力: 国保連伝送ファイル (7111 + 7131 / Shift_JIS) + 確認用CSV
 *
 * kaigo_billing_status 連携 (居宅版 billing/seikyu/_kokuho-seikyu.tsx と同方針):
 *   - 当月分のうち 月遅れ/返戻/過誤 フラグの行は伝送対象から除外 (過誤=取下げ済。後月に再請求)
 *   - 過去月の月遅れ/返戻 (未・国保対象) は再請求行として合流し、
 *     元提供月ごとに別ファイル (提供年月 = 元提供月) として出力する。
 *     コントロールレコードの処理対象年月 (審査月) は同じ提出バッチ
 *     (= 選択中の請求月の翌月) を使う — build.ts 参照。
 *
 * 機能 (従来どおり): チェックで出力対象を絞込 (未チェック時は全件)。
 * ※ 明細書・請求書の発行は「介護請求」画面へ移設済み。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  Download,
  Send,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { saveBlobToFile, saveFilesToFolder } from "@/lib/save-file";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "../_shared/seikyu-context";
import { buildKokuhoDensou, type DensouRow } from "@/lib/kokuho-densou/build";
import { buildSougouDensou, type SougouDensouRow } from "@/lib/kokuho-densou/build-sougou";
import {
  loadReSeikyuRows,
  type ReSeikyuReasons,
  type ReSeikyuRow,
  type ReSeikyuSougouRow,
} from "@/lib/visit-seikyu/re-seikyu";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { ShinsaKekkaImport } from "@/components/kokuho-shinsa/shinsa-import";

// 介護請求タブと同じグリッド列定義の流儀 (格子テーブル)
// 対象 / 提供年月 / 保険者番号 / 被保険者番号 / 利用者名 / 要介護度 / 単位数 / 保険請求額 / 利用者負担 / 状態
const GRID_COLS =
  "grid grid-cols-[32px_64px_88px_104px_1fr_72px_80px_96px_96px_72px]";

// kaigo_billing_status の 1 行 (当月フラグ確認用)
interface BillingStatusRow {
  client_id: string;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)
interface DisplayRow {
  key: string;
  row: UserSeikyuRow;
  origMonthKey: string; // 'YYYY-MM'
  isReSeikyu: boolean;
  reasons: ReSeikyuReasons | null; // 月遅れ/返戻/過誤
}

// テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 判定
const isTableMissingError = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

// Shift_JIS の Blob を作る (仕様: 伝送ファイルの文字コードはシフト JIS)
function sjisBlob(content: string): Blob {
  const sjis = Encoding.convert(Encoding.stringToCode(content), {
    to: "SJIS",
    from: "UNICODE",
  });
  return new Blob([new Uint8Array(sjis)], { type: "text/csv" });
}

export function KokuhoSeikyuContent() {
  const {
    year, month, onMonthChange, filteredRows, filteredSougouRows, kanaMatches, loading, error,
    officeNumber, unitPrice, officeId, tenantId, appliedFormulaCodes,
  } = useSeikyuContext();
  const { businessType } = useBusinessType();
  const billingStatusTable = businessType === "訪問入浴" ? "bath_billing_status" : "kaigo_billing_status";
  const supabase = useMemo(() => createClient(), []);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [reRows, setReRows] = useState<ReSeikyuRow[]>([]);
  const [reSougouRows, setReSougouRows] = useState<ReSeikyuSougouRow[]>([]);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // ── kaigo_billing_status (当月) — 月遅れ/返戻/過誤の除外判定用 (事業所単位) ──
  const loadStatus = useCallback(async () => {
    if (!officeId) {
      setStatusByClient(new Map());
      return;
    }
    const { data, error: e } = await supabase
      .from(billingStatusTable)
      .select("client_id, tsukiokure, henrei, kago")
      .eq("office_id", officeId)
      .eq("target_month", monthKey);
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("請求状態の取得に失敗: " + e.message);
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(((data ?? []) as BillingStatusRow[]).map((r) => [r.client_id, r])),
    );
  }, [supabase, monthKey, officeId, billingStatusTable]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadStatus();
  }, [loadStatus]);

  // ── 再請求行 (過去月の月遅れ/返戻・未国保対象) を元提供月で再集計して合流 ──
  const loadReRows = useCallback(async () => {
    if (!officeId || !tenantId) {
      setReRows([]);
      setReSougouRows([]);
      return;
    }
    try {
      const result = await loadReSeikyuRows(supabase, {
        officeId,
        tenantId,
        unitPrice,
        appliedFormulaCodes,
        currentMonthKey: monthKey,
      });
      setReRows(result.rows);
      // 総合事業ストリームの再請求行 (71R1 で元提供月ファイルとして出力)
      setReSougouRows(result.sougouRows);
      // 再集計 warnings は介護請求タブで表示する (ここでは伝送時の build warnings に集約)
    } catch (e) {
      toast.error(
        "再請求分の集計に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
      setReRows([]);
      setReSougouRows([]);
    }
  }, [supabase, officeId, tenantId, unitPrice, appliedFormulaCodes, monthKey]);

  useEffect(() => {
    if (loading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadReRows();
  }, [loading, loadReRows]);

  // ── 表示行: 再請求 (過去分) を上、当月分 (月遅れ/返戻フラグ行は除外) を下 ──
  // rowKey は保険者変更 (転居) の分割行 (Phase 2) を区別するため segmentIndex 付き
  const displayRows = useMemo<DisplayRow[]>(() => {
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}:${r.segmentIndex ?? 0}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
    }));
    const cur: DisplayRow[] = filteredRows
      .filter((r) => {
        const st = statusByClient.get(r.user_id);
        // 月遅れ/返戻/過誤フラグの当月行は今回の伝送から除外 (過誤=取下げ済。後月に再請求)
        return !(st?.tsukiokure || st?.henrei || st?.kago);
      })
      .map((r) => ({
        key: `cur:${r.user_id}:${r.segmentIndex ?? 0}`,
        row: r,
        origMonthKey: monthKey,
        isReSeikyu: false,
        reasons: null,
      }));
    return [...re, ...cur];
  }, [filteredRows, reRows, kanaMatches, statusByClient, monthKey]);

  const excludedCount =
    filteredRows.length - displayRows.filter((d) => !d.isReSeikyu).length;

  // ── 総合事業 (71R1) の当月分/再請求分 — 介護給付 (7131) と同じ除外・合流ルール ──
  // 当月分のうち 月遅れ/返戻/過誤 フラグの利用者は伝送から除外し (後月に再請求)、
  // 過去月の再請求行 (reSougouRows) は元提供月ごとの別ファイルとして出力する。
  // ※ 一覧テーブルには総合事業行は載せない (従来どおり出力ボタンのみ)
  const sougouCurrentRows = useMemo(
    () =>
      filteredSougouRows.filter((r) => {
        const st = statusByClient.get(r.user_id);
        return !(st?.tsukiokure || st?.henrei || st?.kago);
      }),
    [filteredSougouRows, statusByClient],
  );
  const sougouExcludedCount = filteredSougouRows.length - sougouCurrentRows.length;
  const reSougouMatched = useMemo(
    () => reSougouRows.filter(kanaMatches),
    [reSougouRows, kanaMatches],
  );
  const sougouTargetCount = sougouCurrentRows.length + reSougouMatched.length;

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === displayRows.length
        ? new Set()
        : new Set(displayRows.map((d) => d.key)),
    );

  const targets = useMemo(
    () =>
      checked.size > 0
        ? displayRows.filter((d) => checked.has(d.key))
        : displayRows,
    [displayRows, checked],
  );

  const totalUnits = targets.reduce((s, d) => s + d.row.totalUnits, 0);
  const totalInsurance = targets.reduce((s, d) => s + d.row.insuranceAmount, 0);
  const totalKohi = targets.reduce((s, d) => s + (d.row.kohiAmount ?? 0), 0);
  const totalUser = targets.reduce((s, d) => s + d.row.userAmount, 0);
  const totalSelfPay = targets.reduce((s, d) => s + d.row.selfPayAmount, 0);

  // 国保連伝送ファイル (正式インタフェース仕様: 7111 + 7131 / Shift_JIS)。
  // 提供月ごとに 1 ファイル。再請求分は元提供月のファイルとして出力する。
  const exportDensou = async () => {
    if (targets.length === 0) return;

    // 提供月ごとにグループ化 (再請求 = 元提供月 / 当月 = 選択月)
    const byMonth = new Map<string, DisplayRow[]>();
    for (const d of targets) {
      if (!byMonth.has(d.origMonthKey)) byMonth.set(d.origMonthKey, []);
      byMonth.get(d.origMonthKey)!.push(d);
    }

    const files: { content: string; fileName: string; label: string; count: number }[] = [];
    const warnings: string[] = [];

    for (const [mKey, group] of [...byMonth.entries()].sort()) {
      const [oy, om] = mKey.split("-").map((n) => Number(n));
      if (!oy || !om) continue;
      // 再請求行は ym (元提供月) を保持 (build.ts DensouRow.ym)。当月行は opts の年月
      const rows: DensouRow[] = group.map((d) => d.row as DensouRow);
      const result = buildKokuhoDensou(rows, {
        officeNumber: officeNumber ?? "",
        year: oy,
        month: om,
        unitPrice,
        // 処理対象年月 (審査月) は提供月ではなく「今回の提出バッチの請求月の翌月」。
        // 月遅れ再請求ファイルも同じ審査月になる (build.ts 参照)
        seikyuYear: year,
        seikyuMonth: month,
      });
      warnings.push(...result.warnings.map((w) => `[R${oy - 2018}/${om}] ${w}`));
      files.push({
        content: result.content,
        fileName: result.fileName,
        label: `R${oy - 2018}/${om} 提供分`,
        count: result.dataRecordCount,
      });
    }

    if (warnings.length > 0) {
      const list = warnings.slice(0, 12).join("\n・");
      const ok = window.confirm(
        `以下の項目が不足しています (伝送ソフトの取込チェックでエラーになる可能性があります):\n\n・${list}${warnings.length > 12 ? `\n…他 ${warnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
      );
      if (!ok) return;
    }

    const saved = await saveFilesToFolder(
      files.map((f) => ({ blob: sjisBlob(f.content), fileName: f.fileName })),
      "kokuho-densou",
    );
    if (!saved) return; // フォルダ選択をキャンセル
    toast.success(
      `伝送ファイル ${files.length} 本を保存しました: ` +
        files.map((f) => `${f.fileName} (${f.label} ${f.count} 件)`).join(" / "),
    );
  };

  // ── 総合事業 伝送ファイル (明細書 71R1/様式第二の三 + 請求書 7113 / Shift_JIS) ──
  //    介護給付 (7131) とは別様式なので独立の出力ボタン。
  //    介護給付と同じく、当月分の 月遅れ/返戻/過誤 フラグ行は除外し、過去月の再請求行は
  //    元提供月ごとの別ファイル (SG{元提供YYYYMM}.CSV) として出力する (2026-07-14)。
  const exportSougouDensou = async () => {
    if (sougouTargetCount === 0) return;

    // 提供月ごとにグループ化 (再請求 = 元提供月 / 当月 = 選択月)。exportDensou と同構造
    const byMonth = new Map<string, SougouDensouRow[]>();
    for (const r of reSougouMatched) {
      if (!byMonth.has(r.__origMonthKey)) byMonth.set(r.__origMonthKey, []);
      byMonth.get(r.__origMonthKey)!.push(r); // ReSeikyuSougouRow は ym (元提供年月) 持ち
    }
    if (sougouCurrentRows.length > 0) {
      if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
      byMonth.get(monthKey)!.push(...(sougouCurrentRows as SougouDensouRow[]));
    }

    const files: { content: string; fileName: string; label: string; count: number }[] = [];
    const warnings: string[] = [];
    for (const [mKey, group] of [...byMonth.entries()].sort()) {
      const [oy, om] = mKey.split("-").map((n) => Number(n));
      if (!oy || !om) continue;
      const result = buildSougouDensou(group, {
        officeNumber: officeNumber ?? "",
        year: oy,
        month: om,
        unitPrice,
        // 処理対象年月 (審査月) は「今回の提出バッチの請求月の翌月」(exportDensou と同じ)
        seikyuYear: year,
        seikyuMonth: month,
      });
      warnings.push(...result.warnings.map((w) => `[R${oy - 2018}/${om}] ${w}`));
      files.push({
        content: result.content,
        fileName: result.fileName,
        label: `R${oy - 2018}/${om} 提供分`,
        count: result.dataRecordCount,
      });
    }

    if (warnings.length > 0) {
      const list = warnings.slice(0, 12).join("\n・");
      const ok = window.confirm(
        `総合事業の伝送で以下の項目が不足しています (取込チェックでエラーになる可能性があります):\n\n・${list}${warnings.length > 12 ? `\n…他 ${warnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
      );
      if (!ok) return;
    }
    const saved = await saveFilesToFolder(
      files.map((f) => ({ blob: sjisBlob(f.content), fileName: f.fileName })),
      "kokuho-densou",
    );
    if (!saved) return;
    toast.success(
      `総合事業 伝送ファイル ${files.length} 本を保存しました: ` +
        files.map((f) => `${f.fileName} (${f.label} ${f.count} レコード)`).join(" / "),
    );
  };

  // 確認用 CSV (Excel で内容確認する用の明細一覧。伝送形式ではない)
  // 再請求行は元提供月を提供年月として出す。公費請求額・超過自費の列を含む
  const exportCsv = async () => {
    const ym = `${year}${String(month).padStart(2, "0")}`;
    const header = [
      "提供年月",
      "保険者番号",
      "被保険者番号",
      "利用者名",
      "要介護度",
      "サービス内容",
      "サービス単位数",
      "回数",
      "小計単位数",
      "合計単位数",
      "保険請求額",
      "公費請求額",
      "利用者負担額",
      "超過自費",
      "状態",
    ];
    const lines: string[] = [header.join(",")];
    for (const d of targets) {
      const r = d.row;
      const rowYm = d.origMonthKey.replace("-", "");
      const baseState = d.isReSeikyu
        ? `${
            [
              d.reasons?.henrei && "返戻",
              d.reasons?.kago && "過誤",
              d.reasons?.tsukiokure && "月遅れ",
            ]
              .filter(Boolean)
              .join("/") || "月遅れ"
          }(再請求)`
        : "当月";
      // 保険者変更 (転居) の分割行は状態に分割番号を付記 (Phase 2)
      const state =
        (r.segmentCount ?? 1) > 1
          ? `${baseState}(分割${(r.segmentIndex ?? 0) + 1}/${r.segmentCount})`
          : baseState;
      const tail = [
        r.totalUnits,
        r.insuranceAmount,
        r.kohiAmount ?? 0,
        r.userAmount, // 法定負担のみ (費用 = 保険 + 公費 + 負担)
        r.selfPayAmount, // 限度額超過の全額自費 (保険請求外)
        state,
      ];
      for (const dl of r.details) {
        lines.push(
          [
            rowYm,
            r.insurer_number ?? "",
            r.insured_number ?? "",
            `"${r.user_name}"`,
            r.care_level ?? "",
            `"${dl.service_type}"`,
            dl.unit_per,
            dl.count,
            dl.units,
            ...tail,
          ].join(","),
        );
      }
      if (r.addonUnits > 0) {
        lines.push(
          [
            rowYm,
            r.insurer_number ?? "",
            r.insured_number ?? "",
            `"${r.user_name}"`,
            r.care_level ?? "",
            `"${r.addonLabel ?? "処遇改善加算"}"`,
            "",
            1,
            r.addonUnits,
            ...tail,
          ].join(","),
        );
      }
    }
    // Excel 互換のため BOM 付き UTF-8
    const blob = new Blob(["﻿" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    await saveBlobToFile(blob, `kokuho_seikyu_${ym}.csv`, "kokuho-csv");
  };

  const allChecked =
    checked.size === displayRows.length && displayRows.length > 0;

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── 左: かな行フィルター ── */}
      <SeikyuKanaSidebar />

      {/* ── 中央: ツールバー + テーブル + フッタ ── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* ツールバー (伝送ファイル / 確認用CSV — order-app の CSV 出力ボタン風) */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <SeikyuMonthNav />
          <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">国保請求分</span>
          <span className="text-xs text-gray-500">{displayRows.length} 件</span>
          <div className="ml-auto flex items-center gap-2">
            {/* 審査結果取込 (返戻/支払決定/増減表)。訪問入浴は bath_billing_status のため対象外 */}
            {billingStatusTable === "kaigo_billing_status" && (
              <ShinsaKekkaImport
                officeId={officeId}
                tenantId={tenantId}
                officeNumber={officeNumber}
                onNavigateMonth={onMonthChange}
                onApplied={() => {
                  loadStatus();
                  loadReRows();
                }}
              />
            )}
            <button
              type="button"
              onClick={exportCsv}
              disabled={displayRows.length === 0}
              title="Excel で内容確認する用の明細 CSV (伝送形式ではない)"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download size={13} />確認用CSV
            </button>
            <button
              type="button"
              onClick={exportDensou}
              disabled={displayRows.length === 0}
              title="国保中央会 伝送通信ソフト取込用の正式形式 (Shift_JIS) で出力。再請求分は元提供月ごとに別ファイル"
              className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Send size={13} />伝送ファイル ({targets.length}件)
            </button>
            {sougouTargetCount > 0 && (
              <button
                type="button"
                onClick={exportSougouDensou}
                title="総合事業 (介護予防・日常生活支援総合事業) の伝送ファイル (明細書 71R1/様式第二の三 + 請求書 7113 / Shift_JIS)。介護給付とは別様式。再請求分は元提供月ごとに別ファイル"
                className="border border-emerald-600 rounded bg-emerald-600 px-3 py-1 text-white font-semibold hover:bg-emerald-700 flex items-center gap-1.5"
              >
                <Send size={13} />総合事業 (71R1) ({sougouTargetCount}件)
              </button>
            )}
          </div>
        </div>

        {/* 除外・再請求の案内 */}
        {!loading && (excludedCount > 0 || reRows.length > 0 || sougouExcludedCount > 0 || reSougouMatched.length > 0) && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              {excludedCount > 0 && (
                <>当月分のうち月遅れ・返戻・過誤フラグの {excludedCount} 件は伝送対象から除外しています (後月に再請求)。</>
              )}
              {reRows.length > 0 && (
                <>
                  過去月の再請求 {reRows.length} 件を合流しています (元提供月のファイルとして出力)。
                  {reRows.some((r) => r.__reasons.kago) && (
                    <>
                      {" "}
                      過誤分は取下げ後の再請求です — 通常過誤は保険者の過誤決定 (支払控除)
                      を確認してから伝送してください (同月過誤は申立と同月に伝送)。
                    </>
                  )}
                </>
              )}
              {sougouExcludedCount > 0 && (
                <>
                  {" "}
                  総合事業の当月分のうち月遅れ・返戻・過誤フラグの {sougouExcludedCount} 件は「総合事業 (71R1)」の伝送対象から除外しています。
                </>
              )}
              {reSougouMatched.length > 0 && (
                <>
                  {" "}
                  総合事業の過去月再請求 {reSougouMatched.length} 件は「総合事業 (71R1)」ボタンから元提供月のファイルとして出力します (一覧テーブルには表示されません)。
                </>
              )}
            </span>
          </div>
        )}

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={22} className="animate-spin text-indigo-400" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {/* ヘッダー行 */}
              <div className={`${GRID_COLS} border-b border-gray-300 bg-gray-100 text-xs font-semibold text-gray-600 sticky top-0 z-10`}>
                <div className="px-1 py-2 flex items-center justify-center">
                  <button
                    onClick={toggleAll}
                    title="全選択"
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                      allChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                    }`}
                  >
                    {allChecked && (
                      <span className="text-white text-[8px] font-bold leading-none">✓</span>
                    )}
                  </button>
                </div>
                <div className="px-2 py-2 border-l border-gray-200">提供年月</div>
                <div className="px-2 py-2 border-l border-gray-200">保険者番号</div>
                <div className="px-2 py-2 border-l border-gray-200">被保険者番号</div>
                <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
                <div className="px-2 py-2 border-l border-gray-200">要介護度</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">単位数</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">保険請求額</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">利用者負担</div>
                <div className="px-2 py-2 border-l border-gray-200 text-center">状態</div>
              </div>

              {displayRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">
                  対象月の実績 (完了) がありません
                </p>
              ) : displayRows.map((d, idx) => {
                const r = d.row;
                const isChecked = checked.has(d.key);
                const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
                return (
                  <div
                    key={d.key}
                    onClick={() => toggle(d.key)}
                    className={`${GRID_COLS} border-b border-gray-100 text-xs cursor-pointer transition-colors ${
                      isChecked
                        ? "bg-indigo-50"
                        : idx % 2 === 0
                        ? "bg-white hover:bg-gray-50"
                        : "bg-gray-50/50 hover:bg-gray-100"
                    }`}
                  >
                    <div className="px-1 py-2 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggle(d.key)}
                        className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                          isChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                        }`}
                      >
                        {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                      </button>
                    </div>
                    <div className={`px-2 py-2 border-l border-gray-100 text-gray-500 ${d.isReSeikyu ? "bg-yellow-100" : ""}`}>
                      R{oy - 2018}/{om}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                      {r.insurer_number ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                      {r.insured_number ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-medium text-gray-800 truncate">
                      {r.user_name}
                      {(r.segmentCount ?? 1) > 1 && (
                        <span
                          title={`保険者変更 (転居) によりレセプトを分割しています。この行は ${r.periodFrom ?? "?"}〜${r.periodTo ?? "?"} (保険者 ${r.insurer_number ?? "?"}) の明細書です`}
                          className="ml-1 rounded bg-purple-100 px-1 py-0.5 text-[10px] font-bold text-purple-700 whitespace-nowrap"
                        >
                          分割{(r.segmentIndex ?? 0) + 1}/{r.segmentCount}
                        </span>
                      )}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-gray-700">
                      {r.care_level ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono text-gray-700">
                      {r.totalUnits.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono font-semibold text-indigo-700">
                      {r.insuranceAmount.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono text-gray-700">
                      {r.userAmount.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-center">
                      {d.isReSeikyu ? (
                        <span className="text-red-600">
                          {[
                            d.reasons?.henrei && "返戻",
                            d.reasons?.kago && "過誤",
                            d.reasons?.tsukiokure && "月遅",
                          ]
                            .filter(Boolean)
                            .join("/") || "月遅"}
                        </span>
                      ) : (
                        <span className="text-gray-500">当月</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── フッター合計 (介護請求タブと同じ box レイアウト) ── */}
            <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-1.5">
                <span>合計件数 <strong className="font-mono">{targets.length.toLocaleString()}</strong></span>
                <span>
                  出力対象{" "}
                  <strong className="font-mono">
                    {checked.size > 0 ? `チェック ${checked.size} 件` : "全件"}
                  </strong>
                </span>
                {reRows.length > 0 && (
                  <span className="text-amber-700">再請求 {reRows.length} 件</span>
                )}
              </div>
              <div className="border border-gray-300 rounded bg-white px-2 py-1.5 grid grid-cols-3 gap-x-4 gap-y-1">
                <span>合計単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                <span>保険請求額 <strong className="font-mono text-indigo-700">¥{totalInsurance.toLocaleString()}</strong></span>
                <span>公費請求額 <strong className="font-mono">¥{totalKohi.toLocaleString()}</strong></span>
                <span>利用者負担額 <strong className="font-mono">¥{totalUser.toLocaleString()}</strong></span>
                <span title="区分支給限度基準の超過分 (保険請求外の全額自費。利用請求で請求)">
                  超過自費 <strong className="font-mono">¥{totalSelfPay.toLocaleString()}</strong>
                </span>
              </div>
              <p className="mt-1.5 text-[10px] text-gray-400">
                ※ チェックで出力対象を絞込 (未チェック時は全件)。「伝送ファイル」は国保中央会
                伝送通信ソフト取込用の正式形式 (7111 請求書 + 7131 様式第二 / Shift_JIS)。
                再請求分は元提供月ごとに別ファイルで出力します (処理対象年月 = 今回請求月の翌月 = 審査月)。
                初回は伝送ソフトの取込チェックで内容を確認してください。「確認用CSV」は Excel 閲覧用。
                明細書・請求書の発行は「介護請求」画面で行います。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
