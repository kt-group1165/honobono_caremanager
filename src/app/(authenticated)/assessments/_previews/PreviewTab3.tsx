"use client";

import type { ServiceUsage } from "../_types";
import { PVFrame, PVTitle, PVCheck, PVCheckLabel, cellBase, cellHead, cellLabel } from "../_preview";

interface Props { data: ServiceUsage; userName: string; date: string; }

const HOME_LEFT = [
  "訪問介護（ホームヘルプサービス）", "（介護予防）訪問型サービス", "（介護予防）訪問入浴介護",
  "（介護予防）訪問看護", "（介護予防）訪問リハビリテーション", "（介護予防）居宅療養管理指導",
  "通所介護（デイサービス）", "（介護予防）通所型サービス", "（介護予防）通所リハビリテーション",
  "（介護予防）短期入所生活介護", "（介護予防）短期入所療養介護",
];
const HOME_RIGHT = [
  "（介護予防）特定施設入所者生活介護", "看護小規模多機能型居宅介護",
  "（介護予防）福祉用具貸与", "特定（介護予防）福祉用具販売", "住宅改修",
  "夜間対応型訪問介護", "（介護予防）認知症対応型通所介護",
  "（介護予防）小規模多機能型居宅介護", "（介護予防）認知症対応型共同生活介護",
  "定期巡回・随時対応型訪問介護看護",
];
const OTHER_LEFT = [
  "配食サービス", "洗濯サービス", "移動または外出支援", "友愛訪問",
  "老人福祉センター", "老人憩いの家", "ガイドヘルパー", "身障/補装具・日常生活用具",
];
const OTHER_RIGHT = [
  "生活支援員の訪問（日常生活自立支援事業）", "ふれあい・いきいきサロン", "市町村特別給付",
];

export function PreviewTab3({ data, userName, date }: Props) {
  return (
    <PVFrame userName={userName} date={date}>
      <div className="flex justify-between items-center">
        <PVTitle number="3">サービス利用状況</PVTitle>
        <span className="text-xs">（{data.as_of_date || "　　　"} 時点）</span>
      </div>

      <div className="text-xs bg-blue-100 px-1 py-0.5">
        <strong>在宅利用</strong>（認定調査を行った月のサービス利用回数を記入。（介護予防）福祉用具貸与は調査日時点の、特定（介護予防）福祉用具販売は過去6ヶ月の品目数を記載）
      </div>
      <div className="grid grid-cols-2 gap-2 border border-black p-1 text-xs">
        <div>
          {HOME_LEFT.map((s) => {
            const v = data.home_services?.[s];
            return (
              <div key={s} className="flex items-center">
                <PVCheck on={!!v?.used} />
                <span className="flex-1">{s}</span>
                <span>月 {v?.count || "　"} 回</span>
              </div>
            );
          })}
        </div>
        <div>
          {HOME_RIGHT.map((s) => {
            const v = data.home_services?.[s];
            return (
              <div key={s} className="flex items-center">
                <PVCheck on={!!v?.used} />
                <span className="flex-1">{s}</span>
                <span>月 {v?.count || "　"} 回</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border border-black border-t-0 p-1 text-xs">
        <div>
          {OTHER_LEFT.map((s) => {
            const v = data.other_services?.[s];
            return (
              <div key={s} className="flex items-center">
                <PVCheck on={!!v?.used} />
                <span className="flex-1">{s}</span>
                <span>月 {v?.count || "　"} 回</span>
              </div>
            );
          })}
        </div>
        <div>
          {OTHER_RIGHT.map((s) => {
            const v = data.other_services?.[s];
            return (
              <div key={s} className="flex items-center">
                <PVCheck on={!!v?.used} />
                <span className="flex-1">{s}</span>
                <span>月 {v?.count || "　"} 回</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-blue-100 text-xs px-1 py-0.5 mt-1">直近の入所・入院</div>
      <div className="border border-black p-1 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            {["介護老人福祉施設", "介護老人保健施設", "介護医療院(介護療養型医療施設)", "認知症対応型共同生活介護適用施設", "特定施設入居者生活介護適用施設", "医療機関(医療保険適用療養病床)", "医療機関(療養病床以外)", "その他の施設"].map((t) => (
              <div key={t}>
                <PVCheck on={data.recent_admission?.type === t} /> {t}
              </div>
            ))}
          </div>
          <div>
            <div>施設・機関名 {data.recent_admission?.facility_name}</div>
            <div>所在地 〒 {data.recent_admission?.postal_code}</div>
            <div className="ml-10">{data.recent_admission?.address}</div>
            <div>TEL {data.recent_admission?.tel}</div>
          </div>
        </div>
      </div>

      <div className="bg-blue-100 text-xs px-1 py-0.5 mt-1">制度利用状況</div>
      <div className="grid grid-cols-2 gap-2 border border-black p-1 text-xs">
        <div>
          <div className="font-bold">年金</div>
          <div><PVCheck on={!!data.pension?.elderly?.checked} /> 老齢関係 → （ {data.pension?.elderly?.note} ）</div>
          <div><PVCheck on={!!data.pension?.disability?.checked} /> 障害関係 → （ {data.pension?.disability?.note} ）</div>
          <div><PVCheck on={!!data.pension?.survivor?.checked} /> 遺族・寡婦 → （ {data.pension?.survivor?.note} ）</div>
          {["恩給", "特別障害者手当", "生活保護", "生活福祉資金貸付", "高齢者住宅整備資金貸付", "日常生活自立支援事業"].map((w) => (
            <div key={w}><PVCheck on={!!data.welfare_programs?.[w]} /> {w}</div>
          ))}
          <div className="mt-1">
            成年後見制度 →
            <PVCheckLabel on={data.adult_guardianship === "後見"} label="後見" />
            <PVCheckLabel on={data.adult_guardianship === "保佐"} label="保佐" />
            <PVCheckLabel on={data.adult_guardianship === "補助"} label="補助" />
          </div>
          <div>成年後見人等（ {data.guardian_name} ）</div>
        </div>
        <div>
          <div className="font-bold">健康保険</div>
          <div className="grid grid-cols-2 gap-1">
            {["国保", "組合健保", "国公共済", "私立学校共済", "後期高齢者医療", "協会けんぽ(旧・政管健保)", "日雇い", "地方共済", "船員"].map((h) => (
              <div key={h}><PVCheck on={!!data.health_insurance?.[h]} /> {h}</div>
            ))}
          </div>
          <div className="mt-1">
            <PVCheck on={!!data.worker_comp?.checked} /> 労災保険 → （ {data.worker_comp?.note} ）
          </div>
          <div>その他:
            {(data.other_systems ?? []).map((o, i) => (
              <div key={i}><PVCheck on={!!o.checked} /> （ {o.note} ）</div>
            ))}
          </div>
        </div>
      </div>
    </PVFrame>
  );
}
