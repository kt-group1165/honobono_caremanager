"use client";

import { Trash2, Plus } from "lucide-react";
import type { FamilySupport, FamilyMember } from "../_types";
import { emptyFamilyMember } from "../_types";
import { Section, Field, TextInput, Textarea, Radio, Checkbox } from "../_shared";
import { Genogram } from "./Genogram";

interface Props {
  data: FamilySupport;
  onChange: (data: FamilySupport) => void;
  userName?: string;
  userGender?: string | null;
}

export function Tab2Family({ data, onChange, userName, userGender }: Props) {
  const upd = <K extends keyof FamilySupport>(k: K, v: FamilySupport[K]) => onChange({ ...data, [k]: v });

  const updMember = (i: number, patch: Partial<FamilyMember>) => {
    const newMembers = [...data.family_members];
    newMembers[i] = { ...newMembers[i], ...patch };
    upd("family_members", newMembers);
  };
  const addMember = () => upd("family_members", [...data.family_members, emptyFamilyMember()]);
  const removeMember = (i: number) => upd("family_members", data.family_members.filter((_, idx) => idx !== i));

  const addSupport = () => upd("informal_support", [...data.informal_support, { provider: "", content: "", notes: "" }]);
  const removeSupport = (i: number) => upd("informal_support", data.informal_support.filter((_, idx) => idx !== i));

  return (
    <div>
      <Section title="2. 家族状況とインフォーマルな支援の状況">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600 block mb-1">■家族構成図（自動生成）</label>
            <Genogram
              userName={userName ?? ""}
              userGender={userGender ?? null}
              members={data.family_members}
            />
            <div className="mt-2">
              <label className="text-[10px] text-gray-500 block mb-0.5">補足メモ</label>
              <Textarea value={data.family_composition_diagram} onChange={(v) => upd("family_composition_diagram", v)} rows={2} placeholder="図に表現できない情報を補足" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">家族の介護の状況・課題</label>
            <Textarea value={data.family_care_situation} onChange={(v) => upd("family_care_situation", v)} rows={10} />
          </div>
        </div>

        {/* Family members table */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold text-gray-700">家族構成（※は主たる介護者）</label>
            <button onClick={addMember} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
              <Plus size={12} /> 追加
            </button>
          </div>
          <table className="w-full text-xs border-collapse border">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-2 py-1 w-8">※</th>
                <th className="border px-2 py-1">氏名</th>
                <th className="border px-2 py-1 w-20">続柄</th>
                <th className="border px-2 py-1 w-16">同別居</th>
                <th className="border px-2 py-1 w-16">就労</th>
                <th className="border px-2 py-1">健康状態等</th>
                <th className="border px-2 py-1">特記事項<br />(自治会、ボランティア等社会的活動)</th>
                <th className="border px-2 py-1 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.family_members.map((m, i) => (
                <tr key={i}>
                  <td className="border text-center">
                    <input type="checkbox" checked={m.is_primary_caregiver} onChange={(e) => updMember(i, { is_primary_caregiver: e.target.checked })} className="accent-blue-600" />
                  </td>
                  <td className="border p-1"><TextInput value={m.name} onChange={(v) => updMember(i, { name: v })} className="w-full" /></td>
                  <td className="border p-1"><TextInput value={m.relationship} onChange={(v) => updMember(i, { relationship: v })} className="w-full" /></td>
                  <td className="border p-1">
                    <Radio name={`living-${i}`} options={["同", "別"] as const} value={m.living} onChange={(v) => updMember(i, { living: v })} inline={false} />
                  </td>
                  <td className="border p-1">
                    <Radio name={`employment-${i}`} options={["有", "無"] as const} value={m.employment} onChange={(v) => updMember(i, { employment: v })} inline={false} />
                  </td>
                  <td className="border p-1"><TextInput value={m.health_status} onChange={(v) => updMember(i, { health_status: v })} className="w-full" /></td>
                  <td className="border p-1"><TextInput value={m.notes} onChange={(v) => updMember(i, { notes: v })} className="w-full" /></td>
                  <td className="border text-center">
                    <button onClick={() => removeMember(i)} className="text-gray-400 hover:text-red-500"><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="■インフォーマルな支援活用状況" subtitle="親戚、近隣、友人、同僚、ボランティア、民生委員、自治会等の地域の団体等">
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold text-gray-700">支援状況</label>
            <button onClick={addSupport} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
              <Plus size={12} /> 追加
            </button>
          </div>
          <table className="w-full text-xs border-collapse border">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-2 py-1 w-32">支援提供者</th>
                <th className="border px-2 py-1">活用している支援内容</th>
                <th className="border px-2 py-1">特記事項</th>
                <th className="border px-2 py-1 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.informal_support.map((s, i) => (
                <tr key={i}>
                  <td className="border p-1"><TextInput value={s.provider} onChange={(v) => {
                    const n = [...data.informal_support]; n[i] = { ...n[i], provider: v }; upd("informal_support", n);
                  }} className="w-full" /></td>
                  <td className="border p-1"><TextInput value={s.content} onChange={(v) => {
                    const n = [...data.informal_support]; n[i] = { ...n[i], content: v }; upd("informal_support", n);
                  }} className="w-full" /></td>
                  <td className="border p-1"><TextInput value={s.notes} onChange={(v) => {
                    const n = [...data.informal_support]; n[i] = { ...n[i], notes: v }; upd("informal_support", n);
                  }} className="w-full" /></td>
                  <td className="border text-center">
                    <button onClick={() => removeSupport(i)} className="text-gray-400 hover:text-red-500"><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4">
          <label className="text-sm font-semibold text-gray-700 block mb-2">本人が受けたい支援/今後必要になると思われる支援</label>
          <div className="grid grid-cols-3 gap-2">
            <Field label="内容"><TextInput value={data.needed_support.content} onChange={(v) => upd("needed_support", { ...data.needed_support, content: v })} className="w-full" /></Field>
            <Field label="支援提供者"><TextInput value={data.needed_support.provider} onChange={(v) => upd("needed_support", { ...data.needed_support, provider: v })} className="w-full" /></Field>
            <Field label="特記事項"><TextInput value={data.needed_support.notes} onChange={(v) => upd("needed_support", { ...data.needed_support, notes: v })} className="w-full" /></Field>
          </div>
        </div>
      </Section>
    </div>
  );
}
