import type { Metadata } from "next";
import { ShopView } from "@/components/shop/shop-view";

export const metadata: Metadata = { title: "Rewards" };

export default function ShopPage() {
  return <ShopView />;
}
