"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO, addYears } from "date-fns";
import { Trash2, RefreshCw, Save, FileCheck, Plus } from "lucide-react";
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
  // certification_status の値域は DB 側で CHECK 制約済（認定済み / 申請中 / NULL）
  status: "認定済み" | "申請中";
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
  status: "認定済み",
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
  // DB 列名（client_insurance_records）→ UI フィールド名のマッピング
  //   certification_start_date → start_date
  //   certification_end_date   → end_date
  //   service_limit_amount     → support_limit_amount
  //   certification_status     → status
  return {
    ...EMPTY_FORM,
    insured_number: rec.insured_number ?? "",
    certification_date: rec.certification_date ?? "",
    insurer_number: rec.insurer_number ?? "",
    start_date: rec.certification_start_date ?? "",
    end_date: rec.certification_end_date ?? "",
    care_level: (rec.care_level as CareLevel) ?? "申請中",
    support_limit_amount: rec.service_limit_amount?.toString() ?? "",
    status: (rec.certification_status as DbFields["status"]) ?? "認定済み",
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
  // 新規入力中フラグ（履歴 0 件のときの初回登録、および明示的「+ 新規」入力中の保存先分岐用）
  const [isNew, setIsNew] = useState(false);

  // ── データ取得 ──────────────────────────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select("*")
        .eq("client_id", userId)
        .order("certification_start_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      const recs = (data ?? []) as CareCertification[];
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchRecords();
  }, [fetchRecords]);

  // ── 行選択 ────────────────────────────────────────────────────────────────

  const selectRow = (rec: CareCertification) => {
    setSelectedId(rec.id);
    setForm(recToForm(rec));
    setIsNew(false);
  };

  // ── フォームフィールド更新 ─────────────────────────────────────────────────

  const setField = <K extends keyof FormData>(key: K, value: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // ── 新規入力モードへ ──────────────────────────────────────────────────────

  const handleNew = () => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setIsNew(true);
  };

  // ── 保険変更（既存 UPDATE） / 新規 INSERT ────────────────────────────────

  const handleSave = async () => {
    if (!form.start_date || !form.end_date) {
      toast.error("認定有効期間（開始・終了）は必須です");
      return;
    }
    setSaving(true);
    try {
      // DB 列名（client_insurance_records）にマッピング
      // updated_at はトリガで自動更新されるため省略
      const payload: Record<string, unknown> = {
        care_level: form.care_level,
        certification_start_date: form.start_date,
        certification_end_date: form.end_date,
        certification_date: form.certification_date || null,
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        service_limit_amount: form.support_limit_amount
          ? Number(form.support_limit_amount)
          : null,
        certification_status: form.status,
        certification_number: form.certification_number || null,
      };

      if (selectedId && !isNew) {
        // 既存レコードの上書き保存
        const { error } = await supabase
          .from("client_insurance_records")
          .update(payload)
          .eq("id", selectedId);
        if (error) throw error;
        toast.success("保存しました");
      } else {
        // 新規 INSERT — tenant_id を clients から取得して補完
        const { data: clientRow, error: clientErr } = await supabase
          .from("clients")
          .select("tenant_id")
          .eq("id", userId)
          .single();
        if (clientErr) throw clientErr;
        payload.tenant_id = clientRow?.tenant_id ?? "";
        payload.client_id = userId;
        const { data, error } = await supabase
          .from("client_insurance_records")
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        toast.success("登録しました");
        if (data) {
          setSelectedId(data.id);
          setIsNew(false);
        }
      }
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

      // 新規 INSERT には client_insurance_records.tenant_id が必要なので clients から取得
      const { data: clientRow } = await supabase
        .from("clients")
        .select("tenant_id")
        .eq("id", userId)
        .single();
      const payload = {
        tenant_id: clientRow?.tenant_id ?? "",
        client_id: userId,
        care_level: form.care_level,
        certification_start_date: format(newStart, "yyyy-MM-dd"),
        certification_end_date: format(newEnd, "yyyy-MM-dd"),
        certification_date: null,
        insurer_number: form.insurer_number || null,
        insured_number: form.insured_number || null,
        service_limit_amount: form.support_limit_amount
          ? Number(form.support_limit_amount)
          : null,
        certification_status: "申請中",
        certification_number: null,
      };
      const { data, error } = await supabase
        .from("client_insurance_records")
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

  // ── 削除 ──────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (!confirm("この認定情報を削除しますか？")) return;
    try {
      const { error } = await supabase
        .from("client_insurance_records")
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
                        {formatDate(rec.certification_start_date)} 〜 {formatDate(rec.certification_end_date)}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                          rec.care_level?.startsWith("要介護")
                            ? "bg-orange-100 text-orange-800"
                            : rec.care_level?.startsWith("要支援")
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-600"
                        }`}>
                          {rec.care_level ?? "—"}
                        </span>
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {formatDate(rec.certification_date)}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                        {formatDate(rec.certification_start_date)} 〜 {formatDate(rec.certification_end_date)}
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
            {isNew
              ? "介護認定 詳細（新規入力中）"
              : selectedId
              ? "介護認定 詳細"
              : "介護認定 詳細（レコードを選択してください）"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleNew}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 transition-colors"
            >
              <Plus size={11} />
              新規
            </button>
            <button
              onClick={handleSave}
              disabled={saving || (!selectedId && !isNew)}
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              <Save size={11} />
              {isNew ? "登録" : "保険変更"}
            </button>
            <button
              onClick={handleRenewal}
              disabled={saving || !selectedId || isNew}
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
    </div>
  );
}
