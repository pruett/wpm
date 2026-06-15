import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wampum — Live Dashboard",
  description: "Live player stats, awards, and standings. Updated hourly.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
