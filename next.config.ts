import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; it must not be bundled by webpack/turbopack
  // and must run only on the Node server (ADR-0005).
  serverExternalPackages: ["better-sqlite3"],

  // lib/core is authored with explicit ".js" import specifiers (NodeNext convention),
  // so the SAME source runs under tsx (CLI), vitest (tests), and the Next server
  // (dashboard) without a build step (ADR-0002/0005). Webpack doesn't map ".js" back
  // to a ".ts" source by default, so teach it to — this is the only seam where the
  // app layer reaches into lib/core, and it keeps lib/core itself untouched.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
