import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Coinbase smart wallet popups need the opener relationship preserved.
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] }];
  },
};

export default nextConfig;
