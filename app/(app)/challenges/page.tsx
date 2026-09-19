import type { Metadata } from "next";
import { ChallengesView } from "@/components/challenges/challenges-view";

export const metadata: Metadata = { title: "Challenges" };

export default function ChallengesPage() {
  return <ChallengesView />;
}
