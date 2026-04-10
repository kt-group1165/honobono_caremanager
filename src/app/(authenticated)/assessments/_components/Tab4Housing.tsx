"use client";

import type { Housing } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio, CheckboxGroup } from "../_shared";

interface Props {
  data: Housing;
  onChange: (data: Housing) => void;
}

export function Tab4Housing({ data, onChange }: Props) {
  const upd = <K extends keyof Housing>(k: K, v: Housing[K]) => onChange({ ...data, [k]: v });
  const updLR = <K extends keyof Housing["living_room"]>(k: K, v: Housing["living_room"][K]) => upd("living_room", { ...data.living_room, [k]: v });
  const updToilet = <K extends keyof Housing["toilet"]>(k: K, v: Housing["toilet"][K]) => upd("toilet", { ...data.toilet, [k]: v });
  const updBath = <K extends keyof Housing["bathroom"]>(k: K, v: Housing["bathroom"][K]) => upd("bathroom", { ...data.bathroom, [k]: v });

  return (
    <div>
      <Section title="4. 住居等の状況">
        <div className="grid grid-cols-2 gap-3">
          <Field label="建物種別">
            <Radio name="housing-type" options={["1戸建て", "集合住宅"] as const} value={data.type} onChange={(v) => upd("type", v)} />
          </Field>
          <Field label="所有形態">
            <Radio name="tenure" options={["賃貸", "所有", "社宅等", "公営住宅", "その他"] as const} value={data.tenure} onChange={(v) => upd("tenure", v)} />
          </Field>
        </div>
        {data.tenure === "その他" && (
          <Field label="その他"><TextInput value={data.tenure_other} onChange={(v) => upd("tenure_other", v)} className="w-full" /></Field>
        )}

        <div>
          <label className="text-xs text-gray-600 block mb-1">家屋（居室を含む）見取図 ※段差には▲を記入</label>
          <Textarea value={data.layout_notes} onChange={(v) => upd("layout_notes", v)} rows={4} placeholder="間取り図を文章で記述" />
        </div>

        <SubSection title="居室等の状況">
          <Field label="ア. 専用居室">
            <Radio name="private-room" options={["あり", "なし"] as const} value={data.living_room.has_private} onChange={(v) => updLR("has_private", v)} />
          </Field>
          <Field label="イ. 階">
            <CheckboxGroup options={["1階", "2階", "その他"]} value={data.living_room.floor} onChange={(v) => updLR("floor", v)} />
            {data.living_room.floor.includes("その他") && (
              <TextInput value={data.living_room.floor_other} onChange={(v) => updLR("floor_other", v)} className="ml-2 w-20" placeholder="階数" />
            )}
            <span className="ml-3">エレベーター:</span>
            <Radio name="elevator" options={["有", "無"] as const} value={data.living_room.elevator} onChange={(v) => updLR("elevator", v)} />
          </Field>
          <Field label="ウ. 寝具">
            <Radio name="bed-type" options={["布団", "ベッド"] as const} value={data.living_room.bed_type[0] as any || ""} onChange={(v) => updLR("bed_type", [v])} />
            {data.living_room.bed_type.includes("ベッド") && (
              <CheckboxGroup options={["固定式", "ギャッチ", "電動"]} value={data.living_room.bed_sub} onChange={(v) => updLR("bed_sub", v)} />
            )}
          </Field>
          <Field label="エ. 陽あたり">
            <Radio name="sunlight" options={["良", "普通", "悪"] as const} value={data.living_room.sunlight} onChange={(v) => updLR("sunlight", v)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="オ. 暖房">
              <Radio name="heating" options={["あり", "なし"] as const} value={data.living_room.heating} onChange={(v) => updLR("heating", v)} />
            </Field>
            <Field label="カ. 冷房">
              <Radio name="cooling" options={["あり", "なし"] as const} value={data.living_room.cooling} onChange={(v) => updLR("cooling", v)} />
            </Field>
          </div>
        </SubSection>

        <div className="grid grid-cols-2 gap-3">
          <SubSection title="トイレ">
            <Field label="ア. 種類">
              <CheckboxGroup options={["和式", "洋式", "その他"]} value={data.toilet.type} onChange={(v) => updToilet("type", v)} />
            </Field>
            <Field label="イ. 手すり">
              <Radio name="toilet-handrail" options={["あり", "なし"] as const} value={data.toilet.handrail} onChange={(v) => updToilet("handrail", v)} />
            </Field>
            <Field label="ウ. トイレまでの段差">
              <Radio name="toilet-steps" options={["あり", "なし"] as const} value={data.toilet.steps} onChange={(v) => updToilet("steps", v)} />
            </Field>
          </SubSection>

          <SubSection title="浴室">
            <Field label="ア.">
              <Radio name="bathroom-availability" options={["自宅にあり", "自宅になし"] as const} value={data.bathroom.availability} onChange={(v) => updBath("availability", v)} />
            </Field>
            <Field label="イ. 手すり">
              <Radio name="bath-handrail" options={["あり", "なし"] as const} value={data.bathroom.handrail} onChange={(v) => updBath("handrail", v)} />
            </Field>
            <Field label="ウ. 浴室までの段差">
              <Radio name="bath-steps" options={["あり", "なし"] as const} value={data.bathroom.steps} onChange={(v) => updBath("steps", v)} />
            </Field>
          </SubSection>
        </div>

        <SubSection title="移動手段">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-700 block mb-1">室外</label>
              <Radio name="outdoor-use" options={["使用している", "使用していない"] as const} value={data.mobility.outdoor.device_use} onChange={(v) => upd("mobility", { ...data.mobility, outdoor: { ...data.mobility.outdoor, device_use: v } })} />
              {data.mobility.outdoor.device_use === "使用している" && (
                <CheckboxGroup options={["車いす", "電動車いす", "杖", "歩行器", "その他"]} value={data.mobility.outdoor.devices} onChange={(v) => upd("mobility", { ...data.mobility, outdoor: { ...data.mobility.outdoor, devices: v } })} />
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700 block mb-1">室内</label>
              <Radio name="indoor-use" options={["使用している", "使用していない"] as const} value={data.mobility.indoor.device_use} onChange={(v) => upd("mobility", { ...data.mobility, indoor: { ...data.mobility.indoor, device_use: v } })} />
              {data.mobility.indoor.device_use === "使用している" && (
                <CheckboxGroup options={["車いす", "電動車いす", "杖", "歩行器", "その他"]} value={data.mobility.indoor.devices} onChange={(v) => upd("mobility", { ...data.mobility, indoor: { ...data.mobility.indoor, devices: v } })} />
              )}
            </div>
          </div>
        </SubSection>

        <SubSection title="諸設備">
          <Field label="調理器具">
            <Radio name="cooking" options={["ガス", "IH"] as const} value={data.equipment.cooking} onChange={(v) => upd("equipment", { ...data.equipment, cooking: v })} />
          </Field>
          <Field label="暖房器具">
            <CheckboxGroup options={["ガス", "電気", "灯油", "その他"]} value={data.equipment.heating_device} onChange={(v) => upd("equipment", { ...data.equipment, heating_device: v })} />
          </Field>
        </SubSection>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【周辺環境・立地環境・その他住居に関する特記事項】</label>
          <Textarea value={data.notes} onChange={(v) => upd("notes", v)} rows={3} />
        </div>
      </Section>
    </div>
  );
}
