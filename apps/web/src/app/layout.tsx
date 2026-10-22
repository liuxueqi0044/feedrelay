import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "FeedRelay — Your feeds, delivered to Telegram", template: "%s · FeedRelay" },
  description: "Bring RSS and Atom updates to Telegram. Connect feeds, choose a destination, filter what matters, and keep track of every delivery.",
  applicationName: "FeedRelay",
  openGraph: { title: "FeedRelay — Your feeds, delivered to Telegram", description: "The web moves. Your inbox keeps up. Filter RSS and Atom feeds and deliver the updates that matter to Telegram.", type: "website" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
