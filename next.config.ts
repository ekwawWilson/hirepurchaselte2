import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Send metadata in <head> for every visitor instead of streaming it into
  // <body> (this Next's default when generateMetadata is async, as the root
  // layout's is — it reads the company name from the database). Browsers
  // only honour a manifest link and the iOS home-screen tags in <head>, so
  // streamed metadata left both apps uninstallable. The cost is one small
  // settings query before the page starts sending.
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        // The service worker must never be served stale: a cached copy would
        // keep an installed app on old code after a deploy.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
