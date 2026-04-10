"use client";

import type { LifeFunction } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio, CheckboxGroup, CertItemRow, SupportMatrixTable } from "../_shared";

interface Props {
  data: LifeFunction;
  onChange: (data: LifeFunction) => void;
}

const CERT_ITEMS: { key: string; label: string; count: number }[] = [
  { key: "2-1", label: "2-1 移乗", count: 4 },
  { key: "2-2", label: "2-2 移動", count: 4 },
  { key: "2-3", label: "2-3 えん下", count: 3 },
  { key: "2-4", label: "2-4 食事摂取", count: 4 },
  { key: "2-5", label: "2-5 排尿", count: 4 },
  { key: "2-6", label: "2-6 排便", count: 4 },
  { key: "2-7", label: "2-7 口腔清潔", count: 3 },
  { key: "2-8", label: "2-8 洗顔", count: 3 },
  { key: "2-9", label: "2-9 整髪", count: 3 },
  { key: "2-10", label: "2-10 上衣の着脱", count: 4 },
  { key: "2-11", label: "2-11 ズボン等の着脱", count: 4 },
  { key: "2-12", label: "2-12 外出頻度", count: 3 },
  { key: "2-13", label: "2-13 飲水摂取", count: 4 },
];

export function Tab6LifeFunction({ data, onChange }: Props) {
  const upd = <K extends keyof LifeFunction>(k: K, v: LifeFunction[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="6-② 生活機能（食事・排泄等）">
        <SubSection title="要介護認定項目">
          {CERT_ITEMS.map((item) => (
            <CertItemRow key={item.key} label={item.label} count={item.count}
              value={data.certification_items[item.key] ?? ""}
              onChange={(v) => upd("certification_items", { ...data.certification_items, [item.key]: v })}
            />
          ))}
        </SubSection>

        <SubSection title="食事">
          <SupportMatrixTable rows={["移乗介助", "移動介助", "摂取介助"]} value={data.meals} onChange={(v) => upd("meals", v)} />
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label className="text-xs text-gray-600 block mb-1">主食 現状</label>
              <CheckboxGroup options={["普通食", "粥食", "経口栄養", "経管栄養"]} value={data.main_food.current} onChange={(v) => upd("main_food", { ...data.main_food, current: v })} />
              <label className="text-xs text-gray-600 block mb-1 mt-1">計画</label>
              <CheckboxGroup options={["普通食", "粥食", "経口栄養", "経管栄養"]} value={data.main_food.plan} onChange={(v) => upd("main_food", { ...data.main_food, plan: v })} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">副食 現状</label>
              <CheckboxGroup options={["普通食", "刻み食", "ミキサー食"]} value={data.side_food.current} onChange={(v) => upd("side_food", { ...data.side_food, current: v })} />
              <label className="text-xs text-gray-600 block mb-1 mt-1">計画</label>
              <CheckboxGroup options={["普通食", "刻み食", "ミキサー食"]} value={data.side_food.plan} onChange={(v) => upd("side_food", { ...data.side_food, plan: v })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label className="text-xs text-gray-600 block mb-1">摂取介助 現状</label>
              <CheckboxGroup options={["見守りのみ", "介助あり"]} value={data.food_intake_support.current} onChange={(v) => upd("food_intake_support", { ...data.food_intake_support, current: v })} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">計画</label>
              <CheckboxGroup options={["見守り必要", "介助必要"]} value={data.food_intake_support.plan} onChange={(v) => upd("food_intake_support", { ...data.food_intake_support, plan: v })} />
            </div>
          </div>
        </SubSection>

        <SubSection title="その他食事の現状">
          <Field label="ア. 食事場所">
            <CheckboxGroup options={["食堂", "居室ベッド上", "布団上", "その他居室内", "その他"]} value={data.meal_situation.place} onChange={(v) => upd("meal_situation", { ...data.meal_situation, place: v })} />
          </Field>
          <Field label="イ. 食堂までの段差">
            <Radio name="dining-steps" options={["あり", "なし"] as const} value={data.meal_situation.steps_to_dining} onChange={(v) => upd("meal_situation", { ...data.meal_situation, steps_to_dining: v })} />
          </Field>
          <Field label="ウ. 咀嚼">
            <Radio name="chewing" options={["問題なし", "問題あり"] as const} value={data.meal_situation.chewing_status} onChange={(v) => upd("meal_situation", { ...data.meal_situation, chewing_status: v })} />
          </Field>
          {data.meal_situation.chewing_status === "問題あり" && (
            <CheckboxGroup options={["噛みにくい", "時々噛みにくい", "とても噛みにくい"]} value={data.meal_situation.chewing_issues} onChange={(v) => upd("meal_situation", { ...data.meal_situation, chewing_issues: v })} />
          )}
        </SubSection>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
          <Textarea value={data.meal_notes} onChange={(v) => upd("meal_notes", v)} rows={3} />
        </div>

        <SubSection title="排泄等">
          <SupportMatrixTable
            rows={["準備・後始末", "移乗移動介助", "排尿介助", "排便介助", "口腔清潔介助", "洗面介助", "整容介助", "更衣介助"]}
            value={data.toileting}
            onChange={(v) => upd("toileting", v)}
          />
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label className="text-xs text-gray-600 block mb-1">排尿介助 現状</label>
              <CheckboxGroup options={["見守りのみ", "介助あり", "トイレ", "ポータブルトイレ", "尿収器", "導尿", "おむつ"]} value={data.urination_current} onChange={(v) => upd("urination_current", v)} />
              <label className="text-xs text-gray-600 block mb-1 mt-1">計画</label>
              <CheckboxGroup options={["見守り必要", "介助必要", "トイレ", "ポータブルトイレ", "尿収器", "導尿", "おむつ"]} value={data.urination_plan} onChange={(v) => upd("urination_plan", v)} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">排便介助 現状</label>
              <CheckboxGroup options={["見守りのみ", "介助あり", "トイレ", "ポータブルトイレ", "差し込み便器", "おむつ", "摘便", "浣腸", "人工肛門"]} value={data.defecation_current} onChange={(v) => upd("defecation_current", v)} />
              <label className="text-xs text-gray-600 block mb-1 mt-1">計画</label>
              <CheckboxGroup options={["見守り必要", "介助必要", "トイレ", "ポータブルトイレ", "差し込み便器", "おむつ", "摘便", "浣腸", "人工肛門"]} value={data.defecation_plan} onChange={(v) => upd("defecation_plan", v)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <Field label="尿意">
              <Radio name="urine-aware" options={["ある", "ときどきある", "ない"] as const} value={data.toilet_awareness.urination} onChange={(v) => upd("toilet_awareness", { ...data.toilet_awareness, urination: v })} />
            </Field>
            <Field label="便意">
              <Radio name="feces-aware" options={["ある", "ときどきある", "ない"] as const} value={data.toilet_awareness.defecation} onChange={(v) => upd("toilet_awareness", { ...data.toilet_awareness, defecation: v })} />
            </Field>
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
            <Textarea value={data.toilet_notes} onChange={(v) => upd("toilet_notes", v)} rows={3} />
          </div>
        </SubSection>

        <SubSection title="外出">
          <SupportMatrixTable rows={["移送・外出介助"]} value={data.outing} onChange={(v) => upd("outing", v)} />
          <div>
            <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
            <Textarea value={data.outing_notes} onChange={(v) => upd("outing_notes", v)} rows={3} />
          </div>
        </SubSection>
      </Section>
    </div>
  );
}
