import { Menu } from "lucide-react";
import CompanySwitcher from "../company/CompanySwitcher";
import NotificationsMenu from "./NotificationsMenu";
import ProfileMenu from "./ProfileMenu";

export default function Topbar({ onOpenMenu }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-surface-border bg-white px-4 sm:px-6">
      <button
        onClick={onOpenMenu}
        className="rounded-md p-1.5 text-ink-500 hover:bg-surface-alt lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <CompanySwitcher />

      <div className="ml-auto flex items-center gap-3">
        <NotificationsMenu />
        <ProfileMenu />
      </div>
    </header>
  );
}
