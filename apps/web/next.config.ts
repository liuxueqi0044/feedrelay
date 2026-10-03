import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    const apiBase = (process.env.API_BASE ?? "http://127.0.0.1:4100").replace(/\/$/, "");
    return [{ source: "/api/:path*", destination: `${apiBase}/api/:path*` }];
  },
};
export default nextConfig;
