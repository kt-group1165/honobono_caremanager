"use client";

import { useState, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { toast } from "sonner";
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
import {
  autoFillFromBaseData,
  emptySheet,
  type EmergencySheet,
  type EmergencyUserInfo,
} from "./_emergency-helpers";

const inputClass = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function Section({ icon, title, color, children }: { icon: React.ReactNode; title: string; color: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className={`flex items-center gap-2 text-sm font-bold mb-3 px-3 py-2 rounded-lg ${color}`}>
        {icon}{title}
      </h3>
      <div className="space-y-3 px-1">{children}</div>
    </section>
  );
}

function Field({
  label, value, onChange, placeholder, type = "text", colSpan,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; colSpan?: boolean;
}) {
  return (
    <div className={colSpan ? "col-span-2" : ""}>
      {label && <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>}
      {type === "textarea" ? (
        <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
      )}
    </div>
  );
}

export interface EmergencySheetsContentProps {
  userId: string;
  initialUserInfo: EmergencyUserInfo | null;
  initialSheet: EmergencySheet;
}

export function EmergencySheetsContent({
  userId,
  initialUserInfo,
  initialSheet,
}: EmergencySheetsContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const [userInfo] = useState<EmergencyUserInfo | null>(initialUserInfo);
  const [sheet, setSheet] = useState<EmergencySheet>(initialSheet);
  const [saving, setSaving] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [urls, setUrls] = useState<{ id: string; token: string; name: string }[]>([]);
  const [newUrlName, setNewUrlName] = useState("災害時用");
  const [urlLoading, setUrlLoading] = useState(false);

  const fetchUrls = useCallback(async () => {
    const { data } = await supabase.from("kaigo_emergency_tokens").select("id, token, name").order("created_at", { ascending: false });
    setUrls(data || []);
  }, [supabase]);

  const openUrlModal = async () => {
    setShowUrlModal(true);
    await fetchUrls();
  };

  const createUrl = async () => {
    if (!newUrlName.trim()) { toast.error("名前を入力してください"); return; }
    setUrlLoading(true);
    const resolved = await resolvePreferredTenantId(supabase);
    if (!resolved.ok) {
      toast.error("発行に失敗: " + resolved.error);
      setUrlLoading(false);
      return;
    }
    const { error } = await supabase
      .from("kaigo_emergency_tokens")
      .insert({ name: newUrlName.trim(), tenant_id: resolved.tenantId });
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

  const handleReimport = async () => {
    toast.info("基本情報から再取得中...");
    const filled = await autoFillFromBaseData(supabase, userId, emptySheet(userId));
    setSheet({ ...filled, id: sheet.id });
    toast.success("基本情報から再取得しました");
  };

  const updateField = (key: keyof EmergencySheet, value: string) => {
    setSheet((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    const payload = { ...sheet, user_id: userId };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (payload as any).id;

    if (sheet.id) {
      const { error } = await supabase.from("kaigo_emergency_sheets").update(payload).eq("id", sheet.id);
      if (error) toast.error("保存に失敗: " + error.message);
      else toast.success("保存しました");
    } else {
      const { data, error } = await supabase.from("kaigo_emergency_sheets").insert(payload).select("id").single();
      if (error) toast.error("保存に失敗: " + error.message);
      else { toast.success("保存しました"); setSheet((prev) => ({ ...prev, id: data.id })); }
    }
    setSaving(false);
  };

  const handlePrint = () => window.print();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-white px-6 py-4 shrink-0 print:hidden">
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-red-500" size={22} />
          <div>
            <h1 className="text-xl font-bold text-gray-900">緊急時シート</h1>
            <p className="text-xs text-gray-500">居宅緊急時対応シート</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openUrlModal} className="flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100">
            <Link2 size={15} />
            スマホURL発行
          </button>
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
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="mb-4 text-center">
            <h2 className="text-xl font-bold text-red-800 flex items-center justify-center gap-2">
              <AlertTriangle size={20} />緊急時シート
            </h2>
          </div>

          {userInfo && (
            <Section icon={<User size={16} />} title="基本情報" color="bg-red-50 text-red-800">
              <div className="grid grid-cols-2 gap-3 text-sm mb-2">
                <div><span className="text-gray-500">フリガナ:</span> {userInfo.name_kana}</div>
                <div><span className="text-gray-500">生年月日:</span> {userInfo.birth_date ?? "未登録"}</div>
                <div className="col-span-2"><span className="text-gray-500">氏名:</span> <strong className="text-lg">{userInfo.name}</strong></div>
                <div className="col-span-2"><span className="text-gray-500">住所:</span> {userInfo.address ?? "未登録"}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="固定電話" value={(sheet.home_phone as string) ?? ""} onChange={(v) => updateField("home_phone", v)} type="tel" />
                <Field label="携帯電話" value={(sheet.mobile_phone as string) ?? ""} onChange={(v) => updateField("mobile_phone", v)} type="tel" />
              </div>
              <Field label="同居家族" value={(sheet.family_members as string) ?? ""} onChange={(v) => updateField("family_members", v)} placeholder="妻・次男" />
            </Section>
          )}

          <Section icon={<User size={16} />} title="ADL（簡潔に）" color="bg-green-50 text-green-800">
            <Field label="" value={(sheet.adl_summary as string) ?? ""} onChange={(v) => updateField("adl_summary", v)} type="textarea" placeholder="杖歩行、排泄自立、認知症なし..." />
          </Section>

          <Section icon={<Heart size={16} />} title="現病と注意点" color="bg-purple-50 text-purple-800">
            <Field label="" value={(sheet.current_disease_notes as string) ?? ""} onChange={(v) => updateField("current_disease_notes", v)} type="textarea" placeholder="高血圧、糖尿病。血糖値に注意..." />
          </Section>

          <Section icon={<Pill size={16} />} title="内服薬" color="bg-yellow-50 text-yellow-800">
            <Field label="" value={(sheet.oral_medications as string) ?? ""} onChange={(v) => updateField("oral_medications", v)} type="textarea" placeholder="アムロジピン5mg 朝食後&#10;メトホルミン250mg 朝夕食後..." />
          </Section>

          <Section icon={<FileText size={16} />} title="特別な状況" color="bg-blue-50 text-blue-800">
            <Field label="" value={(sheet.special_situation as string) ?? ""} onChange={(v) => updateField("special_situation", v)} type="textarea" placeholder="ペースメーカー使用、透析中..." />
          </Section>

          <Section icon={<AlertTriangle size={16} />} title="急変時の対応" color="bg-red-50 text-red-800">
            <Field label="" value={(sheet.sudden_change_response as string) ?? ""} onChange={(v) => updateField("sudden_change_response", v)} type="textarea" placeholder="①かかりつけ医に連絡&#10;②家族に連絡&#10;③状況により119番..." />
          </Section>

          <Section icon={<FileText size={16} />} title="避難場所" color="bg-orange-50 text-orange-800">
            <div className="grid grid-cols-2 gap-3">
              <Field label="避難場所（名称）" value={(sheet.evacuation_place_name as string) ?? ""} onChange={(v) => updateField("evacuation_place_name", v)} placeholder="○○小学校" />
              <Field label="避難場所（住所）" value={(sheet.evacuation_place_address as string) ?? ""} onChange={(v) => updateField("evacuation_place_address", v)} />
            </div>
            <Field label="避難時の注意事項・持参するもの・停電リスクなど" value={(sheet.evacuation_notes as string) ?? ""} onChange={(v) => updateField("evacuation_notes", v)} type="textarea" />
          </Section>

          <Section icon={<Phone size={16} />} title="緊急連絡先（優先順位順）" color="bg-orange-50 text-orange-800">
            {[1, 2, 3, 4, 5].map((n) => (
              <div key={n}>
                {n > 1 && <hr className="my-2" />}
                <p className="text-xs text-gray-500 mb-1">連絡先{n}</p>
                <div className="grid grid-cols-4 gap-2">
                  <Field label="氏名" value={(sheet[`emergency_contact${n}_name` as keyof EmergencySheet] as string) ?? ""} onChange={(v) => updateField(`emergency_contact${n}_name` as keyof EmergencySheet, v)} />
                  <Field label="続柄" value={(sheet[`emergency_contact${n}_relation` as keyof EmergencySheet] as string) ?? ""} onChange={(v) => updateField(`emergency_contact${n}_relation` as keyof EmergencySheet, v)} />
                  <Field label="所在地" value={(sheet[`emergency_contact${n}_address` as keyof EmergencySheet] as string) ?? ""} onChange={(v) => updateField(`emergency_contact${n}_address` as keyof EmergencySheet, v)} />
                  <Field label="連絡先" value={(sheet[`emergency_contact${n}_phone` as keyof EmergencySheet] as string) ?? ""} onChange={(v) => updateField(`emergency_contact${n}_phone` as keyof EmergencySheet, v)} type="tel" />
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-400 mt-2">※ 必要な連絡先のみ記載（5件全て埋める必要はなし）</p>
          </Section>

          <Section icon={<Hospital size={16} />} title="主治医" color="bg-blue-50 text-blue-800">
            <div className="grid grid-cols-3 gap-3">
              <Field label="医療機関名" value={(sheet.doctor_hospital as string) ?? ""} onChange={(v) => updateField("doctor_hospital", v)} />
              <Field label="氏名" value={(sheet.doctor_name as string) ?? ""} onChange={(v) => updateField("doctor_name", v)} />
              <Field label="連絡先" value={(sheet.doctor_phone as string) ?? ""} onChange={(v) => updateField("doctor_phone", v)} type="tel" />
            </div>
            <div className="grid grid-cols-3 gap-3 mt-2">
              <Field label="医療機関名②" value={(sheet.doctor2_hospital as string) ?? ""} onChange={(v) => updateField("doctor2_hospital", v)} />
              <Field label="氏名" value={(sheet.doctor2_name as string) ?? ""} onChange={(v) => updateField("doctor2_name", v)} />
              <Field label="連絡先" value={(sheet.doctor2_phone as string) ?? ""} onChange={(v) => updateField("doctor2_phone", v)} type="tel" />
            </div>
          </Section>

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

          <Section icon={<FileText size={16} />} title="担当ケアマネジャー" color="bg-gray-100 text-gray-800">
            <div className="grid grid-cols-3 gap-3">
              <Field label="事業所名" value={(sheet.care_manager_office as string) ?? ""} onChange={(v) => updateField("care_manager_office", v)} />
              <Field label="氏名" value={(sheet.care_manager_name as string) ?? ""} onChange={(v) => updateField("care_manager_name", v)} />
              <Field label="連絡先" value={(sheet.care_manager_phone as string) ?? ""} onChange={(v) => updateField("care_manager_phone", v)} type="tel" />
            </div>
          </Section>
        </div>
      </div>

      {showUrlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowUrlModal(false)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-bold text-gray-900">スマホURL管理</h2>
              <button onClick={() => setShowUrlModal(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
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
