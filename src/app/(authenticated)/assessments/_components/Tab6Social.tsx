"use client";

import type { Social } from "../_types";
import { Section, SubSection, Field, TextInput, Textarea, Radio, CertItemRow, SupportMatrixTable } from "../_shared";

interface Props {
  data: Social;
  onChange: (data: Social) => void;
}

const CERT_ITEMS: { key: string; label: string; count: number }[] = [
  { key: "5-1", label: "5-1 薬の内服", count: 3 },
  { key: "5-2", label: "5-2 金銭の管理", count: 3 },
  { key: "5-3", label: "5-3 日常の意思決定", count: 4 },
  { key: "5-4", label: "5-4 集団への不適応", count: 3 },
  { key: "5-5", label: "5-5 買い物", count: 4 },
  { key: "5-6", label: "5-6 簡単な調理", count: 4 },
  { key: "5-7", label: "5-7 電話の利用", count: 3 },
  { key: "5-8", label: "5-8 日中の活動（生活）状況等", count: 3 },
  { key: "5-9", label: "5-9 家族・居住環境、社会参加の状況などの変化", count: 2 },
];

export function Tab6Social({ data, onChange }: Props) {
  const upd = <K extends keyof Social>(k: K, v: Social[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="6-⑤ 社会生活（への適応）力">
        <SubSection title="要介護認定項目">
          {CERT_ITEMS.map((item) => (
            <CertItemRow key={item.key} label={item.label} count={item.count}
              value={data.certification_items[item.key] ?? ""}
              onChange={(v) => upd("certification_items", { ...data.certification_items, [item.key]: v })}
            />
          ))}
        </SubSection>

        <SubSection title="金銭・買い物・調理（6-⑤5-2、5-5〜5-6関係）">
          <SupportMatrixTable rows={["金銭管理", "買い物", "調理", "準備・後始末"]} value={data.money_shopping} onChange={(v) => upd("money_shopping", v)} />
        </SubSection>

        <SubSection title="社会活動・相談支援（6-⑤5-7〜5-8関係）">
          <SupportMatrixTable
            rows={["定期的な相談・助言", "各種書類作成代行", "余暇活動支援", "移送・外出介助", "代読・代筆",
              "話し相手", "安否確認", "緊急連絡手段の確保", "家族連絡の確保", "社会活動への支援"]}
            value={data.phone_activity}
            onChange={(v) => upd("phone_activity", v)}
          />
        </SubSection>

        <SubSection title="社会活動の状況（6-⑤5-8、5-9関係）">
          {(["family_relatives", "neighborhood", "friends"] as const).map((k) => {
            const label = k === "family_relatives" ? "ア. 家族等近親者との交流"
              : k === "neighborhood" ? "イ. 地域近隣との交流"
              : "ウ. 友人知人との交流";
            const v = data.social_activity[k];
            return (
              <div key={k} className="flex items-center gap-2 mb-1">
                <span className="text-xs text-gray-600 w-40">{label}</span>
                <Radio name={`social-${k}`} options={["あり", "なし"] as const} value={v.has} onChange={(x) => upd("social_activity", { ...data.social_activity, [k]: { ...v, has: x } })} />
                <TextInput value={v.note} onChange={(x) => upd("social_activity", { ...data.social_activity, [k]: { ...v, note: x } })} className="flex-1" />
              </div>
            );
          })}
        </SubSection>

        <Field label="緊急連絡・見守りの方法">
          <TextInput value={data.emergency_method} onChange={(v) => upd("emergency_method", v)} className="w-full" />
        </Field>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題など】</label>
          <Textarea value={data.notes} onChange={(v) => upd("notes", v)} rows={4} />
        </div>
      </Section>
    </div>
  );
}
