import type { ComponentType, ReactNode, SVGProps } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@multica/ui/components/ui/empty";
import { SidebarTrigger, useSidebar } from "@multica/ui/components/ui/sidebar";
import { cn } from "@multica/ui/lib/utils";

/**
 * The page's top bar. It doubles as the window's drag region; with the sidebar
 * collapsed it makes room for the traffic lights and keeps a way back to the nav.
 */
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4 transition-[padding] duration-200 ease-out",
        collapsed && "pl-[84px]",
      )}
    >
      {collapsed ? <SidebarTrigger className="-ml-1" /> : null}
      <h1 data-tauri-drag-region className="flex-1 truncate text-body font-semibold">
        {title}
      </h1>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Page({ title, actions, children, className }: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={title} actions={actions} />
      <div className={cn("scrollbar-slim min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("py-12", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-10 rounded-xl bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-title-sm">{title}</EmptyTitle>
        <EmptyDescription className="max-w-xs">{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
