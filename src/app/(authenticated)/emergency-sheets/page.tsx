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
  // 追加項目（PDF準拠）
  home_phone: string;
  mobile_phone: string;
  family_members: string;
  adl_summary: string;
  current_disease_notes: string;
  oral_medications: string;
  special_situation: string;
  sudden_change_response: string;
  evacuation_place_name: string;
  evacuation_place_address: string;
  evacuation_notes: string;
  emergency_contact4_name: string;
  emergency_contact4_relation: string;
  emergency_contact4_phone: string;
  emergency_contact4_address: string;
  emergency_contact5_name: string;
  emergency_contact5_relation: string;
  emergency_contact5_phone: string;
  emergency_contact5_address: string;
  services_in_use: { service_type: string; provider_name: string; phone: string; schedule: string }[];
  medical_devices: { item: string; provider: string; phone: string; notes: string }[];
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
  home_phone: "", mobile_phone: "", family_members: "",
  adl_summary: "", current_disease_notes: "", oral_medications: "",
  special_situation: "", sudden_change_response: "",
  evacuation_place_name: "", evacuation_place_address: "", evacuation_notes: "",
  emergency_contact4_name: "", emergency_contact4_relation: "", emergency_contact4_phone: "", emergency_contact4_address: "",
  emergency_contact5_name: "", emergency_contact5_relation: "", emergency_contact5_phone: "", emergency_contact5_address: "",
  services_in_use: [], medical_devices: [],
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

  // 基本情報から自動反映する関数
  const autoFillFromBaseData = useCallback(async (userId: string, baseSheet: EmergencySheet): Promise<EmergencySheet> => {
    const s = { ...baseSheet };
    const [{ data: userData }, { data: historyData }, { data: familyData }] = await Promise.all([
      supabase.from("kaigo_users").select("phone").eq("id", userId).single(),
      supabase.from("kaigo_medical_history").select("disease_name, onset_date, status, hospital, doctor, notes").eq("user_id", userId).order("created_at", { ascending: false }),
      supabase.from("kaigo_assessments").select("form_data").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).single(),
    ]);

    // 電話番号
    if (userData?.phone && !s.home_phone) s.home_phone = userData.phone;

    // 既往歴から かかりつけ医 + 既往歴テキスト を反映
    if (historyData && historyData.length > 0) {
      const treating = historyData.filter((h: any) => h.status === "治療中"); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (treating.length > 0 && treating[0].doctor && !s.doctor_name) {
        s.doctor_name = treating[0].doctor;
        s.doctor_hospital = treating[0].hospital || "";
      }
      if (treating.length > 1 && treating[1].doctor && !s.doctor2_name) {
        s.doctor2_name = treating[1].doctor;
        s.doctor2_hospital = treating[1].hospital || "";
      }
      if (!s.current_disease_notes) {
        s.current_disease_notes = historyData.map((h: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
          `${h.disease_name}${h.status ? ` (${h.status})` : ""}${h.hospital ? ` - ${h.hospital}` : ""}`
        ).join("\n");
      }
    }

    // アセスメントの家族情報から緊急連絡先を反映
    if (familyData?.form_data) {
      const fd = familyData.form_data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const members = fd?.tab2?.family_members || [];
      let contactIdx = 0;
      for (const m of members) {
        if (!m.name || contactIdx >= 5) break;
        const key = String(contactIdx + 1);
        const nameField = `emergency_contact${key}_name` as keyof EmergencySheet;
        if (!(s as any)[nameField]) { // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[nameField] = m.name || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[`emergency_contact${key}_relation`] = m.relationship || m.relationship_detail || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[`emergency_contact${key}_phone`] = m.phone || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
          (s as any)[`emergency_contact${key}_address`] = m.address || ""; // eslint-disable-line @typescript-eslint/no-explicit-any
        }
        contactIdx++;
      }
    }

    return s;
  }, [supabase]);

  const fetchData = useCallback(async (userId: string) => {
    setLoading(true);
    const [{ data: userData }, { data: sheetData }] = await Promise.all([
      supabase.from("kaigo_users").select("name, name_kana, birth_date, gender, address, phone").eq("id", userId).single(),
      supabase.from("kaigo_emergency_sheets").select("*").eq("user_id", userId).single(),
    ]);
    setUserInfo(userData as UserInfo | null);

    const base = sheetData ? (sheetData as EmergencySheet) : emptySheet(userId);
    const filled = await autoFillFromBaseData(userId, base);
    setSheet(filled);
    setLoading(false);
  }, [supabase, autoFillFromBaseData]);

  // 「基本情報から再取得」ボタン用
  const handleReimport = async () => {
    if (!selectedUserId || !sheet) return;
    toast.info("基本情報から再取得中...");
    const filled = await autoFillFromBaseData(selectedUserId, emptySheet(selectedUserId));
    // 既存シートのIDは保持しつつ、データを上書き
    setSheet({ ...filled, id: sheet.id });
    toast.success("基本情報から再取得しました");
  };

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
                <button onClick={handleReimport} className="flex items-center gap-1 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-700 hover:bg-orange-100">
                  基本情報から再取得
                </button>
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
              {/* ===== PDFフォーマット準拠レイアウト ===== */}

              {/* タイトル */}
              <div className="mb-4 text-center">
                <h2 className="text-xl font-bold text-red-800 flex items-center justify-center gap-2">
                  <AlertTriangle size={20} />緊急時シート
                </h2>
              </div>

              {/* 基本情報 */}
              {userInfo && (
                <Section icon={<User size={16} />} title="基本情報" color="bg-red-50 text-red-800">
                  <div className="grid grid-cols-2 gap-3 text-sm mb-2">
                    <div><span className="text-gray-500">フリガナ:</span> {userInfo.name_kana}</div>
                    <div><span className="text-gray-500">生年月日:</span> {userInfo.birth_date ?? "未登録"}</div>
                    <div className="col-span-2"><span className="text-gray-500">氏名:</span> <strong className="text-lg">{userInfo.name}</strong></div>
                    <div className="col-span-2"><span className="text-gray-500">住所:</span> {userInfo.address ?? "未登録"}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="固定電話" field="home_phone" type="tel" />
                    <Field label="携帯電話" field="mobile_phone" type="tel" />
                  </div>
                  <Field label="同居家族" field="family_members" placeholder="妻・次男" />
                </Section>
              )}

              {/* ADL（簡潔に） */}
              <Section icon={<User size={16} />} title="ADL（簡潔に）" color="bg-green-50 text-green-800">
                <Field label="" field="adl_summary" type="textarea" placeholder="杖歩行、排泄自立、認知症なし..." />
              </Section>

              {/* 現病と注意点 */}
              <Section icon={<Heart size={16} />} title="現病と注意点" color="bg-purple-50 text-purple-800">
                <Field label="" field="current_disease_notes" type="textarea" placeholder="高血圧、糖尿病。血糖値に注意..." />
              </Section>

              {/* 内服薬 */}
              <Section icon={<Pill size={16} />} title="内服薬" color="bg-yellow-50 text-yellow-800">
                <Field label="" field="oral_medications" type="textarea" placeholder="アムロジピン5mg 朝食後&#10;メトホルミン250mg 朝夕食後..." />
              </Section>

              {/* 特別な状況 */}
              <Section icon={<FileText size={16} />} title="特別な状況" color="bg-blue-50 text-blue-800">
                <Field label="" field="special_situation" type="textarea" placeholder="ペースメーカー使用、透析中..." />
              </Section>

              {/* 急変時の対応 */}
              <Section icon={<AlertTriangle size={16} />} title="急変時の対応" color="bg-red-50 text-red-800">
                <Field label="" field="sudden_change_response" type="textarea" placeholder="①かかりつけ医に連絡&#10;②家族に連絡&#10;③状況により119番..." />
              </Section>

              {/* 避難場所 */}
              <Section icon={<FileText size={16} />} title="避難場所" color="bg-orange-50 text-orange-800">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="避難場所（名称）" field="evacuation_place_name" placeholder="○○小学校" />
                  <Field label="避難場所（住所）" field="evacuation_place_address" />
                </div>
                <Field label="避難時の注意事項・持参するもの・停電リスクなど" field="evacuation_notes" type="textarea" />
              </Section>

              {/* 緊急連絡先（5件） */}
              <Section icon={<Phone size={16} />} title="緊急連絡先（優先順位順）" color="bg-orange-50 text-orange-800">
                {[1, 2, 3, 4, 5].map((n) => (
                  <div key={n}>
                    {n > 1 && <hr className="my-2" />}
                    <p className="text-xs text-gray-500 mb-1">連絡先{n}</p>
                    <div className="grid grid-cols-4 gap-2">
                      <Field label="氏名" field={`emergency_contact${n}_name` as keyof EmergencySheet} />
                      <Field label="続柄" field={`emergency_contact${n}_relation` as keyof EmergencySheet} />
                      <Field label="所在地" field={`emergency_contact${n}_address` as keyof EmergencySheet} />
                      <Field label="連絡先" field={`emergency_contact${n}_phone` as keyof EmergencySheet} type="tel" />
                    </div>
                  </div>
                ))}
                <p className="text-xs text-gray-400 mt-2">※ 必要な連絡先のみ記載（5件全て埋める必要はなし）</p>
              </Section>

              {/* 主治医 */}
              <Section icon={<Hospital size={16} />} title="主治医" color="bg-blue-50 text-blue-800">
                <div className="grid grid-cols-3 gap-3">
                  <Field label="医療機関名" field="doctor_hospital" />
                  <Field label="氏名" field="doctor_name" />
                  <Field label="連絡先" field="doctor_phone" type="tel" />
                </div>
                <div className="grid grid-cols-3 gap-3 mt-2">
                  <Field label="医療機関名②" field="doctor2_hospital" />
                  <Field label="氏名" field="doctor2_name" />
                  <Field label="連絡先" field="doctor2_phone" type="tel" />
                </div>
              </Section>

              {/* 利用中サービス */}
              <Section icon={<FileText size={16} />} title="利用中サービス" color="bg-green-50 text-green-800">
                <div className="space-y-2">
                  {(sheet.services_in_use || []).map((svc, i) => (
                    <div key={i} className="grid grid-cols-4 gap-2 items-end">
                      <div>
                        <label className="text-xs text-gray-500">サービス種別</label>
                        <input value={svc.service_type} onChange={(e) => { const arr = [...(sheet.services_in_use || [])]; arr[i] = { ...arr[i], service_type: e.target.value }; setSheet({ ...sheet, services_in_use: arr }); }} className={inputClass} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">事業所名</label>
                        <input value={svc.provider_name} onChange={(e) => { const arr = [...(sheet.services_in_use || [])]; arr[i] = { ...arr[i], provider_name: e.target.value }; setSheet({ ...sheet, services_in_use: arr }); }} className={inputClass} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">連絡先</label>
                        <input value={svc.phone} onChange={(e) => { const arr = [...(sheet.services_in_use || [])]; arr[i] = { ...arr[i], phone: e.target.value }; setSheet({ ...sheet, services_in_use: arr }); }} className={inputClass} />
                      </div>
                      <div className="flex gap-1 items-end">
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">利用曜日</label>
                          <input value={svc.schedule} onChange={(e) => { const arr = [...(sheet.services_in_use || [])]; arr[i] = { ...arr[i], schedule: e.target.value }; setSheet({ ...sheet, services_in_use: arr }); }} className={inputClass} />
                        </div>
                        <button onClick={() => { const arr = (sheet.services_in_use || []).filter((_, j) => j !== i); setSheet({ ...sheet, services_in_use: arr }); }} className="text-red-400 hover:text-red-600 p-2">×</button>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => setSheet({ ...sheet, services_in_use: [...(sheet.services_in_use || []), { service_type: "", provider_name: "", phone: "", schedule: "" }] })} className="text-xs text-blue-600 hover:underline">+ サービスを追加</button>
                </div>
              </Section>

              {/* 充電式を含む電動の医療・介護機器 */}
              <Section icon={<FileText size={16} />} title="充電式を含む電動の医療・介護機器" color="bg-yellow-50 text-yellow-800">
                <div className="space-y-2">
                  {(sheet.medical_devices || []).map((dev, i) => (
                    <div key={i} className="grid grid-cols-4 gap-2 items-end">
                      <div>
                        <label className="text-xs text-gray-500">品目</label>
                        <input value={dev.item} onChange={(e) => { const arr = [...(sheet.medical_devices || [])]; arr[i] = { ...arr[i], item: e.target.value }; setSheet({ ...sheet, medical_devices: arr }); }} className={inputClass} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">対応事業者名</label>
                        <input value={dev.provider} onChange={(e) => { const arr = [...(sheet.medical_devices || [])]; arr[i] = { ...arr[i], provider: e.target.value }; setSheet({ ...sheet, medical_devices: arr }); }} className={inputClass} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">連絡先</label>
                        <input value={dev.phone} onChange={(e) => { const arr = [...(sheet.medical_devices || [])]; arr[i] = { ...arr[i], phone: e.target.value }; setSheet({ ...sheet, medical_devices: arr }); }} className={inputClass} />
                      </div>
                      <div className="flex gap-1 items-end">
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">備考</label>
                          <input value={dev.notes} onChange={(e) => { const arr = [...(sheet.medical_devices || [])]; arr[i] = { ...arr[i], notes: e.target.value }; setSheet({ ...sheet, medical_devices: arr }); }} className={inputClass} />
                        </div>
                        <button onClick={() => { const arr = (sheet.medical_devices || []).filter((_, j) => j !== i); setSheet({ ...sheet, medical_devices: arr }); }} className="text-red-400 hover:text-red-600 p-2">×</button>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => setSheet({ ...sheet, medical_devices: [...(sheet.medical_devices || []), { item: "", provider: "", phone: "", notes: "" }] })} className="text-xs text-blue-600 hover:underline">+ 機器を追加</button>
                </div>
              </Section>

              {/* 担当ケアマネジャー */}
              <Section icon={<FileText size={16} />} title="担当ケアマネジャー" color="bg-gray-100 text-gray-800">
                <div className="grid grid-cols-3 gap-3">
                  <Field label="事業所名" field="care_manager_office" />
                  <Field label="氏名" field="care_manager_name" />
                  <Field label="連絡先" field="care_manager_phone" type="tel" />
                </div>
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
