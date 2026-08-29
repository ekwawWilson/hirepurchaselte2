import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { getOrgSettings } from "@/lib/services/orgSettingsService";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// force-dynamic: generateMetadata reads the DB-backed company name below, so
// pages must render per-request rather than being frozen into a static build
// artifact — otherwise a company name change on the Settings page would never
// reach the browser tab title without a full rebuild+redeploy.
export const dynamic = "force-dynamic";

// Reads the client's own company name straight from the DB (server component,
// no HTTP round trip needed) so the browser tab reflects whatever they've set
// on the Settings page, not a hardcoded "HP-Lite".
export async function generateMetadata(): Promise<Metadata> {
  const { companyName } = await getOrgSettings();
  return {
    title: companyName === "HP-Lite" ? "HP-Lite" : `${companyName} · HP-Lite`,
    description: "Hire-purchase management system",
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
