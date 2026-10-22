import type { MetadataRoute } from "next";
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return [
    { url: origin, changeFrequency: "monthly", priority: 1 },
    ...["/case-study", "/case-study/zh"].map(path => ({
      url: `${origin}${path}`,
      changeFrequency: "monthly" as const,
      priority: 0.8,
      alternates: { languages: { en: `${origin}/case-study`, "zh-CN": `${origin}/case-study/zh` } },
    })),
  ];
}
