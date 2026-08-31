/**
 * anon key で読み書きできてしまうテーブル / Storage バケットを洗い出す。
 *
 *   cd apps/kaigo-app
 *   npm run check:anon              # 読み取りだけ調べる
 *   npm run check:anon -- --write   # 書き込めるかも調べる (下記の注意を読むこと)
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   RLS を有効にし忘れたテーブルは **anon key で全部読める**。anon key は
 *   公開 JS バンドルに載っているので、URL が分かれば誰でも叩ける。
 *
 *   2026-08-31 に 6 テーブル + 1 バケットが開いた状態で見つかった:
 *     billing_user_invoices / _invoice_items / _payments / client_rental_history
 *       … 元 migration が「RLS は後で別 migration で adjust 可」と書いたまま
 *         その migration が作られなかった
 *     client_public_expenses
 *       … 法別・負担者番号・受給者番号。監査にも載っていなかった
 *     event-images バケット
 *       … public=false なのに policy が anon に開いていて 100 件が一覧・DL 可能
 *
 *   **人が気づく仕組みが無いと必ず再発する。**新しいテーブルを足すたびに
 *   これを回す。
 *
 * ── 何をするか ──────────────────────────────────────────────────────────
 *   1. 全 app のコードから `.from("<table>")` を集める (= 実際に使われている表)
 *   2. それぞれに anon key で GET し、**中身が返るもの**を挙げる
 *   3. Storage の全バケットに anon で LIST / DOWNLOAD できるか見る
 *   4. --write のときだけ、書き込めるかも調べる
 *
 * ⚠ 「HTTP 200 が返る」だけでは開いている判定にしない。RLS が効いていても
 *   PostgREST は 200 + [] を返す。**中身が返ったかどうか**で判定する。
 *   同じ理由で UPDATE/DELETE も 0 行なら 200/204 を返すので、
 *   件数ではなく **実際に値が変わったか**を見る必要がある (下記 --write 参照)。
 *
 * ⚠ --write は既存データに触れない。
 *     テーブル: 存在しない id を条件にした UPDATE を投げ、**結果の行数**で判定。
 *               返った行があれば「書けた」= 実データを書き換えられる状態。
 *     Storage : 新規名で 1x1 PNG を置いて即削除する。既存ファイルは上書きしない。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRITE = process.argv.includes("--write");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const REPO = path.resolve(KAIGO, "../..");

function loadEnv(p: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv(path.join(KAIGO, ".env.local"));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SVC) {
  console.error("✗ .env.local に URL / ANON / SERVICE_ROLE のどれかが無い");
  process.exit(1);
}
const anonH = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}` };

/** 全 app のソースから `.from("<table>")` を集める */
function collectTables(): string[] {
  const found = new Set<string>();
  const re = /\bfrom\(\s*["'`]([a-z][a-z0-9_]{3,})["'`]\s*\)/g;
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === ".next" || name === ".git") continue;
      const p = path.join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|mts|mjs|js)$/.test(name)) continue;
      let text: string;
      try { text = readFileSync(p, "utf8"); } catch { continue; }
      for (const m of text.matchAll(re)) found.add(m[1]);
    }
  };
  const appsDir = path.join(REPO, "apps");
  let apps: string[] = [];
  try { apps = readdirSync(appsDir); } catch { /* apps が無ければ空 */ }
  for (const app of apps) {
    for (const sub of ["src", "app", "lib", "components"]) {
      walk(path.join(appsDir, app, sub));
    }
  }
  return [...found].sort();
}

type Row = { table: string; readable: boolean; sample: string; writable: boolean | null };

async function checkTable(t: string): Promise<Row | null> {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, {
    headers: { ...anonH, Prefer: "count=exact" },
  });
  if (r.status !== 200) return null;           // 404 = 表が無い / 403 = 閉じている
  const body = await r.text();
  // ⚠ 200 でも [] なら RLS は効いている。中身が返ったときだけ「開いている」
  const readable = body.trim() !== "[]" && body.trim() !== "";
  if (!readable) return null;

  let writable: boolean | null = null;
  if (WRITE) {
    // ── 書けるかの判定 ────────────────────────────────────────────────
    // ⚠ 素朴なやり方は全部ハズレる。実測で確かめた挙動:
    //     存在しない id への PATCH  → 権限があっても無くても 200 + []
    //     空 body `{}` の PATCH     → **書けていても 200 + []**（更新列が無いため）
    //   どちらも「拒否されなかった」を意味せず、判定に使えない。
    //
    // そこで **実在行の値を、いま入っている値と同じ値で** 上書きする。
    //   書ければ更新行が返る / 権限が無ければ 401・403 か [] になる。
    //   同じ値なので **データは変わらない**（updated_at が動く表はありうる）。
    const sv = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, { headers: svcH });
    const rows = (await sv.json().catch(() => [])) as Array<Record<string, unknown>>;
    const row = rows?.[0];
    const id = row?.id;
    if (row && typeof id === "string") {
      // 上書きに使える列を 1 つ選ぶ。id と生成列は避け、文字列か数値のものを取る。
      const key = Object.keys(row).find((k) =>
        k !== "id" && !/_at$/.test(k) &&
        (typeof row[k] === "string" || typeof row[k] === "number"));
      if (key) {
        const w = await fetch(`${URL_}/rest/v1/${t}?id=eq.${id}`, {
          method: "PATCH",
          headers: { ...anonH, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ [key]: row[key] }),   // ← 同じ値なので中身は変わらない
        });
        const wb = await w.text();
        writable = w.status === 200 && wb.trim() !== "[]" && wb.trim() !== "";
      }
    }
  }
  return { table: t, readable, sample: body.slice(0, 90).replace(/\n/g, ""), writable };
}

async function checkBuckets() {
  const r = await fetch(`${URL_}/storage/v1/bucket`, { headers: svcH });
  const buckets = (await r.json()) as Array<{ name: string; public: boolean }>;
  // 1x1 PNG (書込プローブ用)
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c" +
    "6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");
  const bad: string[] = [];
  for (const b of buckets) {
    const list = await fetch(`${URL_}/storage/v1/object/list/${b.name}`, {
      method: "POST",
      headers: { ...anonH, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 100, prefix: "" }),
    });
    const lj = await list.json().catch(() => null);
    const n = Array.isArray(lj) ? lj.length : -1;
    const issues: string[] = [];
    if (n > 0) issues.push(`一覧 ${n} 件`);
    // 中身が見えたなら実際に落とせるかも見る
    if (n > 0 && Array.isArray(lj) && lj[0]?.name) {
      const d = await fetch(`${URL_}/storage/v1/object/${b.name}/${encodeURIComponent(lj[0].name)}`,
        { headers: anonH });
      if (d.status === 200) issues.push("ダウンロード可");
    }
    if (WRITE) {
      // ⚠ 既存ファイルは触らない。新規名で置いて即消す。
      const name = `__anon_probe_${Date.now()}.png`;
      const up = await fetch(`${URL_}/storage/v1/object/${b.name}/${name}`, {
        method: "POST", headers: { ...anonH, "Content-Type": "image/png" },
        body: png as unknown as BodyInit,
      });
      if (up.status < 300) {
        issues.push("アップロード可");
        await fetch(`${URL_}/storage/v1/object/${b.name}/${name}`, { method: "DELETE", headers: anonH });
      }
    }
    const label = `${b.name}${b.public ? " (public)" : ""}`;
    if (issues.length) {
      // public バケットは一覧・DL できて当然。書けるならそれは問題
      const isExpected = b.public && !issues.includes("アップロード可");
      console.log(`  ${isExpected ? "△ public なので想定内" : "🔴"} ${label.padEnd(26)} ${issues.join(" / ")}`);
      if (!isExpected) bad.push(b.name);
    } else {
      console.log(`  ✓ ${label.padEnd(26)} anon から見えない`);
    }
  }
  return bad;
}

async function main() {
  console.log(`=== anon 露出チェック ${WRITE ? "【読み書き】" : "【読み取りのみ】"} ===\n`);
  const tables = collectTables();
  console.log(`  コードから集めたテーブル ${tables.length} 個を anon key で総当たり\n`);

  const queue = [...tables];
  const open: Row[] = [];
  let done = 0;
  const worker = async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      try {
        const r = await checkTable(t);
        if (r) open.push(r);
      } catch (e) {
        // ⚠ 握りつぶさない。調べられなかった表があることを出す
        console.error(`  ! ${t}: ${(e as Error).message}`);
      }
      if (++done % 50 === 0) console.error(`  …${done}/${tables.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  console.log("── テーブル ──");
  if (!open.length) {
    console.log("  ✓ anon で中身が返るテーブルは無い");
  } else {
    for (const r of open.sort((a, b) => a.table.localeCompare(b.table))) {
      const w = r.writable === true ? " / 🔴 書き換えも可" : r.writable === false ? " / 読取のみ" : "";
      console.log(`  🔴 ${r.table.padEnd(32)}${w}`);
      console.log(`     ${r.sample}`);
    }
  }

  console.log("\n── Storage バケット ──");
  const badBuckets = await checkBuckets();

  const ng = open.length + badBuckets.length;
  console.log(`\n${ng === 0 ? "✓ 露出なし" : `🔴 露出 ${open.length} テーブル / ${badBuckets.length} バケット`}`);
  if (ng > 0) {
    console.log(`
直し方: migrations/fix_billing_user_tables_rls.sql と同じ形。
  ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
  CREATE POLICY <t>_authenticated ON <t> FOR ALL TO authenticated
    USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
    WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));
tenant_id を持たない子表は親を EXISTS で辿る (fix_billing_user_tables_rls.sql 参照)。
Storage は migrations/fix_event_images_storage_policy.sql 参照。
  ⚠ storage.objects には全バケットの policy が同居しているので、
    対象バケットを含む policy だけを落とすこと。`);
  }
  // ⚠ CI に載せるときのために、露出があれば非 0 で終わる
  process.exit(ng === 0 ? 0 : 1);
}

main();
