"use client";

/**
 * 介護請求 (居宅介護支援) — 利用者ごとの月次請求管理
 * (見た目: billing-visit/kaigo-seikyu = ほのぼの NEXT の実画面に準拠)
 *
 * 左: あかさたな索引 / 中央: ツールバー + 高密度グリッドテーブル + 合計フッタ /
 * 右: 明細情報ペイン (行クリックで表示)。
 *
 * 機能:
 *   - 行チェック + 状態表示 (未発行 / 発行済 / 国保対象 / 再請求)
 *   - 月遅 / 返戻 / 過誤 フラグ (kaigo_billing_status に upsert)
 *   - 明細書 (様式第七) / 請求書 (様式第一) の印刷 (billing/forms のコンポーネント再利用)
 *   - 過去月の月遅れ/返戻 (未・国保対象) を元提供月のレセプトで当月一覧に合流 (再請求行)
 *   - レセプト自体の生成・加算編集は既存 /billing/claims へリンク
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  FileText,
  Printer,
  Landmark,
  Download,
  SquarePen,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  useKyotakuSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
  loadKyotakuReSeikyuRows,
  parseKyufuKanriKubun,
  setKyufuKanriKubunMarker,
  KYUFU_KANRI_KUBUN_LABELS,
  type KyufuKanriKubun,
  type KyotakuSeikyuRow,
  type KyotakuReSeikyuRow,
} from "./_seikyu-context";
import { MeisaiForm } from "../forms/_meisai";
import {
  SeikyuForm,
  type SeikyuKohiRow,
  type SeikyuKohiTandoku,
} from "../forms/_seikyu";
import type { ClaimStatus } from "../claims/claims-shared";
import { monthRange } from "@/lib/cert-for-month";
import {
  getHospitalizationMap,
  hospitalizationsInRange,
  type HospitalizationPeriod,
} from "@/lib/hospitalization";

// ほのぼの実画面の列順 (居宅版):
// 対象 / 申請中 / 状態 / 提供月 / 請求月 / サービス事業所 / 被保険者番号 / 利用者名 /
// 単位数 / 金額 / レセプト / 月遅 / 返戻 / 過誤
const GRID_COLS =
  "grid grid-cols-[26px_44px_60px_54px_54px_minmax(100px,0.8fr)_84px_minmax(140px,1.1fr)_64px_76px_52px_44px_44px_44px]";

// 和暦月表示 「R 8/ 5」 (ほのぼの流。1 桁は空白 pad、font-mono 前提)
const reiwaMonth = (y: number, m: number) =>
  `R${String(y - 2018).padStart(2, " ")}/${String(m).padStart(2, " ")}`;

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "未確定",
  confirmed: "確定済",
  submitted: "請求済",
};

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

// kaigo_benefit_management の 1 行 (下段: 給付管理票一覧用)
interface BenefitDbRow {
  user_id: string;
  service_type: string;
  provider_name: string | null;
  planned_units: number | null;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)
interface DisplayRow {
  /** 一意キー (利用者 × 提供月)。当月="cur:<id>" / 再請求="re:<id>:<origMonthKey>" */
  key: string;
  row: KyotakuSeikyuRow;
  /** この行の提供月 (YYYY-MM)。当月行は当月、再請求行は元提供月 */
  origMonthKey: string;
  isReSeikyu: boolean;
  /** 再請求理由 (月遅れ/返戻)。当月通常行は null */
  reasons: { tsukiokure: boolean; henrei: boolean } | null;
  /** 再請求行の元提供月 kaigo_billing_status.notes (当月行は statusByClient から読む) */
  statusNotes: string | null;
}

export function KyotakuKaigoSeikyuContent() {
  const {
    year, month, monthKey, rows, filteredRows, kanaMatches, loading, error,
    officeName, officeNumber, officeAddress, officePhone, officePostal,
    officeId, tenantId,
  } = useKyotakuSeikyuContext();
  const supabase = useMemo(() => createClient(), []);

  // 選択・チェックは (利用者 × 提供月) 単位 (再請求で同一利用者が二重に並ぶため)
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [printMode, setPrintMode] = useState<"meisai" | "seikyu" | null>(null);
  // 行内「明細書」ボタン用: 印刷対象を明示指定するとき (null = targetDisplayRows)
  const [meisaiPrintRows, setMeisaiPrintRows] = useState<DisplayRow[] | null>(null);
  // 月遅れ/返戻の再請求行 (元提供月のレセプトを読み直したもの)
  const [reRows, setReRows] = useState<KyotakuReSeikyuRow[]>([]);

  // ── 表示用の統合行 (当月通常行 + 再請求行)。カナ索引で共通絞込 ──
  const displayRows = useMemo<DisplayRow[]>(() => {
    const cur: DisplayRow[] = filteredRows.map((r) => ({
      key: `cur:${r.user_id}`,
      row: r,
      origMonthKey: monthKey,
      isReSeikyu: false,
      reasons: null,
      statusNotes: null,
    }));
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
      statusNotes: r.__statusNotes,
    }));
    // 再請求 (過去分) を上、当月を下に並べる
    return [...re, ...cur];
  }, [filteredRows, reRows, kanaMatches, monthKey]);

  const selectedDisplay = displayRows.find((d) => d.key === selectedKey) ?? null;
  const selected = selectedDisplay?.row ?? null;

  // 合計は当月の通常行のみ (再請求分は元提供月の別集計なので当月合計には含めない)
  const totalUnits = filteredRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalAmount = filteredRows.reduce((s, r) => s + r.insuranceAmount, 0);
  const kokuhoRows = filteredRows.filter(
    (r) => statusByClient.get(r.user_id)?.kokuho_target,
  );
  const kokuhoCount = kokuhoRows.length;
  const kokuhoUnits = kokuhoRows.reduce((s, r) => s + r.totalUnits, 0);

  // ── 月遅れ/返戻の再請求行を読み込む ──
  const loadReRows = useCallback(async () => {
    if (!officeId || !tenantId) {
      setReRows([]);
      return;
    }
    try {
      const list = await loadKyotakuReSeikyuRows(supabase, monthKey, officeId);
      setReRows(list);
    } catch (e) {
      toast.error(
        "再請求分の読込に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
      setReRows([]);
    }
  }, [supabase, officeId, tenantId, monthKey]);

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
      // table 未作成 (42P01) / PostgREST schema cache 未反映 (PGRST205) 時は状態なしとして続行
      if (e.code !== "42P01" && e.code !== "PGRST205") {
        toast.error("請求状態の取得に失敗: " + e.message);
      }
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

  // ── 下段: 給付管理票 (kaigo_benefit_management) ──────────────────────────
  const [benefitRows, setBenefitRows] = useState<BenefitDbRow[]>([]);
  const [benefitChecked, setBenefitChecked] = useState<Set<string>>(new Set());
  const loadBenefits = useCallback(async () => {
    const PAGE = 1000;
    const acc: BenefitDbRow[] = [];
    let from = 0;
    while (true) {
      const { data, error: e } = await supabase
        .from("kaigo_benefit_management")
        .select("user_id, service_type, provider_name, planned_units")
        .eq("billing_month", monthKey)
        .order("user_id", { ascending: true })
        .order("service_type", { ascending: true })
        .range(from, from + PAGE - 1);
      if (e) {
        toast.error("給付管理データの取得に失敗: " + e.message);
        setBenefitRows([]);
        return;
      }
      if (!data || data.length === 0) break;
      acc.push(...(data as BenefitDbRow[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    setBenefitRows(acc);
    setBenefitChecked(new Set());
  }, [supabase, monthKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadBenefits();
  }, [loadBenefits]);

  // 給付管理票を利用者単位に集約 (レセプト行と突合して氏名等を補完)
  const benefitGroups = useMemo(() => {
    const rowByUser = new Map(filteredRows.map((r) => [r.user_id, r]));
    const byUser = new Map<string, BenefitDbRow[]>();
    for (const b of benefitRows) {
      if (!byUser.has(b.user_id)) byUser.set(b.user_id, []);
      byUser.get(b.user_id)!.push(b);
    }
    return Array.from(byUser.entries())
      .map(([userId, list]) => {
        const seikyuRow = rowByUser.get(userId) ?? null;
        return {
          userId,
          seikyuRow,
          providers: [...new Set(list.map((b) => b.provider_name).filter(Boolean))] as string[],
          totalPlanned: list.reduce((s, b) => s + (b.planned_units ?? 0), 0),
          lineCount: list.length,
        };
      })
      // カナフィルタはレセプト行が突合できた利用者にのみ適用
      .filter((g) => !g.seikyuRow || kanaMatches(g.seikyuRow))
      .sort((a, b) =>
        (a.seikyuRow?.user_name_kana ?? a.seikyuRow?.user_name ?? a.userId).localeCompare(
          b.seikyuRow?.user_name_kana ?? b.seikyuRow?.user_name ?? b.userId,
          "ja",
        ),
      );
  }, [benefitRows, filteredRows, kanaMatches]);
  const benefitKokuhoCount = benefitGroups.filter(
    (g) => statusByClient.get(g.userId)?.kokuho_target,
  ).length;

  // ── 給付管理票 作成区分 (8221 項5: 新規/修正/取消) — notes マーカーで永続化 ──
  const setKyufuKubun = async (clientId: string, kubun: KyufuKanriKubun) => {
    if (!officeId) {
      toast.error("自事業所が未確定のため作成区分を保存できません");
      return;
    }
    const cur = statusByClient.get(clientId);
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(
        {
          client_id: clientId,
          target_month: monthKey,
          tenant_id: tenantId ?? "kt-group",
          office_id: officeId,
          tsukiokure: cur?.tsukiokure ?? false,
          henrei: cur?.henrei ?? false,
          kago: cur?.kago ?? false,
          notes: setKyufuKanriKubunMarker(cur?.notes, kubun),
        },
        { onConflict: "client_id,target_month,office_id" },
      );
    if (e) {
      toast.error("作成区分の保存に失敗: " + e.message);
      return;
    }
    loadStatus();
  };

  // 給付管理票側のチェック → 国保対象化 (4b の作成区分と連動して 8221 に反映)
  const markBenefitKokuho = async () => {
    if (!officeId) {
      toast.error("自事業所が未確定のため国保対象化できません");
      return;
    }
    const targets = benefitGroups.filter(
      (g) => benefitChecked.size === 0 || benefitChecked.has(g.userId),
    );
    if (targets.length === 0) return;
    const now = new Date().toISOString();
    const payload = targets.map((g) => {
      const cur = statusByClient.get(g.userId);
      return {
        client_id: g.userId,
        target_month: monthKey,
        tenant_id: tenantId ?? "kt-group",
        office_id: officeId,
        issued_at: cur?.issued_at ?? now,
        kokuho_target: true,
        tsukiokure: cur?.tsukiokure ?? false,
        henrei: cur?.henrei ?? false,
        kago: cur?.kago ?? false,
        notes: cur?.notes ?? null,
      };
    });
    const { error: e } = await supabase
      .from("kaigo_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month,office_id" });
    if (e) {
      toast.error("国保対象の保存に失敗: " + e.message);
      return;
    }
    toast.success(`給付管理票 ${payload.length} 件を国保対象にしました`);
    setBenefitChecked(new Set());
    loadStatus();
  };

  // ── 集計エラーバナー (認定切れ/認定なし/単位0/加算矛盾) ──────────────────
  const [hospMap, setHospMap] = useState<Map<string, HospitalizationPeriod[]>>(new Map());
  useEffect(() => {
    if (loading || rows.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の初期化
      setHospMap(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const map = await getHospitalizationMap(
          supabase,
          rows.map((r) => r.user_id),
        );
        if (!cancelled) setHospMap(map);
      } catch (e) {
        console.error("入退院情報の取得に失敗:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, rows, loading]);

  const [checkOpen, setCheckOpen] = useState(false);
  const checkIssues = useMemo(() => {
    const issues: { user: string; kind: string; detail: string }[] = [];
    const { from: mFrom, to: mTo } = monthRange(year, month);
    for (const r of rows) {
      if (r.yoboShienKubun === "itaku") continue;
      // 認定なし
      if (!r.care_level || !r.insured_number) {
        issues.push({
          user: r.user_name,
          kind: "認定なし",
          detail: !r.care_level ? "要介護度が未登録です" : "被保険者番号が未登録です",
        });
      } else {
        // 認定切れ (認定有効期間が対象月に掛からない)
        const certOk =
          (!r.certStart || r.certStart <= mTo) && (!r.certEnd || r.certEnd >= mFrom);
        if (!certOk) {
          issues.push({
            user: r.user_name,
            kind: "認定切れ",
            detail: `認定有効期間 ${r.certStart ?? "?"}〜${r.certEnd ?? "?"} が対象月外です`,
          });
        }
      }
      // 単位0
      if (r.totalUnits <= 0) {
        issues.push({ user: r.user_name, kind: "単位0", detail: "総単位数が 0 以下です" });
      }
      // 加算矛盾 (退院退所/入院時情報連携があるが対象月に入院記録なし)
      const hasHospAddon = r.lines.some(
        (l) => l.name.includes("退院・退所") || l.name.includes("入院時情報連携"),
      );
      if (hasHospAddon) {
        const overlaps = hospitalizationsInRange(hospMap.get(r.user_id), mFrom, mTo);
        if (overlaps.length === 0) {
          issues.push({
            user: r.user_name,
            kind: "加算矛盾",
            detail: "退院退所/入院時情報連携加算がありますが対象月に入院記録がありません",
          });
        }
      }
    }
    return issues;
  }, [rows, hospMap, year, month]);

  // ── フラグ (月遅れ/返戻/過誤) の upsert ──
  const setFlag = async (
    clientId: string,
    field: "tsukiokure" | "henrei" | "kago",
    value: boolean,
  ) => {
    if (!officeId) {
      toast.error("自事業所が未確定のためフラグを保存できません");
      return;
    }
    const cur = statusByClient.get(clientId);
    const payload: Record<string, unknown> = {
      client_id: clientId,
      target_month: monthKey,
      tenant_id: tenantId ?? "kt-group",
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

  // 請求書 (様式第一) は当月の通常行のみを対象とする
  // (再請求分は元提供月の別請求書になるため、当月総括には含めない)
  const seikyuTargets = useMemo(
    () => targetDisplayRows.filter((d) => !d.isReSeikyu).map((d) => d.row),
    [targetDisplayRows],
  );
  // 公費単独 (H番号 = みなし2号) は保険請求欄に載せず公費請求欄へ (billing-forms-content と同じ)
  const hokenTargets = useMemo(
    () => seikyuTargets.filter((r) => !r.kohiTandoku),
    [seikyuTargets],
  );
  const tandokuTargets = useMemo(
    () => seikyuTargets.filter((r) => r.kohiTandoku),
    [seikyuTargets],
  );
  const targetUnits = hokenTargets.reduce((s, r) => s + r.totalUnits, 0);
  const targetCost = hokenTargets.reduce((s, r) => s + r.totalAmount, 0);
  const targetInsurance = hokenTargets.reduce((s, r) => s + r.insuranceAmount, 0);

  // 公費併用分 (10割給付なので振替 0 円だが件数・単位数を公費請求欄に再掲)
  const seikyuKohiRows = useMemo(() => {
    const byHobetsu = new Map<string, SeikyuKohiRow>();
    for (const r of hokenTargets) {
      if (!r.kohiHobetsu) continue;
      const code = r.kohiHobetsu;
      const cur = byHobetsu.get(code) ?? { code, count: 0, units: 0, cost: 0, kohi: 0 };
      cur.count += 1;
      cur.units += r.totalUnits;
      cur.cost += r.totalAmount;
      cur.kohi += Math.max(0, r.totalAmount - r.insuranceAmount);
      byHobetsu.set(code, cur);
    }
    return Array.from(byHobetsu.values());
  }, [hokenTargets]);
  const seikyuKohiTandoku = useMemo<SeikyuKohiTandoku | undefined>(
    () =>
      tandokuTargets.length > 0
        ? {
            count: tandokuTargets.length,
            units: tandokuTargets.reduce((s, r) => s + r.totalUnits, 0),
            cost: tandokuTargets.reduce((s, r) => s + r.totalAmount, 0),
            kohi: tandokuTargets.reduce((s, r) => s + r.totalAmount, 0),
          }
        : undefined,
    [tandokuTargets],
  );

  // ── 明細書: 対象者の様式第七を印刷 → 印刷実行時に issued_at を now() で upsert (発行済化) ──
  //    再請求行は元提供月 (origMonthKey) に対して upsert する。
  const printMeisaiFor = async (rowsToPrint: DisplayRow[]) => {
    if (rowsToPrint.length === 0) return;
    if (!officeId) {
      toast.error("自事業所が未確定のため発行状態を保存できません");
      return;
    }
    const now = new Date().toISOString();
    // ⚠ 一括 upsert は全 payload のキー集合が揃っていないと PGRST102 になるため
    //   notes まで含めて常に同じキー構成にする
    const payload = rowsToPrint.map((d) => {
      // 当月行のみ既存フラグを引き継ぐ (再請求行は過去月の別レコード)
      const cur = d.isReSeikyu ? undefined : statusByClient.get(d.row.user_id);
      return {
        client_id: d.row.user_id,
        target_month: d.origMonthKey,
        tenant_id: tenantId ?? "kt-group",
        office_id: officeId,
        issued_at: now,
        // 既存フラグを保持 (再請求行は理由フラグを保持)
        kokuho_target: cur?.kokuho_target ?? false,
        tsukiokure: d.reasons?.tsukiokure ?? cur?.tsukiokure ?? false,
        henrei: d.reasons?.henrei ?? cur?.henrei ?? false,
        kago: cur?.kago ?? false,
        notes: d.isReSeikyu ? d.statusNotes ?? null : cur?.notes ?? null,
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
    if (seikyuTargets.length === 0) return;
    setPrintMode("seikyu");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 国保対象: 選択行を kokuho_target=true に upsert ──
  //    当月行は「発行済」のみ (未発行はスキップ)。
  //    再請求行 (月遅れ/返戻) は元提供月に対し kokuho_target=true + notes='再請求' で立てる。
  const markKokuhoTarget = async () => {
    if (!officeId) {
      toast.error("自事業所が未確定のため国保対象化できません");
      return;
    }
    const now = new Date().toISOString();
    // ⚠ PostgREST の一括 upsert は全行のキー集合が一致しないと PGRST102
    //   ("All object keys must match") になるため、notes キーを常に含める
    //   (当月行は既存 notes / kago を読み保持)
    const payload: Record<string, unknown>[] = [];
    let skipped = 0;

    for (const d of targetDisplayRows) {
      if (d.isReSeikyu) {
        const mergedNotes = (() => {
          const base = d.statusNotes ?? "";
          return base.includes("再請求") ? base : base ? `${base}\n再請求` : "再請求";
        })();
        payload.push({
          client_id: d.row.user_id,
          target_month: d.origMonthKey,
          tenant_id: tenantId ?? "kt-group",
          office_id: officeId,
          issued_at: now,
          kokuho_target: true,
          tsukiokure: d.reasons?.tsukiokure ?? false,
          henrei: d.reasons?.henrei ?? false,
          kago: false,
          notes: mergedNotes,
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
          tenant_id: tenantId ?? "kt-group",
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
      "サービスコード",
      "総単位数",
      "保険請求額",
      "レセプト",
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
          r.serviceCode,
          r.totalUnits,
          r.insuranceAmount,
          CLAIM_STATUS_LABELS[r.claimStatus],
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
    a.download = `kyotaku_seikyu_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const allChecked = checked.size === displayRows.length && displayRows.length > 0;
  const meisaiTargets = meisaiPrintRows ?? targetDisplayRows;

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
              title="対象者の介護給付費明細書 (様式第七) を印刷。印刷で発行済になります"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <FileText size={13} />明細書 ({targetDisplayRows.length}件)
            </button>
            <button
              onClick={printSeikyu}
              disabled={seikyuTargets.length === 0}
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
              <Link
                href="/billing/claims"
                title="レセプトの一括生成・加算編集・確定 (既存のレセプト管理画面)"
                className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5"
              >
                <SquarePen size={13} />レセプト編集
              </Link>
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

          {/* ── 集計エラー (内容確認) バナー — ほのぼの集計処理の確認内容の代替 ── */}
          {!loading && checkIssues.length > 0 && (
            <div className="border-b border-amber-300 bg-amber-50 shrink-0 text-xs text-amber-900">
              <button
                type="button"
                onClick={() => setCheckOpen((v) => !v)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-amber-100 transition-colors"
              >
                <AlertTriangle size={14} className="shrink-0 text-amber-600" />
                <span className="font-semibold">内容確認 {checkIssues.length} 件</span>
                <span className="text-amber-700">
                  (認定切れ {checkIssues.filter((i) => i.kind === "認定切れ").length} /
                  認定なし {checkIssues.filter((i) => i.kind === "認定なし").length} /
                  単位0 {checkIssues.filter((i) => i.kind === "単位0").length} /
                  加算矛盾 {checkIssues.filter((i) => i.kind === "加算矛盾").length})
                </span>
                <span className="ml-auto">
                  {checkOpen ? <ChevronDown size={14} /> : <ChevronRightIcon size={14} />}
                </span>
              </button>
              {checkOpen && (
                <ul className="max-h-36 overflow-y-auto border-t border-amber-200 px-3 py-1.5 space-y-0.5">
                  {checkIssues.map((i, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="shrink-0 rounded bg-amber-200 px-1 py-0 text-[10px] font-bold text-amber-900">
                        {i.kind}
                      </span>
                      <span className="font-medium">{i.user}</span>
                      <span className="text-amber-700">{i.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
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
                  <div className="px-1 py-0.5 border-l border-sky-300">単位数</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">金額</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">レセプト</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">月遅</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">返戻</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">過誤</div>
                </div>

                {displayRows.length === 0 ? (
                  <p className="text-gray-400 text-center py-10">
                    対象月のレセプトがありません。「レセプト編集」から一括生成してください。
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
                        <button
                          onClick={(e) => { e.stopPropagation(); printMeisaiFor([d]); }}
                          title="この利用者の明細書 (様式第七) を印刷"
                          className="shrink-0 text-[10px] leading-none border border-gray-300 rounded px-1 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                        >明細書</button>
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-700">
                        {r.totalUnits.toLocaleString()}
                      </div>
                      <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-700">
                        {r.insuranceAmount.toLocaleString()}
                      </div>
                      {/* レセプト状態 (draft は黄字で注意喚起) */}
                      <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                        <span className={r.claimStatus === "draft" ? "text-yellow-600" : "text-gray-600"}>
                          {CLAIM_STATUS_LABELS[r.claimStatus]}
                        </span>
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

              {/* ── 下段: 給付管理票 (kaigo_benefit_management ベース) ── */}
              <div className="border-t-2 border-gray-400 shrink-0 flex flex-col max-h-[38%] min-h-0">
                <div className="bg-gradient-to-b from-emerald-50 to-emerald-100 border-b border-gray-300 px-3 py-1 flex items-center gap-2 text-[11px]">
                  <span className="font-bold text-emerald-900">給付管理票</span>
                  <span className="text-gray-500">{benefitGroups.length} 件</span>
                  <button
                    type="button"
                    onClick={markBenefitKokuho}
                    disabled={benefitGroups.length === 0}
                    title="給付管理票を国保連請求 (8211/8221) の対象にする。作成区分 (新規/修正/取消) は行の選択が伝送に反映されます"
                    className="ml-2 border border-blue-500 rounded bg-blue-100 px-2 py-0.5 text-blue-800 font-semibold hover:bg-blue-200 disabled:opacity-50"
                  >
                    国保対象 ({benefitChecked.size > 0 ? `チェック ${benefitChecked.size} 件` : "全件"})
                  </button>
                  <span className="ml-auto text-gray-400">
                    給付管理データの編集は 請求管理 → 給付管理 (/billing/benefits) から
                  </span>
                </div>
                {/* ヘッダー */}
                <div className="grid grid-cols-[26px_60px_54px_54px_minmax(120px,1fr)_84px_minmax(120px,1fr)_72px_44px_44px_44px_84px] border-b border-gray-300 bg-gradient-to-b from-sky-100 to-sky-200 text-[11px] leading-4 font-medium text-gray-700 text-center">
                  <div className="px-1 py-0.5" />
                  <div className="px-1 py-0.5 border-l border-sky-300">状態</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">提供月</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">請求月</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">サービス事業所</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">被保険者番号</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">利用者名</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">単位数合計</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">月遅</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">返戻</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">過誤</div>
                  <div className="px-1 py-0.5 border-l border-sky-300">再請求区分</div>
                </div>
                <div className="flex-1 overflow-y-auto min-h-0">
                  {benefitGroups.length === 0 ? (
                    <p className="text-gray-400 text-center py-4 text-[11px]">
                      対象月の給付管理データがありません (給付管理画面で一括生成できます)
                    </p>
                  ) : benefitGroups.map((g) => {
                    const st = statusByClient.get(g.userId);
                    const isChecked = benefitChecked.has(g.userId);
                    const kubun: KyufuKanriKubun =
                      parseKyufuKanriKubun(st?.notes) ??
                      (st?.tsukiokure || st?.henrei ? "2" : "1");
                    return (
                      <div
                        key={g.userId}
                        className={`grid grid-cols-[26px_60px_54px_54px_minmax(120px,1fr)_84px_minmax(120px,1fr)_72px_44px_44px_44px_84px] border-b border-gray-200 text-[11px] leading-4 ${isChecked ? "bg-indigo-50" : "bg-white hover:bg-sky-50"}`}
                      >
                        <div className="px-1 py-0.5 flex items-center justify-center">
                          <button
                            onClick={() =>
                              setBenefitChecked((prev) => {
                                const next = new Set(prev);
                                if (next.has(g.userId)) next.delete(g.userId);
                                else next.add(g.userId);
                                return next;
                              })
                            }
                            className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-all ${isChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"}`}
                          >
                            {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                          </button>
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200">
                          {st?.kokuho_target ? (
                            <span className="text-red-600">国保対象</span>
                          ) : st?.issued_at ? (
                            <span className="text-emerald-700">発行済</span>
                          ) : (
                            <span className="text-gray-600">未発行</span>
                          )}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700">
                          {reiwaMonth(year, month)}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700">
                          {reiwaMonth(year, month)}
                        </div>
                        <div
                          className="px-1 py-0.5 border-l border-gray-200 text-gray-700 truncate"
                          title={g.providers.join("、")}
                        >
                          {g.providers.join("、") || "—"}
                          {g.lineCount > 1 && (
                            <span className="text-gray-400"> ({g.lineCount}行)</span>
                          )}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 font-mono text-gray-700">
                          {g.seikyuRow?.insured_number ?? "—"}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 text-gray-800 truncate">
                          {g.seikyuRow?.user_name ?? "(レセプト未生成)"}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-700">
                          {g.totalPlanned.toLocaleString()}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                          {st?.tsukiokure && <span className="text-red-600">月遅</span>}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                          {st?.henrei && <span className="text-red-600">返戻</span>}
                        </div>
                        <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                          {st?.kago && <span className="text-red-600">過誤</span>}
                        </div>
                        <div className="px-0.5 py-0.5 border-l border-gray-200 text-center">
                          <select
                            value={kubun}
                            onChange={(e) => setKyufuKubun(g.userId, e.target.value as KyufuKanriKubun)}
                            title="給付管理票情報作成区分 (8221 項5)。伝送ファイル出力に反映されます"
                            className={`w-full text-[11px] leading-4 border border-gray-300 px-0 py-0 bg-white ${kubun !== "1" ? "text-red-600" : "text-gray-600"}`}
                          >
                            {(Object.keys(KYUFU_KANRI_KUBUN_LABELS) as KyufuKanriKubun[]).map((k) => (
                              <option key={k} value={k}>
                                {KYUFU_KANRI_KUBUN_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* 給付管理票フッタ */}
                <div className="border-t border-gray-300 bg-gray-50 px-3 py-1 shrink-0 text-[11px] text-gray-700 flex items-center gap-4">
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">合計件数</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[56px] text-right font-mono">{benefitGroups.length.toLocaleString()}</span>
                  </span>
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">国保件数</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[56px] text-right font-mono">{benefitKokuhoCount.toLocaleString()}</span>
                  </span>
                </div>
              </div>

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
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">保険請求額</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[96px] text-right font-mono">{totalAmount.toLocaleString()}</span>
                  </span>
                  <span className="ml-auto text-gray-500">
                    {reRows.length > 0 && <>再請求 {reRows.length.toLocaleString()} 件</>}
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
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-12">単位数</th>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-8">回数</th>
                      <th className="text-center px-1 py-0.5 font-medium text-gray-700 w-16">摘要</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.lines.map((dt, i) => (
                      <tr key={`${dt.code}-${i}`} className="border-b border-gray-200 bg-white">
                        <td className="px-1 py-0.5 text-gray-700 leading-tight border-r border-gray-200">
                          {dt.name}
                        </td>
                        <td className={`px-1 py-0.5 text-right font-mono border-r border-gray-200 ${dt.units < 0 ? "text-red-600" : "text-gray-800"}`}>
                          {dt.units.toLocaleString()}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200">
                          {dt.count}
                        </td>
                        <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono truncate" title={dt.code}>
                          {dt.code}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* 右下: ラベル箱 + 値箱 のペア grid (ほのぼの流) */}
              <div className="border-t border-gray-400 bg-gray-100 shrink-0 p-1.5">
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-px bg-gray-400 border border-gray-400 text-[11px] leading-4">
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">保険単位数</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.totalUnits.toLocaleString()}</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">単位数単価</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.unitPrice.toFixed(2)}</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">費用合計</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.totalAmount.toLocaleString()}</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">保険請求額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.insuranceAmount.toLocaleString()}</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">利用者負担額</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">0</div>
                  <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">レセプト状態</div>
                  <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{CLAIM_STATUS_LABELS[selected.claimStatus]}</div>
                </div>
                <p className="px-0.5 pt-1 text-[10px] text-gray-500">
                  居宅介護支援費は 10 割給付 (利用者負担なし)。加算・減算の編集は「レセプト編集」から。
                </p>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
              行を選択してください
            </div>
          )}
        </div>
      </div>

      {/* ===== 印刷 view: 明細書 (様式第七) — 利用者 1 名 = 1 枚 ===== */}
      {/* 再請求行は元提供月 (origMonthKey) の billingMonth で出す */}
      {printMode === "meisai" && (
        <div className="hidden print:block">
          <style>{`@media print { @page { size: A4 portrait; margin: 8mm; } }`}</style>
          {meisaiTargets.map((d, i) => (
            <div
              key={d.key}
              style={{ pageBreakAfter: i < meisaiTargets.length - 1 ? "always" : "auto" }}
            >
              <MeisaiForm
                providerNumber={officeNumber ?? ""}
                officeName={officeName ?? ""}
                officeAddress={officeAddress ?? ""}
                officePhone={officePhone ?? ""}
                postalCode={officePostal ?? ""}
                insurerNumber={d.row.insurer_number ?? ""}
                unitPrice={d.row.unitPrice}
                billingMonth={d.origMonthKey}
                person1={{
                  insuredNumber: d.row.insured_number ?? "",
                  userName: d.row.user_name,
                  userKana: d.row.user_name_kana ?? "",
                  birthDate: d.row.birth_date ?? "",
                  gender: d.row.gender ?? "",
                  careLevel: d.row.care_level ?? "",
                  certStart: d.row.certStart ?? "",
                  certEnd: d.row.certEnd ?? "",
                  lines: d.row.lines.map((l) => ({
                    ...l,
                    serviceUnits: l.units * l.count,
                  })),
                  totalServiceUnits: d.row.totalUnits,
                  // 公費単独 (H番号) は保険請求 0 円・全額 (10割) を公費請求
                  claimAmount: d.row.kohiTandoku
                    ? d.row.totalAmount
                    : d.row.insuranceAmount,
                  kohiFutanshaNumber: d.row.kohiFutansha,
                  kohiJukyushaNumber: d.row.kohiJukyusha,
                  kohiTandoku: d.row.kohiTandoku,
                  hasKohi: d.row.kohiTandoku || !!d.row.kohiHobetsu,
                }}
                person2={null}
              />
            </div>
          ))}
        </div>
      )}

      {/* ===== 印刷 view: 請求書 (様式第一) — 事業所単位の総括 1 枚 ===== */}
      {/* 総括は当月の通常分のみ (再請求は元提供月の別請求書扱い) */}
      {printMode === "seikyu" && (
        <div className="hidden print:block">
          <style>{`@media print { @page { size: A4 portrait; margin: 8mm; } }`}</style>
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
            userCopay={0}
            kohiSeg="kyotaku"
            kohiRows={seikyuKohiRows}
            kohiRequestAmount={seikyuKohiRows.reduce((s, k) => s + k.kohi, 0)}
            kohiTandoku={seikyuKohiTandoku}
          />
        </div>
      )}
    </>
  );
}
