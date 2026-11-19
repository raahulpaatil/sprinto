import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], display: "swap", variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "Sprinto | Cold-outreach research assistant",
  description:
    "Paste company domains. Sprinto scrapes each site, qualifies it against the ICP with cited evidence, finds a contact, drafts a grounded first email and sends only a preview to your own inbox.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body>{children}</body>
    </html>
  );
}
