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
 * ※ Phase 2: 月遅れ/返戻/過誤の再請求。過去月の月遅れ/返戻/過誤 (未・国保対象) を
 *    元提供月で再集計し、当月一覧にバッジ付きで合流。明細書・伝送・国保対象化は
 *    各自の元提供月で反映する。
 *
 * ※ 過誤 (かご): 支払済レセプトの取下げ → 再請求。右ペインの「過誤申立」ブロックで
 *    申立日・事由コード (4桁 = 様式番号 + 申立理由番号)・同月過誤を登録すると
 *    kago=true + kokuho_target=false (取下げ) になり、翌月以降の請求に合流する。
 *    通常過誤 = 過誤決定 (支払控除) の翌月以降に再請求 / 同月過誤 = 申立と同月に再請求。
 *    保険者提出用の一覧はツールバー「過誤申立CSV」から出力 (様式は保険者ごと)。
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
  Building2,
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
  type ReSeikyuReasons,
  type ReSeikyuRow,
} from "@/lib/visit-seikyu/re-seikyu";
import {
  buildKagoMoushitateCsv,
  loadKagoMoushitateRows,
  type KagoInfo,
} from "@/lib/visit-seikyu/kago";
import { KagoBlock, type KagoSaveFields } from "./kago-block";
import {
  getGensanPeriodsForMonth,
  GENSAN_LABELS,
  type GensanPeriod,
} from "@/lib/visit-seikyu/gyakutai-bcp";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { SameBuildingCheckPanel } from "./same-building-check-panel";

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
  // 過誤申立の付帯列 (migrations/kago_saiseikyu.sql 適用後のみ)
  kago_moushitate_date?: string | null;
  kago_jiyu_code?: string | null;
  kago_dougetsu?: boolean;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)
interface DisplayRow {
  /** 一意キー (利用者 × 提供月)。当月="cur:<id>" / 再請求="re:<id>:<origMonthKey>" */
  key: string;
  row: UserSeikyuRow;
  /** この行の提供月 (YYYY-MM)。当月行は当月、再請求行は元提供月 */
  origMonthKey: string;
  /** 月遅れ/返戻/過誤の再請求行か */
  isReSeikyu: boolean;
  /** 再請求理由 (月遅れ/返戻/過誤)。当月通常行は null */
  reasons: ReSeikyuReasons | null;
  /** 過誤申立の付帯情報 (過誤の再請求行のみ)。当月通常行は statusByClient から引く */
  kagoInfo: KagoInfo | null;
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
    year, month, rows, sougouRows, filteredRows, filteredSougouRows, kanaMatches, recordCount, loading, error, warnings,
    officeName, officeNumber, officeAddress, officePhone, officePostal,
    officeId, tenantId, unitPrice, appliedFormulaCodes,
  } = useSeikyuContext();
  const { currentOffice, businessType } = useBusinessType();
  const isBath = businessType === "訪問入浴";
  // 訪問入浴は月遅れ/返戻/過誤フラグを bath_billing_status に持つ (schema 同型)
  const billingStatusTable = isBath ? "bath_billing_status" : "kaigo_billing_status";
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
  // 対象月に適用中の 虐防/業未 減算 (kaigo_office_gensan_periods。バナー表示用)
  const [gensanPeriods, setGensanPeriods] = useState<GensanPeriod[]>([]);
  // 同一建物減算チェック パネル (提案・警告のみ。設定書換なし)
  const [sameBuildingOpen, setSameBuildingOpen] = useState(false);
  // チェック対象 = 当月の全実利用者 (カナ絞込前。介護給付 + 総合事業)
  const sameBuildingUserIds = useMemo(
    () =>
      Array.from(new Set([...rows, ...sougouRows].map((r) => r.user_id))),
    [rows, sougouRows],
  );

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // ── 虐防/業未 減算の適用状況 (対象月)。訪問介護・訪問入浴とも合成コード方式で
  //    集計側が自動差し替えするため共通表示。テーブル未適用は空 = バナー非表示 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!officeId) {
        if (!cancelled) setGensanPeriods([]);
        return;
      }
      try {
        const periods = await getGensanPeriodsForMonth(supabase, officeId, monthKey);
        if (!cancelled) setGensanPeriods(periods);
      } catch (e) {
        console.warn("減算適用状況の取得に失敗:", e);
        if (!cancelled) setGensanPeriods([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, officeId, monthKey]);

  // ── 表示用の統合行 (当月通常行 + 再請求行)。カナ索引で共通絞込 ──
  // rowKey: 当月行は "cur:<user_id>:<segmentIndex>" /
  //         再請求行は "re:<user_id>:<origMonthKey>:<segmentIndex>"
  // (segmentIndex は保険者変更 (転居) の分割行のみ 1 以上。通常は 0 — Phase 2)
  const displayRows = useMemo<DisplayRow[]>(() => {
    const cur: DisplayRow[] = filteredRows.map((r) => ({
      key: `cur:${r.user_id}:${r.segmentIndex ?? 0}`,
      row: r,
      origMonthKey: monthKey,
      isReSeikyu: false,
      reasons: null,
      kagoInfo: null,
    }));
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}:${r.segmentIndex ?? 0}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
      kagoInfo: r.__kago,
    }));
    // 再請求 (過去分) を上、当月を下に並べる
    return [...re, ...cur];
  }, [filteredRows, reRows, kanaMatches, monthKey]);

  // 未選択時は先頭行にフォールバック (障害請求と同じく明細ペインを既定で開く)
  const selectedDisplay =
    displayRows.find((d) => d.key === selectedKey) ?? displayRows[0] ?? null;
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

  // 過誤申立の付帯列 (kago_*) が未適用 (migrations/kago_saiseikyu.sql 未実行) か
  const [kagoColsMissing, setKagoColsMissing] = useState(false);

  // ── kaigo_billing_status を (office_id, target_month) で読み、client_id で突合 ──
  const loadStatus = useCallback(async () => {
    if (!officeId) {
      setStatusByClient(new Map());
      return;
    }
    const BASE = "client_id, issued_at, kokuho_target, tsukiokure, henrei, kago, notes";
    const EXT = `${BASE}, kago_moushitate_date, kago_jiyu_code, kago_dougetsu`;
    let { data, error: e } = await supabase
      .from(billingStatusTable)
      .select(EXT)
      .eq("office_id", officeId)
      .eq("target_month", monthKey);
    if (e && e.code === "42703") {
      // kago_* 列が未適用 → 基本列のみで再取得 (過誤ブロックは SQL未適用 表示)
      setKagoColsMissing(true);
      ({ data, error: e } = await supabase
        .from(billingStatusTable)
        .select(BASE)
        .eq("office_id", officeId)
        .eq("target_month", monthKey));
    } else if (!e) {
      setKagoColsMissing(false);
    }
    if (e) {
      // table 未作成 (migration 未適用) 時は状態なしとして続行
      if (!isTableMissingError(e.code)) toast.error("請求状態の取得に失敗: " + e.message);
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(((data ?? []) as unknown as BillingStatusRow[]).map((r) => [r.client_id, r])),
    );
  }, [supabase, monthKey, officeId, billingStatusTable]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadStatus();
  }, [loadStatus]);

  // ── 実績単位の月次加算 (kaigo_visit_month_addons: 初回 / 緊急時 / 生活機能向上連携) ──
  //    この画面は表示専用 (編集はサービス提供表 (実績) 画面へ移設)
  const [addonByClient, setAddonByClient] = useState<Map<string, MonthAddonRow>>(new Map());
  const [addonTableMissing, setAddonTableMissing] = useState(false);

  const loadAddons = useCallback(async () => {
    // 訪問入浴は初回/緊急時/生活機能向上の月次加算が無い (加算は提供表のサービス追加→実績で計上)
    if (!officeId || isBath) {
      setAddonByClient(new Map());
      return;
    }
    // 入力経路 2 系統 (集計 aggregate.ts と同じ) を読んでマージする:
    //   a. kaigo_visit_month_addons (旧 3固定フラグ。移行期データ)
    //   b. kaigo_visit_addon_lines の月次4コード (現行の提供表 加算エディタ)
    // 両方に同じ加算がある場合は boolean は OR、回数は max (二重計上防止 = 集計と同規則)。
    // ※ 月次4コード以外の加算行は集計の details に加算行として乗る (上の明細表に表示)。
    const [oldRes, lineRes] = await Promise.all([
      supabase
        .from("kaigo_visit_month_addons")
        .select("client_id, shokai, seikatsu_kino, kinkyu_count")
        .eq("office_id", officeId)
        .eq("target_month", monthKey),
      supabase
        .from("kaigo_visit_addon_lines")
        .select("client_id, addon_code, count")
        .eq("office_id", officeId)
        .eq("target_month", monthKey)
        .in("addon_code", ["114001", "114000", "114003", "114002"]),
    ]);
    const oldMissing = !!oldRes.error && isTableMissingError(oldRes.error.code);
    const lineMissing = !!lineRes.error && isTableMissingError(lineRes.error.code);
    if (oldRes.error && !oldMissing) {
      toast.error("月次加算の取得に失敗: " + oldRes.error.message);
      setAddonByClient(new Map());
      return;
    }
    if (lineRes.error && !lineMissing) {
      toast.error("月次加算 (加算行) の取得に失敗: " + lineRes.error.message);
      setAddonByClient(new Map());
      return;
    }
    // 両テーブルとも未作成のときのみ SQL 未適用バナー (片方あれば加算表示は成立する)
    setAddonTableMissing(oldMissing && lineMissing);
    const map = new Map<string, MonthAddonRow>(
      oldMissing
        ? []
        : ((oldRes.data ?? []) as MonthAddonRow[]).map((r) => [r.client_id, r]),
    );
    if (!lineMissing) {
      for (const r of (lineRes.data ?? []) as {
        client_id: string;
        addon_code: string;
        count: number | null;
      }[]) {
        const count = r.count ?? 0;
        if (count <= 0) continue;
        let f = map.get(r.client_id);
        if (!f) {
          f = { client_id: r.client_id, shokai: false, seikatsu_kino: "なし", kinkyu_count: 0 };
          map.set(r.client_id, f);
        }
        if (r.addon_code === "114001") {
          f.shokai = true;
        } else if (r.addon_code === "114000") {
          f.kinkyu_count = Math.max(f.kinkyu_count, count);
        } else {
          // 114002 (Ⅱ) / 114003 (Ⅰ)。両方ある異常データは上位 (Ⅱ) を採用
          const grade = r.addon_code === "114002" ? "Ⅱ" : "Ⅰ";
          if (f.seikatsu_kino !== "Ⅱ") f.seikatsu_kino = grade;
        }
      }
    }
    setAddonByClient(map);
  }, [supabase, officeId, monthKey, isBath]);

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
      .from(billingStatusTable)
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      toast.error("フラグの保存に失敗: " + e.message);
      return;
    }
    loadStatus();
  };

  // ── 過誤申立の登録 (右ペインの過誤ブロック) ──
  //    kago=true + 申立日/事由コード/同月過誤 を保存し、kokuho_target=false に落とす
  //    (= 取下げ。re-seikyu の「再請求未実施」判定に乗り、翌月以降の請求に合流する)
  const saveKago = async (clientId: string, f: KagoSaveFields) => {
    if (!officeId) {
      toast.error("事業所が未選択のため過誤申立を保存できません");
      return;
    }
    const cur = statusByClient.get(clientId);
    const payload: Record<string, unknown> = {
      client_id: clientId,
      target_month: monthKey,
      tenant_id: currentOffice?.tenant_id ?? "kt-group",
      office_id: officeId,
      kago: true,
      kago_moushitate_date: f.moushitateDate,
      kago_jiyu_code: f.jiyuCode,
      kago_dougetsu: f.dougetsu,
      // 取下げ = 国保対象から外す (再請求の伝送で再度 true になる)
      kokuho_target: false,
      // 他フラグは既存値を保持
      tsukiokure: cur?.tsukiokure ?? false,
      henrei: cur?.henrei ?? false,
    };
    const { error: e } = await supabase
      .from(billingStatusTable)
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      // 列未適用 (insert/update=PGRST204 / 直 SQL=42703)
      if (e.code === "PGRST204" || e.code === "42703") {
        toast.error(
          "過誤申立の列が未適用です。migrations/kago_saiseikyu.sql を Supabase SQL Editor で適用してください",
        );
      } else {
        toast.error("過誤申立の保存に失敗: " + e.message);
      }
      return;
    }
    toast.success(
      "過誤申立を登録しました (国保対象から外れ、翌月以降の請求画面に再請求候補として合流します)",
    );
    loadStatus();
  };

  // ── 過誤申立の解除 (kago フラグ + 付帯情報をクリア。kokuho_target は触らない) ──
  const clearKago = async (clientId: string) => {
    if (!officeId) {
      toast.error("事業所が未選択のため過誤申立を解除できません");
      return;
    }
    const cur = statusByClient.get(clientId);
    const payload: Record<string, unknown> = {
      client_id: clientId,
      target_month: monthKey,
      tenant_id: currentOffice?.tenant_id ?? "kt-group",
      office_id: officeId,
      kago: false,
      tsukiokure: cur?.tsukiokure ?? false,
      henrei: cur?.henrei ?? false,
    };
    // 付帯列は適用済みの環境でのみクリア (未適用だと PGRST204 になるため)
    if (!kagoColsMissing) {
      payload.kago_moushitate_date = null;
      payload.kago_jiyu_code = null;
      payload.kago_dougetsu = false;
    }
    const { error: e } = await supabase
      .from(billingStatusTable)
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      toast.error("過誤申立の解除に失敗: " + e.message);
      return;
    }
    toast.success(
      "過誤申立を解除しました (国保対象は自動では戻しません。必要ならツールバーの「国保対象」で再度対象化してください)",
    );
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
  // 保険請求分の公費 (生保の振替分 + 保険優先公費の上限適用分) — 公費請求欄の再掲元。
  // 法別番号ごとに集計する (法別21/54 等の部分公費は生保行に混ぜない)。
  // 単位数・費用合計は公費対象分 (kohiUnits / kohiTargetCost。全量公費は総量と同値)。
  // 複数公費の併用行 (kohi2Amount あり) は公費1・公費2 をそれぞれの法別の行に積む。
  const targetKohi = hokenTargets.reduce(
    (s, r) => s + (r.kohiAmount ?? 0) + (r.kohi2Amount ?? 0),
    0,
  );
  const seikyuKohiRows = (() => {
    interface KohiEntry { units: number; cost: number; kohi: number }
    const byHobetsu = new Map<string, KohiEntry[]>();
    const push = (hobetsu: string, e: KohiEntry) => {
      if (!byHobetsu.has(hobetsu)) byHobetsu.set(hobetsu, []);
      byHobetsu.get(hobetsu)!.push(e);
    };
    for (const r of hokenTargets) {
      if ((r.kohiAmount ?? 0) > 0) {
        // 旧テキストのみの移行期データは生保扱い (aggregate と同基準)
        push(r.kohiHobetsu ?? "12", {
          units: r.kohiUnits ?? 0,
          cost: r.kohiTargetCost ?? r.totalAmount,
          kohi: r.kohiAmount ?? 0,
        });
      }
      if (r.kohi2Hobetsu && (r.kohi2Amount ?? 0) > 0) {
        push(r.kohi2Hobetsu, {
          units: r.kohi2Units ?? 0,
          cost: r.kohi2TargetCost ?? 0,
          kohi: r.kohi2Amount ?? 0,
        });
      }
    }
    return Array.from(byHobetsu.entries()).map(([code, es]) => ({
      code,
      count: es.length,
      units: es.reduce((s, e) => s + e.units, 0),
      cost: es.reduce((s, e) => s + e.cost, 0),
      kohi: es.reduce((s, e) => s + e.kohi, 0),
    }));
  })();
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
        .from(billingStatusTable)
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
    [supabase, officeId, billingStatusTable],
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
    // 全行で同一のキー集合にする (upsert の PGRST102「All object keys must match」予防)。
    // 保険者変更の分割セグメント行 (Phase 2) は status が利用者×月の 1 レコードなので
    // 重複キー (client_id, target_month) を除去する (upsert の同一行二重更新エラー予防)
    const seenStatusKey = new Set<string>();
    const payload: Record<string, unknown>[] = [];
    for (const d of rowsToPrint) {
      const statusKey = `${d.row.user_id}:${d.origMonthKey}`;
      if (seenStatusKey.has(statusKey)) continue;
      seenStatusKey.add(statusKey);
      // 当月行は当月 status、再請求行は元提供月の既存レコードを引き継ぐ
      const cur = d.isReSeikyu
        ? origStatus.get(statusKey)
        : statusByClient.get(d.row.user_id);
      payload.push({
        client_id: d.row.user_id,
        target_month: d.origMonthKey,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: officeId,
        issued_at: now,
        // 既存フラグを保持 (再請求行は理由フラグを保持)
        kokuho_target: cur?.kokuho_target ?? false,
        tsukiokure: d.reasons?.tsukiokure ?? cur?.tsukiokure ?? false,
        henrei: d.reasons?.henrei ?? cur?.henrei ?? false,
        kago: d.reasons?.kago ?? cur?.kago ?? false,
        notes: cur?.notes ?? null,
      });
    }
    const { error: e } = await supabase
      .from(billingStatusTable)
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
    // 分割セグメント行 (Phase 2) は status 1 レコード (利用者×月) に集約 (重複 upsert 予防)
    const seenStatusKey = new Set<string>();

    for (const d of targetDisplayRows) {
      const statusKey = `${d.row.user_id}:${d.origMonthKey}`;
      if (seenStatusKey.has(statusKey)) continue;
      seenStatusKey.add(statusKey);
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
          kago: d.reasons?.kago ?? cur?.kago ?? false,
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
      .from(billingStatusTable)
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
        : st?.kokuho_target
        ? "国保対象"
        : st?.issued_at
        ? "発行済"
        : "未発行";
      // 保険者変更 (転居) の分割行は状態に分割番号を付記 (Phase 2)
      const state =
        (r.segmentCount ?? 1) > 1
          ? `${baseState}(分割${(r.segmentIndex ?? 0) + 1}/${r.segmentCount})`
          : baseState;
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

  // ── 過誤申立CSV: 過誤申立中 (kago=true × 国保未対象 = 取下げ済・再請求未実施) の
  //    一覧を保険者提出の下書き用に出力する (様式そのものは保険者ごとなので一覧まで) ──
  const exportKagoCsv = async () => {
    if (!officeId) {
      toast.error("事業所が未選択のため出力できません");
      return;
    }
    try {
      const { rows: kagoRows, colsMissing } = await loadKagoMoushitateRows(supabase, {
        officeId,
        table: billingStatusTable,
      });
      if (kagoRows.length === 0) {
        toast.info(
          "過誤申立中の行がありません (右ペインの過誤申立ブロックで登録した行が対象です)",
        );
        return;
      }
      if (colsMissing) {
        toast.warning(
          "migrations/kago_saiseikyu.sql が未適用のため、申立日・事由コードは空欄で出力します",
        );
      }
      const csv = buildKagoMoushitateCsv(kagoRows);
      // Excel 互換のため BOM 付き UTF-8
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kago_moushitate_${monthKey.replace("-", "")}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(
        "過誤申立CSVの出力に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
    }
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
          {/* ── ツールバー (ボタンが多いタブなので text-xs + 余白詰めで 1 行に固定。
                 flex-nowrap + overflow-x-auto: 幅不足でも折り返さず横スクロール) ── */}
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-1 flex-nowrap overflow-x-auto text-xs whitespace-nowrap">
            <SeikyuMonthNav />
            <span className="border border-gray-400 rounded bg-white px-2 py-1 text-gray-700 font-medium">請求分</span>
            <span className="text-xs text-gray-500">{displayRows.length} 件</span>
            <div className="w-px h-5 bg-gray-300 mx-0.5 shrink-0" />
            <button
              onClick={printMeisai}
              disabled={displayRows.length === 0}
              title="対象者の介護給付費明細書 (様式第二) を印刷。印刷で発行済になります"
              className="border border-gray-400 rounded bg-white px-1.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1 disabled:opacity-50"
            >
              <FileText size={13} />明細書 ({targets.length}件)
            </button>
            <button
              onClick={printSeikyu}
              disabled={displayRows.length === 0}
              title="事業所単位の総括請求書 (様式第一) を印刷"
              className="border border-gray-400 rounded bg-white px-1.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1 disabled:opacity-50"
            >
              <Printer size={13} />請求書
            </button>
            <button
              onClick={markKokuhoTarget}
              disabled={displayRows.length === 0}
              title="発行済の利用者を国保連請求の対象にする"
              className="border border-blue-500 rounded bg-blue-100 px-1.5 py-1 text-blue-800 font-semibold hover:bg-blue-200 flex items-center gap-1 disabled:opacity-50"
            >
              <Landmark size={13} />国保対象
            </button>
            <button
              onClick={selectUnissued}
              disabled={displayRows.length === 0}
              className="border border-gray-400 rounded bg-white px-1.5 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              未発行
            </button>
            {!isBath && (
              <button
                onClick={() => setSameBuildingOpen(true)}
                disabled={loading || !officeId || sameBuildingUserIds.length === 0}
                title="住所グルーピングで同一建物らしき集団を推定し、同一建物減算 (10%/15%/12%) の設定と突合します (提案のみ。設定変更はしません)"
                className="border border-gray-400 rounded bg-white px-1.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1 disabled:opacity-50"
              >
                <Building2 size={13} />同一建物
              </button>
            )}
            <button
              onClick={exportKagoCsv}
              disabled={!officeId}
              title="過誤申立中 (取下げ済・再請求未実施) の一覧を保険者提出の下書き用に CSV 出力します (申立様式は保険者ごとのため一覧まで)"
              className="border border-red-400 rounded bg-white px-1.5 py-1 text-red-700 hover:bg-red-50 flex items-center gap-1 disabled:opacity-50"
            >
              <Download size={13} />過誤CSV
            </button>
            <button
              onClick={exportCsv}
              disabled={displayRows.length === 0}
              title="明細一覧を Excel 閲覧用 CSV で出力"
              className="border border-indigo-500 rounded bg-indigo-500 px-1.5 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1 disabled:opacity-50"
            >
              <Download size={13} />確認用CSV
            </button>
          </div>

          {/* SQL 未適用 (kaigo_visit_addon_lines / kaigo_visit_month_addons とも未作成) 案内 */}
          {addonTableMissing && (
            <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                実績単位の加算テーブル (kaigo_visit_addon_lines / kaigo_visit_month_addons) が未作成です。
                migrations/kaigo_visit_addon_lines.sql を Supabase SQL Editor で適用すると、
                初回・緊急時・生活機能向上連携加算などを利用者×月で設定できます (適用まで加算なしで集計)。
              </span>
            </div>
          )}

          {/* 虐防/業未 減算 (体制未整備) 適用中バナー (対象月に適用期間がある場合のみ) */}
          {!loading && gensanPeriods.length > 0 && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-red-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                {gensanPeriods
                  .map(
                    (p) =>
                      `${GENSAN_LABELS[p.gensan_type]} (1%) を適用中 (${p.start_month ?? "最初から"}〜${p.end_month ?? "無期限"})`,
                  )
                  .join(" / ")}
                — 基本サービスは減算織込み済の合成コード (・虐防/・業未) で集計しています
                (設定: 自事業所管理 → 減算 (体制未整備))。
              </span>
            </div>
          )}

          {/* 集計 warning / 月遅れ合流の案内は一覧の下・合計フッターの「上」に移動した
              (下部 SougouBlock と フッター合計 の間の「注意書き」ブロック)。警告の増減で
              一覧ヘッダーの位置がずれないようにするため。 */}

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
                      <div className="min-w-0 px-1 py-0.5 border-l border-gray-200 text-gray-700 truncate" title={officeName ?? ""}>
                        {officeName ?? ""}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 font-mono text-gray-700">
                        {r.insured_number ?? "—"}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 text-gray-800 flex items-center gap-1 min-w-0">
                        <span className="flex-1 truncate">{r.user_name}</span>
                        {(r.segmentCount ?? 1) > 1 && (
                          <span
                            title={`保険者変更 (転居) によりレセプトを分割しています。この行は ${r.periodFrom ?? "?"}〜${r.periodTo ?? "?"} (保険者 ${r.insurer_number ?? "?"}) の明細書です`}
                            className="shrink-0 rounded bg-purple-100 px-1 py-0.5 text-[10px] font-bold text-purple-700 whitespace-nowrap"
                          >
                            分割{(r.segmentIndex ?? 0) + 1}/{r.segmentCount}
                          </span>
                        )}
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
                        {d.isReSeikyu ? (
                          d.reasons?.kago && (
                            <span
                              className="text-red-600"
                              title={
                                d.kagoInfo?.dougetsu
                                  ? "同月過誤 (申立と同月に再請求)"
                                  : "通常過誤 (過誤決定の翌月以降に再請求)"
                              }
                            >
                              過誤
                            </span>
                          )
                        ) : (
                          <select
                            value={st?.kago ? "過誤" : ""}
                            onChange={(e) => setFlag(r.user_id, "kago", e.target.value === "過誤")}
                            title="過誤 (申立日・事由コードの登録と取下げは行選択 → 右ペインの過誤申立ブロックで)"
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

              {/* ── 総合事業ブロック (71R1/様式第二の三)。介護給付と混ぜず別枠で表示 ── */}
              <SougouBlock rows={filteredSougouRows} />

              {/* ── 注意書き (集計 warning / 月遅れ合流): 一覧の下・合計フッターの「上」に
                  配置する。一覧 (flex-1) より下なので警告の増減で一覧ヘッダーはずれない ── */}
              {(warnings.length > 0 || reWarnings.length > 0) && (() => {
                const allWarnings = [...new Set([...warnings, ...reWarnings])];
                return (
                  <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
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

              {reRows.length > 0 && (() => {
                const kagoCount = reRows.filter((r) => r.__reasons.kago).length;
                return (
                  <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span>
                      過去月の月遅れ・返戻・過誤 {reRows.length} 件を当月請求に合流しています
                      (元提供月で明細書・伝送に反映)。国保対象化すると一覧から外れます。
                      {kagoCount > 0 && (
                        <>
                          {" "}
                          うち過誤 {kagoCount} 件は
                          <strong>支払済レセプトの取下げ後の再請求</strong>です —
                          返戻と異なり、通常過誤は保険者の過誤決定 (支払控除)
                          を確認してから国保対象化してください (同月過誤は申立と同月に再請求)。
                        </>
                      )}
                    </span>
                  </div>
                );
              })()}

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

        {/* ── 右：明細情報 (ほのぼの流: 青系帯 + 高密度明細 + ラベル箱/値箱 grid)。
            幅は障害請求ペイン (w-96) に合わせる ── */}
        <div className="w-96 shrink-0 flex flex-col bg-white">
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

              {/* ── 過誤申立 (支払済レセプトの取下げ → 再請求) ── */}
              {selectedDisplay && (() => {
                const d = selectedDisplay;
                const st = d.isReSeikyu ? undefined : statusByClient.get(d.row.user_id);
                const kagoFlag = d.isReSeikyu ? !!d.reasons?.kago : !!st?.kago;
                const info: KagoInfo | null = d.isReSeikyu
                  ? d.kagoInfo
                  : st
                    ? {
                        moushitateDate: st.kago_moushitate_date ?? null,
                        jiyuCode: st.kago_jiyu_code ?? null,
                        dougetsu: !!st.kago_dougetsu,
                      }
                    : null;
                return (
                  <KagoBlock
                    // 保存/月移動で状態が変わったらフォームを初期化し直す
                    key={`kago:${d.key}:${kagoFlag}:${info?.moushitateDate ?? ""}:${info?.jiyuCode ?? ""}:${info?.dougetsu ? 1 : 0}`}
                    targetMonth={d.origMonthKey}
                    kago={kagoFlag}
                    kagoInfo={info}
                    kokuhoTarget={!!st?.kokuho_target}
                    colsMissing={kagoColsMissing}
                    readOnly={d.isReSeikyu}
                    onSave={(f) => saveKago(d.row.user_id, f)}
                    onClear={() => clearKago(d.row.user_id)}
                  />
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
                  {selected.kohi2Amount != null && (
                    <>
                      {/* 複数公費の併用 (保険 → 公費1 → 公費2 → 本人 のカスケード) */}
                      <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">公費2単位数</div>
                      <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                        {(selected.kohi2Units ?? 0).toLocaleString()}
                      </div>
                      <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">公費2請求額</div>
                      <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                        {selected.kohi2Amount.toLocaleString()}
                      </div>
                    </>
                  )}
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
                      : selected.kohi2Hobetsu
                        ? ` (複数公費の併用: 保険 → 公費1 ${(selected.kohiAmount ?? 0).toLocaleString()}円 → 公費2 ${(selected.kohi2Amount ?? 0).toLocaleString()}円 → 本人 ${selected.userAmount.toLocaleString()}円 のカスケード)`
                        : selected.kohiHobetsu && selected.kohiHobetsu !== "12"
                          ? ` (保険優先公費: 本人負担 ${(selected.kohiHonninFutan ?? 0).toLocaleString()}円 = 上限月額適用 / 残りを公費請求)`
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

      {/* ===== 同一建物減算チェック (モーダル) ===== */}
      {sameBuildingOpen && officeId && (
        <SameBuildingCheckPanel
          officeId={officeId}
          year={year}
          month={month}
          monthUserIds={sameBuildingUserIds}
          onClose={() => setSameBuildingOpen(false)}
        />
      )}

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
//    介護給付 (7131) とは別様式 (明細書 71R1/様式第二の三、請求書 7113) なので、介護保険分と混ぜず別枠で表示する。
//    折りたたみトグル。行なしのときは何も出さない。
function SougouBlock({ rows }: { rows: UserSeikyuRow[] }) {
  const [open, setOpen] = useState(true);
  if (rows.length === 0) return null;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);
  // 限度額超過の全額自費 (aggregate-sougou.ts で保険請求から分離済。利用請求に加算)
  const totalSelfPay = rows.reduce((s, r) => s + r.selfPayAmount, 0);
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
          — 介護給付とは別様式 (国保連 71R1/7113) で伝送します
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
                      {r.overUnits > 0 && (
                        <span
                          className="ml-1 inline-block rounded bg-red-100 px-1 py-px text-[10px] font-semibold text-red-700"
                          title={`限度額 (${(r.limitUnits ?? 0).toLocaleString()} 単位) を超過。超過分 ${r.overUnits.toLocaleString()} 単位は保険請求・法定負担に含めず、${r.selfPayAmount.toLocaleString()} 円 (10割) を超過自費として利用請求に加算します`}
                        >
                          限度額超過 {r.overUnits.toLocaleString()}単位
                        </span>
                      )}
                      {(r as UserSeikyuRow & { jushoTokurei?: boolean }).jushoTokurei && (
                        <span
                          className="ml-1 inline-block rounded bg-amber-100 px-1 py-px text-[10px] font-semibold text-amber-700"
                          title="住所地特例対象者 — 伝送 (71R1) の明細は種別14 (明細情報(住所地特例)) で出力します (施設所在保険者番号 未設定時は種別02)"
                        >
                          住所地特例
                        </span>
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
        {totalSelfPay > 0 && (
          <span className="text-red-700">超過自費 <strong className="font-mono">¥{totalSelfPay.toLocaleString()}</strong></span>
        )}
        <span className="ml-auto text-emerald-600">伝送ファイル (71R1/7113) は「国保請求」タブから出力</span>
      </div>
    </div>
  );
}
