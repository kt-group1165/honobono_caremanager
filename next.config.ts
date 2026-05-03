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
};

export default nextConfig;
