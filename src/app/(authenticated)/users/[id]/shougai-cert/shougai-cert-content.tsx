"use client";

import { useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Save, Trash2, X } from "lucide-react";
import type {
  ShougaiCertification,
  ShougaiSupportLevel,
  ShougaiPrimaryDisability,
} from "@/types/database";

// ─── マスタ値 ─────────────────────────────────────────────────────────────────

const SUPPORT_LEVELS: ShougaiSupportLevel[] = [
  "区分1",
  "区分2",
  "区分3",
  "区分4",
  "区分5",
  "区分6",
  "非該当",
];

const PRIMARY_DISABILITIES: ShougaiPrimaryDisability[] = [
  "身体障害",
  "知的障害",
  "精神障害",
  "発達障害",
  "難病",
  "重複障害",
];

// 支給決定サービス (= 受給者証に記載される支給決定済サービス)
// 障害福祉サービスの主要種別。チェックボックスで複数選択。
const SERVICE_TYPE_OPTIONS = [
  "居宅介護",
  "重度訪問介護",
  "行動援護",
  "同行援護",
  "重度障害者等包括支援",
  "短期入所",
  "療養介護",
  "生活介護",
  "施設入所支援",
  "自立訓練",
  "就労移行支援",
  "就労継続支援A型",
  "就労継続支援B型",
  "共同生活援助",
] as const;

type FormData = Omit<
  ShougaiCertification,
  "id" | "client_id" | "tenant_id" | "created_at" | "updated_at"
>;

const EMPTY_FORM: FormData = {
  support_level: "区分1",
  primary_disability: null,
  certification_start_date: format(new Date(), "yyyy-MM-dd"),
  certification_end_date: "",
  beneficiary_number: "",
  insurer_municipality: "",
  service_types: [],
  copay_rate: 0.1,
  self_payment_limit: 0,
  seiho_flag: false,
  soudan_office_name: null,
  soudan_manager_name: null,
  monthly_allocations: {},
  notes: "",
};

const inputCls =
  "rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function FieldRow({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start gap-2 py-2">
      <span className="pt-1 text-xs text-gray-600">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      <div>{children}</div>
    </div>
  );
}

// ─── メインコンポーネント ─────────────────────────────────────────────────────

export function ShougaiCertContent({
  userId,
  initialRecords,
}: {
  userId: string;
  initialRecords: ShougaiCertification[];
}) {
  const supabase = createClient();

  const [records, setRecords] = useState<ShougaiCertification[]>(initialRecords);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialRecords.length > 0 ? initialRecords[0].id : null,
  );
  const [form, setForm] = useState<FormData>(
    initialRecords.length > 0 ? recordToForm(initialRecords[0]) : EMPTY_FORM,
  );
  const [editing, setEditing] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);

  function recordToForm(r: ShougaiCertification): FormData {
    return {
      support_level: r.support_level,
      primary_disability: r.primary_disability,
      certification_start_date: r.certification_start_date,
      certification_end_date: r.certification_end_date,
      beneficiary_number: r.beneficiary_number ?? "",
      insurer_municipality: r.insurer_municipality ?? "",
      service_types: Array.isArray(r.service_types) ? r.service_types : [],
      copay_rate: r.copay_rate ?? 0.1,
      self_payment_limit: r.self_payment_limit ?? 0,
      seiho_flag: r.seiho_flag ?? false,
      soudan_office_name: r.soudan_office_name ?? null,
      soudan_manager_name: r.soudan_manager_name ?? null,
      monthly_allocations: r.monthly_allocations ?? {},
      notes: r.notes ?? "",
    };
  }

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("shougai_certifications")
      .select("*")
      .eq("client_id", userId)
      .order("certification_start_date", { ascending: false, nullsFirst: false });
    if (error) {
      // 42P01 = table not exist (migration 未適用)
      if (error.code !== "42P01") {
        toast.error("読み込み失敗: " + error.message);
      }
      return;
    }
    const list = (data ?? []) as ShougaiCertification[];
    setRecords(list);
    if (list.length > 0) {
      setSelectedId(list[0].id);
      setForm(recordToForm(list[0]));
    } else {
      setSelectedId(null);
      setForm(EMPTY_FORM);
    }
    setIsNew(false);
    setEditing(false);
  }, [supabase, userId]);

  const handleSelectRecord = (id: string) => {
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    setSelectedId(id);
    setForm(recordToForm(rec));
    setIsNew(false);
    setEditing(false);
  };

  const handleNew = () => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setIsNew(true);
    setEditing(true);
  };

  const handleEdit = () => {
    if (!selectedId) return;
    setEditing(true);
  };

  const handleCancel = () => {
    if (isNew) {
      setIsNew(false);
      if (records.length > 0) {
        setSelectedId(records[0].id);
        setForm(recordToForm(records[0]));
      } else {
        setForm(EMPTY_FORM);
      }
    } else if (selectedId) {
      const rec = records.find((r) => r.id === selectedId);
      if (rec) setForm(recordToForm(rec));
    }
    setEditing(false);
  };

  const handleSave = async () => {
    if (!form.certification_start_date) {
      toast.error("認定開始日は必須です");
      return;
    }
    if (!form.certification_end_date) {
      toast.error("認定終了日は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        client_id: userId,
        beneficiary_number: form.beneficiary_number || null,
        insurer_municipality: form.insurer_municipality || null,
        notes: form.notes || null,
      };
      if (selectedId && !isNew) {
        const { error } = await supabase
          .from("shougai_certifications")
          .update(payload)
          .eq("id", selectedId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("shougai_certifications")
          .insert(payload);
        if (error) throw error;
        toast.success("登録しました");
      }
      await load();
    } catch (err: unknown) {
      toast.error(
        "保存失敗: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!confirm("この認定情報を削除します。よろしいですか？")) return;
    const { error } = await supabase
      .from("shougai_certifications")
      .delete()
      .eq("id", selectedId);
    if (error) {
      toast.error("削除失敗: " + error.message);
      return;
    }
    toast.success("削除しました");
    await load();
  };

  // ─── 部分更新ヘルパー ────────────────────────────────────────────────────
  const upd = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleServiceType = (st: string) => {
    setForm((f) => {
      const has = f.service_types.includes(st);
      return {
        ...f,
        service_types: has
          ? f.service_types.filter((s) => s !== st)
          : [...f.service_types, st],
      };
    });
  };

  const fmtDate = (d: string | null): string =>
    d ? format(parseISO(d), "yyyy/MM/dd") : "—";

  return (
    <div className="rounded-b-lg border border-t-0 bg-white p-6 shadow-sm space-y-4">
      {/* ─── ツールバー ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <h2 className="text-base font-semibold text-gray-800">
          障害支援区分 (受給者証)
        </h2>
        <div className="flex items-center gap-2">
          {!editing ? (
            <>
              {records.length > 0 && (
                <select
                  value={selectedId ?? ""}
                  onChange={(e) => handleSelectRecord(e.target.value)}
                  className={`${inputCls} min-w-[260px]`}
                >
                  {records.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.support_level} / {fmtDate(r.certification_start_date)} ~{" "}
                      {fmtDate(r.certification_end_date)}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={handleNew}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
              >
                <Plus size={14} /> 新規
              </button>
              {selectedId && (
                <>
                  <button
                    onClick={handleEdit}
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    編集
                  </button>
                  <button
                    onClick={handleDelete}
                    className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
                  >
                    <Trash2 size={14} /> 削除
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                onClick={handleCancel}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <X size={14} /> キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Save size={14} /> 保存
              </button>
            </>
          )}
        </div>
      </div>

      {/* ─── 本体: 表示モード or 編集モード ───────────────────────────── */}
      {records.length === 0 && !editing ? (
        <div className="py-12 text-center text-sm text-gray-500">
          障害支援区分の登録がありません。
          <button
            onClick={handleNew}
            className="ml-2 text-blue-600 hover:underline"
          >
            新規登録する
          </button>
        </div>
      ) : !editing && selectedId ? (
        // 表示モード
        <div className="grid grid-cols-1 gap-y-1 lg:grid-cols-2 lg:gap-x-8">
          <FieldRow label="障害支援区分">
            <span className="text-sm font-semibold text-violet-700">
              {form.support_level}
            </span>
          </FieldRow>
          <FieldRow label="主たる障害">
            <span className="text-sm text-gray-900">
              {form.primary_disability ?? "—"}
            </span>
          </FieldRow>
          <FieldRow label="受給者証番号">
            <span className="text-sm text-gray-900">
              {form.beneficiary_number || "—"}
            </span>
          </FieldRow>
          <FieldRow label="支給決定市町村">
            <span className="text-sm text-gray-900">
              {form.insurer_municipality || "—"}
            </span>
          </FieldRow>
          <FieldRow label="認定有効期間">
            <span className="text-sm text-gray-900">
              {fmtDate(form.certification_start_date)} 〜{" "}
              {fmtDate(form.certification_end_date)}
            </span>
          </FieldRow>
          <FieldRow label="自己負担割合">
            <span className="text-sm text-gray-900">
              {form.copay_rate != null
                ? `${(form.copay_rate * 100).toFixed(0)}%`
                : "—"}
            </span>
          </FieldRow>
          <FieldRow label="自己負担月額上限">
            <span className="text-sm text-gray-900">
              {form.self_payment_limit
                ? `¥${form.self_payment_limit.toLocaleString()}`
                : "—"}
            </span>
          </FieldRow>
          <FieldRow label="生保受給">
            <span className="text-sm text-gray-900">
              {form.seiho_flag ? "あり" : "—"}
            </span>
          </FieldRow>
          <FieldRow label="相談支援事業所">
            <span className="text-sm text-gray-900">
              {form.soudan_office_name || "—"}
            </span>
          </FieldRow>
          <FieldRow label="相談支援専門員">
            <span className="text-sm text-gray-900">
              {form.soudan_manager_name || "—"}
            </span>
          </FieldRow>
          <div className="lg:col-span-2">
            <FieldRow label="月間支給量 (単位数/月)">
              <div className="flex flex-wrap gap-2 text-sm">
                {Object.keys(form.monthly_allocations ?? {}).length === 0 ? (
                  <span className="text-gray-500">—</span>
                ) : (
                  Object.entries(form.monthly_allocations ?? {}).map(
                    ([st, n]) => (
                      <span
                        key={st}
                        className="rounded bg-sky-50 px-2 py-0.5 text-xs ring-1 ring-sky-200"
                      >
                        {st}: {n.toLocaleString()}
                      </span>
                    ),
                  )
                )}
              </div>
            </FieldRow>
          </div>
          <div className="lg:col-span-2">
            <FieldRow label="利用中サービス種別">
              <div className="flex flex-wrap gap-1.5">
                {form.service_types.length === 0 ? (
                  <span className="text-sm text-gray-500">—</span>
                ) : (
                  form.service_types.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700"
                    >
                      {s}
                    </span>
                  ))
                )}
              </div>
            </FieldRow>
          </div>
          <div className="lg:col-span-2">
            <FieldRow label="備考">
              <span className="block whitespace-pre-wrap text-sm text-gray-700">
                {form.notes || "—"}
              </span>
            </FieldRow>
          </div>
        </div>
      ) : (
        // 編集モード
        <div className="grid grid-cols-1 gap-y-1 lg:grid-cols-2 lg:gap-x-8">
          <FieldRow label="障害支援区分" required>
            <select
              value={form.support_level}
              onChange={(e) =>
                upd("support_level", e.target.value as ShougaiSupportLevel)
              }
              className={`${inputCls} w-40`}
            >
              {SUPPORT_LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {lv}
                </option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="主たる障害">
            <select
              value={form.primary_disability ?? ""}
              onChange={(e) =>
                upd(
                  "primary_disability",
                  e.target.value === ""
                    ? null
                    : (e.target.value as ShougaiPrimaryDisability),
                )
              }
              className={`${inputCls} w-40`}
            >
              <option value="">未選択</option>
              {PRIMARY_DISABILITIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="受給者証番号">
            <input
              type="text"
              value={form.beneficiary_number ?? ""}
              onChange={(e) => upd("beneficiary_number", e.target.value)}
              className={`${inputCls} w-48`}
            />
          </FieldRow>
          <FieldRow label="支給決定市町村">
            <input
              type="text"
              value={form.insurer_municipality ?? ""}
              onChange={(e) => upd("insurer_municipality", e.target.value)}
              className={`${inputCls} w-full max-w-xs`}
            />
          </FieldRow>
          <FieldRow label="認定開始日" required>
            <input
              type="date"
              value={form.certification_start_date ?? ""}
              onChange={(e) => upd("certification_start_date", e.target.value)}
              className={inputCls}
            />
          </FieldRow>
          <FieldRow label="認定終了日" required>
            <input
              type="date"
              value={form.certification_end_date ?? ""}
              onChange={(e) => upd("certification_end_date", e.target.value)}
              className={inputCls}
            />
          </FieldRow>
          <FieldRow label="自己負担割合">
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={form.copay_rate ?? 0}
                onChange={(e) =>
                  upd("copay_rate", Number(e.target.value || 0))
                }
                className={`${inputCls} w-24 text-right`}
              />
              <span className="text-xs text-gray-500">
                (= {((form.copay_rate ?? 0) * 100).toFixed(0)}%)
              </span>
            </div>
          </FieldRow>
          <FieldRow label="自己負担月額上限 (円)">
            <input
              type="number"
              min={0}
              value={form.self_payment_limit ?? 0}
              onChange={(e) =>
                upd("self_payment_limit", Number(e.target.value || 0))
              }
              className={`${inputCls} w-32 text-right`}
            />
          </FieldRow>
          <FieldRow label="生保受給">
            <label className="inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={form.seiho_flag}
                onChange={(e) => upd("seiho_flag", e.target.checked)}
                className="accent-violet-600"
              />
              生保連携あり (自己負担 0 円扱い)
            </label>
          </FieldRow>
          <FieldRow label="相談支援事業所">
            <input
              type="text"
              value={form.soudan_office_name ?? ""}
              onChange={(e) =>
                upd("soudan_office_name", e.target.value || null)
              }
              className={`${inputCls} w-full`}
            />
          </FieldRow>
          <FieldRow label="相談支援専門員">
            <input
              type="text"
              value={form.soudan_manager_name ?? ""}
              onChange={(e) =>
                upd("soudan_manager_name", e.target.value || null)
              }
              className={`${inputCls} w-full`}
            />
          </FieldRow>
          <div className="lg:col-span-2">
            <FieldRow label="月間支給量 (サービス種別ごと、単位数)">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(["居宅介護", "重度訪問介護", "行動援護", "同行援護"] as const).map(
                  (st) => (
                    <div key={st} className="flex items-center gap-1">
                      <span className="text-xs text-gray-600 min-w-[80px]">
                        {st}
                      </span>
                      <input
                        type="number"
                        min={0}
                        value={form.monthly_allocations?.[st] ?? 0}
                        onChange={(e) => {
                          const next = { ...(form.monthly_allocations ?? {}) };
                          const n = Number(e.target.value || 0);
                          if (n > 0) next[st] = n;
                          else delete next[st];
                          upd("monthly_allocations", next);
                        }}
                        className={`${inputCls} w-full text-right`}
                      />
                    </div>
                  ),
                )}
              </div>
            </FieldRow>
          </div>
          <div className="lg:col-span-2">
            <FieldRow label="利用中サービス種別">
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {SERVICE_TYPE_OPTIONS.map((st) => {
                  const checked = form.service_types.includes(st);
                  return (
                    <label
                      key={st}
                      className="flex cursor-pointer items-center gap-1.5 rounded border border-gray-200 px-2 py-1.5 text-xs hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleServiceType(st)}
                        className="accent-violet-600"
                      />
                      <span>{st}</span>
                    </label>
                  );
                })}
              </div>
            </FieldRow>
          </div>
          <div className="lg:col-span-2">
            <FieldRow label="備考">
              <textarea
                value={form.notes ?? ""}
                onChange={(e) => upd("notes", e.target.value)}
                rows={3}
                className={`${inputCls} w-full`}
              />
            </FieldRow>
          </div>
        </div>
      )}
    </div>
  );
}
