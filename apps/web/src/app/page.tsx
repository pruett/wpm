import { Suspense } from "react";
import { Dashboard } from "./dashboard";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";
import { LiveTicker } from "./live-ticker";

const authenticated = true;

export default function Home() {
  if (!authenticated) {
    return (
      <main>
        <h1>WPM</h1>
        <p>Wampum Prediction Markets</p>
      </main>
    );
  }

  return (
    <RealtimeProvider>
      <main>
        <h1>WPM</h1>
        <Suspense fallback={<p>Loading markets…</p>}>
          <Dashboard />
        </Suspense>
        <LiveTicker />
      </main>
    </RealtimeProvider>
  );
}
