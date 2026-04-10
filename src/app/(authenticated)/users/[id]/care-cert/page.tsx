"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO, addYears } from "date-fns";
import { Trash2, RefreshCw, Save, FileCheck, ArrowRightLeft, X } from "lucide-react";
import type { CareCertification, CareLevel } from "@/types/database";

// ─── 定数 ────────────────────────────────────────────────────────────────────

const CARE_LEVELS: CareLevel[] = [
  "申請中",
  "非該当",
  "要支援1",
  "要支援2",
  "要介護1",
  "要介護2",
  "要介護3",
  "要介護4",
  "要介護5",
];

// ─── 型定義 ───────────────────────────────────────────────────────────────────

/** DB に保存するフィールド */
type DbFields = {
  insured_number: string;
  certification_date: string;
  insurer_number: string;
  start_date: string;
  end_date: string;
  care_level: CareLevel;
  support_limit_amount: string;
  status: "active" | "expired" | "pending";
  certification_number: string;
};

/** ローカルステート専用フィールド（DB列なし） */
type LocalFields = {
  insurer_name: string;
  copay_rate: string;
  insurance_check_date: string;
  qualification_date: string;
  insurance_start_date: string;
  insurance_end_date: string;
  cert_status_type: "認定済み" | "申請中";
  service_start_date: string;
  service_end_date: string;
  service_limit_type: string;
  notes: string;
  benefit_type: string;
  benefit_content: string;
  benefit_rate: string;
  benefit_start_date: string;
  benefit_end_date: string;
  support_office_date: string;
  care_manager: string;
};

type FormData = DbFields & LocalFields;

const EMPTY_FORM: FormData = {
  // DB
  insured_number: "",
  certification_date: "",
  insurer_number: "",
  start_date: "",
  end_date: "",
  care_level: "申請中",
  support_limit_amount: "",
  status: "active",
  certification_number: "",
  // Local
  insurer_name: "",
  copay_rate: "90",
  insurance_check_date: "",
  qualification_date: "",
  insurance_start_date: "",
  insurance_end_date: "",
  cert_status_type: "認定済み",
  service_start_date: "",
  service_end_date: "",
  service_limit_type: "なし",
  notes: "",
  benefit_type: "",
  benefit_content: "",
  benefit_rate: "",
  benefit_start_date: "",
  benefit_end_date: "",
  support_office_date: "",
  care_manager: "",
};

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return format(parseISO(d), "yyyy/MM/dd");
  } catch {
    return d;
  }
}

function recToForm(rec: CareCertification): FormData {
  return {
    ...EMPTY_FORM,
    insured_number: rec.insured_number ?? "",
    certification_date: rec.certification_date ?? "",
    insurer_number: rec.insurer_number ?? "",
    start_date: rec.start_date ?? "",
    end_date: rec.end_date ?? "",
    care_level: rec.care_level,
    support_limit_amount: rec.support_limit_amount?.toString() ?? "",
    status: rec.status ?? "active",
    certification_number: rec.certification_number ?? "",
    cert_status_type: rec.care_level === "申請中" ? "申請中" : "認定済み",
  };
}

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const inp =
  "w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white";
const inpSm =
  "border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white";
const labelCls = "block text-xs text-gray-600 mb-0.5";
const labelYellow = "block text-xs mb-0.5 font-medium text-amber-800 bg-amber-100 px-1 rounded";

// ─── メインコンポーネント ──────────────────────────────────────────────────────

export default function CareCertPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const supabase = createClient();

  const [records, setRecords] = useState<CareCertification[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // 区分変更モーダル
  const [showClassChangeModal, setShowClassChangeModal] = useState(false);
  const [classChangeForm, setClassChangeForm] = useState({
    newCareLevel: "要介護1" as CareLevel,
    changeDate: "",           // 区分変更認定日（＝新認定の start_date）
    newEndDate: "",           // 新認定の end_date
    certificationDate: "",    // 認定年月日
    supportLimitAmount: "",   // 区分支給限度額
  });

  // ── データ取得 ──────────────────────────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_care_certifications")
        .select("*")
        .eq("user_id", userId)
        .order("start_date", { ascending: false });
      if (error) throw error;
      const recs = data ?? [];
      setRecords(recs);
      // 最新レコードを自動選択
      if (recs.length > 0 && selectedId === null) {
        setSelectedId(recs[0].id);
        setForm(recToForm(recs[0]));
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [supabase, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  // ── 行選択 ────────────────────────────────────────────────────────────────

  const selectRow = (rec: CareCertification) => {
    setSelectedId(rec.id);
    setForm(recToForm(rec));
  };

  // ── フォームフィールド更新 ─────────────────────────────────────────────────

  const setField = <K extends keyof FormData>(key: K, value: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // ── 保険変更（上書き保存） ────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selectedId) {
      toast.error("レコードが選択されていません");
      return;
    }
    if (!form.start_date || !form.end_date) {
      toast.error("認定有効期間（開始・終了）は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        care_level: form.care_level,
        start_date: form.start_date,
        end_date: form.end_date,
        certification_date: form.certification_date || null,
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        support_limit_amount: form.support_limit_amount
          ? Number(form.support_limit_amount)
          : null,
        status: form.status,
        certification_number: form.certification_number || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("kaigo_care_certifications")
        .update(payload)
        .eq("id", selectedId);
      if (error) throw error;
      toast.success("保存しました");
      await fetchRecords();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // ── 認定更新（新規レコード作成） ──────────────────────────────────────────

  const handleRenewal = async () => {
    if (!form.end_date) {
      toast.error("認定終了日が設定されていません");
      return;
    }
    const confirmed = confirm(
      "認定更新：現在の認定情報をもとに新しい認定期間のレコードを作成します。よろしいですか？"
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      // 新しい有効期間：現在の終了日翌日〜1年後
      const oldEnd = parseISO(form.end_date);
      const newStart = new Date(oldEnd);
      newStart.setDate(newStart.getDate() + 1);
      const newEnd = addYears(newStart, 1);
      newEnd.setDate(newEnd.getDate() - 1);

      const payload = {
        user_id: userId,
        care_level: form.care_level,
        start_date: format(newStart, "yyyy-MM-dd"),
        end_date: format(newEnd, "yyyy-MM-dd"),
        certification_date: null,
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        support_limit_amount: form.support_limit_amount
          ? Number(form.support_limit_amount)
          : null,
        status: "pending" as const,
        certification_number: null,
      };
      const { data, error } = await supabase
        .from("kaigo_care_certifications")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      toast.success("認定更新レコードを作成しました");
      await fetchRecords();
      // 新規作成したレコードを選択
      if (data) {
        setSelectedId(data.id);
        setForm(recToForm(data));
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "認定更新に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // ── 区分変更モーダルを開く ─────────────────────────────────────────────────

  const openClassChangeModal = () => {
    if (!selectedId) {
      toast.error("現在の認定レコードを選択してください");
      return;
    }
    if (!form.end_date) {
      toast.error("現在の認定終了日が設定されていません");
      return;
    }
    // デフォルト値: 今日を区分変更日、新有効期間は今日〜現在の終了日
    const today = format(new Date(), "yyyy-MM-dd");
    setClassChangeForm({
      newCareLevel: form.care_level,
      changeDate: today,
      newEndDate: form.end_date,
      certificationDate: today,
      supportLimitAmount: form.support_limit_amount,
    });
    setShowClassChangeModal(true);
  };

  // ── 区分変更実行 ──────────────────────────────────────────────────────────

  const handleClassChange = async () => {
    if (!selectedId) {
      toast.error("現在の認定レコードが選択されていません");
      return;
    }
    const { newCareLevel, changeDate, newEndDate, certificationDate, supportLimitAmount } =
      classChangeForm;

    if (!changeDate || !newEndDate) {
      toast.error("区分変更日と新しい認定有効期間の終了日は必須です");
      return;
    }
    if (newEndDate < changeDate) {
      toast.error("終了日は区分変更日以降を指定してください");
      return;
    }

    // 旧認定の終了日 = 区分変更日の前日
    const changeDateObj = parseISO(changeDate);
    const oldEndDate = new Date(changeDateObj);
    oldEndDate.setDate(oldEndDate.getDate() - 1);
    const oldEndDateStr = format(oldEndDate, "yyyy-MM-dd");

    if (oldEndDateStr < form.start_date) {
      toast.error("区分変更日が旧認定の開始日以前です。開始日より後を指定してください");
      return;
    }

    const confirmed = confirm(
      `区分変更を実行します:\n\n` +
      `旧認定: ${form.care_level}（${form.start_date} 〜 ${oldEndDateStr} に終了）\n` +
      `新認定: ${newCareLevel}（${changeDate} 〜 ${newEndDate}）\n\n` +
      `よろしいですか？`
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      // 1. 旧認定の end_date を区分変更日の前日に更新
      const { error: updateErr } = await supabase
        .from("kaigo_care_certifications")
        .update({
          end_date: oldEndDateStr,
          status: "expired",
          updated_at: new Date().toISOString(),
        })
        .eq("id", selectedId);
      if (updateErr) throw updateErr;

      // 2. 新しい区分変更認定レコードを挿入
      const payload = {
        user_id: userId,
        care_level: newCareLevel,
        start_date: changeDate,
        end_date: newEndDate,
        certification_date: certificationDate || changeDate,
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        support_limit_amount: supportLimitAmount ? Number(supportLimitAmount) : null,
        status: "active" as const,
        certification_number: null,
      };
      const { data, error: insertErr } = await supabase
        .from("kaigo_care_certifications")
        .insert(payload)
        .select()
        .single();
      if (insertErr) throw insertErr;

      toast.success(`区分変更を登録しました（${form.care_level} → ${newCareLevel}）`);
      setShowClassChangeModal(false);
      await fetchRecords();
      // 新規作成レコードを選択
      if (data) {
        setSelectedId(data.id);
        setForm(recToForm(data));
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "区分変更に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // ── 削除 ──────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (!confirm("この認定情報を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("kaigo_care_certifications")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("削除しました");
      if (selectedId === id) {
        setSelectedId(null);
        setForm(EMPTY_FORM);
      }
      await fetchRecords();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  // ── レンダリング ──────────────────────────────────────────────────────────

  return (
    <div className="rounded-b-lg border border-t-0 bg-white shadow-sm">
      {/* ══════════════════════════════════════════
          Section 1: 履歴一覧テーブル
      ══════════════════════════════════════════ */}
      <div className="border-b border-gray-200">
        <div className="bg-gray-100 border-b border-gray-200 px-4 py-1.5">
          <span className="text-xs font-semibold text-gray-700">介護認定 履歴一覧</span>
        </div>

        {loading ? (
          <div className="py-6 text-center text-xs text-gray-400">読み込み中...</div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-gray-400">
            <FileCheck size={32} className="mb-2 opacity-30" />
            <p className="text-xs">介護認定情報がありません</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">保険者</th>
                  <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">被保険者番号</th>
                  <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">保険有効期間</th>
                  <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">要介護度</th>
                  <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">認定年月日</th>
                  <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">認定有効期間</th>
                  <th className="border-b border-gray-200 px-3 py-1.5 text-center font-medium whitespace-nowrap w-8"></th>
                </tr>
              </thead>
              <tbody>
                {records.map((rec) => {
                  const isSelected = rec.id === selectedId;
                  return (
                    <tr
                      key={rec.id}
                      onClick={() => selectRow(rec)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-blue-100 border-l-2 border-l-blue-500"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {rec.insurer_number ?? "—"}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {rec.insured_number ?? "—"}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {formatDate(rec.start_date)} 〜 {formatDate(rec.end_date)}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                          rec.care_level.startsWith("要介護")
                            ? "bg-orange-100 text-orange-800"
                            : rec.care_level.startsWith("要支援")
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-600"
                        }`}>
                          {rec.care_level}
                        </span>
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {formatDate(rec.certification_date)}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {formatDate(rec.start_date)} 〜 {formatDate(rec.end_date)}
                      </td>
                      <td className="border-b border-gray-100 px-2 py-1.5 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(rec.id);
                          }}
                          className="rounded p-1 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="削除"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════
          Section 2: 詳細入力フォーム
      ══════════════════════════════════════════ */}
      <div>
        {/* フォームヘッダー・ボタン */}
        <div className="bg-gray-100 border-b border-gray-200 px-4 py-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-700">
            {selectedId ? "介護認定 詳細" : "介護認定 詳細（レコードを選択してください）"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !selectedId}
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              <Save size={11} />
              保険変更
            </button>
            <button
              onClick={openClassChangeModal}
              disabled={saving || !selectedId}
              className="inline-flex items-center gap-1 rounded bg-orange-600 px-3 py-1 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-40 transition-colors"
              title="要介護度を変更して新しい認定レコードを作成します"
            >
              <ArrowRightLeft size={11} />
              区分変更
            </button>
            <button
              onClick={handleRenewal}
              disabled={saving || !selectedId}
              className="inline-flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={11} />
              認定更新
            </button>
          </div>
        </div>

        {/* 3カラムレイアウト */}
        <div className="grid grid-cols-3 divide-x divide-gray-200 min-h-[480px]">
          {/* ── 左カラム ── */}
          <div className="p-4 space-y-3">
            <div className="text-xs font-semibold text-gray-500 border-b border-gray-200 pb-1 mb-2">
              保険証情報
            </div>

            <div>
              <label className={labelCls}>被保険者番号</label>
              <input
                type="text"
                value={form.insured_number}
                onChange={(e) => setField("insured_number", e.target.value)}
                className={inp}
                placeholder="0000000000"
              />
            </div>

            <div>
              <label className={labelCls}>交付年月日</label>
              <input
                type="date"
                value={form.certification_date}
                onChange={(e) => setField("certification_date", e.target.value)}
                className={inp}
              />
            </div>

            <div>
              <label className={labelCls}>保険者番号</label>
              <input
                type="text"
                value={form.insurer_number}
                onChange={(e) => setField("insurer_number", e.target.value)}
                className={inp}
                placeholder="000000"
              />
            </div>

            <div>
              <label className={labelCls}>保険者名</label>
              <input
                type="text"
                value={form.insurer_name}
                onChange={(e) => setField("insurer_name", e.target.value)}
                className={inp}
                placeholder="〇〇市"
              />
            </div>

            <div>
              <label className={labelCls}>給付率（%）</label>
              <input
                type="number"
                value={form.copay_rate}
                onChange={(e) => setField("copay_rate", e.target.value)}
                className={inp}
                min={0}
                max={100}
              />
            </div>

            <div>
              <label className={labelCls}>保険証確認日</label>
              <input
                type="date"
                value={form.insurance_check_date}
                onChange={(e) => setField("insurance_check_date", e.target.value)}
                className={inp}
              />
            </div>

            <div>
              <label className={labelCls}>資格取得日</label>
              <input
                type="date"
                value={form.qualification_date}
                onChange={(e) => setField("qualification_date", e.target.value)}
                className={inp}
              />
            </div>

            <div>
              <label className={labelYellow}>保険証有効期間</label>
              <div className="flex items-center gap-1 mt-1">
                <input
                  type="date"
                  value={form.insurance_start_date}
                  onChange={(e) => setField("insurance_start_date", e.target.value)}
                  className={`${inpSm} flex-1`}
                />
                <span className="text-xs text-gray-400">〜</span>
                <input
                  type="date"
                  value={form.insurance_end_date}
                  onChange={(e) => setField("insurance_end_date", e.target.value)}
                  className={`${inpSm} flex-1`}
                />
              </div>
            </div>
          </div>

          {/* ── 中央カラム ── */}
          <div className="p-4 space-y-3">
            <div className="text-xs font-semibold text-gray-500 border-b border-gray-200 pb-1 mb-2">
              認定情報
            </div>

            {/* 要介護状態等ラジオ */}
            <div>
              <label className={labelCls}>要介護状態等</label>
              <div className="flex gap-4 mt-1">
                {(["認定済み", "申請中"] as const).map((v) => (
                  <label key={v} className="flex items-center gap-1 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="cert_status_type"
                      value={v}
                      checked={form.cert_status_type === v}
                      onChange={() => setField("cert_status_type", v)}
                      className="accent-blue-600"
                    />
                    {v}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>介護度</label>
              <select
                value={form.care_level}
                onChange={(e) => setField("care_level", e.target.value as CareLevel)}
                className={inp}
              >
                {CARE_LEVELS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>認定年月日</label>
              <input
                type="date"
                value={form.certification_date}
                onChange={(e) => setField("certification_date", e.target.value)}
                className={inp}
              />
            </div>

            <div>
              <label className={labelYellow}>認定有効期間</label>
              <div className="flex items-center gap-1 mt-1">
                <input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => setField("start_date", e.target.value)}
                  className={`${inpSm} flex-1`}
                />
                <span className="text-xs text-gray-400">〜</span>
                <input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setField("end_date", e.target.value)}
                  className={`${inpSm} flex-1`}
                />
              </div>
            </div>

            {/* 居宅サービス区分 */}
            <div className="border border-gray-200 rounded p-2 space-y-2 bg-gray-50">
              <div className="text-xs font-medium text-gray-600">居宅サービス区分</div>

              <div>
                <label className={labelYellow}>適用期間</label>
                <div className="flex items-center gap-1 mt-1">
                  <input
                    type="date"
                    value={form.service_start_date}
                    onChange={(e) => setField("service_start_date", e.target.value)}
                    className={`${inpSm} flex-1`}
                  />
                  <span className="text-xs text-gray-400">〜</span>
                  <input
                    type="date"
                    value={form.service_end_date}
                    onChange={(e) => setField("service_end_date", e.target.value)}
                    className={`${inpSm} flex-1`}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>区分支給限度額（円）</label>
                <input
                  type="number"
                  value={form.support_limit_amount}
                  onChange={(e) => setField("support_limit_amount", e.target.value)}
                  className={inp}
                  min={0}
                  placeholder="0"
                />
              </div>

              <div>
                <button
                  type="button"
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs text-gray-600 bg-white hover:bg-gray-50 text-left"
                >
                  種類別支給限度 ▶
                </button>
              </div>
            </div>

            <div>
              <label className={labelCls}>留意事項</label>
              <textarea
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
                className={`${inp} resize-none`}
                rows={2}
              />
            </div>

            <div>
              <label className={labelCls}>サービス限定</label>
              <select
                value={form.service_limit_type}
                onChange={(e) => setField("service_limit_type", e.target.value)}
                className={inp}
              >
                <option value="なし">なし</option>
                <option value="あり">あり</option>
              </select>
            </div>
          </div>

          {/* ── 右カラム ── */}
          <div className="p-4 space-y-3">
            <div className="text-xs font-semibold text-gray-500 border-b border-gray-200 pb-1 mb-2">
              介護保険負担割合証・給付制限等
            </div>

            <div className="border border-gray-200 rounded p-2 space-y-2 bg-gray-50">
              <div>
                <label className={labelCls}>給付種類</label>
                <input
                  type="text"
                  value={form.benefit_type}
                  onChange={(e) => setField("benefit_type", e.target.value)}
                  className={inp}
                />
              </div>
              <div>
                <label className={labelCls}>内容</label>
                <input
                  type="text"
                  value={form.benefit_content}
                  onChange={(e) => setField("benefit_content", e.target.value)}
                  className={inp}
                />
              </div>
              <div>
                <label className={labelCls}>給付率（%）</label>
                <input
                  type="number"
                  value={form.benefit_rate}
                  onChange={(e) => setField("benefit_rate", e.target.value)}
                  className={inp}
                  min={0}
                  max={100}
                />
              </div>
              <div>
                <label className={labelCls}>期間</label>
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    value={form.benefit_start_date}
                    onChange={(e) => setField("benefit_start_date", e.target.value)}
                    className={`${inpSm} flex-1`}
                  />
                  <span className="text-xs text-gray-400">〜</span>
                  <input
                    type="date"
                    value={form.benefit_end_date}
                    onChange={(e) => setField("benefit_end_date", e.target.value)}
                    className={`${inpSm} flex-1`}
                  />
                </div>
              </div>
            </div>

            <div>
              <label className={labelCls}>支援事業所届出日</label>
              <input
                type="date"
                value={form.support_office_date}
                onChange={(e) => setField("support_office_date", e.target.value)}
                className={inp}
              />
            </div>

            <div>
              <label className={labelCls}>担当ケアマネージャー</label>
              <input
                type="text"
                value={form.care_manager}
                onChange={(e) => setField("care_manager", e.target.value)}
                className={inp}
                placeholder="氏名"
              />
            </div>

            {/* ステータス表示 */}
            {selectedId && (
              <div className="mt-4 pt-3 border-t border-gray-200">
                <div className="text-xs text-gray-500 mb-1">ステータス</div>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setField("status", e.target.value as FormData["status"])
                  }
                  className={inp}
                >
                  <option value="active">有効</option>
                  <option value="pending">申請中</option>
                  <option value="expired">期限切れ</option>
                </select>
              </div>
            )}

            {!selectedId && (
              <div className="mt-8 flex flex-col items-center justify-center text-gray-400 py-6">
                <FileCheck size={28} className="mb-2 opacity-30" />
                <p className="text-xs">上の一覧からレコードを選択してください</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          区分変更モーダル
      ══════════════════════════════════════════ */}
      {showClassChangeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowClassChangeModal(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* モーダルヘッダー */}
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 bg-orange-50">
              <div className="flex items-center gap-2">
                <ArrowRightLeft size={16} className="text-orange-600" />
                <h3 className="text-sm font-semibold text-gray-800">区分変更</h3>
              </div>
              <button
                onClick={() => setShowClassChangeModal(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* モーダル本体 */}
            <div className="px-5 py-4 space-y-4">
              {/* 現在の認定情報 */}
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="text-xs font-semibold text-gray-600 mb-1">
                  現在の認定情報
                </div>
                <div className="text-xs text-gray-700 space-y-0.5">
                  <div>
                    要介護度：
                    <span className={`ml-1 inline-block px-1.5 py-0.5 rounded font-medium ${
                      form.care_level.startsWith("要介護")
                        ? "bg-orange-100 text-orange-800"
                        : form.care_level.startsWith("要支援")
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-600"
                    }`}>{form.care_level}</span>
                  </div>
                  <div>
                    認定有効期間：{formatDate(form.start_date)} 〜 {formatDate(form.end_date)}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  ⚠ 現在の認定は「区分変更日の前日」で終了扱いになります
                </div>
              </div>

              {/* 新しい要介護度 */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  新しい要介護度 <span className="text-red-500">*</span>
                </label>
                <select
                  value={classChangeForm.newCareLevel}
                  onChange={(e) =>
                    setClassChangeForm((prev) => ({
                      ...prev,
                      newCareLevel: e.target.value as CareLevel,
                    }))
                  }
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                >
                  {CARE_LEVELS.filter((l) => l !== "申請中" && l !== "非該当").map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>

              {/* 区分変更日 */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  区分変更日（新認定の開始日） <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={classChangeForm.changeDate}
                  onChange={(e) =>
                    setClassChangeForm((prev) => ({ ...prev, changeDate: e.target.value }))
                  }
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                />
              </div>

              {/* 新しい認定有効期間（終了日） */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  新認定の有効期間終了日 <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={classChangeForm.newEndDate}
                  onChange={(e) =>
                    setClassChangeForm((prev) => ({ ...prev, newEndDate: e.target.value }))
                  }
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                />
                <p className="mt-0.5 text-[10px] text-gray-400">
                  通常は区分変更日から6ヶ月〜12ヶ月後を指定します
                </p>
              </div>

              {/* 認定年月日 */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  認定年月日
                </label>
                <input
                  type="date"
                  value={classChangeForm.certificationDate}
                  onChange={(e) =>
                    setClassChangeForm((prev) => ({
                      ...prev,
                      certificationDate: e.target.value,
                    }))
                  }
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                />
              </div>

              {/* 区分支給限度額 */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  区分支給限度額（円）
                </label>
                <input
                  type="number"
                  value={classChangeForm.supportLimitAmount}
                  onChange={(e) =>
                    setClassChangeForm((prev) => ({
                      ...prev,
                      supportLimitAmount: e.target.value,
                    }))
                  }
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                  placeholder="例: 167650"
                />
              </div>
            </div>

            {/* モーダルフッター */}
            <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
              <button
                onClick={() => setShowClassChangeModal(false)}
                disabled={saving}
                className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleClassChange}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded bg-orange-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-700 transition-colors disabled:opacity-50"
              >
                <ArrowRightLeft size={12} />
                {saving ? "登録中..." : "区分変更を登録"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
