import type { Metadata } from "next";
import { CaseStudy } from "@/components/case-study";

export const metadata: Metadata = {
  title: { absolute: "FeedRelay — A working product, from first visit to delivery | Xueqi Liu" },
  description: "Explore a self-initiated product case: a clear website, a working RSS-to-Telegram dashboard, and a usable mobile experience. See the redesign and try the workflow.",
  openGraph: { title: "FeedRelay · Selected work by Xueqi Liu", description: "From scattered updates to one inbox. Explore the product, the redesign, and the working demo.", images: [{ url: "/case-study/dashboard-desktop.png", alt: "FeedRelay dashboard with demo data" }], type: "website" },
  alternates: { languages: { en: "/case-study", "zh-CN": "/case-study/zh" } },
};

export default function Page() { return <CaseStudy locale="en"/>; }
