"use client";

import { useState, useCallback, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { municipalityName } from "@/lib/shogai-seikyu/municipalities";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Plus, Save, Trash2, X } from "lucide-react";
import type {
  ShougaiCertification,
  ShougaiSupportLevel,
  ShougaiPrimaryDisability,
  ShougaiProviderEntry,
  ShougaiShikyuryoDetails,
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

// 所得区分 (ほのぼのMORE のプルダウン相当)
const INCOME_CATEGORIES = [
  "生活保護",
  "低所得1",
  "低所得2",
  "一般1",
  "一般2",
] as const;

// 支給量の細分内訳 (ほのぼのMORE の支給量入力に対応)
//   kind: time = 時間+分 / count = 回 / units = 単位
const SHIKYURYO_ITEMS = [
  { key: "shintai", label: "身体介護中心", kind: "time" },
  { key: "jouko", label: "乗降介助中心", kind: "count" },
  { key: "kaji", label: "家事援助中心", kind: "time" },
  { key: "tsuuin", label: "通院介助中心", kind: "time" },
  { key: "tsuuin_shintai", label: "通院介助・身体あり", kind: "time" },
  { key: "doukou", label: "同行援護中心", kind: "time" },
  { key: "doukou_shintai", label: "同行援護・身体あり", kind: "time" },
  { key: "koudou", label: "行動援護中心", kind: "time" },
  { key: "juudo_houkatsu", label: "重度包括中心", kind: "units" },
  { key: "juudo_houmon_houkatsu", label: "重度訪問介護包括支援", kind: "time" },
  { key: "juudo_houmon_kubun6", label: "重度訪問介護区分6該当", kind: "time" },
  { key: "juudo_houmon_sonota", label: "重度訪問介護その他", kind: "time" },
  // 重度訪問介護の加算移動介護 (決定サービスコード 120901)。受給者証に別枠で載る
  { key: "idou", label: "移動介護 (重訪加算)", kind: "time" },
] as const;
// ⚠ キーを増やしたら migrations/_shikyuryo_keys.mjs の対応表も直すこと
//   (取込スクリプトは .mjs なのでこの定義を import できない)。
//   DB に入れるのは **ローマ字キー**。日本語は表示ラベルだけに使う
//   (全角「６」等の表記ゆれで引けなくなった前例あり → fix_shikyuryo_details_keys.mjs)。

// SQL 未適用 (42703) 時に payload から除外し、UI からも隠す列
const EXT_KEYS = [
  "issue_date",
  "is_applying",
  "income_category",
  "shafuku_genmen",
  "reduced_payment_limit",
  "municipality_defined_amount",
  "household_multi_jogen",
  "flag_rousha",
  "flag_h30_after",
  "flag_severe",
  "flag_short_multi",
  "flag_special_area",
  "provider_entries",
  "shikyuryo_details",
] as const;

// 事業者記入欄を常に 6 枠に正規化。string[] / {no,label,value}[] の両形式を許容。
function normalizeProviderEntries(
  pe: ShougaiProviderEntry[] | string[] | null | undefined,
): ShougaiProviderEntry[] {
  const base = Array.isArray(pe) ? pe : [];
  return Array.from({ length: 6 }, (_, i) => {
    const raw = base[i] as ShougaiProviderEntry | string | undefined;
    const value =
      typeof raw === "string" ? raw : (raw?.value ?? "");
    const label =
      typeof raw === "string" || !raw?.label ? `予備${i + 1}` : raw.label;
    return { no: i + 1, label, value };
  });
}

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
  self_payment_limit: null, // null = 未設定 / 0 = 負担0円 (低所得区分等)
  seiho_flag: false,
  soudan_office_name: null,
  soudan_manager_name: null,
  monthly_allocations: {},
  jogen_kanri_kubun: "なし",
  jogen_kanri_office_number: null,
  jogen_kanri_office_name: null,
  contract_amount_text: null,
  contract_start_date: null,
  contract_entry_number: null,
  holder_name_kana: null,
  issue_date: null,
  is_applying: false,
  income_category: null,
  shafuku_genmen: false,
  reduced_payment_limit: null,
  municipality_defined_amount: null,
  household_multi_jogen: false,
  flag_rousha: false,
  flag_h30_after: false,
  flag_severe: false,
  flag_short_multi: false,
  flag_special_area: false,
  provider_entries: normalizeProviderEntries(null),
  shikyuryo_details: {},
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
  // 拡張列 (ほのぼのMORE 相当) が DB に存在するか。SQL 未適用時は false → 該当欄を非表示。
  const [extAvailable, setExtAvailable] = useState<boolean>(
    initialRecords.length > 0 ? "issue_date" in initialRecords[0] : true,
  );
  // holder_name_kana は shougai_cert_holder_kana.sql で後から足した列。
  //   未適用の環境では payload から外す (= 従来どおり保存できる)。
  const [holderAvailable, setHolderAvailable] = useState<boolean>(
    initialRecords.length > 0 ? "holder_name_kana" in initialRecords[0] : true,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { error } = await supabase
        .from("shougai_certifications")
        .select("issue_date")
        .limit(1);
      if (cancelled) return;
      if (error) {
        // 42703 = undefined_column (列未追加) / 42P01・PGRST205 = table 未存在
        if (
          error.code === "42703" ||
          error.code === "42P01" ||
          error.code === "PGRST205"
        ) {
          setExtAvailable(false);
        }
      } else {
        setExtAvailable(true);
      }
      const { error: e2 } = await supabase
        .from("shougai_certifications")
        .select("holder_name_kana")
        .limit(1);
      if (cancelled) return;
      setHolderAvailable(!e2);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

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
      self_payment_limit: r.self_payment_limit ?? null, // null = 未設定を保持 (0 と区別)
      seiho_flag: r.seiho_flag ?? false,
      soudan_office_name: r.soudan_office_name ?? null,
      soudan_manager_name: r.soudan_manager_name ?? null,
      monthly_allocations: r.monthly_allocations ?? {},
      jogen_kanri_kubun: r.jogen_kanri_kubun ?? "なし",
      jogen_kanri_office_number: r.jogen_kanri_office_number ?? null,
      jogen_kanri_office_name: r.jogen_kanri_office_name ?? null,
      contract_amount_text: r.contract_amount_text ?? null,
      contract_start_date: r.contract_start_date ?? null,
      contract_entry_number: r.contract_entry_number ?? null,
      holder_name_kana: r.holder_name_kana ?? null,
      issue_date: r.issue_date ?? null,
      is_applying: r.is_applying ?? false,
      income_category: r.income_category ?? null,
      shafuku_genmen: r.shafuku_genmen ?? false,
      reduced_payment_limit: r.reduced_payment_limit ?? null,
      municipality_defined_amount: r.municipality_defined_amount ?? null,
      household_multi_jogen: r.household_multi_jogen ?? false,
      flag_rousha: r.flag_rousha ?? false,
      flag_h30_after: r.flag_h30_after ?? false,
      flag_severe: r.flag_severe ?? false,
      flag_short_multi: r.flag_short_multi ?? false,
      flag_special_area: r.flag_special_area ?? false,
      provider_entries: normalizeProviderEntries(r.provider_entries),
      shikyuryo_details: (r.shikyuryo_details ?? {}) as ShougaiShikyuryoDetails,
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
      // 42P01 / PGRST205 = table not exist (migration 未適用)
      if (error.code !== "42P01" && error.code !== "PGRST205") {
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
      // 事業者記入欄: 全 value 空なら null で保存 (DB を汚さない)
      const providerForSave =
        (form.provider_entries ?? []).some((e) => (e.value ?? "").trim())
          ? form.provider_entries
          : null;
      // 支給量内訳: 空 object なら null
      const shikyuryoForSave =
        form.shikyuryo_details &&
        Object.keys(form.shikyuryo_details).length > 0
          ? form.shikyuryo_details
          : null;

      const payload: Record<string, unknown> = {
        ...form,
        client_id: userId,
        beneficiary_number: form.beneficiary_number || null,
        insurer_municipality: form.insurer_municipality || null,
        jogen_kanri_office_number: form.jogen_kanri_office_number || null,
        jogen_kanri_office_name: form.jogen_kanri_office_name || null,
        contract_amount_text: form.contract_amount_text || null,
        contract_start_date: form.contract_start_date || null,
        contract_entry_number: form.contract_entry_number || null,
        holder_name_kana: form.holder_name_kana || null,
        issue_date: form.issue_date || null,
        income_category: form.income_category || null,
        reduced_payment_limit: form.reduced_payment_limit ?? null,
        municipality_defined_amount: form.municipality_defined_amount ?? null,
        provider_entries: providerForSave,
        shikyuryo_details: shikyuryoForSave,
        notes: form.notes || null,
      };
      // SQL 未適用環境では拡張列を除外 (= 従来通り保存できる)
      if (!holderAvailable) delete payload.holder_name_kana;
      if (!extAvailable) {
        for (const k of EXT_KEYS) delete payload[k];
      }
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

  // 支給量内訳の 1 フィールド更新 (空になった項目は削除)
  const updShikyuryo = (
    key: string,
    field: "hours" | "minutes" | "count" | "units",
    raw: string,
  ) => {
    setForm((f) => {
      const next: ShougaiShikyuryoDetails = { ...(f.shikyuryo_details ?? {}) };
      const item = { ...(next[key] ?? {}) };
      const n = raw === "" ? undefined : Number(raw);
      if (n === undefined || Number.isNaN(n)) delete item[field];
      else item[field] = n;
      if (Object.keys(item).length === 0) delete next[key];
      else next[key] = item;
      return { ...f, shikyuryo_details: next };
    });
  };

  // 事業者記入欄の value 更新
  const updProviderEntry = (idx: number, value: string) => {
    setForm((f) => {
      const entries = normalizeProviderEntries(f.provider_entries);
      entries[idx] = { ...entries[idx], value };
      return { ...f, provider_entries: entries };
    });
  };

  // 支給量内訳を表示用文字列に整形
  const fmtShikyuryo = (
    kind: "time" | "count" | "units",
    v: { hours?: number; minutes?: number; count?: number; units?: number },
  ): string => {
    if (kind === "time") {
      const h = v.hours ?? 0;
      const m = v.minutes ?? 0;
      if (!h && !m) return "";
      return `${h}時間${m ? `${m}分` : ""}`;
    }
    if (kind === "count") return v.count ? `${v.count}回` : "";
    return v.units ? `${v.units}単位` : "";
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
              {municipalityName(form.insurer_municipality) && (
                <span className="ml-2 text-gray-600">
                  {municipalityName(form.insurer_municipality)}
                </span>
              )}
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
              {form.self_payment_limit != null ? (
                `¥${form.self_payment_limit.toLocaleString()}${form.self_payment_limit === 0 ? " (負担0円)" : ""}`
              ) : (
                <span className="text-amber-600">未設定</span>
              )}
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
          <FieldRow label="上限額管理">
            <span className="text-sm text-gray-900">
              {form.jogen_kanri_kubun}
              {form.jogen_kanri_kubun === "他事業所" && form.jogen_kanri_office_name
                ? ` — ${form.jogen_kanri_office_name}${form.jogen_kanri_office_number ? ` (${form.jogen_kanri_office_number})` : ""}`
                : ""}
            </span>
          </FieldRow>
          {/* 契約支給量・事業者記入欄は下の「契約支給量 (事業者記入欄)」カード
              (shogai_contracts) に集約した。ここの列は 0〜33 件しか埋まっておらず
              伝送にも出ていない旧フィールドなので、値がある場合だけ参考表示する */}
          {form.contract_amount_text && (
            <FieldRow label="契約支給量 (旧・自由記述)">
              <span className="text-sm text-gray-500">
                {form.contract_amount_text}
                <span className="ml-2 text-xs">※ 下の契約支給量カードが正</span>
              </span>
            </FieldRow>
          )}
          {extAvailable && (
            <>
              <FieldRow label="交付年月日">
                <span className="text-sm text-gray-900">
                  {fmtDate(form.issue_date)}
                  {form.is_applying ? (
                    <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 ring-1 ring-amber-200">
                      申請中
                    </span>
                  ) : null}
                </span>
              </FieldRow>
              <FieldRow label="所得区分">
                <span className="text-sm text-gray-900">
                  {form.income_category || "—"}
                </span>
              </FieldRow>
              <FieldRow label="社福減免後上限月額">
                <span className="text-sm text-gray-900">
                  {form.shafuku_genmen ? "社福減免あり" : "—"}
                  {form.reduced_payment_limit != null
                    ? ` / ¥${form.reduced_payment_limit.toLocaleString()}`
                    : ""}
                </span>
              </FieldRow>
              <FieldRow label="市町村が定める額">
                <span className="text-sm text-gray-900">
                  {form.municipality_defined_amount != null
                    ? `¥${form.municipality_defined_amount.toLocaleString()}`
                    : "—"}
                </span>
              </FieldRow>
              <div className="lg:col-span-2">
                <FieldRow label="該当区分・フラグ">
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      form.household_multi_jogen && "同一世帯 複数上限管理",
                      form.flag_rousha && "聾者",
                      form.flag_h30_after && "H30.4以降支給決定",
                      form.flag_severe && "著しく重度の者",
                      form.flag_short_multi && "短時間複数訪問",
                      form.flag_special_area && "特別地域加算",
                    ]
                      .filter(Boolean)
                      .map((t) => (
                        <span
                          key={t as string}
                          className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700"
                        >
                          {t}
                        </span>
                      ))}
                    {![
                      form.household_multi_jogen,
                      form.flag_rousha,
                      form.flag_h30_after,
                      form.flag_severe,
                      form.flag_short_multi,
                      form.flag_special_area,
                    ].some(Boolean) && (
                      <span className="text-sm text-gray-500">—</span>
                    )}
                  </div>
                </FieldRow>
              </div>
              <div className="lg:col-span-2">
                <FieldRow label="支給量 (時間/回/単位)">
                  <div className="flex flex-wrap gap-2 text-sm">
                    {(() => {
                      const shown = SHIKYURYO_ITEMS.map((it) => ({
                        it,
                        txt: fmtShikyuryo(
                          it.kind,
                          (form.shikyuryo_details ?? {})[it.key] ?? {},
                        ),
                      })).filter((x) => x.txt);
                      if (shown.length === 0)
                        return <span className="text-gray-500">—</span>;
                      return shown.map(({ it, txt }) => (
                        <span
                          key={it.key}
                          className="rounded bg-indigo-50 px-2 py-0.5 text-xs ring-1 ring-indigo-200"
                        >
                          {it.label}: {txt}
                        </span>
                      ));
                    })()}
                  </div>
                </FieldRow>
              </div>
              {/* 事業者記入欄は下の「契約支給量 (事業者記入欄)」カード (shogai_contracts) が正。
                  この自由記述 6 枠は 576 件すべて空で伝送にも出ていないため、
                  値が入っている場合だけ残骸として見せる */}
              {normalizeProviderEntries(form.provider_entries).some((e) =>
                (e.value ?? "").trim(),
              ) && (
                <div className="lg:col-span-2">
                  <FieldRow label="事業者記入欄 (旧・自由記述)">
                    <div className="flex flex-wrap gap-2 text-sm">
                      {normalizeProviderEntries(form.provider_entries)
                        .filter((e) => (e.value ?? "").trim())
                        .map((e) => (
                          <span
                            key={e.no}
                            className="rounded bg-gray-50 px-2 py-0.5 text-xs text-gray-500 ring-1 ring-gray-200"
                          >
                            {e.label}: {e.value}
                          </span>
                        ))}
                      <span className="text-xs text-gray-400">※ 下の契約支給量カードが正</span>
                    </div>
                  </FieldRow>
                </div>
              )}
            </>
          )}
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
            {/* 番号を打ち間違えたら名称が出ないので、その場で気づける */}
            <span className="ml-2 text-sm text-gray-600">
              {municipalityName(form.insurer_municipality) ??
                (form.insurer_municipality ? "（未登録の市町村番号）" : "")}
            </span>
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
            <div className="space-y-0.5">
              <input
                type="number"
                min={0}
                value={form.self_payment_limit ?? ""}
                onChange={(e) =>
                  upd(
                    "self_payment_limit",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                placeholder="未設定"
                className={`${inputCls} w-32 text-right`}
              />
              <p className="text-[10px] text-gray-400">
                0 = 負担0円 (低所得区分等) / 空欄 = 未設定。請求計算は 0 でも上限として適用されます
              </p>
            </div>
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
          <FieldRow label="上限額管理">
            <div className="space-y-1.5">
              <div className="flex gap-1">
                {(["なし", "自事業所", "他事業所"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => upd("jogen_kanri_kubun", k)}
                    className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                      form.jogen_kanri_kubun === k
                        ? "border-violet-500 bg-violet-50 text-violet-700"
                        : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              {form.jogen_kanri_kubun === "他事業所" && (
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="text"
                    value={form.jogen_kanri_office_number ?? ""}
                    onChange={(e) => upd("jogen_kanri_office_number", e.target.value || null)}
                    placeholder="管理事業所番号 (10桁)"
                    className={`${inputCls} w-full`}
                  />
                  <input
                    type="text"
                    value={form.jogen_kanri_office_name ?? ""}
                    onChange={(e) => upd("jogen_kanri_office_name", e.target.value || null)}
                    placeholder="管理事業所名"
                    className={`${inputCls} w-full`}
                  />
                </div>
              )}
              <p className="text-[10px] text-gray-400">
                月次の管理結果 (区分 1/2/3) は 請求業務 → 障害請求 の明細で入力します
              </p>
            </div>
          </FieldRow>
          <FieldRow label="契約支給量 (記入欄)">
            <div className="space-y-1.5">
              <input
                type="text"
                value={form.contract_amount_text ?? ""}
                onChange={(e) => upd("contract_amount_text", e.target.value || null)}
                placeholder="例: 身体介護 10時間/月"
                className={`${inputCls} w-full`}
              />
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  type="date"
                  value={form.contract_start_date ?? ""}
                  onChange={(e) => upd("contract_start_date", e.target.value || null)}
                  className={`${inputCls} w-full`}
                  title="契約開始日"
                />
                <input
                  type="text"
                  value={form.contract_entry_number ?? ""}
                  onChange={(e) => upd("contract_entry_number", e.target.value || null)}
                  placeholder="記入欄番号"
                  className={`${inputCls} w-full`}
                />
              </div>
              {holderAvailable && (
                <div className="space-y-1 border-t border-gray-200 pt-1.5">
                  <input
                    type="text"
                    value={form.holder_name_kana ?? ""}
                    onChange={(e) => upd("holder_name_kana", e.target.value || null)}
                    placeholder="支給決定者(保護者)カナ — 障害児のみ"
                    className={`${inputCls} w-full`}
                  />
                  <p className="text-xs text-gray-500">
                    <b>障害児のときだけ</b>保護者のカナを入れます。入れると明細書の
                    支給決定者氏名カナが保護者・支給決定児童氏名カナが本人になります
                    (成人は空のままで本人が出ます)。
                  </p>
                </div>
              )}
              <p className="text-xs text-amber-700">
                受給者証の「事業者記入欄」= <b>当事業所との契約内容</b>を転記します。
                上の支給量 (市町村の支給決定量) とは別で、他事業所と分け合う場合は
                その一部になります。国保連伝送の契約情報レコード (契約支給量・契約開始日・
                事業者記入欄番号) に出るため、<b>契約開始日が空だと受給者証の値で代替</b>され、
                伝送時に警告が出ます。
              </p>
            </div>
          </FieldRow>
          {extAvailable && (
            <>
              <FieldRow label="交付年月日">
                <div className="flex items-center gap-3">
                  <input
                    type="date"
                    value={form.issue_date ?? ""}
                    onChange={(e) => upd("issue_date", e.target.value || null)}
                    className={inputCls}
                  />
                  <label className="inline-flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={form.is_applying}
                      onChange={(e) => upd("is_applying", e.target.checked)}
                      className="accent-violet-600"
                    />
                    申請中
                  </label>
                </div>
              </FieldRow>
              <FieldRow label="所得区分">
                <select
                  value={form.income_category ?? ""}
                  onChange={(e) =>
                    upd("income_category", e.target.value || null)
                  }
                  className={`${inputCls} w-40`}
                >
                  <option value="">未選択</option>
                  {INCOME_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </FieldRow>
              <FieldRow label="社福減免 / 軽減後上限月額 (円)">
                <div className="space-y-1.5">
                  <label className="inline-flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={form.shafuku_genmen}
                      onChange={(e) => upd("shafuku_genmen", e.target.checked)}
                      className="accent-violet-600"
                    />
                    社会福祉法人減免
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={form.reduced_payment_limit ?? ""}
                    onChange={(e) =>
                      upd(
                        "reduced_payment_limit",
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                    placeholder="軽減後上限月額"
                    className={`${inputCls} w-32 text-right`}
                  />
                </div>
              </FieldRow>
              <FieldRow label="市町村が定める額 (円)">
                <input
                  type="number"
                  min={0}
                  value={form.municipality_defined_amount ?? ""}
                  onChange={(e) =>
                    upd(
                      "municipality_defined_amount",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  className={`${inputCls} w-32 text-right`}
                />
              </FieldRow>
              <div className="lg:col-span-2">
                <FieldRow label="該当区分・フラグ">
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {(
                      [
                        ["household_multi_jogen", "同一世帯で複数上限管理"],
                        ["flag_rousha", "聾者"],
                        ["flag_h30_after", "H30.4以降支給決定"],
                        ["flag_severe", "著しく重度の者"],
                        ["flag_short_multi", "短時間複数訪問"],
                        ["flag_special_area", "特別地域加算"],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-1.5 rounded border border-gray-200 px-2 py-1.5 text-xs hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={form[key]}
                          onChange={(e) => upd(key, e.target.checked)}
                          className="accent-violet-600"
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-amber-600">
                    ※ 特別地域加算 を ON にすると請求に加算が反映されます
                  </p>
                </FieldRow>
              </div>
              <div className="lg:col-span-2">
                <FieldRow label="支給量 (時間/回/単位)">
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {SHIKYURYO_ITEMS.map((it) => {
                      const v =
                        (form.shikyuryo_details ?? {})[it.key] ?? {};
                      return (
                        <div
                          key={it.key}
                          className="flex items-center gap-1.5"
                        >
                          <span className="min-w-[150px] text-xs text-gray-600">
                            {it.label}
                          </span>
                          {it.kind === "time" ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                value={v.hours ?? ""}
                                onChange={(e) =>
                                  updShikyuryo(it.key, "hours", e.target.value)
                                }
                                className={`${inputCls} w-16 text-right`}
                              />
                              <span className="text-xs text-gray-500">時間</span>
                              <input
                                type="number"
                                min={0}
                                max={59}
                                value={v.minutes ?? ""}
                                onChange={(e) =>
                                  updShikyuryo(it.key, "minutes", e.target.value)
                                }
                                className={`${inputCls} w-16 text-right`}
                              />
                              <span className="text-xs text-gray-500">分</span>
                            </div>
                          ) : it.kind === "count" ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                value={v.count ?? ""}
                                onChange={(e) =>
                                  updShikyuryo(it.key, "count", e.target.value)
                                }
                                className={`${inputCls} w-16 text-right`}
                              />
                              <span className="text-xs text-gray-500">回</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                value={v.units ?? ""}
                                onChange={(e) =>
                                  updShikyuryo(it.key, "units", e.target.value)
                                }
                                className={`${inputCls} w-20 text-right`}
                              />
                              <span className="text-xs text-gray-500">単位</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </FieldRow>
              </div>
              <div className="lg:col-span-2">
                <FieldRow label="事業者記入欄 (予備1〜6)">
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {normalizeProviderEntries(form.provider_entries).map(
                      (e, idx) => (
                        <div key={e.no} className="flex items-center gap-1.5">
                          <span className="min-w-[52px] text-xs text-gray-600">
                            {e.label}
                          </span>
                          <input
                            type="text"
                            value={e.value}
                            onChange={(ev) =>
                              updProviderEntry(idx, ev.target.value)
                            }
                            className={`${inputCls} w-full`}
                          />
                        </div>
                      ),
                    )}
                  </div>
                </FieldRow>
              </div>
            </>
          )}
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
