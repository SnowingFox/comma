import type { ComponentType, SVGProps } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@multica/ui/components/ui/sidebar";
import { BarChart3, BookOpenText, ChevronRight, History, KeyRound, LayoutDashboard, Settings, UserRound } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { CommaWordmark } from "../../components/brand";
import { useSecretStatus, useSettings } from "../../lib/queries";
import { navigate, useRoute, type Page } from "./route";

const NAV: { page: Page; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { page: "home", label: "Home", icon: LayoutDashboard },
  { page: "history", label: "History", icon: History },
  { page: "dictionary", label: "Dictionary", icon: BookOpenText },
  { page: "usage", label: "Usage", icon: BarChart3 },
];

export function AppSidebar() {
  const { page } = useRoute();

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      {/* Top row: room for the traffic lights, then the collapse toggle. Drag region. */}
      <SidebarHeader data-tauri-drag-region className="h-[44px] flex-row items-center justify-end px-2 py-0">
        <SidebarTrigger />
      </SidebarHeader>
      <div className="px-4 pt-1 pb-3">
        <CommaWordmark />
      </div>
      <SidebarContent>
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV.map(({ page: target, label, icon: Icon }) => (
                <SidebarMenuItem key={target}>
                  <SidebarMenuButton
                    isActive={page === target}
                    onClick={() => navigate(target)}
                    aria-current={page === target ? "page" : undefined}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-1 pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={page === "settings"}
              onClick={() => navigate("settings")}
              aria-current={page === "settings" ? "page" : undefined}
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <AccountStatus />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Footer card: which mode Comma runs in and whether it is ready. */
function AccountStatus() {
  const settings = useSettings().data;
  const secrets = useSecretStatus().data;
  if (!settings) return <div className="h-[52px]" />;

  const local = settings.mode === "local";
  const ready = local ? !!secrets?.elevenlabs : false;
  const title = local ? "Your own keys" : "Comma account";
  const detail = local
    ? ready
      ? "Ready to dictate"
      : "Key needed"
    : "Not signed in";

  return (
    <button
      type="button"
      onClick={() => navigate("settings", local ? "speech" : "general")}
      className="group/account flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar p-2 text-left transition-colors hover:bg-sidebar-accent"
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-muted-foreground">
        {local ? <KeyRound className="size-4" /> : <UserRound className="size-4" />}
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
            ready ? "bg-success" : "bg-warning",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium">{title}</span>
        <span className="truncate text-caption text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 text-faint-foreground transition-transform group-hover/account:translate-x-0.5" />
    </button>
  );
}
