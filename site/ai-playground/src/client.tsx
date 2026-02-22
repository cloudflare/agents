import ReactDOM from "react-dom/client";
import App from "./app";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
