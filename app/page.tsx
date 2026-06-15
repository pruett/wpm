// Revalidate the dashboard once per hour (ISR). When deployed to Vercel this
// regenerates the page in the background every 3600s; data wiring comes later.
export const revalidate = 3600;

const panelStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 20,
};

export default function DashboardPage() {
  const updatedAt = new Date().toISOString();

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: "48px 24px 80px",
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 34, margin: 0, letterSpacing: -0.5 }}>
          Wampum <span style={{ color: "var(--accent)" }}>Live</span>
        </h1>
        <p style={{ color: "var(--muted)", margin: "8px 0 0" }}>
          Player stats, awards, and standings — refreshed hourly.
        </p>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 12 }}>
          Last generated: <time dateTime={updatedAt}>{updatedAt}</time>
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        }}
      >
        <div style={panelStyle}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Player Stats</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Coming soon — live leaderboard pulled from the betting database.
          </p>
        </div>

        <div style={panelStyle}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Awards</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Coming soon — weekly and season awards.
          </p>
        </div>

        <div style={panelStyle}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Standings</h2>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Coming soon — circle and overall rankings.
          </p>
        </div>
      </section>
    </main>
  );
}
