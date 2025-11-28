import { createRoot } from "react-dom/client";
import App from "./client";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
