import type { Metadata } from "next";
import { ScheduleView } from "@/components/schedule/schedule-view";

export const metadata: Metadata = { title: "Chores" };

export default function SchedulePage() {
  return <ScheduleView />;
}
