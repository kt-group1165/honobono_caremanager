"use client";

import type { YoboFormData, YoboDomain, BasicChecklistAnswer } from "./_types";
import { BASIC_CHECKLIST_QUESTIONS, YOBO_DOMAINS } from "./_types";
import { Section, SubSection, Textarea, Radio, Checkbox } from "../_shared";

interface Props {
  data: YoboFormData;
  onChange: (data: YoboFormData) => void;
}

export function YoboForm({ data, onChange }: Props) {
  const upd = <K extends keyof YoboFormData>(k: K, v: YoboFormData[K]) =>
    onChange({ ...data, [k]: v });

  const updDomain = (
    key: "mobility" | "daily_life" | "social" | "health",
    patch: Partial<YoboDomain>
  ) => {
    onChange({ ...data, [key]: { ...data[key], ...patch } });
  };

  const setChecklist = (no: number, answer: BasicChecklistAnswer) => {
    onChange({
      ...data,
      basic_checklist: { ...data.basic_checklist, [String(no)]: answer },
    });
  };

  // リスク該当数 (集計表示用)
  const riskCount = BASIC_CHECKLIST_QUESTIONS.reduce((acc, q) => {
    return acc + (data.basic_checklist[String(q.no)] === q.riskAnswer ? 1 : 0);
  }, 0);

  return (
    <div>
      {/* ─── 基本情報 ─────────────────────────────────────────── */}
      <Section title="基本情報" subtitle="介護予防のためのアセスメント（要支援者等のケアマネジメント様式）">
        <SubSection title="相談経路・意向">
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-xs text-gray-600 block mb-1">相談・委託の経路等</label>
              <Textarea value={data.basic_info.referral_route} onChange={(v) => upd("basic_info", { ...data.basic_info, referral_route: v })} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-600 block mb-1">本人の希望・意向</label>
                <Textarea value={data.basic_info.user_intention} onChange={(v) => upd("basic_info", { ...data.basic_info, user_intention: v })} rows={3} />
              </div>
              <div>
                <label className="text-xs text-gray-600 block mb-1">家族の希望・意向</label>
                <Textarea value={data.basic_info.family_intention} onChange={(v) => upd("basic_info", { ...data.basic_info, family_intention: v })} rows={3} />
              </div>
            </div>
          </div>
        </SubSection>

        <SubSection title="現在の状況">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600 block mb-1">利用中サービス（介護保険）</label>
              <Textarea value={data.basic_info.current_services_insurance} onChange={(v) => upd("basic_info", { ...data.basic_info, current_services_insurance: v })} rows={2} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">利用中サービス（保険外・地域資源）</label>
              <Textarea value={data.basic_info.current_services_other} onChange={(v) => upd("basic_info", { ...data.basic_info, current_services_other: v })} rows={2} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">住居環境・住まいの状況</label>
              <Textarea value={data.basic_info.housing_situation} onChange={(v) => upd("basic_info", { ...data.basic_info, housing_situation: v })} rows={2} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">経済状況（特記）</label>
              <Textarea value={data.basic_info.economic_situation} onChange={(v) => upd("basic_info", { ...data.basic_info, economic_situation: v })} rows={2} />
            </div>
          </div>
        </SubSection>
      </Section>

      {/* ─── 4 領域のアセスメント ─────────────────────────────── */}
      <Section title="アセスメント領域（4領域）" subtitle="①運動・移動 ②日常生活 ③社会参加・対人関係・コミュニケーション ④健康管理">
        {YOBO_DOMAINS.map((d) => {
          const domain = data[d.key];
          return (
            <SubSection key={d.key} title={`${d.number}. ${d.title}`}>
              <p className="text-[11px] text-gray-500 mb-1">{d.hint}</p>
              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">現状（できていること／困っていること）</label>
                  <Textarea value={domain.current_state} onChange={(v) => updDomain(d.key, { current_state: v })} rows={3} />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">課題の分析（背景・要因）</label>
                  <Textarea value={domain.issue_analysis} onChange={(v) => updDomain(d.key, { issue_analysis: v })} rows={3} />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">本人の意欲・意向（「〜したい」）</label>
                  <Textarea value={domain.motivation} onChange={(v) => updDomain(d.key, { motivation: v })} rows={2} />
                </div>
              </div>
            </SubSection>
          );
        })}
      </Section>

      {/* ─── 基本チェックリスト ───────────────────────────────── */}
      <Section
        title="基本チェックリスト（25項目）"
        subtitle={`該当（リスク）項目数：${riskCount} / 25`}
        action={
          <Checkbox
            label="実施した"
            checked={data.checklist_done}
            onChange={(v) => upd("checklist_done", v)}
          />
        }
      >
        {data.checklist_done ? (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-50">
                <tr>
                  <th className="border px-1 py-1 w-8">No</th>
                  <th className="border px-1 py-1 w-16">区分</th>
                  <th className="border px-2 py-1 text-left">質問項目</th>
                  <th className="border px-1 py-1 w-32">回答</th>
                </tr>
              </thead>
              <tbody>
                {BASIC_CHECKLIST_QUESTIONS.map((q) => {
                  const ans = data.basic_checklist[String(q.no)] ?? "";
                  const isRisk = ans === q.riskAnswer;
                  return (
                    <tr key={q.no} className={isRisk ? "bg-amber-50" : ""}>
                      <td className="border px-1 py-1 text-center">{q.no}</td>
                      <td className="border px-1 py-1 text-center text-[10px] text-gray-500">{q.category}</td>
                      <td className="border px-2 py-1">{q.text}</td>
                      <td className="border px-1 py-1">
                        <Radio
                          name={`chk-${q.no}`}
                          options={["はい", "いいえ"] as const}
                          value={ans}
                          onChange={(v) => setChecklist(q.no, v)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-400">「実施した」にチェックすると入力できます。</p>
        )}
      </Section>

      {/* ─── 総合的な課題 ─────────────────────────────────────── */}
      <Section title="総合的な課題・方針">
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="text-xs text-gray-600 block mb-1">総合的な課題（生活課題・背景・要因）</label>
            <Textarea value={data.summary.overall_issues} onChange={(v) => upd("summary", { ...data.summary, overall_issues: v })} rows={4} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600 block mb-1">目標とする生活（6ヶ月後・1年後の姿）</label>
              <Textarea value={data.summary.target_life} onChange={(v) => upd("summary", { ...data.summary, target_life: v })} rows={3} />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">具体的な支援の方針</label>
              <Textarea value={data.summary.support_policy} onChange={(v) => upd("summary", { ...data.summary, support_policy: v })} rows={3} />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">特記事項</label>
            <Textarea value={data.summary.special_notes} onChange={(v) => upd("summary", { ...data.summary, special_notes: v })} rows={2} />
          </div>
        </div>
      </Section>
    </div>
  );
}
