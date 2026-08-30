import type { Metadata, Viewport } from "next";
import { Inter, Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { getOrgSettings } from "@/lib/services/orgSettingsService";
import { APP_NAME } from "@/lib/constants/branding";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"], weight: ["600", "700", "800"] });
// Kept for monospace use (SKUs, serial numbers, contract numbers) — unrelated to
// the body/heading redesign, so left as-is rather than swapped for consistency's sake.
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// force-dynamic: generateMetadata reads the DB-backed company name below, so
// pages must render per-request rather than being frozen into a static build
// artifact — otherwise a company name change on the Settings page would never
// reach the browser tab title without a full rebuild+redeploy.
export const dynamic = "force-dynamic";

// Static (not generateViewport) since none of this depends on request/DB data —
// themeColor must live here, not in Metadata, per Next's viewport/metadata split.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1e3a8a",
};

// Reads the client's own company name straight from the DB (server component,
// no HTTP round trip needed) so the browser tab reflects whatever they've set
// on the Settings page, not just the application's own default branding.
export async function generateMetadata(): Promise<Metadata> {
  const { companyName } = await getOrgSettings();
  return {
    title: companyName === APP_NAME ? APP_NAME : `${companyName} · ${APP_NAME}`,
    description: "Hire-purchase management system",
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${inter.variable} ${jakarta.variable} ${geistMono.variable}`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
