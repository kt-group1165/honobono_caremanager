"use client";

import type { FaceSheet, ContactInfo } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio, Checkbox } from "../_shared";

interface Props {
  data: FaceSheet;
  onChange: (data: FaceSheet) => void;
}

function ContactBlock({ title, value, onChange }: { title: string; value: ContactInfo; onChange: (v: ContactInfo) => void }) {
  const upd = <K extends keyof ContactInfo>(k: K, v: ContactInfo[K]) => onChange({ ...value, [k]: v });
  return (
    <SubSection title={title}>
      {/* 氏名は独立行で幅を確保 */}
      <Field label="氏名">
        <TextInput value={value.name} onChange={(v) => upd("name", v)} className="w-full" />
      </Field>
      {/* 性別 / 年齢 は下段に横並び */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Field label="性別" className="shrink-0">
          <Radio name={`${title}-gender`} options={["男", "女"] as const} value={value.gender} onChange={(v) => upd("gender", v)} />
        </Field>
        <Field label="年齢" className="shrink-0">
          <div className="flex items-center gap-1">
            <TextInput value={value.age} onChange={(v) => upd("age", v)} className="w-14" />
            <span className="text-sm text-gray-600">歳</span>
          </div>
        </Field>
      </div>
      <Field label="続柄"><TextInput value={value.relationship} onChange={(v) => upd("relationship", v)} className="w-full" /></Field>
      <Field label="住所"><TextInput value={value.address} onChange={(v) => upd("address", v)} className="w-full" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="TEL"><TextInput value={value.tel} onChange={(v) => upd("tel", v)} className="w-full" /></Field>
        <Field label="携帯"><TextInput value={value.mobile} onChange={(v) => upd("mobile", v)} className="w-full" /></Field>
      </div>
    </SubSection>
  );
}

export function Tab1FaceSheet({ data, onChange }: Props) {
  const upd = <K extends keyof FaceSheet>(k: K, v: FaceSheet[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="1. フェースシート">
        <div className="grid grid-cols-3 gap-3">
          <Field label="相談受付日"><TextInput type="date" value={data.consultation_date} onChange={(v) => upd("consultation_date", v)} className="w-full" /></Field>
          <div className="col-span-2">
            <Field label="相談受付">
              <Radio name="consultation_type" options={["訪問", "電話", "来所", "その他"] as const} value={data.consultation_type} onChange={(v) => upd("consultation_type", v)} />
            </Field>
          </div>
        </div>
        {data.consultation_type === "その他" && (
          <Field label="その他"><TextInput value={data.consultation_type_other} onChange={(v) => upd("consultation_type_other", v)} className="w-full" /></Field>
        )}
        <Field label="初回相談受付者"><TextInput value={data.first_receptionist} onChange={(v) => upd("first_receptionist", v)} className="w-full" /></Field>

        <div className="grid grid-cols-2 gap-3">
          <ContactBlock title="緊急連絡先" value={data.emergency_contact} onChange={(v) => upd("emergency_contact", v)} />
          <ContactBlock title="相談者" value={data.consultant} onChange={(v) => upd("consultant", v)} />
        </div>

        <Field label="相談経路（紹介者）"><TextInput value={data.referral_route} onChange={(v) => upd("referral_route", v)} className="w-full" /></Field>
        <Field label="居宅サービス計画作成依頼の届出 年月日"><TextInput type="date" value={data.plan_request_submission_date} onChange={(v) => upd("plan_request_submission_date", v)} /></Field>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600 block mb-1">■相談内容（本人）</label>
            <Textarea value={data.consultation_content_user} onChange={(v) => upd("consultation_content_user", v)} rows={5} />
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">■相談内容（介護者・家族）</label>
            <Textarea value={data.consultation_content_family} onChange={(v) => upd("consultation_content_family", v)} rows={5} />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-600 block mb-1">■これまでの生活の経過（主な生活史）</label>
          <Textarea value={data.life_history} onChange={(v) => upd("life_history", v)} rows={4} />
        </div>
      </Section>

      <Section title="介護保険・医療保険">
        <div className="grid grid-cols-2 gap-3">
          <SubSection title="介護保険">
            <Field label="利用者負担割合">
              <Radio name="copay" options={["1割", "2割", "3割"] as const} value={data.insurance_copay_ratio} onChange={(v) => upd("insurance_copay_ratio", v)} />
            </Field>
          </SubSection>
          <SubSection title="後期高齢者医療保険（75歳以上）">
            <Field label="一部負担金">
              <Radio name="elderly-copay" options={["1割", "2割", "3割"] as const} value={data.elderly_medical_copay_ratio} onChange={(v) => upd("elderly_medical_copay_ratio", v)} />
            </Field>
          </SubSection>
        </div>
        <SubSection title="高額介護サービス費該当">
          <Field label="利用者負担">
            <Radio name="high-cost" options={["第1段階", "第2段階", "第3段階", "第4段階", "第5段階"] as const} value={data.high_cost_care_stage} onChange={(v) => upd("high_cost_care_stage", v)} />
          </Field>
        </SubSection>
      </Section>

      <Section title="要介護認定">
        <div className="grid grid-cols-3 gap-3">
          <Field label="認定状況">
            <Radio name="cert-status" options={["済", "未(見込み)"] as const} value={data.certification_status} onChange={(v) => upd("certification_status", v)} />
          </Field>
          <Field label="要介護度"><TextInput value={data.certification_level} onChange={(v) => upd("certification_level", v)} className="w-full" /></Field>
          <Field label="認定日"><TextInput type="date" value={data.certification_date} onChange={(v) => upd("certification_date", v)} /></Field>
        </div>
      </Section>

      <Section title="各種手帳">
        <SubSection title="身体障害者手帳">
          <div className="grid grid-cols-4 gap-2">
            <Checkbox label="有" checked={data.physical_disability_cert.has} onChange={(v) => upd("physical_disability_cert", { ...data.physical_disability_cert, has: v })} />
            <Field label="等級"><TextInput value={data.physical_disability_cert.grade} onChange={(v) => upd("physical_disability_cert", { ...data.physical_disability_cert, grade: v })} className="w-full" /></Field>
            <Field label="種"><TextInput value={data.physical_disability_cert.type} onChange={(v) => upd("physical_disability_cert", { ...data.physical_disability_cert, type: v })} className="w-full" /></Field>
            <Field label="交付日"><TextInput type="date" value={data.physical_disability_cert.issue_date} onChange={(v) => upd("physical_disability_cert", { ...data.physical_disability_cert, issue_date: v })} /></Field>
          </div>
        </SubSection>
        <SubSection title="療育手帳">
          <div className="grid grid-cols-3 gap-2">
            <Checkbox label="有" checked={data.intellectual_disability_cert.has} onChange={(v) => upd("intellectual_disability_cert", { ...data.intellectual_disability_cert, has: v })} />
            <Field label="程度"><TextInput value={data.intellectual_disability_cert.level} onChange={(v) => upd("intellectual_disability_cert", { ...data.intellectual_disability_cert, level: v })} className="w-full" /></Field>
            <Field label="交付日"><TextInput type="date" value={data.intellectual_disability_cert.issue_date} onChange={(v) => upd("intellectual_disability_cert", { ...data.intellectual_disability_cert, issue_date: v })} /></Field>
          </div>
        </SubSection>
        <SubSection title="精神障害者保健福祉手帳">
          <div className="grid grid-cols-3 gap-2">
            <Checkbox label="有" checked={data.mental_disability_cert.has} onChange={(v) => upd("mental_disability_cert", { ...data.mental_disability_cert, has: v })} />
            <Field label="等級"><TextInput value={data.mental_disability_cert.grade} onChange={(v) => upd("mental_disability_cert", { ...data.mental_disability_cert, grade: v })} className="w-full" /></Field>
            <Field label="交付日"><TextInput type="date" value={data.mental_disability_cert.issue_date} onChange={(v) => upd("mental_disability_cert", { ...data.mental_disability_cert, issue_date: v })} /></Field>
          </div>
        </SubSection>
        <div className="grid grid-cols-3 gap-3">
          <Field label="障害福祉サービス受給者証">
            <Radio name="welfare-svc" options={["有", "無"] as const} value={data.welfare_service_cert} onChange={(v) => upd("welfare_service_cert", v)} />
          </Field>
          <Field label="自立支援医療受給者証">
            <Radio name="self-support" options={["有", "無"] as const} value={data.self_support_medical_cert} onChange={(v) => upd("self_support_medical_cert", v)} />
          </Field>
          <Field label="障害支援区分"><TextInput value={data.disability_support_level} onChange={(v) => upd("disability_support_level", v)} className="w-full" /></Field>
        </div>
      </Section>

      <Section title="日常生活自立度">
        <SubSection title="障害高齢者">
          <Field label="">
            <Radio name="physical-indep" options={["自立", "J1", "J2", "A1", "A2", "B1", "B2", "C1", "C2"] as const} value={data.daily_life_independence.physical} onChange={(v) => upd("daily_life_independence", { ...data.daily_life_independence, physical: v })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="判定機関"><TextInput value={data.daily_life_independence.physical_judge_organization} onChange={(v) => upd("daily_life_independence", { ...data.daily_life_independence, physical_judge_organization: v })} className="w-full" /></Field>
            <Field label="判定日"><TextInput type="date" value={data.daily_life_independence.physical_judge_date} onChange={(v) => upd("daily_life_independence", { ...data.daily_life_independence, physical_judge_date: v })} /></Field>
          </div>
        </SubSection>
        <SubSection title="認知症">
          <Field label="">
            <Radio name="cog-indep" options={["自立", "I", "IIa", "IIb", "IIIa", "IIIb", "IV", "M"] as const} value={data.daily_life_independence.cognitive} onChange={(v) => upd("daily_life_independence", { ...data.daily_life_independence, cognitive: v })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="判定機関"><TextInput value={data.daily_life_independence.cognitive_judge_organization} onChange={(v) => upd("daily_life_independence", { ...data.daily_life_independence, cognitive_judge_organization: v })} className="w-full" /></Field>
            <Field label="判定日"><TextInput type="date" value={data.daily_life_independence.cognitive_judge_date} onChange={(v) => upd("daily_life_independence", { ...data.daily_life_independence, cognitive_judge_date: v })} /></Field>
          </div>
        </SubSection>
        <Field label="アセスメント実施日（初回）"><TextInput type="date" value={data.first_assessment_date} onChange={(v) => upd("first_assessment_date", v)} /></Field>
      </Section>
    </div>
  );
}
