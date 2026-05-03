"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { ChevronLeft, Save } from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";
import { getMaxUserNumber } from "@kt/shared/user-number";

// FormData は kaigo-app UI 入力用の中間型。DB カラム名（共通 clients）にマッピングして INSERT。
//   name_kana    → clients.furigana
//   mobile_phone → clients.mobile
//   notes        → client_memos.body (scope='tenant')
type FormData = {
  name: string;
  name_kana: string;
  gender: "男" | "女";
  birth_date: string;
  blood_type: string;
  postal_code: string;
  address: string;
  phone: string;
  mobile_phone: string;
  email: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  admission_date: string;
  notes: string;
};

const INITIAL_FORM: FormData = {
  name: "",
  name_kana: "",
  gender: "女",
  birth_date: "",
  blood_type: "",
  postal_code: "",
  address: "",
  phone: "",
  mobile_phone: "",
  email: "",
  emergency_contact_name: "",
  emergency_contact_phone: "",
  admission_date: "",
  notes: "",
};

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

export default function NewUserPage() {
  const router = useRouter();
  const supabase = createClient();
  const { currentOffice } = useBusinessType();
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);

  const set = (field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("氏名は必須です");
      return;
    }
    if (!form.name_kana.trim()) {
      toast.error("氏名（かな）は必須です");
      return;
    }
    if (!form.birth_date) {
      toast.error("生年月日は必須です");
      return;
    }
    if (!currentOffice?.tenant_id) {
      toast.error("自事業所が選択されていません。サイドバーの事業所セレクタで選択してください。");
      return;
    }

    setSaving(true);
    try {
      // user_number 採番（tenant 単位 max+1）。@kt/shared 共通 util。
      // 共通マスタ clients は order-app 由来で user_number が NOT NULL のため必須。
      const userNumber = String((await getMaxUserNumber(supabase, currentOffice.tenant_id)) + 1);

      // 共通マスタ clients への INSERT（旧 kaigo_users から張替え）
      // カラム名対応: name_kana → furigana, mobile_phone → mobile
      const payload = {
        tenant_id: currentOffice.tenant_id,
        user_number: userNumber,
        name: form.name.trim(),
        furigana: form.name_kana.trim(),
        gender: form.gender,
        birth_date: form.birth_date,
        blood_type: form.blood_type || null,
        postal_code: form.postal_code || null,
        address: form.address || null,
        phone: form.phone || null,
        mobile: form.mobile_phone || null,
        email: form.email || null,
        emergency_contact_name: form.emergency_contact_name || null,
        emergency_contact_phone: form.emergency_contact_phone || null,
        admission_date: form.admission_date || null,
        status: "active",
        is_facility: false,
        is_provisional: false,
      };

      const { data, error } = await supabase
        .from("clients")
        .insert(payload)
        .select("id")
        .single();

      if (error) throw error;

      // 備考は client_memos へ scope='tenant' で別 INSERT
      if (form.notes.trim()) {
        const { error: memoErr } = await supabase
          .from("client_memos")
          .insert({
            client_id: data.id,
            scope: "tenant",
            tenant_id: currentOffice.tenant_id,
            body: form.notes.trim(),
          });
        if (memoErr) {
          console.warn("備考の保存に失敗:", memoErr);
          toast.warning("利用者は登録されましたが、備考の保存に失敗しました");
        }
      }

      toast.success("利用者を登録しました");
      router.push(`/users/${data.id}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "登録に失敗しました";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/users"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft size={16} />
          利用者一覧
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">利用者新規登録</h1>
        <p className="mt-1 text-sm text-gray-500">
          新しい利用者の基本情報を入力してください
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 基本情報 */}
        <section className="rounded-lg border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-base font-semibold text-gray-800 border-b pb-2">
            基本情報
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="氏名" required>
              <input
                type="text"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="山田 花子"
                className={inputClass}
                required
              />
            </FormField>
            <FormField label="氏名（かな）" required>
              <input
                type="text"
                value={form.name_kana}
                onChange={(e) => set("name_kana", e.target.value)}
                placeholder="やまだ はなこ"
                className={inputClass}
                required
              />
            </FormField>
            <FormField label="性別" required>
              <select
                value={form.gender}
                onChange={(e) => set("gender", e.target.value)}
                className={inputClass}
                required
              >
                <option value="女">女</option>
                <option value="男">男</option>
              </select>
            </FormField>
            <FormField label="生年月日" required>
              <input
                type="date"
                value={form.birth_date}
                onChange={(e) => set("birth_date", e.target.value)}
                className={inputClass}
                required
              />
            </FormField>
            <FormField label="血液型">
              <select
                value={form.blood_type}
                onChange={(e) => set("blood_type", e.target.value)}
                className={inputClass}
              >
                <option value="">不明</option>
                <option value="A">A型</option>
                <option value="B">B型</option>
                <option value="O">O型</option>
                <option value="AB">AB型</option>
              </select>
            </FormField>
            <FormField label="入所日">
              <input
                type="date"
                value={form.admission_date}
                onChange={(e) => set("admission_date", e.target.value)}
                className={inputClass}
              />
            </FormField>
          </div>
        </section>

        {/* 連絡先 */}
        <section className="rounded-lg border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-base font-semibold text-gray-800 border-b pb-2">
            連絡先・住所
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="郵便番号">
              <input
                type="text"
                value={form.postal_code}
                onChange={(e) => set("postal_code", e.target.value)}
                placeholder="123-4567"
                className={inputClass}
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="住所">
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  placeholder="東京都新宿区..."
                  className={inputClass}
                />
              </FormField>
            </div>
            <FormField label="電話番号">
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="03-1234-5678"
                className={inputClass}
              />
            </FormField>
            <FormField label="携帯電話">
              <input
                type="tel"
                value={form.mobile_phone}
                onChange={(e) => set("mobile_phone", e.target.value)}
                placeholder="090-1234-5678"
                className={inputClass}
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="メールアドレス">
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="example@mail.com"
                  className={inputClass}
                />
              </FormField>
            </div>
          </div>
        </section>

        {/* 緊急連絡先 */}
        <section className="rounded-lg border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-base font-semibold text-gray-800 border-b pb-2">
            緊急連絡先
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="緊急連絡先氏名">
              <input
                type="text"
                value={form.emergency_contact_name}
                onChange={(e) => set("emergency_contact_name", e.target.value)}
                placeholder="山田 太郎"
                className={inputClass}
              />
            </FormField>
            <FormField label="緊急連絡先電話番号">
              <input
                type="tel"
                value={form.emergency_contact_phone}
                onChange={(e) =>
                  set("emergency_contact_phone", e.target.value)
                }
                placeholder="090-1234-5678"
                className={inputClass}
              />
            </FormField>
          </div>
        </section>

        {/* 備考 */}
        <section className="rounded-lg border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-base font-semibold text-gray-800 border-b pb-2">
            備考
          </h2>
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={4}
            placeholder="特記事項があれば入力してください"
            className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
          />
        </section>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pb-6">
          <Link
            href="/users"
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            キャンセル
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Save size={16} />
            {saving ? "保存中..." : "登録する"}
          </button>
        </div>
      </form>
    </div>
  );
}
