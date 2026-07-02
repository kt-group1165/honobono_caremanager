import type { NextConfig } from "next";

// Phase 2-X monorepo 化（B-2 段階）。@kt/shared は TypeScript ソースを
// 直接 import しているため Next の transpile 対象に含める。
// node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/transpilePackages.md
//
// 旧 turbopack.root = process.cwd() は npm workspaces 化前の workaround。
// workspace 化後は package-lock.json が workspace root にしか無くなり、
// auto-detect が正しく workspace root を選ぶため不要になった。
// node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md
const nextConfig: NextConfig = {
  transpilePackages: ["@kt/shared"],
  // Phase Perf-1: barrel optimization で bundle 縮小
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
    // Phase Perf-2: メニュー間遷移の高速化。
    // dynamic ページの client cache はデフォルト 0 秒 (毎回 server 往復) のため、
    // 30 秒キャッシュしてメニュー往復を即時にする。
    // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/staleTimes.md
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
};

export default nextConfig;
