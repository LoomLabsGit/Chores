import type { Metadata } from "next";
import { ManageView } from "@/components/manage/manage-view";

export const metadata: Metadata = { title: "Manage chores" };

export default function ManagePage() {
  return <ManageView />;
}
