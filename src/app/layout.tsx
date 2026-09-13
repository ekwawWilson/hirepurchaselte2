import type { Metadata, Viewport } from "next";
import { Inter, Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { InstallAppButton } from "@/components/shared/InstallAppButton";
import { ServiceWorkerRegister } from "@/components/shared/ServiceWorkerRegister";
import { getOrgSettings } from "@/lib/services/orgSettingsService";
import { APP_NAME, APP_THEME_COLOR } from "@/lib/constants/branding";

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
  themeColor: APP_THEME_COLOR,
};

// Reads the client's own company name straight from the DB (server component,
// no HTTP round trip needed) so the browser tab reflects whatever they've set
// on the Settings page, not just the application's own default branding.
export async function generateMetadata(): Promise<Metadata> {
  const { companyName } = await getOrgSettings();
  return {
    title: companyName === APP_NAME ? APP_NAME : `${companyName} · ${APP_NAME}`,
    description: "Hire-purchase management system",
    // iOS reads these rather than the manifest when adding to the home screen.
    appleWebApp: { capable: true, title: companyName, statusBarStyle: "default" },
    applicationName: companyName,
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${inter.variable} ${jakarta.variable} ${geistMono.variable}`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
        <ServiceWorkerRegister />
        {/* Above the mobile tab bar on phones (bottom-20), in the corner on desktop.
            Legacy used bottom-4 everywhere, which covered its own "More" tab. */}
        <div className="fixed bottom-20 right-4 z-40 lg:bottom-4">
          <InstallAppButton />
        </div>
      </body>
    </html>
  );
}
