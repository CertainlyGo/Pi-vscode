import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Store } from "./store";
import "./styles.css";

const store = new Store();

window.addEventListener("message", (event: MessageEvent) => {
  store.dispatch(event.data);
});

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
}
