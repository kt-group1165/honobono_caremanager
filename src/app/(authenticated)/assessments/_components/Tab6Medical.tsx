"use client";

import type { MedicalHealth } from "../_types";
import { Section, SubSection, Textarea, Checkbox, CheckboxGroup, SupportMatrixTable } from "../_shared";

interface Props {
  data: MedicalHealth;
  onChange: (data: MedicalHealth) => void;
}

const TREATMENTS = [
  "1. 点滴の管理", "2. 中心静脈栄養", "3. 透析", "4. ストーマ（人工肛門）の処置",
  "5. 酸素療法", "6. レスピレーター（人工呼吸器）", "7. 気管切開の処置", "8. 疼痛の看護",
  "9. 経管栄養", "10. モニター測定（血圧、心拍、酸素飽和度等）", "11. じょくそうの処置",
  "12. カテーテル（コンドームカテーテル、留置カテーテル、ウロストーマ等）",
];

const SPECIFIC_CONTENTS = [
  "バイタルサインのチェック", "定期的な病状観察",
  "内服薬", "坐薬（緩下剤、解熱剤等）", "眼・耳・鼻等の外用薬の使用等", "温・冷あん法、湿布貼付等", "注射",
  "吸引", "吸入", "自己注射（インスリン療法）", "経管栄養法", "中心静脈栄養法",
  "酸素療法", "人工呼吸療法", "気管カニューレの管理", "自己導尿", "自己腹膜灌流",
  "膀胱留置カテーテル管理", "人工肛門・人工膀胱管理", "疼痛管理", "褥瘡管理",
];

export function Tab6Medical({ data, onChange }: Props) {
  const upd = <K extends keyof MedicalHealth>(k: K, v: MedicalHealth[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="6-⑥ 医療・健康関係" subtitle="※計画をする際には主治医の意見を求める場合あり">
        <SubSection title="要介護認定項目">
          <div className="grid grid-cols-2 gap-1">
            {TREATMENTS.map((t) => (
              <Checkbox key={t} label={t} checked={data.treatments[t] ?? false} onChange={(c) => upd("treatments", { ...data.treatments, [t]: c })} />
            ))}
          </div>
        </SubSection>

        <SubSection title="援助の現状">
          <SupportMatrixTable
            rows={["測定・観察", "薬剤の管理", "薬剤の使用", "受診・検査介助", "リハビリテーション", "医療処置の管理"]}
            value={data.support_matrix}
            onChange={(v) => upd("support_matrix", v)}
          />
        </SubSection>

        <SubSection title="具体的内容">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-700 block mb-1">現状</label>
              <CheckboxGroup options={SPECIFIC_CONTENTS} value={data.specific_contents_current} onChange={(v) => upd("specific_contents_current", v)} inline={false} />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700 block mb-1">計画</label>
              <CheckboxGroup options={SPECIFIC_CONTENTS} value={data.specific_contents_plan} onChange={(v) => upd("specific_contents_plan", v)} inline={false} />
            </div>
          </div>
        </SubSection>

        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記、生活上注意すべき課題など】</label>
          <Textarea value={data.notes} onChange={(v) => upd("notes", v)} rows={3} />
        </div>
      </Section>
    </div>
  );
}
