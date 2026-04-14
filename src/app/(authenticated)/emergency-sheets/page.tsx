"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  AlertTriangle,
  Save,
  Loader2,
  User,
  Phone,
  Hospital,
  Pill,
  Heart,
  FileText,
  Printer,
  Link2,
  Copy,
  X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmergencySheet {
  id?: string;
  user_id: string;
  blood_type: string;
  allergies: string;
  doctor_name: string;
  doctor_hospital: string;
  doctor_phone: string;
  doctor_address: string;
  doctor2_name: string;
  doctor2_hospital: string;
  doctor2_phone: string;
  dentist_name: string;
  dentist_hospital: string;
  dentist_phone: string;
  pharmacy_name: string;
  pharmacy_phone: string;
  emergency_contact1_name: string;
  emergency_contact1_relation: string;
  emergency_contact1_phone: string;
  emergency_contact1_address: string;
  emergency_contact2_name: string;
  emergency_contact2_relation: string;
  emergency_contact2_phone: string;
  emergency_contact2_address: string;
  emergency_contact3_name: string;
  emergency_contact3_relation: string;
  emergency_contact3_phone: string;
  medical_history: string;
  current_illness: string;
  adl_mobility: string;
  adl_eating: string;
  adl_toileting: string;
  adl_bathing: string;
  adl_dressing: string;
  adl_communication: string;
  adl_cognition: string;
  adl_notes: string;
  medications: string;
  medication_notes: string;
  emergency_instructions: string;
  hospital_preference: string;
  care_manager_name: string;
  care_manager_office: string;
  care_manager_phone: string;
  notes: string;
}

interface UserInfo {
  name: string;
  name_kana: string;
  birth_date: string | null;
  gender: string | null;
  address: string | null;
  phone: string | null;
}

const emptySheet = (userId: string): EmergencySheet => ({
  user_id: userId,
  blood_type: "", allergies: "",
  doctor_name: "", doctor_hospital: "", doctor_phone: "", doctor_address: "",
  doctor2_name: "", doctor2_hospital: "", doctor2_phone: "",
  dentist_name: "", dentist_hospital: "", dentist_phone: "",
  pharmacy_name: "", pharmacy_phone: "",
  emergency_contact1_name: "", emergency_contact1_relation: "", emergency_contact1_phone: "", emergency_contact1_address: "",
  emergency_contact2_name: "", emergency_contact2_relation: "", emergency_contact2_phone: "", emergency_contact2_address: "",
  emergency_contact3_name: "", emergency_contact3_relation: "", emergency_contact3_phone: "",
  medical_history: "", current_illness: "",
  adl_mobility: "", adl_eating: "", adl_toileting: "", adl_bathing: "", adl_dressing: "", adl_communication: "", adl_cognition: "", adl_notes: "",
  medications: "", medication_notes: "",
  emergency_instructions: "", hospital_preference: "",
  care_manager_name: "", care_manager_office: "", care_manager_phone: "",
  notes: "",
});

const inputClass = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EmergencySheetsPage() {
  const supabase = createClient();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [sheet, setSheet] = useState<EmergencySheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [urls, setUrls] = useState<{ id: string; token: string; name: string }[]>([]);
  const [newUrlName, setNewUrlName] = useState("災害時用");
  const [urlLoading, setUrlLoading] = useState(false);

  // URL management
  const fetchUrls = useCallback(async () => {
    const { data } = await supabase.from("kaigo_emergency_tokens").select("id, token, name").order("created_at", { ascending: false });
    setUrls(data || []);
  }, [supabase]);

  useEffect(() => { if (showUrlModal) fetchUrls(); }, [showUrlModal, fetchUrls]);

  const createUrl = async () => {
    if (!newUrlName.trim()) { toast.error("名前を入力してください"); return; }
    setUrlLoading(true);
    const { error } = await supabase.from("kaigo_emergency_tokens").insert({ name: newUrlName.trim() });
    if (error) toast.error("発行に失敗: " + error.message);
    else { toast.success("URLを発行しました"); setNewUrlName("災害時用"); fetchUrls(); }
    setUrlLoading(false);
  };

  const copyUrl = (token: string) => {
    const url = `${window.location.origin}/emergency/${token}`;
    navigator.clipboard.writeText(url);
    toast.success("URLをコピーしました");
  };

  const deleteUrl = async (id: string) => {
    if (!confirm("このURLを削除しますか？")) return;
    await supabase.from("kaigo_emergency_tokens").delete().eq("id", id);
    fetchUrls();
    toast.success("削除しました");
  };

  const fetchData = useCallback(async (userId: string) => {
    setLoading(true);
    // Fetch user info + 既往歴 + アセスメント（家族情報）を並行取得
    const [{ data: userData }, { data: sheetData }, { data: historyData }, { data: familyData }] = await Promise.all([
      supabase.from("kaigo_users").select("name, name_kana, birth_date, gender, address, phone").eq("id", userId).single(),
      supabase.from("kaigo_emergency_sheets").select("*").eq("user_id", userId).single(),
      supabase.from("kaigo_medical_history").select("disease_name, onset_date, status, hospital, doctor, notes").eq("user_id", userId).order("created_at", { ascending: false }),
      supabase.from("kaigo_assessments").select("form_data").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).single(),
    ]);

    setUserInfo(userData as UserInfo | null);

    if (sheetData) {
      setSheet(sheetData as EmergencySheet);
    } else {
      // 新規: 既存データから自動反映
      const s = emptySheet(userId);

      // 既往歴から かかりつけ医 + 既往歴テキスト を反映
      if (historyData && historyData.length > 0) {
        // 治療中の最初のレコードからかかりつけ医を取得
        const treating = historyData.filter((h: any) => h.status === "治療中"); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (treating.length > 0 && treating[0].doctor) {
          s.doctor_name = treating[0].doctor;
          s.doctor_hospital = treating[0].hospital || "";
        }
        if (treating.length > 1 && treating[1].doctor) {
          s.doctor2_name = treating[1].doctor;
          s.doctor2_hospital = treating[1].hospital || "";
        }
        // 既往歴テキスト
        s.medical_history = historyData.map((h: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
          `${h.disease_name}${h.status ? ` (${h.status})` : ""}${h.hospital ? ` - ${h.hospital}` : ""}`
        ).join("\n");
      }

      // アセスメントの家族情報から緊急連絡先を反映
      if (familyData?.form_data) {
        const fd = familyData.form_data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const members = fd?.tab2?.family_members || [];
        // 緊急連絡先として主介護者や近親者を反映
        let contactIdx = 0;
        for (const m of members) {
          if (!m.name || contactIdx >= 3) break;
          const key = contactIdx === 0 ? "1" : contactIdx === 1 ? "2" : "3";
          (s as any)[`emergency_contact${key}_name`] = m.name || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[`emergency_contact${key}_relation`] = m.relationship || m.relationship_detail || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[`emergency_contact${key}_phone`] = m.phone || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[`emergency_contact${key}_address`] = m.address || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          contactIdx++;
        }
      }

      setSheet(s);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (selectedUserId) fetchData(selectedUserId);
  }, [selectedUserId, fetchData]);

  const updateField = (key: keyof EmergencySheet, value: string) => {
    setSheet((prev) => prev ? { ...prev, [key]: value } : prev);
  };

  const handleSave = async () => {
    if (!sheet || !selectedUserId) return;
    setSaving(true);
    const payload = { ...sheet, user_id: selectedUserId };
    delete (payload as any).id;  // eslint-disable-line @typescript-eslint/no-explicit-any

    if (sheet.id) {
      const { error } = await supabase.from("kaigo_emergency_sheets").update(payload).eq("id", sheet.id);
      if (error) toast.error("保存に失敗: " + error.message);
      else toast.success("保存しました");
    } else {
      const { data, error } = await supabase.from("kaigo_emergency_sheets").insert(payload).select("id").single();
      if (error) toast.error("保存に失敗: " + error.message);
      else { toast.success("保存しました"); setSheet((prev) => prev ? { ...prev, id: data.id } : prev); }
    }
    setSaving(false);
  };

  const handlePrint = () => window.print();

  // Form section helper
  const Section = ({ icon, title, color, children }: { icon: React.ReactNode; title: string; color: string; children: React.ReactNode }) => (
    <section className="mb-6">
      <h3 className={`flex items-center gap-2 text-sm font-bold mb-3 px-3 py-2 rounded-lg ${color}`}>
        {icon}{title}
      </h3>
      <div className="space-y-3 px-1">{children}</div>
    </section>
  );

  const Field = ({ label, field, placeholder, type = "text", colSpan }: { label: string; field: keyof EmergencySheet; placeholder?: string; type?: string; colSpan?: boolean }) => (
    <div className={colSpan ? "col-span-2" : ""}>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      {type === "textarea" ? (
        <textarea rows={3} value={(sheet?.[field] as string) ?? ""} onChange={(e) => updateField(field, e.target.value)} placeholder={placeholder} className={inputClass} />
      ) : (
        <input type={type} value={(sheet?.[field] as string) ?? ""} onChange={(e) => updateField(field, e.target.value)} placeholder={placeholder} className={inputClass} />
      )}
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b bg-white px-6 py-4 shrink-0 print:hidden">
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-red-500" size={22} />
            <div>
              <h1 className="text-xl font-bold text-gray-900">緊急時シート</h1>
              <p className="text-xs text-gray-500">居宅緊急時対応シート</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowUrlModal(true)} className="flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100">
              <Link2 size={15} />
              スマホURL発行
            </button>
            {selectedUserId && sheet && (
              <>
                <button onClick={handlePrint} className="flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  <Printer size={15} />
                  印刷
                </button>
                <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  保存
                </button>
              </>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
          {!selectedUserId ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              <div className="text-center">
                <User size={32} className="mx-auto mb-2 text-gray-300" />
                <p>利用者を選択してください</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 size={20} className="animate-spin text-blue-500" />
            </div>
          ) : sheet ? (
            <div className="max-w-3xl mx-auto">
              {/* 利用者基本情報（自動表示） */}
              {userInfo && (
                <div className="mb-6 rounded-xl border-2 border-red-200 bg-red-50 p-4">
                  <h2 className="text-lg font-bold text-red-800 mb-2 flex items-center gap-2">
                    <AlertTriangle size={18} />
                    居宅緊急時シート
                  </h2>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500">氏名:</span>{" "}
                      <strong className="text-lg">{userInfo.name}</strong>
                      <span className="ml-2 text-gray-400 text-xs">({userInfo.name_kana})</span>
                    </div>
                    <div>
                      <span className="text-gray-500">生年月日:</span>{" "}
                      <strong>{userInfo.birth_date ?? "未登録"}</strong>
                      {userInfo.gender && <span className="ml-2">({userInfo.gender})</span>}
                    </div>
                    <div className="col-span-2">
                      <span className="text-gray-500">住所:</span>{" "}
                      <strong>{userInfo.address ?? "未登録"}</strong>
                    </div>
                    <div>
                      <span className="text-gray-500">電話:</span>{" "}
                      <strong>{userInfo.phone ?? "未登録"}</strong>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="血液型" field="blood_type" placeholder="A型" />
                      <Field label="アレルギー" field="allergies" placeholder="なし / 薬剤名等" />
                    </div>
                  </div>
                </div>
              )}

              {/* かかりつけ医 */}
              <Section icon={<Hospital size={16} />} title="かかりつけ医" color="bg-blue-50 text-blue-800">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="主治医名" field="doctor_name" placeholder="山田太郎" />
                  <Field label="医療機関名" field="doctor_hospital" placeholder="○○クリニック" />
                  <Field label="電話番号" field="doctor_phone" placeholder="03-1234-5678" type="tel" />
                  <Field label="住所" field="doctor_address" placeholder="東京都..." />
                </div>
                <hr className="my-3" />
                <p className="text-xs text-gray-500 mb-2">かかりつけ医②</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="医師名" field="doctor2_name" />
                  <Field label="医療機関名" field="doctor2_hospital" />
                  <Field label="電話番号" field="doctor2_phone" type="tel" />
                </div>
                <hr className="my-3" />
                <p className="text-xs text-gray-500 mb-2">かかりつけ歯科</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="歯科医名" field="dentist_name" />
                  <Field label="医療機関名" field="dentist_hospital" />
                  <Field label="電話番号" field="dentist_phone" type="tel" />
                </div>
                <hr className="my-3" />
                <p className="text-xs text-gray-500 mb-2">かかりつけ薬局</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="薬局名" field="pharmacy_name" />
                  <Field label="電話番号" field="pharmacy_phone" type="tel" />
                </div>
              </Section>

              {/* 緊急連絡先 */}
              <Section icon={<Phone size={16} />} title="緊急連絡先" color="bg-orange-50 text-orange-800">
                <p className="text-xs text-gray-500 mb-1">連絡先①</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="氏名" field="emergency_contact1_name" />
                  <Field label="続柄" field="emergency_contact1_relation" placeholder="長男" />
                  <Field label="電話番号" field="emergency_contact1_phone" type="tel" />
                  <Field label="住所" field="emergency_contact1_address" />
                </div>
                <hr className="my-3" />
                <p className="text-xs text-gray-500 mb-1">連絡先②</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="氏名" field="emergency_contact2_name" />
                  <Field label="続柄" field="emergency_contact2_relation" />
                  <Field label="電話番号" field="emergency_contact2_phone" type="tel" />
                  <Field label="住所" field="emergency_contact2_address" />
                </div>
                <hr className="my-3" />
                <p className="text-xs text-gray-500 mb-1">連絡先③</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="氏名" field="emergency_contact3_name" />
                  <Field label="続柄" field="emergency_contact3_relation" />
                  <Field label="電話番号" field="emergency_contact3_phone" type="tel" />
                </div>
              </Section>

              {/* 既往歴・現病歴 */}
              <Section icon={<Heart size={16} />} title="既往歴・現病歴" color="bg-purple-50 text-purple-800">
                <Field label="既往歴" field="medical_history" type="textarea" placeholder="高血圧、糖尿病..." colSpan />
                <Field label="現病歴" field="current_illness" type="textarea" placeholder="現在治療中の疾患..." colSpan />
              </Section>

              {/* ADL */}
              <Section icon={<User size={16} />} title="ADL（日常生活動作）" color="bg-green-50 text-green-800">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="移動" field="adl_mobility" placeholder="自立 / 杖使用 / 車椅子" />
                  <Field label="食事" field="adl_eating" placeholder="自立 / 一部介助 / 全介助" />
                  <Field label="排泄" field="adl_toileting" placeholder="自立 / 一部介助 / おむつ" />
                  <Field label="入浴" field="adl_bathing" placeholder="自立 / 一部介助 / 全介助" />
                  <Field label="更衣" field="adl_dressing" placeholder="自立 / 一部介助" />
                  <Field label="コミュニケーション" field="adl_communication" placeholder="問題なし / やや困難" />
                  <Field label="認知" field="adl_cognition" placeholder="問題なし / 軽度認知症" />
                </div>
                <Field label="ADL備考" field="adl_notes" type="textarea" colSpan />
              </Section>

              {/* 服薬 */}
              <Section icon={<Pill size={16} />} title="服薬情報" color="bg-yellow-50 text-yellow-800">
                <Field label="服薬一覧" field="medications" type="textarea" placeholder="薬品名 / 用法・用量" colSpan />
                <Field label="服薬上の注意" field="medication_notes" type="textarea" placeholder="食前服用、血液凝固剤使用中..." colSpan />
              </Section>

              {/* 緊急時対応 */}
              <Section icon={<AlertTriangle size={16} />} title="緊急時の対応" color="bg-red-50 text-red-800">
                <Field label="緊急時の対応方法" field="emergency_instructions" type="textarea" placeholder="①まず○○に連絡&#10;②救急車を呼ぶ場合は..." colSpan />
                <Field label="搬送先希望病院" field="hospital_preference" placeholder="○○総合病院" colSpan />
              </Section>

              {/* ケアマネ */}
              <Section icon={<FileText size={16} />} title="担当ケアマネジャー" color="bg-gray-100 text-gray-800">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="氏名" field="care_manager_name" />
                  <Field label="事業所名" field="care_manager_office" />
                  <Field label="電話番号" field="care_manager_phone" type="tel" />
                </div>
              </Section>

              {/* 備考 */}
              <Section icon={<FileText size={16} />} title="備考" color="bg-gray-100 text-gray-800">
                <Field label="その他" field="notes" type="textarea" colSpan />
              </Section>
            </div>
          ) : null}
        </div>
      </div>
      {/* URL発行モーダル */}
      {showUrlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowUrlModal(false)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-bold text-gray-900">スマホURL管理</h2>
              <button onClick={() => setShowUrlModal(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              {/* 新規発行 */}
              <div className="flex gap-2">
                <input
                  value={newUrlName}
                  onChange={(e) => setNewUrlName(e.target.value)}
                  placeholder="URL名（例: 災害時用）"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <button onClick={createUrl} disabled={urlLoading} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {urlLoading ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  発行
                </button>
              </div>

              {/* URL一覧 */}
              <div className="space-y-3">
                {urls.map((u) => {
                  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/emergency/${u.token}`;
                  return (
                    <div key={u.id} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-bold text-gray-900">{u.name}</span>
                        <button onClick={() => deleteUrl(u.id)} className="text-xs text-red-500 hover:underline">削除</button>
                      </div>
                      <div className="flex items-center gap-2">
                        <input readOnly value={url} className="flex-1 text-xs bg-gray-50 border rounded px-2 py-1.5 text-gray-600" />
                        <button onClick={() => copyUrl(u.token)} className="shrink-0 p-1.5 rounded hover:bg-gray-100"><Copy size={14} className="text-gray-500" /></button>
                      </div>
                    </div>
                  );
                })}
                {urls.length === 0 && <p className="text-sm text-gray-400 text-center py-4">URLがまだ発行されていません</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
