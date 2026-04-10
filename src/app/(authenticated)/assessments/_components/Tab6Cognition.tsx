"use client";

import type { CognitionBehavior } from "../_types";
import { Section, SubSection, Textarea, CertItemRow } from "../_shared";

interface Props {
  data: CognitionBehavior;
  onChange: (data: CognitionBehavior) => void;
}

const COGNITION_ITEMS: { key: string; label: string; count: number }[] = [
  { key: "3-1", label: "3-1 意思の伝達", count: 4 },
  { key: "3-2", label: "3-2 毎日の日課を理解する", count: 2 },
  { key: "3-3", label: "3-3 生年月日や年齢を答える", count: 2 },
  { key: "3-4", label: "3-4 面接調査の直前記憶", count: 2 },
  { key: "3-5", label: "3-5 自分の名前を答える", count: 2 },
  { key: "3-6", label: "3-6 今の季節を理解する", count: 2 },
  { key: "3-7", label: "3-7 自分のいる場所を答える", count: 2 },
  { key: "3-8", label: "3-8 徘徊", count: 3 },
  { key: "3-9", label: "3-9 外出すると戻れない（迷子）", count: 3 },
  { key: "3-10", label: "3-10 介護者の発言への反応", count: 3 },
];

const BEHAVIOR_ITEMS: { key: string; label: string; count: number }[] = [
  { key: "4-1", label: "4-1 被害妄想（物を盗られたなど）", count: 3 },
  { key: "4-2", label: "4-2 作話をする", count: 3 },
  { key: "4-3", label: "4-3 感情が不安定になる", count: 3 },
  { key: "4-4", label: "4-4 昼夜の逆転", count: 3 },
  { key: "4-5", label: "4-5 しつこく同じ話をする", count: 3 },
  { key: "4-6", label: "4-6 大声を出す", count: 3 },
  { key: "4-7", label: "4-7 介護に抵抗する", count: 3 },
  { key: "4-8", label: "4-8 落ち着きがない（家に帰る等）", count: 3 },
  { key: "4-9", label: "4-9 外に出たがり目が離せない", count: 3 },
  { key: "4-10", label: "4-10 ものを集める、無断でもってくる", count: 3 },
  { key: "4-11", label: "4-11 物を壊す、衣類を破く", count: 3 },
  { key: "4-12", label: "4-12 ひどい物忘れ", count: 3 },
  { key: "4-13", label: "4-13 独り言や独り笑い", count: 3 },
  { key: "4-14", label: "4-14 自分勝手な行動", count: 3 },
  { key: "4-15", label: "4-15 話がまとまらない、会話にならない", count: 3 },
  { key: "4-16", label: "4-16 幻視・幻聴", count: 3 },
  { key: "4-17", label: "4-17 暴言・暴力", count: 3 },
  { key: "4-18", label: "4-18 目的なく動き回る", count: 3 },
  { key: "4-19", label: "4-19 火の始末・管理", count: 3 },
  { key: "4-20", label: "4-20 不潔行為", count: 3 },
  { key: "4-21", label: "4-21 異食行動", count: 3 },
];

export function Tab6Cognition({ data, onChange }: Props) {
  const upd = <K extends keyof CognitionBehavior>(k: K, v: CognitionBehavior[K]) => onChange({ ...data, [k]: v });

  return (
    <div>
      <Section title="6-③ 認知機能 / 6-④ 精神・行動障害">
        <div className="grid grid-cols-2 gap-4">
          <SubSection title="6-③ 認知機能">
            {COGNITION_ITEMS.map((item) => (
              <CertItemRow key={item.key} label={item.label} count={item.count}
                value={data.cognition_items[item.key] ?? ""}
                onChange={(v) => upd("cognition_items", { ...data.cognition_items, [item.key]: v })}
              />
            ))}
          </SubSection>

          <div>
            <SubSection title="家族等からの情報と観察">
              <Textarea value={data.family_observation} onChange={(v) => upd("family_observation", v)} rows={6} />
            </SubSection>
            <SubSection title="援助の現状" className="mt-3">
              <label className="text-xs text-gray-600 block">家族</label>
              <Textarea value={data.support_current.family} onChange={(v) => upd("support_current", { ...data.support_current, family: v })} rows={3} />
              <label className="text-xs text-gray-600 block mt-2">サービス</label>
              <Textarea value={data.support_current.service} onChange={(v) => upd("support_current", { ...data.support_current, service: v })} rows={3} />
            </SubSection>
          </div>
        </div>

        <SubSection title="6-④ 精神・行動障害">
          <div className="grid grid-cols-2 gap-2">
            {BEHAVIOR_ITEMS.map((item) => (
              <CertItemRow key={item.key} label={item.label} count={item.count}
                value={data.behavior_items[item.key] ?? ""}
                onChange={(v) => upd("behavior_items", { ...data.behavior_items, [item.key]: v })}
              />
            ))}
          </div>
        </SubSection>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600 block mb-1">援助の希望/本人</label>
            <Textarea value={data.support_wish_user} onChange={(v) => upd("support_wish_user", v)} rows={3} />
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">援助の希望/家族</label>
            <Textarea value={data.support_wish_family} onChange={(v) => upd("support_wish_family", v)} rows={3} />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600 block mb-1">援助の計画</label>
          <Textarea value={data.support_plan} onChange={(v) => upd("support_plan", v)} rows={4} />
        </div>
        <div>
          <label className="text-xs text-gray-600 block mb-1">【特記、解決すべき課題】</label>
          <Textarea value={data.notes} onChange={(v) => upd("notes", v)} rows={3} />
        </div>
      </Section>
    </div>
  );
}
