"use client";

import type { DoctorOpinion } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio, Checkbox, CheckboxGroup } from "../_shared";

interface Props {
  data: DoctorOpinion;
  onChange: (data: DoctorOpinion) => void;
}

const RISK_ITEMS = [
  "尿失禁", "転倒・骨折", "移動能力の低下", "褥瘡", "心肺機能の低下", "閉じこもり", "意欲低下", "徘徊",
  "低栄養", "摂食・嚥下機能低下", "脱水", "易感染性", "がん等による疼痛",
];

const MEDICAL_SERVICES = [
  "訪問診療", "訪問看護", "訪問歯科診療", "訪問薬剤管理指導",
  "訪問リハビリテーション", "短期入所療養介護", "訪問歯科衛生指導", "訪問栄養食事指導",
  "通所リハビリテーション", "老人保健施設", "介護医療院",
];

const OBSERVATION_ITEMS = ["血圧", "摂食", "嚥下", "移動", "運動", "その他"];

export function Tab6Doctor({ data, onChange }: Props) {
  const upd = <K extends keyof DoctorOpinion>(k: K, v: DoctorOpinion[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="介護に関する医師の意見" subtitle="（「主治医意見書」を転記）">
        <SubSection title="(1) 移動">
          <Field label="屋外歩行">
            <Radio name="outdoor-walk" options={["自立", "介助があればしている", "していない"] as const} value={data.movement.outdoor_walk} onChange={(v) => upd("movement", { ...data.movement, outdoor_walk: v })} />
          </Field>
          <Field label="車いすの使用">
            <Radio name="wheelchair" options={["用いていない", "主に自分で操作している", "主に他人が操作している"] as const} value={data.movement.wheelchair} onChange={(v) => upd("movement", { ...data.movement, wheelchair: v })} />
          </Field>
          <Field label="歩行補助具・装具">
            <CheckboxGroup options={["用いていない", "屋外で使用", "屋内で使用"]} value={data.movement.walk_aid} onChange={(v) => upd("movement", { ...data.movement, walk_aid: v })} />
          </Field>
        </SubSection>

        <SubSection title="(2) 栄養・食生活">
          <Field label="食事行為">
            <Radio name="eating" options={["自立ないし何とか自分で食べられる", "全面介助"] as const} value={data.nutrition.eating} onChange={(v) => upd("nutrition", { ...data.nutrition, eating: v })} />
          </Field>
          <Field label="現在の栄養状態">
            <Radio name="nutrition-status" options={["良好", "不良"] as const} value={data.nutrition.current_status} onChange={(v) => upd("nutrition", { ...data.nutrition, current_status: v })} />
          </Field>
          <Field label="留意点">
            <TextInput value={data.nutrition.notes} onChange={(v) => upd("nutrition", { ...data.nutrition, notes: v })} className="w-full" />
          </Field>
        </SubSection>

        <SubSection title="(3) 現在あるかまたは今後発生の可能性の高い状態とその対処方針">
          <CheckboxGroup options={RISK_ITEMS} value={data.current_risks.items} onChange={(v) => upd("current_risks", { ...data.current_risks, items: v })} />
          <Field label="その他"><TextInput value={data.current_risks.other} onChange={(v) => upd("current_risks", { ...data.current_risks, other: v })} className="w-full" /></Field>
          <Field label="対処方針"><TextInput value={data.current_risks.response} onChange={(v) => upd("current_risks", { ...data.current_risks, response: v })} className="w-full" /></Field>
        </SubSection>

        <SubSection title="(4) サービス利用による生活機能の維持・改善の見通し">
          <Radio name="outlook" options={["期待できる", "期待できない", "不明"] as const} value={data.improvement_outlook} onChange={(v) => upd("improvement_outlook", v)} />
        </SubSection>

        <SubSection title="(5) 医学的管理の必要性">
          <p className="text-xs text-gray-500 mb-1">※特に必要性の高いものは[高]にチェック</p>
          <div className="grid grid-cols-2 gap-1">
            {MEDICAL_SERVICES.map((s) => {
              const v = data.medical_necessity[s] ?? { checked: false, high: false };
              return (
                <div key={s} className="flex items-center gap-2">
                  <Checkbox label={s} checked={v.checked} onChange={(c) => upd("medical_necessity", { ...data.medical_necessity, [s]: { ...v, checked: c } })} />
                  {v.checked && (
                    <Checkbox label="高" checked={v.high} onChange={(c) => upd("medical_necessity", { ...data.medical_necessity, [s]: { ...v, high: c } })} />
                  )}
                </div>
              );
            })}
          </div>
          <Field label="その他の医療系サービス"><TextInput value={data.medical_necessity_other} onChange={(v) => upd("medical_necessity_other", v)} className="w-full" /></Field>
          <Checkbox label="特記すべき項目なし" checked={data.no_special_item} onChange={(c) => upd("no_special_item", c)} />
        </SubSection>

        <SubSection title="(6) サービス提供時における医学的観点からの留意事項">
          {OBSERVATION_ITEMS.map((item) => {
            const v = data.observation_points[item] ?? { checked: false, note: "" };
            return (
              <div key={item} className="flex items-center gap-2 mb-1">
                <Checkbox label={item} checked={v.checked} onChange={(c) => upd("observation_points", { ...data.observation_points, [item]: { ...v, checked: c } })} />
                {v.checked && (
                  <TextInput value={v.note} onChange={(n) => upd("observation_points", { ...data.observation_points, [item]: { ...v, note: n } })} className="flex-1" />
                )}
              </div>
            );
          })}
          <Checkbox label="特記すべき項目なし" checked={data.no_special_observation} onChange={(c) => upd("no_special_observation", c)} />
        </SubSection>

        <SubSection title="(7) 感染症の有無">
          <Radio name="infection" options={["無", "有", "不明"] as const} value={data.infection.status} onChange={(v) => upd("infection", { ...data.infection, status: v })} />
          {data.infection.status === "有" && (
            <TextInput value={data.infection.note} onChange={(v) => upd("infection", { ...data.infection, note: v })} className="w-full mt-1" placeholder="具体的に記入" />
          )}
        </SubSection>
      </Section>
    </div>
  );
}
