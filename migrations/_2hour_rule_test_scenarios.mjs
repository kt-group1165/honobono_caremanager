// ============================================================================
// 障害福祉「2時間ルール」合算ロジック検証用シナリオ定義。
//   seed / run / verify / delete の各 script から共有する。
//
//   対象ロジック: import_meisai_shougai_records.mjs の
//     buildDailySessions (654〜695行目) / convertSession (700〜753行目)
//   判定規則 (コード実装どおり):
//     同一職員: gap <= MERGE_GAP_MINUTES-1 (既定120-1=119) → 合算   (実質「120分未満」)
//     別職員  : gap <= MERGE_GAP_DIFF_STAFF_MINUTES (既定60)   → 合算   (「60分以下」)
//   全シナリオ 身体介護(021001)・日中(08-18)内・1visit=30分 に統一し、
//   合算後コードが 身体日０．５/１．０/１．５ (111111/111115/111119) の3種に収まるようにした。
// ============================================================================

export const CLIENT_NAME = "検証花子";
export const CLIENT_NUM = "9999001"; // MEISAI 利用者番号 (任意の値でよい)
export const STAFF_A = "検証職員A";
export const STAFF_B = "検証職員B";

// hh:mm(文字列) を分に変換 / 分→hh:mm
function toMin(hm) { const [h, m] = hm.split(":").map(Number); return h * 60 + m; }
function toHM(min) { return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`; }
function addMin(hm, min) { return toHM(toMin(hm) + min); }

// 各シナリオ: visits = [{staff, start, gapAfterPrevEnd}] (先頭は gapAfterPrevEnd 不要)
// 各 visit は固定 30 分。gap は「直前 visit の終了」から「この visit の開始」までの分。
const RAW = [
  // ── 同一職員: 120分しきい値の境界 (実装は 119 以下で合算) ──
  { id: "S-A", date: "2026-06-01", desc: "同一職員 gap=59分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 59 }] },
  { id: "S-B", date: "2026-06-02", desc: "同一職員 gap=60分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 60 }] },
  { id: "S-C", date: "2026-06-03", desc: "同一職員 gap=61分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 61 }] },
  { id: "S-D", date: "2026-06-04", desc: "同一職員 gap=119分 (期待:合算・境界ぎりぎり)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 119 }] },
  { id: "S-E", date: "2026-06-05", desc: "同一職員 gap=120分 (期待:合算しない・境界)", expectMerge: [false],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 120 }] },
  { id: "S-F", date: "2026-06-06", desc: "同一職員 gap=121分 (期待:合算しない)", expectMerge: [false],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 121 }] },

  // ── 別職員: 60分しきい値の境界 (実装は 60 以下で合算=inclusive) ──
  { id: "D-A", date: "2026-06-07", desc: "別職員 gap=29分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 29 }] },
  { id: "D-B", date: "2026-06-08", desc: "別職員 gap=30分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 30 }] },
  { id: "D-C", date: "2026-06-09", desc: "別職員 gap=31分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 31 }] },
  { id: "D-D", date: "2026-06-10", desc: "別職員 gap=59分 (期待:合算)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 59 }] },
  { id: "D-E", date: "2026-06-11", desc: "別職員 gap=60分 (期待:合算・境界。同一職員と閾値の扱いが違う)", expectMerge: [true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 60 }] },
  { id: "D-F", date: "2026-06-12", desc: "別職員 gap=61分 (期待:合算しない・境界)", expectMerge: [false],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 61 }] },

  // ── 3セッション以上 (コード内コメントで「未検証」と自己申告されている箇所) ──
  { id: "T-A", date: "2026-06-13", desc: "3件連続・同一職員 gap 119/119 (期待:全て合算=1セッション)",
    expectMerge: [true, true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 119 }, { staff: STAFF_A, gap: 119 }] },
  { id: "T-B", date: "2026-06-14", desc: "3件連続・職員交代 A→B→A gap 30/45 (期待:全て合算。判定は直前1件の職員とのみ比較)",
    expectMerge: [true, true],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_B, gap: 30 }, { staff: STAFF_A, gap: 45 }] },
  { id: "T-C", date: "2026-06-15", desc: "3件・前半合算/後半分離 (同職員gap100→合算、次に別職員gap65→非合算で3件目は単独)",
    expectMerge: [true, false],
    visits: [{ staff: STAFF_A, start: "09:00" }, { staff: STAFF_A, gap: 100 }, { staff: STAFF_B, gap: 65 }] },
];

// 実時刻を展開し、各 visit に {start,end} を確定する
export const SCENARIOS = RAW.map((sc) => {
  const visits = [];
  let prevEnd = null;
  for (const v of sc.visits) {
    const start = v.start ?? addMin(prevEnd, v.gap);
    const end = addMin(start, 30); // 全 visit 固定 30 分
    visits.push({ staff: v.staff, start, end, gapBefore: v.gap ?? null });
    prevEnd = end;
  }
  // expectMerge[i] = visits[i] と visits[i+1] が同一セッションに入るか
  // → セッション分割を算出 (グルーピング)
  const groups = [[0]];
  for (let i = 0; i < sc.expectMerge.length; i++) {
    if (sc.expectMerge[i]) groups[groups.length - 1].push(i + 1);
    else groups.push([i + 1]);
  }
  // 合算後の合計分数 → 期待コード名 (身体のみ・30分刻み・honobono=ceil)
  const codeForMinutes = (min) => {
    const hours = Math.ceil(min / 30) * 0.5;
    return hours === 0.5 ? "身体日０．５" : hours === 1.0 ? "身体日１．０" : hours === 1.5 ? "身体日１．５" : `身体日${hours.toFixed(1)}(未定義)`;
  };
  const expectedGroups = groups.map((idxs) => {
    const totalMin = idxs.length * 30;
    return {
      memberIdx: idxs,
      merged: idxs.length >= 2,
      code: codeForMinutes(totalMin),
      repStaff: visits[idxs[0]].staff,
      repStart: visits[idxs[0]].start,
      repEnd: visits[idxs[0]].end,
    };
  });
  return { ...sc, visits, expectedGroups };
});
