import { createRoot } from "react-dom/client";
// import { useAgent } from "agents/react";
import "./styles.css";

function App() {
  return <div>Hello, world!</div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
