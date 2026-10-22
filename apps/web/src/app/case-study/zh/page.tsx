import type { Metadata } from "next";
import { CaseStudy } from "@/components/case-study";

export const metadata: Metadata = {
  title: { absolute: "FeedRelay 案例：从一个想法，到可以亲手试用的产品 | Xueqi Liu" },
  description: "网站更新自动筛选并送到 Telegram。查看真实改版对比、手机端展示与可操作演示，了解我们如何把想法做成完整产品。",
  openGraph: { title: "FeedRelay · Xueqi Liu 作品案例", description: "一个入口，串起介绍、设置、操作和结果。查看真实界面，亲手体验完整流程。", images: [{ url: "/case-study/dashboard-desktop.png", alt: "FeedRelay 后台真实截图，使用演示数据" }], locale: "zh_CN", type: "website" },
  alternates: { languages: { en: "/case-study", "zh-CN": "/case-study/zh" } },
};

export default function Page() { return <CaseStudy locale="zh"/>; }
