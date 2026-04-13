"use client";

import type { SummarySection } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio } from "../_shared";

interface Props {
  data: SummarySection;
  onChange: (data: SummarySection) => void;
}

export function Tab7Summary({ data: rawData, onChange }: Props) {
  // DB から取得したデータに災害時対応等のネスト構造が無い場合のセーフガード
  const data: SummarySection = {
    notes: rawData.notes ?? "",
    disaster_response: {
      needed: rawData.disaster_response?.needed ?? "",
      individual_plan: rawData.disaster_response?.individual_plan ?? "",
      contact: {
        name: rawData.disaster_response?.contact?.name ?? "",
        relationship: rawData.disaster_response?.contact?.relationship ?? "",
        tel: rawData.disaster_response?.contact?.tel ?? "",
        fax: rawData.disaster_response?.contact?.fax ?? "",
        email: rawData.disaster_response?.contact?.email ?? "",
      },
      notes: rawData.disaster_response?.notes ?? "",
    },
    rights_protection: {
      needed: rawData.rights_protection?.needed ?? "",
      notes: rawData.rights_protection?.notes ?? "",
    },
  };
  const upd = <K extends keyof SummarySection>(k: K, v: SummarySection[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="7. 全体のまとめ">
        <div>
          <label className="text-xs text-gray-600 block mb-1">特記事項</label>
          <Textarea value={data.notes} onChange={(v) => upd("notes", v)} rows={10} />
        </div>

        <SubSection title="災害時の対応の必要性について">
          <div className="grid grid-cols-2 gap-3">
            <Field label="必要性の有無">
              <Radio name="disaster-needed" options={["有", "無"] as const} value={data.disaster_response.needed} onChange={(v) => upd("disaster_response", { ...data.disaster_response, needed: v })} />
            </Field>
            <Field label="個別避難計画策定">
              <Radio name="disaster-plan" options={["有", "策定中", "無"] as const} value={data.disaster_response.individual_plan} onChange={(v) => upd("disaster_response", { ...data.disaster_response, individual_plan: v })} />
            </Field>
          </div>
          {data.disaster_response.needed === "有" && (
            <>
              <label className="text-xs font-semibold text-gray-700 block mb-1 mt-2">災害時の連絡先（家族以外/民生委員等）</label>
              <div className="grid grid-cols-2 gap-2">
                <Field label="氏名"><TextInput value={data.disaster_response.contact.name} onChange={(v) => upd("disaster_response", { ...data.disaster_response, contact: { ...data.disaster_response.contact, name: v } })} className="w-full" /></Field>
                <Field label="本人との関係"><TextInput value={data.disaster_response.contact.relationship} onChange={(v) => upd("disaster_response", { ...data.disaster_response, contact: { ...data.disaster_response.contact, relationship: v } })} className="w-full" /></Field>
                <Field label="TEL"><TextInput value={data.disaster_response.contact.tel} onChange={(v) => upd("disaster_response", { ...data.disaster_response, contact: { ...data.disaster_response.contact, tel: v } })} className="w-full" /></Field>
                <Field label="FAX"><TextInput value={data.disaster_response.contact.fax} onChange={(v) => upd("disaster_response", { ...data.disaster_response, contact: { ...data.disaster_response.contact, fax: v } })} className="w-full" /></Field>
              </div>
              <Field label="メール"><TextInput value={data.disaster_response.contact.email} onChange={(v) => upd("disaster_response", { ...data.disaster_response, contact: { ...data.disaster_response.contact, email: v } })} className="w-full" /></Field>
              <label className="text-xs text-gray-600 block mt-2">備考</label>
              <Textarea value={data.disaster_response.notes} onChange={(v) => upd("disaster_response", { ...data.disaster_response, notes: v })} rows={3} />
            </>
          )}
        </SubSection>

        <SubSection title="権利擁護に関する対応の必要性について">
          <Field label="必要性の有無">
            <Radio name="rights-needed" options={["有", "無"] as const} value={data.rights_protection.needed} onChange={(v) => upd("rights_protection", { ...data.rights_protection, needed: v })} />
          </Field>
          {data.rights_protection.needed === "有" && (
            <>
              <label className="text-xs text-gray-600 block mt-2">備考</label>
              <Textarea value={data.rights_protection.notes} onChange={(v) => upd("rights_protection", { ...data.rights_protection, notes: v })} rows={3} />
            </>
          )}
        </SubSection>
      </Section>
    </div>
  );
}
