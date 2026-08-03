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

import { ID_IN_CHUNK, NAME_IN_CHUNK } from "@/lib/chunk-parallel";
import { useMemo, useState, useEffect, useCallback } from "react";
import {
  Loader2,
  AlertCircle,
  ClipboardList,
  Download,
  FileDown,
  FileText,
  Printer,
  Receipt,
  Send,
  X,
} from "lucide-react";
import Encoding from "encoding-japanese";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import { MonthNav } from "../_shared/month-nav";
import { useSeikyuContext } from "../_shared/seikyu-context";
import {
  aggregateMonthlyShogaiSeikyu,
  buildShogaiSeikyuCsv,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";
import {
  loadReSeikyuShogai,
  type ShogaiReSeikyuRow,
  type ShogaiReSeikyuReasons,
} from "@/lib/shogai-seikyu/re-seikyu-shogai";
import { validInMonth } from "@/lib/service-code-valid";
import { getShogaiHomonUnitPrice } from "@/lib/shogai-seikyu/unit-price";
import { isAddonRecord, isSessionSubRecord } from "@/lib/shogai-seikyu/record-markers";
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
  ShogaiFutanIchiranPrintSheet,
  ShogaiKeiyakuHoukokuPrintSheet,
  type ShogaiSeikyuSummaryGroup,
  type ShogaiKeiyakuEntry,
} from "../../billing/forms/_shogai-meisai";

// table 未作成 (migration 未適用): 42P01 = SQL / PGRST205 = PostgREST schema cache
const isMissingTable = (code: string | undefined) =>
  code === "42P01" || code === "PGRST205";

// ── 介護請求 (kaigo-seikyu) と同じ高密度グリッド。列は view ごとに出し分け
//    (gridTemplate をコンポーネント内で動的生成)。
//    対象 / 状態 / 提供月 / 請求月 / サービス事業所 / 受給者証番号 / 利用者名 /
//    区分 / 入金 / 総単位数 / 給付費請求額 / 利用者負担

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
//   月遅れ/返戻/過誤フラグ (shogai_billing_status_flags.sql 適用後) で再請求に合流する
interface ShogaiBillingStatusRow {
  client_id: string;
  issued_at: string | null;
  densou_target: boolean;
  notes: string | null;
  tsukiokure?: boolean;
  henrei?: boolean;
  kago?: boolean;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)。再請求は元提供月で再集計済み
interface DisplayRow {
  key: string;
  row: ShogaiSeikyuRow;
  origMonthKey: string; // 'YYYY-MM' (再請求は元提供月、当月行は当月)
  ym: string; // 'YYYYMM' (伝送の元提供年月)
  isReSeikyu: boolean;
  reasons: ShogaiReSeikyuReasons | null; // 再請求/当月フラグの理由
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

/**
 * 表示 view — 障害の請求工程を 3 タブに出し分ける (親の制度トグル配下)。
 *   seikyu = 障害請求 (レセプト: 明細書 / 実績記録票 / 総括請求書 + 上限額管理)
 *   riyou  = 利用請求 (利用料請求書 + 入金管理)
 *   kokuho = 国保請求 (伝送対象 / 確認用CSV / 伝送ファイル)
 * state・データ・印刷 view は共通。親は同一要素を保持するので view 切替で再 fetch しない。
 */
export type ShogaiSeikyuView = "seikyu" | "riyou" | "kokuho";

export function ShogaiSeikyuContent({
  view = "seikyu",
}: {
  view?: ShogaiSeikyuView;
} = {}) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  // 対象月は請求画面共通 (SeikyuProvider) の月を使う。障害の 月次情報 と
  // 障害請求/利用請求/国保請求 が同じ月で連動する (自前月 state は廃止)。
  const { year, month, onMonthChange } = useSeikyuContext();

  // ── view ごとの表示列 (グリッド幅が右ペインで潰れて末列が切れるのを防ぐ) ──
  //   利用請求: 状態/提供月/請求月/サービス事業所 を省き、入金 を出す
  //   国保請求: 入金/利用者負担 を省く (伝送は保険給付分)
  const colState = view !== "riyou";
  const colMonths = view !== "riyou";
  const colOffice = view !== "riyou";
  const colNyukin = view === "riyou";
  const colFutan = view !== "kokuho";
  const gridTemplate = [
    "26px", // 対象
    colState && "60px", // 状態
    colMonths && "54px", // 提供月
    colMonths && "54px", // 請求月
    colOffice && "minmax(90px,0.8fr)", // サービス事業所
    "84px", // 受給者証番号
    "minmax(110px,1fr)", // 利用者名
    "48px", // 区分
    colNyukin && "56px", // 入金
    "72px", // 総単位数
    "84px", // 給付費請求額
    colFutan && "78px", // 利用者負担
  ]
    .filter(Boolean)
    .join(" ");

  const [rows, setRows] = useState<ShogaiSeikyuRow[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 集計時の注意事項 (月途中の市町村変更 等)。集計値には影響しない
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // ── 上限管理の月次ワークフロー一覧 (対象者と未処理をまとめて確認するモーダル) ──
  //   対象 = 受給者証の上限管理区分が「なし」以外。未処理 = 管理結果 (kanri_result) 未登録
  //   (自事業所管理 = 調整計算→保存が未実施 / 他事業所管理 = 結果票の入力が未実施)。
  const [jogenListOpen, setJogenListOpen] = useState(false);
  const [officeNumber, setOfficeNumber] = useState<string | null>(null);
  const [officeUnitPrice, setOfficeUnitPrice] = useState<number | undefined>(undefined);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // かな行フィルタ (介護請求の左サイドバーと同じ。null = 全)
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [statusByClient, setStatusByClient] = useState<
    Map<string, ShogaiBillingStatusRow>
  >(new Map());
  const [payments, setPayments] = useState<Map<string, ShogaiPaymentRow>>(new Map());
  const [printMode, setPrintMode] = useState<
    "meisai" | "seikyu" | "riyou" | "jisseki" | "futan" | "keiyaku" | null
  >(null);
  // 実績記録票 印刷用の月内提供実績 (client_id → visits)
  const [jissekiVisits, setJissekiVisits] = useState<
    Map<string, ShogaiDensouVisit[]>
  >(new Map());
  const [jissekiLoading, setJissekiLoading] = useState(false);
  // 契約内容報告書 印刷用の契約情報 (client_id → 受給者証の契約支給量)
  const [keiyakuEntries, setKeiyakuEntries] = useState<ShogaiKeiyakuEntry[]>([]);
  const [keiyakuLoading, setKeiyakuLoading] = useState(false);

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let unitPrice: number | undefined;
      if (currentOffice) {
        const { data: o, error: oe } = await supabase
          .from("offices")
          .select("unit_price, area_category, business_number, shogai_business_number")
          .eq("id", currentOffice.id)
          .maybeSingle();
        if (oe) throw new Error("事業所情報の取得に失敗: " + oe.message);
        const od = o as {
          unit_price?: number;
          area_category?: string | null;
          business_number?: string | null;
          shogai_business_number?: string | null;
        } | null;
        // ⚠ offices.unit_price は介護の地域区分単価。障害は人件費割合が違うため
        //   級地から障害用の単価を引く (7級地: 介護10.21 / 障害10.18)
        unitPrice = getShogaiHomonUnitPrice(od?.area_category ?? null);
        setOfficeUnitPrice(unitPrice);
        // 障害伝送は障害事業所番号を優先。未設定 (NULL) は介護 business_number にフォールバック。
        setOfficeNumber(
          ((od?.shogai_business_number ?? od?.business_number ?? "") as string).trim() ||
            null,
        );
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

  // ── shogai_billing_status (発行/伝送状態 + 月遅/返戻/過誤フラグ) を月で読み突合 ──
  // フラグ列は shogai_billing_status_flags.sql 適用後のみ。未適用 (42703) は基本列で再取得。
  const [flagColsMissing, setFlagColsMissing] = useState(false);
  const loadStatus = useCallback(async () => {
    const BASE = "client_id, issued_at, densou_target, notes";
    const EXT = `${BASE}, tsukiokure, henrei, kago`;
    let { data, error: e } = await supabase
      .from("shogai_billing_status")
      .select(EXT)
      .eq("target_month", monthStr);
    if (e && (e.code === "42703" || e.code === "PGRST204")) {
      setFlagColsMissing(true);
      ({ data, error: e } = await supabase
        .from("shogai_billing_status")
        .select(BASE)
        .eq("target_month", monthStr));
    } else if (!e) {
      setFlagColsMissing(false);
    }
    if (e) {
      // table 未作成 (migration 未適用) 時は状態なしとして続行
      if (!isMissingTable(e.code)) toast.error("請求状態の取得に失敗: " + e.message);
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(
        ((data ?? []) as unknown as ShogaiBillingStatusRow[]).map((r) => [r.client_id, r]),
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
  // ── 月遅れ/返戻/過誤の再請求 (過去月フラグ) を元提供月で再集計して合流 ──
  const [reRows, setReRows] = useState<ShogaiReSeikyuRow[]>([]);
  const [reWarnings, setReWarnings] = useState<string[]>([]);
  const loadReRows = useCallback(async () => {
    if (!currentOffice?.id) {
      setReRows([]);
      setReWarnings([]);
      return;
    }
    try {
      const res = await loadReSeikyuShogai(supabase, {
        officeId: currentOffice.id,
        unitPrice: officeUnitPrice,
        currentMonthKey: monthStr,
      });
      setReRows(res.rows);
      setReWarnings(res.warnings);
    } catch (e) {
      toast.error("障害 再請求分の集計に失敗: " + (e instanceof Error ? e.message : String(e)));
      setReRows([]);
      setReWarnings([]);
    }
  }, [supabase, currentOffice, officeUnitPrice, monthStr]);
  useEffect(() => {
    if (loading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadReRows();
  }, [loading, loadReRows]);

  // 当月の通常行 (カナ絞込)。当月に月遅/返戻/過誤フラグが立った行は「今回は伝送しない
  // (翌月へ繰越)」ので、伝送側 (displayRows) からは除外する — 介護 kokuho と同規則。
  const currentRows = useMemo(() => rows.filter(kanaMatches), [rows, kanaMatches]);

  // ── 表示行: 再請求 (過去分) を上、当月分 (全件) を下に。当月フラグ行も表示し
  //    (フラグ解除できるように)、伝送からの除外は densou 側で行う ──
  const curYm = `${year}${String(month).padStart(2, "0")}`;
  const displayRows = useMemo<DisplayRow[]>(() => {
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      ym: r.ym,
      isReSeikyu: true,
      reasons: r.__reasons,
    }));
    const cur: DisplayRow[] = currentRows.map((r) => {
      const st = statusByClient.get(r.user_id);
      const flags =
        st?.tsukiokure || st?.henrei || st?.kago
          ? {
              tsukiokure: !!st.tsukiokure,
              henrei: !!st.henrei,
              kago: !!st.kago,
            }
          : null;
      return {
        key: `cur:${r.user_id}`,
        row: r,
        origMonthKey: monthStr,
        ym: curYm,
        isReSeikyu: false,
        reasons: flags,
      };
    });
    return [...re, ...cur];
  }, [reRows, currentRows, kanaMatches, statusByClient, monthStr, curYm]);

  const filteredRows = currentRows;

  // 上限管理の対象 (区分 なし 以外) と未処理 (管理結果未登録)。カナ絞込に依らず全行から集計
  const jogenTargets = useMemo(
    () => rows.filter((r) => r.jogenKanriKubun !== "なし"),
    [rows],
  );
  const jogenPending = useMemo(
    () => jogenTargets.filter((r) => r.kanriResult == null),
    [jogenTargets],
  );

  // 選択行 (右ペイン明細)。key は displayRows のキー (再請求と当月で衝突しない)
  const selectedDisplay =
    displayRows.find((d) => d.key === selectedKey) ?? displayRows[0] ?? null;
  const selected = selectedDisplay?.row ?? null;
  const totalUnits = filteredRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalBenefit = filteredRows.reduce((s, r) => s + r.benefitAmount, 0);
  const totalUser = filteredRows.reduce((s, r) => s + r.userAmount, 0);

  // ── 対象チェック (key 単位。チェックあり → その行 / なし → 表示中全件) ──
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
  // 発行/印刷用 (ShogaiSeikyuRow[])。当月フラグ行も含む (発行はできる。伝送は別除外)
  const targetDisplays = useMemo(
    () =>
      checked.size > 0
        ? displayRows.filter((d) => checked.has(d.key))
        : displayRows,
    [displayRows, checked],
  );
  const targets = useMemo(() => targetDisplays.map((d) => d.row), [targetDisplays]);
  const allChecked =
    displayRows.length > 0 && checked.size === displayRows.length;
  // 伝送対象件数 (当月の densou_target 済 + 再請求行はすべて伝送候補)
  const densouCount =
    filteredRows.filter((r) => statusByClient.get(r.user_id)?.densou_target).length +
    reRows.length;

  // ── 月遅/返戻/過誤フラグの設定 (当月行のみ)。true にすると当月伝送から外れ、
  //    翌月に再請求として合流する。既存フラグは保持し対象のみ更新 (介護と同規則) ──
  const setFlag = async (
    clientId: string,
    field: "tsukiokure" | "henrei" | "kago",
    value: boolean,
  ) => {
    if (flagColsMissing) {
      toast.warning(
        "再請求フラグには migrations/shogai_billing_status_flags.sql の適用が必要です",
      );
      return;
    }
    const cur = statusByClient.get(clientId);
    const { error: e } = await supabase.from("shogai_billing_status").upsert(
      {
        client_id: clientId,
        target_month: monthStr,
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        office_id: currentOffice?.id ?? null,
        tsukiokure: cur?.tsukiokure ?? false,
        henrei: cur?.henrei ?? false,
        kago: cur?.kago ?? false,
        [field]: value,
      },
      { onConflict: "client_id,target_month" },
    );
    if (e) {
      toast.error("フラグの保存に失敗: " + e.message);
      return;
    }
    loadStatus();
  };

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

  // ── 利用者負担額一覧表: 自事業所が「非」管理者の対象者を上限管理事業所へ提出 ──
  const futanIchiranRows = useMemo(
    () => targets.filter((r) => r.jogenKanriKubun === "他事業所"),
    [targets],
  );
  const printFutanIchiran = () => {
    if (futanIchiranRows.length === 0) {
      toast.info("上限管理を他事業所に依頼する対象者がいません (負担額一覧表は不要です)");
      return;
    }
    setPrintMode("futan");
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 100);
  };

  // ── 契約内容報告書: 受給者証の契約支給量を市町村へ報告 (対象者ぶん 1 名 1 枚) ──
  const printKeiyakuHoukoku = async () => {
    if (targets.length === 0) return;
    setKeiyakuLoading(true);
    try {
      const ids = targets.map((r) => r.user_id);
      const byClient = new Map<
        string,
        { text: string | null; start: string | null; entry: string | null; holder: string | null }
      >();
      for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
        const chunk = ids.slice(i, i + ID_IN_CHUNK);
        // holder_name_kana は shougai_cert_holder_kana.sql 未適用の環境があるので
        //   42703 (undefined_column) のときは列を落として再取得する
        let { data, error } = await supabase
          .from("shougai_certifications")
          .select(
            "client_id, contract_amount_text, contract_start_date, contract_entry_number, holder_name_kana, certification_start_date",
          )
          .in("client_id", chunk)
          .order("certification_start_date", { ascending: false });
        if (error?.code === "42703") {
          const fb = await supabase
            .from("shougai_certifications")
            .select(
              "client_id, contract_amount_text, contract_start_date, contract_entry_number, certification_start_date",
            )
            .in("client_id", chunk)
            .order("certification_start_date", { ascending: false });
          data = (fb.data ?? []) as unknown as typeof data;
          error = fb.error;
        }
        if (error) throw new Error(error.message);
        for (const c of (data ?? []) as {
          client_id: string;
          contract_amount_text: string | null;
          contract_start_date: string | null;
          contract_entry_number: string | null;
          holder_name_kana?: string | null;
        }[]) {
          if (!byClient.has(c.client_id)) {
            byClient.set(c.client_id, {
              text: c.contract_amount_text,
              start: c.contract_start_date,
              entry: c.contract_entry_number,
              holder: c.holder_name_kana ?? null,
            });
          }
        }
      }
      const entries: ShogaiKeiyakuEntry[] = targets.map((r) => {
        const c = byClient.get(r.user_id);
        return {
          row: r,
          contractAmountText: c?.text ?? null,
          contractStartDate: c?.start ?? null,
          contractEntryNumber: c?.entry ?? null,
        };
      });
      setKeiyakuEntries(entries);
      const missing = entries.filter((e) => !e.contractAmountText).length;
      if (missing > 0) {
        toast.warning(
          `契約支給量が未入力の利用者が ${missing} 名います (受給者証ページで入力してください)`,
        );
      }
    } catch (e) {
      toast.error("契約情報の取得に失敗: " + (e instanceof Error ? e.message : String(e)));
      setKeiyakuLoading(false);
      return;
    }
    setKeiyakuLoading(false);
    setPrintMode("keiyaku");
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
  //   再請求行は元提供月 (origMonthKey) のレコードを対象化し、フラグは保持したまま
  //   densou_target=true にして翌月一覧から落とす (二重伝送防止)。
  const markDensouTarget = async () => {
    const payload: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const d of targetDisplays) {
      const r = d.row;
      if (d.isReSeikyu) {
        // 元提供月のフラグを保持しつつ densou_target 化 (未発行チェックはしない)
        payload.push({
          client_id: r.user_id,
          target_month: d.origMonthKey,
          tenant_id: currentOffice?.tenant_id ?? "kt-group",
          office_id: currentOffice?.id ?? null,
          densou_target: true,
          tsukiokure: d.reasons?.tsukiokure ?? false,
          henrei: d.reasons?.henrei ?? false,
          kago: d.reasons?.kago ?? false,
        });
        continue;
      }
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
    loadReRows(); // 元提供月を densou_target 化した再請求行を一覧から落とす
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
  // 集計 (aggregate) と同じく shogai_service_records (confirmed) と
  // kaigo_visit_schedule (completed, 障害サービス名) の union。
  // 同一 client×code×date はスケジュール優先で重複排除 (二重計上防止)。
  // 引数省略時は当月。再請求の元提供月ぶんを取るときは (y, m) を渡す
  const loadMonthVisits = useCallback(async (
    y: number = year,
    m: number = month,
  ): Promise<Map<string, ShogaiDensouVisit[]>> => {
    const mStr = `${y}-${String(m).padStart(2, "0")}`;
    const daysInMonth = new Date(y, m, 0).getDate();
    const from = `${mStr}-01`;
    const to = `${mStr}-${String(daysInMonth).padStart(2, "0")}`;
    interface RawVisit {
      client: string;
      visit: ShogaiDensouVisit;
    }
    const recRows: RawVisit[] = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      let q = supabase
        .from("shogai_service_records")
        .select(
          "client_id, service_date, start_time, end_time, duration_minutes, service_category, service_code",
        )
        .eq("status", "confirmed")
        .gte("service_date", from)
        .lte("service_date", to);
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
        recRows.push({
          client: rec.client_id,
          visit: {
            date: rec.service_date,
            startTime: rec.start_time,
            endTime: rec.end_time,
            durationMinutes: rec.duration_minutes,
            category: rec.service_category,
            serviceCode: rec.service_code,
            serviceName: null, // 後段で 12xxxx (重訪) のみマスタから逆引き
          },
        });
      }
      if (recs.length < PAGE) break;
      offset += PAGE;
    }

    // ── シフト/提供表 (kaigo_visit_schedule の completed) の障害実績を統合 ──
    // service_type (サービス名) が障害マスタ (system='障害', validInMonth) に解決できる
    // 行のみ障害実績とみなす (介護/総合は解決に失敗して自然に除外) — aggregate と同ロジック
    const schedRaw: RawVisit[] = [];
    {
      interface SchedRow {
        user_id: string;
        service_type: string | null;
        visit_date: string;
        start_time: string | null;
        end_time: string | null;
        notes: string | null;
      }
      const schedRows: SchedRow[] = [];
      let soff = 0;
      let schedOk = true;
      while (true) {
        let sq = supabase
          .from("kaigo_visit_schedule")
          .select("user_id, service_type, visit_date, start_time, end_time, notes")
          .eq("status", "completed")
          .gte("visit_date", from)
          .lte("visit_date", to);
        if (currentOffice) {
          sq = sq.or(`office_id.eq.${currentOffice.id},office_id.is.null`);
        }
        const { data, error } = await sq.order("id").range(soff, soff + PAGE - 1);
        if (error) {
          // office_id 列未適用(42703) 等は schedule 連携をスキップ (握らず warn)
          console.warn(
            "[shogai] シフト実績の取得に失敗 (実績記録票への連携スキップ):",
            error.message,
          );
          schedOk = false;
          break;
        }
        const rows = (data ?? []) as SchedRow[];
        schedRows.push(...rows);
        if (rows.length < PAGE) break;
        soff += PAGE;
      }
      if (schedOk && schedRows.length > 0) {
        const names = Array.from(
          new Set(
            schedRows.map((s) => (s.service_type ?? "").trim()).filter(Boolean),
          ),
        );
        const nameMap = new Map<string, { code: string; category: string | null }>();
        for (let i = 0; i < names.length; i += NAME_IN_CHUNK) {
          const chunk = names.slice(i, i + NAME_IN_CHUNK);
          const { data, error } = await validInMonth(
            supabase
              .from("kaigo_service_codes")
              .select("service_code, service_name, service_category")
              .eq("system", "障害")
              .in("service_name", chunk),
            y,
            m,
          );
          if (error) {
            console.warn("[shogai] 障害コード解決に失敗 (一部スキップ):", error.message);
            continue;
          }
          for (const c of (data ?? []) as {
            service_code: string;
            service_name: string;
            service_category: string | null;
          }[]) {
            const k = c.service_name.trim();
            if (!nameMap.has(k)) {
              nameMap.set(k, { code: c.service_code, category: c.service_category });
            }
          }
        }
        // "HH:MM(:SS)" 2 つから分数を計算 (0 時またぎは +24h 扱い)
        const diffMinutes = (s: string | null, e: string | null): number | null => {
          if (!s || !e) return null;
          const toMin = (t: string) =>
            Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
          let d = toMin(e) - toMin(s);
          if (d < 0) d += 24 * 60;
          return d;
        };
        for (const s of schedRows) {
          const name = (s.service_type ?? "").trim();
          const m = nameMap.get(name);
          if (!m) continue; // 障害コードに解決できない = 介護/総合 → スキップ
          schedRaw.push({
            client: s.user_id,
            visit: {
              date: s.visit_date,
              startTime: s.start_time,
              endTime: s.end_time,
              durationMinutes: diffMinutes(s.start_time, s.end_time),
              category: m.category,
              serviceCode: m.code,
              serviceName: name,
              isAddon: isAddonRecord(s.notes),
              isSessionSub: isSessionSubRecord(s.notes),
            },
          });
        }
      }
    }

    // ── 重複排除: 同一 client×code×date はスケジュール優先 (aggregate と同条件) ──
    const keyOf = (r: RawVisit) =>
      `${r.client}__${r.visit.serviceCode ?? ""}__${r.visit.date}`;
    const schedKeys = new Set(schedRaw.map(keyOf));
    const merged = [
      ...recRows.filter((r) => !schedKeys.has(keyOf(r))),
      ...schedRaw,
    ];

    // ── shogai_service_records 由来の重訪 (12xxxx) にサービス名を逆引き付与 ──
    // (「・２人」「・同行ｎ」の派遣人数/同行支援判定は名前でしかできないため)
    const juhoCodes = Array.from(
      new Set(
        merged
          .filter(
            (r) =>
              r.visit.serviceName == null &&
              (r.visit.serviceCode ?? "").startsWith("12"),
          )
          .map((r) => r.visit.serviceCode!),
      ),
    );
    if (juhoCodes.length > 0) {
      const codeNameMap = new Map<string, string>();
      for (let i = 0; i < juhoCodes.length; i += ID_IN_CHUNK) {
        const chunk = juhoCodes.slice(i, i + ID_IN_CHUNK);
        const { data, error } = await validInMonth(
          supabase
            .from("kaigo_service_codes")
            .select("service_code, service_name")
            .eq("system", "障害")
            .in("service_code", chunk),
          y,
          m,
        );
        if (error) {
          console.warn("[shogai] 重訪コード名の逆引きに失敗 (一部スキップ):", error.message);
          continue;
        }
        for (const c of (data ?? []) as { service_code: string; service_name: string }[]) {
          if (!codeNameMap.has(c.service_code)) {
            codeNameMap.set(c.service_code, c.service_name);
          }
        }
      }
      for (const r of merged) {
        if (r.visit.serviceName == null && r.visit.serviceCode) {
          r.visit.serviceName = codeNameMap.get(r.visit.serviceCode) ?? null;
        }
      }
    }

    const visitsByClient = new Map<string, ShogaiDensouVisit[]>();
    for (const r of merged) {
      if (!visitsByClient.has(r.client)) visitsByClient.set(r.client, []);
      visitsByClient.get(r.client)!.push(r.visit);
    }
    return visitsByClient;
  }, [supabase, currentOffice, year, month]);

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
    setDensouLoading(true);
    try {
      // 1) 事業所番号・単価・地域区分 (月をまたいで共通)
      const { data: o, error: oe } = await supabase
        .from("offices")
        .select(
          "business_number, shogai_business_number, unit_price, area_category",
        )
        .eq("id", currentOffice?.id ?? "")
        .maybeSingle();
      if (oe) throw new Error("事業所情報取得失敗: " + oe.message);
      // 障害伝送は障害事業所番号を優先。未設定 (NULL) は介護 business_number にフォールバック。
      const officeNumber = ((o?.shogai_business_number ??
        o?.business_number ??
        "") as string).trim();
      const areaCategory = (o?.area_category ?? null) as string | null;
      // ⚠ 介護の unit_price ではなく障害用の地域区分単価を使う
      const unitPrice = getShogaiHomonUnitPrice(areaCategory);

      // 対象月ぶんの users を組み立てて buildShogaiDensou を実行するヘルパ。
      // 当月分と、再請求の元提供月ぶんを「別々の月」で呼ぶことで、伝送ファイルを
      // 元提供月ごとに分けて出力する (介護 kokuho と同じ考え方)。
      const buildForMonth = async (
        monthRows: ShogaiSeikyuRow[],
        y: number,
        m: number,
      ) => {
        const mStr = `${y}-${String(m).padStart(2, "0")}`;
        const visitsByClient = await loadMonthVisits(y, m);
        // 契約支給量 (契約情報レコード J121-05)
        const ids = monthRows.map((r) => r.user_id);
        const contractByClient = new Map<
          string,
          { text: string | null; start: string | null; entry: string | null; holder: string | null }
        >();
        for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
          const chunk = ids.slice(i, i + ID_IN_CHUNK);
          // holder_name_kana は shougai_cert_holder_kana.sql 未適用の環境があるので
          //   42703 (undefined_column) のときは列を落として再取得する
          let { data, error } = await supabase
            .from("shougai_certifications")
            .select(
              "client_id, contract_amount_text, contract_start_date, contract_entry_number, holder_name_kana, certification_start_date",
            )
            .in("client_id", chunk)
            .order("certification_start_date", { ascending: false });
          if (error?.code === "42703") {
            const fb = await supabase
              .from("shougai_certifications")
              .select(
                "client_id, contract_amount_text, contract_start_date, contract_entry_number, certification_start_date",
              )
              .in("client_id", chunk)
              .order("certification_start_date", { ascending: false });
            data = (fb.data ?? []) as unknown as typeof data;
            error = fb.error;
          }
          if (error) throw new Error("受給者証取得失敗: " + error.message);
          for (const c of (data ?? []) as {
            client_id: string;
            contract_amount_text: string | null;
            contract_start_date: string | null;
            contract_entry_number: string | null;
            holder_name_kana?: string | null;
          }[]) {
            if (!contractByClient.has(c.client_id)) {
              contractByClient.set(c.client_id, {
                text: c.contract_amount_text,
                start: c.contract_start_date,
                entry: c.contract_entry_number,
                holder: c.holder_name_kana ?? null,
              });
            }
          }
        }
        // 自事業所上限管理の関係事業所一覧 (J411)。その月の結果を引く
        const selfIds = monthRows
          .filter((r) => r.jogenKanriKubun === "自事業所")
          .map((r) => r.user_id);
        const linesByClient = new Map<string, ShogaiDensouKanriLine[]>();
        if (selfIds.length > 0) {
          const { data, error } = await supabase
            .from("shogai_jogen_kanri_results")
            .select("client_id, office_lines")
            .eq("target_month", mStr)
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
        const users: ShogaiDensouUser[] = monthRows.map((r) => {
          const contract = contractByClient.get(r.user_id);
          return {
            row: r,
            visits: visitsByClient.get(r.user_id) ?? [],
            contractAmountText: contract?.text ?? null,
            contractStartDate: contract?.start ?? null,
            contractEntryNumber: contract?.entry ?? null,
            holderNameKana: contract?.holder ?? null,
            jogenOfficeLines: linesByClient.get(r.user_id) ?? null,
          };
        });
        return buildShogaiDensou(users, {
          officeNumber,
          year: y,
          month: m,
          unitPrice,
          areaCategory,
        });
      };

      // 当月分: 月遅/返戻/過誤フラグの立った行は今回の伝送から除外 (翌月に再請求繰越)
      const currentEligible = rows.filter((r) => {
        const st = statusByClient.get(r.user_id);
        return !(st?.tsukiokure || st?.henrei || st?.kago);
      });
      // 再請求分: 元提供月ごとにグループ化
      const reByMonth = new Map<string, ShogaiReSeikyuRow[]>();
      for (const r of reRows) {
        if (!reByMonth.has(r.__origMonthKey)) reByMonth.set(r.__origMonthKey, []);
        reByMonth.get(r.__origMonthKey)!.push(r);
      }

      if (currentEligible.length === 0 && reByMonth.size === 0) {
        alert("伝送対象の行がありません (当月分がフラグで繰越、再請求も無し)。");
        return;
      }

      // 各月ぶんを生成
      const results: {
        label: string;
        result: Awaited<ReturnType<typeof buildForMonth>>;
      }[] = [];
      if (currentEligible.length > 0) {
        results.push({ label: `当月 (${year}年${month}月)`, result: await buildForMonth(currentEligible, year, month) });
      }
      for (const [mk, grp] of reByMonth) {
        const [gy, gm] = mk.split("-").map((n) => Number(n));
        results.push({ label: `再請求 (${gy}年${gm}月)`, result: await buildForMonth(grp, gy, gm) });
      }

      const allWarnings = results.flatMap((x) => x.result.warnings);
      if (allWarnings.length > 0) {
        const ok = window.confirm(
          "以下の確認事項があります:\n\n・" +
            allWarnings.join("\n・") +
            "\n\nこのまま出力しますか？",
        );
        if (!ok) return;
      }
      for (const { result } of results) {
        downloadSjis(result.seikyuFile);
        downloadSjis(result.jissekiFile);
        if (result.jogenFile) downloadSjis(result.jogenFile);
      }
      if (reByMonth.size > 0) {
        toast.success(
          `伝送ファイルを ${results.length} 月分 (当月 + 再請求 ${reByMonth.size} 月) 出力しました`,
        );
      }
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
    {/* ── 上限管理の月次ワークフロー一覧 (対象者・未処理の確認 → 行クリックで移動) ── */}
    {jogenListOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 print:hidden">
        <div className="flex max-h-full w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
          <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <ClipboardList size={15} className="text-violet-600" />
              利用者負担上限額管理 — {year}年{month}月
              <span className="text-xs font-normal text-gray-500">
                対象 {jogenTargets.length} 名
                {jogenPending.length > 0 && (
                  <span className="ml-1 font-bold text-amber-700">/ 未処理 {jogenPending.length} 名</span>
                )}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setJogenListOpen(false)}
              className="text-gray-400 hover:text-gray-600"
              title="閉じる"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-auto px-4 py-3">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-gray-50 text-[11px] text-gray-500">
                <tr>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-left">利用者名</th>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-center">管理区分</th>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-right">上限月額</th>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-right">利用者負担</th>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-center">管理結果</th>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-right">結果額</th>
                  <th className="border-b border-gray-200 px-2 py-1.5 text-center">状態</th>
                </tr>
              </thead>
              <tbody>
                {jogenTargets.map((r) => {
                  const pending = r.kanriResult == null;
                  return (
                    <tr
                      key={r.user_id}
                      onClick={() => {
                        setSelectedKey(`cur:${r.user_id}`);
                        setJogenListOpen(false);
                      }}
                      className="cursor-pointer border-b border-gray-100 hover:bg-violet-50"
                      title="クリックで該当利用者の上限管理ブロックへ移動"
                    >
                      <td className="px-2 py-1.5 font-medium text-gray-800">{r.user_name}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span
                          className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            r.jogenKanriKubun === "自事業所"
                              ? "bg-violet-100 text-violet-700"
                              : "bg-sky-100 text-sky-700"
                          }`}
                        >
                          {r.jogenKanriKubun === "自事業所" ? "自事業所が管理" : "他事業所が管理"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.self_payment_limit != null
                          ? `¥${r.self_payment_limit.toLocaleString()}`
                          : "未設定"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        ¥{r.userAmount.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {r.kanriResult != null ? `区分${r.kanriResult}` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.kanriResultAmount != null
                          ? `¥${r.kanriResultAmount.toLocaleString()}`
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {pending ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                            未処理
                          </span>
                        ) : (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            登録済
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              未処理 = 管理結果が未登録 (自事業所が管理者 → 調整計算して保存 / 他事業所が管理者 →
              届いた結果票の区分・金額を入力)。行をクリックすると該当利用者の上限管理ブロックに移動します。
              上限月額が「未設定」の場合は受給者証ページで負担上限月額を入力してください。
            </p>
          </div>
        </div>
      </div>
    )}

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
      <div className={`flex flex-col flex-1 min-w-0 ${view === "kokuho" ? "" : "border-r border-gray-200"}`}>
        {/* ── ツールバー ── */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <MonthNav year={year} month={month} onChange={onMonthChange} />
          <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">
            {view === "riyou" ? "利用請求" : view === "kokuho" ? "国保伝送" : "請求分"}
          </span>
          <span className="text-xs text-gray-500">{filteredRows.length} 件</span>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          {/* 障害請求 (レセプト): 明細書 / 実績記録票 / 総括請求書 */}
          {view === "seikyu" && (
            <>
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
                disabled={keiyakuLoading}
                onClick={printKeiyakuHoukoku}
                className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
                title="受給者証の契約支給量を市町村へ報告する「契約内容報告書」を印刷 (対象者 1 名 = 1 枚)"
              >
                {keiyakuLoading ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                契約報告書
              </button>
              <button
                type="button"
                disabled={futanIchiranRows.length === 0}
                onClick={printFutanIchiran}
                className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
                title="上限管理を他事業所に依頼する対象者について、当事業所の総費用額・利用者負担額を記載した「利用者負担額一覧表」を印刷 (上限管理事業所へ提出)"
              >
                <Printer size={13} />負担額一覧表
                {futanIchiranRows.length > 0 && ` (${futanIchiranRows.length})`}
              </button>
              <button
                type="button"
                disabled={jogenTargets.length === 0}
                onClick={() => setJogenListOpen(true)}
                className="border border-violet-500 rounded bg-violet-50 px-2.5 py-1 text-violet-700 hover:bg-violet-100 flex items-center gap-1.5 disabled:opacity-50"
                title="上限額管理の対象者一覧。未処理 (管理結果の未登録) をまとめて確認し、行クリックで該当利用者の管理ブロックへ移動します"
              >
                <ClipboardList size={13} />
                上限管理 ({jogenTargets.length})
                {jogenPending.length > 0 && (
                  <span className="rounded bg-amber-200 px-1 text-[10px] font-bold text-amber-800">
                    未 {jogenPending.length}
                  </span>
                )}
              </button>
            </>
          )}
          {/* 利用請求: 利用料請求書 (本人負担分) */}
          {view === "riyou" && (
            <button
              type="button"
              disabled={filteredRows.length === 0}
              onClick={printRiyouSeikyu}
              className="border border-emerald-500 rounded bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1.5 disabled:opacity-50"
              title="利用者向けの利用料請求書 (利用者負担額) を発行・印刷。発行日を記録します"
            >
              <Receipt size={13} />利用料請求書 ({targets.length}件)
            </button>
          )}
          {/* 国保請求: 伝送対象化 / 確認用CSV / 伝送ファイル (J11/J61/J41) */}
          {view === "kokuho" && (
            <>
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
            </>
          )}
        </div>

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {reRows.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              過去月の月遅れ・返戻・過誤 {reRows.length} 件を当月請求に合流しています
              (元提供月のファイルとして伝送)。伝送対象化すると一覧から外れます。
            </span>
          </div>
        )}

        {(warnings.length > 0 || reWarnings.length > 0) && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              {[...new Set([...warnings, ...reWarnings])].map((w, i) => (
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
              <div
                className="grid border-b border-gray-400 bg-gradient-to-b from-sky-100 to-sky-200 text-[11px] leading-4 font-medium text-gray-700 text-center sticky top-0 z-10"
                style={{ gridTemplateColumns: gridTemplate }}
              >
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
                {colState && <div className="px-1 py-0.5 border-l border-sky-300">状態</div>}
                {colMonths && <div className="px-1 py-0.5 border-l border-sky-300">提供月</div>}
                {colMonths && <div className="px-1 py-0.5 border-l border-sky-300">請求月</div>}
                {colOffice && <div className="px-1 py-0.5 border-l border-sky-300">サービス事業所</div>}
                <div className="px-1 py-0.5 border-l border-sky-300">受給者証番号</div>
                <div className="px-1 py-0.5 border-l border-sky-300">利用者名</div>
                <div className="px-1 py-0.5 border-l border-sky-300">区分</div>
                {colNyukin && <div className="px-1 py-0.5 border-l border-sky-300">入金</div>}
                <div className="px-1 py-0.5 border-l border-sky-300">総単位数</div>
                <div className="px-1 py-0.5 border-l border-sky-300">給付費請求額</div>
                {colFutan && <div className="px-1 py-0.5 border-l border-sky-300">利用者負担</div>}
              </div>

              {displayRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">
                  対象月の実績 (確定) がありません。障害福祉 → サービス提供実績 で記録を確定してください。
                </p>
              ) : displayRows.map((d) => {
                const r = d.row;
                const st = d.isReSeikyu ? undefined : statusByClient.get(r.user_id);
                const isDetail = selectedKey === d.key;
                const isChecked = checked.has(d.key);
                // 元提供月 (再請求は過去月、当月行は当月)
                const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
                return (
                  <div
                    key={d.key}
                    onClick={() => setSelectedKey(isDetail ? null : d.key)}
                    style={{ gridTemplateColumns: gridTemplate }}
                    className={`grid border-b border-gray-200 text-[11px] leading-4 cursor-pointer transition-colors ${
                      isDetail
                        ? "bg-violet-100"
                        : isChecked
                        ? "bg-violet-50"
                        : "bg-white hover:bg-sky-50"
                    }`}
                  >
                    <div className="px-1 py-0.5 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggle(d.key)}
                        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-all ${
                          isChecked ? "border-violet-500 bg-violet-500" : "border-gray-400 bg-white"
                        }`}
                      >
                        {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                      </button>
                    </div>
                    {/* 状態: 再請求=琥珀 / 伝送対象=赤 / 発行済=緑 / 未発行=灰。
                        当月に月遅/返戻/過誤フラグが立つと「(繰越)」を添えて伝送保留を示す */}
                    {colState && (
                      <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                        {d.isReSeikyu ? (
                          <span className="text-amber-700">
                            再請求
                            {d.reasons &&
                              (d.reasons.kago ? "(過誤)" : d.reasons.henrei ? "(返戻)" : "(月遅)")}
                          </span>
                        ) : st?.densou_target ? (
                          <span className="text-red-600">伝送対象</span>
                        ) : d.reasons ? (
                          <span className="text-amber-600">
                            {d.reasons.kago ? "過誤" : d.reasons.henrei ? "返戻" : "月遅"}(繰越)
                          </span>
                        ) : st?.issued_at ? (
                          <span className="text-emerald-700">発行済</span>
                        ) : (
                          <span className="text-gray-600">未発行</span>
                        )}
                      </div>
                    )}
                    {/* 提供月 (再請求は元提供月) / 請求月 = 当月 */}
                    {colMonths && (
                      <div className={`px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre ${d.isReSeikyu ? "bg-yellow-100 text-gray-700" : "text-gray-700"}`}>
                        {reiwaMonth(oy || year, om || month)}
                      </div>
                    )}
                    {colMonths && (
                      <div className="px-1 py-0.5 border-l border-gray-200 font-mono whitespace-pre text-gray-700">
                        {reiwaMonth(year, month)}
                      </div>
                    )}
                    {colOffice && (
                      <div className="min-w-0 px-1 py-0.5 border-l border-gray-200 text-gray-700 truncate" title={currentOffice?.name ?? ""}>
                        {currentOffice?.name ?? ""}
                      </div>
                    )}
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
                    {colNyukin && (
                      <div className="px-1 py-0.5 border-l border-gray-200 text-center">
                        {paymentBadge(r.user_id)}
                      </div>
                    )}
                    <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-800 tabular-nums">
                      {r.totalUnits.toLocaleString()}
                    </div>
                    <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono font-semibold text-violet-700 tabular-nums">
                      {r.benefitAmount.toLocaleString()}
                    </div>
                    {colFutan && (
                      <div className="px-1 py-0.5 border-l border-gray-200 text-right font-mono text-gray-800 tabular-nums">
                        {r.userAmount.toLocaleString()}
                      </div>
                    )}
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

      {/* ── 右：明細情報 (介護請求と同じ 青系帯 + 高密度明細)。障害固有ブロック(上限管理/入金管理)を内包。
             国保請求は伝送リストのみで明細ペイン非表示 (介護国保とレイアウトを揃える) ── */}
      {view !== "kokuho" && (
      <div className="w-96 shrink-0 flex flex-col bg-white">
        <div className="border-b border-sky-700 bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-1 text-xs font-bold text-white flex items-center gap-2">
          <span>明細情報</span>
          {selected && <span className="font-normal text-sky-100 truncate">{selected.user_name}</span>}
        </div>
        {selected ? (
          <div className="flex-1 overflow-auto">
            {/* 明細テーブル: 列構成を介護請求ペインと統一
                (サービス内容 / 単位数/単価 / 回数 / 単位数 / 摘要=コード) */}
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
                {selected.details.map((d, i) => (
                  <tr key={i} className="border-b border-gray-200 bg-white">
                    <td className="px-1 py-0.5 text-gray-700 leading-tight border-r border-gray-200">
                      {d.service_type}
                      {d.service_category && (
                        <span className="ml-1 text-[9px] text-gray-400">{d.service_category}</span>
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">
                      {d.unit_per.toLocaleString()}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">
                      {d.count}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-800 border-r border-gray-200 tabular-nums">
                      {d.units.toLocaleString()}
                    </td>
                    <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono truncate" title={d.service_code ?? ""}>
                      {d.service_code ?? ""}
                    </td>
                  </tr>
                ))}
                {/* 処遇改善加算等 (月次加算、回数 1) */}
                {selected.addons.map((a) => (
                  <tr key={a.service_code} className="border-b border-gray-200 bg-violet-50/60">
                    <td className="px-1 py-0.5 text-violet-700 leading-tight border-r border-gray-200">
                      {a.service_name}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">
                      {a.units.toLocaleString()}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-700 border-r border-gray-200 tabular-nums">1</td>
                    <td className="px-1 py-0.5 text-right font-mono text-gray-800 border-r border-gray-200 tabular-nums">
                      {a.units.toLocaleString()}
                    </td>
                    <td className="px-1 py-0.5 text-gray-500 text-[10px] font-mono truncate" title={a.service_code}>
                      {a.service_code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* ── 金額サマリ (介護請求 右下と同じ ラベル箱/値箱 4 列 grid) ── */}
            <div className="border-t border-gray-400 bg-gray-100 shrink-0 p-1.5">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-px bg-gray-400 border border-gray-400 text-[11px] leading-4">
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">合計単位数</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.totalUnits.toLocaleString()}</div>
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap" title={selected.addonLabel ?? "処遇改善加算"}>
                  うち処遇改善
                </div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">
                  {selected.addonUnits > 0 ? selected.addonUnits.toLocaleString() : ""}
                </div>
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">地域単価</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">{selected.unitPrice.toFixed(2)} 円/単位</div>
                <div className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap">総費用額</div>
                <div className="bg-white px-1.5 py-0.5 text-right font-mono text-gray-800">¥{selected.totalAmount.toLocaleString()}</div>
                <div
                  className="bg-sky-100 px-1.5 py-0.5 whitespace-nowrap"
                  title={selected.seiho ? "生保のため負担なし (0 円に正規化)" : "受給者証の負担上限月額"}
                >
                  負担上限月額{selected.seiho ? " (生保)" : ""}
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
                <div className="bg-white px-1.5 py-0.5 text-right font-mono font-bold text-violet-700" style={{ gridColumn: "2 / -1" }}>
                  ¥{selected.benefitAmount.toLocaleString()}
                </div>
              </div>

              {/* ── 月遅れ/返戻/過誤フラグ (障害請求ビューの当月行のみ)。ON で当月伝送から
                     外れ翌月に再請求合流。再請求行 (過去分) には出さない ── */}
              {view === "seikyu" && !selectedDisplay?.isReSeikyu && (
                <div className="mt-3 rounded border border-amber-200 bg-amber-50/50 p-2 text-xs">
                  <div className="mb-1 font-bold text-amber-800">再請求フラグ (月遅れ / 返戻 / 過誤)</div>
                  {flagColsMissing ? (
                    <p className="text-[11px] text-amber-700">
                      migrations/shogai_billing_status_flags.sql を適用すると使えます。
                    </p>
                  ) : (
                    <>
                      <div className="flex gap-1.5">
                        {([
                          { f: "tsukiokure" as const, label: "月遅れ" },
                          { f: "henrei" as const, label: "返戻" },
                          { f: "kago" as const, label: "過誤" },
                        ]).map(({ f, label }) => {
                          const st = statusByClient.get(selected.user_id);
                          const on = !!st?.[f];
                          return (
                            <button
                              key={f}
                              type="button"
                              onClick={() => setFlag(selected.user_id, f, !on)}
                              className={`flex-1 rounded border px-1.5 py-1 font-medium transition-colors ${
                                on
                                  ? "border-red-400 bg-red-100 text-red-700"
                                  : "border-gray-300 bg-white text-gray-500 hover:bg-gray-50"
                              }`}
                            >
                              {label}
                              {on ? " ✓" : ""}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-gray-500">
                        いずれか ON = 今月は伝送せず、翌月の請求に「再請求」として自動合流します
                        (伝送は元の提供月のファイルで出力)。返戻・過誤の原因を直してから翌月に伝送してください。
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* ── 障害固有: 利用者負担上限額管理 (このペインは国保請求では非表示なので常時表示) ── */}
              <JogenKanriSection
                key={`${selected.user_id}-${year}-${month}`}
                row={selected}
                year={year}
                month={month}
                onSaved={load}
              />

              {/* ── 障害固有: 入金管理 (利用料請求の未収金管理。利用請求タブのみ) ── */}
              {view === "riyou" && (
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
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
            行を選択してください
          </div>
        )}
      </div>
      )}
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

    {/* ===== 印刷 view: サービス提供実績記録票 (様式1 居宅介護) — 利用者 1 名 = 1 枚 =====
        重度訪問介護 (12xxxx) は様式3-1 のため様式1 印刷から除外 (印刷様式は未実装。伝送 J611 は 0301 対応済) */}
    {printMode === "jisseki" && (
      <div className="hidden print:block">
        {targets.map((r) => (
          <ShogaiJissekiKirokuhyoPrintSheet
            key={r.user_id}
            row={r}
            visits={(jissekiVisits.get(r.user_id) ?? []).filter(
              (v) => !(v.serviceCode ?? "").startsWith("12"),
            )}
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

    {/* ===== 印刷 view: 利用者負担額一覧表 (上限管理事業所へ提出。1 枚) ===== */}
    {printMode === "futan" && (
      <div className="hidden print:block">
        <ShogaiFutanIchiranPrintSheet
          rows={futanIchiranRows}
          officeName={currentOffice?.name ?? null}
          officeNumber={officeNumber}
          reiwa={year - 2018}
          month={month}
        />
      </div>
    )}

    {/* ===== 印刷 view: 契約内容報告書 (市町村へ。利用者 1 名 = 1 枚) ===== */}
    {printMode === "keiyaku" && (
      <div className="hidden print:block">
        {keiyakuEntries.map((e) => (
          <ShogaiKeiyakuHoukokuPrintSheet
            key={e.row.user_id}
            entry={e}
            officeName={currentOffice?.name ?? null}
            officeNumber={officeNumber}
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
        <Link
          href={`/users/${row.user_id}/shougai-cert`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 whitespace-nowrap font-medium text-indigo-600 underline decoration-dotted hover:text-indigo-700"
        >
          → 受給者証を設定
        </Link>
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

// 関係事業所の入力候補 (自社 offices + 他社 kaigo_service_providers)。
// 毎月同じ事業所を手打ちしなくて済むよう datalist で提示し、名称一致で番号を自動補完。
// module レベル cache で session 内 1 回だけ fetch (利用者・月をまたいで共有)。
interface KanriOfficeOption {
  number: string;
  name: string;
}
let kanriOfficeOptionsCache: KanriOfficeOption[] | null = null;

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

  // 関係事業所の候補 (自社 offices + 他社 providers)。cache 済みなら fetch しない
  const [officeOptions, setOfficeOptions] = useState<KanriOfficeOption[]>(
    kanriOfficeOptionsCache ?? [],
  );
  useEffect(() => {
    if (kanriOfficeOptionsCache) return;
    let cancelled = false;
    (async () => {
      const [own, providers] = await Promise.all([
        supabase
          .from("offices")
          .select("business_number, name")
          .eq("app_type", "kaigo-app")
          .order("name"),
        supabase
          .from("kaigo_service_providers")
          .select("provider_number, name")
          .order("name"),
      ]);
      const opts: KanriOfficeOption[] = [];
      for (const o of (own.data ?? []) as { business_number: string | null; name: string }[]) {
        if (o.name) opts.push({ number: o.business_number ?? "", name: o.name });
      }
      for (const p of (providers.data ?? []) as { provider_number: string | null; name: string }[]) {
        if (p.name) opts.push({ number: p.provider_number ?? "", name: p.name });
      }
      kanriOfficeOptionsCache = opts;
      if (!cancelled) setOfficeOptions(opts);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // 前月の関係事業所を複写 (金額は月ごとに違うため 0 で複写 → 当月分を入力)
  const copyPrevMonth = async () => {
    const [py, pm] = month === 1 ? [year - 1, 12] : [year, month - 1];
    const prevKey = `${py}-${String(pm).padStart(2, "0")}`;
    const { data, error } = await supabase
      .from("shogai_jogen_kanri_results")
      .select("office_lines")
      .eq("client_id", row.user_id)
      .eq("target_month", prevKey)
      .maybeSingle();
    if (error) {
      toast.error("前月の上限管理データの取得に失敗: " + error.message);
      return;
    }
    const prev = (((data?.office_lines ?? []) as KanriOfficeLine[]) ?? []).filter(
      (l) => !l.is_self,
    );
    if (prev.length === 0) {
      toast.info(`前月 (${prevKey}) の関係事業所データがありません`);
      return;
    }
    setLines((cur) => {
      const existing = new Set(
        cur.filter((l) => !l.is_self).map((l) => `${l.office_number}|${l.office_name}`),
      );
      const added = prev
        .filter((l) => !existing.has(`${l.office_number}|${l.office_name}`))
        .map((l) => ({
          office_number: l.office_number,
          office_name: l.office_name,
          total_amount: 0,
          user_amount: 0,
          adjusted_amount: 0,
          is_self: false,
        }));
      if (added.length === 0) {
        toast.info("前月の関係事業所は全て追加済みです");
        return cur;
      }
      toast.success(
        `前月から関係事業所 ${added.length} 件を複写しました — 当月の金額を入力して調整計算してください`,
      );
      return [...cur, ...added];
    });
  };

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
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copyPrevMonth}
            className="rounded border border-violet-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-100"
            title="前月の関係事業所 (他事業所の行) を複写します。金額は月ごとに違うため 0 で複写されるので、当月の金額を入力してください"
          >
            前月複写
          </button>
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
            上限月額 {limit != null ? `¥${limit.toLocaleString()}` : "未設定"}
          </span>
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
          onChange={(e) => {
            const v = e.target.value;
            setNewName(v);
            // 候補と名称が完全一致したら事業所番号を自動補完 (マスタ選択の手間削減)
            const hit = officeOptions.find((o) => o.name === v);
            if (hit?.number) setNewNo(hit.number);
          }}
          placeholder="関係事業所名 (候補から選択可)"
          list="jogen-kanri-office-options"
          className="rounded border px-2 py-1.5 focus:border-violet-500 focus:outline-none"
        />
        <datalist id="jogen-kanri-office-options">
          {officeOptions.map((o) => (
            <option key={`${o.number}|${o.name}`} value={o.name}>
              {o.number}
            </option>
          ))}
        </datalist>
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
        <span
          className="text-[10px] text-gray-500"
          title="調整計算の充当順: 管理事業所 (自事業所) を優先して上限まで充当 → 残りを他事業所の負担額が大きい順に充当します"
        >
          {result != null
            ? `管理結果区分: ${result} (${result === 1 ? "管理事業所で充当" : result === 2 ? "調整なし" : "結果票のとおり調整"})`
            : "未計算 (充当順: 自事業所優先 → 負担額の大きい順)"}
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
