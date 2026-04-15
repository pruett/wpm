import { Suspense } from "react";
import { Dashboard } from "./dashboard";

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
    <main>
      <h1>WPM</h1>
      <Suspense fallback={<p>Loading markets…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}
