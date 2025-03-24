import { createRoot } from "react-dom/client";

function App() {
  return <div>Hello World</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
