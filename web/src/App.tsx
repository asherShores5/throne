import { useEffect, useState, useSyncExternalStore } from "react";
import { isSignedIn, onAuthChange } from "./auth";
import { loadConfig } from "./config";
import { usePath } from "./route";
import { Home } from "./views/Home";
import { Join } from "./views/Join";
import { Login } from "./views/Login";
import { Settings } from "./views/Settings";

export function App() {
  const [configured, setConfigured] = useState(false);
  const [configError, setConfigError] = useState<string>();
  const signedIn = useSyncExternalStore(onAuthChange, isSignedIn);
  const path = usePath();

  useEffect(() => {
    loadConfig().then(() => setConfigured(true), (e) => setConfigError(String(e)));
  }, []);

  if (configError) return <div className="center">Couldn't load app config: {configError}</div>;
  if (!configured) return <div className="center">Loading…</div>;
  // An Invite link stays on the landing page through sign-up (which signs in), until it moves on itself.
  if (path === "/invite") return <Join />;
  if (!signedIn) return <Login />;
  return path === "/settings" ? <Settings /> : <Home />;
}
