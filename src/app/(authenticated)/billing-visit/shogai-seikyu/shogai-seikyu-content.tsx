"use client";

/**
 * 障害請求 — 障害福祉サービスの月次請求集計 + 国保連 CSV (ほのぼのMORE の請求フロー準拠)
 *
 * 左: 利用者一覧 (対象 / 状態 / 受給者証番号 / 名前 / 区分 / 入金 / 総単位数 / 給付費請求額 / 負担額)
 * 右: 明細 (サービス種類 / コード / 単位数 / 回数) + 上限額管理 + 入金管理
 * 出力: 明細書 (様式第二相当) / 請求書 (様式第一相当 総括) / 利用料請求書 /
 *       国保連請求 CSV / 伝送ファイル (J11 / J61 / J41)
 *
 * 状態管理 (介護請求 kaigo-seikyu と同じ作り):
 *   未発行 → (明細書印刷で issued_at=now() upsert) → 発行済
 *   → (伝送対象ボタンで densou_target=true) → 伝送対象
 *   shogai_billing_status (client_id × target_month UNIQUE) に upsert
 * 入金管理 (利用請求 riyou-seikyu と同じ作り):
 *   shogai_seikyu_payments (client_id × target_month UNIQUE) に upsert
 */

import { useMemo, useState, useEffect, useCallback } from "react";
import {
  Loader2,
  AlertCircle,
  Download,
  FileDown,
  FileText,
  Printer,
  Receipt,
  Send,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import { MonthNav } from "../_shared/month-nav";
import {
  aggregateMonthlyShogaiSeikyu,
  buildShogaiSeikyuCsv,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";
import {
  buildShogaiDensou,
  type ShogaiDensouUser,
  type ShogaiDensouVisit,
  type ShogaiDensouKanriLine,
} from "@/lib/shogai-densou/build";
import {
  ShogaiMeisaiPrintSheet,
  ShogaiSeikyushoPrintSheet,
  ShogaiRiyouSeikyuPrintSheet,
  ShogaiJissekiKirokuhyoPrintSheet,
  type ShogaiSeikyuSummaryGroup,
} from "../../billing/forms/_shogai-meisai";

// table 未作成 (migration 未適用): 42P01 = SQL / PGRST205 = PostgREST schema cache
const isMissingTable = (code: string | undefined) =>
  code === "42P01" || code === "PGRST205";

// ── 介護請求 (kaigo-seikyu) と同じ高密度グリッド。障害の列にマッピング ──
// 対象 / 状態 / 提供月 / 請求月 / サービス事業所 / 受給者証番号 / 利用者名 / 区分 / 入金 / 総単位数 / 給付費請求額 / 利用者負担
const GRID_COLS =
  "grid grid-cols-[26px_60px_54px_54px_minmax(100px,0.8fr)_84px_minmax(120px,1fr)_48px_56px_72px_84px_78px]";

// 和暦月表示 「R 8/ 5」 (ほのぼの流。1 桁は空白 pad、font-mono 前提)
const reiwaMonth = (y: number, m: number) =>
  `R${String(y - 2018).padStart(2, " ")}/${String(m).padStart(2, " ")}`;

// ── かな行フィルター (介護請求の SeikyuKanaSidebar と同じ判定 map) ──
// shogai は SeikyuProvider を使わず local state で回すため、ここに自前で持つ
const SHOGAI_KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "他"];
const SHOGAI_KANA_MAP: Record<string, string[]> = {
  "あ": ["ア", "イ", "ウ", "エ", "オ"],
  "か": ["カ", "キ", "ク", "ケ", "コ", "ガ", "ギ", "グ", "ゲ", "ゴ"],
  "さ": ["サ", "シ", "ス", "セ", "ソ", "ザ", "ジ", "ズ", "ゼ", "ゾ"],
  "た": ["タ", "チ", "ツ", "テ", "ト", "ダ", "ヂ", "ヅ", "デ", "ド"],
  "な": ["ナ", "ニ", "ヌ", "ネ", "ノ"],
  "は": ["ハ", "ヒ", "フ", "ヘ", "ホ", "バ", "ビ", "ブ", "ベ", "ボ", "パ", "ピ", "プ", "ペ", "ポ"],
  "ま": ["マ", "ミ", "ム", "メ", "モ"],
  "や": ["ヤ", "ユ", "ヨ"],
  "ら": ["ラ", "リ", "ル", "レ", "ロ"],
  "わ": ["ワ", "ヲ", "ン"],
};
const SHOGAI_ALL_KANA = Object.values(SHOGAI_KANA_MAP).flat();
const shogaiToKana = (s: string) =>
  s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// shogai_billing_status の 1 行 (利用者 × 月) — 状態: 未発行 / 発行済 / 伝送対象
interface ShogaiBillingStatusRow {
  client_id: string;
  issued_at: string | null;
  densou_target: boolean;
  notes: string | null;
}

// shogai_seikyu_payments の 1 行 (利用者 × 月) — 利用料請求の入金管理
interface ShogaiPaymentRow {
  client_id: string;
  billed_amount: number;
  paid_amount: number;
  paid_date: string | null;
  payment_method: string | null;
  status: "請求済" | "入金完" | "一部入金" | "未収";
  issued_date: string | null;
}

// 入金状態バッジ (riyou-seikyu の PAYMENT_STATUS_CLS と同じ配色ルール)
const PAYMENT_STATUS_CLS: Record<string, string> = {
  請求済: "bg-blue-100 text-blue-700",
  入金完: "bg-emerald-100 text-emerald-700",
  一部入金: "bg-amber-100 text-amber-700",
  未収: "bg-red-100 text-red-700",
};

export function ShogaiSeikyuContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<ShogaiSeikyuRow[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 集計時の注意事項 (月途中の市町村変更 等)。集計値には影響しない
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [officeNumber, setOfficeNumber] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // かな行フィルタ (介護請求の左サイドバーと同じ。null = 全)
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [statusByClient, setStatusByClient] = useState<
    Map<string, ShogaiBillingStatusRow>
  >(new Map());
  const [payments, setPayments] = useState<Map<string, ShogaiPaymentRow>>(new Map());
  const [printMode, setPrintMode] = useState<
    "meisai" | "seikyu" | "riyou" | "jisseki" | null
  >(null);
  // 実績記録票 印刷用の月内提供実績 (client_id → visits)
  const [jissekiVisits, setJissekiVisits] = useState<
    Map<string, ShogaiDensouVisit[]>
  >(new Map());
  const [jissekiLoading, setJissekiLoading] = useState(false);

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let unitPrice: number | undefined;
      if (currentOffice) {
        const { data: o, error: oe } = await supabase
          .from("offices")
          .select("unit_price, business_number")
          .eq("id", currentOffice.id)
          .maybeSingle();
        if (oe) throw new Error("事業所情報の取得に失敗: " + oe.message);
        const od = o as {
          unit_price?: number;
          business_number?: string | null;
        } | null;
        unitPrice = od?.unit_price;
        setOfficeNumber(((od?.business_number ?? "") as string).trim() || null);
      }
      const result = await aggregateMonthlyShogaiSeikyu(supabase, {
        year,
        month,
        unitPrice,
        officeId: currentOffice?.id ?? null,
      });
      setRows(result.rows);
      setRecordCount(result.recordCount);
      setWarnings(result.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOffice, year, month]);

  useEffect(() => {
    if (btLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    load();
  }, [btLoading, load]);

  // ── shogai_billing_status (発行/伝送状態) を月で読み client_id で突合 ──
  const loadStatus = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("shogai_billing_status")
      .select("client_id, issued_at, densou_target, notes")
      .eq("target_month", monthStr);
    if (e) {
      // table 未作成 (migration 未適用) 時は状態なしとして続行
      if (!isMissingTable(e.code)) toast.error("請求状態の取得に失敗: " + e.message);
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(
        ((data ?? []) as ShogaiBillingStatusRow[]).map((r) => [r.client_id, r]),
      ),
    );
  }, [supabase, monthStr]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadStatus();
  }, [loadStatus]);

  // ── shogai_seikyu_payments (利用料請求の入金状況) を月で読み client_id で突合 ──
  const loadPayments = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("shogai_seikyu_payments")
      .select(
        "client_id, billed_amount, paid_amount, paid_date, payment_method, status, issued_date",
      )
      .eq("target_month", monthStr);
    if (e) {
      if (!isMissingTable(e.code)) toast.error("入金状況の取得に失敗: " + e.message);
      setPayments(new Map());
      return;
    }
    setPayments(
      new Map(((data ?? []) as ShogaiPaymentRow[]).map((p) => [p.client_id, p])),
    );
  }, [supabase, monthStr]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadPayments();
  }, [loadPayments]);

  // ── かな行フィルタ済みの表示行 (介護請求と同じ左サイドバー絞込) ──
  const kanaMatches = useCallback(
    (r: ShogaiSeikyuRow) => {
      if (!kanaFilter) return true;
      const first = shogaiToKana((r.user_name_kana ?? r.user_name).charAt(0));
      return kanaFilter === "他"
        ? !SHOGAI_ALL_KANA.includes(first)
        : (SHOGAI_KANA_MAP[kanaFilter] ?? []).includes(first);
    },
    [kanaFilter],
  );
  const filteredRows = useMemo(() => rows.filter(kanaMatches), [rows, kanaMatches]);

  const selected =
    filteredRows.find((r) => r.user_id === selectedUserId) ?? filteredRows[0] ?? null;
  const totalUnits = filteredRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalBenefit = filteredRows.reduce((s, r) => s + r.benefitAmount, 0);
  const totalUser = filteredRows.reduce((s, r) => s + r.userAmount, 0);

  // ── 対象チェック (kaigo-seikyu と同じ: チェックあり → その行 / なし → 表示中全件) ──
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === filteredRows.length
        ? new Set()
        : new Set(filteredRows.map((r) => r.user_id)),
    );
  const targets = useMemo(
    () =>
      checked.size > 0
        ? filteredRows.filter((r) => checked.has(r.user_id))
        : filteredRows,
    [filteredRows, checked],
  );
  const allChecked =
    filteredRows.length > 0 && checked.size === filteredRows.length;
  const densouCount = filteredRows.filter(
    (r) => statusByClient.get(r.user_id)?.densou_target,
  ).length;

  // ── 明細書: 対象者の明細書を印刷 → 印刷実行時に issued_at=now() upsert (発行済化) ──
  const printMeisai = async () => {
    if (targets.length === 0) return;
    const now = new Date().toISOString();
    const payload = targets.map((r) => {
      const cur = statusByClient.get(r.user_id);
      return {
        client_id: r.user_id,
        target_month: monthStr,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: currentOffice?.id ?? null,
        issued_at: now,
        // 既存の伝送対象フラグ・備考は保持
        densou_target: cur?.densou_target ?? false,
        notes: cur?.notes ?? null,
      };
    });
    const { error: e } = await supabase
      .from("shogai_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month" });
    if (e) {
      // table 未作成でも印刷は実行 (状態が保存できなくても紙は出せるように)
      if (!isMissingTable(e.code)) toast.error("発行状態の保存に失敗: " + e.message);
    } else {
      loadStatus();
    }
    setPrintMode("meisai");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 請求書: 事業所単位の総括 (市町村別 J111 相当) を印刷 ──
  const seikyuGroups = useMemo<ShogaiSeikyuSummaryGroup[]>(() => {
    const m = new Map<string, ShogaiSeikyuSummaryGroup>();
    for (const r of targets) {
      const key = r.municipality ?? "";
      const g =
        m.get(key) ??
        {
          municipality: r.municipality,
          count: 0,
          units: 0,
          cost: 0,
          userAmt: 0,
          benefit: 0,
        };
      g.count += 1;
      g.units += r.totalUnits;
      g.cost += r.totalAmount;
      g.userAmt += r.userAmount;
      g.benefit += r.benefitAmount;
      m.set(key, g);
    }
    return Array.from(m.values()).sort((a, b) =>
      (a.municipality ?? "").localeCompare(b.municipality ?? ""),
    );
  }, [targets]);

  const printSeikyusho = () => {
    if (targets.length === 0) return;
    setPrintMode("seikyu");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 利用料請求書: 発行記録 (billed_amount/issued_date) を upsert → 印刷 ──
  //    入金状態などは既存を保持 (新規行は DB default '請求済') — riyou-seikyu と同じ流儀
  const printRiyouSeikyu = async () => {
    if (targets.length === 0) return;
    const today = new Date();
    const issued = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const { error: e } = await supabase.from("shogai_seikyu_payments").upsert(
      targets.map((r) => ({
        client_id: r.user_id,
        target_month: monthStr,
        billed_amount: r.userAmount,
        issued_date: issued,
      })),
      { onConflict: "client_id,target_month" },
    );
    if (e && !isMissingTable(e.code)) {
      toast.error("発行記録の保存に失敗: " + e.message);
    } else if (!e) {
      loadPayments();
    }
    setPrintMode("riyou");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 伝送対象: 発行済の対象行を densou_target=true に (未発行はスキップ + 警告) ──
  const markDensouTarget = async () => {
    const payload: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const r of targets) {
      const cur = statusByClient.get(r.user_id);
      if (!cur?.issued_at) {
        skipped++;
        continue;
      }
      payload.push({
        client_id: r.user_id,
        target_month: monthStr,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: currentOffice?.id ?? null,
        issued_at: cur.issued_at,
        densou_target: true,
        notes: cur.notes ?? null,
      });
    }
    if (payload.length === 0) {
      toast.warning("伝送対象にできる行がありません (先に明細書を発行してください)");
      return;
    }
    const { error: e } = await supabase
      .from("shogai_billing_status")
      .upsert(payload, { onConflict: "client_id,target_month" });
    if (e) {
      toast.error("伝送対象の保存に失敗: " + e.message);
      return;
    }
    toast.success(
      `${payload.length} 件を伝送対象にしました${skipped > 0 ? ` (未発行 ${skipped} 名はスキップ)` : ""}`,
    );
    loadStatus();
  };

  // 入金状態バッジ (riyou-seikyu の statusBadge と同じ)
  const paymentBadge = (userId: string) => {
    const p = payments.get(userId);
    if (!p)
      return (
        <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">
          未発行
        </span>
      );
    return (
      <span
        className={`inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold ${PAYMENT_STATUS_CLS[p.status] ?? "bg-gray-100 text-gray-600"}`}
      >
        {p.status}
      </span>
    );
  };

  const exportCsv = () => {
    const csv = buildShogaiSeikyuCsv(rows, year, month);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shogai_seikyu_${year}${String(month).padStart(2, "0")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ─── 月内の確定実績を取得 (実績記録票 印刷 / 伝送 J611 で共用) ──────────────
  const loadMonthVisits = useCallback(async (): Promise<
    Map<string, ShogaiDensouVisit[]>
  > => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const visitsByClient = new Map<string, ShogaiDensouVisit[]>();
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      let q = supabase
        .from("shogai_service_records")
        .select(
          "client_id, service_date, start_time, end_time, duration_minutes, service_category, service_code",
        )
        .eq("status", "confirmed")
        .gte("service_date", `${monthStr}-01`)
        .lte("service_date", `${monthStr}-${String(daysInMonth).padStart(2, "0")}`);
      // 自事業所スコープ (office_id 未設定の旧データは含める) — aggregate と同条件
      if (currentOffice) {
        q = q.or(`office_id.eq.${currentOffice.id},office_id.is.null`);
      }
      const { data, error } = await q
        .order("id") // page-loop の安定順序
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error("実績取得失敗: " + error.message);
      const recs = (data ?? []) as {
        client_id: string;
        service_date: string;
        start_time: string | null;
        end_time: string | null;
        duration_minutes: number | null;
        service_category: string | null;
        service_code: string | null;
      }[];
      for (const rec of recs) {
        if (!visitsByClient.has(rec.client_id)) visitsByClient.set(rec.client_id, []);
        visitsByClient.get(rec.client_id)!.push({
          date: rec.service_date,
          startTime: rec.start_time,
          endTime: rec.end_time,
          durationMinutes: rec.duration_minutes,
          category: rec.service_category,
          serviceCode: rec.service_code,
        });
      }
      if (recs.length < PAGE) break;
      offset += PAGE;
    }
    return visitsByClient;
  }, [supabase, currentOffice, year, month, monthStr]);

  // ─── サービス提供実績記録票 (様式1 居宅介護) — 対象者 1 名 = 1 枚 ────────────
  const printJisseki = async () => {
    if (targets.length === 0) return;
    setJissekiLoading(true);
    try {
      const visits = await loadMonthVisits();
      setJissekiVisits(visits);
      setPrintMode("jisseki");
      setTimeout(() => {
        window.print();
        setPrintMode(null);
      }, 100);
    } catch (e) {
      toast.error(
        "実績記録票の作成に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setJissekiLoading(false);
    }
  };

  // ─── 電子請求受付システム向け 伝送ファイル (J11 / J61 / J41) ────────────────
  const [densouLoading, setDensouLoading] = useState(false);

  const downloadSjis = (f: { content: string; fileName: string }) => {
    const sjis = Encoding.convert(Encoding.stringToCode(f.content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = f.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleDensouExport = async () => {
    if (rows.length === 0) return;
    setDensouLoading(true);
    try {
      // 1) 事業所番号・単価・地域区分
      const { data: o, error: oe } = await supabase
        .from("offices")
        .select("business_number, unit_price, area_category")
        .eq("id", currentOffice?.id ?? "")
        .maybeSingle();
      if (oe) throw new Error("事業所情報取得失敗: " + oe.message);
      const officeNumber = ((o?.business_number ?? "") as string).trim();
      const unitPrice = (o?.unit_price ?? 10) as number;
      const areaCategory = (o?.area_category ?? null) as string | null;

      // 2) 月内の確定実績 (実績記録票 J611 用の明細) — 自事業所スコープ + 安定順序
      const visitsByClient = await loadMonthVisits();

      // 3) 受給者証の契約支給量 (契約情報レコード J121-05 用)
      const ids = rows.map((r) => r.user_id);
      const contractByClient = new Map<
        string,
        { text: string | null; start: string | null; entry: string | null }
      >();
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const { data, error } = await supabase
          .from("shougai_certifications")
          .select(
            "client_id, contract_amount_text, contract_start_date, contract_entry_number, certification_start_date",
          )
          .in("client_id", chunk)
          .order("certification_start_date", { ascending: false });
        if (error) throw new Error("受給者証取得失敗: " + error.message);
        for (const c of (data ?? []) as {
          client_id: string;
          contract_amount_text: string | null;
          contract_start_date: string | null;
          contract_entry_number: string | null;
        }[]) {
          if (!contractByClient.has(c.client_id)) {
            contractByClient.set(c.client_id, {
              text: c.contract_amount_text,
              start: c.contract_start_date,
              entry: c.contract_entry_number,
            });
          }
        }
      }

      // 4) 自事業所上限管理の関係事業所一覧 (上限管理結果票 J411 用)
      const selfIds = rows
        .filter((r) => r.jogenKanriKubun === "自事業所")
        .map((r) => r.user_id);
      const linesByClient = new Map<string, ShogaiDensouKanriLine[]>();
      if (selfIds.length > 0) {
        const { data, error } = await supabase
          .from("shogai_jogen_kanri_results")
          .select("client_id, office_lines")
          .eq("target_month", monthStr)
          .in("client_id", selfIds);
        if (error) throw new Error("上限管理結果取得失敗: " + error.message);
        for (const k of (data ?? []) as {
          client_id: string;
          office_lines: ShogaiDensouKanriLine[];
        }[]) {
          if (Array.isArray(k.office_lines) && k.office_lines.length > 0) {
            linesByClient.set(k.client_id, k.office_lines);
          }
        }
      }

      // 5) 組み立て → 生成 → ダウンロード
      const users: ShogaiDensouUser[] = rows.map((r) => {
        const contract = contractByClient.get(r.user_id);
        return {
          row: r,
          visits: visitsByClient.get(r.user_id) ?? [],
          contractAmountText: contract?.text ?? null,
          contractStartDate: contract?.start ?? null,
          contractEntryNumber: contract?.entry ?? null,
          jogenOfficeLines: linesByClient.get(r.user_id) ?? null,
        };
      });
      const result = buildShogaiDensou(users, {
        officeNumber,
        year,
        month,
        unitPrice,
        areaCategory,
      });
      if (result.warnings.length > 0) {
        const ok = window.confirm(
          "以下の確認事項があります:\n\n・" +
            result.warnings.join("\n・") +
            "\n\nこのまま出力しますか？",
        );
        if (!ok) return;
      }
      downloadSjis(result.seikyuFile);
      downloadSjis(result.jissekiFile);
      if (result.jogenFile) downloadSjis(result.jogenFile);
    } catch (e) {
      alert(
        "伝送ファイルの生成に失敗しました: " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setDensouLoading(false);
    }
  };

  // 訪問介護 office 専用 (障害福祉の実績・請求は訪問介護事業所で運用)
  if (!btLoading && currentOffice && currentOffice.service_type !== "訪問介護") {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        この機能は訪問介護事業所専用です。ヘッダーの事業所切替で訪問介護の事業所を選択してください。
      </div>
    );
  }

  return (
    <>
    {/* printMode 中は画面を隠す (上限管理結果票の印刷は printMode=null のまま
        overlay で出すため、常時 print:hidden にはしない)。
        レイアウトは介護請求 (kaigo-seikyu) と統一:
        左=かな索引 / 中央=ツールバー+高密度グリッド+合計フッタ / 右=明細情報ペイン */}
    <div className={`flex flex-1 min-h-0 ${printMode ? "print:hidden" : ""}`}>
      {/* ── 左: 行カナ絞り込みサイドバー (介護請求と同一クラス) ── */}
      <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
        <button
          type="button"
          onClick={() => setKanaFilter(null)}
          className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
        >
          全
        </button>
        {SHOGAI_KANA_ROWS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
            className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
          >
            {k}
          </button>
        ))}
      </div>

      {/* ── 中央: メインテーブル ── */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-gray-200">
        {/* ── ツールバー ── */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <MonthNav
            year={year}
            month={month}
            onChange={(y, m) => {
              setYear(y);
              setMonth(m);
            }}
          />
          <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">請求分</span>
          <span className="text-xs text-gray-500">{filteredRows.length} 件</span>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <button
            type="button"
            disabled={filteredRows.length === 0}
            onClick={printMeisai}
            className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            title="対象者の介護給付費・訓練等給付費等明細書を印刷。印刷で発行済になります"
          >
            <FileText size={13} />明細書 ({targets.length}件)
          </button>
          <button
            type="button"
            disabled={filteredRows.length === 0 || jissekiLoading}
            onClick={printJisseki}
            className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            title="対象者の居宅介護サービス提供実績記録票 (様式1) を印刷 (利用者 1 名 = 1 枚)"
          >
            {jissekiLoading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Printer size={13} />
            )}
            実績記録票 ({targets.length}件)
          </button>
          <button
            type="button"
            disabled={filteredRows.length === 0}
            onClick={printSeikyusho}
            className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            title="事業所単位の総括請求書 (市町村別 J111 相当) を印刷"
          >
            <Printer size={13} />請求書
          </button>
          <button
            type="button"
            disabled={filteredRows.length === 0}
            onClick={printRiyouSeikyu}
            className="border border-emerald-500 rounded bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1.5 disabled:opacity-50"
            title="利用者向けの利用料請求書 (利用者負担額) を発行・印刷。発行日を記録します"
          >
            <Receipt size={13} />利用料請求書 ({targets.length}件)
          </button>
          <button
            type="button"
            disabled={filteredRows.length === 0}
            onClick={markDensouTarget}
            className="border border-red-500 rounded bg-red-100 px-2.5 py-1 text-red-800 font-semibold hover:bg-red-200 flex items-center gap-1.5 disabled:opacity-50"
            title="発行済の利用者を国保連伝送の対象にする (未発行はスキップ)"
          >
            <Send size={13} />伝送対象
          </button>
          <div className="ml-auto flex items-center gap-2">
            {densouCount > 0 && (
              <span className="text-[11px] font-medium text-red-600">
                伝送対象 {densouCount} 件
              </span>
            )}
            <button
              type="button"
              disabled={filteredRows.length === 0}
              onClick={exportCsv}
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
              title="内容確認用の明細 CSV を出力"
            >
              <Download size={13} />確認用CSV
            </button>
            <button
              type="button"
              disabled={filteredRows.length === 0 || densouLoading}
              onClick={handleDensouExport}
              className="border border-violet-600 rounded bg-violet-600 px-3 py-1 text-white font-semibold hover:bg-violet-700 flex items-center gap-1.5 disabled:opacity-50"
              title="電子請求受付システム向け伝送ファイル (請求書・明細書 J11 / 実績記録票 J61 / 上限管理結果票 J41) を出力"
            >
              {densouLoading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FileDown size={13} />
              )}
              伝送ファイル
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </div>
        )}

        {loading || btLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={22} className="animate-spin text-violet-400" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {/* ヘッダー行: 対象 / 状態 / 提供月 / 請求月 / サービス事業所 / 受給者証番号 / 利用者名 / 区分 / 入金 / 総単位数 / 給付費請求額 / 利用者負担 */}
              <div className={`${GRID_COLS} border-b border-gray-400 bg-gradient-to-b from-sky-100 to-sky-200 text-[11px] leading-4 font-medium text-gray-700 text-center sticky top-0 z-10`}>
                <div className="px-1 py-0.5 flex items-center justify-center">
                  <button
                    onClick={toggleAll}
                    title="全選択 (未チェック時は表示中全件が対象)"
                    className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-all ${
                      allChecked ? "border-violet-500 bg-violet-500" : "border-gray-400 bg-white"
                    }`}
                  >
                    {allChecked && (
                      <span className="text-white text-[8px] font-bold leading-none">✓</span>
                    )}
                  </button>
                </div>
                <div className="px-1 py-0.5 border-l border-sky-300">状態</div>
                <div className="px-1 py-0.5 border-l border-sky-300">提供月</div>
                <div className="px-1 py-0.5 border-l border-sky-300">請求月</div>
                <div className="px-1 py-0.5 border-l border-sky-300">サービス事業所</div>
                <div className="px-1 py-0.5 border-l border-sky-300">受給者証番号</div>
                <div className="px-1 py-0.5 border-l border-sky-300">利用者名</div>
                <div className="px-1 py-0.5 border-l border-sky-300">区分</div>
                <div className="px-1 py-0.5 border-l border-sky-300">入金</div>
                <div className="px-1 py-0.5 border-l border-sky-300">総単位数</div>
                <div className="px-1 py-0.5 border-l border-sky-300">給付費請求額</div>
                <div className="px-1 py-0.5 border-l border-sky-300">利用者負担</div>
              </div>

              {filteredRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">
                  対象月の実績 (確定) がありません。障害福祉 → サービス提供実績 で記録を確定してください。
                </p>
              ) : filteredRows.map((r) => {
                const st = statusByClient.get(r.user_id);
                const isDetail = selectedUserId === r.user_id;
                const isChecked = checked.has(r.user_id);
                return (
                  <div
                    key={r.user_id}
                    onClick={() => setSelectedUserId(isDetail ? null : r.user_id)}
                    className={`${GRID_COLS} border-b border-gray-200 text-[11px] leading-4 cursor-pointer transition-colors ${
                      isDetail
                        ? "bg-violet-100"
                        : isChecked
                        ? "bg-violet-50"
                        : "bg-white hover:bg-sky-50"
                    }`}
                  >
                    <div className="px-1 py-0.5 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggle(r.user_id)}
                        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-all ${
                          isChecked ? "border-violet-500 bg-violet-500" : "border-gray-400 bg-white"
                        }`}
                      >
                        {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                      </button>
                    </div>
                    {/* 状態: バッジ背景なしの素の色文字 (介護請求と同じ)。伝送対象 = 赤字 */}
                    <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                      {st?.densou_target ? (
                        <span className="text-red-600">伝送対象</span>
                      ) : st?.issued_at ? (
                        <span className="text-emerald-700">発行済</span>
                      ) : (
                        <span className="text-gray-600">未発行</span>
                      )}
                    </div>
                    {/* 提供月 = 請求月 = 当月 (障害は月遅れ/返戻の再請求合流なし) */}
                    <div className="px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700">
                      {reiwaMonth(year, month)}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700">
                      {reiwaMonth(year, month)}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-gray-700 truncate" title={currentOffice?.name ?? ""}>
                      {currentOffice?.name ?? ""}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 font-mono text-gray-700">
                      {r.beneficiary_number ?? "—"}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-gray-800 flex items-center gap-1 min-w-0">
                      <span className="flex-1 truncate">{r.user_name}</span>
                      {r.seiho && (
                        <span className="shrink-0 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-700 ring-1 ring-amber-200">
                          生保
                        </span>
                      )}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-center text-gray-700">
                      {r.support_level ?? "—"}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                      {paymentBadge(r.user_id)}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-800 tabular-nums">
                      {r.totalUnits.toLocaleString()}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono font-semibold text-violet-700 tabular-nums">
                      {r.benefitAmount.toLocaleString()}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-800 tabular-nums">
                      {r.userAmount.toLocaleString()}
                    </div>
                  </div>
                );
              })}
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
                <span className="ml-auto text-gray-500">実績 {recordCount.toLocaleString()} 件</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                <span className="inline-flex">
                  <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">給付費請求額</span>
                  <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[96px] text-right font-mono text-violet-700">{totalBenefit.toLocaleString()}</span>
                </span>
                <span className="inline-flex">
                  <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">利用者負担合計</span>
                  <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[96px] text-right font-mono">{totalUser.toLocaleString()}</span>
                </span>
                <span className="ml-auto text-[10px] text-gray-400">
                  ※ 明細書の印刷で「発行済」、伝送対象ボタンで「伝送対象」に (介護請求と同じ流れ)
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── 右：明細情報 (介護請求と同じ 青系帯 + 高密度明細)。障害固有ブロック(上限管理/入金管理)を内包 ── */}
      <div className="w-96 shrink-0 flex flex-col bg-white">
        <div className="border-b border-sky-700 bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-1 text-xs font-bold text-white flex items-center gap-2">
          <span>明細情報</span>
          {selected && <span className="font-normal text-sky-100 truncate">{selected.user_name}</span>}
        </div>
        {selected ? (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-[11px] leading-4 border-collapse">
              <thead className="bg-gradient-to-b from-sky-100 to-sky-200 border-b border-gray-400 sticky top-0">
                <tr>
                  <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300">サービス内容</th>
                  <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-16 whitespace-nowrap">コード</th>
                  <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-12">単位数</th>
                  <th className="text-center px-1 py-0.5 font-medium text-gray-700 border-r border-sky-300 w-8">回数</th>
                  <th className="text-center px-1 py-0.5 font-medium text-gray-700 w-12">小計</th>
                </tr>
              </thead>
              <tbody>
                {selected.details.map((d, i) => (
                  <tr key={i} className="border-b border-gray-200 bg-white">
                    <td className="px-1 py-0.5 text-gray-700 leading-tight border-r border-gray-200">
                      {d.service_type}
                      {d.service_category && (
                        <span className="ml-1 text-[9px] text-gray-400">{d.service_category}</span>
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono border-r border-gray-200 truncate" title={d.service_code ?? ""}>
                      {d.service_code ?? "—"}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">
                      {d.unit_per.toLocaleString()}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">
                      {d.count}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono font-semibold text-gray-800 tabular-nums">
                      {d.units.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {/* 処遇改善加算等 (月次加算、回数 1) */}
                {selected.addons.map((a) => (
                  <tr key={a.service_code} className="border-b border-gray-200 bg-violet-50/60">
                    <td className="px-1 py-0.5 text-violet-700 leading-tight border-r border-gray-200">
                      {a.service_name}
                    </td>
                    <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono border-r border-gray-200 truncate">
                      {a.service_code}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">
                      {a.units.toLocaleString()}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">1</td>
                    <td className="px-1 py-0.5 text-right font-mono font-semibold text-gray-800 tabular-nums">
                      {a.units.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* ── 金額サマリ (介護請求 右下の ラベル箱/値箱 grid と同じ様式) ── */}
            <div className="border-t border-gray-400 bg-gray-100 shrink-0 p-1.5">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-px bg-gray-400 border border-gray-400 text-[11px] leading-4">
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">合計単位数</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.totalUnits.toLocaleString()}</div>
                {selected.addonUnits > 0 && (
                  <>
                    <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">うち{selected.addonLabel ?? "処遇改善加算"}</div>
                    <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.addonUnits.toLocaleString()}</div>
                  </>
                )}
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">地域単価</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.unitPrice.toFixed(2)} 円/単位</div>
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">総費用額</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">¥{selected.totalAmount.toLocaleString()}</div>
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">
                  負担上限月額{selected.seiho ? " (生保=負担なし)" : ""}
                </div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                  {selected.self_payment_limit != null ? (
                    `¥${selected.self_payment_limit.toLocaleString()}`
                  ) : (
                    <span className="font-sans text-[10px] font-semibold text-amber-600">未設定 (受給者証で入力)</span>
                  )}
                </div>
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">利用者負担額</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono font-bold text-gray-800">¥{selected.userAmount.toLocaleString()}</div>
                <div className="bg-violet-100 px-1.5 py-0.5 whitespace-nowrap font-bold text-violet-800">介護給付費請求額</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono font-bold text-violet-700">¥{selected.benefitAmount.toLocaleString()}</div>
              </div>

              {/* ── 障害固有: 利用者負担上限額管理 (介護請求には無いブロック) ── */}
              <JogenKanriSection
                key={`${selected.user_id}-${year}-${month}`}
                row={selected}
                year={year}
                month={month}
                onSaved={load}
              />

              {/* ── 障害固有: 入金管理 (利用料請求の未収金管理。介護請求には無いブロック) ── */}
              <ShogaiPaymentSection
                key={`pay-${selected.user_id}-${monthStr}`}
                userId={selected.user_id}
                monthKey={monthStr}
                billed={
                  payments.get(selected.user_id)?.billed_amount ??
                  selected.userAmount
                }
                payment={payments.get(selected.user_id) ?? null}
                onChanged={loadPayments}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
            行を選択してください
          </div>
        )}
      </div>
    </div>

    {/* ===== 印刷 view: 明細書 (介護給付費・訓練等給付費等明細書) — 利用者 1 名 = 1 枚 ===== */}
    {printMode === "meisai" && (
      <div className="hidden print:block">
        {targets.map((r) => (
          <ShogaiMeisaiPrintSheet
            key={r.user_id}
            row={r}
            officeName={currentOffice?.name ?? null}
            officeNumber={officeNumber}
            reiwa={year - 2018}
            month={month}
          />
        ))}
      </div>
    )}

    {/* ===== 印刷 view: 請求書 (様式第一相当 — 事業所単位の総括 1 枚) ===== */}
    {printMode === "seikyu" && (
      <div className="hidden print:block">
        <ShogaiSeikyushoPrintSheet
          groups={seikyuGroups}
          officeName={currentOffice?.name ?? null}
          officeNumber={officeNumber}
          reiwa={year - 2018}
          month={month}
        />
      </div>
    )}

    {/* ===== 印刷 view: サービス提供実績記録票 (様式1 居宅介護) — 利用者 1 名 = 1 枚 ===== */}
    {printMode === "jisseki" && (
      <div className="hidden print:block">
        {targets.map((r) => (
          <ShogaiJissekiKirokuhyoPrintSheet
            key={r.user_id}
            row={r}
            visits={jissekiVisits.get(r.user_id) ?? []}
            officeName={currentOffice?.name ?? null}
            officeNumber={officeNumber}
            reiwa={year - 2018}
            month={month}
          />
        ))}
      </div>
    )}

    {/* ===== 印刷 view: 利用料請求書 (利用者向け) — 利用者 1 名 = 1 枚 ===== */}
    {printMode === "riyou" && (
      <div className="hidden print:block">
        {targets.map((r) => (
          <ShogaiRiyouSeikyuPrintSheet
            key={r.user_id}
            row={r}
            officeName={currentOffice?.name ?? null}
            reiwa={year - 2018}
            month={month}
          />
        ))}
      </div>
    )}
    </>
  );
}

// ─── 入金管理 (利用料請求の未収金管理 — riyou-seikyu の PaymentSection と同じ作り) ──
function ShogaiPaymentSection({
  userId,
  monthKey,
  billed,
  payment,
  onChanged,
}: {
  userId: string;
  monthKey: string;
  billed: number;
  payment: ShogaiPaymentRow | null;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const [amount, setAmount] = useState(String(billed));
  const [date, setDate] = useState(todayStr);
  const [method, setMethod] = useState(payment?.payment_method ?? "振込");
  const [saving, setSaving] = useState(false);

  const save = async (asStatus?: "未収") => {
    setSaving(true);
    const paid =
      asStatus === "未収" ? (payment?.paid_amount ?? 0) : parseInt(amount, 10) || 0;
    const status =
      asStatus ??
      (paid >= billed && billed > 0 ? "入金完" : paid > 0 ? "一部入金" : "請求済");
    const { error } = await supabase.from("shogai_seikyu_payments").upsert(
      {
        client_id: userId,
        target_month: monthKey,
        billed_amount: billed,
        paid_amount: paid,
        paid_date: asStatus === "未収" ? (payment?.paid_date ?? null) : date,
        payment_method: method,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    setSaving(false);
    if (error) {
      toast.error("入金登録に失敗: " + error.message);
      return;
    }
    toast.success(asStatus === "未収" ? "未収として記録しました" : "入金を登録しました");
    onChanged();
  };

  return (
    <div className="mt-3 rounded border border-blue-200 bg-blue-50/40 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-bold text-blue-800">入金管理</span>
        <span className="text-[10px] text-gray-500">
          {payment?.issued_date
            ? `利用料請求書発行日: ${payment.issued_date}`
            : "利用料請求書未発行"}
          {payment && (
            <span
              className={`ml-2 whitespace-nowrap rounded px-1.5 py-0.5 font-bold ${PAYMENT_STATUS_CLS[payment.status]}`}
            >
              {payment.status}
            </span>
          )}
        </span>
      </div>
      {payment && payment.paid_amount > 0 && (
        <p className="text-[10px] text-gray-500">
          入金済: ¥{payment.paid_amount.toLocaleString()} (
          {payment.paid_date ?? "—"} / {payment.payment_method ?? "—"})
        </p>
      )}
      <div className="flex flex-wrap items-end gap-1.5">
        <div className="w-20">
          <label className="mb-0.5 block text-[10px] text-gray-500">入金額</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-right tabular-nums focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">入金日</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded border px-2 py-1.5 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">方法</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="rounded border px-2 py-1.5 focus:border-blue-500 focus:outline-none"
          >
            <option>振込</option>
            <option>現金</option>
            <option>口座振替</option>
          </select>
        </div>
        <div className="ml-auto flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => save()}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            入金登録
          </button>
          <button
            type="button"
            onClick={() => save("未収")}
            disabled={saving}
            className="rounded border border-red-300 bg-white px-2.5 py-1.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            未収
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 利用者負担上限額管理 (月次の管理結果入力) ────────────────────────────────
function JogenKanriSection({
  row,
  year,
  month,
  onSaved,
}: {
  row: ShogaiSeikyuRow;
  year: number;
  month: number;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [result, setResult] = useState<string>(row.kanriResult != null ? String(row.kanriResult) : "");
  const [amount, setAmount] = useState<string>(row.kanriResultAmount != null ? String(row.kanriResultAmount) : "");
  const [saving, setSaving] = useState(false);

  if (row.jogenKanriKubun === "なし") {
    return (
      <div className="mt-3 rounded border border-dashed bg-gray-50 px-3 py-2 text-[11px] text-gray-400">
        上限額管理: 対象外 (受給者証で管理事業所を設定すると月次の管理結果を入力できます)
      </div>
    );
  }

  // 自事業所が管理者の場合は調整計算 + 結果票作成 (別コンポーネント)
  if (row.jogenKanriKubun === "自事業所") {
    return <JogenKanriSelfSection row={row} year={year} month={month} onSaved={onSaved} />;
  }

  const save = async () => {
    setSaving(true);
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;
    const { error } = await supabase.from("shogai_jogen_kanri_results").upsert(
      {
        client_id: row.user_id,
        target_month: monthStr,
        kanri_result: result ? parseInt(result, 10) : null,
        kanri_result_amount: amount !== "" ? parseInt(amount, 10) : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    setSaving(false);
    if (error) {
      alert("上限管理結果の保存に失敗しました: " + error.message);
      return;
    }
    onSaved();
  };

  return (
    <div className="mt-3 rounded border border-violet-200 bg-violet-50/50 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-bold text-violet-800">利用者負担上限額管理</span>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
          {row.jogenKanriKubun}が管理
        </span>
      </div>
      {row.jogenKanriKubun === "他事業所" && (
        <p className="text-[10px] text-gray-500">
          管理事業所: {row.jogenKanriOfficeName ?? "未設定"}
          {row.jogenKanriOfficeNumber ? ` (${row.jogenKanriOfficeNumber})` : ""}
          — 管理結果票を受領したら下に入力してください
        </p>
      )}
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">管理結果区分</label>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-xs focus:border-violet-500 focus:outline-none"
          >
            <option value="">未入力</option>
            <option value="1">1: 管理事業所で充当 (他は負担なし)</option>
            <option value="2">2: 合算が上限以下 (調整なし)</option>
            <option value="3">3: 管理結果票のとおり調整</option>
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">調整後負担額</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={result === "2" || result === ""}
            placeholder="円"
            className="w-24 rounded border px-2 py-1.5 text-right text-xs tabular-nums focus:border-violet-500 focus:outline-none disabled:bg-gray-100"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
      <p className="text-[10px] text-gray-400">
        区分 1・3 は調整後負担額が利用者負担額・給付費請求額に反映されます。
      </p>
    </div>
  );
}

// ─── 自事業所が上限管理者の場合: 調整計算 + 結果票 (上限管理編 3-1/3-2) ────────
interface KanriOfficeLine {
  office_number: string;
  office_name: string;
  total_amount: number;
  user_amount: number;
  adjusted_amount: number;
  is_self: boolean;
}

function JogenKanriSelfSection({
  row,
  year,
  month,
  onSaved,
}: {
  row: ShogaiSeikyuRow;
  year: number;
  month: number;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  // 負担上限月額: null = 未設定 / 0 = 負担0円 (aggregate 側で生保は 0 に正規化済)
  const limit = row.self_payment_limit;
  const ichiwari = Math.floor(row.totalAmount / 10);
  // 調整前の自事業所 利用者負担 (上限管理結果の反映前の値を再計算)
  const selfPre = row.seiho ? 0 : limit != null ? Math.min(ichiwari, limit) : ichiwari;

  const [lines, setLines] = useState<KanriOfficeLine[]>([]);
  const [result, setResult] = useState<number | null>(row.kanriResult);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [newNo, setNewNo] = useState("");
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newTotal, setNewTotal] = useState("");

  // 保存済みの関係事業所一覧を読み込み (無ければ自事業所行のみで初期化)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("shogai_jogen_kanri_results")
        .select("office_lines, kanri_result")
        .eq("client_id", row.user_id)
        .eq("target_month", monthStr)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // 読込失敗時に空で初期化すると保存済みの管理結果を上書き消失させるため編集不可にする
        setLoadErr(error.message);
        return;
      }
      setLoadErr(null);
      const saved = ((data?.office_lines ?? []) as KanriOfficeLine[]) ?? [];
      if (saved.length > 0) {
        // 自事業所行は最新の請求集計値で更新
        setLines(
          saved.map((l) =>
            l.is_self
              ? { ...l, total_amount: row.totalAmount, user_amount: selfPre }
              : l,
          ),
        );
        setResult((data?.kanri_result as number | null) ?? null);
      } else {
        setLines([
          {
            office_number: "",
            office_name: "(自事業所)",
            total_amount: row.totalAmount,
            user_amount: selfPre,
            adjusted_amount: selfPre,
            is_self: true,
          },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 対象 (利用者×月) 切替時のみ再読込
  }, [row.user_id, monthStr]);

  const addLine = () => {
    if (!newName.trim()) {
      alert("事業所名を入力してください");
      return;
    }
    const amt = parseInt(newAmount, 10) || 0;
    const tot = parseInt(newTotal, 10) || 0;
    setLines((prev) => [
      ...prev,
      {
        office_number: newNo.trim(),
        office_name: newName.trim(),
        total_amount: tot,
        user_amount: amt,
        adjusted_amount: amt,
        is_self: false,
      },
    ]);
    setNewNo("");
    setNewName("");
    setNewAmount("");
    setNewTotal("");
  };

  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  // 他事業所行の総費用額をインライン編集 (J411 明細 9 / 管理結果3 で必須)
  const setLineTotal = (i: number, v: string) =>
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, total_amount: parseInt(v, 10) || 0 } : l)),
    );

  // 調整計算: 合算 ≤ 上限 → 区分2 / 超過 → 管理事業所 (自) 優先充当で配分
  const calc = () => {
    if (limit == null) {
      alert(
        "負担上限月額が未設定のため調整計算できません。受給者証ページで入力してください (負担 0 円の場合も 0 を入力)。",
      );
      return;
    }
    const sum = lines.reduce((s, l) => s + l.user_amount, 0);
    if (sum <= limit) {
      setLines((prev) => prev.map((l) => ({ ...l, adjusted_amount: l.user_amount })));
      setResult(2);
      return;
    }
    let remain = limit;
    const next = lines.map((l) => ({ ...l }));
    for (const l of next.filter((x) => x.is_self)) {
      l.adjusted_amount = Math.min(l.user_amount, remain);
      remain -= l.adjusted_amount;
    }
    const others = next.filter((x) => !x.is_self).sort((a, b) => b.user_amount - a.user_amount);
    for (const l of others) {
      l.adjusted_amount = Math.min(l.user_amount, remain);
      remain -= l.adjusted_amount;
    }
    setLines(next);
    setResult(others.every((l) => l.adjusted_amount === 0) ? 1 : 3);
  };

  const save = async () => {
    if (result == null) {
      alert("先に「調整計算」を実行してください");
      return;
    }
    setSaving(true);
    const self = lines.find((l) => l.is_self);
    const { error } = await supabase.from("shogai_jogen_kanri_results").upsert(
      {
        client_id: row.user_id,
        target_month: monthStr,
        kanri_result: result,
        kanri_result_amount: self?.adjusted_amount ?? null,
        office_lines: lines,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    setSaving(false);
    if (error) {
      alert("保存に失敗しました: " + error.message);
      return;
    }
    onSaved();
  };

  const doPrint = () => {
    setPrinting(true);
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 100);
  };

  const sumUser = lines.reduce((s, l) => s + l.user_amount, 0);
  const sumAdj = lines.reduce((s, l) => s + l.adjusted_amount, 0);
  const sumTotal = lines.reduce((s, l) => s + l.total_amount, 0);

  // 読込失敗: 保存済みの管理結果を保護するため編集 UI を出さない
  if (loadErr) {
    return (
      <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        <span className="font-bold">利用者負担上限額管理:</span> 保存済みデータの読込に失敗しました
        ({loadErr})。既存の管理結果を上書きしないよう編集を無効化しています —
        ページを再読み込みしてください。
      </div>
    );
  }

  return (
    <div className="mt-3 rounded border border-violet-200 bg-violet-50/50 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-bold text-violet-800">利用者負担上限額管理 (当事業所が管理者)</span>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
          上限月額 {limit != null ? `¥${limit.toLocaleString()}` : "未設定"}
        </span>
      </div>
      {limit == null && (
        <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
          負担上限月額が未設定です。受給者証ページで入力してください (負担 0 円の場合も 0 を入力)。
        </p>
      )}

      <table className="w-full text-[11px]">
        <thead className="text-left text-[10px] text-gray-500">
          <tr>
            <th className="py-0.5">事業所</th>
            <th className="py-0.5 text-right">総費用額</th>
            <th className="py-0.5 text-right">利用者負担額</th>
            <th className="py-0.5 text-right">管理結果後</th>
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-violet-100">
          {lines.map((l, i) => (
            <tr key={i} className={l.is_self ? "font-semibold" : ""}>
              <td className="py-1">
                {l.office_name}
                {l.office_number && (
                  <span className="ml-1 font-mono text-[9px] text-gray-400">{l.office_number}</span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">
                {l.is_self ? (
                  `¥${l.total_amount.toLocaleString()}`
                ) : (
                  <input
                    type="number"
                    value={l.total_amount || ""}
                    onChange={(e) => setLineTotal(i, e.target.value)}
                    placeholder="0"
                    className="w-20 rounded border px-1 py-0.5 text-right tabular-nums focus:border-violet-500 focus:outline-none"
                  />
                )}
              </td>
              <td className="py-1 text-right tabular-nums">¥{l.user_amount.toLocaleString()}</td>
              <td className="py-1 text-right tabular-nums text-violet-700">
                ¥{l.adjusted_amount.toLocaleString()}
              </td>
              <td className="py-1 text-center">
                {!l.is_self && (
                  <button
                    onClick={() => removeLine(i)}
                    className="text-gray-300 hover:text-red-500"
                    title="削除"
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
          <tr className="border-t border-violet-200 font-bold">
            <td className="py-1">合算</td>
            <td className="py-1 text-right tabular-nums">¥{sumTotal.toLocaleString()}</td>
            <td className={`py-1 text-right tabular-nums ${limit != null && sumUser > limit ? "text-red-600" : ""}`}>
              ¥{sumUser.toLocaleString()}
            </td>
            <td className="py-1 text-right tabular-nums">¥{sumAdj.toLocaleString()}</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div className="grid grid-cols-[90px_1fr_80px_80px_auto] items-center gap-1.5">
        <input
          value={newNo}
          onChange={(e) => setNewNo(e.target.value)}
          placeholder="事業所番号"
          className="rounded border px-2 py-1.5 font-mono focus:border-violet-500 focus:outline-none"
        />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="関係事業所名"
          className="rounded border px-2 py-1.5 focus:border-violet-500 focus:outline-none"
        />
        <input
          type="number"
          value={newTotal}
          onChange={(e) => setNewTotal(e.target.value)}
          placeholder="総費用額"
          className="rounded border px-2 py-1.5 text-right tabular-nums focus:border-violet-500 focus:outline-none"
        />
        <input
          type="number"
          value={newAmount}
          onChange={(e) => setNewAmount(e.target.value)}
          placeholder="負担額"
          className="rounded border px-2 py-1.5 text-right tabular-nums focus:border-violet-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={addLine}
          className="rounded border border-violet-300 bg-white px-2.5 py-1.5 font-medium text-violet-700 hover:bg-violet-50"
        >
          追加
        </button>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-gray-500">
          {result != null
            ? `管理結果区分: ${result} (${result === 1 ? "管理事業所で充当" : result === 2 ? "調整なし" : "結果票のとおり調整"})`
            : "未計算"}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={calc}
            className="rounded border border-violet-300 bg-white px-3 py-1.5 font-medium text-violet-700 hover:bg-violet-50"
          >
            調整計算
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存 (請求に反映)"}
          </button>
          <button
            type="button"
            onClick={doPrint}
            disabled={result == null}
            className="rounded border border-violet-300 bg-white px-3 py-1.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
          >
            結果票印刷
          </button>
        </div>
      </div>

      {/* 印刷: 利用者負担上限額管理結果票 */}
      {printing && (
        <div className="fixed inset-0 hidden bg-white p-8 text-black print:block">
          <h1 className="mb-4 text-center text-lg font-bold tracking-widest">
            利用者負担上限額管理結果票
          </h1>
          <div className="mb-1 text-right text-xs">
            令和{year - 2018}年{month}月分
          </div>
          <table className="mb-3 w-full border-collapse text-xs">
            <tbody>
              <tr>
                <td className="w-28 border border-black bg-gray-100 px-2 py-1">受給者証番号</td>
                <td className="border border-black px-2 py-1 font-mono">{row.beneficiary_number ?? ""}</td>
                <td className="w-40 border border-black bg-gray-100 px-2 py-1">支給決定障害者等氏名</td>
                <td className="border border-black px-2 py-1">{row.user_name}</td>
              </tr>
              <tr>
                <td className="border border-black bg-gray-100 px-2 py-1">利用者負担上限月額</td>
                <td className="border border-black px-2 py-1 tabular-nums">
                  {limit != null ? `¥${limit.toLocaleString()}` : ""}
                </td>
                <td className="border border-black bg-gray-100 px-2 py-1">管理結果区分</td>
                <td className="border border-black px-2 py-1">{result ?? ""}</td>
              </tr>
            </tbody>
          </table>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-black px-2 py-1">項番</th>
                <th className="border border-black px-2 py-1">事業所番号</th>
                <th className="border border-black px-2 py-1">事業所名称</th>
                <th className="border border-black px-2 py-1 text-right">総費用額</th>
                <th className="border border-black px-2 py-1 text-right">利用者負担額</th>
                <th className="border border-black px-2 py-1 text-right">管理結果後利用者負担額</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="border border-black px-2 py-1 text-center">{i + 1}</td>
                  <td className="border border-black px-2 py-1 font-mono">{l.office_number}</td>
                  <td className="border border-black px-2 py-1">
                    {l.office_name}
                    {l.is_self ? " (上限額管理事業所)" : ""}
                  </td>
                  <td className="border border-black px-2 py-1 text-right tabular-nums">
                    ¥{l.total_amount.toLocaleString()}
                  </td>
                  <td className="border border-black px-2 py-1 text-right tabular-nums">
                    ¥{l.user_amount.toLocaleString()}
                  </td>
                  <td className="border border-black px-2 py-1 text-right tabular-nums">
                    ¥{l.adjusted_amount.toLocaleString()}
                  </td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="border border-black px-2 py-1 text-center" colSpan={3}>
                  合計
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">
                  ¥{sumTotal.toLocaleString()}
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">
                  ¥{sumUser.toLocaleString()}
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">
                  ¥{sumAdj.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
