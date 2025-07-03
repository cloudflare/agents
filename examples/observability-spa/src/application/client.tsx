import { createRoot } from "react-dom/client";
import Chat from "./components/Chat";
import "./styles.css";

function App() {
  return (
    <div className="container">
      <div className="col-span-1">
        <Chat />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
