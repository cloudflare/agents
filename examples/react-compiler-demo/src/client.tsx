import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";

// --- Child component (no React.memo!) ---
// Without the compiler, this re-renders every time App re-renders.
// With the compiler, React auto-memoizes it and skips re-renders
// when its props haven't changed.
function ExpensiveChild({ config }: { config: { theme: string } }) {
  const renderCount = useRef(0);
  renderCount.current++;

  return (
    <div
      style={{
        border: "1px solid #ccc",
        padding: "16px",
        marginTop: "16px",
        borderRadius: "8px"
      }}
    >
      <h3>ExpensiveChild</h3>
      <p>
        Received config: <code>{JSON.stringify(config)}</code>
      </p>
      <p>
        Render count:{" "}
        <strong style={{ fontSize: "1.5em" }}>{renderCount.current}</strong>
      </p>
      <p style={{ color: "#888", fontSize: "0.85em" }}>
        This component has no React.memo wrapper. The compiler should
        auto-memoize it.
      </p>
    </div>
  );
}

// --- Parent component ---
function App() {
  const [count, setCount] = useState(0);

  // This creates a new object reference on every render.
  // Without the compiler: ExpensiveChild re-renders every time (new reference).
  // With the compiler: the compiler sees this is a static value and caches it,
  // so ExpensiveChild gets the same reference and skips re-rendering.
  const config = { theme: "light" };

  const compilerEnabled = import.meta.env.REACT_COMPILER;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "32px" }}>
      <h1>React Compiler Demo</h1>
      <p
        style={{
          padding: "8px 16px",
          borderRadius: "6px",
          display: "inline-block",
          background: compilerEnabled ? "#d4edda" : "#f8d7da",
          color: compilerEnabled ? "#155724" : "#721c24"
        }}
      >
        React Compiler: <strong>{compilerEnabled ? "ON" : "OFF"}</strong>
      </p>

      <div style={{ marginTop: "24px" }}>
        <button
          onClick={() => setCount((c) => c + 1)}
          style={{
            fontSize: "1.1em",
            padding: "8px 20px",
            cursor: "pointer"
          }}
        >
          Increment counter: {count}
        </button>
        <p style={{ color: "#666" }}>
          Clicking this re-renders App. Watch ExpensiveChild's render count
          below.
        </p>
      </div>

      <ExpensiveChild config={config} />

      <div
        style={{
          marginTop: "32px",
          padding: "16px",
          background: "#f5f5f5",
          borderRadius: "8px",
          fontSize: "0.9em"
        }}
      >
        <h3>What to expect</h3>
        <ul>
          <li>
            <strong>Compiler OFF:</strong> ExpensiveChild render count increases
            with every click (new <code>config</code> object reference each
            render)
          </li>
          <li>
            <strong>Compiler ON:</strong> ExpensiveChild render count stays at 1
            (compiler caches the static object, same reference each render)
          </li>
        </ul>

        <h3 style={{ marginTop: "16px" }}>Inspecting the compiled output</h3>
        <ul>
          <li>
            Run <code>npm start</code> — check <code>compiled-output.js</code>{" "}
            (look for <code>react/compiler-runtime</code> imports and{" "}
            <code>_c()</code> cache slots)
          </li>
          <li>
            Run <code>npm run start:no-compiler</code> — check{" "}
            <code>uncompiled-output.js</code> (plain JSX transform)
          </li>
          <li>
            Diff them: <code>diff compiled-output.js uncompiled-output.js</code>
          </li>
          <li>
            Or paste the source into the{" "}
            <a
              href="https://playground.react.dev/"
              target="_blank"
              rel="noreferrer"
            >
              React Compiler Playground
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
