import { Suspense, lazy, useEffect } from "react";
import { ConnectionBanner, Toasts, TopBar } from "./components/Chrome";
import { useAccentSync } from "./components/accent";
import { useRoute, type Route } from "./lib/route";
import { useApp } from "./live/store";
import { HomeScreen } from "./screens/HomeScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { OfflineScreen } from "./screens/OfflineScreen";

// Secondary screens load on demand, keeping the first load small (06: ≤ 250 KB gzipped).
const LampScreen = lazy(() => import("./screens/LampScreen"));
const ScenesScreen = lazy(() => import("./screens/ScenesScreen"));
const SchedulesScreen = lazy(() => import("./screens/SchedulesScreen"));
const ActivityScreen = lazy(() => import("./screens/ActivityScreen"));
const SettingsScreen = lazy(() => import("./screens/SettingsScreen"));

const TITLES: Record<Route["name"], string> = {
  home: "DoubleLamp",
  lamp: "Lamp · DoubleLamp",
  scenes: "Scenes · DoubleLamp",
  schedules: "Schedules · DoubleLamp",
  activity: "Activity · DoubleLamp",
  settings: "Settings · DoubleLamp",
};

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <HomeScreen />;
    case "lamp":
      return <LampScreen id={route.id} />;
    case "scenes":
      return <ScenesScreen />;
    case "schedules":
      return <SchedulesScreen />;
    case "activity":
      return <ActivityScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}

function Shell() {
  const route = useRoute();
  const lampName = useApp((s) => (route.name === "lamp" ? s.devices[route.id]?.name : undefined));
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);
  useEffect(() => {
    document.title = lampName ? `${lampName} · DoubleLamp` : TITLES[route.name];
  }, [route, lampName]);
  return (
    <>
      <TopBar route={route} />
      <ConnectionBanner />
      <main id="main" className={route.name === "home" ? "page page-home" : "page"}>
        <Suspense fallback={<p className="muted loading">Loading…</p>}>
          <Screen route={route} />
        </Suspense>
      </main>
    </>
  );
}

export function App() {
  const auth = useApp((s) => s.auth);
  useAccentSync();
  return (
    <>
      {auth === "checking" ? (
        <p className="boot" role="status">
          Loading DoubleLamp…
        </p>
      ) : auth === "offline" ? (
        <OfflineScreen />
      ) : auth === "login" ? (
        <LoginScreen />
      ) : (
        <Shell />
      )}
      <Toasts />
    </>
  );
}
