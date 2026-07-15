"use client";

/**
 * 利用請求 — 利用者本人への請求一覧 (見た目: order-app UserBillingTab と同一)
 *
 * 左: あかさたな索引 / 中央: ツールバー + 格子テーブル + 合計フッタ /
 * 右: 利用明細欄 (行クリックで明細 + 実費入力 + 入金管理)。
 *
 * 機能:
 *   - 請求書発行 (対象チェック or 全件) / FB データ出力 (全銀協)
 *   - 名寄せ (= 「名寄」チェック列。order-app UserBillingTab と同じ操作感):
 *     請求書発行時に名寄チェック 2 名以上を 1 枚の世帯合算請求書、
 *     それ以外は従来どおり 1 名 1 枚の個別請求書として同じ印刷 view 内で出す
 *   - 利用実費 (保険外) の入力 / 入金管理 (未収金)
 *   - 軽減 (減免): kaigo_riyou_settings の軽減率を対象月有効分だけ適用
 *     (ほのぼの「請求個人設定の軽減」相当。請求額 = 負担額 − 軽減額 + 実費)
 *   - 前回領収欄: 前月の請求/入金から繰越額 (未収繰越 / 過入金充当) を算出し
 *     請求書に印字 (当月の billed_amount 記録は従来どおり当月分のみ = 二重計上なし)
 *   - 医療費控除対象額: iryohi_taisho の利用者のみ、生活援助を除く単位比率で按分
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  AlertTriangle,
  FileText,
  Plus,
  Printer,
  Trash2,
  Banknote,
  Upload,
  X,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "../_shared/seikyu-context";
import { useCrossOfficeSeikyu } from "../_shared/use-cross-office-seikyu";
import { mergeSegmentRows, type UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";
import { buildFbZengin, type FbTransferTarget } from "@/lib/fb-zengin";
import {
  parseFbZenginResult,
  type FbResultDetail,
  type FbResultParse,
} from "@/lib/fb-zengin-result";
import {
  buildMergedClients,
  RiyouSeikyuMergedPrintSheet,
  type MergeInput,
  type MergedClient,
  type MergedLine,
  type MergeBank,
  type SheetCompany,
} from "./riyou-merge-print";

// ─── 3 制度統合の表示行モデル ────────────────────────────────────────────────
// 介護 / 総合事業 は同型 UserSeikyuRow (既存ロジックをそのまま流用)。
// 障害 は ShogaiSeikyuRow (請求額 = userAmount。軽減/実費/医療費控除は N/A)。
// 入金の保存先が制度で異なる (介護・総合 → riyou_seikyu_payments /
// 障害 → shogai_seikyu_payments) ため、行キーは `制度:client_id` で衝突を避ける。
type SeikyuSystem = "介護" | "総合事業" | "障害";

// 入金テーブルは 2 系統。行の system で読み書き先を振り分ける
const paymentTableFor = (system: SeikyuSystem) =>
  system === "障害" ? "shogai_seikyu_payments" : "riyou_seikyu_payments";

// 制度区分バッジの配色 (介護=indigo / 総合=teal / 障害=violet)
const SYSTEM_BADGE_CLS: Record<SeikyuSystem, string> = {
  介護: "bg-indigo-100 text-indigo-700",
  総合事業: "bg-teal-100 text-teal-700",
  障害: "bg-violet-100 text-violet-700",
};

// 統合行: 介護/総合 は kaigo を、障害 は shogai を持つ判別 union。
// key は制度またぎの client_id 衝突を避けるための一意キー。
type UnifiedRow =
  | { key: string; system: "介護" | "総合事業"; userId: string; kaigo: UserSeikyuRow }
  | { key: string; system: "障害"; userId: string; shogai: ShogaiSeikyuRow };

const rowKey = (system: SeikyuSystem, userId: string) => `${system}:${userId}`;

// 介護・総合のみの統合行 (一括印刷用。障害の帳票は障害請求タブ側にあるため対象外)
type KaigoUnifiedRow = Extract<UnifiedRow, { system: "介護" | "総合事業" }>;

// 利用者の口座情報 (FB データ用) — clients の bank_* 列 + ひな形の宛先 (郵便番号/住所)
interface ClientBank {
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_type: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  // ひな形 宛先 (Phase 1 表示専用)
  postal_code: string | null;
  address: string | null;
}

// ClientBank → ひな形の口座 (MergeBank) へ変換 (表示専用)
const toMergeBank = (b: ClientBank | undefined): MergeBank | null =>
  b
    ? {
        bankName: b.bank_name,
        bankBranch: b.bank_branch,
        bankAccountType: b.bank_account_type,
        bankAccountNumber: b.bank_account_number,
        bankAccountHolder: b.bank_account_holder,
      }
    : null;

// 利用実費 (保険外費用) — ほのぼの 訪問介護請求管理編 1-3 対応
interface JippiEntry {
  id: string;
  client_id: string;
  item_name: string;
  unit_price: number;
  quantity: number;
  amount: number;
  provide_date: string | null;
}

const JIPPI_SUGGESTIONS = ["交通費", "キャンセル料", "日用品費", "その他"];

// 事業所合算が無い/無効時に使う安定した空配列 (再レンダリング抑止)
const EMPTY_CLIENT_IDS: readonly string[] = [];
const EMPTY_MERGE_INPUTS: MergeInput[] = [];

// 入金状況 (ほのぼの 利用請求タブ: 状態 = 確定/入金完 + 未収金管理)
interface PaymentRow {
  id: string;
  client_id: string;
  billed_amount: number;
  paid_amount: number;
  paid_date: string | null;
  payment_method: string | null;
  status: "請求済" | "入金完" | "一部入金" | "未収";
  issued_date: string | null;
}

// 状態バッジ (order-app UserBillingTab の statusBadge と同じ配色ルール:
//  確定系 = 青 / 入金完 = 緑 / 未確定 = グレー。未収系は赤/橙で警告)
const PAYMENT_STATUS_CLS: Record<string, string> = {
  請求済: "bg-blue-100 text-blue-700",
  入金完: "bg-emerald-100 text-emerald-700",
  一部入金: "bg-amber-100 text-amber-700",
  未収: "bg-red-100 text-red-700",
};

const PAYMENT_METHOD_OPTIONS = ["", "振込", "現金", "口座振替"];

// ─── 振替結果取込 (FB 結果ファイル → 入金自動消込) ────────────────────────────
// 全銀協フォーマットは依頼と結果が同一レイアウトで、金融機関が「振替結果コード」
// 欄に結果 (0=振替済 / 1=資金不足 / …) を書き戻して返却する。ここでは
// fb-zengin.ts の依頼レイアウトを正としてパースし (fb-zengin-result.ts)、
// 振替済 (コード 0) を riyou_seikyu_payments に入金として自動記録する。
// ⚠ 実ファイル未検証: 自前依頼ファイルとの往復は机上検証済みだが、実際の
//   金融機関返却ファイルでの検証は未実施 (プレビューで必ず目視確認する)。

// 取込済みマーカー (riyou_seikyu_payments.notes に付与して二重取込を防ぐ)
const fbImportMarker = (monthKey: string) => `[FB振替取込 ${monthKey}]`;

// プレビュー行の分類
type FbRowKind =
  | "import" // 振替済 → 入金消込の対象
  | "failed" // 振替不能 (理由コード付き) → 入金は立てない
  | "unmatched" // 顧客番号から利用者を特定できない (突合不能)
  | "skip_marker" // 取込マーカーあり = この月は取込済み
  | "skip_dup"; // 同一 client×月×金額 の入金が既にある (手入力済み疑い)

interface FbPreviewRow {
  detail: FbResultDetail;
  kind: FbRowKind;
  clientId: string | null;
  clientName: string | null;
  /** 請求残額 = 請求額 − 既入金 (利用者を特定できない場合 null) */
  remaining: number | null;
  /** 引落金額 ≠ 請求残額 (取込対象行のみ判定) */
  amountMismatch: boolean;
}

// 取込時に参照する既存入金行 (notes 込みで別途 fetch する — PaymentRow は不変)
interface FbPayRow {
  client_id: string;
  billed_amount: number;
  paid_amount: number;
  paid_date: string | null;
  payment_method: string | null;
  status: string;
  notes: string | null;
}

interface FbImportState {
  fileName: string;
  parsed: FbResultParse;
  /** パース警告 + UI 側の追加警告 (対象月ずれ 等) */
  warnings: string[];
  rows: FbPreviewRow[];
  payByClient: Map<string, FbPayRow>;
  /** 確定後の結果 (null = 未確定) */
  done: { imported: number; amount: number; dbErrors: string[] } | null;
}

// プレビュー行の状態表示 (ラベル + 配色)
const FB_KIND_BADGE: Record<FbRowKind, { label: string; cls: string }> = {
  import: { label: "消込対象", cls: "bg-emerald-100 text-emerald-700" },
  failed: { label: "振替不能", cls: "bg-red-100 text-red-700" },
  unmatched: { label: "突合不能", cls: "bg-red-100 text-red-700" },
  skip_marker: { label: "取込済み (スキップ)", cls: "bg-gray-100 text-gray-600" },
  skip_dup: { label: "同額入金あり (スキップ)", cls: "bg-amber-100 text-amber-700" },
};

// テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 判定
const isTableMissingError = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

// 利用請求のベース額 = 法定負担 (userAmount) + 限度額超過の全額自費 (selfPayAmount)。
// aggregate.ts で userAmount から超過自費を分離したため、利用請求は両者を合算して
// 従来どおりの請求額を維持する (内訳は splitUserAmount で別行表示)。
const userPlusSelf = (r: UserSeikyuRow) => r.userAmount + r.selfPayAmount;

// ── 合算請求書のサービス明細行 (表示専用。集計の details / addons をそのまま詰める) ──
//   ★ money-safety: units は表示だけ。円 (subtotal) は各制度の billed をそのまま使う。
// 介護 / 総合: details (基本サービス + 実績単位加算) + 処遇改善等%加算 (addonUnits) を 1 行に。
//   処遇改善は details に含まれないため addonLabel で名称そのまま出す。
function kaigoMergeLines(r: UserSeikyuRow): MergedLine[] {
  const lines: MergedLine[] = r.details.map((d) => ({
    serviceName: d.service_type,
    units: d.units,
    count: d.count,
  }));
  if (r.addonUnits > 0) {
    lines.push({
      serviceName: r.addonLabel ?? "処遇改善加算等",
      units: r.addonUnits,
      count: 1,
    });
  }
  return lines;
}
// 障害: details (所定サービス) + addons (処遇改善・特別地域等。月 1 回 = 回数 1)。
function shogaiMergeLines(s: ShogaiSeikyuRow): MergedLine[] {
  const lines: MergedLine[] = s.details.map((d) => ({
    serviceName: d.service_category
      ? `${d.service_type}（${d.service_category}）`
      : d.service_type,
    units: d.units,
    count: d.count,
  }));
  for (const a of s.addons) {
    lines.push({ serviceName: a.service_name, units: a.units, count: 1 });
  }
  return lines;
}

// 印刷する綴り (ほのぼの流の綴り選択)。領収書は入金済み (入金完/一部入金) の行のみ発行
type PrintDocKey = "seikyu" | "seikyuHikae" | "ryoshu" | "ryoshuHikae";
const PRINT_DOC_LABELS: { key: PrintDocKey; label: string }[] = [
  { key: "seikyu", label: "請求書" },
  { key: "seikyuHikae", label: "請求書控え" },
  { key: "ryoshu", label: "領収書" },
  { key: "ryoshuHikae", label: "領収書控え" },
];

// 請求個人設定 (軽減 / 医療費控除) — kaigo_riyou_settings (client_id UNIQUE)
// ほのぼの「請求個人設定の軽減」相当
interface RiyouSettingRow {
  client_id: string;
  /** 軽減率 (% 表記。NULL = 軽減なし) */
  keigen_rate: number | null;
  keigen_start_date: string | null;
  keigen_end_date: string | null;
  /** 医療費控除の対象者か */
  iryohi_taisho: boolean;
  notes: string | null;
}

// 軽減が対象月に有効か: 開始 <= 月末 かつ (終了 null or 終了 >= 月初)
// (日付は YYYY-MM-DD の文字列比較で判定。"-31" は月末番兵として安全)
function keigenActiveInMonth(
  s: RiyouSettingRow | undefined,
  monthKey: string,
): boolean {
  if (!s || s.keigen_rate == null || s.keigen_rate <= 0) return false;
  const monthStart = `${monthKey}-01`;
  const monthEnd = `${monthKey}-31`;
  if (s.keigen_start_date && s.keigen_start_date > monthEnd) return false;
  if (s.keigen_end_date && s.keigen_end_date < monthStart) return false;
  return true;
}

// YYYY-MM-DD → R{Y}/{M}/{D} 表示 (order-app formatIssuedDateReiwa と同じ流儀)
function fmtReiwaDate(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `R${parseInt(m[1], 10) - 2018}/${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

export function RiyouSeikyuContent() {
  const {
    year,
    month,
    rows: rawRows,
    sougouRows,
    filteredRows: rawFilteredRows,
    filteredSougouRows,
    filteredShogaiRows,
    loading,
    error,
    officeName,
    officeId,
    officeAddress,
    officePhone,
    officePostal,
  } = useSeikyuContext();
  // 保険者変更 (転居) の分割セグメント行 (Phase 2) は利用者単位に合算してから使う。
  // 利用者請求書・軽減・実費・入金・FB 全銀はすべて利用者単位 (保険者をまたがない)
  // なので、分割前の従来どおり「利用者 = 1 行」に戻す (分割行が無ければ同一参照)。
  const rows = useMemo(() => mergeSegmentRows(rawRows), [rawRows]);
  const filteredRows = useMemo(
    () => mergeSegmentRows(rawFilteredRows),
    [rawFilteredRows],
  );
  const supabase = useMemo(() => createClient(), []);
  // 選択行は `制度:client_id` の一意キーで保持 (制度またぎの衝突回避)
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 対象 (発行/FB の絞込) と 名寄 (世帯合算) は別チェック列 (order-app と同じ)。
  // Set のキーは `制度:client_id` の一意キー (制度またぎの衝突回避)
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [merged, setMerged] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  // 印刷する綴り (請求書 / 請求書控え / 領収書 / 領収書控え — ほのぼの流の綴り選択)
  const [printDocs, setPrintDocs] = useState<Set<PrintDocKey>>(new Set(["seikyu"]));
  const [jippiByUser, setJippiByUser] = useState<Map<string, JippiEntry[]>>(new Map());
  // ── 請求書の合算モード (一覧の表示制度 + 印刷レイヤーに効く。金額計算 = aggregate は不変) ──
  //   制度合算 (mergeSystems): ON = 一覧に 介護/総合/障害 を並べ、同一利用者を 1 枚に合算 (デフォルト)。
  //     OFF = この画面は 介護/総合 のみ表示し、制度ごとに別枚 (障害は障害請求タブ側で扱う)。
  //   事業所合算 (mergeOffices): ON = 同一法人 (company_id) の全 kaigo 事業所分の
  //     利用者負担を横断集計し、利用者ごとに 1 枚へ合算する (法人が違えば別枚)。
  //     OFF = 自事業所分のみ (従来)。デフォルト ON。
  const [mergeSystems, setMergeSystems] = useState(true);
  const [mergeOffices, setMergeOffices] = useState(true);
  // 事業所合算バナーの詳細 (事業所名リスト + 注記) の展開 (既定は折りたたみ)
  const [officeBannerOpen, setOfficeBannerOpen] = useState(false);

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // ── 事業所合算: 同一法人の他事業所分の利用者負担を集計 (use-cross-office-seikyu) ──
  //   自事業所分は下の既存 context データを再利用するため、ここでは取得しない。
  //   集計関数は自事業所と同一 (officeId 差し替えのみ) なので金額は各事業所タブと一致。
  const crossOffice = useCrossOfficeSeikyu({
    enabled: mergeOffices,
    supabase,
    selfOfficeId: officeId,
    year,
    month,
  });

  // ── 3 制度統合の表示行 (介護 → 総合 → 障害、各制度内はカナ順のまま) ──
  //    介護/総合 は UserSeikyuRow を、障害 は ShogaiSeikyuRow を持つ union。
  //    key は `制度:client_id` (同一 client_id が複数制度に跨っても衝突しない)。
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const out: UnifiedRow[] = [];
    for (const r of filteredRows)
      out.push({ key: rowKey("介護", r.user_id), system: "介護", userId: r.user_id, kaigo: r });
    for (const r of filteredSougouRows)
      out.push({ key: rowKey("総合事業", r.user_id), system: "総合事業", userId: r.user_id, kaigo: r });
    // 障害は「制度合算 ON」のときだけ一覧に出す (OFF = この画面 (介護タブ) は
    // 介護 + 総合 のみ表示。障害の利用請求は障害タブで扱う)。合算 ON のときだけ
    // 制度横断で 1 リストに並べ、1 枚の合算請求書を作れるようにする。
    if (mergeSystems)
      for (const r of filteredShogaiRows)
        out.push({ key: rowKey("障害", r.user_id), system: "障害", userId: r.user_id, shogai: r });
    return out;
  }, [filteredRows, filteredSougouRows, filteredShogaiRows, mergeSystems]);

  const loadJippi = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("riyou_jippi_entries")
      .select("id, client_id, item_name, unit_price, quantity, amount, provide_date")
      .eq("target_month", monthKey)
      .order("created_at");
    if (e) {
      // table 未作成 (migration 未適用) 時は実費なしとして続行
      if (!isTableMissingError(e.code)) toast.error("実費取得失敗: " + e.message);
      setJippiByUser(new Map());
      return;
    }
    const m = new Map<string, JippiEntry[]>();
    for (const r of (data ?? []) as JippiEntry[]) {
      if (!m.has(r.client_id)) m.set(r.client_id, []);
      m.get(r.client_id)!.push(r);
    }
    setJippiByUser(m);
  }, [supabase, monthKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadJippi();
  }, [loadJippi]);

  const jippiTotal = useCallback(
    (userId: string) => (jippiByUser.get(userId) ?? []).reduce((s, e) => s + e.amount, 0),
    [jippiByUser],
  );

  // 入金状況
  const [payments, setPayments] = useState<Map<string, PaymentRow>>(new Map());
  const loadPayments = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("riyou_seikyu_payments")
      .select("id, client_id, billed_amount, paid_amount, paid_date, payment_method, status, issued_date")
      .eq("target_month", monthKey);
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("入金状況取得失敗: " + e.message);
      setPayments(new Map());
      return;
    }
    setPayments(new Map(((data ?? []) as PaymentRow[]).map((p) => [p.client_id, p])));
  }, [supabase, monthKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadPayments();
  }, [loadPayments]);

  // 障害の入金状況 (shogai_seikyu_payments)。介護と同じ status 体系・列構成。
  // client_id で持つ (介護 payments と別 Map なので client_id 衝突は問題にならない)
  const [shogaiPayments, setShogaiPayments] = useState<Map<string, PaymentRow>>(new Map());
  const loadShogaiPayments = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("shogai_seikyu_payments")
      .select("id, client_id, billed_amount, paid_amount, paid_date, payment_method, status, issued_date")
      .eq("target_month", monthKey);
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("障害入金状況取得失敗: " + e.message);
      setShogaiPayments(new Map());
      return;
    }
    setShogaiPayments(new Map(((data ?? []) as PaymentRow[]).map((p) => [p.client_id, p])));
  }, [supabase, monthKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadShogaiPayments();
  }, [loadShogaiPayments]);

  // 制度で入金 Map を振り分けて 1 行分の入金を返す (障害 → shogai / それ以外 → 介護)
  const paymentForRow = useCallback(
    (row: UnifiedRow): PaymentRow | undefined =>
      row.system === "障害"
        ? shogaiPayments.get(row.userId)
        : payments.get(row.userId),
    [payments, shogaiPayments],
  );
  // 入金 reload も制度で振り分け
  const reloadPaymentsFor = useCallback(
    (system: SeikyuSystem) =>
      system === "障害" ? loadShogaiPayments() : loadPayments(),
    [loadShogaiPayments, loadPayments],
  );

  // ── 前月の入金状況 (前回領収欄・繰越の算出用。②) ──
  const prevMonthKey =
    month === 1
      ? `${year - 1}-12`
      : `${year}-${String(month - 1).padStart(2, "0")}`;
  const [prevPayments, setPrevPayments] = useState<Map<string, PaymentRow>>(new Map());
  const loadPrevPayments = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("riyou_seikyu_payments")
      .select("id, client_id, billed_amount, paid_amount, paid_date, payment_method, status, issued_date")
      .eq("target_month", prevMonthKey);
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("前月入金状況取得失敗: " + e.message);
      setPrevPayments(new Map());
      return;
    }
    setPrevPayments(
      new Map(((data ?? []) as PaymentRow[]).map((p) => [p.client_id, p])),
    );
  }, [supabase, prevMonthKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadPrevPayments();
  }, [loadPrevPayments]);

  // 繰越額 = 前月請求 − 前月入金 (正 = 未収繰越 / 負 = 過入金充当)。前月レコード無しは 0
  const carryover = useCallback(
    (userId: string) => {
      const p = prevPayments.get(userId);
      return p ? p.billed_amount - p.paid_amount : 0;
    },
    [prevPayments],
  );

  // ── 障害の前月入金状況 (障害行の前月繰越の算出用) ──
  //    介護と同じ流儀で shogai_seikyu_payments の前月分を読む。テーブル未作成・前月なしは 0。
  const [prevShogaiPayments, setPrevShogaiPayments] = useState<
    Map<string, PaymentRow>
  >(new Map());
  const loadPrevShogaiPayments = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("shogai_seikyu_payments")
      .select("id, client_id, billed_amount, paid_amount, paid_date, payment_method, status, issued_date")
      .eq("target_month", prevMonthKey);
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("障害前月入金状況取得失敗: " + e.message);
      setPrevShogaiPayments(new Map());
      return;
    }
    setPrevShogaiPayments(
      new Map(((data ?? []) as PaymentRow[]).map((p) => [p.client_id, p])),
    );
  }, [supabase, prevMonthKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadPrevShogaiPayments();
  }, [loadPrevShogaiPayments]);

  // 障害の繰越額 = 前月請求 − 前月入金 (前月レコード無しは 0)。介護 carryover と同型。
  const shogaiCarryover = useCallback(
    (userId: string) => {
      const p = prevShogaiPayments.get(userId);
      return p ? p.billed_amount - p.paid_amount : 0;
    },
    [prevShogaiPayments],
  );

  // 制度で繰越を振り分け (障害 → shogaiCarryover / 介護・総合 → 従来 carryover)。
  // 介護・総合 の既存 carryover は不変のまま流用する。
  const carryoverForRow = useCallback(
    (row: UnifiedRow) =>
      row.system === "障害"
        ? shogaiCarryover(row.userId)
        : carryover(row.userId),
    [shogaiCarryover, carryover],
  );

  // 介護 + 総合 の UserSeikyuRow 全体 (軽減/実費/医療費控除/口座 は両制度に同じ流儀を適用)。
  // 障害はこれらが N/A なので含めない。
  const kaigoAllRows = useMemo(() => [...rows, ...sougouRows], [rows, sougouRows]);

  // ── 請求個人設定 (軽減 / 医療費控除。①③) — kaigo_riyou_settings ──
  //   軽減率は client 単位 (kaigo_riyou_settings は client_id UNIQUE) なので、
  //   事業所合算 ON のときは他事業所のみの利用者分も含めて読む
  //   (= 他事業所セクションの軽減額 keigenAmount(clientId, base) を効かせるため)。
  const crossClientIds = crossOffice.data?.clientIds ?? EMPTY_CLIENT_IDS;
  const crossClientIdsKey = useMemo(
    () => crossClientIds.slice().sort().join(","),
    [crossClientIds],
  );
  const [settings, setSettings] = useState<Map<string, RiyouSettingRow>>(new Map());
  const loadSettings = useCallback(async () => {
    const ids = Array.from(
      new Set<string>([
        ...kaigoAllRows.map((r) => r.user_id),
        ...crossClientIds,
      ]),
    );
    if (ids.length === 0) {
      setSettings(new Map());
      return;
    }
    const m = new Map<string, RiyouSettingRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("kaigo_riyou_settings")
        .select("client_id, keigen_rate, keigen_start_date, keigen_end_date, iryohi_taisho, notes")
        .in("client_id", chunk);
      if (e) {
        // table 未作成 (migration 未適用) 時は設定なしとして続行
        if (!isTableMissingError(e.code)) toast.error("請求設定取得失敗: " + e.message);
        setSettings(new Map());
        return;
      }
      for (const s of (data ?? []) as RiyouSettingRow[]) m.set(s.client_id, s);
    }
    setSettings(m);
    // crossClientIdsKey で他事業所利用者の変化にも追随 (crossClientIds 参照は key 経由)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, kaigoAllRows, crossClientIdsKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更/行更新時の fetch
    loadSettings();
  }, [loadSettings]);

  // 軽減額 = round(負担額 × 軽減率 / 100)。対象月に有効な軽減のみ。
  // 対象は 法定負担 + 超過自費 (userPlusSelf) — 分離前の従来請求額を維持する
  const keigenAmount = useCallback(
    (userId: string, userAmount: number) => {
      const s = settings.get(userId);
      if (!keigenActiveInMonth(s, monthKey)) return 0;
      return Math.round((userAmount * (s!.keigen_rate ?? 0)) / 100);
    },
    [settings, monthKey],
  );

  // 行の請求額 = (法定負担 + 超過自費) − 軽減額 + 実費 (従来額と同じ)
  const rowBilled = useCallback(
    (r: UserSeikyuRow) =>
      userPlusSelf(r) - keigenAmount(r.user_id, userPlusSelf(r)) + jippiTotal(r.user_id),
    [keigenAmount, jippiTotal],
  );

  // 統合行の請求額。介護/総合 は従来どおり rowBilled、障害 は userAmount (上限適用後)。
  // 障害は軽減/実費/医療費控除が N/A なので userAmount がそのまま請求額。
  const billedForRow = useCallback(
    (row: UnifiedRow): number =>
      row.system === "障害" ? row.shogai.userAmount : rowBilled(row.kaigo),
    [rowBilled],
  );

  // 医療費控除対象額 = round(軽減後負担額 × 対象単位比率)。
  // 対象単位比率 = 「生活援助」を含まないサービスの単位数 ÷ 総単位数
  // (生活援助中心型は控除対象外。加算は比率に按分される)
  const iryohiAmount = useCallback(
    (r: UserSeikyuRow) => {
      const s = settings.get(r.user_id);
      if (!s?.iryohi_taisho || r.totalUnits <= 0) return 0;
      const eligibleUnits = r.details
        .filter((d) => !d.service_type.includes("生活援助"))
        .reduce((sum, d) => sum + d.units, 0);
      const afterKeigen = userPlusSelf(r) - keigenAmount(r.user_id, userPlusSelf(r));
      // 整数演算 (比率を先に float 化しない)
      return Math.round((afterKeigen * eligibleUnits) / r.totalUnits);
    },
    [settings, keigenAmount],
  );

  // 印刷/フッタ用の per-user 計算値 (介護 + 総合 全体で計算しておく)
  const keigenByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of kaigoAllRows) m.set(r.user_id, keigenAmount(r.user_id, userPlusSelf(r)));
    return m;
  }, [kaigoAllRows, keigenAmount]);
  const iryohiByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of kaigoAllRows) {
      if (settings.get(r.user_id)?.iryohi_taisho) m.set(r.user_id, iryohiAmount(r));
    }
    return m;
  }, [kaigoAllRows, settings, iryohiAmount]);

  // 口座情報 (FB データ用) — clients の bank_* を月内の利用者分だけ fetch。
  // FB は介護・総合のみ対象なので kaigoAllRows で十分 (障害は FB 除外)。
  const [bankByUser, setBankByUser] = useState<Map<string, ClientBank>>(new Map());
  const loadBanks = useCallback(async () => {
    if (kaigoAllRows.length === 0) {
      setBankByUser(new Map());
      return;
    }
    const ids = Array.from(new Set(kaigoAllRows.map((r) => r.user_id)));
    const m = new Map<string, ClientBank>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("clients")
        .select("id, bank_name, bank_branch, bank_account_type, bank_account_number, bank_account_holder, postal_code, address")
        .in("id", chunk);
      if (e) {
        toast.error("口座情報取得失敗: " + e.message);
        return;
      }
      for (const c of (data ?? []) as ({ id: string } & ClientBank)[]) {
        m.set(c.id, {
          bank_name: c.bank_name,
          bank_branch: c.bank_branch,
          bank_account_type: c.bank_account_type,
          bank_account_number: c.bank_account_number,
          bank_account_holder: c.bank_account_holder,
          postal_code: c.postal_code,
          address: c.address,
        });
      }
    }
    setBankByUser(m);
  }, [supabase, kaigoAllRows]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更/行更新時の fetch
    loadBanks();
  }, [loadBanks]);

  // ── ご利用日 (提供実績日) — kaigo_visit_schedule の completed を月内で取得 (表示専用) ──
  //   ★ money-safety: 金額計算には一切使わない。請求書のご利用日カレンダー描画のみ。
  //   介護/総合/障害 いずれも同テーブルの completed 行が実績元 (aggregate と対称)。
  //   自事業所スコープ (office_id 列があれば絞る。未適用=42703 は列なしで再取得)。
  const [serviceDaysByUser, setServiceDaysByUser] = useState<Map<string, number[]>>(
    new Map(),
  );
  const loadServiceDays = useCallback(async () => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const from = `${monthKey}-01`;
    const to = `${monthKey}-${String(daysInMonth).padStart(2, "0")}`;
    // office_id で自事業所に絞る。列未適用時は絞らず取得 (aggregate と同じ流儀)。
    const fetchPage = async (withOffice: boolean, start: number) => {
      let q = supabase
        .from("kaigo_visit_schedule")
        .select("user_id, visit_date")
        .eq("status", "completed")
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("user_id")
        .range(start, start + 999);
      if (withOffice && officeId) q = q.eq("office_id", officeId);
      return q;
    };
    const m = new Map<string, Set<number>>();
    let withOffice = true;
    let start = 0;
    // page-loop (1000 行上限を跨ぐ月に備える)
    for (;;) {
      let { data, error: e } = await fetchPage(withOffice, start);
      if (e && e.code === "42703" && withOffice) {
        // office_id 列未適用 → 列なしで最初から取り直す
        withOffice = false;
        start = 0;
        m.clear();
        ({ data, error: e } = await fetchPage(false, 0));
      }
      if (e) {
        if (!isTableMissingError(e.code))
          console.warn("ご利用日取得失敗:", e.message);
        setServiceDaysByUser(new Map());
        return;
      }
      const rows = (data ?? []) as { user_id: string; visit_date: string }[];
      for (const r of rows) {
        const day = parseInt(r.visit_date.slice(8, 10), 10);
        if (!Number.isFinite(day)) continue;
        if (!m.has(r.user_id)) m.set(r.user_id, new Set());
        m.get(r.user_id)!.add(day);
      }
      if (rows.length < 1000) break;
      start += 1000;
    }
    setServiceDaysByUser(
      new Map(
        Array.from(m, ([k, v]) => [k, Array.from(v).sort((a, b) => a - b)]),
      ),
    );
  }, [supabase, monthKey, year, month, officeId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadServiceDays();
  }, [loadServiceDays]);

  // ── 居宅介護支援事業者名 (請求書の「居宅介護支援事業者名：」欄。表示専用) ──
  //   源: client_insurance_records.care_office_id → care_offices.name (様式第二と同源)。
  //   client 単位。複数保険記録がある場合は effective_date 降順で最新の care_office を採用。
  const [careOfficeByUser, setCareOfficeByUser] = useState<Map<string, string>>(
    new Map(),
  );
  const loadCareOffices = useCallback(async () => {
    const ids = Array.from(new Set(kaigoAllRows.map((r) => r.user_id)));
    if (ids.length === 0) {
      setCareOfficeByUser(new Map());
      return;
    }
    // 1) client → care_office_id (最新の非 null)
    const careOfficeIdByClient = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("client_insurance_records")
        .select("client_id, care_office_id, effective_date")
        .in("client_id", chunk)
        .not("care_office_id", "is", null)
        .order("effective_date", { ascending: false });
      if (e) {
        if (!isTableMissingError(e.code))
          console.warn("居宅介護支援事業者の取得失敗:", e.message);
        continue;
      }
      for (const r of (data ?? []) as {
        client_id: string;
        care_office_id: string;
      }[]) {
        if (!careOfficeIdByClient.has(r.client_id))
          careOfficeIdByClient.set(r.client_id, r.care_office_id);
      }
    }
    // 2) care_office_id → name
    const officeIds = Array.from(new Set(careOfficeIdByClient.values()));
    const nameById = new Map<string, string>();
    for (let i = 0; i < officeIds.length; i += 100) {
      const chunk = officeIds.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("care_offices")
        .select("id, name")
        .in("id", chunk);
      if (e) {
        if (!isTableMissingError(e.code))
          console.warn("居宅介護支援事業所名の取得失敗:", e.message);
        continue;
      }
      for (const c of (data ?? []) as { id: string; name: string }[])
        nameById.set(c.id, c.name);
    }
    const m = new Map<string, string>();
    for (const [client, oid] of careOfficeIdByClient) {
      const n = nameById.get(oid);
      if (n) m.set(client, n);
    }
    setCareOfficeByUser(m);
  }, [supabase, kaigoAllRows]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/行変更時の fetch
    loadCareOffices();
  }, [loadCareOffices]);

  // ── 自社情報 (ひな形ヘッダーの法人情報) — offices.company_id → companies ──
  //   companies.name (法人名) を優先し、住所/電話/郵便番号は offices の値を fallback。
  //   インボイス登録番号は companies に列が無いため Phase 1 は固定プレースホルダ。
  const [companyName, setCompanyName] = useState<string | null>(null);
  const loadCompany = useCallback(async () => {
    if (!officeId) {
      setCompanyName(null);
      return;
    }
    const { data: off, error: oe } = await supabase
      .from("offices")
      .select("company_id")
      .eq("id", officeId)
      .maybeSingle();
    if (oe) {
      // 取得失敗は officeName フォールバックで続行 (帳票は崩さない)
      setCompanyName(null);
      return;
    }
    const companyId = (off as { company_id?: string | null } | null)?.company_id;
    if (!companyId) {
      setCompanyName(null);
      return;
    }
    const { data: co, error: ce } = await supabase
      .from("companies")
      .select("name")
      .eq("id", companyId)
      .maybeSingle();
    if (ce) {
      setCompanyName(null);
      return;
    }
    setCompanyName((co as { name?: string | null } | null)?.name ?? null);
  }, [supabase, officeId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所変更時の fetch
    loadCompany();
  }, [loadCompany]);

  // ひな形シートに渡す自社情報 (companies.name 優先 / 住所・電話・郵便は offices)
  const sheetCompany = useMemo<SheetCompany>(
    () => ({
      name: companyName ?? officeName,
      postalCode: officePostal,
      address: officeAddress,
      phone: officePhone,
      invoiceNumber: null, // Phase 1: 固定プレースホルダ (companies に列なし)
    }),
    [companyName, officeName, officePostal, officeAddress, officePhone],
  );

  // 選択行 (order-app と同じく未選択時は右ペインに placeholder を出す)。key で一意特定
  // 未選択時は先頭行にフォールバック (介護請求/障害請求と同じく明細ペインを既定で開く)
  const selected =
    unifiedRows.find((r) => r.key === selectedKey) ?? unifiedRows[0] ?? null;
  const totalBilled = unifiedRows.reduce((s, r) => s + billedForRow(r), 0);

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === unifiedRows.length
        ? new Set()
        : new Set(unifiedRows.map((r) => r.key)),
    );
  const toggleMerged = (key: string) =>
    setMerged((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 発行対象: チェックあり → その行のみ / チェックなし → 全件
  const targets = useMemo(
    () =>
      checked.size > 0
        ? unifiedRows.filter((r) => checked.has(r.key))
        : unifiedRows,
    [unifiedRows, checked],
  );

  // FB (口座振替) / 名寄せ (世帯合算) / 介護帳票 は介護・総合のみ対象。障害は除外する。
  const kaigoTargets = useMemo(
    () => targets.filter((r) => r.system !== "障害"),
    [targets],
  );

  const reiwa = year - 2018;

  // 領収書 (介護帳票) の発行対象 = 介護・総合 のうち入金済み (入金完 / 一部入金) かつ
  // 入金額 > 0 の行。障害の帳票は障害請求タブ側にあるためここでは除外する。
  const ryoshuTargets = useMemo(
    () =>
      kaigoTargets
        .filter((r) => {
          const p = payments.get(r.userId);
          return (
            p != null &&
            (p.status === "入金完" || p.status === "一部入金") &&
            p.paid_amount > 0
          );
        })
        .map((r) => ({ row: r.kaigo, payment: payments.get(r.userId)! })),
    [kaigoTargets, payments],
  );

  const togglePrintDoc = (key: PrintDocKey) =>
    setPrintDocs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const issueSeikyusho = async () => {
    if (printDocs.size === 0) {
      toast.error("印刷する綴り (請求書 / 領収書 等) を選択してください");
      return;
    }
    const wantsRyoshu = printDocs.has("ryoshu") || printDocs.has("ryoshuHikae");
    const wantsSeikyu = printDocs.has("seikyu") || printDocs.has("seikyuHikae");
    if (wantsRyoshu && ryoshuTargets.length === 0 && !wantsSeikyu) {
      toast.error("領収書を発行できる行がありません (入金完 / 一部入金 の利用者のみ)");
      return;
    }
    // 発行記録は「請求書」を含む場合のみ (領収書のみの印刷では発行日を更新しない)。
    // 発行記録: 請求額 + 発行日を upsert (入金状態は既存を保持、新規は 請求済)。
    // billed_amount は当月分のみ (繰越は印字のみ = 二重計上を避ける)。
    // 保存先は制度で振り分け (介護/総合 → riyou_seikyu_payments / 障害 → shogai_seikyu_payments)。
    if (printDocs.has("seikyu")) {
      const today = new Date();
      const issued = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const kaigoUp = targets.filter((r) => r.system !== "障害");
      const shogaiUp = targets.filter((r) => r.system === "障害");
      let anyKaigo = false;
      let anyShogai = false;
      if (kaigoUp.length > 0) {
        const { error: upErr } = await supabase.from("riyou_seikyu_payments").upsert(
          kaigoUp.map((r) => ({
            client_id: r.userId,
            target_month: monthKey,
            billed_amount: billedForRow(r),
            issued_date: issued,
          })),
          { onConflict: "client_id,target_month" },
        );
        if (upErr && !isTableMissingError(upErr.code)) {
          toast.error("発行記録の保存に失敗: " + upErr.message);
        } else if (!upErr) {
          anyKaigo = true;
        }
      }
      if (shogaiUp.length > 0) {
        const { error: upErr } = await supabase.from("shogai_seikyu_payments").upsert(
          shogaiUp.map((r) => ({
            client_id: r.userId,
            target_month: monthKey,
            billed_amount: billedForRow(r),
            issued_date: issued,
          })),
          { onConflict: "client_id,target_month" },
        );
        if (upErr && !isTableMissingError(upErr.code)) {
          toast.error("障害の発行記録の保存に失敗: " + upErr.message);
        } else if (!upErr) {
          anyShogai = true;
        }
      }
      if (anyKaigo) loadPayments();
      if (anyShogai) loadShogaiPayments();
    }
    setPrinting(true);
    // print CSS 適用後に印刷 dialog
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 100);
  };

  // ── 支払方法 / 請求書発行日 のインライン編集 (order-app の行内 select/date と同じ) ──
  //    upsert は指定列のみ更新 (入金状態などは既存を保持 — issueSeikyusho と同じ流儀)。
  //    保存先テーブルは行の制度で振り分ける。
  const setPaymentMethod = async (row: UnifiedRow, method: string) => {
    const table = paymentTableFor(row.system);
    const { error: e } = await supabase.from(table).upsert(
      {
        client_id: row.userId,
        target_month: monthKey,
        billed_amount: paymentForRow(row)?.billed_amount ?? billedForRow(row),
        payment_method: method || null,
      },
      { onConflict: "client_id,target_month" },
    );
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("支払方法の保存に失敗: " + e.message);
      return;
    }
    reloadPaymentsFor(row.system);
  };
  const setIssuedDate = async (row: UnifiedRow, date: string) => {
    const table = paymentTableFor(row.system);
    const { error: e } = await supabase.from(table).upsert(
      {
        client_id: row.userId,
        target_month: monthKey,
        billed_amount: paymentForRow(row)?.billed_amount ?? billedForRow(row),
        issued_date: date || null,
      },
      { onConflict: "client_id,target_month" },
    );
    if (e) {
      if (!isTableMissingError(e.code)) toast.error("発行日の保存に失敗: " + e.message);
      return;
    }
    reloadPaymentsFor(row.system);
  };

  // ─── 名寄せ (世帯合算) — order-app UserBillingTab の groupForPrint と同じ挙動 ──
  // 発行対象 (targets) のうち「名寄」チェックされた 2 名以上を 1 世帯グループに、
  // それ以外は 1 名 1 枚。請求書発行 (issueSeikyusho) の同じ印刷 view 内で出し分ける。
  const printGroups = useMemo(() => {
    const kaigoRows = kaigoTargets.map((r) => r.kaigo);
    const household = kaigoTargets
      .filter((r) => merged.has(r.key))
      .map((r) => r.kaigo);
    if (household.length >= 2) {
      const hset = new Set(household.map((r) => r.user_id));
      return {
        household,
        singles: kaigoRows.filter((r) => !hset.has(r.user_id)),
      };
    }
    // 名寄 1 名以下は合算にならないので全員個別
    return { household: [] as UserSeikyuRow[], singles: kaigoRows };
  }, [kaigoTargets, merged]);

  // ── 事業所合算: 他事業所分の MergeInput (全 sibling client 分。利用者単位で後段が畳み込む) ──
  //   ★ money-safety: base は集計関数そのままの利用者負担 (法定負担+超過自費 / 障害=userAmount)。
  //   軽減 (keigen) は client 単位の率なので他事業所 base にも keigenAmount で適用
  //   (= 他事業所タブが自分で出す軽減後額と一致)。
  //   実費 (jippi) / 医療費控除 (iryohi) / 前月繰越 (prev) は client-月 単位で
  //   自事業所タブが管理する値。二重計上を避けるため他事業所セクションでは 0 とし、
  //   自事業所セクションに一度だけ計上する (下の toInput が自事業所分を持つ)。
  const siblingInputsAll = useMemo<MergeInput[]>(() => {
    if (!mergeOffices || !crossOffice.data) return EMPTY_MERGE_INPUTS;
    const out: MergeInput[] = [];
    const pushKaigo = (
      officeLabel: string,
      system: "介護" | "総合事業",
      rowsIn: UserSeikyuRow[],
    ) => {
      for (const r of rowsIn) {
        const base = userPlusSelf(r);
        const keigen = keigenAmount(r.user_id, base);
        out.push({
          system,
          userId: r.user_id,
          userName: r.user_name,
          userNameKana: r.user_name_kana,
          userNumber: r.user_number,
          copayRate: r.copay_rate,
          officeLabel,
          lines: kaigoMergeLines(r),
          base,
          keigen,
          jippi: 0,
          subtotal: base - keigen,
          iryohi: 0,
          prevBilled: 0,
          prevPaid: 0,
        });
      }
    };
    for (const office of crossOffice.data.byOffice) {
      // 介護給付 (訪問介護/看護/入浴) は保険者変更の分割セグメントを利用者単位に合算 (自事業所と同流儀)
      pushKaigo(office.officeName, "介護", mergeSegmentRows(office.kaigoRows));
      pushKaigo(office.officeName, "総合事業", office.sougouRows);
      for (const s of office.shogaiRows) {
        out.push({
          system: "障害",
          userId: s.user_id,
          userName: s.user_name,
          userNameKana: s.user_name_kana,
          userNumber: null,
          copayRate: null,
          officeLabel: office.officeName,
          lines: shogaiMergeLines(s),
          base: s.userAmount,
          keigen: 0,
          jippi: 0,
          subtotal: s.userAmount,
          iryohi: 0,
          prevBilled: 0,
          prevPaid: 0,
        });
      }
    }
    return out;
  }, [mergeOffices, crossOffice.data, keigenAmount]);

  // 自事業所セクションに付ける事業所ラベル (事業所合算 ON のときのみ表示)
  const selfOfficeLabel = officeName;
  // 集計対象の他事業所が 1 つ以上あるか (バナー・title 表示・companyMerged 判定に使う)
  const hasSiblingOffices = (crossOffice.data?.offices.length ?? 0) > 0;

  // ── 制度合算 (mergeSystems ON) 用の合算モデル ────────────────────────────────
  //   発行対象 (targets = 介護/総合/障害の全制度) を 1 明細 = 1 制度に落とし込み、
  //   利用者単位に畳み込む。金額は billedForRow (既存関数) をそのまま subtotal に
  //   詰めるだけなので、制度合算 OFF で個別に足した合計と 1 円も違わない。
  //   名寄せ (世帯合算) は別軸: 名寄チェック 2 名以上を 1 世帯グループに束ねる。
  const mergedPrintGroups = useMemo(() => {
    const toInput = (row: UnifiedRow): MergeInput => {
      if (row.system === "障害") {
        const s = row.shogai;
        const prev = prevShogaiPayments.get(row.userId);
        const meta = bankByUser.get(row.userId);
        return {
          system: "障害",
          userId: row.userId,
          userName: s.user_name,
          userNameKana: s.user_name_kana,
          userNumber: null,
          copayRate: null,
          officeLabel: mergeOffices ? selfOfficeLabel : null,
          lines: shogaiMergeLines(s),
          base: s.userAmount,
          keigen: 0,
          jippi: 0,
          subtotal: s.userAmount, // = billedForRow(障害)
          iryohi: 0, // 障害は医療費控除 N/A
          prevBilled: prev?.billed_amount ?? 0,
          prevPaid: prev?.paid_amount ?? 0,
          // ひな形 表示専用 (自事業所セクションに宛先・口座・問い合わせ先を付与)
          postalCode: meta?.postal_code ?? null,
          address: meta?.address ?? null,
          bank: toMergeBank(meta),
          careOfficeName: careOfficeByUser.get(row.userId) ?? null,
          officePhone,
          serviceDays: serviceDaysByUser.get(row.userId) ?? [],
        };
      }
      const r = row.kaigo;
      const prev = prevPayments.get(row.userId);
      const meta = bankByUser.get(row.userId);
      return {
        system: row.system,
        userId: row.userId,
        userName: r.user_name,
        userNameKana: r.user_name_kana,
        userNumber: r.user_number,
        copayRate: r.copay_rate,
        officeLabel: mergeOffices ? selfOfficeLabel : null,
        lines: kaigoMergeLines(r),
        base: userPlusSelf(r),
        keigen: keigenByUser.get(r.user_id) ?? 0,
        jippi: jippiTotal(r.user_id),
        subtotal: rowBilled(r), // = billedForRow(介護/総合)
        iryohi: iryohiByUser.get(r.user_id) ?? 0,
        prevBilled: prev?.billed_amount ?? 0,
        prevPaid: prev?.paid_amount ?? 0,
        // ひな形 表示専用 (自事業所セクションに宛先・口座・問い合わせ先を付与)
        postalCode: meta?.postal_code ?? null,
        address: meta?.address ?? null,
        bank: toMergeBank(meta),
        careOfficeName: careOfficeByUser.get(row.userId) ?? null,
        officePhone,
        serviceDays: serviceDaysByUser.get(row.userId) ?? [],
      };
    };
    // 自事業所分 (targets) + 他事業所分 (対象 client に限定) を 1 リストで畳み込む。
    // 他事業所分は自事業所の発行対象になっている利用者のみに付与する
    // (= この事業所タブが請求する利用者に他事業所の負担を足し込む。他事業所のみの
    //  利用者はその事業所タブで請求されるため、ここでは新規シートを作らない)。
    const targetClientIds = new Set(targets.map((r) => r.userId));
    const siblingForTargets = siblingInputsAll.filter((i) =>
      targetClientIds.has(i.userId),
    );
    const clients = buildMergedClients([
      ...targets.map(toInput),
      ...siblingForTargets,
    ]);
    // 名寄せ (世帯合算): 介護/総合 の名寄チェックが付いた利用者 (2 名以上) を 1 枚に。
    const householdIds = new Set(
      targets
        .filter((r) => r.system !== "障害" && merged.has(r.key))
        .map((r) => r.userId),
    );
    const household = clients.filter((c) => householdIds.has(c.userId));
    if (household.length >= 2) {
      return {
        household,
        singles: clients.filter((c) => !householdIds.has(c.userId)),
      };
    }
    return { household: [] as MergedClient[], singles: clients };
  }, [
    targets,
    merged,
    prevPayments,
    prevShogaiPayments,
    keigenByUser,
    jippiTotal,
    rowBilled,
    iryohiByUser,
    mergeOffices,
    selfOfficeLabel,
    siblingInputsAll,
    bankByUser,
    officePhone,
    serviceDaysByUser,
    careOfficeByUser,
  ]);

  // 事業所合算: このシート群が実際に複数事業所を横断しているか (title の (事業所合算) 用)
  const companyMergedActive = mergeOffices && hasSiblingOffices;

  // ── 事業所合算バナー用の派生情報 (集計は use-cross-office-seikyu が実施) ──────────
  //   当タブの利用者のうち、他事業所にも当月の利用者負担がある人数 (= 合算が効いた人数)。
  const officeMergeSharedCount = useMemo(() => {
    if (!mergeOffices) return 0;
    const siblingClientIds = new Set(crossOffice.data?.clientIds ?? EMPTY_CLIENT_IDS);
    let n = 0;
    for (const r of unifiedRows) if (siblingClientIds.has(r.userId)) n += 1;
    return n;
  }, [mergeOffices, crossOffice.data, unifiedRows]);

  // ─── 請求書一括印刷 (全員 or チェック中 を 1 印刷ジョブで連続出力) ──────────
  // 既存の単票印刷 (発行ボタン) とは独立した追加機能。発行日の記録は行わない。
  const [bulkPrintOpen, setBulkPrintOpen] = useState(false);
  // 一括印刷の対象候補 = 介護・総合のみ (障害の帳票は障害請求タブ側にあるため対象外)
  const bulkCandidateRows = useMemo(
    () => unifiedRows.filter((r): r is KaigoUnifiedRow => r.system !== "障害"),
    [unifiedRows],
  );

  // ─── FB データ (全銀協 口座振替) ───────────────────────────────────────────
  // 引き落としは常に「利用者単位で 1 明細」(介護+総合の行を畳む。請求書を制度別・
  // 事業所別に発行していても引落は 1 件、という運用要件のため)。
  // さらに事業所合算 ON のときは同一法人他事業所の請求分も金額に合算する
  // = 法人全体で 1 ファイル・利用者 1 明細。移行期間 (請求書は事業所別のまま) は
  // 「印刷は合算 OFF・FB 出力だけ合算 ON」で「請求書 2 枚 + 引落 1 件」にできる。
  // ⚠ 合算 ON の FB は法人で 1 回だけ出すこと (各事業所の画面で各々出すと二重引落)。
  const exportFbData = async () => {
    // 対象: 発行対象のうち介護・総合のみ (障害は FB 除外)。金額 = 負担額 − 軽減 + 実費
    type FbUserAgg = { userId: string; name: string; kana: string | null; insured: string | null; amount: number };
    const byUser = new Map<string, FbUserAgg>();
    const addAmount = (userId: string, name: string, kana: string | null, insured: string | null, amount: number) => {
      const cur = byUser.get(userId);
      if (cur) {
        cur.amount += amount;
        if (!cur.insured && insured) cur.insured = insured;
      } else {
        byUser.set(userId, { userId, name, kana, insured, amount });
      }
    };
    for (const row of kaigoTargets) {
      const r = row.kaigo;
      addAmount(r.user_id, r.user_name, r.user_name_kana, r.insured_number, rowBilled(r));
    }
    // 事業所合算中: 他事業所分 (介護+総合、軽減適用後) を利用者単位で加算。
    // 自事業所に居ない利用者 (他事業所のみ利用) も明細に含める。
    if (mergeOffices && crossOffice.data && crossOffice.data.byOffice.length > 0) {
      let siblingRows = 0;
      for (const office of crossOffice.data.byOffice) {
        for (const r of [...mergeSegmentRows(office.kaigoRows), ...office.sougouRows]) {
          const base = userPlusSelf(r);
          addAmount(r.user_id, r.user_name, r.user_name_kana, r.insured_number, base - keigenAmount(r.user_id, base));
          siblingRows++;
        }
      }
      if (siblingRows > 0) {
        const ok = window.confirm(
          `事業所合算中のため、同一法人 ${crossOffice.data.offices.length} 事業所の請求分も利用者単位で 1 明細に合算して出力します。\n` +
            `⚠ この FB ファイルは法人で 1 回だけ出力してください (各事業所の画面で各々出力すると二重引落になります)。\n\n続行しますか？`,
        );
        if (!ok) return;
      }
    }
    // 他事業所のみ利用の利用者は口座情報が未取得のことがある → 不足分を fetch
    const missingBankIds = Array.from(byUser.keys()).filter((id) => !bankByUser.has(id));
    const extraBank = new Map<string, ClientBank>();
    for (let i = 0; i < missingBankIds.length; i += 100) {
      const chunk = missingBankIds.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("clients")
        .select("id, bank_name, bank_branch, bank_account_type, bank_account_number, bank_account_holder, postal_code, address")
        .in("id", chunk);
      if (e) {
        toast.error("口座情報取得失敗: " + e.message);
        return;
      }
      for (const c of (data ?? []) as ({ id: string } & ClientBank)[]) {
        extraBank.set(c.id, {
          bank_name: c.bank_name,
          bank_branch: c.bank_branch,
          bank_account_type: c.bank_account_type,
          bank_account_number: c.bank_account_number,
          bank_account_holder: c.bank_account_holder,
          postal_code: c.postal_code,
          address: c.address,
        });
      }
    }
    const fbTargets: FbTransferTarget[] = Array.from(byUser.values()).map((u) => {
      const bank = bankByUser.get(u.userId) ?? extraBank.get(u.userId);
      return {
        customerNumber: u.insured ?? u.userId.slice(0, 20),
        accountHolderKana: bank?.bank_account_holder ?? u.kana ?? u.name,
        bankCode: null, // clients に銀行番号は未保持 → 空欄
        branchCode: null, // 支店番号も未保持 → 空欄
        bankName: bank?.bank_name ?? null,
        branchName: bank?.bank_branch ?? null,
        accountType: bank?.bank_account_type ?? null,
        accountNumber: bank?.bank_account_number ?? null,
        amount: u.amount, // 利用者合算後の当月請求額
      };
    });

    const result = buildFbZengin(fbTargets, {
      consignorCode: null, // 委託者コードは未設定 (銀行付与) → 空欄 + warning
      consignorNameKana: officeName,
      transferDay: 27, // 引落日は既定 27 日 (対象月)
      year,
      month,
    });

    if (result.count === 0) {
      toast.error("引落対象 (金額 > 0) がありません");
      return;
    }

    if (result.warnings.length > 0) {
      const list = result.warnings.slice(0, 12).join("\n・");
      const ok = window.confirm(
        `以下の項目が未設定です (伝送前にご確認ください):\n\n・${list}${result.warnings.length > 12 ? `\n…他 ${result.warnings.length - 12} 件` : ""}\n\nこのまま FB データを出力しますか？`,
      );
      if (!ok) return;
    }

    // Shift_JIS で出力 (全銀フォーマットは Shift_JIS 固定)
    const sjis = Encoding.convert(Encoding.stringToCode(result.content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(
      `FB データ ${result.fileName} を出力しました (${result.count} 件 / 合計 ¥${result.totalAmount.toLocaleString()})`,
    );
  };

  // ─── 振替結果取込 (FB 結果ファイル → 入金自動消込) ─────────────────────────
  const [fbImport, setFbImport] = useState<FbImportState | null>(null);
  const [fbImporting, setFbImporting] = useState(false);

  // 利用者ごとの当月請求額 (介護 + 総合 の合算 = 自事業所分)。FB 依頼は利用者単位
  // 1 明細で、事業所合算出力時は他事業所分も含むため、その場合は引落金額 >
  // 自事業所請求額となり「金額差異」バッジが出ることがある (仕様。入金行は
  // client×月 で 1 行に共有されるので消込自体は全額で成立する)
  const billedForClient = useCallback(
    (clientId: string) =>
      kaigoAllRows
        .filter((r) => r.user_id === clientId)
        .reduce((s, r) => s + rowBilled(r), 0),
    [kaigoAllRows, rowBilled],
  );

  const handleFbResultFile = async (file: File) => {
    // Shift_JIS 固定長 → Unicode 文字列 (全銀の許容文字は 1 文字 = 1 バイト)
    const buf = new Uint8Array(await file.arrayBuffer());
    const unicode = Encoding.convert(buf, {
      to: "UNICODE",
      from: "SJIS",
      type: "string",
    });
    const parsed = parseFbZenginResult(unicode);
    if (parsed.details.length === 0) {
      toast.error(
        `振替結果ファイルを読み取れません:\n${parsed.errors.join("\n")}`,
      );
      return;
    }

    const warnings = [...parsed.warnings];
    // 対象月ずれの検知 (ヘッダーの引落日 MMDD の MM と表示中の対象月を照合)
    const fileMM = parseInt(parsed.header?.transferMMDD.slice(0, 2) ?? "", 10);
    if (Number.isFinite(fileMM) && fileMM >= 1 && fileMM <= 12 && fileMM !== month) {
      warnings.push(
        `ファイルの引落月 (${fileMM}月) が表示中の対象月 (${month}月) と異なります。取込前に対象月を確認してください`,
      );
    }

    // 顧客番号 → 利用者の解決 (fb-zengin.ts の customerNumber 生成規則の逆):
    //   依頼側は insured_number (被保険者番号) ?? user_id.slice(0, 20) を入れている
    const byInsured = new Map<string, UserSeikyuRow>();
    const byUuidPrefix = new Map<string, UserSeikyuRow>();
    for (const r of kaigoAllRows) {
      const ins = r.insured_number?.trim();
      if (ins && !byInsured.has(ins)) byInsured.set(ins, r);
      const pfx = r.user_id.slice(0, 20);
      if (!byUuidPrefix.has(pfx)) byUuidPrefix.set(pfx, r);
    }
    const resolveClient = (customerNumber: string): UserSeikyuRow | null =>
      byInsured.get(customerNumber) ?? byUuidPrefix.get(customerNumber) ?? null;

    // 既存の入金行を notes 込みで取得 (二重取込マーカー / 手入力済みの検知用)
    const clientIds = Array.from(
      new Set(
        parsed.details
          .map((d) => resolveClient(d.customerNumber)?.user_id)
          .filter((id): id is string => id != null),
      ),
    );
    const payByClient = new Map<string, FbPayRow>();
    for (let i = 0; i < clientIds.length; i += 100) {
      const chunk = clientIds.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("riyou_seikyu_payments")
        .select(
          "client_id, billed_amount, paid_amount, paid_date, payment_method, status, notes",
        )
        .eq("target_month", monthKey)
        .in("client_id", chunk);
      if (e) {
        // table 未作成なら既存入金なしとして続行、それ以外は取込を中止する
        if (!isTableMissingError(e.code)) {
          toast.error("既存の入金状況の取得に失敗: " + e.message);
          return;
        }
        break;
      }
      for (const p of (data ?? []) as FbPayRow[]) payByClient.set(p.client_id, p);
    }

    const marker = fbImportMarker(monthKey);
    const rows: FbPreviewRow[] = parsed.details.map((d) => {
      const client = resolveClient(d.customerNumber);
      const pay = client ? payByClient.get(client.user_id) : undefined;
      const billed = client
        ? (pay?.billed_amount ?? billedForClient(client.user_id))
        : null;
      const remaining = billed != null ? billed - (pay?.paid_amount ?? 0) : null;
      let kind: FbRowKind;
      if (!client) kind = "unmatched";
      else if (!d.transferred) kind = "failed";
      // 月マーカーは「同一対象月で FB 取込済み」の印。同月に 2 バッチ目の FB ファイルを
      // 取り込んだ場合もマーカーが付いた利用者は取込済み扱いでスキップされる (仕様)。
      // 2 バッチ目に別利用者の振替が含まれるケースはその利用者にマーカーが無いので取込対象になる。
      else if (pay?.notes?.includes(marker)) kind = "skip_marker";
      else if (pay != null && pay.paid_amount > 0 && pay.paid_amount === d.amount)
        kind = "skip_dup"; // 同一 client×月×金額 → 手入力済みの二重計上を防止
      else kind = "import";
      return {
        detail: d,
        kind,
        clientId: client?.user_id ?? null,
        clientName: client?.user_name ?? null,
        remaining,
        amountMismatch:
          kind === "import" && remaining != null && d.amount !== remaining,
      };
    });

    setFbImport({ fileName: file.name, parsed, warnings, rows, payByClient, done: null });
  };

  // 確定: 振替済 (コード 0) の消込対象を riyou_seikyu_payments へ入金記録する。
  // 同一利用者が複数明細 (介護 + 総合 等) の場合は金額を合算して 1 行に upsert。
  const confirmFbImport = async () => {
    if (!fbImport || fbImporting) return;
    const importRows = fbImport.rows.filter((r) => r.kind === "import");
    if (importRows.length === 0) return;
    setFbImporting(true);

    // 入金日 = ヘッダーの引落日 (MMDD) + 表示中の年。不正値は今日にフォールバック。
    // 引落月 < 対象月 は年跨ぎ (12月請求→1月引落 等) なので翌年扱いにする
    const mmdd = fbImport.parsed.header?.transferMMDD ?? "";
    const mm = parseInt(mmdd.slice(0, 2), 10);
    const dd = parseInt(mmdd.slice(2, 4), 10);
    const today = new Date();
    const paidYear = Number.isFinite(mm) && mm < month ? year + 1 : year;
    const paidDate =
      Number.isFinite(mm) && mm >= 1 && mm <= 12 && Number.isFinite(dd) && dd >= 1 && dd <= 31
        ? `${paidYear}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`
        : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    // 利用者単位に合算
    const byClient = new Map<string, { amount: number; name: string | null }>();
    for (const r of importRows) {
      const cur = byClient.get(r.clientId!) ?? { amount: 0, name: r.clientName };
      cur.amount += r.detail.amount;
      byClient.set(r.clientId!, cur);
    }

    const marker = fbImportMarker(monthKey);
    const dbErrors: string[] = [];
    let imported = 0;
    let importedAmount = 0;
    for (const [clientId, g] of byClient) {
      const existing = fbImport.payByClient.get(clientId);
      const billed = existing?.billed_amount ?? billedForClient(clientId);
      const newPaid = (existing?.paid_amount ?? 0) + g.amount;
      const status =
        newPaid >= billed && billed > 0 ? "入金完" : newPaid > 0 ? "一部入金" : "請求済";
      const notes = existing?.notes ? `${existing.notes} ${marker}` : marker;
      const { error: e } = await supabase.from("riyou_seikyu_payments").upsert(
        {
          client_id: clientId,
          target_month: monthKey,
          billed_amount: billed,
          paid_amount: newPaid,
          paid_date: paidDate,
          payment_method: "口座振替",
          status,
          notes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_id,target_month" },
      );
      if (e) {
        dbErrors.push(`${g.name ?? clientId}: ${e.message}`);
        continue;
      }
      imported++;
      importedAmount += g.amount;
    }

    setFbImporting(false);
    if (dbErrors.length > 0) {
      toast.error(`入金登録に失敗した利用者があります (${dbErrors.length} 件)`);
    } else {
      toast.success(
        `振替結果を消込しました (${imported} 名 / ¥${importedAmount.toLocaleString()})`,
      );
    }
    setFbImport((prev) =>
      prev ? { ...prev, done: { imported, amount: importedAmount, dbErrors } } : prev,
    );
    loadPayments();
  };

  // ── フッタ集計 (order-app の 件数合計/確定合計 に対応。全制度合算) ──
  const issuedRows = unifiedRows.filter((r) => paymentForRow(r) != null);
  const issuedTotal = issuedRows.reduce(
    (s, r) => s + (paymentForRow(r)?.billed_amount ?? 0),
    0,
  );
  const paidTotal = unifiedRows.reduce(
    (s, r) => s + (paymentForRow(r)?.paid_amount ?? 0),
    0,
  );
  const misyuCount = unifiedRows.filter((r) => {
    const p = paymentForRow(r);
    return p && p.status !== "入金完";
  }).length;

  // 制度別の請求額小計 (介護 / 総合 / 障害)
  const subtotalBySystem = useMemo(() => {
    const m: Record<SeikyuSystem, number> = { 介護: 0, 総合事業: 0, 障害: 0 };
    for (const r of unifiedRows) m[r.system] += billedForRow(r);
    return m;
  }, [unifiedRows, billedForRow]);
  const countBySystem = useMemo(() => {
    const m: Record<SeikyuSystem, number> = { 介護: 0, 総合事業: 0, 障害: 0 };
    for (const r of unifiedRows) m[r.system] += 1;
    return m;
  }, [unifiedRows]);

  // 軽減 / 繰越 / 医療費控除 の全体合計 (介護 + 総合 のみ。障害は N/A)。
  const keigenTotal = kaigoAllRows.reduce(
    (s, r) => s + (keigenByUser.get(r.user_id) ?? 0),
    0,
  );
  const iryohiTotal = kaigoAllRows.reduce(
    (s, r) => s + (iryohiByUser.get(r.user_id) ?? 0),
    0,
  );
  // 過入金充当額 = 負の繰越 (前月過入金) の合計絶対値 / 未収繰越 = 正の繰越の合計。
  // 介護 + 総合 は従来 carryover、障害は shogaiCarryover を足す (介護分の値は不変)。
  const overpayTotal =
    kaigoAllRows.reduce((s, r) => {
      const c = carryover(r.user_id);
      return s + (c < 0 ? -c : 0);
    }, 0) +
    filteredShogaiRows.reduce((s, r) => {
      const c = shogaiCarryover(r.user_id);
      return s + (c < 0 ? -c : 0);
    }, 0);
  const misyuCarryTotal =
    kaigoAllRows.reduce((s, r) => {
      const c = carryover(r.user_id);
      return s + (c > 0 ? c : 0);
    }, 0) +
    filteredShogaiRows.reduce((s, r) => {
      const c = shogaiCarryover(r.user_id);
      return s + (c > 0 ? c : 0);
    }, 0);

  // 選択行のフッタ詳細 (未選択時は全体合計 — order-app と同じ)。
  // 障害は軽減/繰越/医療費控除が N/A なので 0。
  const selIsShogai = selected?.system === "障害";
  const selKaigo = selected && !selIsShogai ? selected.kaigo : null;
  const selAmount = selected ? billedForRow(selected) : totalBilled;
  const selKeigen = selected
    ? selKaigo
      ? (keigenByUser.get(selKaigo.user_id) ?? 0)
      : 0
    : keigenTotal;
  const selIryohi = selected
    ? selKaigo
      ? (iryohiByUser.get(selKaigo.user_id) ?? 0)
      : 0
    : iryohiTotal;
  // 選択行の繰越は制度で振り分け (障害も含めて表示。介護/総合 は従来値のまま)。
  const selOverpay = selected
    ? Math.max(0, -carryoverForRow(selected))
    : overpayTotal;
  const selMisyuCarry = selected
    ? Math.max(0, carryoverForRow(selected))
    : misyuCarryTotal;

  const checkedCount = unifiedRows.filter((r) => checked.has(r.key)).length;
  const printScopeLabel =
    checkedCount > 0 ? `対象 ${checkedCount} 名` : `全 ${unifiedRows.length} 名`;
  const allChecked =
    unifiedRows.length > 0 && checked.size === unifiedRows.length;

  const statusBadge = (row: UnifiedRow) => {
    const p = paymentForRow(row);
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

  return (
    <>
      <div className="flex flex-1 min-h-0 print:hidden">
        {/* ── 左: かな行フィルター ── */}
        <SeikyuKanaSidebar />

        {/* ── 中央: ツールバー + テーブル + フッタ ── */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200">
          {/* ツールバー */}
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
            <SeikyuMonthNav />
            <span className="text-xs text-gray-500">{unifiedRows.length} 件</span>
            <span className="text-[10px] text-gray-400">
              (介護 {countBySystem.介護} / 総合 {countBySystem.総合事業} / 障害 {countBySystem.障害})
            </span>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button
              type="button"
              onClick={issueSeikyusho}
              disabled={unifiedRows.length === 0 || printDocs.size === 0}
              title={`選択した綴りを印刷 (${printScopeLabel})。請求書を含む場合は発行日を記録します (保存先は制度で振り分け)。「名寄」チェック 2 名以上は 1 枚の世帯合算請求書になります (介護・総合のみ)。領収書は入金済み (入金完/一部入金) の行から発行します`}
              className="border border-emerald-500 rounded bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <FileText size={13} />
              発行 ({targets.length}件)
            </button>
            {/* 綴り選択 (ほのぼの流: 請求書 / 請求書控え / 領収書 / 領収書控え) */}
            <span className="flex items-center gap-2 border border-gray-300 rounded bg-white px-2 py-1 text-[11px] text-gray-700">
              {PRINT_DOC_LABELS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-0.5 cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={printDocs.has(key)}
                    onChange={() => togglePrintDoc(key)}
                    className="cursor-pointer"
                  />
                  {label}
                </label>
              ))}
              {(printDocs.has("ryoshu") || printDocs.has("ryoshuHikae")) && (
                <span className="text-[10px] text-gray-400 whitespace-nowrap">
                  (領収書 {ryoshuTargets.length} 件)
                </span>
              )}
            </span>
            {/* 合算モード (一覧の表示制度 + 印刷レイヤーに効く。金額計算は不変) */}
            <span className="flex items-center gap-2 border border-gray-300 rounded bg-white px-2 py-1 text-[11px] text-gray-700">
              <span className="text-gray-400">合算:</span>
              <label
                className="flex items-center gap-0.5 cursor-pointer select-none whitespace-nowrap"
                title="ON = 介護 / 総合 / 障害 を 1 リストに並べ、同一利用者の利用者負担を 1 枚に合算 (制度別セクション + 合計)。OFF = この画面は 介護 + 総合 のみ表示し、制度ごとに別枚 (障害は障害タブで請求)"
              >
                <input
                  type="checkbox"
                  checked={mergeSystems}
                  onChange={() => setMergeSystems((v) => !v)}
                  className="cursor-pointer"
                />
                制度合算
              </label>
              <label
                className="flex items-center gap-0.5 cursor-pointer select-none whitespace-nowrap"
                title="ON (既定) = 同一法人 (company_id) の全 介護事業所分の利用者負担を横断集計し、利用者ごとに 1 枚へ合算します (法人が違えば別枚)。OFF = 自事業所分のみ (従来)。金額は各事業所タブの集計と一致 (印刷・表示レイヤーのみ / 発行記録・入金は事業所別のまま)"
              >
                <input
                  type="checkbox"
                  checked={mergeOffices}
                  onChange={() => setMergeOffices((v) => !v)}
                  className="cursor-pointer"
                />
                事業所合算
                {mergeOffices && crossOffice.loading && (
                  <Loader2 size={11} className="animate-spin text-indigo-400" />
                )}
              </label>
            </span>
            <button
              type="button"
              onClick={() => setBulkPrintOpen(true)}
              disabled={bulkCandidateRows.length === 0}
              title="対象月の請求書 (・領収書) を全員分またはチェック中の利用者分、1 回の印刷ジョブで連続出力します (ブラウザの印刷 → PDF 保存で一括 PDF 化)。発行日の記録は行いません (記録は「発行」ボタン)。障害は対象外"
              className="border border-purple-500 rounded bg-purple-50 px-2.5 py-1 text-purple-700 hover:bg-purple-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <Printer size={13} />
              請求書一括印刷
            </button>
            <button
              type="button"
              onClick={() => void exportFbData()}
              disabled={kaigoTargets.length === 0}
              title="全銀協 口座振替フォーマット (Shift_JIS) で FB データを出力 (介護・総合のみ / 障害は対象外)。引落は利用者単位で 1 明細に合算 (請求書が制度別・事業所別でも引落は 1 件)。事業所合算 ON のときは同一法人他事業所分も合算します"
              className="border border-blue-500 rounded bg-blue-50 px-2.5 py-1 text-blue-700 hover:bg-blue-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <Banknote size={13} />
              FBデータ ({kaigoTargets.length}件)
            </button>
            <label
              title="金融機関から返却された振替結果ファイル (全銀協フォーマット / Shift_JIS) を取り込み、振替済 (結果コード 0) の明細を入金として自動消込します。⚠ 実際の金融機関返却ファイルでの検証は未実施のため、プレビュー内容を必ず確認してください"
              className="border border-indigo-500 rounded bg-indigo-50 px-2.5 py-1 text-indigo-700 hover:bg-indigo-100 flex items-center gap-1.5 text-xs font-medium cursor-pointer"
            >
              <Upload size={13} />
              振替結果取込
              <input
                type="file"
                accept=".txt,.dat,.fb,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFbResultFile(f);
                  e.target.value = ""; // 同じファイルの再選択を許可
                }}
              />
            </label>
            <span className="text-[11px] text-gray-400">{printScopeLabel}</span>
          </div>

          {/* 事業所合算 (法人横断) の状態表示 — 1 行要約 + ▾詳細 展開 (集計は印刷レイヤーに反映済)。
              siblング無し (合算不発) はバナー自体を出さない (画面を占有しない) */}
          {mergeOffices && (crossOffice.loading || crossOffice.errors.length > 0 || hasSiblingOffices) && (
            <div className="border-b border-slate-200 bg-slate-50 px-3 py-1 shrink-0 text-xs text-slate-600">
              {crossOffice.loading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  同一法人の他事業所分を集計中…
                </span>
              ) : crossOffice.errors.length > 0 ? (
                <span
                  className="flex items-center gap-1.5 text-red-700"
                  title={crossOffice.errors.join("\n")}
                >
                  <AlertTriangle size={12} className="shrink-0" />
                  一部事業所の集計に失敗 ({crossOffice.errors.length} 件)・成功分のみ合算中
                </span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      title={(crossOffice.data?.offices ?? []).map((s) => s.name).join(" / ")}
                    >
                      同一法人 {crossOffice.data?.offices.length} 事業所を合算中・共有利用者{" "}
                      {officeMergeSharedCount} 名
                    </span>
                    <button
                      type="button"
                      onClick={() => setOfficeBannerOpen((v) => !v)}
                      className="text-slate-400 hover:text-slate-600"
                    >
                      {officeBannerOpen ? "▴閉じる" : "▾詳細"}
                    </button>
                  </div>
                  {officeBannerOpen && (
                    <div className="pb-0.5 text-[11px] text-slate-500">
                      {(crossOffice.data?.offices ?? []).map((s) => s.name).join(" / ")}
                      <span className="ml-1">
                        ※ 発行記録・入金は従来どおり事業所別・制度別。FB データは利用者単位 1 明細で、合算 ON 中は法人全体を含めて出力 (法人で 1 回だけ出力すること)
                      </span>
                    </div>
                  )}
                </div>
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
              {/* テーブル (order-app UserBillingTab と同一列構成) */}
              <div className="flex-1 overflow-auto">
                <table className="min-w-full text-[11px] leading-4 border-collapse">
                  <thead className="bg-gradient-to-b from-sky-100 to-sky-200 text-gray-700 sticky top-0 z-10">
                    <tr>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-center w-10">
                        <label
                          className="inline-flex cursor-pointer select-none flex-col items-center gap-0.5"
                          title="全選択"
                        >
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={toggleAll}
                            className="cursor-pointer"
                          />
                          <span className="text-[9px] font-normal">対象</span>
                        </label>
                      </th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-center w-10">名寄</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-center w-16">制度</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-center w-16">状態</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-left whitespace-nowrap">利用者名</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-left">事業所名</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-left w-24">番号</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-left w-24">支払方法</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-right w-24">請求額</th>
                      <th className="px-1 py-0.5 border-b border-l border-gray-300 text-left w-44 whitespace-nowrap">請求書発行日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedRows.map((row) => {
                      const p = paymentForRow(row);
                      const isSelected = selectedKey === row.key;
                      const isShogai = row.system === "障害";
                      const userName = isShogai ? row.shogai.user_name : row.kaigo.user_name;
                      const numberCell = isShogai
                        ? row.shogai.beneficiary_number
                        : row.kaigo.insured_number;
                      const keigen = isShogai ? 0 : (keigenByUser.get(row.userId) ?? 0);
                      const billed = billedForRow(row);
                      return (
                        <tr
                          key={row.key}
                          className={`cursor-pointer ${isSelected ? "bg-indigo-50" : "hover:bg-blue-50"}`}
                          onClick={() => setSelectedKey(row.key)}
                        >
                          <td className="px-1 py-0.5 border-b border-l border-gray-200 text-center">
                            <input
                              type="checkbox"
                              checked={checked.has(row.key)}
                              onChange={() => toggle(row.key)}
                              onClick={(e) => e.stopPropagation()}
                              className="cursor-pointer"
                            />
                          </td>
                          <td className="px-1 py-0.5 border-b border-l border-gray-200 text-center">
                            {/* 名寄せは介護・総合のみ (障害は世帯合算対象外) */}
                            {isShogai ? (
                              <span className="text-[10px] text-gray-300" title="障害は名寄せ対象外">
                                —
                              </span>
                            ) : (
                              <input
                                type="checkbox"
                                checked={merged.has(row.key)}
                                onChange={() => toggleMerged(row.key)}
                                onClick={(e) => e.stopPropagation()}
                                className="cursor-pointer"
                                title="名寄せ (チェックした利用者を世帯合算の請求書 1 枚に合算)"
                              />
                            )}
                          </td>
                          <td className="px-1 py-0.5 border-b border-l border-gray-200 text-center">
                            <span
                              className={`inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-semibold ${SYSTEM_BADGE_CLS[row.system]}`}
                            >
                              {row.system}
                            </span>
                          </td>
                          <td className="px-1 py-0.5 border-b border-l border-gray-200 text-center">
                            {statusBadge(row)}
                          </td>
                          <td className="px-1 py-0.5 border-b border-l border-gray-200 font-medium whitespace-nowrap">
                            {userName}
                          </td>
                          <td
                            className="px-1 py-0.5 border-b border-l border-gray-200 truncate max-w-[200px]"
                            title={officeName ?? ""}
                          >
                            {officeName ?? "-"}
                          </td>
                          <td className="px-1 py-0.5 border-b border-l border-gray-200 font-mono">
                            {numberCell ?? "-"}
                          </td>
                          <td
                            className="px-1 py-0.5 border-b border-l border-gray-200"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <select
                              value={p?.payment_method ?? ""}
                              onChange={(e) => setPaymentMethod(row, e.target.value)}
                              className="w-full bg-transparent border-0 text-xs focus:bg-white focus:border focus:border-indigo-300 focus:outline-none rounded px-1 py-0.5"
                            >
                              {PAYMENT_METHOD_OPTIONS.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt || "—"}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td
                            className="px-1 py-0.5 border-b border-l border-gray-200 text-right font-mono"
                            title={
                              keigen > 0
                                ? `軽減 ▲¥${keigen.toLocaleString()} 適用後`
                                : undefined
                            }
                          >
                            ¥{billed.toLocaleString()}
                            {keigen > 0 && (
                              <span className="ml-1 text-[9px] text-rose-500 font-sans">軽</span>
                            )}
                          </td>
                          <td
                            className="px-1 py-0.5 border-b border-l border-gray-200 whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* 発行日 (西暦入力) + 令和表記を同一行に置き、請求済でも
                                行が2行分に太らないようにする (令和は input の右にインライン) */}
                            <div className="flex items-center gap-1">
                              <input
                                type="date"
                                value={p?.issued_date ?? ""}
                                onChange={(e) => setIssuedDate(row, e.target.value)}
                                className="w-[112px] shrink-0 bg-transparent border-0 text-xs focus:bg-white focus:border focus:border-indigo-300 focus:outline-none rounded px-1 py-0.5"
                              />
                              {p?.issued_date && (
                                <span className="shrink-0 text-[10px] text-gray-400">
                                  {fmtReiwaDate(p.issued_date)}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {unifiedRows.length === 0 && (
                      <tr>
                        <td colSpan={10} className="px-3 py-8 text-center text-gray-400 text-sm">
                          対象月の実績 (完了) がありません
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* フッタ: 総合計 + 選択行詳細 (order-app と同一レイアウト)。
                  介護請求/障害請求のフッタと同じ box 帯に合わせる */}
              <div className="border-t border-gray-400 bg-gray-100 px-3 py-1.5 shrink-0 text-[11px]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-gray-700">
                  {/* 主要合計は介護請求/障害請求と同じ box 型 (ラベル=水色枠 + 値=白枠) */}
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">件数合計</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[56px] text-right font-mono font-semibold">{unifiedRows.length.toLocaleString()}</span>
                  </span>
                  <span className="inline-flex">
                    <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">請求額合計</span>
                    <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[88px] text-right font-mono font-semibold">¥{totalBilled.toLocaleString()}</span>
                  </span>
                  {/* 制度別小計 */}
                  <span className="text-[11px] text-gray-500">
                    (介護 ¥{subtotalBySystem.介護.toLocaleString()} / 総合 ¥
                    {subtotalBySystem.総合事業.toLocaleString()} / 障害 ¥
                    {subtotalBySystem.障害.toLocaleString()})
                  </span>
                  <span className="text-gray-500">
                    確 件数合計{" "}
                    <span className="font-mono font-semibold">{issuedRows.length.toLocaleString()}</span>
                  </span>
                  <span className="text-gray-500">
                    確定請求額合計{" "}
                    <span className="font-mono font-semibold">¥{issuedTotal.toLocaleString()}</span>
                  </span>
                  <span className="text-gray-500">
                    入金額合計{" "}
                    <span className="font-mono font-semibold">¥{paidTotal.toLocaleString()}</span>
                  </span>
                  {misyuCount > 0 && (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-600">
                      未入金 {misyuCount} 件
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-gray-600">
                  <span>
                    合計金額 <span className="font-mono">¥{selAmount.toLocaleString()}</span>
                  </span>
                  <span>
                    過入金充当額 <span className="font-mono">¥{selOverpay.toLocaleString()}</span>
                  </span>
                  <span>
                    軽減額 <span className="font-mono">¥{selKeigen.toLocaleString()}</span>
                  </span>
                  <span>
                    医療費控除対象額 <span className="font-mono">¥{selIryohi.toLocaleString()}</span>
                  </span>
                  <span>
                    消費税額 <span className="font-mono">¥0</span>
                  </span>
                  {selMisyuCarry > 0 && (
                    <span className="text-[10px] text-red-500 self-center">
                      (未収繰越 ¥{selMisyuCarry.toLocaleString()})
                    </span>
                  )}
                  <span className="font-semibold text-gray-800">
                    請求金額 <span className="font-mono">¥{selAmount.toLocaleString()}</span>
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── 右ペイン: 利用明細欄 (幅・青帯を介護請求/障害請求の明細情報ペインに揃える) ── */}
        <div className="w-96 shrink-0 flex flex-col bg-white">
          <div className="border-b border-sky-700 bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-1 shrink-0 flex items-center justify-between">
            <span className="text-xs font-bold text-white">利用明細欄</span>
            {selected && (
              <span className="text-xs text-sky-100 truncate max-w-[160px]">
                {selected.system === "障害"
                  ? selected.shogai.user_name
                  : selected.kaigo.user_name}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            {!selected && (
              <div className="p-4 text-center text-gray-400 text-xs">
                左の行をクリックすると明細が表示されます
              </div>
            )}
            {/* ── 介護 / 総合: 従来どおりの利用明細欄 (軽減・実費・医療費控除・入金) ── */}
            {selected && selected.system !== "障害" && (
              <RiyouKaigoDetail
                selected={selected.kaigo}
                monthKey={monthKey}
                keigenByUser={keigenByUser}
                iryohiByUser={iryohiByUser}
                settings={settings}
                jippiByUser={jippiByUser}
                jippiTotal={jippiTotal}
                rowBilled={rowBilled}
                carryover={carryover}
                payments={payments}
                onJippiChanged={loadJippi}
                onSettingsChanged={loadSettings}
                onPaymentChanged={loadPayments}
              />
            )}
            {/* ── 障害: 明細 + 入金のみ (軽減/実費/医療費控除は N/A) ── */}
            {selected && selected.system === "障害" && (
              <ShogaiRiyouDetail
                selected={selected.shogai}
                monthKey={monthKey}
                payment={shogaiPayments.get(selected.userId) ?? null}
                carryover={shogaiCarryover(selected.userId)}
                onPaymentChanged={loadShogaiPayments}
              />
            )}
          </div>
        </div>
      </div>

      {/* ===== 請求書一括印刷 プレビュー (単票コンポーネントを page-break で連結) ===== */}
      {bulkPrintOpen && (
        <RiyouBulkPrintView
          rows={bulkCandidateRows}
          allRows={unifiedRows}
          mergeSystems={mergeSystems}
          mergeOffices={mergeOffices}
          companyMerged={companyMergedActive}
          siblingInputsAll={siblingInputsAll}
          checkedKeys={checked}
          mergedKeys={merged}
          rowBilled={rowBilled}
          payments={payments}
          jippiByUser={jippiByUser}
          keigenByUser={keigenByUser}
          iryohiByUser={iryohiByUser}
          prevPayments={prevPayments}
          prevShogaiPayments={prevShogaiPayments}
          officeName={officeName}
          officePhone={officePhone}
          company={sheetCompany}
          bankByUser={bankByUser}
          reiwa={reiwa}
          year={year}
          month={month}
          onClose={() => setBulkPrintOpen(false)}
        />
      )}

      {/* ===== 振替結果取込 プレビュー / 確定 モーダル ===== */}
      {fbImport && (
        <FbResultImportDialog
          state={fbImport}
          importing={fbImporting}
          monthLabel={`${year}年${month}月`}
          onConfirm={confirmFbImport}
          onClose={() => setFbImport(null)}
        />
      )}

      {/* ===== 印刷 view: 綴り選択 (請求書 / 請求書控え / 領収書 / 領収書控え) =====
          請求書: 名寄チェック 2 名以上 → 1 枚の世帯合算請求書 / それ以外 → 1 名 1 枚
          (order-app UserBillingTab の請求書発行と同じ操作感)。控えは同一内容に「控」表記。
          領収書: 入金済み (入金完/一部入金) の行から 1 名 1 枚 (様式は請求書流用のシンプル版) */}
      {printing && (
        <div className="hidden print:block">
          {(["seikyu", "seikyuHikae"] as const)
            .filter((k) => printDocs.has(k))
            .map((k) => {
              const isCopy = k === "seikyuHikae";
              // 制度合算 ON → 利用者単位の合算シート (介護/総合/障害を 1 枚に)。
              // OFF → 従来どおり 介護/総合 の既存シート (障害は障害請求タブ側)。
              if (mergeSystems) {
                return (
                  <div key={k}>
                    {mergedPrintGroups.household.length >= 2 && (
                      <RiyouSeikyuMergedPrintSheet
                        clients={mergedPrintGroups.household}
                        officeName={officeName}
                        reiwa={reiwa}
                        month={month}
                        isCopy={isCopy}
                        companyMerged={companyMergedActive}
                        company={sheetCompany}
                      />
                    )}
                    {mergedPrintGroups.singles.map((c) => (
                      <RiyouSeikyuMergedPrintSheet
                        key={`${k}-${c.userId}`}
                        clients={[c]}
                        officeName={officeName}
                        reiwa={reiwa}
                        month={month}
                        isCopy={isCopy}
                        companyMerged={companyMergedActive}
                        company={sheetCompany}
                      />
                    ))}
                  </div>
                );
              }
              return (
                <div key={k}>
                  {printGroups.household.length >= 2 && (
                    <RiyouSeikyuHouseholdPrintSheet
                      rows={printGroups.household}
                      jippiByUser={jippiByUser}
                      keigenByUser={keigenByUser}
                      iryohiByUser={iryohiByUser}
                      prevPayments={prevPayments}
                      officeName={officeName}
                      reiwa={reiwa}
                      month={month}
                      isCopy={isCopy}
                    />
                  )}
                  {printGroups.singles.map((r) => (
                    <RiyouSeikyuPrintSheet
                      key={`${k}-${r.user_id}`}
                      row={r}
                      jippi={jippiByUser.get(r.user_id) ?? []}
                      keigen={keigenByUser.get(r.user_id) ?? 0}
                      iryohi={
                        iryohiByUser.has(r.user_id)
                          ? (iryohiByUser.get(r.user_id) ?? 0)
                          : null
                      }
                      prevPayment={prevPayments.get(r.user_id) ?? null}
                      officeName={officeName}
                      reiwa={reiwa}
                      month={month}
                      isCopy={isCopy}
                    />
                  ))}
                </div>
              );
            })}
          {(["ryoshu", "ryoshuHikae"] as const)
            .filter((k) => printDocs.has(k))
            .map((k) => (
              <div key={k}>
                {ryoshuTargets.map(({ row: r, payment: pay }) => (
                  <RyoshuPrintSheet
                    key={`${k}-${r.user_id}`}
                    row={r}
                    payment={pay}
                    officeName={officeName}
                    reiwa={reiwa}
                    month={month}
                    isCopy={k === "ryoshuHikae"}
                  />
                ))}
              </div>
            ))}
        </div>
      )}
    </>
  );
}

// ─── 振替結果取込 プレビュー / 確定 ダイアログ ────────────────────────────────
// プレビュー: 成功/不能の件数・不能理由別集計・突合不能行 (赤字)・金額不一致警告。
// 確定後: 消込結果 + 振替不能一覧 (再請求・現金回収の案内) を表示する。
function FbResultImportDialog({
  state,
  importing,
  monthLabel,
  onConfirm,
  onClose,
}: {
  state: FbImportState;
  importing: boolean;
  /** 表示中の対象月 (例: 2026年7月) */
  monthLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { parsed, rows, warnings, done, fileName } = state;
  const importRows = rows.filter((r) => r.kind === "import");
  const failedRows = rows.filter((r) => r.kind === "failed");
  const unmatchedRows = rows.filter((r) => r.kind === "unmatched");
  const skippedRows = rows.filter(
    (r) => r.kind === "skip_marker" || r.kind === "skip_dup",
  );
  const importAmount = importRows.reduce((s, r) => s + r.detail.amount, 0);
  const failedAmount = failedRows.reduce((s, r) => s + r.detail.amount, 0);
  const mismatchCount = importRows.filter((r) => r.amountMismatch).length;

  // 振替不能の理由コード別集計 (表示時のみ計算 — メモ化不要の軽量処理)
  const failReasonMap = new Map<string, number>();
  for (const r of failedRows) {
    failReasonMap.set(r.detail.resultLabel, (failReasonMap.get(r.detail.resultLabel) ?? 0) + 1);
  }
  const failReasons = Array.from(failReasonMap.entries());

  const mmdd = parsed.header?.transferMMDD ?? "";
  const transferDayLabel =
    mmdd.length === 4 ? `${parseInt(mmdd.slice(0, 2), 10)}/${parseInt(mmdd.slice(2, 4), 10)}` : "—";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 print:hidden">
      <div className="flex max-h-full w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl">
        {/* ヘッダー */}
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
            <Upload size={15} className="text-indigo-600" />
            振替結果取込 — {monthLabel}分
            <span className="font-normal text-xs text-gray-500 truncate max-w-[240px]">
              ({fileName})
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            title="閉じる"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3 text-xs space-y-3">
          {/* ⚠ 実ファイル未検証注記 (常時表示) */}
          <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              自前の FB 依頼ファイルとの往復整合は確認済みですが、
              <b>実際の金融機関が返却する結果ファイルでの検証は未実施</b>です。
              初回取込時は下記プレビュー (利用者・金額・結果) を必ず目視確認してから確定してください。
            </span>
          </div>

          {/* ファイル情報 */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-gray-600">
            <span>
              引落日 <b className="font-mono">{transferDayLabel}</b>
            </span>
            <span>
              委託者 <b>{parsed.header?.consignorName || "—"}</b>
            </span>
            <span>
              明細 <b className="font-mono">{rows.length}</b> 件
            </span>
            {parsed.trailer && (
              <span>
                トレーラ合計 <b className="font-mono">¥{parsed.trailer.totalAmount.toLocaleString()}</b>
              </span>
            )}
          </div>

          {/* パースエラー / 警告 */}
          {parsed.errors.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700 space-y-0.5">
              {parsed.errors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50/60 px-3 py-2 text-amber-700 space-y-0.5">
              {warnings.map((w, i) => (
                <p key={i}>・{w}</p>
              ))}
            </div>
          )}

          {/* 集計チップ */}
          <div className="flex flex-wrap gap-2">
            <span className="rounded bg-emerald-100 px-2 py-1 font-semibold text-emerald-700">
              振替済 (消込対象) {importRows.length} 件 / ¥{importAmount.toLocaleString()}
            </span>
            <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-700">
              振替不能 {failedRows.length} 件 / ¥{failedAmount.toLocaleString()}
            </span>
            {unmatchedRows.length > 0 && (
              <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-700">
                突合不能 {unmatchedRows.length} 件
              </span>
            )}
            {skippedRows.length > 0 && (
              <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-600">
                スキップ {skippedRows.length} 件 (取込済み/同額入金あり)
              </span>
            )}
            {mismatchCount > 0 && (
              <span className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-700">
                ⚠ 金額不一致 {mismatchCount} 件
              </span>
            )}
          </div>

          {/* 不能理由別集計 */}
          {failReasons.length > 0 && (
            <div className="text-gray-600">
              不能理由別:{" "}
              {failReasons.map(([label, n]) => (
                <span key={label} className="mr-3">
                  {label} <b className="font-mono">{n}</b> 件
                </span>
              ))}
            </div>
          )}

          {/* 明細テーブル */}
          <table className="w-full border-collapse">
            <thead className="bg-gray-100 text-gray-600">
              <tr>
                <th className="border border-gray-200 px-2 py-1 text-right w-10">行</th>
                <th className="border border-gray-200 px-2 py-1 text-left">顧客番号</th>
                <th className="border border-gray-200 px-2 py-1 text-left">利用者</th>
                <th className="border border-gray-200 px-2 py-1 text-right w-24">引落金額</th>
                <th className="border border-gray-200 px-2 py-1 text-left w-28">振替結果</th>
                <th className="border border-gray-200 px-2 py-1 text-left">状態 / 備考</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const badge = FB_KIND_BADGE[r.kind];
                const isRed = r.kind === "unmatched" || r.kind === "failed";
                return (
                  <tr key={r.detail.line} className={isRed ? "bg-red-50/50" : undefined}>
                    <td className="border border-gray-200 px-2 py-1 text-right font-mono text-gray-400">
                      {r.detail.line}
                    </td>
                    <td className="border border-gray-200 px-2 py-1 font-mono">
                      {r.detail.customerNumber || "—"}
                    </td>
                    <td
                      className={`border border-gray-200 px-2 py-1 ${r.clientName ? "" : "font-semibold text-red-600"}`}
                    >
                      {r.clientName ?? "突合不能 (該当利用者なし)"}
                    </td>
                    <td className="border border-gray-200 px-2 py-1 text-right font-mono">
                      ¥{r.detail.amount.toLocaleString()}
                    </td>
                    <td
                      className={`border border-gray-200 px-2 py-1 ${r.detail.transferred ? "text-emerald-700" : "font-semibold text-red-600"}`}
                    >
                      {r.detail.resultLabel}
                      {r.detail.resultCode !== "" && (
                        <span className="ml-1 text-[10px] text-gray-400">
                          ({r.detail.resultCode})
                        </span>
                      )}
                    </td>
                    <td className="border border-gray-200 px-2 py-1">
                      <span
                        className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      {r.amountMismatch && r.remaining != null && (
                        <span className="ml-1.5 text-[10px] font-semibold text-amber-700">
                          ⚠ 請求残額 ¥{r.remaining.toLocaleString()} と不一致
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 振替不能一覧の案内 (再請求・現金回収) */}
          {failedRows.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50/60 px-3 py-2 text-red-700">
              振替不能 {failedRows.length} 件には入金を立てていません (未収のまま残ります)。
              理由コードを確認のうえ、<b>再請求 (請求書の再発行) または現金回収</b>をご案内ください。
              口座解約 (取引なし) や依頼書なしの場合は口座情報の再登録が必要です。
            </div>
          )}

          {/* 確定後の結果 */}
          {done && (
            <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 font-semibold text-emerald-800">
              {done.imported} 名 / ¥{done.amount.toLocaleString()} を入金登録しました
              (入金方法: 口座振替)。
              {done.dbErrors.length > 0 && (
                <span className="mt-1 block font-normal text-red-600">
                  登録失敗: {done.dbErrors.join(" / ")}
                </span>
              )}
            </div>
          )}
        </div>

        {/* フッタ */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 shrink-0">
          {done ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-gray-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
            >
              閉じる
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={importing}
                className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={importing || importRows.length === 0}
                title={
                  importRows.length === 0
                    ? "消込対象 (振替済かつ未取込) の明細がありません"
                    : mismatchCount > 0
                      ? "金額不一致の明細が含まれます。内容を確認のうえ確定してください"
                      : undefined
                }
                className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {importing && <Loader2 size={13} className="animate-spin" />}
                入金消込を確定 ({importRows.length} 件 / ¥{importAmount.toLocaleString()})
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 明細行の利用者負担額 比例配分 (端数は最大行に寄せて合計を一致させる) ──────
// ※ 法定負担 (userAmount) を明細行へ比例配分し、区分支給限度基準の超過自費
//    (selfPayAmount = 超過単位×単価×10割) は独立行で内訳表示する (aggregate.ts で分離)。
//    ほのぼのは全額自費を別請求書にするが、ここでは利用請求に合算する方式
//    (合計 = userAmount + selfPayAmount = 従来の請求額)。
interface RiyouLine {
  label: string;
  unitPer: number | null;
  count: number;
  amount: number;
}

function splitUserAmount(row: UserSeikyuRow): RiyouLine[] {
  const lines: RiyouLine[] = row.details.map((d) => ({
    label: d.short_name ?? d.service_type,
    unitPer: d.unit_per,
    count: d.count,
    amount:
      row.totalUnits > 0
        ? Math.floor((d.units * row.userAmount) / row.totalUnits)
        : 0,
  }));
  if (row.addonUnits > 0) {
    lines.push({
      label: row.addonLabel ?? "処遇改善加算",
      unitPer: null,
      count: 1,
      amount:
        row.totalUnits > 0
          ? Math.floor((row.addonUnits * row.userAmount) / row.totalUnits)
          : 0,
    });
  }
  // floor の切捨て分を最大金額の行に加算して合計 = userAmount (法定負担) にする
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  const diff = row.userAmount - sum;
  if (diff !== 0 && lines.length > 0) {
    const maxLine = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
    maxLine.amount += diff;
  }
  // 超過自費 (保険給付外の全額自費) は独立行で内訳表示
  if (row.selfPayAmount > 0) {
    lines.push({
      label: `限度額超過分 全額自費 (${row.overUnits.toLocaleString()}単位)`,
      unitPer: null,
      count: 1,
      amount: row.selfPayAmount,
    });
  }
  return lines;
}

// ─── 介護 / 総合 の利用明細欄 (従来の右ペイン body を component 化。挙動は不変) ──
//    軽減 / 実費 / 医療費控除 / 前月繰越 / 入金 (riyou_seikyu_payments) を扱う。
function RiyouKaigoDetail({
  selected,
  monthKey,
  keigenByUser,
  iryohiByUser,
  settings,
  jippiByUser,
  jippiTotal,
  rowBilled,
  carryover,
  payments,
  onJippiChanged,
  onSettingsChanged,
  onPaymentChanged,
}: {
  selected: UserSeikyuRow;
  monthKey: string;
  keigenByUser: Map<string, number>;
  iryohiByUser: Map<string, number>;
  settings: Map<string, RiyouSettingRow>;
  jippiByUser: Map<string, JippiEntry[]>;
  jippiTotal: (userId: string) => number;
  rowBilled: (r: UserSeikyuRow) => number;
  carryover: (userId: string) => number;
  payments: Map<string, PaymentRow>;
  onJippiChanged: () => void;
  onSettingsChanged: () => void;
  onPaymentChanged: () => void;
}) {
  return (
    <>
      <table className="w-full text-xs border-collapse">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-2 py-1 border-b border-gray-200 text-left">利用料項目</th>
            <th className="px-2 py-1 border-b border-gray-200 text-right w-16">単価</th>
            <th className="px-2 py-1 border-b border-gray-200 text-right w-10">数量</th>
            <th className="px-2 py-1 border-b border-gray-200 text-right w-20">金額</th>
          </tr>
        </thead>
        <tbody>
          {splitUserAmount(selected).map((l) => (
            <tr key={l.label} className="border-b border-gray-100">
              <td className="px-2 py-1 text-gray-700">{l.label}</td>
              <td className="px-2 py-1 text-right font-mono">
                {l.unitPer != null ? l.unitPer.toLocaleString() : "—"}
              </td>
              <td className="px-2 py-1 text-right font-mono">{l.count}</td>
              <td className="px-2 py-1 text-right font-mono">
                ¥{l.amount.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="px-3 py-2 border-t border-gray-200 text-xs space-y-0.5">
        <div className="flex justify-between text-gray-600">
          <span>利用者負担額 ({Math.round(selected.copay_rate * 10)}割)</span>
          <span className="font-mono">¥{selected.userAmount.toLocaleString()}</span>
        </div>
        {selected.selfPayAmount > 0 && (
          <div className="flex justify-between text-red-600">
            <span>限度額超過 全額自費 ({selected.overUnits.toLocaleString()}単位)</span>
            <span className="font-mono">¥{selected.selfPayAmount.toLocaleString()}</span>
          </div>
        )}
        {(keigenByUser.get(selected.user_id) ?? 0) > 0 && (
          <div className="flex justify-between text-rose-600">
            <span>軽減額 ({settings.get(selected.user_id)?.keigen_rate ?? 0}%)</span>
            <span className="font-mono">
              ▲¥{(keigenByUser.get(selected.user_id) ?? 0).toLocaleString()}
            </span>
          </div>
        )}
        {jippiTotal(selected.user_id) > 0 && (
          <div className="flex justify-between text-gray-600">
            <span>実費合計</span>
            <span className="font-mono">
              ¥{jippiTotal(selected.user_id).toLocaleString()}
            </span>
          </div>
        )}
        <div className="flex justify-between text-gray-800 font-semibold pt-1 border-t border-gray-100 mt-1">
          <span>合計</span>
          <span className="font-mono">¥{rowBilled(selected).toLocaleString()}</span>
        </div>
        {iryohiByUser.has(selected.user_id) && (
          <div className="flex justify-between text-gray-500 text-[10px]">
            <span>うち医療費控除対象額</span>
            <span className="font-mono">
              ¥{(iryohiByUser.get(selected.user_id) ?? 0).toLocaleString()}
            </span>
          </div>
        )}
        {carryover(selected.user_id) !== 0 && (
          <div className="flex justify-between text-gray-500 text-[10px]">
            <span>
              前月繰越 ({carryover(selected.user_id) > 0 ? "未収繰越" : "過入金充当"})
            </span>
            <span className="font-mono">
              {carryover(selected.user_id) < 0 ? "▲" : ""}¥
              {Math.abs(carryover(selected.user_id)).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      <div className="px-3 pb-3">
        <JippiSection
          key={`jippi-${selected.user_id}-${monthKey}`}
          userId={selected.user_id}
          monthKey={monthKey}
          entries={jippiByUser.get(selected.user_id) ?? []}
          onChanged={onJippiChanged}
        />

        <RiyouSettingsSection
          key={`setting-${selected.user_id}`}
          userId={selected.user_id}
          setting={settings.get(selected.user_id) ?? null}
          onChanged={onSettingsChanged}
        />

        <PaymentSection
          key={`pay-${selected.user_id}-${monthKey}`}
          userId={selected.user_id}
          monthKey={monthKey}
          billed={rowBilled(selected)}
          payment={payments.get(selected.user_id) ?? null}
          onChanged={onPaymentChanged}
        />
      </div>
    </>
  );
}

// ─── 障害 の利用明細欄 (明細 + 入金のみ。軽減/実費/医療費控除は N/A) ──────────────
//    請求額 = userAmount (上限適用後)。入金は shogai_seikyu_payments に読み書きする。
function ShogaiRiyouDetail({
  selected,
  monthKey,
  payment,
  carryover,
  onPaymentChanged,
}: {
  selected: ShogaiSeikyuRow;
  monthKey: string;
  payment: PaymentRow | null;
  /** 前月繰越 (正 = 未収繰越 / 負 = 過入金充当 / 0 = 前月なし)。shogai_seikyu_payments 由来 */
  carryover: number;
  onPaymentChanged: () => void;
}) {
  return (
    <>
      <table className="w-full text-xs border-collapse">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-2 py-1 border-b border-gray-200 text-left">サービス種類</th>
            <th className="px-2 py-1 border-b border-gray-200 text-right w-16">単位</th>
            <th className="px-2 py-1 border-b border-gray-200 text-right w-10">回数</th>
            <th className="px-2 py-1 border-b border-gray-200 text-right w-20">単位計</th>
          </tr>
        </thead>
        <tbody>
          {selected.details.map((d) => (
            <tr
              key={`${d.service_type}-${d.service_code}-${d.service_category}`}
              className="border-b border-gray-100"
            >
              <td className="px-2 py-1 text-gray-700">
                {d.service_type}
                {d.service_category ? ` (${d.service_category})` : ""}
              </td>
              <td className="px-2 py-1 text-right font-mono">{d.unit_per.toLocaleString()}</td>
              <td className="px-2 py-1 text-right font-mono">{d.count}</td>
              <td className="px-2 py-1 text-right font-mono">{d.units.toLocaleString()}</td>
            </tr>
          ))}
          {selected.addons.map((a) => (
            <tr key={a.service_code} className="border-b border-gray-100">
              <td className="px-2 py-1 text-gray-700">{a.service_name}</td>
              <td className="px-2 py-1 text-right font-mono">—</td>
              <td className="px-2 py-1 text-right font-mono">1</td>
              <td className="px-2 py-1 text-right font-mono">{a.units.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="px-3 py-2 border-t border-gray-200 text-xs space-y-0.5">
        <div className="flex justify-between text-gray-600">
          <span>総単位数</span>
          <span className="font-mono">{selected.totalUnits.toLocaleString()} 単位</span>
        </div>
        <div className="flex justify-between text-gray-600">
          <span>総費用額</span>
          <span className="font-mono">¥{selected.totalAmount.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-gray-600">
          <span>負担上限月額{selected.seiho ? " (生保)" : ""}</span>
          <span className="font-mono">
            {selected.self_payment_limit != null
              ? `¥${selected.self_payment_limit.toLocaleString()}`
              : "未設定"}
          </span>
        </div>
        <div className="flex justify-between text-gray-800 font-semibold pt-1 border-t border-gray-100 mt-1">
          <span>利用者負担額 (請求額)</span>
          <span className="font-mono">¥{selected.userAmount.toLocaleString()}</span>
        </div>
        {carryover !== 0 && (
          <div className="flex justify-between text-gray-500 text-[10px]">
            <span>前月繰越 ({carryover > 0 ? "未収繰越" : "過入金充当"})</span>
            <span className="font-mono">
              {carryover < 0 ? "▲" : ""}¥{Math.abs(carryover).toLocaleString()}
            </span>
          </div>
        )}
        <p className="pt-1 text-[10px] text-gray-400">
          ※ 障害福祉サービスは 軽減 / 実費 / 医療費控除 の対象外です (—)。
        </p>
      </div>

      <div className="px-3 pb-3">
        <PaymentSection
          key={`shogai-pay-${selected.user_id}-${monthKey}`}
          userId={selected.user_id}
          monthKey={monthKey}
          billed={selected.userAmount}
          payment={payment}
          onChanged={onPaymentChanged}
          table="shogai_seikyu_payments"
        />
      </div>
    </>
  );
}

// ─── 利用実費の入力セクション ─────────────────────────────────────────────────
function JippiSection({
  userId,
  monthKey,
  entries,
  onChanged,
}: {
  userId: string;
  monthKey: string;
  entries: JippiEntry[];
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [itemName, setItemName] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [saving, setSaving] = useState(false);

  const amount = (parseInt(unitPrice, 10) || 0) * (parseInt(quantity, 10) || 0);

  const add = async () => {
    if (!itemName.trim()) {
      toast.error("項目名を入力してください");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("riyou_jippi_entries").insert({
      client_id: userId,
      target_month: monthKey,
      item_name: itemName.trim(),
      unit_price: parseInt(unitPrice, 10) || 0,
      quantity: parseInt(quantity, 10) || 1,
      amount,
    });
    setSaving(false);
    if (error) {
      toast.error("実費の追加に失敗: " + error.message);
      return;
    }
    setItemName("");
    setUnitPrice("");
    setQuantity("1");
    onChanged();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("riyou_jippi_entries").delete().eq("id", id);
    if (error) {
      toast.error("削除に失敗: " + error.message);
      return;
    }
    onChanged();
  };

  return (
    <div className="mt-4 rounded border border-emerald-200 bg-emerald-50/40 p-3 text-xs">
      <p className="mb-2 font-bold text-emerald-800">利用実費 (保険外)</p>
      {entries.length > 0 && (
        <table className="mb-2 w-full">
          <thead className="text-left text-[10px] text-gray-500">
            <tr>
              <th className="py-0.5">項目</th>
              <th className="py-0.5 text-right">単価</th>
              <th className="py-0.5 text-right">数量</th>
              <th className="py-0.5 text-right">金額</th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-emerald-100">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="py-1">{e.item_name}</td>
                <td className="py-1 text-right tabular-nums">{e.unit_price.toLocaleString()}</td>
                <td className="py-1 text-right tabular-nums">{e.quantity}</td>
                <td className="py-1 text-right tabular-nums font-semibold">¥{e.amount.toLocaleString()}</td>
                <td className="py-1 text-center">
                  <button onClick={() => remove(e.id)} className="text-gray-300 hover:text-red-500" title="削除">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="grid grid-cols-[1fr_72px_52px_auto] items-center gap-1.5">
        <input
          type="text"
          list="jippi-items"
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          placeholder="項目名 (交通費 等)"
          className="rounded border px-2 py-1.5 focus:border-emerald-500 focus:outline-none"
        />
        <datalist id="jippi-items">
          {JIPPI_SUGGESTIONS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <input
          type="number"
          value={unitPrice}
          onChange={(e) => setUnitPrice(e.target.value)}
          placeholder="単価"
          className="rounded border px-2 py-1.5 text-right tabular-nums focus:border-emerald-500 focus:outline-none"
        />
        <input
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          min={1}
          className="rounded border px-2 py-1.5 text-right tabular-nums focus:border-emerald-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Plus size={12} />
          追加 {amount > 0 ? `(¥${amount.toLocaleString()})` : ""}
        </button>
      </div>
    </div>
  );
}

// ─── 入金登録 (未収金管理) ────────────────────────────────────────────────────
function PaymentSection({
  userId,
  monthKey,
  billed,
  payment,
  onChanged,
  table = "riyou_seikyu_payments",
}: {
  userId: string;
  monthKey: string;
  billed: number;
  payment: PaymentRow | null;
  onChanged: () => void;
  /** 保存先テーブル (介護/総合 → riyou_seikyu_payments / 障害 → shogai_seikyu_payments) */
  table?: "riyou_seikyu_payments" | "shogai_seikyu_payments";
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
    const paid = asStatus === "未収" ? payment?.paid_amount ?? 0 : parseInt(amount, 10) || 0;
    const status =
      asStatus ??
      (paid >= billed && billed > 0 ? "入金完" : paid > 0 ? "一部入金" : "請求済");
    const { error } = await supabase.from(table).upsert(
      {
        client_id: userId,
        target_month: monthKey,
        billed_amount: billed,
        paid_amount: paid,
        paid_date: asStatus === "未収" ? payment?.paid_date ?? null : date,
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
          {payment?.issued_date ? `請求書発行日: ${payment.issued_date}` : "請求書未発行"}
          {payment && (
            <span className={`ml-2 whitespace-nowrap rounded px-1.5 py-0.5 font-bold ${PAYMENT_STATUS_CLS[payment.status]}`}>
              {payment.status}
            </span>
          )}
        </span>
      </div>
      {payment && payment.paid_amount > 0 && (
        <p className="text-[10px] text-gray-500">
          入金済: ¥{payment.paid_amount.toLocaleString()} ({payment.paid_date ?? "—"} / {payment.payment_method ?? "—"})
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

// ─── 請求設定 (軽減 / 医療費控除) — kaigo_riyou_settings に upsert ────────────
function RiyouSettingsSection({
  userId,
  setting,
  onChanged,
}: {
  userId: string;
  setting: RiyouSettingRow | null;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rate, setRate] = useState(
    setting?.keigen_rate != null ? String(setting.keigen_rate) : "",
  );
  const [start, setStart] = useState(setting?.keigen_start_date ?? "");
  const [end, setEnd] = useState(setting?.keigen_end_date ?? "");
  const [iryohi, setIryohi] = useState(setting?.iryohi_taisho ?? false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const rateNum = rate.trim() === "" ? null : Number(rate);
    if (rateNum != null && (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100)) {
      toast.error("軽減率は 0〜100 の数値 (%) で入力してください");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("kaigo_riyou_settings").upsert(
      {
        client_id: userId,
        keigen_rate: rateNum,
        keigen_start_date: start || null,
        keigen_end_date: end || null,
        iryohi_taisho: iryohi,
      },
      { onConflict: "client_id" },
    );
    setSaving(false);
    if (error) {
      // table 未作成 (migration 未適用) も含めて必ず通知する
      toast.error("請求設定の保存に失敗: " + error.message);
      return;
    }
    toast.success("請求設定を保存しました");
    onChanged();
  };

  return (
    <div className="mt-3 rounded border border-rose-200 bg-rose-50/40 p-3 text-xs space-y-2">
      <p className="font-bold text-rose-800">請求設定 (軽減・医療費控除)</p>
      <div className="flex flex-wrap items-end gap-1.5">
        <div className="w-16">
          <label className="mb-0.5 block text-[10px] text-gray-500">軽減率 %</label>
          <input
            type="number"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="なし"
            min={0}
            max={100}
            className="w-full rounded border px-2 py-1.5 text-right tabular-nums focus:border-rose-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">適用開始</label>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="rounded border px-2 py-1.5 focus:border-rose-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">適用終了</label>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="rounded border px-2 py-1.5 focus:border-rose-500 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-gray-700">
          <input
            type="checkbox"
            checked={iryohi}
            onChange={(e) => setIryohi(e.target.checked)}
            className="cursor-pointer"
          />
          医療費控除の対象者 (生活援助中心型を除き按分)
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </div>
  );
}

// ─── 印刷: 利用料請求書 (利用者 1 名 = 1 枚) ─────────────────────────────────
function RiyouSeikyuPrintSheet({
  row,
  jippi,
  keigen,
  iryohi,
  prevPayment,
  officeName,
  reiwa,
  month,
  isCopy = false,
}: {
  row: UserSeikyuRow;
  jippi: JippiEntry[];
  /** 軽減額 (0 = 軽減なし) */
  keigen: number;
  /** 医療費控除対象額 (null = 対象者でない) */
  iryohi: number | null;
  /** 前月の請求/入金 (前回領収欄・繰越の印字用。null = 前月レコードなし) */
  prevPayment: PaymentRow | null;
  officeName: string | null;
  reiwa: number;
  month: number;
  /** true = 控え (同一内容に「控」表記) */
  isCopy?: boolean;
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const lines = splitUserAmount(row);
  const jippiSum = jippi.reduce((s, e) => s + e.amount, 0);
  // 当月請求額 = (法定負担 + 超過自費) − 軽減 + 実費
  const monthTotal = userPlusSelf(row) - keigen + jippiSum;
  // 繰越額 = 前回請求 − 前回入金 (正 = 未収繰越 / 負 = 過入金充当)
  const carry = prevPayment
    ? prevPayment.billed_amount - prevPayment.paid_amount
    : 0;
  // 今回御請求額 = 当月請求額 + 繰越額
  const grandTotal = monthTotal + carry;

  return (
    <div className="p-10 text-black relative" style={{ pageBreakAfter: "always" }}>
      {isCopy && (
        <span className="absolute right-10 top-8 border border-black px-2 py-1 text-sm font-bold">
          控
        </span>
      )}
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書{isCopy ? " (控)" : ""}
      </h1>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="inline-block border-b border-black pb-1 pr-12 text-lg">
            {row.user_name} 様
          </p>
          <p className="mt-3 text-sm">
            令和{reiwa}年{month}月分のサービス利用料を下記のとおりご請求申し上げます。
          </p>
        </div>
        <div className="text-right text-sm leading-6">
          <p>発行日: {issueDate}</p>
          <p className="mt-3 font-medium">{officeName ?? ""}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <span className="border border-black px-4 py-2 text-lg font-bold">
          今回御請求額 ¥{grandTotal.toLocaleString()} －
        </span>
        <span className="text-xs">(消費税: 非課税)</span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1.5 text-left">利用料項目</th>
            <th className="border border-black px-2 py-1.5 text-right w-24">単価 (単位)</th>
            <th className="border border-black px-2 py-1.5 text-right w-16">数量</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">金額</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.label}>
              <td className="border border-black px-2 py-1.5">{l.label}</td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {l.unitPer != null ? l.unitPer.toLocaleString() : "—"}
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {l.count}
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                ¥{l.amount.toLocaleString()}
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="border border-black px-2 py-1.5" colSpan={3}>
              小計 (利用者負担額{Math.round(row.copay_rate * 10)}割
              {row.selfPayAmount > 0 ? " + 限度額超過自費" : ""})
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{userPlusSelf(row).toLocaleString()}
            </td>
          </tr>
          {keigen > 0 && (
            <tr>
              <td className="border border-black px-2 py-1.5" colSpan={3}>
                軽減額 (利用者負担額軽減)
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                ▲¥{keigen.toLocaleString()}
              </td>
            </tr>
          )}
          {jippi.map((e) => (
            <tr key={e.id}>
              <td className="border border-black px-2 py-1.5">{e.item_name} (実費)</td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {e.unit_price > 0 ? e.unit_price.toLocaleString() : "—"}
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">{e.quantity}</td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                ¥{e.amount.toLocaleString()}
              </td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border border-black px-2 py-1.5" colSpan={3}>
              当月請求額
              {keigen > 0 || jippiSum > 0
                ? ` (利用者負担${keigen > 0 ? " − 軽減" : ""}${jippiSum > 0 ? " + 実費" : ""})`
                : ""}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{monthTotal.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      {/* 前回領収欄 (ほのぼの 請求書の前回領収欄・未収欄 相当) */}
      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1 text-right">前回請求額</th>
            <th className="border border-black px-2 py-1 text-right">前回入金額</th>
            <th className="border border-black px-2 py-1 text-right">
              繰越額 (未収は+、過入金は▲)
            </th>
            <th className="border border-black px-2 py-1 text-right">今回御請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {prevPayment ? `¥${prevPayment.billed_amount.toLocaleString()}` : "—"}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {prevPayment ? `¥${prevPayment.paid_amount.toLocaleString()}` : "—"}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {carry === 0
                ? "¥0"
                : carry > 0
                  ? `¥${carry.toLocaleString()}`
                  : `▲¥${(-carry).toLocaleString()}`}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums font-bold">
              ¥{grandTotal.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      {iryohi != null && (
        <p className="mt-3 text-sm">
          うち医療費控除対象額 ¥{iryohi.toLocaleString()}
        </p>
      )}

      <p className="mt-6 text-xs text-gray-700">
        ※ 本請求は介護保険サービス利用に伴う利用者負担分です (保険単位数{" "}
        {row.totalUnits.toLocaleString()} 単位、単価 {row.unitPrice.toFixed(2)} 円/単位)。
      </p>
    </div>
  );
}

// ─── 印刷: 世帯合算 請求書 (名寄チェック者を 1 枚に合算 / 宛名 = 代表者) ──────
function RiyouSeikyuHouseholdPrintSheet({
  rows,
  jippiByUser,
  keigenByUser,
  iryohiByUser,
  prevPayments,
  officeName,
  reiwa,
  month,
  isCopy = false,
}: {
  rows: UserSeikyuRow[];
  jippiByUser: Map<string, JippiEntry[]>;
  /** 利用者ごとの軽減額 (0 = 軽減なし) */
  keigenByUser: Map<string, number>;
  /** 医療費控除対象額 (対象者のみ entry あり) */
  iryohiByUser: Map<string, number>;
  /** 前月の請求/入金 (前回領収欄・繰越の印字用) */
  prevPayments: Map<string, PaymentRow>;
  officeName: string | null;
  reiwa: number;
  month: number;
  /** true = 控え (同一内容に「控」表記) */
  isCopy?: boolean;
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const rep = rows[0]; // 代表者 = 先頭
  // 各利用者の (法定負担 + 超過自費) − 軽減 + 実費 = 明細 1 行、合計を世帯合算とする
  const perUser = rows.map((r) => {
    const jippiSum = (jippiByUser.get(r.user_id) ?? []).reduce((s, e) => s + e.amount, 0);
    const keigen = keigenByUser.get(r.user_id) ?? 0;
    return { row: r, jippiSum, keigen, subtotal: userPlusSelf(r) - keigen + jippiSum };
  });
  const monthTotal = perUser.reduce((s, u) => s + u.subtotal, 0);
  const hasKeigen = perUser.some((u) => u.keigen > 0);
  // 前回領収欄 (世帯合算 = 世帯メンバーの前月分を合算)
  const prevList = rows
    .map((r) => prevPayments.get(r.user_id))
    .filter((p): p is PaymentRow => p != null);
  const prevBilled = prevList.reduce((s, p) => s + p.billed_amount, 0);
  const prevPaid = prevList.reduce((s, p) => s + p.paid_amount, 0);
  const carry = prevBilled - prevPaid;
  // 今回御請求額 = 当月請求額 + 繰越額
  const grandTotal = monthTotal + carry;
  // うち医療費控除対象額 (対象者がいる場合のみ印字)
  const iryohiList = rows.filter((r) => iryohiByUser.has(r.user_id));
  const iryohiSum = iryohiList.reduce(
    (s, r) => s + (iryohiByUser.get(r.user_id) ?? 0),
    0,
  );

  return (
    <div className="p-10 text-black relative" style={{ pageBreakAfter: "always" }}>
      {isCopy && (
        <span className="absolute right-10 top-8 border border-black px-2 py-1 text-sm font-bold">
          控
        </span>
      )}
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書 (世帯合算){isCopy ? " (控)" : ""}
      </h1>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="inline-block border-b border-black pb-1 pr-12 text-lg">
            {rep.user_name} 様 {rows.length > 1 ? `他 ${rows.length - 1} 名` : ""}
          </p>
          <p className="mt-3 text-sm">
            令和{reiwa}年{month}月分のサービス利用料を下記のとおり (世帯合算) ご請求申し上げます。
          </p>
        </div>
        <div className="text-right text-sm leading-6">
          <p>発行日: {issueDate}</p>
          <p className="mt-3 font-medium">{officeName ?? ""}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <span className="border border-black px-4 py-2 text-lg font-bold">
          今回御請求額 ¥{grandTotal.toLocaleString()} －
        </span>
        <span className="text-xs">(消費税: 非課税 / 世帯 {rows.length} 名分)</span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1.5 text-left">利用者名</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">利用者負担額</th>
            {hasKeigen && (
              <th className="border border-black px-2 py-1.5 text-right w-24">軽減額</th>
            )}
            <th className="border border-black px-2 py-1.5 text-right w-24">実費</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">小計</th>
          </tr>
        </thead>
        <tbody>
          {perUser.map((u) => (
            <tr key={u.row.user_id}>
              <td className="border border-black px-2 py-1.5">
                {u.row.user_name}
                <span className="ml-2 text-xs text-gray-500">
                  ({Math.round(u.row.copay_rate * 10)}割)
                </span>
              </td>
              <td
                className="border border-black px-2 py-1.5 text-right tabular-nums"
                title={u.row.selfPayAmount > 0 ? "限度額超過の全額自費を含む" : undefined}
              >
                ¥{userPlusSelf(u.row).toLocaleString()}
              </td>
              {hasKeigen && (
                <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                  {u.keigen > 0 ? `▲¥${u.keigen.toLocaleString()}` : "—"}
                </td>
              )}
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {u.jippiSum > 0 ? `¥${u.jippiSum.toLocaleString()}` : "—"}
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums font-semibold">
                ¥{u.subtotal.toLocaleString()}
              </td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border border-black px-2 py-1.5" colSpan={hasKeigen ? 4 : 3}>
              当月請求額 (世帯 {rows.length} 名分)
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{monthTotal.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      {/* 前回領収欄 (世帯メンバー合算) */}
      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1 text-right">前回請求額</th>
            <th className="border border-black px-2 py-1 text-right">前回入金額</th>
            <th className="border border-black px-2 py-1 text-right">
              繰越額 (未収は+、過入金は▲)
            </th>
            <th className="border border-black px-2 py-1 text-right">今回御請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {prevList.length > 0 ? `¥${prevBilled.toLocaleString()}` : "—"}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {prevList.length > 0 ? `¥${prevPaid.toLocaleString()}` : "—"}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {carry === 0
                ? "¥0"
                : carry > 0
                  ? `¥${carry.toLocaleString()}`
                  : `▲¥${(-carry).toLocaleString()}`}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums font-bold">
              ¥{grandTotal.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      {iryohiList.length > 0 && (
        <p className="mt-3 text-sm">
          うち医療費控除対象額 ¥{iryohiSum.toLocaleString()} (
          {iryohiList.map((r) => r.user_name).join("、")})
        </p>
      )}

      <p className="mt-6 text-xs text-gray-700">
        ※ 本請求は世帯内 {rows.length} 名分の介護保険サービス利用者負担分
        {hasKeigen ? " (軽減適用後)" : ""} + 実費を合算したものです。
        代表者 ({rep.user_name} 様) 宛に 1 枚で発行しています。
      </p>
    </div>
  );
}

// ─── 印刷: 領収書 (入金済みの行から 1 名 1 枚。様式は請求書流用のシンプル版) ────
//  領収額 = 入金額 (paid_amount) / 領収日 = 入金日 (paid_date) /
//  但し書き「介護サービス利用料として」 / 収入印紙欄付き。控えは同一内容に「控」表記
function RyoshuPrintSheet({
  row,
  payment,
  officeName,
  reiwa,
  month,
  isCopy = false,
}: {
  row: UserSeikyuRow;
  payment: PaymentRow;
  officeName: string | null;
  reiwa: number;
  month: number;
  /** true = 控え (同一内容に「控」表記) */
  isCopy?: boolean;
}) {
  const ryoshuDate = payment.paid_date
    ? fmtReiwaDate(payment.paid_date)
    : "";
  const partial = payment.status === "一部入金";
  return (
    <div className="p-10 text-black relative" style={{ pageBreakAfter: "always" }}>
      {isCopy && (
        <span className="absolute right-10 top-8 border border-black px-2 py-1 text-sm font-bold">
          控
        </span>
      )}
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        領収書{isCopy ? " (控)" : ""}
      </h1>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="inline-block border-b border-black pb-1 pr-12 text-lg">
            {row.user_name} 様
          </p>
          <p className="mt-3 text-sm">
            令和{reiwa}年{month}月分のサービス利用料として、下記のとおり領収いたしました。
          </p>
        </div>
        <div className="text-right text-sm leading-6">
          <p>領収日: {ryoshuDate || "　　　　　"}</p>
          <p className="mt-3 font-medium">{officeName ?? ""}</p>
        </div>
      </div>

      <div className="mb-6 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="border border-black px-4 py-2 text-lg font-bold">
            領収金額 ¥{payment.paid_amount.toLocaleString()} －
          </span>
          <span className="text-xs">(消費税: 非課税)</span>
        </div>
        {/* 収入印紙欄 */}
        <div className="flex h-24 w-20 items-center justify-center border border-dashed border-black text-center text-[10px] leading-4 text-gray-500">
          収入印紙
        </div>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1.5 text-left">但し書き</th>
            <th className="border border-black px-2 py-1.5 text-right w-32">請求額</th>
            <th className="border border-black px-2 py-1.5 text-right w-32">領収額</th>
            <th className="border border-black px-2 py-1.5 text-left w-24">入金方法</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1.5">
              介護サービス利用料として (令和{reiwa}年{month}月分)
              {partial ? " ※一部入金" : ""}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{payment.billed_amount.toLocaleString()}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums font-bold">
              ¥{payment.paid_amount.toLocaleString()}
            </td>
            <td className="border border-black px-2 py-1.5">
              {payment.payment_method ?? "—"}
            </td>
          </tr>
        </tbody>
      </table>

      {partial && (
        <p className="mt-3 text-xs text-gray-700">
          ※ 残額 ¥{Math.max(0, payment.billed_amount - payment.paid_amount).toLocaleString()}{" "}
          は未収です。
        </p>
      )}

      <p className="mt-6 text-xs text-gray-700">
        ※ 介護保険サービスの利用者負担分は消費税非課税です。
      </p>
    </div>
  );
}

// ─── 請求書一括印刷ビュー (全員/チェック中 を 1 印刷ジョブで連続出力) ──────────
// 単票の RiyouSeikyuPrintSheet / RiyouSeikyuHouseholdPrintSheet / RyoshuPrintSheet を
// 利用者ごとに page-break-after で連結するだけの view。金額計算はコピーせず、
// 既存の rowBilled / keigenByUser / jippiByUser / prevPayments をそのまま渡す
// (= 単票印刷と 1 円も違わない)。名寄せ (世帯合算) も発行ボタンと同じ挙動。
// 発行日の記録 (riyou_seikyu_payments への upsert) は行わない — 記録は「発行」ボタン側。
// 並び順: 利用者番号 (clients.user_number) 順、番号なしは末尾でカナ順。
function RiyouBulkPrintView({
  rows,
  allRows,
  mergeSystems,
  mergeOffices,
  companyMerged,
  siblingInputsAll,
  checkedKeys,
  mergedKeys,
  rowBilled,
  payments,
  jippiByUser,
  keigenByUser,
  iryohiByUser,
  prevPayments,
  prevShogaiPayments,
  officeName,
  officePhone,
  company,
  bankByUser,
  reiwa,
  year,
  month,
  onClose,
}: {
  /** 対象候補 (介護・総合のみ。障害の帳票は障害請求タブ側のため対象外) */
  rows: KaigoUnifiedRow[];
  /** 制度合算 ON 時に 障害分も 1 枚へ畳み込むための全制度行 */
  allRows: UnifiedRow[];
  /** 制度合算モード (ON = 同一利用者の 介護/総合/障害 を 1 枚に合算) */
  mergeSystems: boolean;
  /** 事業所合算モード (ON = 同一法人の他事業所分も 1 枚に合算) */
  mergeOffices: boolean;
  /** 事業所合算が実際に効いている (他事業所あり) か。シート見出しの (事業所合算) 判定用 */
  companyMerged: boolean;
  /** 他事業所分の MergeInput (全 client。scope 内 client のみ後段で採用) */
  siblingInputsAll: MergeInput[];
  /** 一覧の「対象」チェック (制度:client_id キー) */
  checkedKeys: Set<string>;
  /** 一覧の「名寄」チェック (世帯合算。制度:client_id キー) */
  mergedKeys: Set<string>;
  /** 行の請求額 = (負担額 + 超過自費) − 軽減 + 実費 — 単票と同じ既存関数 */
  rowBilled: (r: UserSeikyuRow) => number;
  payments: Map<string, PaymentRow>;
  jippiByUser: Map<string, JippiEntry[]>;
  keigenByUser: Map<string, number>;
  iryohiByUser: Map<string, number>;
  prevPayments: Map<string, PaymentRow>;
  /** 障害の前月入金 (制度合算 ON 時の障害セクションの前回領収欄用) */
  prevShogaiPayments: Map<string, PaymentRow>;
  officeName: string | null;
  /** 自事業所の問い合わせ先電話 (ひな形の「お問い合わせ先」) */
  officePhone: string | null;
  /** ひな形ヘッダーの自社情報 */
  company: SheetCompany;
  /** 利用者の宛先・口座 (ひな形の宛先/口座振替欄) */
  bankByUser: Map<string, ClientBank>;
  reiwa: number;
  year: number;
  month: number;
  onClose: () => void;
}) {
  // 対象 (全員 / チェック中) — チェックが 1 件も無いときは「全員」固定
  const [scope, setScope] = useState<"all" | "checked">("all");
  // 0 円請求 (当月請求額 = 0) の利用者を除外するオプション
  const [excludeZero, setExcludeZero] = useState(false);
  // 印刷する綴り (請求書 / 領収書)。領収書は入金済み行のみ = 追加コストほぼ 0 なので同梱
  const [docs, setDocs] = useState<Set<"seikyu" | "ryoshu">>(new Set(["seikyu"]));

  const checkedRows = useMemo(
    () => rows.filter((r) => checkedKeys.has(r.key)),
    [rows, checkedKeys],
  );

  // 対象行の確定: scope → 0円除外 → 利用者番号順ソート
  const { sorted, excludedZeroCount } = useMemo(() => {
    const scoped = scope === "checked" ? checkedRows : rows;
    const nonZero = excludeZero
      ? scoped.filter((r) => rowBilled(r.kaigo) !== 0)
      : scoped;
    const out = [...nonZero].sort((a, b) => {
      const na = a.kaigo.user_number;
      const nb = b.kaigo.user_number;
      if (na != null && nb != null) {
        const c = na.localeCompare(nb, "ja", { numeric: true });
        if (c !== 0) return c;
      } else if (na != null) {
        return -1; // 番号ありを先に
      } else if (nb != null) {
        return 1;
      }
      // 番号なし同士 (または同番号) はカナ順で安定化
      return (a.kaigo.user_name_kana ?? a.kaigo.user_name).localeCompare(
        b.kaigo.user_name_kana ?? b.kaigo.user_name,
        "ja",
      );
    });
    return { sorted: out, excludedZeroCount: scoped.length - nonZero.length };
  }, [rows, checkedRows, scope, excludeZero, rowBilled]);

  // 名寄せ (世帯合算): 対象内の名寄チェック 2 名以上 → 1 枚の世帯合算請求書、
  // それ以外は 1 名 1 枚 (発行ボタンの printGroups と同じ判定)
  const groups = useMemo(() => {
    const household = sorted
      .filter((r) => mergedKeys.has(r.key))
      .map((r) => r.kaigo);
    if (household.length >= 2) {
      const hset = new Set(household.map((r) => r.user_id));
      return {
        household,
        singles: sorted.map((r) => r.kaigo).filter((r) => !hset.has(r.user_id)),
      };
    }
    return { household: [] as UserSeikyuRow[], singles: sorted.map((r) => r.kaigo) };
  }, [sorted, mergedKeys]);

  // 制度合算 ON: scope 内の利用者について 介護/総合/障害 を 1 枚に畳み込む。
  // 金額は単票と同じ既存関数 (rowBilled / userAmount) をそのまま subtotal に詰めるだけ。
  const mergedGroups = useMemo(() => {
    if (!mergeSystems)
      return { household: [] as MergedClient[], singles: [] as MergedClient[] };
    const scopedUserIds = new Set(sorted.map((r) => r.userId));
    const jippiTotalFor = (uid: string) =>
      (jippiByUser.get(uid) ?? []).reduce((s, e) => s + e.amount, 0);
    const inputs: MergeInput[] = allRows
      .filter((row) => scopedUserIds.has(row.userId))
      .map((row): MergeInput => {
        if (row.system === "障害") {
          const s = row.shogai;
          const prev = prevShogaiPayments.get(row.userId);
          const meta = bankByUser.get(row.userId);
          return {
            system: "障害",
            userId: row.userId,
            userName: s.user_name,
            userNameKana: s.user_name_kana,
            userNumber: null,
            copayRate: null,
            officeLabel: mergeOffices ? officeName : null,
            lines: shogaiMergeLines(s),
            base: s.userAmount,
            keigen: 0,
            jippi: 0,
            subtotal: s.userAmount,
            iryohi: 0,
            prevBilled: prev?.billed_amount ?? 0,
            prevPaid: prev?.paid_amount ?? 0,
            postalCode: meta?.postal_code ?? null,
            address: meta?.address ?? null,
            bank: toMergeBank(meta),
            officePhone,
          };
        }
        const r = row.kaigo;
        const prev = prevPayments.get(row.userId);
        const meta = bankByUser.get(row.userId);
        return {
          system: row.system,
          userId: row.userId,
          userName: r.user_name,
          userNameKana: r.user_name_kana,
          userNumber: r.user_number,
          copayRate: r.copay_rate,
          officeLabel: mergeOffices ? officeName : null,
          lines: kaigoMergeLines(r),
          base: userPlusSelf(r),
          keigen: keigenByUser.get(r.user_id) ?? 0,
          jippi: jippiTotalFor(r.user_id),
          subtotal: rowBilled(r),
          iryohi: iryohiByUser.get(r.user_id) ?? 0,
          prevBilled: prev?.billed_amount ?? 0,
          prevPaid: prev?.paid_amount ?? 0,
          postalCode: meta?.postal_code ?? null,
          address: meta?.address ?? null,
          bank: toMergeBank(meta),
          officePhone,
        };
      });
    // 事業所合算: scope 内 client の他事業所セクションを追加 (単票と同じ集計値)
    if (mergeOffices) {
      for (const si of siblingInputsAll) {
        if (scopedUserIds.has(si.userId)) inputs.push(si);
      }
    }
    const clients = buildMergedClients(inputs);
    const householdIds = new Set(
      sorted.filter((r) => mergedKeys.has(r.key)).map((r) => r.userId),
    );
    const household = clients.filter((c) => householdIds.has(c.userId));
    if (household.length >= 2) {
      return {
        household,
        singles: clients.filter((c) => !householdIds.has(c.userId)),
      };
    }
    return { household: [] as MergedClient[], singles: clients };
  }, [
    mergeSystems,
    mergeOffices,
    officeName,
    officePhone,
    bankByUser,
    siblingInputsAll,
    sorted,
    allRows,
    mergedKeys,
    prevPayments,
    prevShogaiPayments,
    keigenByUser,
    jippiByUser,
    rowBilled,
    iryohiByUser,
  ]);

  // 領収書 = 対象のうち入金済み (入金完 / 一部入金 かつ 入金額 > 0)。
  // 既存の ryoshuTargets と同条件 (riyou_seikyu_payments 由来)
  const ryoshuRows = useMemo(
    () =>
      sorted
        .map((r) => ({ row: r.kaigo, payment: payments.get(r.userId) }))
        .filter(
          (x): x is { row: UserSeikyuRow; payment: PaymentRow } =>
            x.payment != null &&
            (x.payment.status === "入金完" || x.payment.status === "一部入金") &&
            x.payment.paid_amount > 0,
        ),
    [sorted, payments],
  );

  const seikyuSheetCount = docs.has("seikyu")
    ? mergeSystems
      ? (mergedGroups.household.length >= 2 ? 1 : 0) + mergedGroups.singles.length
      : (groups.household.length >= 2 ? 1 : 0) + groups.singles.length
    : 0;
  const ryoshuSheetCount = docs.has("ryoshu") ? ryoshuRows.length : 0;
  const totalSheets = seikyuSheetCount + ryoshuSheetCount;

  const toggleDoc = (k: "seikyu" | "ryoshu") =>
    setDocs((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-200 print:static print:block print:bg-white">
      {/* ── 操作バー (印刷には出さない) ── */}
      <div className="shrink-0 border-b border-gray-300 bg-white px-4 py-2 flex items-center gap-3 flex-wrap text-xs print:hidden">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
          <Printer size={15} className="text-purple-600" />
          請求書一括印刷 — 令和{reiwa}年{month}月分 ({year}-
          {String(month).padStart(2, "0")})
        </span>
        <span className="font-mono font-semibold text-gray-700">
          対象 {sorted.length} 名 / {totalSheets} 枚
        </span>
        {/* 対象選択 (全員 / チェック中) */}
        <span className="flex items-center gap-2 rounded border border-gray-300 bg-gray-50 px-2 py-1">
          <label className="flex cursor-pointer select-none items-center gap-1 whitespace-nowrap">
            <input
              type="radio"
              name="bulk-print-scope"
              checked={scope === "all"}
              onChange={() => setScope("all")}
              className="cursor-pointer"
            />
            全員 ({rows.length})
          </label>
          <label
            className={`flex items-center gap-1 whitespace-nowrap select-none ${checkedRows.length === 0 ? "text-gray-400" : "cursor-pointer"}`}
            title={checkedRows.length === 0 ? "一覧の「対象」列でチェックすると選べます" : undefined}
          >
            <input
              type="radio"
              name="bulk-print-scope"
              checked={scope === "checked"}
              disabled={checkedRows.length === 0}
              onChange={() => setScope("checked")}
              className="cursor-pointer disabled:cursor-not-allowed"
            />
            チェック中 ({checkedRows.length})
          </label>
        </span>
        {/* 0 円請求の除外 */}
        <label
          className="flex cursor-pointer select-none items-center gap-1 whitespace-nowrap rounded border border-gray-300 bg-gray-50 px-2 py-1"
          title="当月請求額が 0 円の利用者を印刷対象から除外します (繰越のみの利用者も除外されます)"
        >
          <input
            type="checkbox"
            checked={excludeZero}
            onChange={(e) => setExcludeZero(e.target.checked)}
            className="cursor-pointer"
          />
          0円請求を除外
          {excludeZero && excludedZeroCount > 0 && (
            <span className="text-[10px] text-gray-500">({excludedZeroCount} 名除外)</span>
          )}
        </label>
        {/* 綴り (請求書 / 領収書) */}
        <span className="flex items-center gap-2 rounded border border-gray-300 bg-gray-50 px-2 py-1">
          <label className="flex cursor-pointer select-none items-center gap-1 whitespace-nowrap">
            <input
              type="checkbox"
              checked={docs.has("seikyu")}
              onChange={() => toggleDoc("seikyu")}
              className="cursor-pointer"
            />
            請求書 (
            {mergeSystems
              ? (mergedGroups.household.length >= 2 ? 1 : 0) +
                mergedGroups.singles.length
              : (groups.household.length >= 2 ? 1 : 0) + groups.singles.length}{" "}
            枚)
          </label>
          <label
            className="flex cursor-pointer select-none items-center gap-1 whitespace-nowrap"
            title="入金済み (入金完 / 一部入金) の利用者のみ発行できます"
          >
            <input
              type="checkbox"
              checked={docs.has("ryoshu")}
              onChange={() => toggleDoc("ryoshu")}
              className="cursor-pointer"
            />
            領収書 ({ryoshuRows.length} 枚)
          </label>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            disabled={totalSheets === 0}
            title="ブラウザの印刷ダイアログを開きます。「PDF に保存」を選ぶと全員分が 1 つの PDF になります"
            className="flex items-center gap-1.5 rounded bg-purple-600 px-4 py-1.5 font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            <Printer size={13} />
            印刷 / PDF保存 ({totalSheets} 枚)
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 bg-white px-4 py-1.5 font-medium text-gray-600 hover:bg-gray-50"
          >
            閉じる
          </button>
        </div>
      </div>
      {/* 注記行 (印刷には出さない) */}
      <div className="shrink-0 border-b border-gray-300 bg-gray-50 px-4 py-1 text-[10px] text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5 print:hidden">
        <span>並び順: 利用者番号順 (番号なしは末尾・カナ順)</span>
        <span>※ 発行日の記録は行いません (記録が必要な場合は一覧の「発行」ボタンをご利用ください)</span>
        <span>※ 障害は対象外 (帳票は障害請求タブ側)</span>
        {sorted.length > 50 && (
          <span className="font-semibold text-amber-600">
            ⚠ 件数が多いためプレビュー生成・印刷ダイアログの準備に時間がかかる場合があります。重い場合は一覧の「対象」チェックで 50 名前後ずつに分割して印刷してください
          </span>
        )}
      </div>

      {/* ── プレビュー本体 = そのまま印刷対象 (単票を page-break-after で連結) ── */}
      <div className="flex-1 overflow-auto py-4 print:overflow-visible print:py-0">
        <div className="mx-auto w-[210mm] max-w-full bg-white shadow print:mx-0 print:w-auto print:max-w-none print:shadow-none">
          {totalSheets === 0 && (
            <p className="p-10 text-center text-sm text-gray-500">
              印刷対象がありません (対象・0円除外・綴りの条件をご確認ください)
            </p>
          )}
          {docs.has("seikyu") &&
            (mergeSystems ? (
              <>
                {mergedGroups.household.length >= 2 && (
                  <RiyouSeikyuMergedPrintSheet
                    clients={mergedGroups.household}
                    officeName={officeName}
                    reiwa={reiwa}
                    month={month}
                    companyMerged={companyMerged}
                    company={company}
                  />
                )}
                {mergedGroups.singles.map((c) => (
                  <RiyouSeikyuMergedPrintSheet
                    key={`bulk-seikyu-merged-${c.userId}`}
                    clients={[c]}
                    officeName={officeName}
                    reiwa={reiwa}
                    month={month}
                    companyMerged={companyMerged}
                    company={company}
                  />
                ))}
              </>
            ) : (
              <>
                {groups.household.length >= 2 && (
                  <RiyouSeikyuHouseholdPrintSheet
                    rows={groups.household}
                    jippiByUser={jippiByUser}
                    keigenByUser={keigenByUser}
                    iryohiByUser={iryohiByUser}
                    prevPayments={prevPayments}
                    officeName={officeName}
                    reiwa={reiwa}
                    month={month}
                  />
                )}
                {groups.singles.map((r) => (
                  <RiyouSeikyuPrintSheet
                    key={`bulk-seikyu-${r.system ?? "介護"}-${r.user_id}`}
                    row={r}
                    jippi={jippiByUser.get(r.user_id) ?? []}
                    keigen={keigenByUser.get(r.user_id) ?? 0}
                    iryohi={
                      iryohiByUser.has(r.user_id)
                        ? (iryohiByUser.get(r.user_id) ?? 0)
                        : null
                    }
                    prevPayment={prevPayments.get(r.user_id) ?? null}
                    officeName={officeName}
                    reiwa={reiwa}
                    month={month}
                  />
                ))}
              </>
            ))}
          {docs.has("ryoshu") &&
            ryoshuRows.map(({ row: r, payment: pay }) => (
              <RyoshuPrintSheet
                key={`bulk-ryoshu-${r.system ?? "介護"}-${r.user_id}`}
                row={r}
                payment={pay}
                officeName={officeName}
                reiwa={reiwa}
                month={month}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
