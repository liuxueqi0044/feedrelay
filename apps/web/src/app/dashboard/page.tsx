import type { Metadata } from "next";
import { Workspace } from "@/components/workspace";
import { TelegramSdk } from "@/components/telegram-sdk";
export const metadata: Metadata = { title: "Your workspace", robots: { index: false, follow: false } };
export default function Dashboard() { return <><TelegramSdk/><Workspace/></>; }
