import { createRoot } from "react-dom/client";
import "./index.css";
import "@/lib/theme-applier";
import { UaoStandaloneScreen } from "@/components/uao/uao-standalone-screen";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root element not found in uao.html");
}

createRoot(container).render(<UaoStandaloneScreen />);
