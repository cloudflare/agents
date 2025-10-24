import ReactDOM from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider
} from "react-router-dom";
import App from "./app";
import OAuthCallbackPage from "./components/OAuthCallbackPage";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <App />,
    path: "/"
  },
  {
    element: <OAuthCallbackPage />,
    path: "/oauth/callback"
  },
  {
    element: <Navigate to="/" replace />,
    path: "*"
  }
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />
);
