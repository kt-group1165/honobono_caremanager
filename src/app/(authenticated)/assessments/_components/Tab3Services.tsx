"use client";

import type { ServiceUsage } from "../_types";
import { Section, SubSection, Field, TextInput, Radio, Checkbox } from "../_shared";

interface Props {
  data: ServiceUsage;
  onChange: (data: ServiceUsage) => void;
}

const HOME_SERVICES = [
  "訪問介護（ホームヘルプサービス）", "（介護予防）訪問型サービス", "（介護予防）訪問入浴介護",
  "（介護予防）訪問看護", "（介護予防）訪問リハビリテーション", "（介護予防）居宅療養管理指導",
  "通所介護（デイサービス）", "（介護予防）通所型サービス", "（介護予防）通所リハビリテーション",
  "（介護予防）短期入所生活介護", "（介護予防）短期入所療養介護",
  "（介護予防）特定施設入所者生活介護", "看護小規模多機能型居宅介護",
  "（介護予防）福祉用具貸与", "特定（介護予防）福祉用具販売", "住宅改修",
  "夜間対応型訪問介護", "（介護予防）認知症対応型通所介護",
  "（介護予防）小規模多機能型居宅介護", "（介護予防）認知症対応型共同生活介護",
  "定期巡回・随時対応型訪問介護看護",
];

const OTHER_SERVICES = [
  "配食サービス", "洗濯サービス", "移動または外出支援", "友愛訪問",
  "老人福祉センター", "老人憩いの家", "ガイドヘルパー", "身障/補装具・日常生活用具",
  "生活支援員の訪問（日常生活自立支援事業）", "ふれあい・いきいきサロン", "市町村特別給付",
];

const ADMISSION_TYPES = [
  "介護老人福祉施設", "介護老人保健施設", "介護医療院(介護療養型医療施設)",
  "認知症対応型共同生活介護適用施設", "特定施設入居者生活介護適用施設",
  "医療機関(医療保険適用療養病床)", "医療機関(療養病床以外)", "その他の施設",
];

const HEALTH_INSURANCES = [
  "国保", "協会けんぽ(旧・政管健保)", "組合健保", "日雇い",
  "国公共済", "地方共済", "私立学校共済", "船員", "後期高齢者医療",
];

const WELFARE_PROGRAMS = [
  "恩給", "特別障害者手当", "生活保護", "生活福祉資金貸付",
  "高齢者住宅整備資金貸付", "日常生活自立支援事業",
];

export function Tab3Services({ data, onChange }: Props) {
  const upd = <K extends keyof ServiceUsage>(k: K, v: ServiceUsage[K]) => onChange({ ...data, [k]: v });

  const toggleHomeService = (name: string, used: boolean) => {
    const current = data.home_services[name] ?? { used: false, count: "", unit: "月" };
    upd("home_services", { ...data.home_services, [name]: { ...current, used } });
  };
  const setHomeServiceCount = (name: string, count: string) => {
    const current = data.home_services[name] ?? { used: true, count: "", unit: "月" };
    upd("home_services", { ...data.home_services, [name]: { ...current, count } });
  };
  const toggleOther = (name: string, used: boolean) => {
    const current = data.other_services[name] ?? { used: false, count: "" };
    upd("other_services", { ...data.other_services, [name]: { ...current, used } });
  };
  const setOtherCount = (name: string, count: string) => {
    const current = data.other_services[name] ?? { used: true, count: "" };
    upd("other_services", { ...data.other_services, [name]: { ...current, count } });
  };

  return (
    <div>
      <Section title="3. サービス利用状況">
        <Field label="時点"><TextInput type="date" value={data.as_of_date} onChange={(v) => upd("as_of_date", v)} /></Field>

        <SubSection title="在宅利用">
          <div className="grid grid-cols-2 gap-2">
            {HOME_SERVICES.map((s) => {
              const v = data.home_services[s] ?? { used: false, count: "", unit: "月" };
              return (
                <div key={s} className="flex items-center gap-1 text-xs">
                  <Checkbox label={s} checked={v.used} onChange={(c) => toggleHomeService(s, c)} />
                  {v.used && (
                    <>
                      <span className="text-gray-500">月</span>
                      <TextInput value={v.count} onChange={(c) => setHomeServiceCount(s, c)} className="w-12" />
                      <span className="text-gray-500">回</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </SubSection>

        <SubSection title="その他（保険外サービス）">
          <div className="grid grid-cols-2 gap-2">
            {OTHER_SERVICES.map((s) => {
              const v = data.other_services[s] ?? { used: false, count: "" };
              return (
                <div key={s} className="flex items-center gap-1 text-xs">
                  <Checkbox label={s} checked={v.used} onChange={(c) => toggleOther(s, c)} />
                  {v.used && (
                    <>
                      <span className="text-gray-500">月</span>
                      <TextInput value={v.count} onChange={(c) => setOtherCount(s, c)} className="w-12" />
                      <span className="text-gray-500">回</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </SubSection>

        <SubSection title="直近の入所・入院">
          <Radio name="admission-type" options={ADMISSION_TYPES} value={data.recent_admission.type as any} onChange={(v) => upd("recent_admission", { ...data.recent_admission, type: v })} /> {/* eslint-disable-line @typescript-eslint/no-explicit-any -- Radio prop widening */}
          <div className="grid grid-cols-2 gap-2 mt-2">
            <Field label="施設・機関名"><TextInput value={data.recent_admission.facility_name} onChange={(v) => upd("recent_admission", { ...data.recent_admission, facility_name: v })} className="w-full" /></Field>
            <Field label="TEL"><TextInput value={data.recent_admission.tel} onChange={(v) => upd("recent_admission", { ...data.recent_admission, tel: v })} className="w-full" /></Field>
          </div>
          <Field label="所在地"><TextInput value={data.recent_admission.address} onChange={(v) => upd("recent_admission", { ...data.recent_admission, address: v })} className="w-full" /></Field>
        </SubSection>

        <SubSection title="制度利用状況">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-700 mb-1 block">年金</label>
              {(["elderly", "disability", "survivor"] as const).map((k) => {
                const label = k === "elderly" ? "老齢関係" : k === "disability" ? "障害関係" : "遺族・寡婦";
                const v = data.pension[k];
                return (
                  <div key={k} className="flex items-center gap-2 mb-1">
                    <Checkbox label={label} checked={v.checked} onChange={(c) => upd("pension", { ...data.pension, [k]: { ...v, checked: c } })} />
                    <TextInput value={v.note} onChange={(n) => upd("pension", { ...data.pension, [k]: { ...v, note: n } })} className="flex-1" />
                  </div>
                );
              })}
              <div className="grid grid-cols-2 gap-1 mt-2">
                {WELFARE_PROGRAMS.map((p) => (
                  <Checkbox key={p} label={p} checked={data.welfare_programs[p] ?? false} onChange={(c) => upd("welfare_programs", { ...data.welfare_programs, [p]: c })} />
                ))}
              </div>
              <Field label="成年後見制度">
                <Radio name="guardianship" options={["後見", "保佐", "補助"] as const} value={data.adult_guardianship} onChange={(v) => upd("adult_guardianship", v)} />
              </Field>
              <Field label="成年後見人等"><TextInput value={data.guardian_name} onChange={(v) => upd("guardian_name", v)} className="w-full" /></Field>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700 mb-1 block">健康保険</label>
              <div className="grid grid-cols-2 gap-1">
                {HEALTH_INSURANCES.map((p) => (
                  <Checkbox key={p} label={p} checked={data.health_insurance[p] ?? false} onChange={(c) => upd("health_insurance", { ...data.health_insurance, [p]: c })} />
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Checkbox label="労災保険" checked={data.worker_comp.checked} onChange={(c) => upd("worker_comp", { ...data.worker_comp, checked: c })} />
                <TextInput value={data.worker_comp.note} onChange={(n) => upd("worker_comp", { ...data.worker_comp, note: n })} className="flex-1" />
              </div>
              <label className="text-xs text-gray-600 block mt-2">その他</label>
              {data.other_systems.map((o, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <Checkbox label="" checked={o.checked} onChange={(c) => {
                    const n = [...data.other_systems]; n[i] = { ...o, checked: c }; upd("other_systems", n);
                  }} />
                  <TextInput value={o.note} onChange={(v) => {
                    const n = [...data.other_systems]; n[i] = { ...o, note: v }; upd("other_systems", n);
                  }} className="flex-1" />
                </div>
              ))}
            </div>
          </div>
        </SubSection>
      </Section>
    </div>
  );
}
