import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <div className="flex items-center justify-center h-screen">
      <h1 className="text-4xl font-bold mb-4">Observability</h1>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
