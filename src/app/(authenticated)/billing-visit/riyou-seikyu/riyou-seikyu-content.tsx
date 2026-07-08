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
  FileText,
  Plus,
  Trash2,
  Banknote,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  useSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "../_shared/seikyu-context";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import { buildFbZengin, type FbTransferTarget } from "@/lib/fb-zengin";

// 利用者の口座情報 (FB データ用) — clients の bank_* 列
interface ClientBank {
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_type: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
}

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
  const { year, month, rows, filteredRows, loading, error, officeName } =
    useSeikyuContext();
  const supabase = useMemo(() => createClient(), []);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  // 対象 (発行/FB の絞込) と 名寄 (世帯合算) は別チェック列 (order-app と同じ)
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [merged, setMerged] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [jippiByUser, setJippiByUser] = useState<Map<string, JippiEntry[]>>(new Map());

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  const loadJippi = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("riyou_jippi_entries")
      .select("id, client_id, item_name, unit_price, quantity, amount, provide_date")
      .eq("target_month", monthKey)
      .order("created_at");
    if (e) {
      // table 未作成 (migration 未適用) 時は実費なしとして続行
      if (e.code !== "42P01") toast.error("実費取得失敗: " + e.message);
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
      if (e.code !== "42P01") toast.error("入金状況取得失敗: " + e.message);
      setPayments(new Map());
      return;
    }
    setPayments(new Map(((data ?? []) as PaymentRow[]).map((p) => [p.client_id, p])));
  }, [supabase, monthKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadPayments();
  }, [loadPayments]);

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
      if (e.code !== "42P01") toast.error("前月入金状況取得失敗: " + e.message);
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

  // ── 請求個人設定 (軽減 / 医療費控除。①③) — kaigo_riyou_settings ──
  const [settings, setSettings] = useState<Map<string, RiyouSettingRow>>(new Map());
  const loadSettings = useCallback(async () => {
    if (rows.length === 0) {
      setSettings(new Map());
      return;
    }
    const ids = rows.map((r) => r.user_id);
    const m = new Map<string, RiyouSettingRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("kaigo_riyou_settings")
        .select("client_id, keigen_rate, keigen_start_date, keigen_end_date, iryohi_taisho, notes")
        .in("client_id", chunk);
      if (e) {
        // table 未作成 (migration 未適用) 時は設定なしとして続行
        if (e.code !== "42P01") toast.error("請求設定取得失敗: " + e.message);
        setSettings(new Map());
        return;
      }
      for (const s of (data ?? []) as RiyouSettingRow[]) m.set(s.client_id, s);
    }
    setSettings(m);
  }, [supabase, rows]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更/行更新時の fetch
    loadSettings();
  }, [loadSettings]);

  // 軽減額 = round(利用者負担額 × 軽減率 / 100)。対象月に有効な軽減のみ
  const keigenAmount = useCallback(
    (userId: string, userAmount: number) => {
      const s = settings.get(userId);
      if (!keigenActiveInMonth(s, monthKey)) return 0;
      return Math.round((userAmount * (s!.keigen_rate ?? 0)) / 100);
    },
    [settings, monthKey],
  );

  // 行の請求額 = 利用者負担額 − 軽減額 + 実費
  const rowBilled = useCallback(
    (r: UserSeikyuRow) =>
      r.userAmount - keigenAmount(r.user_id, r.userAmount) + jippiTotal(r.user_id),
    [keigenAmount, jippiTotal],
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
      const afterKeigen = r.userAmount - keigenAmount(r.user_id, r.userAmount);
      return Math.round((afterKeigen * eligibleUnits) / r.totalUnits);
    },
    [settings, keigenAmount],
  );

  // 印刷/フッタ用の per-user 計算値 (rows 全体で計算しておく)
  const keigenByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.user_id, keigenAmount(r.user_id, r.userAmount));
    return m;
  }, [rows, keigenAmount]);
  const iryohiByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (settings.get(r.user_id)?.iryohi_taisho) m.set(r.user_id, iryohiAmount(r));
    }
    return m;
  }, [rows, settings, iryohiAmount]);

  // 口座情報 (FB データ用) — clients の bank_* を月内の利用者分だけ fetch
  const [bankByUser, setBankByUser] = useState<Map<string, ClientBank>>(new Map());
  const loadBanks = useCallback(async () => {
    if (rows.length === 0) {
      setBankByUser(new Map());
      return;
    }
    const ids = rows.map((r) => r.user_id);
    const m = new Map<string, ClientBank>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error: e } = await supabase
        .from("clients")
        .select("id, bank_name, bank_branch, bank_account_type, bank_account_number, bank_account_holder")
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
        });
      }
    }
    setBankByUser(m);
  }, [supabase, rows]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更/行更新時の fetch
    loadBanks();
  }, [loadBanks]);

  // 選択行 (order-app と同じく未選択時は右ペインに placeholder を出す)
  const selected =
    filteredRows.find((r) => r.user_id === selectedUserId) ?? null;
  const totalBilled = filteredRows.reduce((s, r) => s + rowBilled(r), 0);

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
  const toggleMerged = (id: string) =>
    setMerged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 発行対象: チェックあり → その利用者のみ / チェックなし → 全件
  const targets = useMemo(
    () =>
      checked.size > 0
        ? filteredRows.filter((r) => checked.has(r.user_id))
        : filteredRows,
    [filteredRows, checked],
  );

  const reiwa = year - 2018;

  const issueSeikyusho = async () => {
    // 発行記録: 請求額 + 発行日を upsert (入金状態は既存を保持、新規は 請求済)
    // billed_amount は軽減後の当月分のみ (繰越は印字のみ = 二重計上を避ける)
    const today = new Date();
    const issued = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const { error: upErr } = await supabase.from("riyou_seikyu_payments").upsert(
      targets.map((r) => ({
        client_id: r.user_id,
        target_month: monthKey,
        billed_amount: rowBilled(r),
        issued_date: issued,
      })),
      { onConflict: "client_id,target_month" },
    );
    if (upErr && upErr.code !== "42P01") {
      toast.error("発行記録の保存に失敗: " + upErr.message);
    } else if (!upErr) {
      loadPayments();
    }
    setPrinting(true);
    // print CSS 適用後に印刷 dialog
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 100);
  };

  // ── 支払方法 / 請求書発行日 のインライン編集 (order-app の行内 select/date と同じ) ──
  //    upsert は指定列のみ更新 (入金状態などは既存を保持 — issueSeikyusho と同じ流儀)
  const setPaymentMethod = async (r: UserSeikyuRow, method: string) => {
    const { error: e } = await supabase.from("riyou_seikyu_payments").upsert(
      {
        client_id: r.user_id,
        target_month: monthKey,
        billed_amount: payments.get(r.user_id)?.billed_amount ?? rowBilled(r),
        payment_method: method || null,
      },
      { onConflict: "client_id,target_month" },
    );
    if (e) {
      if (e.code !== "42P01") toast.error("支払方法の保存に失敗: " + e.message);
      return;
    }
    loadPayments();
  };
  const setIssuedDate = async (r: UserSeikyuRow, date: string) => {
    const { error: e } = await supabase.from("riyou_seikyu_payments").upsert(
      {
        client_id: r.user_id,
        target_month: monthKey,
        billed_amount: payments.get(r.user_id)?.billed_amount ?? rowBilled(r),
        issued_date: date || null,
      },
      { onConflict: "client_id,target_month" },
    );
    if (e) {
      if (e.code !== "42P01") toast.error("発行日の保存に失敗: " + e.message);
      return;
    }
    loadPayments();
  };

  // ─── 名寄せ (世帯合算) — order-app UserBillingTab の groupForPrint と同じ挙動 ──
  // 発行対象 (targets) のうち「名寄」チェックされた 2 名以上を 1 世帯グループに、
  // それ以外は 1 名 1 枚。請求書発行 (issueSeikyusho) の同じ印刷 view 内で出し分ける。
  const printGroups = useMemo(() => {
    const household = targets.filter((r) => merged.has(r.user_id));
    if (household.length >= 2) {
      return {
        household,
        singles: targets.filter((r) => !merged.has(r.user_id)),
      };
    }
    // 名寄 1 名以下は合算にならないので全員個別
    return { household: [] as UserSeikyuRow[], singles: targets };
  }, [targets, merged]);

  // ─── FB データ (全銀協 口座振替) ───────────────────────────────────────────
  const exportFbData = () => {
    // 対象: 発行対象 (targets)。金額 (負担額 + 実費) を引落額とする
    const fbTargets: FbTransferTarget[] = targets.map((r) => {
      const bank = bankByUser.get(r.user_id);
      return {
        customerNumber: r.insured_number ?? r.user_id.slice(0, 20),
        accountHolderKana: bank?.bank_account_holder ?? r.user_name_kana ?? r.user_name,
        bankCode: null, // clients に銀行番号は未保持 → 空欄
        branchCode: null, // 支店番号も未保持 → 空欄
        bankName: bank?.bank_name ?? null,
        branchName: bank?.bank_branch ?? null,
        accountType: bank?.bank_account_type ?? null,
        accountNumber: bank?.bank_account_number ?? null,
        amount: rowBilled(r), // 軽減後の当月請求額 (負担額 − 軽減 + 実費)
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

  // ── フッタ集計 (order-app の 件数合計/確定合計 に対応) ──
  const issuedRows = filteredRows.filter((r) => payments.has(r.user_id));
  const issuedTotal = issuedRows.reduce(
    (s, r) => s + (payments.get(r.user_id)?.billed_amount ?? 0),
    0,
  );
  const paidTotal = filteredRows.reduce(
    (s, r) => s + (payments.get(r.user_id)?.paid_amount ?? 0),
    0,
  );
  const misyuCount = filteredRows.filter((r) => {
    const p = payments.get(r.user_id);
    return p && p.status !== "入金完";
  }).length;

  // 軽減 / 繰越 / 医療費控除 の全体合計 (フッタ実値化用)
  const keigenTotal = filteredRows.reduce(
    (s, r) => s + (keigenByUser.get(r.user_id) ?? 0),
    0,
  );
  const iryohiTotal = filteredRows.reduce(
    (s, r) => s + (iryohiByUser.get(r.user_id) ?? 0),
    0,
  );
  // 過入金充当額 = 負の繰越 (前月過入金) の合計絶対値 / 未収繰越 = 正の繰越の合計
  const overpayTotal = filteredRows.reduce((s, r) => {
    const c = carryover(r.user_id);
    return s + (c < 0 ? -c : 0);
  }, 0);
  const misyuCarryTotal = filteredRows.reduce((s, r) => {
    const c = carryover(r.user_id);
    return s + (c > 0 ? c : 0);
  }, 0);

  // 選択行のフッタ詳細 (未選択時は全体合計 — order-app と同じ)
  const selAmount = selected ? rowBilled(selected) : totalBilled;
  const selKeigen = selected
    ? (keigenByUser.get(selected.user_id) ?? 0)
    : keigenTotal;
  const selIryohi = selected
    ? (iryohiByUser.get(selected.user_id) ?? 0)
    : iryohiTotal;
  const selOverpay = selected
    ? Math.max(0, -carryover(selected.user_id))
    : overpayTotal;
  const selMisyuCarry = selected
    ? Math.max(0, carryover(selected.user_id))
    : misyuCarryTotal;

  const checkedCount = filteredRows.filter((r) => checked.has(r.user_id)).length;
  const printScopeLabel =
    checkedCount > 0 ? `対象 ${checkedCount} 名` : `全 ${filteredRows.length} 名`;
  const allChecked =
    filteredRows.length > 0 && checked.size === filteredRows.length;

  const statusBadge = (userId: string) => {
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
            <span className="text-xs text-gray-500">{filteredRows.length} 件</span>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button
              type="button"
              onClick={issueSeikyusho}
              disabled={filteredRows.length === 0}
              title={`利用料請求書を発行 (${printScopeLabel})。発行日を記録して印刷します。「名寄」チェック 2 名以上は 1 枚の世帯合算請求書になります`}
              className="border border-emerald-500 rounded bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <FileText size={13} />
              請求書 ({targets.length}件)
            </button>
            <button
              type="button"
              onClick={exportFbData}
              disabled={filteredRows.length === 0}
              title="全銀協 口座振替フォーマット (Shift_JIS) で FB データを出力"
              className="border border-blue-500 rounded bg-blue-50 px-2.5 py-1 text-blue-700 hover:bg-blue-100 flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <Banknote size={13} />
              FBデータ ({targets.length}件)
            </button>
            <span className="text-[11px] text-gray-400">{printScopeLabel}</span>
          </div>

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
                <table className="min-w-full text-xs border-collapse">
                  <thead className="bg-gray-100 text-gray-700 sticky top-0 z-10">
                    <tr>
                      <th className="px-2 py-1.5 border border-gray-300 text-center w-10">
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
                      <th className="px-2 py-1.5 border border-gray-300 text-center w-10">名寄</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-center w-16">状態</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-left">利用者名</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-left">事業所名</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-left w-24">番号</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-left w-24">支払方法</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-right w-24">請求額</th>
                      <th className="px-2 py-1.5 border border-gray-300 text-left w-28">請求書発行日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((r) => {
                      const p = payments.get(r.user_id);
                      const isSelected = selectedUserId === r.user_id;
                      return (
                        <tr
                          key={r.user_id}
                          className={`cursor-pointer ${isSelected ? "bg-indigo-50" : "hover:bg-blue-50"}`}
                          onClick={() => setSelectedUserId(r.user_id)}
                        >
                          <td className="px-2 py-1 border border-gray-200 text-center">
                            <input
                              type="checkbox"
                              checked={checked.has(r.user_id)}
                              onChange={() => toggle(r.user_id)}
                              onClick={(e) => e.stopPropagation()}
                              className="cursor-pointer"
                            />
                          </td>
                          <td className="px-2 py-1 border border-gray-200 text-center">
                            <input
                              type="checkbox"
                              checked={merged.has(r.user_id)}
                              onChange={() => toggleMerged(r.user_id)}
                              onClick={(e) => e.stopPropagation()}
                              className="cursor-pointer"
                              title="名寄せ (チェックした利用者を世帯合算の請求書 1 枚に合算)"
                            />
                          </td>
                          <td className="px-2 py-1 border border-gray-200 text-center">
                            {statusBadge(r.user_id)}
                          </td>
                          <td className="px-2 py-1 border border-gray-200 font-medium">
                            {r.user_name}
                          </td>
                          <td
                            className="px-2 py-1 border border-gray-200 truncate max-w-[200px]"
                            title={officeName ?? ""}
                          >
                            {officeName ?? "-"}
                          </td>
                          <td className="px-2 py-1 border border-gray-200 font-mono">
                            {r.insured_number ?? "-"}
                          </td>
                          <td
                            className="px-2 py-1 border border-gray-200"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <select
                              value={p?.payment_method ?? ""}
                              onChange={(e) => setPaymentMethod(r, e.target.value)}
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
                            className="px-2 py-1 border border-gray-200 text-right font-mono"
                            title={
                              (keigenByUser.get(r.user_id) ?? 0) > 0
                                ? `軽減 ▲¥${(keigenByUser.get(r.user_id) ?? 0).toLocaleString()} 適用後`
                                : undefined
                            }
                          >
                            ¥{rowBilled(r).toLocaleString()}
                            {(keigenByUser.get(r.user_id) ?? 0) > 0 && (
                              <span className="ml-1 text-[9px] text-rose-500 font-sans">軽</span>
                            )}
                          </td>
                          <td
                            className="px-2 py-1 border border-gray-200"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="date"
                              value={p?.issued_date ?? ""}
                              onChange={(e) => setIssuedDate(r, e.target.value)}
                              className="w-full bg-transparent border-0 text-xs focus:bg-white focus:border focus:border-indigo-300 focus:outline-none rounded px-1 py-0.5"
                            />
                            {p?.issued_date && (
                              <span className="text-[10px] text-gray-400 ml-1">
                                {fmtReiwaDate(p.issued_date)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredRows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-sm">
                          対象月の実績 (完了) がありません
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* フッタ: 総合計 + 選択行詳細 (order-app と同一レイアウト) */}
              <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-xs">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-700">
                  <span>
                    件数合計 <span className="font-mono font-semibold">{filteredRows.length.toLocaleString()}</span>
                  </span>
                  <span>
                    請求額合計{" "}
                    <span className="font-mono font-semibold">¥{totalBilled.toLocaleString()}</span>
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

        {/* ── 右ペイン: 利用明細欄 ── */}
        <div className="w-80 shrink-0 flex flex-col bg-white">
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">利用明細欄</span>
            {selected && (
              <span className="text-xs text-gray-500 truncate max-w-[160px]">
                {selected.user_name}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            {!selected && (
              <div className="p-4 text-center text-gray-400 text-xs">
                左の行をクリックすると明細が表示されます
              </div>
            )}
            {selected && (
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
                    <span>
                      利用者負担額 ({Math.round(selected.copay_rate * 10)}割)
                    </span>
                    <span className="font-mono">
                      ¥{selected.userAmount.toLocaleString()}
                    </span>
                  </div>
                  {(keigenByUser.get(selected.user_id) ?? 0) > 0 && (
                    <div className="flex justify-between text-rose-600">
                      <span>
                        軽減額 ({settings.get(selected.user_id)?.keigen_rate ?? 0}%)
                      </span>
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
                    <span className="font-mono">
                      ¥{rowBilled(selected).toLocaleString()}
                    </span>
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

                {/* 利用実費 (保険外) の入力 */}
                <div className="px-3 pb-3">
                  <JippiSection
                    key={`jippi-${selected.user_id}-${monthKey}`}
                    userId={selected.user_id}
                    monthKey={monthKey}
                    entries={jippiByUser.get(selected.user_id) ?? []}
                    onChanged={loadJippi}
                  />

                  {/* 請求設定 (軽減 / 医療費控除) — ほのぼの「請求個人設定」相当 */}
                  <RiyouSettingsSection
                    key={`setting-${selected.user_id}`}
                    userId={selected.user_id}
                    setting={settings.get(selected.user_id) ?? null}
                    onChanged={loadSettings}
                  />

                  {/* 入金登録 (未収金管理) */}
                  <PaymentSection
                    key={`pay-${selected.user_id}-${monthKey}`}
                    userId={selected.user_id}
                    monthKey={monthKey}
                    billed={rowBilled(selected)}
                    payment={payments.get(selected.user_id) ?? null}
                    onChanged={loadPayments}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ===== 印刷 view: 利用料請求書 =====
          名寄チェック 2 名以上 → 1 枚の世帯合算請求書 / それ以外 → 1 名 1 枚
          (order-app UserBillingTab の請求書発行と同じ操作感) */}
      {printing && (
        <div className="hidden print:block">
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
            />
          )}
          {printGroups.singles.map((r) => (
            <RiyouSeikyuPrintSheet
              key={r.user_id}
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
        </div>
      )}
    </>
  );
}

// ─── 明細行の利用者負担額 比例配分 (端数は最大行に寄せて合計を一致させる) ──────
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
        ? Math.floor((d.units / row.totalUnits) * row.userAmount)
        : 0,
  }));
  if (row.addonUnits > 0) {
    lines.push({
      label: row.addonLabel ?? "処遇改善加算",
      unitPer: null,
      count: 1,
      amount:
        row.totalUnits > 0
          ? Math.floor((row.addonUnits / row.totalUnits) * row.userAmount)
          : 0,
    });
  }
  // floor の切捨て分を最大金額の行に加算して合計 = userAmount にする
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  const diff = row.userAmount - sum;
  if (diff !== 0 && lines.length > 0) {
    const maxLine = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
    maxLine.amount += diff;
  }
  return lines;
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
}: {
  userId: string;
  monthKey: string;
  billed: number;
  payment: PaymentRow | null;
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
    const paid = asStatus === "未収" ? payment?.paid_amount ?? 0 : parseInt(amount, 10) || 0;
    const status =
      asStatus ??
      (paid >= billed && billed > 0 ? "入金完" : paid > 0 ? "一部入金" : "請求済");
    const { error } = await supabase.from("riyou_seikyu_payments").upsert(
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
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const lines = splitUserAmount(row);
  const jippiSum = jippi.reduce((s, e) => s + e.amount, 0);
  // 当月請求額 = 利用者負担 − 軽減 + 実費
  const monthTotal = row.userAmount - keigen + jippiSum;
  // 繰越額 = 前回請求 − 前回入金 (正 = 未収繰越 / 負 = 過入金充当)
  const carry = prevPayment
    ? prevPayment.billed_amount - prevPayment.paid_amount
    : 0;
  // 今回御請求額 = 当月請求額 + 繰越額
  const grandTotal = monthTotal + carry;

  return (
    <div className="p-10 text-black" style={{ pageBreakAfter: "always" }}>
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書
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
              小計 (利用者負担額{Math.round(row.copay_rate * 10)}割)
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{row.userAmount.toLocaleString()}
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
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const rep = rows[0]; // 代表者 = 先頭
  // 各利用者の 負担額 − 軽減 + 実費 = 明細 1 行、合計を世帯合算とする
  const perUser = rows.map((r) => {
    const jippiSum = (jippiByUser.get(r.user_id) ?? []).reduce((s, e) => s + e.amount, 0);
    const keigen = keigenByUser.get(r.user_id) ?? 0;
    return { row: r, jippiSum, keigen, subtotal: r.userAmount - keigen + jippiSum };
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
    <div className="p-10 text-black" style={{ pageBreakAfter: "always" }}>
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書 (世帯合算)
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
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                ¥{u.row.userAmount.toLocaleString()}
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
