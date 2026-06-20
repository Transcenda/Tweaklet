import "./panel.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const el = document.getElementById("tweaklet-root");
if (el) createRoot(el).render(<StrictMode><App /></StrictMode>);
