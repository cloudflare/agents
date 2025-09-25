import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";

function App() {
  const agent = useAgent({
    agent: "codemode"
  });

  return <div>Hello World</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
