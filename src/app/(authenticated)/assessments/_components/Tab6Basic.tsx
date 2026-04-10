"use client";

import type { BasicMotion } from "../_types";
import { Section, SubSection, Field, Textarea, Radio, CheckboxGroup, CertItemRow, SupportMatrixTable } from "../_shared";

interface Props {
  data: BasicMotion;
  onChange: (data: BasicMotion) => void;
}

const CERT_ITEMS: { key: string; label: string; count: number; multi?: boolean }[] = [
  { key: "1-1", label: "1-1 麻痺等（複数可）", count: 6, multi: true },
  { key: "1-2", label: "1-2 拘縮（複数可）", count: 5, multi: true },
  { key: "1-3", label: "1-3 寝返り", count: 3 },
  { key: "1-4", label: "1-4 起き上がり", count: 3 },
  { key: "1-5", label: "1-5 座位保持", count: 4 },
  { key: "1-6", label: "1-6 両足での立位保持", count: 3 },
  { key: "1-7", label: "1-7 歩行", count: 3 },
  { key: "1-8", label: "1-8 立ち上がり", count: 3 },
  { key: "1-9", label: "1-9 片足での立位保持", count: 3 },
  { key: "1-10", label: "1-10 洗身", count: 4 },
  { key: "1-11", label: "1-11 つめ切り", count: 3 },
  { key: "1-12", label: "1-12 視力", count: 5 },
  { key: "1-13", label: "1-13 聴力", count: 5 },
  { key: "1-14", label: "1-14 関節の動き（複数可）", count: 7, multi: true },
];

export function Tab6Basic({ data, onChange }: Props) {
  const upd = <K extends keyof BasicMotion>(k: K, v: BasicMotion[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="6-① 基本（身体機能・起居）動作">
        <SubSection title="要介護認定項目">
          {CERT_ITEMS.map((item) => (
            <CertItemRow
              key={item.key}
              label={item.label}
              count={item.count}
              multi={item.multi}
              value={data.certification_items[item.key] ?? ""}
              onChange={(v) => upd("certification_items", { ...data.certification_items, [item.key]: v })}
            />
          ))}
        </SubSection>

        <SubSection title="体位変換・起居">
          <SupportMatrixTable rows={["体位変換介助", "起居介助"]} value={data.body_position} onChange={(v) => upd("body_position", v)} />
          <Field label="リハビリの必要性">
            <Radio name="rehab" options={["あり", "なし"] as const} value={data.rehab_needed} onChange={(v) => upd("rehab_needed", v)} />
          </Field>
        </SubSection>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
          <Textarea value={data.basic_notes} onChange={(v) => upd("basic_notes", v)} rows={3} />
        </div>

        <SubSection title="入浴（6-①1-10関係）">
          <SupportMatrixTable
            rows={["準備・後始末", "移乗移動介助", "洗身介助", "洗髪介助", "清拭・部分浴", "褥瘡・皮膚疾患の対応"]}
            value={data.bathing}
            onChange={(v) => upd("bathing", v)}
          />
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label className="text-xs text-gray-600 block mb-1">2) 移乗移動介助 現状</label>
              <CheckboxGroup options={["見守りのみ", "介助あり"]} value={data.bathing_transfer_current} onChange={(v) => upd("bathing_transfer_current", v)} />
              <label className="text-xs text-gray-600 block mb-1 mt-2">計画</label>
              <CheckboxGroup options={["見守り必要", "介助必要"]} value={data.bathing_transfer_plan} onChange={(v) => upd("bathing_transfer_plan", v)} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">3) 洗身介助 現状</label>
              <CheckboxGroup options={["見守りのみ", "介助あり"]} value={data.bathing_wash_current} onChange={(v) => upd("bathing_wash_current", v)} />
              <label className="text-xs text-gray-600 block mb-1 mt-2">計画</label>
              <CheckboxGroup options={["見守り必要", "介助必要"]} value={data.bathing_wash_plan} onChange={(v) => upd("bathing_wash_plan", v)} />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
            <Textarea value={data.bathing_notes} onChange={(v) => upd("bathing_notes", v)} rows={3} />
          </div>
        </SubSection>

        <SubSection title="コミュニケーションの状況・方法（6-①1-12、1-13関係）">
          <Field label="ア. 視聴覚">
            <CheckboxGroup options={["眼鏡使用", "コンタクト使用", "補聴器使用"]} value={data.communication.visual_aid} onChange={(v) => upd("communication", { ...data.communication, visual_aid: v })} />
          </Field>
          <Field label="イ. 電話">
            <Radio name="phone" options={["あり", "なし"] as const} value={data.communication.phone} onChange={(v) => upd("communication", { ...data.communication, phone: v })} />
          </Field>
          <Field label="ウ. 言語障害">
            <Radio name="lang" options={["あり", "なし"] as const} value={data.communication.language_disorder} onChange={(v) => upd("communication", { ...data.communication, language_disorder: v })} />
          </Field>
          <Field label="エ. 支援機器">
            <Radio name="comm-dev" options={["あり", "なし"] as const} value={data.communication.comm_device} onChange={(v) => upd("communication", { ...data.communication, comm_device: v })} />
          </Field>
          <div>
            <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
            <Textarea value={data.communication_notes} onChange={(v) => upd("communication_notes", v)} rows={3} />
          </div>
        </SubSection>
      </Section>
    </div>
  );
}
