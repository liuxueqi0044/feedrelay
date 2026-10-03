import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "FeedRelay — RSS to Telegram, thoughtfully", template: "%s · FeedRelay" },
  description: "Bring RSS and Atom updates to Telegram. Connect feeds, choose a destination, filter what matters, and keep track of every delivery.",
  applicationName: "FeedRelay",
  openGraph: { title: "FeedRelay — RSS to Telegram, thoughtfully", description: "Your favorite sources. One familiar inbox. Route RSS and Atom feeds to Telegram with useful filters and dependable delivery logs.", type: "website" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
