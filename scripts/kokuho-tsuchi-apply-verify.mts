/**
 * 国保連 通知ファイル取込 (kokuho-tsuchi/apply.ts) の検証
 *
 * ⚠⚠⚠ モックなので実データでは一度も通っていない ⚠⚠⚠
 *   parse.ts は migrations/test_kokuho_tsuchi_parse.mjs が仕様書由来の fixture で検証済み (ALL OK)。
 *   だがそちらは apply.ts の DB 反映ロジック (返戻フラグ / 支払決定額 / 冪等性) を一度も通していない。
 *   このスクリプトは Supabase を完全にモックし、apply.ts の純粋な分岐を決定的に検証する。
 *   ★ 実ファイルは repo 内・伝送データ配下のどこにも見つからなかった (2026-09-05 grep 済。
 *     `74*.CSV`/`75*.CSV`/`72*.CSV` 系のファイル名は 0 件)。旗振り役も同様に未発見と報告済み。
 *   → 実ファイル取込の初回は必ずプレビューで目視確認すること (apply.ts 冒頭のコメントどおり)。
 *
 * 使い方: npx tsx scripts/kokuho-tsuchi-apply-verify.mts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveClientsByInsuredNumber,
  saveNoticeFile,
  applyHenreiFlags,
  applyShiharaiKettei,
  markRowsApplied,
} from "../src/lib/kokuho-tsuchi/apply";
import type { ParsedNoticeFile, ShiharaiKettei, HenreiRow } from "../src/lib/kokuho-tsuchi/parse";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};
const eq = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(label, a === e, `期待: ${e}\n         実際: ${a}`);
};

/* ══════════════════════ モック Supabase (§A: bath-seikyu-verify.mts と同じ形) ══════════════════════ */

type Row = Record<string, unknown>;

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}
function parseLeaf(leaf: string): (r: Row) => boolean {
  const parts = leaf.split(".");
  const field = parts[0];
  if (parts[1] === "eq") {
    const raw = parts.slice(2).join(".");
    const val: unknown = raw === "true" ? true : raw === "false" ? false : raw;
    return (r) => r[field] === val;
  }
  if (parts[1] === "not" && parts[2] === "is" && parts[3] === "null") {
    return (r) => r[field] != null;
  }
  throw new Error("未対応の or 式 (モック側の限界): " + leaf);
}
function parseOrExpr(expr: string): (r: Row) => boolean {
  const clauses = splitTopLevel(expr);
  const fns = clauses.map((c) => {
    if (c.startsWith("and(") && c.endsWith(")")) {
      const subFns = splitTopLevel(c.slice(4, -1)).map(parseLeaf);
      return (r: Row) => subFns.every((f) => f(r));
    }
    return parseLeaf(c);
  });
  return (r: Row) => fns.some((f) => f(r));
}

function tableBuilder(rows: Row[], opts?: { genId?: () => string }) {
  const preds: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "update" | "upsert" = "select";
  let payload: unknown = null;
  let single: "one" | "maybe" | null = null;

  const b: Record<string, unknown> = {
    select: () => b,
    eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return b; },
    in: (col: string, vals: unknown[]) => { preds.push((r) => vals.includes(r[col])); return b; },
    or: (expr: string) => { preds.push(parseOrExpr(expr)); return b; },
    order: () => b,
    range: () => b,
    limit: () => b,
    maybeSingle: () => { single = "maybe"; return b; },
    single: () => { single = "one"; return b; },
    insert: (p: unknown) => { op = "insert"; payload = p; return b; },
    update: (p: unknown) => { op = "update"; payload = p; return b; },
    upsert: (p: unknown, o?: { onConflict?: string }) => { op = "upsert"; payload = { rows: p, onConflict: o?.onConflict }; return b; },
    then: (res: (v: { data: unknown; error: null }) => unknown) => {
      if (op === "insert") {
        const arr = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted = arr.map((r) => ({ id: opts?.genId?.(), ...r }));
        rows.push(...inserted);
        return res({ data: single ? inserted[0] : inserted, error: null });
      }
      if (op === "update") {
        const targets = rows.filter((r) => preds.every((p) => p(r)));
        for (const t of targets) Object.assign(t, payload as Row);
        return res({ data: null, error: null });
      }
      if (op === "upsert") {
        const { rows: newRows, onConflict } = payload as { rows: Row[]; onConflict: string };
        const keys = onConflict.split(",");
        for (const nr of newRows) {
          const existing = rows.find((r) => keys.every((k) => r[k] === nr[k]));
          if (existing) Object.assign(existing, nr);
          else rows.push({ ...nr });
        }
        return res({ data: null, error: null });
      }
      const data = rows.filter((r) => preds.every((p) => p(r)));
      if (single === "maybe") return res({ data: data[0] ?? null, error: null });
      if (single === "one") return res({ data: data[0], error: null });
      return res({ data, error: null });
    },
  };
  return b;
}

interface Db {
  clients: Row[];
  clientInsurance: Row[];
  billingStatus: Row[];
  nyukin: Row[];
  noticeRows: Row[];
  noticeFiles: Row[];
}
function makeMockSupabase(db: Db): SupabaseClient {
  let nyukinSeq = 1, fileSeq = 1;
  const from = (table: string) => {
    switch (table) {
      case "clients": return tableBuilder(db.clients);
      case "client_insurance_records": return tableBuilder(db.clientInsurance);
      case "kaigo_billing_status": return tableBuilder(db.billingStatus);
      case "kokuho_nyukin_records": return tableBuilder(db.nyukin, { genId: () => `nyukin-${nyukinSeq++}` });
      case "kokuho_shinsa_notice_files": return tableBuilder(db.noticeFiles, { genId: () => `file-${fileSeq++}` });
      case "kokuho_shinsa_notice_rows": return tableBuilder(db.noticeRows);
      default: return tableBuilder([]);
    }
  };
  return { from } as unknown as SupabaseClient;
}
function freshDb(): Db {
  return { clients: [], clientInsurance: [], billingStatus: [], nyukin: [], noticeRows: [], noticeFiles: [] };
}

const TENANT = "t1", OFFICE = "office-1";

/* ══════════════════════ §A 被保険者番号 → client 突合 ══════════════════════ */
console.log("\n=== §A 被保険者番号突合 (clients優先 / client_insurance_records フォールバック) ===");
async function testResolve() {
  const db = freshDb();
  db.clients.push(
    { id: "c1", name: "甲野太郎", insured_number: "1001" },
    { id: "c2", name: "乙野花子", insured_number: null },
  );
  db.clientInsurance.push({ client_id: "c2", insured_number: "2002" });
  const sb = makeMockSupabase(db);
  const result = await resolveClientsByInsuredNumber(sb, ["1001", "2002", "9999"]);

  eq("clients 優先で解決 (1001→c1)", result.get("1001"), { clientId: "c1", name: "甲野太郎", source: "clients" });
  eq("フォールバックで解決 (2002→c2)", result.get("2002"), { clientId: "c2", name: "乙野花子", source: "insurance_records" });
  check("突合できない番号 (9999) は Map に無い", !result.has("9999"));
  eq("Map サイズは解決できた 2 件のみ", result.size, 2);
}
await testResolve();

/* ══════════════════════ §B saveNoticeFile — 未突合行が黙って消えないか ══════════════════════ */
console.log("\n=== §B saveNoticeFile — 未突合行は match_status='unmatched' で残る (silent drop 禁止) ===");
async function testSaveNoticeFile() {
  const db = freshDb();
  const sb = makeMockSupabase(db);

  const henreiRowMatched: HenreiRow = {
    rowIndex: 2, insurerNumber: "122069", insurerName: "木更津市", insuredNumber: "1001",
    kanaName: "ｺｳﾉﾀﾛｳ", shubetsu: "請", serviceYm: "2026-06", serviceKindCode: "11",
    tanisu: -1000, jiyuCode: "C", jiyuNaiyo: "突合エラー", biko: "", serviceItemCode: null,
  };
  const henreiRowUnmatched: HenreiRow = {
    rowIndex: 3, insurerNumber: "122069", insurerName: "木更津市", insuredNumber: "9999",
    kanaName: "ﾐﾂｺﾞｳﾋﾃﾞｵ", shubetsu: "給", serviceYm: "2026-06", serviceKindCode: "11",
    tanisu: -500, jiyuCode: "D", jiyuNaiyo: "給付管理未提出", biko: "", serviceItemCode: null,
  };
  const parsed: ParsedNoticeFile = {
    fileName: "KJ_dummy.CSV",
    control: { dataType: "741", officeNumber: "1234567890", insurerNumber: "0", mediaKubun: "1", processYm: "2026-06", recordCount: 2 },
    rawRecords: [
      { rowIndex: 2, exchangeNumber: "7411", recordKind: "D1", noticeKind: "henrei", fields: [] },
      { rowIndex: 3, exchangeNumber: "7411", recordKind: "D1", noticeKind: "henrei", fields: [] },
    ],
    henreiHeaders: [], henreiRows: [henreiRowMatched, henreiRowUnmatched],
    shiharaiKettei: [], uchiwakeHeaders: [], uchiwakeRows: [], uchiwakeTrailers: [],
    zougenHeaders: [], zougenRows: [], zougenTrailers: [], unsupported: [],
    shinsaYm: "2026-06", headerOfficeNumber: "1234567890", warnings: [],
  };
  const matches = new Map([["1001", { clientId: "c1", name: "甲野太郎", source: "clients" as const }]]);

  const result = await saveNoticeFile(sb, { tenantId: TENANT, officeId: OFFICE, parsed, rawContent: "dummy", matches });
  eq("2 行とも保存される (行が消えない)", db.noticeRows.length, 2);
  const matchedRow = db.noticeRows.find((r) => r.insured_number === "1001");
  const unmatchedRow = db.noticeRows.find((r) => r.insured_number === "9999");
  eq("突合できた行は client_id が入る", matchedRow?.client_id, "c1");
  eq("突合できた行は match_status=matched", matchedRow?.match_status, "matched");
  check("未突合行も残る (undefined ではない)", unmatchedRow !== undefined);
  eq("未突合行は client_id=null (捨てられず、null 明示)", unmatchedRow?.client_id, null);
  eq("未突合行は match_status=unmatched (na のまま握りつぶされない)", unmatchedRow?.match_status, "unmatched");
  check("rowCount はファイル全行数と一致", result.rowCount === 2);
}
await testSaveNoticeFile();

/* ══════════════════════ §C 返戻フラグ (applyHenreiFlags) — 冪等性 ══════════════════════ */
console.log("\n=== §C applyHenreiFlags — 同じ通知を2回取り込んでも notes が重複しないか ===");
async function testHenreiIdempotent() {
  const db = freshDb();
  const sb = makeMockSupabase(db);
  const row: HenreiRow = {
    rowIndex: 2, insurerNumber: "122069", insurerName: "木更津市", insuredNumber: "1001",
    kanaName: "ｺｳﾉﾀﾛｳ", shubetsu: "請", serviceYm: "2026-06", serviceKindCode: "11",
    tanisu: -1000, jiyuCode: "C", jiyuNaiyo: "突合・査定エラー", biko: "保留", serviceItemCode: null,
  };
  const entries = [{ clientId: "c1", clientName: "甲野太郎", targetMonth: "2026-06", row }];

  const r1 = await applyHenreiFlags(sb, { tenantId: TENANT, officeId: OFFICE, shinsaYm: "2026-06", entries });
  eq("1回目: applied=1 / alreadyFlagged=0", r1, { applied: 1, alreadyFlagged: 0 });
  check("1回目で henrei=true になる", db.billingStatus[0]?.henrei === true);
  const notesAfter1 = String(db.billingStatus[0]?.notes ?? "");
  const marker = "[返戻取込 2026-06審査]";
  check("notes にマーカーが1回だけ入る", notesAfter1.split(marker).length - 1 === 1);

  // 同じ通知をもう一度取り込む (冪等性)
  const r2 = await applyHenreiFlags(sb, { tenantId: TENANT, officeId: OFFICE, shinsaYm: "2026-06", entries });
  eq("2回目: applied=1 / alreadyFlagged=1 (既に立っていたと分かる)", r2, { applied: 1, alreadyFlagged: 1 });
  eq("行数は増えない (upsert)", db.billingStatus.length, 1);
  const notesAfter2 = String(db.billingStatus[0]?.notes ?? "");
  check("2回目でも notes は重複しない (同一事由の再追記なし)", notesAfter2.split(marker).length - 1 === 1,
    `notes: ${notesAfter2}`);

  // 既存の他フラグ (tsukiokure/kago) が upsert で消されないか
  db.billingStatus[0] = { ...db.billingStatus[0], tsukiokure: true, kago: true };
  await applyHenreiFlags(sb, { tenantId: TENANT, officeId: OFFICE, shinsaYm: "2026-06", entries });
  check("upsert しても他の列 (tsukiokure/kago) は保持される (列を渡さないので上書きされない)",
    db.billingStatus[0]?.tsukiokure === true && db.billingStatus[0]?.kago === true);
}
await testHenreiIdempotent();

/* ══════════════════════ §D 支払決定額 (applyShiharaiKettei) — insert→update経路 + 冪等性 ══════════════════════ */
console.log("\n=== §D applyShiharaiKettei — 新規作成→更新の経路 + 冪等性 ===");
function makeKettei(overrides: Partial<ShiharaiKettei>): ShiharaiKettei {
  return {
    rowIndex: 1, exchangeNumber: "7511", shinsaYm: "2026-06", zipcode: "290-0000",
    address: "千葉県市原市○○1-1", officeName: "テスト事業所", kaisetsusha: "テスト太郎",
    officeNumber: "1234567890", furikomiAmount: 500000, kaigoKyufuhiAmount: 495000,
    shujiiIkensho: null, shujiiIkenshoTax: null, ninteiChousa: null, ninteiChousaTax: null,
    sougouJigyouhi: null, denshiShoumeisho: null, goukeiAmount: 500000,
    bankName: "○○銀行", branchName: "△△支店", furikomiDate: "20260810", kokuhoName: "千葉県国保連合会",
    ...overrides,
  };
}
async function testKetteiIdempotent() {
  const db = freshDb();
  const sb = makeMockSupabase(db);
  const notice = makeKettei({});

  const r1 = await applyShiharaiKettei(sb, { tenantId: TENANT, officeId: OFFICE, notices: [notice] });
  eq("1回目: 請求スナップショット未登録月なので inserted=1 / updated=0", r1, { updated: 0, inserted: 1 });
  eq("nyukin 行が1件でき、kettei_amount が入る", db.nyukin[0]?.kettei_amount, 500000);
  eq("seikyu_amount は 0 のまま (未登録月の目印)", db.nyukin[0]?.seikyu_amount, 0);
  eq("nyukin_date は YYYYMMDD→YYYY-MM-DD に変換される", db.nyukin[0]?.nyukin_date, "2026-08-10");

  // 同じ通知をもう一度取り込む (冪等性: 既存行があるので今度は update 経路)
  const r2 = await applyShiharaiKettei(sb, { tenantId: TENANT, officeId: OFFICE, notices: [notice] });
  eq("2回目: 既存行が見つかるので updated=1 / inserted=0", r2, { updated: 1, inserted: 0 });
  eq("nyukin 行は増えない (office_id+target_month で一意)", db.nyukin.length, 1);
  const notesAfter2 = String(db.nyukin[0]?.notes ?? "");
  const noteText = "[支払決定取込] 給付費495000円 / 合計500000円 / ○○銀行 △△支店";
  check("2回目でも notes は重複しない", notesAfter2.split(noteText).length - 1 === 1, `notes: ${notesAfter2}`);
}
await testKetteiIdempotent();

/* ══════════════════════ §E 金額の境界値 (0円 / マイナス / 過誤決定) ══════════════════════ */
console.log("\n=== §E 金額境界値 (0円 / マイナス / null) ===");
async function testAmountEdgeCases() {
  {
    const db = freshDb();
    const sb = makeMockSupabase(db);
    const notice = makeKettei({ shinsaYm: "2026-07", furikomiAmount: 0, kaigoKyufuhiAmount: 0, goukeiAmount: 0 });
    let threw = false;
    try { await applyShiharaiKettei(sb, { tenantId: TENANT, officeId: OFFICE, notices: [notice] }); }
    catch { threw = true; }
    check("振込金額 0円 は例外にならない (0 は falsy だが null チェックのみなので通る)", !threw);
    eq("kettei_amount=0 がそのまま入る", db.nyukin[0]?.kettei_amount, 0);
  }
  {
    // ⚠ 過誤決定の逆仕訳は「マイナス金額の 7511/7513」として来る可能性がある。
    //   parse.ts の num() は /^[+-]?\d+$/ で符号付きに対応済みなので、パース自体は通る。
    //   だが ShiharaiKettei 型に「これは過誤取消です」という決定区分フィールドは無い —
    //   通常の支払決定と構造上見分けが付かない (仕様書 (_if_kyotaku.txt 項3-19) にも
    //   決定区分に相当する項目が無いため、実装漏れではなく仕様上の制約)。
    const db = freshDb();
    const sb = makeMockSupabase(db);
    const notice = makeKettei({ shinsaYm: "2026-07", furikomiAmount: -50000, kaigoKyufuhiAmount: -50000, goukeiAmount: -50000 });
    let threw = false;
    try { await applyShiharaiKettei(sb, { tenantId: TENANT, officeId: OFFICE, notices: [notice] }); }
    catch { threw = true; }
    check("振込金額マイナス (過誤取消想定) も例外にならない", !threw);
    eq("kettei_amount=-50000 がそのまま入る (符号はそのまま保存)", db.nyukin[0]?.kettei_amount, -50000);
  }
  {
    const db = freshDb();
    const sb = makeMockSupabase(db);
    const notice = makeKettei({ furikomiAmount: null });
    let msg = "";
    try { await applyShiharaiKettei(sb, { tenantId: TENANT, officeId: OFFICE, notices: [notice] }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    check("振込金額 null は例外になる (silent skip されない)", msg.includes("振込金額が読み取れません"), `msg: ${msg}`);
  }
  {
    const db = freshDb();
    const sb = makeMockSupabase(db);
    const notice = makeKettei({ shinsaYm: null });
    let msg = "";
    try { await applyShiharaiKettei(sb, { tenantId: TENANT, officeId: OFFICE, notices: [notice] }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    check("審査年月 null も例外になる (target_month が無いと nyukin に書けないため)", msg.includes("審査年月が読み取れません"), `msg: ${msg}`);
  }
}
await testAmountEdgeCases();

/* ══════════════════════ §F markRowsApplied — applied マークの条件・冪等性 ══════════════════════ */
console.log("\n=== §F markRowsApplied — 条件を満たす行だけ applied になるか / 2回実行しても壊れないか ===");
async function testMarkRowsApplied() {
  const db = freshDb();
  const sb = makeMockSupabase(db);
  db.noticeRows.push(
    { file_id: "f1", notice_type: "henrei", match_status: "matched", record_kind: "D1", service_ym: "2026-06", applied: false, applied_at: null },
    { file_id: "f1", notice_type: "henrei", match_status: "unmatched", record_kind: "D1", service_ym: "2026-06", applied: false, applied_at: null },
    { file_id: "f1", notice_type: "henrei", match_status: "matched", record_kind: "D1", service_ym: null, applied: false, applied_at: null },
    { file_id: "f1", notice_type: "shiharai_kettei", match_status: "na", record_kind: "H1", service_ym: null, applied: false, applied_at: null },
  );
  await markRowsApplied(sb, "f1");
  const [matchedOk, unmatched, matchedNoYm, kettei] = db.noticeRows;
  check("突合済み+D1+提供年月ありは applied=true", matchedOk.applied === true);
  check("未突合は applied のまま false (billing_status に反映していないので付けない)", unmatched.applied === false);
  check("突合済みでも提供年月が無い行は applied=false (反映をスキップした行に付けない)", matchedNoYm.applied === false);
  check("支払決定額は無条件で applied=true", kettei.applied === true);

  // 2回目 (冪等性): 同じ file_id にもう一度マークしても状態は変わらない・壊れない
  let threw = false;
  try { await markRowsApplied(sb, "f1"); } catch { threw = true; }
  check("2回実行してもエラーにならない", !threw);
  check("2回目後も条件を満たす行は applied=true のまま", matchedOk.applied === true && kettei.applied === true);
  check("2回目後も条件を満たさない行は変化しない", unmatched.applied === false && matchedNoYm.applied === false);
}
await testMarkRowsApplied();

/* ══════════════════════ 結果 ══════════════════════ */
console.log(`\n${"=".repeat(70)}`);
console.log(`結果: ${pass} OK / ${fail} FAIL`);
console.log("⚠⚠⚠ 上記は全てモック (Supabase 呼出をメモリ内配列に差し替え)。実データでは一度も通っていない ⚠⚠⚠");
console.log("⚠ 実ファイル (7411/7511/7513/7521/7211) は repo 内に見つからなかった (2026-09-05 grep 済)。");
console.log("⚠ 見つかった論点 (コード修正ではなく記録): 過誤決定 (取消) の通知は仕様書上も");
console.log("  『決定区分』のような専用フィールドが無く、マイナス金額の通常通知と構造上区別できない。");
console.log("  実ファイルが手に入った際は、過誤取消の実例が来たときに kettei_amount がどう変わるか要目視確認。");
if (fail > 0) process.exit(1);
