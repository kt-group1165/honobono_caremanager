/**
 * 障害伝送 突合ハーネス (READ ONLY — DB 書込一切なし)
 *
 * 茂原・2026-06 の障害請求について、新システムの J11/J61/J41 をヘッドレス生成し
 * (アプリ起動せず build.ts / aggregate.ts を直接呼ぶ)、ほのぼのの正解伝送と
 * 受給者番号別にフィールド突合する。
 *
 * 実行:  npx tsx scripts/shogai-densou-diff.mts
 *   出力: 伝送データ/茂原/202606/障害/新システム/J11.../J61.../J41... (SJIS)
 *         + 標準出力に diff レポート
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";
import { getShogaiHomonUnitPrice } from "@/lib/shogai-seikyu/unit-price";
import { isAddonRecord, isSessionSubRecord } from "@/lib/shogai-seikyu/record-markers";
import {
  kindFromServiceName,
  loadShogaiCodeMaps,
  shogaiCodeFromTime,
} from "@/lib/shogai-seikyu/code-from-time";
import {
  isJuhoTierCode,
  loadJuhoTierByClient,
  loadJuhoTierMaps,
  remapJuhoCode,
} from "@/lib/shogai-seikyu/juho-tier";
import {
  aggregateMonthlyShogaiSeikyu,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";
import {
  buildShogaiDensou,
  type ShogaiDensouUser,
  type ShogaiDensouVisit,
  type ShogaiDensouKanriLine,
} from "@/lib/shogai-densou/build";
import { validInMonth } from "@/lib/service-code-valid";
import { loadContractsForMonth, loadServiceStartDates } from "@/lib/shogai-densou/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 対象 ─────────────────────────────────────────────────────────────────────
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。DENSOU_DIR も同じ月を指すこと。
const TARGET_MONTH = process.env.TARGET_MONTH || "2026-06";
const YEAR = Number(TARGET_MONTH.slice(0, 4));
const MONTH = Number(TARGET_MONTH.slice(5, 7));
// 事業所は env で切替 (既定 = リンクスヘルパーステーション(茂原))。
//   OFFICE_ID       … offices.id
//   SHOGAI_BN       … 障害の事業所番号 (介護とは別番号。伝送の制御レコードに出る)
//   DENSOU_DIR      … 伝送データ/ 以下の相対パス。正規形は <拠点>/訪問介護/障害/<YYYYMM> (既定 茂原/訪問介護/障害/202606)
const OFFICE_ID = process.env.OFFICE_ID || "e08c3706-ad59-4913-b4e2-67f2675422e9";
const FALLBACK_OFFICE_NUMBER = process.env.SHOGAI_BN || "1213100017";
// 伝送データ は apps/kaigo-app 直下 (= __dirname の 1 つ上)
//   DENSOU_DIR は 伝送データ/ 以下の相対パス (例 大網/障害/202606)。
//   事業所ごとにフォルダ構成が揃っていないため、丸ごと指定できるようにしている。
const DENSOU_BASE = process.env.DENSOU_DIR
  ? join(__dirname, "..", "伝送データ", ...process.env.DENSOU_DIR.split("/"))
  : join(__dirname, "..", "伝送データ", "茂原", "訪問介護", "障害", "202606");
const HONOBONO_DIR = join(DENSOU_BASE, "ほのぼのから");
/**
 * 同じ提供年月を後の請求サイクルで出し直した分 (過誤取下げ → 再請求 / 月遅れ)。
 * 当初請求と同じフォルダには置けない (KJ が 2 つになり突合が壊れる) ので別フォルダにする。
 * 例: 茂原 2026-06 は 7/10 に当初請求 (KJ260701)、狩野さんだけ 8/10 に再請求 (KJ260803)。
 */
const RECLAIM_DIR = join(DENSOU_BASE, "ほのぼのから_再請求");
const OUT_DIR = join(DENSOU_BASE, "新システム");

// ─── env ──────────────────────────────────────────────────────────────────────
function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envFile = loadEnvLocal();
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? envFile.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("env 不足: .env.local の SUPABASE URL/SERVICE_ROLE_KEY が必要");
  process.exit(1);
}
const supabase = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── loadMonthVisits (content.tsx から移植。DB 読み取りのみ) ──────────────────
async function loadMonthVisits(
  sb: SupabaseClient,
  officeId: string,
  y: number,
  m: number,
): Promise<Map<string, ShogaiDensouVisit[]>> {
  const mStr = `${y}-${String(m).padStart(2, "0")}`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const from = `${mStr}-01`;
  const to = `${mStr}-${String(daysInMonth).padStart(2, "0")}`;
  interface RawVisit {
    client: string;
    visit: ShogaiDensouVisit;
  }
  const recRows: RawVisit[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from("shogai_service_records")
      .select(
        "client_id, service_date, start_time, end_time, duration_minutes, service_category, service_code",
      )
      .eq("status", "confirmed")
      .gte("service_date", from)
      .lte("service_date", to)
      .or(`office_id.eq.${officeId},office_id.is.null`)
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error("実績取得失敗: " + error.message);
    const recs = (data ?? []) as {
      client_id: string;
      service_date: string;
      start_time: string | null;
      end_time: string | null;
      duration_minutes: number | null;
      service_category: string | null;
      service_code: string | null;
    }[];
    for (const rec of recs) {
      recRows.push({
        client: rec.client_id,
        visit: {
          date: rec.service_date,
          startTime: rec.start_time,
          endTime: rec.end_time,
          durationMinutes: rec.duration_minutes,
          category: rec.service_category,
          serviceCode: rec.service_code,
          serviceName: null,
        },
      });
    }
    if (recs.length < PAGE) break;
    offset += PAGE;
  }

  const schedRaw: RawVisit[] = [];
  {
    interface SchedRow {
      user_id: string;
      service_type: string | null;
      visit_date: string;
      start_time: string | null;
      end_time: string | null;
      notes: string | null;
      system?: string | null;
    }
    const schedRows: SchedRow[] = [];
    let soff = 0;
    let schedOk = true;
    while (true) {
      const { data, error } = await sb
        .from("kaigo_visit_schedule")
        .select("user_id, service_type, visit_date, start_time, end_time, notes, system")
        .eq("status", "completed")
        .gte("visit_date", from)
        .lte("visit_date", to)
        .or(`office_id.eq.${officeId},office_id.is.null`)
        .order("id")
        .range(soff, soff + PAGE - 1);
      if (error) {
        console.warn("[shogai] シフト実績の取得に失敗 (連携スキップ):", error.message);
        schedOk = false;
        break;
      }
      const rows = (data ?? []) as SchedRow[];
      schedRows.push(...rows.filter((s) => s.system !== "介護"));
      if (rows.length < PAGE) break;
      soff += PAGE;
    }
    if (schedOk && schedRows.length > 0) {
      const names = Array.from(
        new Set(schedRows.map((s) => (s.service_type ?? "").trim()).filter(Boolean)),
      );
      const nameMap = new Map<string, { code: string; category: string | null; name: string }>();
      for (let i = 0; i < names.length; i += 50) {
        const chunk = names.slice(i, i + 50);
        const { data, error } = await validInMonth(
          sb
            .from("kaigo_service_codes")
            .select("service_code, service_name, service_category")
            .eq("system", "障害")
            .in("service_name", chunk),
          y,
          m,
        );
        if (error) {
          console.warn("[shogai] 障害コード解決に失敗 (一部スキップ):", error.message);
          continue;
        }
        for (const c of (data ?? []) as {
          service_code: string;
          service_name: string;
          service_category: string | null;
        }[]) {
          const k = c.service_name.trim();
          if (!nameMap.has(k))
            nameMap.set(k, {
              code: c.service_code,
              category: c.service_category,
              name: c.service_name,
            });
        }
      }
      // 名前で引けない障害行は時刻からコードを引く (アプリ側と同じ関数)
      const needTimeResolve = schedRows.some(
        (s) => s.system === "障害" && !nameMap.has((s.service_type ?? "").trim()),
      );
      const timeMaps = needTimeResolve ? await loadShogaiCodeMaps(sb, y, m) : null;
      const diffMinutes = (s: string | null, e: string | null): number | null => {
        if (!s || !e) return null;
        const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        let d = toMin(e) - toMin(s);
        if (d < 0) d += 24 * 60;
        return d;
      };
      for (const s of schedRows) {
        const name = (s.service_type ?? "").trim();
        const mm = nameMap.get(name);
        let code: string;
        let category: string | null;
        let label: string;
        if (mm) {
          code = mm.code;
          category = mm.category;
          label = name;
        } else if (s.system === "障害" && timeMaps) {
          const kind = kindFromServiceName(name);
          const hit = kind
            ? shogaiCodeFromTime(timeMaps, kind, s.start_time, s.end_time, {
                minutes: diffMinutes(s.start_time, s.end_time) ?? undefined,
              })
            : null;
          if (!hit) continue;
          code = hit.code;
          category = null;
          label = hit.name;
        } else {
          continue;
        }
        schedRaw.push({
          client: s.user_id,
          visit: {
            date: s.visit_date,
            startTime: s.start_time,
            endTime: s.end_time,
            durationMinutes: diffMinutes(s.start_time, s.end_time),
            category,
            serviceCode: code,
            serviceName: label,
            isAddon: isAddonRecord(s.notes),
            isSessionSub: isSessionSubRecord(s.notes),
          },
        });
      }
    }
  }

  const keyOf = (r: RawVisit) => `${r.client}__${r.visit.serviceCode ?? ""}__${r.visit.date}`;
  const schedKeys = new Set(schedRaw.map(keyOf));
  const merged = [...recRows.filter((r) => !schedKeys.has(keyOf(r))), ...schedRaw];

  // 重度訪問介護の段 (Ⅰ/Ⅱ/Ⅲ) を支給決定から決め直す (集計 aggregate.ts と同じロジック)。
  // シフトのサービス名は全件「重訪Ⅱ…」で段の情報を持っていないため名前からは読まない。
  {
    const tierMaps = await loadJuhoTierMaps(sb, y, m);
    if (merged.some((r) => isJuhoTierCode(tierMaps, r.visit.serviceCode))) {
      const ids = Array.from(
        new Set(
          merged.filter((r) => isJuhoTierCode(tierMaps, r.visit.serviceCode)).map((r) => r.client),
        ),
      );
      const { tierByClient, warnings } = await loadJuhoTierByClient(sb, ids, y, m, { officeId });
      for (const w of warnings) console.warn("  [重訪] " + w);
      for (let i = merged.length - 1; i >= 0; i--) {
        const v = merged[i].visit;
        if (!isJuhoTierCode(tierMaps, v.serviceCode)) continue;
        const tier = tierByClient.get(merged[i].client);
        const hit = tier ? remapJuhoCode(tierMaps, v.serviceCode!, tier) : null;
        if (!hit) {
          console.warn(
            `  [重訪] 段が決まらないため除外: client=${merged[i].client} code=${v.serviceCode}`,
          );
          merged.splice(i, 1);
          continue;
        }
        v.serviceCode = hit.code;
        v.serviceName = hit.name;
      }
    }
  }

  const juhoCodes = Array.from(
    new Set(
      merged
        .filter(
          (r) => r.visit.serviceName == null && (r.visit.serviceCode ?? "").startsWith("12"),
        )
        .map((r) => r.visit.serviceCode!),
    ),
  );
  if (juhoCodes.length > 0) {
    const codeNameMap = new Map<string, string>();
    for (let i = 0; i < juhoCodes.length; i += 50) {
      const chunk = juhoCodes.slice(i, i + 50);
      const { data, error } = await validInMonth(
        sb
          .from("kaigo_service_codes")
          .select("service_code, service_name")
          .eq("system", "障害")
          .in("service_code", chunk),
        y,
        m,
      );
      if (error) {
        console.warn("[shogai] 重訪コード名の逆引きに失敗:", error.message);
        continue;
      }
      for (const c of (data ?? []) as { service_code: string; service_name: string }[]) {
        if (!codeNameMap.has(c.service_code)) codeNameMap.set(c.service_code, c.service_name);
      }
    }
    for (const r of merged) {
      if (r.visit.serviceName == null && r.visit.serviceCode) {
        r.visit.serviceName = codeNameMap.get(r.visit.serviceCode) ?? null;
      }
    }
  }

  const visitsByClient = new Map<string, ShogaiDensouVisit[]>();
  for (const r of merged) {
    if (!visitsByClient.has(r.client)) visitsByClient.set(r.client, []);
    visitsByClient.get(r.client)!.push(r.visit);
  }
  return visitsByClient;
}

// ─── SJIS 書き出し ────────────────────────────────────────────────────────────
function writeSjis(dir: string, fileName: string, content: string) {
  const sjis = Encoding.convert(Encoding.stringToCode(content), { to: "SJIS", from: "UNICODE" });
  writeFileSync(join(dir, fileName), Buffer.from(sjis));
}

// ─── ほのぼの CSV パース (SJIS) → data 行の配列 (col2 以降) ────────────────────
interface DensouRow {
  seq: string;
  cols: string[]; // col2 以降 (= build.ts の parts。cols[0]=J111 等, cols[1]=レコード種別)
}
interface ParsedFile {
  control: string[]; // [1, seq, vol0, count, kind, muni0, office, pref0, media, processYm, ...]
  rows: DensouRow[];
  end: string[];
}
// RFC4180 風の CSV 行パース (ダブルクォート囲み + "" エスケープ対応)。
// ほのぼのの伝送 CSV は各セルを "..." で囲む形式なので、囲みを剥がして値化する。
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseDensou(path: string): ParsedFile {
  const buf = readFileSync(path);
  const unicode = Encoding.convert(new Uint8Array(buf), { to: "UNICODE", from: "SJIS" });
  const text = Encoding.codeToString(unicode);
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  let control: string[] = [];
  let end: string[] = [];
  const rows: DensouRow[] = [];
  for (const line of lines) {
    const c = splitCsvLine(line);
    if (c[0] === "1") control = c;
    else if (c[0] === "3") end = c;
    else if (c[0] === "2") rows.push({ seq: c[1], cols: c.slice(2) });
  }
  return { control, rows, end };
}

// build.ts の content 文字列を同じ形でパース
function parseContent(content: string): ParsedFile {
  const lines = content.split(/\r\n|\n/).filter((l) => l.length > 0);
  let control: string[] = [];
  let end: string[] = [];
  const rows: DensouRow[] = [];
  for (const line of lines) {
    // ⚠ 引用符を外してから比較する。ほのぼのも当方も一部の項目を "J121" のように括るため、
    //   外さないとレコード種別の判定に失敗し「新に無し」で全件不一致になる
    //   (2026-08-07: 当方の出力を ほのぼの書式に合わせた直後、17 拠点が一斉に 0 一致になった)。
    const c = line.split(",").map((s) => s.replace(/^"|"$/g, ""));
    if (c[0] === "1") control = c;
    else if (c[0] === "3") end = c;
    else if (c[0] === "2") rows.push({ seq: c[1], cols: c.slice(2) });
  }
  return { control, rows, end };
}

// ─── 突合ユーティリティ ──────────────────────────────────────────────────────
const N = (s: string | undefined) => {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};

function fmtEnvelope(p: ParsedFile) {
  const c = p.control;
  return {
    kind: c[4],
    count: N(c[3]),
    office: c[6],
    processYm: c[9],
    media: c[8],
    actualDataRows: p.rows.length,
  };
}

// J111: 市町村別 basic(01) を拾う
function j111Basics(p: ParsedFile) {
  // cols: [J111, 01, ym, muni, office, benefit, count, units, cost, benefit, ...userAmt at idx 11]
  const map = new Map<string, { muni: string; count: number; units: number; cost: number; benefit: number; userAmt: number }>();
  for (const r of p.rows) {
    if (r.cols[0] === "J111" && r.cols[1] === "01") {
      const muni = r.cols[3];
      map.set(muni, {
        muni,
        count: N(r.cols[6]),
        units: N(r.cols[7]),
        cost: N(r.cols[8]),
        benefit: N(r.cols[9]),
        userAmt: N(r.cols[11]),
      });
    }
  }
  return map;
}

// J121 basic(01): 受給者別サマリ
interface J121Basic {
  jukyu: string;
  muni: string;
  totalUnits: number; // col idx 19 (項20)
  totalAmount: number; // 20 (項21)
  jogenChosei: number; // 21 (項22)
  userAmount: number; // 26 (項27 決定利用者負担額)
  benefit: number; // 27 (項28)
  limit: string; // 11 (項12)
  kanriResult: string; // 15 (項16)
}
function j121Basics(p: ParsedFile) {
  const map = new Map<string, J121Basic>();
  for (const r of p.rows) {
    if (r.cols[0] === "J121" && r.cols[1] === "01") {
      const c = r.cols;
      const jukyu = c[5];
      map.set(jukyu, {
        jukyu,
        muni: c[3],
        limit: c[11] ?? "",
        kanriResult: c[15] ?? "",
        totalUnits: N(c[19]),
        totalAmount: N(c[20]),
        jogenChosei: N(c[21]),
        userAmount: N(c[26]),
        benefit: N(c[27]),
      });
    }
  }
  return map;
}

// J121 meisai(03): 受給者別 サービスコード明細
function j121Meisai(p: ParsedFile) {
  const map = new Map<string, Map<string, { unit: number; count: number; units: number }>>();
  for (const r of p.rows) {
    if (r.cols[0] === "J121" && r.cols[1] === "03") {
      const c = r.cols;
      const jukyu = c[5];
      const code = c[6];
      if (!map.has(jukyu)) map.set(jukyu, new Map());
      const inner = map.get(jukyu)!;
      const cur = inner.get(code) ?? { unit: 0, count: 0, units: 0 };
      cur.unit = N(c[7]);
      cur.count += N(c[8]);
      cur.units += N(c[9]);
      inner.set(code, cur);
    }
  }
  return map;
}

// J611: 受給者別 サービス内容コード別 (回数/様式)
function j611Summary(p: ParsedFile) {
  // basic 01: jukyu, yoshiki(col6). meisai 02: jukyu, yoshiki, tsuban(7), day(8), count(9), content(10)
  const byJukyu = new Map<string, { yoshiki: Set<string>; days: Set<string>; meisaiCount: number; codeCount: Map<string, number> }>();
  for (const r of p.rows) {
    if (r.cols[0] !== "J611") continue;
    const c = r.cols;
    const jukyu = c[5];
    if (!byJukyu.has(jukyu)) byJukyu.set(jukyu, { yoshiki: new Set(), days: new Set(), meisaiCount: 0, codeCount: new Map() });
    const e = byJukyu.get(jukyu)!;
    e.yoshiki.add(c[6]);
    if (c[1] === "02") {
      e.meisaiCount += 1;
      e.days.add(c[8]);
      const content = c[10] ?? "";
      e.codeCount.set(content, (e.codeCount.get(content) ?? 0) + 1);
    }
  }
  return byJukyu;
}

// J411: 受給者別 上限管理
function j411Summary(p: ParsedFile) {
  const byJukyu = new Map<string, { limit: string; kanriResult: string; sumTotal: number; sumUser: number; sumAdj: number; lines: number }>();
  for (const r of p.rows) {
    if (r.cols[0] !== "J411") continue;
    const c = r.cols;
    if (c[1] === "01") {
      // [J411,01,ym,sakusei,muni,office,jukyu,kana,kana,limit(9),kanri(10),sumTotal(11),sumUser(12),sumAdj(13)]
      const jukyu = c[6];
      byJukyu.set(jukyu, {
        limit: c[9] ?? "",
        kanriResult: c[10] ?? "",
        sumTotal: N(c[11]),
        sumUser: N(c[12]),
        sumAdj: N(c[13]),
        lines: 0,
      });
    } else if (c[1] === "02") {
      const jukyu = c[5];
      const e = byJukyu.get(jukyu);
      if (e) e.lines += 1;
    }
  }
  return byJukyu;
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  // office 情報
  const { data: o, error: oe } = await supabase
    .from("offices")
    .select("business_number, shogai_business_number, unit_price, area_category, name")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  if (oe) throw new Error("事業所情報取得失敗: " + oe.message);
  const dbOfficeNumber = ((o?.business_number ?? "") as string).trim();
  // offices.business_number は介護の事業所番号。障害伝送は別番号を使う。
  // 障害の事業所番号は offices.shogai_business_number が正 (2026-08-04 に 五井/大網/姉ム を登録)。
  // env SHOGAI_BN は未登録の事業所を検証するための逃げ道として残す。
  const officeNumber =
    process.env.SHOGAI_BN ||
    ((o?.shogai_business_number ?? "") as string).trim() ||
    FALLBACK_OFFICE_NUMBER;
  // 単価: offices.unit_price は介護の地域区分単価。障害は人件費割合が違うので別計算
  //   (lib/shogai-seikyu/unit-price.ts。実伝送3事業所で検証済)
  const areaCategory = (o?.area_category ?? null) as string | null;
  const unitPrice = getShogaiHomonUnitPrice(areaCategory);
  console.log("=== office ===");
  console.log("name:", o?.name);
  console.log("business_number(DB):", JSON.stringify(dbOfficeNumber), "→ 使用:", officeNumber);
  console.log("unit_price:", unitPrice, "area_category:", areaCategory);

  // 集計
  const agg = await aggregateMonthlyShogaiSeikyu(supabase, {
    year: YEAR,
    month: MONTH,
    unitPrice,
    officeId: OFFICE_ID,
  });
  console.log("\n=== aggregate ===");
  console.log("recordCount:", agg.recordCount, "rows:", agg.rows.length);
  if (agg.warnings.length) console.log("warnings:\n  - " + agg.warnings.join("\n  - "));

  const rows: ShogaiSeikyuRow[] = agg.rows;

  // visits
  const visitsByClient = await loadMonthVisits(supabase, OFFICE_ID, YEAR, MONTH);

  // 契約支給量
  const ids = rows.map((r) => r.user_id);
  // 契約情報 (shogai_contracts)。あればこれが最優先で J121-05 になる
  const contractsByClient = await loadContractsForMonth(supabase, OFFICE_ID, ids, YEAR, MONTH);
  // サービス利用開始年月日 (J121-02 項8)。契約日とは別物
  const startByClient = await loadServiceStartDates(supabase, OFFICE_ID, ids);
  const contractByClient = new Map<string, { text: string | null; start: string | null; entry: string | null; holder: string | null; shikyuryo: Record<string, { hours?: number; minutes?: number; count?: number; units?: number }> | null }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    // holder_name_kana は shougai_cert_holder_kana.sql 未適用の環境があるので
    //   42703 (undefined_column) のときは列を落として再取得する
    let { data, error } = await supabase
      .from("shougai_certifications")
      .select("client_id, contract_amount_text, contract_start_date, contract_entry_number, holder_name_kana, shikyuryo_details, certification_start_date")
      .in("client_id", chunk)
      .order("certification_start_date", { ascending: false });
    if (error?.code === "42703") {
      const fb = await supabase
        .from("shougai_certifications")
        .select("client_id, contract_amount_text, contract_start_date, contract_entry_number, shikyuryo_details, certification_start_date")
        .in("client_id", chunk)
        .order("certification_start_date", { ascending: false });
      data = (fb.data ?? []) as unknown as typeof data;
      error = fb.error;
    }
    if (error) throw new Error("受給者証取得失敗: " + error.message);
    for (const c of (data ?? []) as {
      client_id: string;
      contract_amount_text: string | null;
      holder_name_kana?: string | null;
      shikyuryo_details?: Record<string, { hours?: number; minutes?: number; count?: number; units?: number }> | null;
      contract_start_date: string | null;
      contract_entry_number: string | null;
    }[]) {
      if (!contractByClient.has(c.client_id))
        contractByClient.set(c.client_id, {
          holder: c.holder_name_kana ?? null,
          shikyuryo: c.shikyuryo_details ?? null,
          text: c.contract_amount_text,
          start: c.contract_start_date,
          entry: c.contract_entry_number,
        });
    }
  }

  // 上限管理 関係事業所一覧
  const selfIds = rows.filter((r) => r.jogenKanriKubun === "自事業所").map((r) => r.user_id);
  const linesByClient = new Map<string, ShogaiDensouKanriLine[]>();
  if (selfIds.length > 0) {
    const { data, error } = await supabase
      .from("shogai_jogen_kanri_results")
      .select("client_id, office_lines")
      .eq("target_month", `${YEAR}-${String(MONTH).padStart(2, "0")}`)
      .in("client_id", selfIds);
    if (error) throw new Error("上限管理結果取得失敗: " + error.message);
    for (const k of (data ?? []) as { client_id: string; office_lines: ShogaiDensouKanriLine[] }[]) {
      if (Array.isArray(k.office_lines) && k.office_lines.length > 0)
        linesByClient.set(k.client_id, k.office_lines);
    }
  }

  const users: ShogaiDensouUser[] = rows.map((r) => {
    const contract = contractByClient.get(r.user_id);
    return {
      row: r,
      visits: visitsByClient.get(r.user_id) ?? [],
      // 契約情報 (shogai_contracts)。あればこれが最優先で J121-05 になる
      contracts: contractsByClient.get(r.user_id) ?? [],
      serviceStartByType: startByClient.get(r.user_id),
      contractAmountText: contract?.text ?? null,
      contractStartDate: contract?.start ?? null,
      contractEntryNumber: contract?.entry ?? null,
      holderNameKana: contract?.holder ?? null,
      shikyuryoDetails: contract?.shikyuryo ?? null,
      jogenOfficeLines: linesByClient.get(r.user_id) ?? null,
    };
  });

  const result = buildShogaiDensou(users, {
    officeNumber,
    year: YEAR,
    month: MONTH,
    unitPrice,
    areaCategory,
  });

  console.log("\n=== build warnings ===");
  if (result.warnings.length) console.log("  - " + result.warnings.join("\n  - "));
  else console.log("  (なし)");

  // 出力
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeSjis(OUT_DIR, result.seikyuFile.fileName, result.seikyuFile.content);
  writeSjis(OUT_DIR, result.jissekiFile.fileName, result.jissekiFile.content);
  if (result.jogenFile) writeSjis(OUT_DIR, result.jogenFile.fileName, result.jogenFile.content);
  console.log("\n=== 出力 (新システム) ===");
  console.log("J11:", result.seikyuFile.fileName, "dataRows:", result.seikyuFile.dataRecordCount);
  console.log("J61:", result.jissekiFile.fileName, "dataRows:", result.jissekiFile.dataRecordCount);
  console.log("J41:", result.jogenFile ? `${result.jogenFile.fileName} dataRows:${result.jogenFile.dataRecordCount}` : "(なし)");

  // レコード種別内訳
  const kindBreakdown = (p: ParsedFile) => {
    const m = new Map<string, number>();
    for (const r of p.rows) {
      const k = `${r.cols[0]}-${r.cols[1]}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort().map(([k, v]) => `${k}:${v}`).join("  ");
  };

  // ─── パース (新 vs ほのぼの) ─────────────────────────────────────────────
  const newJ11 = parseContent(result.seikyuFile.content);
  const newJ61 = parseContent(result.jissekiFile.content);
  const newJ41 = result.jogenFile ? parseContent(result.jogenFile.content) : { control: [], rows: [], end: [] };

  // ほのぼの側のファイル名は**処理年月**なので事業所ごとに違う (姉ムは月遅れで KJ260802)。
  //   接頭辞で拾う。同じ接頭辞が複数あるときは提供年月が揃っていない置き方なので中断する。
  const EMPTY_DENSOU = { control: [] as string[], end: [] as string[], rows: [] as DensouRow[] };
  /**
   * 過誤申立で取り下げた当初請求の受給者証番号。
   * `ほのぼのから_再請求/_過誤取下げ.json` に `{"withdrawn":["1242311080"],"reason":"…"}`。
   * 再請求で番号が変わるケースは自動判別できないので、ここに書いてある分だけ捨てる。
   */
  const WITHDRAWN = new Set<string>();
  /** 再請求で明細を差し替えたか (請求書サマリの ★DIFF を「当然」と説明するため) */
  let reclaimApplied = false;
  {
    const f = join(RECLAIM_DIR, "_過誤取下げ.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8")) as { withdrawn?: string[]; reason?: string };
      for (const n of j.withdrawn ?? []) WITHDRAWN.add(String(n).trim());
      console.log(`  過誤取下げ: ${[...WITHDRAWN].join(", ")}${j.reason ? ` (${j.reason})` : ""}`);
    }
  }
  /** dir から prefix にマッチする伝送ファイルを 1 つだけ拾う (2 つ以上は置き方の誤り) */
  const oneFile = (dir: string, prefix: string): string | null => {
    const hits = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.toUpperCase().startsWith(prefix) && /\.CSV$/i.test(f))
          // densou-explain.mts が同じ場所に書く注釈CSV (…_解説.csv) は伝送ファイルではない
          .filter((f) => !/_解説\.csv$/i.test(f))
          .sort()
      : [];
    if (hits.length > 1) {
      console.error(`FATAL: ${dir} に ${prefix}*.CSV が ${hits.length} 個あります (${hits.join(", ")})。`);
      console.error(`  提供年月ごとにフォルダを分けてください (月遅れ請求を混ぜると突合が壊れます)`);
      console.error(`  同じ提供年月の出し直しは ほのぼのから_再請求/ に置いてください`);
      process.exit(1);
    }
    return hits[0] ? join(dir, hits[0]) : null;
  };
  /**
   * 受給者証番号。J121 / J611 / J411 の明細レコードだけが持つ (cols[5])。
   * ⚠ 種別で絞らないと J111 (請求書サマリ) の cols[5] = 合計金額を受給者証番号として
   *   拾ってしまう (30157 を「3 人目の受給者」と数えて当初請求の J111 行を破棄した)。
   */
  const unq = (s: string | undefined) => (s ?? "").replace(/^"|"$/g, "").trim();
  const beneOf = (r: DensouRow) => {
    const kind = unq(r.cols[0]);
    // ⚠ J411-01 だけ「作成区分」が 1 項多く、受給者証番号が cols[6] にずれる
    //   (j411Summary が c[6] を見ているのと同じ)。cols[5] を見ると事業所番号を拾う。
    if (kind === "J411" && unq(r.cols[1]) === "01") return unq(r.cols[6]);
    return /^J(121|611|411)$/.test(kind) ? unq(r.cols[5]) : "";
  };

  const pickDensou = (prefix: string, required: boolean) => {
    const file = oneFile(HONOBONO_DIR, prefix);
    if (!file) {
      if (required) {
        console.error(`FATAL: ${HONOBONO_DIR} に ${prefix}*.CSV がありません`);
        process.exit(1);
      }
      return EMPTY_DENSOU;
    }
    console.log(`  ほのぼの ${prefix}: ${file.split(/[\\/]/).pop()}`);
    const base = parseDensou(file);

    // ── 再請求で上書き ──────────────────────────────────────────────────
    // 過誤申立で当初請求は取り下げられ、再請求が「最終的に請求した内容」になる。
    // よって **再請求に出てくる受給者は、当初請求の行を丸ごと捨てて置き換える**。
    // ⚠ J111 (請求書サマリ) は市町村単位の合計なので受給者単位に置換できない。
    //   合計の作り直しはしない (memory: 突合は明細 J121 で見るのが既定) — 警告だけ出す。
    const rc = oneFile(RECLAIM_DIR, prefix);
    if (!rc && WITHDRAWN.size === 0) return base;
    const reclaim = rc ? parseDensou(rc) : EMPTY_DENSOU;
    const targets = new Set(reclaim.rows.map(beneOf).filter(Boolean));
    // 受給者証番号が変わった再請求 (18歳到達で 障害児→障害者 に切替 等) は
    // 当初請求と再請求で **キーが違う**ので自動では結び付かない。取り下げ済みの
    // 旧番号は _過誤取下げ.json に明示してもらう (請求の取下げは人が確認すべき事実)。
    for (const w of WITHDRAWN) targets.add(w);
    if (targets.size === 0) return base;
    const kept = base.rows.filter((r) => {
      const b = beneOf(r);
      return !b || !targets.has(b);
    });
    const dropped = base.rows.length - kept.length;
    const added = reclaim.rows.filter((r) => beneOf(r)).length;
    if (dropped === 0 && added === 0) return base;
    reclaimApplied = true;
    console.log(
      `  ほのぼの ${prefix}: ${rc ? `再請求 ${rc.split(/[\\/]/).pop()} で ` : "過誤取下げのみ "}` +
      `受給者証 ${targets.size} 件を上書き (当初 ${dropped} 行を破棄 → 再請求 ${added} 行)`,
    );
    return {
      control: base.control,
      end: base.end,
      rows: [...kept, ...reclaim.rows.filter((r) => beneOf(r))],
    };
  };
  const hbJ11 = pickDensou("KJ", true);
  const hbJ61 = pickDensou("TJ", true);
  // JJ (上限管理結果票) は該当者がいない事業所では出力されない → 無ければ空扱い
  const hbJ41 = pickDensou("JJ", false);

  console.log("\n\n########## 突合レポート ##########");

  // エンベロープ
  console.log("\n===== エンベロープ =====");
  for (const [label, np, hp] of [
    ["J11", newJ11, hbJ11],
    ["J61", newJ61, hbJ61],
    ["J41", newJ41, hbJ41],
  ] as const) {
    const ne = fmtEnvelope(np);
    const he = fmtEnvelope(hp);
    console.log(`\n[${label}]`);
    console.log(`  種別   新=${ne.kind}          ほ=${he.kind}`);
    console.log(`  件数   新=${ne.count}(実${ne.actualDataRows})  ほ=${he.count}(実${he.actualDataRows})  ${ne.count === he.count ? "OK" : "★DIFF"}`);
    console.log(`  事業所 新=${ne.office}  ほ=${he.office}  ${ne.office === he.office ? "OK" : "★DIFF"}`);
    console.log(`  処理年月 新=${ne.processYm}  ほ=${he.processYm}  ${ne.processYm === he.processYm ? "OK" : "★DIFF"}`);
    console.log(`  媒体   新=${ne.media}  ほ=${he.media}  ${ne.media === he.media ? "OK" : "★DIFF"}`);
    console.log(`  レコ内訳 新: ${kindBreakdown(np)}`);
    console.log(`           ほ: ${kindBreakdown(hp)}`);
  }

  // J111 請求書 (市町村別)
  console.log("\n\n===== J111 請求書 (市町村別サマリ) =====");
  if (reclaimApplied) {
    console.log(
      "  ※ この月は再請求で明細を差し替えている。ほのぼの側の請求書サマリは **当初請求のまま**なので、\n" +
      "    差し替えた受給者を含む市町村は ★DIFF になって当然。判定は下の J121 明細で行うこと。",
    );
  }
  const nB = j111Basics(newJ11);
  const hB = j111Basics(hbJ11);
  const allMuni = new Set([...nB.keys(), ...hB.keys()]);
  for (const muni of Array.from(allMuni).sort()) {
    const n = nB.get(muni);
    const h = hB.get(muni);
    console.log(`\n[市町村 ${muni}]`);
    const fields: (keyof NonNullable<typeof n>)[] = ["count", "units", "cost", "benefit", "userAmt"];
    for (const f of fields) {
      const nv = n?.[f] ?? "(なし)";
      const hv = h?.[f] ?? "(なし)";
      const ok = nv === hv ? "OK" : "★DIFF";
      console.log(`  ${String(f).padEnd(8)} 新=${String(nv).padStart(10)}  ほ=${String(hv).padStart(10)}  ${ok}`);
    }
  }

  // J121 明細書 受給者別
  console.log("\n\n===== J121 明細書 (受給者別サマリ) =====");
  const nJ121 = j121Basics(newJ11);
  const hJ121 = j121Basics(hbJ11);
  const nMeisai = j121Meisai(newJ11);
  const hMeisai = j121Meisai(hbJ11);
  const allJukyu = new Set([...nJ121.keys(), ...hJ121.keys()]);
  let matchCount = 0;
  const mismatches: string[] = [];
  for (const jukyu of Array.from(allJukyu).sort()) {
    const n = nJ121.get(jukyu);
    const h = hJ121.get(jukyu);
    const diffs: string[] = [];
    if (!n) diffs.push("新に無し (ほのぼののみ)");
    if (!h) diffs.push("ほのぼのに無し (新のみ)");
    if (n && h) {
      const cmp: [string, unknown, unknown][] = [
        ["totalUnits", n.totalUnits, h.totalUnits],
        ["totalAmount", n.totalAmount, h.totalAmount],
        ["jogenChosei", n.jogenChosei, h.jogenChosei],
        ["userAmount", n.userAmount, h.userAmount],
        ["benefit", n.benefit, h.benefit],
        ["limit", n.limit, h.limit],
      ];
      for (const [f, nv, hv] of cmp) {
        if (String(nv) !== String(hv)) diffs.push(`${f} 新=${nv} ほ=${hv}`);
      }
      // サービスコード別明細
      const nm = nMeisai.get(jukyu) ?? new Map();
      const hm = hMeisai.get(jukyu) ?? new Map();
      const allCodes = new Set([...nm.keys(), ...hm.keys()]);
      for (const code of allCodes) {
        const nc = nm.get(code);
        const hc = hm.get(code);
        if (!nc) diffs.push(`code ${code}: 新に無し (ほ: units=${hc.units} cnt=${hc.count})`);
        else if (!hc) diffs.push(`code ${code}: ほに無し (新: units=${nc.units} cnt=${nc.count})`);
        else {
          if (nc.units !== hc.units) diffs.push(`code ${code} units 新=${nc.units} ほ=${hc.units}`);
          if (nc.count !== hc.count) diffs.push(`code ${code} count 新=${nc.count} ほ=${hc.count}`);
        }
      }
    }
    if (diffs.length === 0) matchCount += 1;
    else {
      mismatches.push(`  受給者 ${jukyu} (muni ${(n ?? h)?.muni}): \n      - ${diffs.join("\n      - ")}`);
    }
  }
  console.log(`一致 ${matchCount} 名 / 不一致 ${mismatches.length} 名 (総 ${allJukyu.size} 名)`);
  if (mismatches.length) console.log("\n--- 不一致明細 ---\n" + mismatches.join("\n"));

  // J611 実績記録票
  console.log("\n\n===== J611 実績記録票 (受給者別) =====");
  const nJ611 = j611Summary(newJ61);
  const hJ611 = j611Summary(hbJ61);
  const allJ611 = new Set([...nJ611.keys(), ...hJ611.keys()]);
  let j611Match = 0;
  const j611Mis: string[] = [];
  for (const jukyu of Array.from(allJ611).sort()) {
    const n = nJ611.get(jukyu);
    const h = hJ611.get(jukyu);
    const diffs: string[] = [];
    if (!n) diffs.push("新に無し");
    if (!h) diffs.push("ほのぼのに無し");
    if (n && h) {
      const ny = Array.from(n.yoshiki).sort().join("/");
      const hy = Array.from(h.yoshiki).sort().join("/");
      if (ny !== hy) diffs.push(`様式 新=${ny} ほ=${hy}`);
      if (n.meisaiCount !== h.meisaiCount) diffs.push(`明細行数 新=${n.meisaiCount} ほ=${h.meisaiCount}`);
      if (n.days.size !== h.days.size) diffs.push(`提供日数 新=${n.days.size} ほ=${h.days.size}`);
      const allC = new Set([...n.codeCount.keys(), ...h.codeCount.keys()]);
      for (const code of allC) {
        const nv = n.codeCount.get(code) ?? 0;
        const hv = h.codeCount.get(code) ?? 0;
        if (nv !== hv) diffs.push(`内容コード ${code} 回数 新=${nv} ほ=${hv}`);
      }
    }
    if (diffs.length === 0) j611Match += 1;
    else j611Mis.push(`  受給者 ${jukyu}: ${diffs.join(" | ")}`);
  }
  console.log(`一致 ${j611Match} 名 / 不一致 ${j611Mis.length} 名 (総 ${allJ611.size} 名)`);
  if (j611Mis.length) console.log(j611Mis.join("\n"));

  // J411 上限管理
  console.log("\n\n===== J411 上限管理結果票 (受給者別) =====");
  const nJ411 = j411Summary(newJ41);
  const hJ411 = j411Summary(hbJ41);
  const allJ411 = new Set([...nJ411.keys(), ...hJ411.keys()]);
  if (allJ411.size === 0) console.log("(両者とも J411 対象なし)");
  for (const jukyu of Array.from(allJ411).sort()) {
    const n = nJ411.get(jukyu);
    const h = hJ411.get(jukyu);
    const diffs: string[] = [];
    if (!n) diffs.push("新に無し");
    if (!h) diffs.push("ほのぼのに無し");
    if (n && h) {
      const cmp: [string, unknown, unknown][] = [
        ["limit", n.limit, h.limit],
        ["kanriResult", n.kanriResult, h.kanriResult],
        ["sumTotal", n.sumTotal, h.sumTotal],
        ["sumUser", n.sumUser, h.sumUser],
        ["sumAdj", n.sumAdj, h.sumAdj],
        ["lines", n.lines, h.lines],
      ];
      for (const [f, nv, hv] of cmp) if (String(nv) !== String(hv)) diffs.push(`${f} 新=${nv} ほ=${hv}`);
    }
    console.log(`  受給者 ${jukyu}: ${diffs.length === 0 ? "OK" : "★ " + diffs.join(" | ")}`);
  }

  console.log("\n########## 突合レポート end ##########");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
