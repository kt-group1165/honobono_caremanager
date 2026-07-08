"use client";

/**
 * 介護請求 — 利用者ごとの月次請求管理 (見た目: ほのぼの NEXT の実画面に準拠)
 *
 * 左: あかさたな索引 / 中央: ツールバー + 高密度グリッドテーブル + 合計フッタ /
 * 右: 明細情報ペイン (行クリックで表示)。
 *
 * 機能 (従来どおり):
 *   - 行チェック + 状態表示 (未発行 / 発行済 / 国保対象)
 *   - 月遅 / 返戻 / 過誤 フラグ (kaigo_billing_status に upsert)
 *   - 明細書 (様式第二) / 請求書 (様式第一 総括) / 国保対象 / 確認用CSV
 *
 * ※ Phase 2: 月遅れ/返戻の再請求。過去月の月遅れ/返戻 (未・国保対象) を
 *    元提供月で再集計し、当月一覧にバッジ付きで合流。明細書・伝送・国保対象化は
 *    各自の元提供月で反映する。
 *
 * ※ 実績単位の加算: 明細ペインは表示専用 (編集はサービス提供表 (実績) 画面へ移設)。
 *    初回加算は過去 2 ヶ月に completed 実績が無い利用者に「候補」バッジを出す
 *    (自動付与はしない。付与もサービス提供表側で行う)。
 *
 * ※ 区分支給限度基準の超過自費: 超過がある行に赤バッジ、明細ペインに内訳。
 *    超過分は保険請求から除外され selfPayAmount (全額自費) として利用請求へ
 *    (利用者負担額 userAmount は法定負担のみ) — aggregate.ts 参照。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  AlertCircle,
  FileText,
  Printer,
  Landmark,
  Download,
  ExternalLink,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "../_shared/seikyu-context";
import { MeisaiPrintSheet } from "../../billing/forms/_meisai";
import { SeikyuForm } from "../../billing/forms/_seikyu";
import {
  loadReSeikyuRows,
  type ReSeikyuRow,
} from "@/lib/visit-seikyu/re-seikyu";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

// ほのぼの実画面の列順:
// 対象 / 申請中 / 状態 / 提供月 / 請求月 / サービス事業所 / 被保険者番号 / 利用者名 / 月遅 / 返戻 / 過誤
const GRID_COLS =
  "grid grid-cols-[26px_44px_60px_54px_54px_minmax(110px,0.9fr)_84px_minmax(140px,1.1fr)_44px_44px_44px]";

// 和暦月表示 「R 8/ 5」 (ほのぼの流。1 桁は空白 pad、font-mono 前提)
const reiwaMonth = (y: number, m: number) =>
  `R${String(y - 2018).padStart(2, " ")}/${String(m).padStart(2, " ")}`;

// kaigo_billing_status の 1 行 (利用者 × 月)
interface BillingStatusRow {
  client_id: string;
  issued_at: string | null;
  kokuho_target: boolean;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
  notes: string | null;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)
interface DisplayRow {
  /** 一意キー (利用者 × 提供月)。当月="cur:<id>" / 再請求="re:<id>:<origMonthKey>" */
  key: string;
  row: UserSeikyuRow;
  /** この行の提供月 (YYYY-MM)。当月行は当月、再請求行は元提供月 */
  origMonthKey: string;
  /** 月遅れ/返戻の再請求行か */
  isReSeikyu: boolean;
  /** 再請求理由 (月遅れ/返戻)。当月通常行は null */
  reasons: { tsukiokure: boolean; henrei: boolean } | null;
}

// kaigo_visit_month_addons の 1 行 (利用者 × 月 × 事業所 の実績単位加算フラグ)
interface MonthAddonRow {
  client_id: string;
  shokai: boolean;
  seikatsu_kino: string; // 'なし' | 'Ⅰ' | 'Ⅱ'
  kinkyu_count: number;
}

// テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 判定
const isTableMissingError = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

export function KaigoSeikyuContent() {
  const {
    year, month, filteredRows, filteredSougouRows, kanaMatches, recordCount, loading, error, warnings,
    officeName, officeNumber, officeAddress, officePhone, officePostal,
    officeId, tenantId, unitPrice, appliedFormulaCodes,
  } = useSeikyuContext();
  const { currentOffice } = useBusinessType();
  const supabase = useMemo(() => createClient(), []);

  // 選択・チェックは (利用者 × 提供月) 単位。月遅れ/返戻で同一利用者が
  // 当月行 + 過去月行で二重に並ぶため、user_id 単体ではなく複合キーで持つ。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [printMode, setPrintMode] = useState<"meisai" | "seikyu" | null>(null);
  // 行内「明細書」ボタン用: 印刷対象を明示指定するとき (null = targetDisplayRows)
  const [meisaiPrintRows, setMeisaiPrintRows] = useState<DisplayRow[] | null>(null);
  // 月遅れ/返戻の再請求行 (過去月を元提供月で再集計したもの)
  const [reRows, setReRows] = useState<ReSeikyuRow[]>([]);
  // 再請求の再集計時 warnings (認定フォールバック・入院重なり等)
  const [reWarnings, setReWarnings] = useState<string[]>([]);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // ── 表示用の統合行 (当月通常行 + 再請求行)。カナ索引で共通絞込 ──
  // rowKey: 当月行は "cur:<user_id>" / 再請求行は "re:<user_id>:<origMonthKey>"
  const displayRows = useMemo<DisplayRow[]>(() => {
    const cur: DisplayRow[] = filteredRows.map((r) => ({
      key: `cur:${r.user_id}`,
      row: r,
      origMonthKey: monthKey,
      isReSeikyu: false,
      reasons: null,
    }));
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
    }));
    // 再請求 (過去分) を上、当月を下に並べる
    return [...re, ...cur];
  }, [filteredRows, reRows, kanaMatches, monthKey]);

  const selectedDisplay = displayRows.find((d) => d.key === selectedKey) ?? null;
  const selected = selectedDisplay?.row ?? null;
  // 月次加算の編集は当月の通常行のみ (再請求行は元提供月のデータなので編集不可)
  const selectedCurUserId =
    selectedDisplay && !selectedDisplay.isReSeikyu ? selectedDisplay.row.user_id : null;

  // 合計は当月の通常行のみ (再請求分は元提供月の別集計なので当月合計には含めない)
  const totalUnits = filteredRows.reduce((s, r) => s + r.totalUnits, 0);
  const kokuhoRows = filteredRows.filter(
    (r) => statusByClient.get(r.user_id)?.kokuho_target,
  );
  const kokuhoCount = kokuhoRows.length;
  const kokuhoUnits = kokuhoRows.reduce((s, r) => s + r.totalUnits, 0);

  // ── 月遅れ/返戻の再請求行を読み込む ──
  const loadReRows = useCallback(async () => {
    if (!officeId || !tenantId) {
      setReRows([]);
      setReWarnings([]);
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
      setReWarnings(result.warnings);
    } catch (e) {
      toast.error(
        "再請求分の集計に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
      setReRows([]);
      setReWarnings([]);
    }
  }, [supabase, officeId, tenantId, unitPrice, appliedFormulaCodes, monthKey]);

  useEffect(() => {
    if (loading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadReRows();
  }, [loading, loadReRows]);

  // ── kaigo_billing_status を (office_id, target_month) で読み、client_id で突合 ──
  const loadStatus = useCallback(async () => {
    if (!officeId) {
      setStatusByClient(new Map());
      return;
    }
    const { data, error: e } = await supabase
      .from("kaigo_billing_status")
      .select("client_id, issued_at, kokuho_target, tsukiokure, henrei, kago, notes")
      .eq("office_id", officeId)
      .eq("target_month", monthKey);
    if (e) {
      // table 未作成 (migration 未適用) 時は状態なしとして続行
      if (!isTableMissingError(e.code)) toast.error("請求状態の取得に失敗: " + e.message);
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(((data ?? []) as BillingStatusRow[]).map((r) => [r.client_id, r])),
    );
  }, [supabase, monthKey, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadStatus();
  }, [loadStatus]);

  // ── 実績単位の月次加算 (kaigo_visit_month_addons: 初回 / 緊急時 / 生活機能向上連携) ──
  //    この画面は表示専用 (編集はサービス提供表 (実績) 画面へ移設)
  const [addonByClient, setAddonByClient] = useState<Map<string, MonthAddonRow>>(new Map());
  const [addonTableMissing, setAddonTableMissing] = useState(false);

  const loadAddons = useCallback(async () => {
    if (!officeId) {
      setAddonByClient(new Map());
      return;
    }
    const { data, error: e } = await supabase
      .from("kaigo_visit_month_addons")
      .select("client_id, shokai, seikatsu_kino, kinkyu_count")
      .eq("office_id", officeId)
      .eq("target_month", monthKey);
    if (e) {
      // テーブル未作成 (SQL 未適用) は amber バナー案内、それ以外は toast
      if (isTableMissingError(e.code)) {
        setAddonTableMissing(true);
      } else {
        toast.error("月次加算の取得に失敗: " + e.message);
      }
      setAddonByClient(new Map());
      return;
    }
    setAddonTableMissing(false);
    setAddonByClient(
      new Map(((data ?? []) as MonthAddonRow[]).map((r) => [r.client_id, r])),
    );
  }, [supabase, officeId, monthKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadAddons();
  }, [loadAddons]);

  // ── 初回加算の自動サジェスト: 過去 2 ヶ月に completed 実績が無ければ「候補」──
  //    (表示のみ。付与はサービス提供表 (実績) 画面で行う)
  const [shokaiCandidate, setShokaiCandidate] = useState(false);
  useEffect(() => {
    if (!selectedCurUserId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 選択解除時のリセット
      setShokaiCandidate(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // 過去 2 ヶ月 = (month-2) 月初 〜 前月末
      const fromD = new Date(year, month - 3, 1);
      const toD = new Date(year, month - 1, 0);
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const { count, error: e } = await supabase
        .from("kaigo_visit_schedule")
        .select("id", { count: "exact", head: true })
        .eq("user_id", selectedCurUserId)
        .eq("status", "completed")
        .gte("visit_date", fmt(fromD))
        .lte("visit_date", fmt(toD));
      if (cancelled) return;
      if (e) {
        // 候補判定の失敗は請求業務を止めない (console のみ)
        console.error("初回加算候補の判定に失敗:", e.message);
        setShokaiCandidate(false);
        return;
      }
      setShokaiCandidate((count ?? 0) === 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, selectedCurUserId, year, month]);

  // ── フラグ (月遅れ/返戻/過誤) の upsert ──
  const setFlag = async (
    clientId: string,
    field: "tsukiokure" | "henrei" | "kago",
    value: boolean,
  ) => {
    if (!officeId) {
      toast.error("事業所が未選択のためフラグを保存できません");
      return;
    }
    const cur = statusByClient.get(clientId);
    const payload: Record<string, unknown> = {
      client_id: clientId,
      target_month: monthKey,
      tenant_id: currentOffice?.tenant_id ?? "kt-group",
      office_id: officeId,
      // 既存値を保持しつつ対象フラグだけ更新
      tsukiokure: cur?.tsukiokure ?? false,
      henrei: cur?.henrei ?? false,
      kago: cur?.kago ?? false,
      [field]: value,
    };
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      toast.error("フラグの保存に失敗: " + e.message);
      return;
    }
    loadStatus();
  };

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
  const selectUnissued = () =>
    setChecked(
      new Set(
        displayRows
          .filter(
            (d) =>
              // 再請求行は常に未発行扱い / 当月行は issued_at 無しのみ
              d.isReSeikyu || !statusByClient.get(d.row.user_id)?.issued_at,
          )
          .map((d) => d.key),
      ),
    );

  // 対象: チェックあり → その行 / チェックなし → 全件 (当月 + 再請求)
  const targetDisplayRows = useMemo(
    () =>
      checked.size > 0
        ? displayRows.filter((d) => checked.has(d.key))
        : displayRows,
    [displayRows, checked],
  );
  const targets = useMemo(
    () => targetDisplayRows.map((d) => d.row),
    [targetDisplayRows],
  );

  // 集計 (請求書用) — 様式第一 総括は当月の通常行のみを対象とする
  // (再請求分は元提供月の別請求書になるため、当月総括には含めない)
  const seikyuTargets = useMemo(
    () => targetDisplayRows.filter((d) => !d.isReSeikyu).map((d) => d.row),
    [targetDisplayRows],
  );
  // 公費単独 (被保険者番号 H = 生保 10割公費) は保険請求欄に記載しない。
  // 公費請求欄の生保行に合算する (様式第一の公式記載例準拠)。
  const hokenTargets = seikyuTargets.filter((r) => !r.kohiTandoku);
  const tandokuTargets = seikyuTargets.filter((r) => r.kohiTandoku);
  const targetUnits = hokenTargets.reduce((s, r) => s + r.totalUnits, 0);
  const targetCost = hokenTargets.reduce((s, r) => s + r.totalAmount, 0);
  const targetInsurance = hokenTargets.reduce((s, r) => s + r.insuranceAmount, 0);
  const targetUser = hokenTargets.reduce((s, r) => s + r.userAmount, 0);
  // 保険請求分の公費 (生保等の本人負担振替分) — 公費請求欄の再掲元
  const hokenKohiRows = hokenTargets.filter((r) => (r.kohiAmount ?? 0) > 0);
  const targetKohi = hokenKohiRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);
  const seikyuKohiRows =
    hokenKohiRows.length > 0
      ? [
          {
            code: "12",
            count: hokenKohiRows.length,
            units: hokenKohiRows.reduce((s, r) => s + (r.kohiUnits ?? 0), 0),
            cost: hokenKohiRows.reduce((s, r) => s + r.totalAmount, 0),
            kohi: targetKohi,
          },
        ]
      : [];
  // 公費単独分の集計 (10割公費: 費用合計 = 公費請求額)
  const seikyuKohiTandoku =
    tandokuTargets.length > 0
      ? {
          count: tandokuTargets.length,
          units: tandokuTargets.reduce((s, r) => s + r.totalUnits, 0),
          cost: tandokuTargets.reduce((s, r) => s + r.totalAmount, 0),
          kohi: tandokuTargets.reduce((s, r) => s + (r.kohiAmount ?? 0), 0),
        }
      : undefined;

  // ── 再請求行 (元提供月) の既存 kaigo_billing_status を取得 ──
  //    upsert で既存の kago / notes 等を上書き消去しないための事前読取。
  //    key = `${client_id}:${target_month}`
  const fetchOrigStatus = useCallback(
    async (rows: DisplayRow[]): Promise<Map<string, BillingStatusRow>> => {
      const map = new Map<string, BillingStatusRow>();
      const reOnly = rows.filter((d) => d.isReSeikyu);
      if (!officeId || reOnly.length === 0) return map;
      const months = [...new Set(reOnly.map((d) => d.origMonthKey))];
      const ids = [...new Set(reOnly.map((d) => d.row.user_id))];
      const { data, error: e } = await supabase
        .from("kaigo_billing_status")
        .select("client_id, target_month, issued_at, kokuho_target, tsukiokure, henrei, kago, notes")
        .eq("office_id", officeId)
        .in("target_month", months)
        .in("client_id", ids);
      if (e) {
        if (!isTableMissingError(e.code)) {
          toast.error("既存の請求状態の取得に失敗: " + e.message);
        }
        return map;
      }
      for (const r of (data ?? []) as (BillingStatusRow & { target_month: string })[]) {
        map.set(`${r.client_id}:${r.target_month}`, r);
      }
      return map;
    },
    [supabase, officeId],
  );

  // ── 明細書: 対象者の様式第二を印刷 → 印刷実行時に issued_at を now() で upsert (発行済化) ──
  //    再請求行は元提供月 (origMonthKey) に対して upsert する (既存 kago/notes は保持)。
  //    rowsToPrint 指定時 (行内ボタン) はその行のみ対象。
  const printMeisaiFor = async (rowsToPrint: DisplayRow[]) => {
    if (rowsToPrint.length === 0) return;
    if (!officeId) {
      toast.error("事業所が未選択のため発行できません");
      return;
    }
    const now = new Date().toISOString();
    const origStatus = await fetchOrigStatus(rowsToPrint);
    // 全行で同一のキー集合にする (upsert の PGRST102「All object keys must match」予防)
    const payload = rowsToPrint.map((d) => {
      // 当月行は当月 status、再請求行は元提供月の既存レコードを引き継ぐ
      const cur = d.isReSeikyu
        ? origStatus.get(`${d.row.user_id}:${d.origMonthKey}`)
        : statusByClient.get(d.row.user_id);
      return {
        client_id: d.row.user_id,
        target_month: d.origMonthKey,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: officeId,
        issued_at: now,
        // 既存フラグを保持 (再請求行は理由フラグを保持)
        kokuho_target: cur?.kokuho_target ?? false,
        tsukiokure: d.reasons?.tsukiokure ?? cur?.tsukiokure ?? false,
        henrei: d.reasons?.henrei ?? cur?.henrei ?? false,
        kago: cur?.kago ?? false,
        notes: cur?.notes ?? null,
      };
    });
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      toast.error("発行状態の保存に失敗: " + e.message);
    } else {
      loadStatus();
    }
    // 保存の成否に関わらず印刷は実行 (状態が保存できなくても紙は出せるように)
    setMeisaiPrintRows(rowsToPrint);
    setPrintMode("meisai");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
      setMeisaiPrintRows(null);
    }, 100);
  };

  const printMeisai = () => printMeisaiFor(targetDisplayRows);

  // ── 請求書: 事業所単位の総括 (様式第一) を印刷 ──
  const printSeikyu = () => {
    if (targets.length === 0) return;
    setPrintMode("seikyu");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 国保対象: 選択行を kokuho_target=true に upsert ──
  //    当月行は「発行済」のみ (未発行はスキップ)。
  //    再請求行 (月遅れ/返戻) は元提供月に対し kokuho_target=true で立てる
  //    (未発行なら発行済化も同時に行う)。既存行の kago / notes は読み取って保持し、
  //    notes は既存があれば「既存 / 再請求」と追記する (固定値での上書き消去をしない)。
  //    payload は全行同一のキー集合 (PGRST102 予防)。
  const markKokuhoTarget = async () => {
    if (!officeId) {
      toast.error("事業所が未選択のため国保対象化できません");
      return;
    }
    const now = new Date().toISOString();
    const origStatus = await fetchOrigStatus(targetDisplayRows);
    const payload: Record<string, unknown>[] = [];
    let skipped = 0;

    for (const d of targetDisplayRows) {
      if (d.isReSeikyu) {
        // 再請求分: 元提供月に kokuho_target を立てる (発行済でなくても許可)。
        // 既存レコードの kago / notes を保持 (notes は「再請求」を追記)
        const cur = origStatus.get(`${d.row.user_id}:${d.origMonthKey}`);
        const prevNotes = cur?.notes?.trim() || null;
        const notes = prevNotes
          ? prevNotes.includes("再請求")
            ? prevNotes
            : `${prevNotes} / 再請求`
          : "再請求";
        payload.push({
          client_id: d.row.user_id,
          target_month: d.origMonthKey,
          tenant_id: currentOffice?.tenant_id ?? "kt-group",
          office_id: officeId,
          issued_at: cur?.issued_at ?? now,
          kokuho_target: true,
          tsukiokure: d.reasons?.tsukiokure ?? cur?.tsukiokure ?? false,
          henrei: d.reasons?.henrei ?? cur?.henrei ?? false,
          kago: cur?.kago ?? false,
          notes,
        });
      } else {
        const cur = statusByClient.get(d.row.user_id);
        if (!cur?.issued_at) {
          skipped++;
          continue;
        }
        payload.push({
          client_id: d.row.user_id,
          target_month: monthKey,
          tenant_id: currentOffice?.tenant_id ?? "kt-group",
          office_id: officeId,
          issued_at: cur.issued_at,
          kokuho_target: true,
          tsukiokure: cur.tsukiokure,
          henrei: cur.henrei,
          kago: cur.kago,
          notes: cur.notes ?? null,
        });
      }
    }

    if (payload.length === 0) {
      toast.warning(
        "国保対象にできる行がありません (当月分は先に明細書を発行してください)",
      );
      return;
    }
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      toast.error("国保対象の保存に失敗: " + e.message);
      return;
    }
    toast.success(
      `${payload.length} 件を国保対象にしました${skipped > 0 ? ` (未発行 ${skipped} 名はスキップ)` : ""}`,
    );
    loadStatus();
    // 再請求分は kokuho_target 化されたので一覧から外れる → 再読込
    loadReRows();
  };

  // ── 確認用 CSV (明細一覧) ──
  const exportCsv = () => {
    const ym = `${year}${String(month).padStart(2, "0")}`;
    const header = [
      "提供年月",
      "被保険者番号",
      "利用者名",
      "要介護度",
      "総単位数",
      "保険請求額",
      "利用者負担額",
      "限度額超過単位",
      "超過自費額",
      "状態",
    ];
    const lines: string[] = [header.join(",")];
    for (const d of targetDisplayRows) {
      const r = d.row;
      // 再請求行は元提供月 (YYYYMM) を提供年月として出す
      const rowYm = d.isReSeikyu ? d.origMonthKey.replace("-", "") : ym;
      const st = d.isReSeikyu ? undefined : statusByClient.get(r.user_id);
      const state = d.isReSeikyu
        ? d.reasons?.henrei
          ? "返戻(再請求)"
          : "月遅れ(再請求)"
        : st?.kokuho_target
        ? "国保対象"
        : st?.issued_at
        ? "発行済"
        : "未発行";
      lines.push(
        [
          rowYm,
          r.insured_number ?? "",
          `"${r.user_name}"`,
          r.care_level ?? "",
          r.totalUnits,
          r.insuranceAmount,
          r.userAmount, // 法定負担のみ (超過自費は次列)
          r.overUnits,
          r.selfPayAmount,
          state,
        ].join(","),
      );
    }
    // Excel 互換のため BOM 付き UTF-8
    const blob = new Blob(["﻿" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kaigo_seikyu_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const allChecked = checked.size === displayRows.length && displayRows.length > 0;

  // 認定申請中 (care_level='申請中') は認定結果が出るまで国保連請求の対象外。
  // 当月行のみ集計 (再請求行は元提供月の別集計)。行の amber 色付け + 上部バナー用。
  const shinseichuCount = displayRows.filter(
    (d) => !d.isReSeikyu && d.row.care_level === "申請中",
  ).length;

  return (
    <>
      <div className="flex flex-1 min-h-0 print:hidden">
        {/* ── 行カナ絞り込みサイドバー ── */}
        <SeikyuKanaSidebar />

        {/* ── メインテーブル ── */}
        <div className="flex flex-col flex-1 min-w-0 border-r border-gray-200">
          {/* ── ツールバー ── */}
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
            <SeikyuMonthNav />
            <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">請求分</span>
            <span className="text-xs text-gray-500">{displayRows.length} 件</span>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button
              onClick={printMeisai}
              disabled={displayRows.length === 0}
              title="対象者の介護給付費明細書 (様式第二) を印刷。印刷で発行済になります"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <FileText size={13} />明細書 ({targets.length}件)
            </button>
            <button
              onClick={printSeikyu}
              disabled={displayRows.length === 0}
              title="事業所単位の総括請求書 (様式第一) を印刷"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Printer size={13} />請求書
            </button>
            <button
              onClick={markKokuhoTarget}
              disabled={displayRows.length === 0}
              title="発行済の利用者を国保連請求の対象にする"
              className="border border-blue-500 rounded bg-blue-100 px-2.5 py-1 text-blue-800 font-semibold hover:bg-blue-200 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Landmark size={13} />国保対象
            </button>
            <button
              onClick={selectUnissued}
              disabled={displayRows.length === 0}
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              未発行のみ
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={exportCsv}
                disabled={displayRows.length === 0}
                title="明細一覧を Excel 閲覧用 CSV で出力"
                className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50"
              >
                <Download size={13} />確認用CSV
              </button>
            </div>
          </div>

          {/* SQL 未適用 (kaigo_visit_month_addons) 案内 */}
          {addonTableMissing && (
            <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                実績単位の加算テーブル (kaigo_visit_month_addons) が未作成です。
                migrations/kaigo_visit_month_addons.sql を Supabase SQL Editor で適用すると、
                初回・緊急時・生活機能向上連携加算を利用者×月で設定できます (適用まで加算なしで集計)。
              </span>
            </div>
          )}

          {/* 集計時の warning (身体介護9系 / 総合事業除外 / 入院重なり / 認定フォールバック /
              公費レコード未登録 等) + 再請求分の再集計 warning */}
          {!loading && (warnings.length > 0 || reWarnings.length > 0) && (() => {
            const allWarnings = [...new Set([...warnings, ...reWarnings])];
            return (
              <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  {allWarnings.slice(0, 8).map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                  {allWarnings.length > 8 && <p>…他 {allWarnings.length - 8} 件</p>}
                </div>
              </div>
            );
          })()}

          {/* 月遅れ/返戻の再請求 案内 */}
          {!loading && reRows.length > 0 && (
            <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                過去月の月遅れ・返戻 {reRows.length} 件を当月請求に合流しています
                (元提供月で明細書・伝送に反映)。国保対象化すると一覧から外れます。
              </span>
            </div>
          )}

          {/* 認定申請中の利用者 案内 (該当者がいるときのみ) */}
          {!loading && shinseichuCount > 0 && (
            <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                認定申請中の利用者が {shinseichuCount} 名います。認定結果が確定するまで国保連への請求対象外です
                (該当行は amber で色付けしています)。
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
                {/* ヘッダー行: 対象 / 申請中 / 状態 / 提供月 / 請求月 / サービス事業所 / 被保険者番号 / 利用者名 / 月遅 / 返戻 / 過誤 */}
                <div className={`${GRID_COLS} border-b border-gray-400 bg-gradient-to-b from-sky-100 to-sky-200 text-[11px] leading-4 font-medium text-gray-700 text-center sticky top-0 z-10`}>
                  <div className="px-1 py-0.5 flex items-center justify-center">
                    <button
                      onClick={toggleAll}
                      className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-all ${
                        allChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                      }`}
                    >
                      {allChecked && (
                        <span className="text-white text-[8px] font-bold leading-none">✓</span>
                      )}
                    </button>
                  </div>
                  <div className="px-1 py-0.5 border-l border-sky-300">申請中</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">状態</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">提供月</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">請求月</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">サービス事業所</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">被保険者番号</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">利用者名</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">月遅</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">返戻</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">過誤</div>
                </div>

                {displayRows.length === 0 ? (
                  <p className="text-gray-400 text-center py-10">
                    対象月の実績 (完了) がありません。サービス提供表で実績を確定してください。
                  </p>
                ) : displayRows.map((d) => {
                  const r = d.row;
                  // 当月行のみ status を突合 (再請求行は過去月レコードなので理由表示で代替)
                  const st = d.isReSeikyu ? undefined : statusByClient.get(r.user_id);
                  const isDetail = selectedKey === d.key;
                  const isChecked = checked.has(d.key);
                  const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
                  // 月遅れ行 = 提供月 ≠ 請求月 (再請求合流) or 月遅フラグ → 提供月セルを黄色ハイライト
                  const isTsukiokure =
                    d.origMonthKey !== monthKey || !!st?.tsukiokure;
                  // 認定申請中 (当月行のみ) = 国保連請求対象外 → 行を amber で色付け
                  const isShinseichu = !d.isReSeikyu && r.care_level === "申請中";
                  return (
                    <div
                      key={d.key}
                      onClick={() => setSelectedKey(isDetail ? null : d.key)}
                      title={
                        isShinseichu
                          ? "認定申請中のため請求できません (結果確定まで国保対象外)"
                          : undefined
                      }
                      className={`${GRID_COLS} border-b border-gray-200 text-[11px] leading-4 cursor-pointer transition-colors ${
                        isShinseichu ? "border-l-2 border-l-amber-400" : ""
                      } ${
                        isDetail
                          ? "bg-blue-100"
                          : isChecked
                          ? "bg-indigo-50"
                          : isShinseichu
                          ? "bg-amber-50 hover:bg-amber-100"
                          : "bg-white hover:bg-sky-50"
                      }`}
                    >
                      <div className="px-1 py-0.5 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => toggle(d.key)}
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-all ${
                            isChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                          }`}
                        >
                          {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                        </button>
                      </div>
                      {/* 申請中: 対象月の認定が申請中 (care_level='申請中') なら 〇。認定済は空欄 */}
                      <div className="px-1 py-0.5 border-l border-gray-200 text-center text-red-600 font-bold" title={isShinseichu ? "認定申請中のため請求できません (結果確定まで国保対象外)" : undefined}>
                        {isShinseichu ? "〇" : ""}
                      </div>
                      {/* 状態: バッジ背景なしの素の色文字 (ほのぼの流)。国保対象 = 赤字 */}
                      <div className="px-1 py-0.5 border-l border-gray-200">
                        {d.isReSeikyu ? (
                          <span className="text-amber-700">再請求</span>
                        ) : st?.kokuho_target ? (
                          <span className="text-red-600">国保対象</span>
                        ) : st?.issued_at ? (
                          <span className="text-emerald-700">発行済</span>
                        ) : (
                          <span className="text-gray-600">未発行</span>
                        )}
                      </div>
                      {/* 提供月 (再請求は元提供月。月遅れ行は黄色ハイライト) / 請求月 = 当月 */}
                      <div className={`px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700 ${isTsukiokure ? "bg-yellow-200" : ""}`}>
                        {reiwaMonth(oy, om)}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700">
                        {reiwaMonth(year, month)}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 text-gray-700 truncate" title={officeName ?? ""}>
                        {officeName ?? ""}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 font-mono text-gray-700">
                        {r.insured_number ?? "—"}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 text-gray-800 flex items-center gap-1 min-w-0">
                        <span className="flex-1 truncate">{r.user_name}</span>
                        {r.overUnits > 0 && (
                          <span
                            title={`区分支給限度基準 (${(r.limitUnits ?? 0).toLocaleString()} 単位) を超過。超過分 ${r.overUnits.toLocaleString()} 単位は保険請求・法定負担に含めず、${r.selfPayAmount.toLocaleString()} 円 (10割) を超過自費として利用請求に加算します`}
                            className="shrink-0 rounded bg-red-100 px-1 py-0.5 text-[10px] font-bold text-red-700 whitespace-nowrap"
                          >
                            限度額超過 {r.overUnits.toLocaleString()}単位
                          </span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); printMeisaiFor([d]); }}
                          title="この利用者の明細書 (様式第二) を印刷"
                          className="shrink-0 text-[10px] leading-none border border-gray-300 rounded px-1 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                        >明細書</button>
                      </div>
                      {/* 月遅 / 返戻 / 過誤 — 当月行は小さな select、再請求行は赤字の読取専用表示 */}
                      <div className="px-0.5 py-0.5 border-l border-gray-200 text-center" onClick={(e) => e.stopPropagation()}>
                        {d.isReSeikyu ? (
                          d.reasons?.tsukiokure && (
                            <span className="text-red-600">月遅</span>
                          )
                        ) : (
                          <select
                            value={st?.tsukiokure ? "月遅" : ""}
                            onChange={(e) => setFlag(r.user_id, "tsukiokure", e.target.value === "月遅")}
                            title="月遅れ"
                            className={`w-full text-[11px] leading-4 border border-gray-300 px-0 py-0 bg-white ${st?.tsukiokure ? "text-red-600" : "text-gray-500"}`}
                          >
                            <option value=""></option>
                            <option value="月遅">月遅</option>
                          </select>
                        )}
                      </div>
                      <div className="px-0.5 py-0.5 border-l border-gray-200 text-center" onClick={(e) => e.stopPropagation()}>
                        {d.isReSeikyu ? (
                          d.reasons?.henrei && (
                            <span className="text-red-600">返戻</span>
                          )
                        ) : (
                          <select
                            value={st?.henrei ? "返戻" : ""}
                            onChange={(e) => setFlag(r.user_id, "henrei", e.target.value === "返戻")}
                            className={`w-full text-[11px] leading-4 border border-gray-300 px-0 py-0 bg-white ${st?.henrei ? "text-red-600" : "text-gray-500"}`}
                          >
                            <option value=""></option>
                            <option value="返戻">返戻</option>
                          </select>
                        )}
                      </div>
                      <div className="px-0.5 py-0.5 border-l border-gray-200 text-center" onClick={(e) => e.stopPropagation()}>
                        {!d.isReSeikyu && (
                          <select
                            value={st?.kago ? "過誤" : ""}
                            onChange={(e) => setFlag(r.user_id, "kago", e.target.value === "過誤")}
                            title="過誤"
                            className={`w-full text-[11px] leading-4 border border-gray-300 px-0 py-0 bg-white ${st?.kago ? "text-red-600" : "text-gray-500"}`}
                          >
                            <option value=""></option>
                            <option value="過誤">過誤</option>
                          </select>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── 総合事業ブロック (7112/様式(予))。介護給付と混ぜず別枠で表示 ── */}
              <SougouBlock rows={filteredSougouRows} />

              {/* ── フッター合計 (ほのぼの流: ラベル=水色枠 + 値=白枠右寄せ のボックス並び) ── */}
              <div className="border-t border-gray-400 bg-gray-100 px-3 py-1.5 shrink-0 text-[11px] text-gray-800">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">合計件数</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[64px] text-right font-mono">{filteredRows.length.toLocaleString()}</span>
                  </span>
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">合計単位数</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[96px] text-right font-mono">{totalUnits.toLocaleString()}</span>
                  </span>
                  <span className="ml-auto text-gray-500">
                    実績 {recordCount.toLocaleString()} 件
                    {reRows.length > 0 && <> / 再請求 {reRows.length.toLocaleString()} 件</>}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">国保件数</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[64px] text-right font-mono">{kokuhoCount.toLocaleString()}</span>
                  </span>
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">国保対象単位数</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[96px] text-right font-mono">{kokuhoUnits.toLocaleString()}</span>
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── 右：明細情報 (ほのぼの流: 青系帯 + 高密度明細 + ラベル箱/値箱 grid) ── */}
        <div className="w-80 shrink-0 flex flex-col bg-white">
          <div className="border-b border-sky-700 bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-1 text-xs font-bold text-white flex items-center gap-2">
            <span>明細情報</span>
            {selected && <span className="font-normal text-sky-100 truncate">{selected.user_name}</span>}
          </div>
          {selected ? (
            <>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-[11px] leading-4 border-collapse">
                  <thead className="bg-gradient-to-b from-sky-100 to-sky-200 border-b border-gray-400 sticky top-0">
                    <tr>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300">サービス内容</th>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-14 whitespace-nowrap">単位数/単価</th>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-8">回数</th>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-12">単位数</th>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 w-16">摘要</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.details.map((dt) => (
                      <tr key={dt.service_type} className="border-b border-gray-200 bg-white">
                        <td className="px-1 py-0.5 text-gray-700 leading-tight border-r border-gray-200">
                          {dt.short_name ?? dt.service_type}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200">
                          {dt.unit_per.toLocaleString()}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200">
                          {dt.count}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-800 border-r border-gray-200">
                          {dt.units.toLocaleString()}
                        </td>
                        <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono truncate" title={dt.service_code ?? ""}>
                          {dt.service_code ?? ""}
                        </td>
                      </tr>
                    ))}
                    {selected.addonUnits > 0 && (
                      <tr className="border-b border-gray-200 bg-white">
                        <td className="px-1 py-0.5 text-gray-700 leading-tight border-r border-gray-200">
                          {selected.addonLabel ?? "処遇改善加算"}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200">
                          {selected.addonUnits.toLocaleString()}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200">1</td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-800 border-r border-gray-200">
                          {selected.addonUnits.toLocaleString()}
                        </td>
                        <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono truncate">
                          {selected.addonCode ?? ""}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── 月次加算 (実績単位の加算) — 表示専用。編集はサービス提供表 (実績) 画面へ移設 ── */}
              {selectedCurUserId && (() => {
                const addon = addonByClient.get(selectedCurUserId);
                return (
                  <div className="border-t border-gray-300 bg-gray-50 shrink-0 px-2 py-1.5 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-700">月次加算</span>
                      {addonTableMissing && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                          SQL未適用
                        </span>
                      )}
                      {!addonTableMissing && shokaiCandidate && !addon?.shokai && (
                        <span
                          title="過去 2 ヶ月に完了実績が無いため初回加算の候補です (付与はサービス提供表 (実績) 画面で行います)"
                          className="rounded border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                        >
                          初回加算 候補
                        </span>
                      )}
                      <Link
                        href="/provision-tickets"
                        title="月次加算 (初回 / 緊急時 / 生活機能向上連携) の設定はサービス提供表 (実績) 画面で行います"
                        className="ml-auto flex items-center gap-1 text-[10px] text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        <ExternalLink size={11} />
                        サービス提供表 (実績) で編集
                      </Link>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-700">
                      <span title="訪問介護初回加算 (114001)">
                        初回加算:{" "}
                        <strong className={addon?.shokai ? "text-blue-700" : "text-gray-400 font-normal"}>
                          {addon?.shokai ? "あり" : "なし"}
                        </strong>
                      </span>
                      <span title="緊急時訪問介護加算 (114000)。シフトの緊急時訪問 (kinkyu_houmon) 実績があればそちらが優先されます">
                        緊急時:{" "}
                        <strong className={(addon?.kinkyu_count ?? 0) > 0 ? "text-blue-700 font-mono" : "text-gray-400 font-normal font-mono"}>
                          {addon?.kinkyu_count ?? 0}
                        </strong>{" "}
                        回
                      </span>
                      <span title="訪問介護生活機能向上連携加算 Ⅰ(114003) / Ⅱ(114002)">
                        生活機能向上:{" "}
                        <strong className={addon?.seikatsu_kino && addon.seikatsu_kino !== "なし" ? "text-blue-700" : "text-gray-400 font-normal"}>
                          {addon?.seikatsu_kino ?? "なし"}
                        </strong>
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* 右下: ラベル箱 + 値箱 のペア grid (2 列 × 4 行、ほのぼの流) */}
              <div className="border-t border-gray-400 bg-gray-100 shrink-0 p-1.5">
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-px bg-gray-400 border border-gray-400 text-[11px] leading-4">
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">特定介護請求額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono" />
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">軽減額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono" />
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">保険単位数</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.totalUnits.toLocaleString()}</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">公費単位数</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                    {selected.kohiUnits != null ? selected.kohiUnits.toLocaleString() : ""}
                  </div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">保険請求額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.insuranceAmount.toLocaleString()}</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">公費請求額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                    {selected.kohiAmount != null ? selected.kohiAmount.toLocaleString() : ""}
                  </div>
                  {/* 利用者負担額 = 保険/公費で賄われない法定の本人負担のみ (超過自費は別掲) */}
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">利用者負担額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                    {selected.userAmount.toLocaleString()}
                  </div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">公費分本人負担</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.publicExpense ? "0" : ""}</div>
                  {selected.overUnits > 0 && (
                    <>
                      <div
                        className="bg-red-50 px-1.5 py-0.5 whitespace-nowrap text-red-700"
                        title={
                          selected.overSource === "manual"
                            ? "ケアマネが利用票別表で確定した自事業所分の超過自費単位 (kaigo_gendo_allocation manual)"
                            : "機械判定 (管理対象単位 − 区分支給限度基準)。ケアマネの別表割振りが確定するとそちらが優先されます"
                        }
                      >
                        超過単位数
                      </div>
                      <div className="bg-white px-1.5 py-0.5 text-right font-mono text-red-700">
                        {selected.overUnits.toLocaleString()}
                        <span className="ml-0.5 font-sans text-[9px]">
                          ({selected.overSource === "manual" ? "ケアマネ割振り" : "自動判定"})
                        </span>
                      </div>
                      <div className="bg-red-50 px-1.5 py-0.5 whitespace-nowrap text-red-700">超過自費額</div>
                      <div className="bg-white px-1.5 py-0.5 text-right font-mono text-red-700">
                        {selected.overAmount.toLocaleString()}
                      </div>
                    </>
                  )}
                </div>
                {selected.overUnits > 0 && (
                  <p className="px-0.5 pt-1 text-[10px] text-red-600">
                    {selected.overSource === "manual" ? (
                      <>
                        限度額超過 {selected.overUnits.toLocaleString()} 単位 (ケアマネ割振り =
                        利用票別表で確定した自事業所分の自費単位)
                      </>
                    ) : (
                      <>
                        区分支給限度基準 {(selected.limitUnits ?? 0).toLocaleString()} 単位に対し
                        実績 {selected.grossBaseUnits.toLocaleString()} 単位 →
                        超過 {selected.overUnits.toLocaleString()} 単位 (自動判定)
                      </>
                    )}
                    {" "}× 単価 {selected.unitPrice.toFixed(2)} 円 (10割) ={" "}
                    {selected.selfPayAmount.toLocaleString()} 円を超過自費として利用請求に加算。
                    上記の利用者負担額 (法定) には含めません。超過分は保険請求・明細書
                    (様式第二) の集計にも含めません。
                  </p>
                )}
                {selected.publicExpense && (
                  <p className="px-0.5 pt-1 text-[10px] text-purple-600">
                    公費: {selected.publicExpense}
                    {selected.kohiTandoku
                      ? " (公費単独請求 = 保険給付なし・総費用の10割を公費請求)"
                      : " (本人負担分を公費請求へ振替)"}
                  </p>
                )}
                {selected.kohiTandoku && !selected.kohiHobetsu && (
                  <p className="px-0.5 pt-0.5 text-[10px] text-amber-600">
                    ⚠ 公費単独 (被保険者番号 H) ですが公費情報 (法別12 生活保護)
                    が未登録です。保険情報に公費を登録してください。
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
              行を選択してください
            </div>
          )}
        </div>
      </div>

      {/* ===== 印刷 view: 明細書 (様式第二) — 利用者 1 名 = 1 枚 ===== */}
      {/* 再請求行は元提供月 (origMonthKey) で reiwa/month を出す */}
      {printMode === "meisai" && (
        <div className="hidden print:block">
          {(meisaiPrintRows ?? targetDisplayRows).map((d) => {
            const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
            // 契約 C1: 様式第二の限度額欄。
            //   kanriTaishougaiUnits = 処遇改善等%加算 + 初回 + 緊急時 (限度額管理対象外)
            //   planUnits = ④計画単位数 (kaigo_monthly_plan_units があればそれ、
            //               無ければ基準内 (管理対象) 単位数)
            // _meisai.tsx 側の optional props (kanriTaishougaiUnits? / planUnits?) へ
            // spread で渡す (props 追加は別エージェント担当)。
            const kanriProps = {
              kanriTaishougaiUnits: d.row.kanriTaishougaiUnits,
              planUnits:
                d.row.planUnits ??
                d.row.baseUnits - (d.row.kanriTaishougaiUnits - d.row.addonUnits),
            };
            return (
              <MeisaiPrintSheet
                key={d.key}
                row={d.row}
                officeName={officeName}
                officeNumber={officeNumber}
                officeAddress={officeAddress}
                officePhone={officePhone}
                officePostal={officePostal}
                reiwa={oy - 2018}
                month={om}
                {...kanriProps}
              />
            );
          })}
        </div>
      )}

      {/* ===== 印刷 view: 請求書 (様式第一) — 事業所単位の総括 1 枚 ===== */}
      {/* 総括は当月の通常分のみ (再請求は元提供月の別請求書扱い) */}
      {printMode === "seikyu" && (
        <div className="hidden print:block">
          <SeikyuForm
            providerNumber={officeNumber ?? ""}
            officeName={officeName ?? ""}
            officeAddress={officeAddress ?? ""}
            officePhone={officePhone ?? ""}
            postalCode={officePostal ?? ""}
            billingMonth={monthKey}
            totalCount={hokenTargets.length}
            totalUnits={targetUnits}
            totalAmount={targetCost}
            insuranceAmount={targetInsurance}
            userCopay={targetUser}
            kubunLabel={"居宅サービス・地域密着型\nサービス・介護予防サービス"}
            kohiRequestAmount={targetKohi}
            kohiRows={seikyuKohiRows}
            kohiTandoku={seikyuKohiTandoku}
          />
        </div>
      )}
    </>
  );
}

// ── 総合事業 (介護予防・日常生活支援総合事業) 訪問型サービス (A2) の請求ブロック ──
//    介護給付 (7131) とは別様式 (7112/様式(予)) なので、介護保険分と混ぜず別枠で表示する。
//    折りたたみトグル。行なしのときは何も出さない。
function SougouBlock({ rows }: { rows: UserSeikyuRow[] }) {
  const [open, setOpen] = useState(true);
  if (rows.length === 0) return null;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);
  return (
    <div className="border-t-2 border-emerald-300 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100"
      >
        <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-white">総合事業</span>
        <span>訪問型サービス (A2) {rows.length} 件</span>
        <span className="font-normal text-emerald-600">
          — 介護給付とは別様式 (国保連 7112) で伝送します
        </span>
        <span className="ml-auto text-emerald-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-[11px] leading-4 border-collapse">
            <thead className="bg-emerald-100/70 border-b border-emerald-200 sticky top-0">
              <tr className="text-gray-600">
                <th className="text-left px-2 py-1 font-medium border-r border-emerald-200">被保険者番号</th>
                <th className="text-left px-2 py-1 font-medium border-r border-emerald-200">利用者名</th>
                <th className="text-left px-2 py-1 font-medium border-r border-emerald-200">要介護度</th>
                <th className="text-left px-2 py-1 font-medium border-r border-emerald-200">サービス内容</th>
                <th className="text-right px-2 py-1 font-medium border-r border-emerald-200">総単位数</th>
                <th className="text-right px-2 py-1 font-medium border-r border-emerald-200">保険請求額</th>
                <th className="text-right px-2 py-1 font-medium">利用者負担</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const svc = r.details
                  .map((d) => d.short_name ?? d.service_type)
                  .join(" / ");
                return (
                  <tr key={r.user_id} className="border-b border-emerald-100 bg-white">
                    <td className="px-2 py-1 font-mono text-gray-700 border-r border-emerald-100">
                      {r.insured_number ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-gray-800 border-r border-emerald-100">{r.user_name}</td>
                    <td className="px-2 py-1 text-gray-700 border-r border-emerald-100">{r.care_level ?? "—"}</td>
                    <td className="px-2 py-1 text-gray-600 border-r border-emerald-100 truncate max-w-[220px]" title={svc}>
                      {svc}
                      {r.addonLabel && r.addonUnits > 0 && (
                        <span className="ml-1 text-emerald-600">+{r.addonLabel}</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-gray-700 border-r border-emerald-100">
                      {r.totalUnits.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 text-right font-mono font-semibold text-emerald-700 border-r border-emerald-100">
                      {r.insuranceAmount.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-gray-700">
                      {r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="bg-emerald-50 px-3 py-1 text-[11px] text-emerald-800 flex flex-wrap gap-x-4 gap-y-0.5">
        <span>合計 <strong className="font-mono">{rows.length}</strong> 件</span>
        <span>総単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
        <span>保険請求額 <strong className="font-mono">¥{totalInsurance.toLocaleString()}</strong></span>
        <span>利用者負担 <strong className="font-mono">¥{totalUser.toLocaleString()}</strong></span>
        <span className="ml-auto text-emerald-600">伝送ファイル (7112) は「国保請求」タブから出力</span>
      </div>
    </div>
  );
}
