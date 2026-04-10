"use client";

import type { Health, MedicalVisit } from "../_types";
import { emptyMedicalVisit } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio, CheckboxGroup } from "../_shared";

interface Props {
  data: Health;
  onChange: (data: Health) => void;
}

export function Tab5Health({ data, onChange }: Props) {
  const upd = <K extends keyof Health>(k: K, v: Health[K]) => onChange({ ...data, [k]: v });
  const updVisit = (i: number, patch: Partial<MedicalVisit>) => {
    const n = [...data.medical_visits];
    n[i] = { ...n[i], ...patch };
    upd("medical_visits", n);
  };

  return (
    <div>
      <Section title="5. 本人の健康状態・受診等の状況">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600 block mb-1">既往歴・現症（必要に応じ「主治医意見書」を転記）</label>
            <Textarea value={data.medical_history} onChange={(v) => upd("medical_history", v)} rows={8} placeholder="※要介護状態に関係がある既往歴および現症" />
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">障害等の部位 △障害部位 ×欠損部位 ●褥瘡部位</label>
            <Textarea value={data.disability_location_notes} onChange={(v) => upd("disability_location_notes", v)} rows={8} placeholder="人体図の部位を文章で記述" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="身長"><TextInput value={data.height} onChange={(v) => upd("height", v)} className="w-20" /> cm</Field>
          <Field label="体重"><TextInput value={data.weight} onChange={(v) => upd("weight", v)} className="w-20" /> kg</Field>
          <Field label="歯の状況">
            <CheckboxGroup options={["歯あり", "歯なし", "総入れ歯", "局部義歯"]} value={data.teeth.status} onChange={(v) => upd("teeth", { status: v })} />
          </Field>
        </div>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記事項】（病気やけが、障害等に関わる事項。改善の可能性等）</label>
          <Textarea value={data.special_notes} onChange={(v) => upd("special_notes", v)} rows={4} />
        </div>

        <SubSection title="現在の受診状況（歯科含む）">
          <table className="w-full text-xs border-collapse border">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-1 py-0.5 w-20">項目</th>
                {data.medical_visits.map((_, i) => (
                  <th key={i} className="border px-1 py-0.5">受診{i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr><td className="border px-1">病名</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.disease_name} onChange={(x) => updVisit(i, { disease_name: x })} className="w-full" /></td>)}</tr>
              <tr><td className="border px-1">薬の有無</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><Radio name={`med-${i}`} options={["有", "無"] as const} value={v.has_medication} onChange={(x) => updVisit(i, { has_medication: x })} /></td>)}</tr>
              <tr><td className="border px-1">発症時期</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.onset_date} onChange={(x) => updVisit(i, { onset_date: x })} className="w-full" /></td>)}</tr>
              <tr><td className="border px-1">受診頻度</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5">
                <div className="flex items-center gap-1">
                  <Radio name={`freq-${i}`} options={["定期", "不定期"] as const} value={v.frequency_type} onChange={(x) => updVisit(i, { frequency_type: x })} />
                </div>
                {v.frequency_type === "定期" && (
                  <div className="flex items-center gap-1">
                    <Radio name={`funit-${i}`} options={["週", "月"] as const} value={v.frequency_unit} onChange={(x) => updVisit(i, { frequency_unit: x })} />
                    <TextInput value={v.frequency_count} onChange={(x) => updVisit(i, { frequency_count: x })} className="w-12" /> 回
                  </div>
                )}
              </td>)}</tr>
              <tr><td className="border px-1">受診状況</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><Radio name={`visit-${i}`} options={["通院", "往診"] as const} value={v.visit_type} onChange={(x) => updVisit(i, { visit_type: x })} /></td>)}</tr>
              <tr><td className="border px-1">医療機関</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.facility} onChange={(x) => updVisit(i, { facility: x })} className="w-full" /></td>)}</tr>
              <tr><td className="border px-1">診療科</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.department} onChange={(x) => updVisit(i, { department: x })} className="w-full" /></td>)}</tr>
              <tr><td className="border px-1">主治医</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.doctor} onChange={(x) => updVisit(i, { doctor: x })} className="w-full" /></td>)}</tr>
              <tr><td className="border px-1">連絡先</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.tel} onChange={(x) => updVisit(i, { tel: x })} className="w-full" /></td>)}</tr>
              <tr><td className="border px-1">受診方法・留意点等</td>{data.medical_visits.map((v, i) => <td key={i} className="border p-0.5"><TextInput value={v.notes} onChange={(x) => updVisit(i, { notes: x })} className="w-full" /></td>)}</tr>
            </tbody>
          </table>
        </SubSection>

        <div className="space-y-2">
          <div className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
            <span className="text-xs text-gray-700 w-32">往診可能な医療機関</span>
            <div className="flex items-center gap-2">
              <Radio name="home-visit" options={["有", "無"] as const} value={data.home_visit_available.has} onChange={(v) => upd("home_visit_available", { ...data.home_visit_available, has: v })} />
              <TextInput value={data.home_visit_available.facility} onChange={(v) => upd("home_visit_available", { ...data.home_visit_available, facility: v })} className="flex-1" placeholder="施設名" />
            </div>
            <TextInput value={data.home_visit_available.tel} onChange={(v) => upd("home_visit_available", { ...data.home_visit_available, tel: v })} className="w-32" placeholder="TEL" />
          </div>
          <div className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
            <span className="text-xs text-gray-700 w-32">緊急入院できる医療機関</span>
            <div className="flex items-center gap-2">
              <Radio name="emergency" options={["有", "無"] as const} value={data.emergency_hospital.has} onChange={(v) => upd("emergency_hospital", { ...data.emergency_hospital, has: v })} />
              <TextInput value={data.emergency_hospital.facility} onChange={(v) => upd("emergency_hospital", { ...data.emergency_hospital, facility: v })} className="flex-1" placeholder="施設名" />
            </div>
            <TextInput value={data.emergency_hospital.tel} onChange={(v) => upd("emergency_hospital", { ...data.emergency_hospital, tel: v })} className="w-32" placeholder="TEL" />
          </div>
          <div className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
            <span className="text-xs text-gray-700 w-32">かかりつけ薬局</span>
            <div className="flex items-center gap-2">
              <Radio name="pharmacy" options={["有", "無"] as const} value={data.pharmacy.has} onChange={(v) => upd("pharmacy", { ...data.pharmacy, has: v })} />
              <TextInput value={data.pharmacy.name} onChange={(v) => upd("pharmacy", { ...data.pharmacy, name: v })} className="flex-1" placeholder="薬局名" />
            </div>
            <TextInput value={data.pharmacy.tel} onChange={(v) => upd("pharmacy", { ...data.pharmacy, tel: v })} className="w-32" placeholder="TEL" />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記、生活上配慮すべき課題など】</label>
          <Textarea value={data.life_considerations} onChange={(v) => upd("life_considerations", v)} rows={3} />
        </div>
      </Section>
    </div>
  );
}
