import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { queryClient } from "@/lib/query-client";
import "@/lib/theme-applier";
import { UaoStandaloneScreen } from "@/components/uao/uao-standalone-screen";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root element not found in uao.html");
}

createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <UaoStandaloneScreen />
  </QueryClientProvider>,
);
