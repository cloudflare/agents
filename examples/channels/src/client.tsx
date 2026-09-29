import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@cloudflare/kumo";
import { App } from "./ui/app";
import { SupportFormPage } from "./ui/support-form";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      {window.location.pathname === "/support-form" ? (
        <SupportFormPage />
      ) : (
        <App />
      )}
    </TooltipProvider>
  </StrictMode>
);
