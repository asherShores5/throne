import { useEffect, useState, useSyncExternalStore } from "react";
import { isSignedIn, onAuthChange } from "./auth";
import { loadConfig } from "./config";
import { navigateMessage } from "./deepLink";
import { navigate, usePath } from "./route";
import { Home } from "./views/Home";
import { Join } from "./views/Join";
import { Login } from "./views/Login";
import { Settings } from "./views/Settings";
import { SummaryScreen } from "./views/summary/SummaryScreen";

export function App() {
  const [configured, setConfigured] = useState(false);
  const [configError, setConfigError] = useState<string>();
  const signedIn = useSyncExternalStore(onAuthChange, isSignedIn);
  const path = usePath();

  // A tapped push while the app is open: the service worker says where to go (sw/sw.ts).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const to = navigateMessage(e.data);
      if (to) navigate(to);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    loadConfig().then(() => setConfigured(true), (e) => setConfigError(String(e)));
  }, []);

  if (configError) return <div className="center">Couldn't load app config: {configError}</div>;
  if (!configured) return <div className="center">Loading…</div>;
  // An Invite link stays on the landing page through sign-up (which signs in), until it moves on itself.
  if (path === "/invite") return <Join />;
  if (!signedIn) return <Login />;
  if (path === "/settings") return <Settings />;
  if (path === "/summary") return <SummaryScreen />;
  return <Home view={path === "/calendar" ? "calendar" : path === "/friends" ? "friends" : "log"} />;
}
