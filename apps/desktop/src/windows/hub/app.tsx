import { SidebarInset, SidebarProvider } from "@multica/ui/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { useEffect } from "react";
import { useHistorySync } from "../../lib/history-queries";
import { listen } from "../../lib/ipc";
import { useSettingsSync } from "../../lib/shortcut-events";
import { DictionaryPage } from "./pages/dictionary";
import { HistoryPage } from "./pages/history";
import { HomePage } from "./pages/home";
import { UsagePage } from "./pages/usage";
import { navigate, useRoute, type Page } from "./route";
import { SettingsPage } from "./settings/settings-page";

const PAGES: Record<Page, () => React.JSX.Element> = {
  home: HomePage,
  history: HistoryPage,
  dictionary: DictionaryPage,
  usage: UsagePage,
  settings: SettingsPage,
};

export function HubApp() {
  const { page } = useRoute();
  useHistorySync();
  useSettingsSync();
  // The bar's Details and Sign in open a page here.
  useEffect(() => {
    const off = listen("hub://open", (p) => navigate(p.page, p.section));
    return () => void off.then((f) => f());
  }, []);
  const Current = PAGES[page];
  return (
    // The traffic lights sit over the sidebar, so it keeps its own toggle on screen.
    <SidebarProvider hasExternalTrigger className="h-full min-h-0 bg-sidebar">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <Current />
      </SidebarInset>
    </SidebarProvider>
  );
}
