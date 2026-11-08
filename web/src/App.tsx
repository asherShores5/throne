import { useEffect, useState, useSyncExternalStore } from "react";
import { isSignedIn, onAuthChange } from "./auth";
import { loadConfig } from "./config";
import { Home } from "./views/Home";
import { Login } from "./views/Login";

export function App() {
  const [configured, setConfigured] = useState(false);
  const [configError, setConfigError] = useState<string>();
  const signedIn = useSyncExternalStore(onAuthChange, isSignedIn);

  useEffect(() => {
    loadConfig().then(() => setConfigured(true), (e) => setConfigError(String(e)));
  }, []);

  if (configError) return <div className="center">Couldn't load app config: {configError}</div>;
  if (!configured) return <div className="center">Loading…</div>;
  return signedIn ? <Home /> : <Login />;
}
