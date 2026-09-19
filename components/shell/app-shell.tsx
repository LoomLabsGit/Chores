"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { badgeCount } from "@/lib/logic/notifications";
import { useHousehold } from "@/lib/store/household-store";
import { Icon, type IconName } from "../icons";
import { NotificationsDrawer } from "./notifications-drawer";
import { ProfileMenu } from "./profile-menu";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Chores", icon: "calendar" },
  { href: "/challenges", label: "Challenges", icon: "trophy" },
  { href: "/stats", label: "Stats", icon: "chart" },
  { href: "/shop", label: "Rewards", icon: "gift" },
  { href: "/manage", label: "Manage", icon: "sliders" },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:pl-24">
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] pt-3 md:px-8 md:pb-12">
        {children}
      </main>
      <NavBar />
    </div>
  );
}

function TopBar() {
  const { me, state } = useHousehold();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const badge = badgeCount(state.notifications, state.challenges, me.id);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-app/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-3 md:px-8">
          <ProfileMenu />
          <div className="flex items-center gap-1.5">
            <div
              className="flex h-11 items-center gap-1.5 rounded-full bg-gold-soft px-3.5 text-gold"
              aria-label={`${me.points} points available`}
              role="status"
            >
              <Icon name="star" size={16} />
              <span key={me.points} className="anim-pop text-[15px] font-extrabold tabular-nums">
                {me.points} pts
              </span>
            </div>
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label={badge ? `Notifications, ${badge} need attention` : "Notifications"}
              className="relative flex h-11 w-11 items-center justify-center rounded-full text-ink hover:bg-raised"
            >
              <Icon name="bell" size={22} />
              {badge > 0 && (
                <span
                  aria-hidden
                  className="anim-pop absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-extrabold leading-none text-white ring-2 ring-app"
                >
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>
      <NotificationsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}

function NavBar() {
  const pathname = usePathname();
  const { me, state } = useHousehold();
  const proposals = state.challenges.filter((c) => c.status === "pending" && c.assigned_to === me.id).length;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:inset-y-0 md:left-0 md:right-auto md:w-24 md:border-r md:border-t-0 md:pb-0 md:pt-20"
    >
      <ul className="mx-auto grid h-16 max-w-md grid-cols-5 md:h-auto md:max-w-none md:grid-cols-1 md:gap-2 md:px-2">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="contents">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-bold transition-colors md:h-16 ${
                  active ? "text-brand" : "text-muted hover:text-ink"
                }`}
              >
                <span
                  className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors ${active ? "bg-brand-soft" : ""}`}
                >
                  <Icon name={item.icon} size={22} strokeWidth={active ? 2.4 : 2} />
                </span>
                {item.label}
                {item.href === "/challenges" && proposals > 0 && (
                  <span aria-label={`${proposals} waiting`} className="absolute right-[calc(50%-1.5rem)] top-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface" />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
