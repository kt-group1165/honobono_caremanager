import type { NextConfig } from "next";

// Pin Turbopack filesystem root to this app's directory.
// Without this, Next.js can mis-detect the root as `apps/` because of sibling
// projects (order-app, calendar-app, payroll-app) and their `.next/dev/cache`,
// which causes tailwindcss resolution failures and OOM during compile.
// See node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md
const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
