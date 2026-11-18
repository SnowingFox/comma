import { SidebarInset, SidebarProvider } from "@multica/ui/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { DictionaryPage, HistoryPage, UsagePage } from "./pages/empty-pages";
import { HomePage } from "./pages/home";
import { useRoute, type Page } from "./route";
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
