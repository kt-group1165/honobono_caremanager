"use client";

import type { Social } from "../_types";
import { PVFrame, PVCircle, PVCheckLabel, cellBase, cellHead, cellLabel } from "../_preview";

interface Props { data: Social; userName: string; date: string; }

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

function CheckMark({ on }: { on: boolean }) {
  return <span className="inline-block text-center" style={{ width: "4mm" }}>{on ? "○" : ""}</span>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
function SupportT({ title, rows, matrix }: { title: string; rows: string[]; matrix: Record<string, any> | undefined }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7pt" }}>
      <thead>
        <tr>
          <th style={{ ...cellHead, width: "22mm" }} rowSpan={2}>{title}</th>
          <th style={cellHead} colSpan={2}>援助の現状</th>
          <th style={cellHead} rowSpan={2}>希望</th>
          <th style={cellHead} rowSpan={2}>要援助→計画</th>
        </tr>
        <tr>
          <th style={cellHead}>家族実施</th>
          <th style={cellHead}>サービス実施</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const row = matrix?.[r] ?? { family_exec: false, service_exec: false, wish: false, needs_plan: false };
          return (
            <tr key={r}>
              <td style={cellBase}>{i + 1}) {r}</td>
              <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.family_exec} /></td>
              <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.service_exec} /></td>
              <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.wish} /></td>
              <td style={{ ...cellBase, textAlign: "center" }}><CheckMark on={row.needs_plan} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PreviewTab6Social({ data, userName, date }: Props) {
  const c = data;
  const isSel = (key: string, n: number) => {
    const v = c.certification_items?.[key] ?? "";
    return v.split(",").includes(String(n));
  };

  return (
    <PVFrame userName={userName} date={date}>
      <div className="text-sm font-bold mb-1">6-⑤ 社会生活（への適応）力</div>

      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <div>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "7.5pt" }}>
            <tbody>
              {CERT_ITEMS.map((item) => (
                <tr key={item.key}>
                  <td style={{ ...cellLabel, width: "40mm" }}>{item.label}</td>
                  <td style={cellBase}>
                    {Array.from({ length: item.count }, (_, i) => i + 1).map((n) => (
                      <span key={n} className="mr-1"><PVCircle on={isSel(item.key, n)}>{n}</PVCircle></span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-2 border border-black p-1 text-xs">
            <div className="font-bold">&lt;社会活動の状況（6-⑤5-8、5-9関係）&gt;</div>
            <div>ア. 家族等近親者との交流 <PVCheckLabel on={c.social_activity?.family_relatives?.has === "あり"} label="あり" /> （ {c.social_activity?.family_relatives?.note} ） <PVCheckLabel on={c.social_activity?.family_relatives?.has === "なし"} label="なし" /></div>
            <div>イ. 地域近隣との交流 <PVCheckLabel on={c.social_activity?.neighborhood?.has === "あり"} label="あり" /> （ {c.social_activity?.neighborhood?.note} ） <PVCheckLabel on={c.social_activity?.neighborhood?.has === "なし"} label="なし" /></div>
            <div>ウ. 友人知人との交流 <PVCheckLabel on={c.social_activity?.friends?.has === "あり"} label="あり" /> （ {c.social_activity?.friends?.note} ） <PVCheckLabel on={c.social_activity?.friends?.has === "なし"} label="なし" /></div>
          </div>

          <div className="mt-2 border border-black p-1 text-xs">
            <div className="font-bold">緊急連絡・見守りの方法</div>
            <div>{c.emergency_method}</div>
          </div>
        </div>

        <div>
          <SupportT title="6-⑤5-2、5-5〜5-6関係" rows={["金銭管理", "買い物", "調理", "準備・後始末"]} matrix={c.money_shopping} />
          <div className="mt-1">
            <SupportT title="6-⑤5-7〜5-8関係" rows={["定期的な相談・助言", "各種書類作成代行", "余暇活動支援", "移送・外出介助", "代読・代筆", "話し相手", "安否確認", "緊急連絡手段の確保", "家族連絡の確保", "社会活動への支援"]} matrix={c.phone_activity} />
          </div>
        </div>
      </div>

      <div className="bg-blue-100 text-xs px-1 font-bold mt-2">【特記、解決すべき課題など】</div>
      <div className="border border-black p-1 text-xs whitespace-pre-wrap" style={{ minHeight: "30mm" }}>{c.notes}</div>
    </PVFrame>
  );
}
