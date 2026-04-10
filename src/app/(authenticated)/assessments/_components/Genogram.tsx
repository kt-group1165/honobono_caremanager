"use client";

import React from "react";
import type { FamilyMember } from "../_types";

/**
 * 家系図 (Genogram) を SVG で自動生成する。
 *
 * 仕様:
 *  - 中央: 利用者本人 (■=男 / ◎=女、二重線で強調)
 *  - 右隣: 配偶者
 *  - 上段: 父母
 *  - 下段: 子（長男・長女・次男…）
 *  - 横並び: 兄弟姉妹
 *  - 同居: 実線、別居: 破線
 *  - 男性: 四角(□)、女性: 円(○)
 *  - 死亡: 斜線
 *  - 主たる介護者: 星マーク(★)
 *
 * 続柄テキストから役割と性別を推定する簡易ロジック。
 */

interface GenogramProps {
  userName: string;
  userGender: "男" | "女" | string | null;
  members: FamilyMember[];
}

type Role = "self" | "spouse" | "child" | "parent" | "sibling" | "other";

interface Node {
  id: string;
  name: string;
  gender: "男" | "女" | "?";
  role: Role;
  isPrimaryCaregiver: boolean;
  living: "同" | "別" | "";
  relationship: string;
  deceased: boolean;
}

function inferRole(rel: string): Role {
  if (!rel) return "other";
  const r = rel.replace(/\s+/g, "");
  if (/(本人)/.test(r)) return "self";
  if (/(夫|妻|配偶者|パートナー)/.test(r)) return "spouse";
  if (/(息子|娘|長男|長女|次男|次女|三男|三女|四男|四女|男子|女子|子)/.test(r)) return "child";
  if (/(父|母|実父|実母|義父|義母|養父|養母)/.test(r) && !/(祖)/.test(r)) return "parent";
  if (/(兄|姉|弟|妹)/.test(r)) return "sibling";
  return "other";
}

function inferGender(rel: string, fallback?: string | null): "男" | "女" | "?" {
  const r = rel.replace(/\s+/g, "");
  if (/(夫|父|息子|長男|次男|三男|四男|男子|兄|弟|祖父|養父|義父|実父)/.test(r)) return "男";
  if (/(妻|母|娘|長女|次女|三女|四女|女子|姉|妹|祖母|養母|義母|実母)/.test(r)) return "女";
  if (fallback === "男" || fallback === "女") return fallback;
  return "?";
}

function isDeceased(rel: string): boolean {
  return /(故|死亡|†)/.test(rel);
}

function memberToNode(m: FamilyMember, idx: number): Node {
  const role = inferRole(m.relationship);
  const gender = inferGender(m.relationship);
  return {
    id: `m${idx}`,
    name: m.name || "",
    gender,
    role,
    isPrimaryCaregiver: !!m.is_primary_caregiver,
    living: (m.living as "同" | "別" | "") ?? "",
    relationship: m.relationship,
    deceased: isDeceased(m.relationship),
  };
}

// 男=四角 女=円 ?=ひし形 を SVG パスで描画
function PersonShape({
  cx,
  cy,
  size = 28,
  gender,
  isSelf,
  deceased,
  living,
}: {
  cx: number;
  cy: number;
  size?: number;
  gender: "男" | "女" | "?";
  isSelf: boolean;
  deceased: boolean;
  living: "同" | "別" | "";
}) {
  const stroke = "#000";
  const strokeWidth = isSelf ? 2.5 : 1.5;
  const dashArray = living === "別" ? "4 2" : undefined;
  const half = size / 2;

  return (
    <g>
      {gender === "男" && (
        <rect
          x={cx - half}
          y={cy - half}
          width={size}
          height={size}
          fill="#fff"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray}
        />
      )}
      {gender === "女" && (
        <circle
          cx={cx}
          cy={cy}
          r={half}
          fill="#fff"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray}
        />
      )}
      {gender === "?" && (
        <polygon
          points={`${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`}
          fill="#fff"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray}
        />
      )}
      {/* 本人マーク: 内側に二重 */}
      {isSelf && gender === "男" && (
        <rect
          x={cx - half + 4}
          y={cy - half + 4}
          width={size - 8}
          height={size - 8}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
        />
      )}
      {isSelf && gender === "女" && (
        <circle cx={cx} cy={cy} r={half - 4} fill="none" stroke={stroke} strokeWidth={1} />
      )}
      {/* 死亡: 斜線 */}
      {deceased && (
        <line
          x1={cx - half}
          y1={cy - half}
          x2={cx + half}
          y2={cy + half}
          stroke={stroke}
          strokeWidth={1.5}
        />
      )}
    </g>
  );
}

export function Genogram({ userName, userGender, members }: GenogramProps) {
  // ──── ノード分類 ────
  const nodes: Node[] = members
    .filter((m) => m.name || m.relationship)
    .map((m, i) => memberToNode(m, i));

  // 利用者本人ノードを先頭に挿入
  const selfNode: Node = {
    id: "self",
    name: userName || "本人",
    gender: (userGender === "男" || userGender === "女" ? userGender : "?") as Node["gender"],
    role: "self",
    isPrimaryCaregiver: false,
    living: "同",
    relationship: "本人",
    deceased: false,
  };

  const spouses = nodes.filter((n) => n.role === "spouse");
  const children = nodes.filter((n) => n.role === "child");
  const parents = nodes.filter((n) => n.role === "parent");
  const siblings = nodes.filter((n) => n.role === "sibling");
  const others = nodes.filter((n) => n.role === "other");

  // ──── レイアウト計算 ────
  const W = 480;
  const H = 280;
  const centerX = W / 2;
  const selfY = H / 2;
  const parentY = selfY - 90;
  const childY = selfY + 90;
  const NODE_W = 60;

  // 本人 + 配偶者 + 兄弟 を中段に並べる
  const middleRow: Node[] = [...siblings, selfNode, ...spouses];
  const middleStartX = centerX - ((middleRow.length - 1) * NODE_W) / 2;

  // 子は中段（self+spouse 中央）の下に並べる
  const selfIdxInMiddle = middleRow.findIndex((n) => n.id === "self");
  const selfX = middleStartX + selfIdxInMiddle * NODE_W;
  const spouseX = spouses.length > 0 ? selfX + NODE_W : selfX;
  const coupleCenterX = spouses.length > 0 ? (selfX + spouseX) / 2 : selfX;

  const childStartX = coupleCenterX - ((children.length - 1) * NODE_W) / 2;

  // 親は本人の上中央
  const parentStartX = centerX - ((parents.length - 1) * NODE_W) / 2;

  return (
    <div className="border border-gray-300 rounded bg-white p-2">
      <div className="text-[10px] text-gray-500 mb-1">
        家族構成図（自動生成・続柄から推定）
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxHeight: 300 }}>
        {/* 親と本人を結ぶ縦線 */}
        {parents.length > 0 && (
          <>
            {/* 親同士の横線 */}
            {parents.length > 1 && (
              <line
                x1={parentStartX}
                y1={parentY}
                x2={parentStartX + (parents.length - 1) * NODE_W}
                y2={parentY}
                stroke="#000"
                strokeWidth={1}
              />
            )}
            {/* 親→本人 縦線 */}
            <line
              x1={centerX}
              y1={parentY + 14}
              x2={centerX}
              y2={selfY - 14}
              stroke="#000"
              strokeWidth={1}
            />
          </>
        )}

        {/* 親 */}
        {parents.map((p, i) => {
          const x = parentStartX + i * NODE_W;
          return (
            <g key={p.id}>
              <PersonShape
                cx={x}
                cy={parentY}
                gender={p.gender}
                isSelf={false}
                deceased={p.deceased}
                living={p.living}
              />
              <text x={x} y={parentY + 26} textAnchor="middle" fontSize="9" fill="#333">
                {p.name || p.relationship}
              </text>
            </g>
          );
        })}

        {/* 中段（本人 + 配偶者 + 兄弟） */}
        {middleRow.map((n, i) => {
          const x = middleStartX + i * NODE_W;
          return (
            <g key={n.id}>
              <PersonShape
                cx={x}
                cy={selfY}
                gender={n.gender}
                isSelf={n.id === "self"}
                deceased={n.deceased}
                living={n.living}
              />
              <text x={x} y={selfY + 26} textAnchor="middle" fontSize="9" fill={n.id === "self" ? "#1d4ed8" : "#333"} fontWeight={n.id === "self" ? "bold" : "normal"}>
                {n.name || n.relationship}
              </text>
              {n.isPrimaryCaregiver && (
                <text x={x + 16} y={selfY - 12} fontSize="11" fill="#dc2626">
                  ★
                </text>
              )}
            </g>
          );
        })}

        {/* 配偶者と本人をつなぐ横線 */}
        {spouses.length > 0 && (
          <line
            x1={selfX + 14}
            y1={selfY}
            x2={spouseX - 14}
            y2={selfY}
            stroke="#000"
            strokeWidth={1.5}
          />
        )}

        {/* 子と親(夫婦)をつなぐ縦線 */}
        {children.length > 0 && (
          <>
            <line
              x1={coupleCenterX}
              y1={selfY + 14}
              x2={coupleCenterX}
              y2={childY - 30}
              stroke="#000"
              strokeWidth={1}
            />
            {children.length > 1 && (
              <line
                x1={childStartX}
                y1={childY - 30}
                x2={childStartX + (children.length - 1) * NODE_W}
                y2={childY - 30}
                stroke="#000"
                strokeWidth={1}
              />
            )}
            {children.map((_, i) => (
              <line
                key={`v${i}`}
                x1={childStartX + i * NODE_W}
                y1={childY - 30}
                x2={childStartX + i * NODE_W}
                y2={childY - 14}
                stroke="#000"
                strokeWidth={1}
              />
            ))}
          </>
        )}

        {/* 子 */}
        {children.map((c, i) => {
          const x = childStartX + i * NODE_W;
          return (
            <g key={c.id}>
              <PersonShape
                cx={x}
                cy={childY}
                gender={c.gender}
                isSelf={false}
                deceased={c.deceased}
                living={c.living}
              />
              <text x={x} y={childY + 26} textAnchor="middle" fontSize="9" fill="#333">
                {c.name || c.relationship}
              </text>
              {c.isPrimaryCaregiver && (
                <text x={x + 16} y={childY - 12} fontSize="11" fill="#dc2626">
                  ★
                </text>
              )}
            </g>
          );
        })}

        {/* その他の親族（右下に列挙） */}
        {others.length > 0 && (
          <g transform={`translate(${W - 110}, 20)`}>
            <text x={0} y={0} fontSize="9" fill="#666">その他の親族</text>
            {others.map((o, i) => (
              <g key={o.id} transform={`translate(0, ${10 + i * 22})`}>
                <PersonShape cx={12} cy={8} size={16} gender={o.gender} isSelf={false} deceased={o.deceased} living={o.living} />
                <text x={26} y={12} fontSize="9" fill="#333">
                  {(o.name || "") + (o.relationship ? ` (${o.relationship})` : "")}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[9px] text-gray-500">
        <span>□ 男性</span>
        <span>○ 女性</span>
        <span>二重線=本人</span>
        <span>破線=別居</span>
        <span>★=主たる介護者</span>
        <span>斜線=死亡</span>
      </div>
    </div>
  );
}
