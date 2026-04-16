import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "WPM",
  description: "Wampum Prediction Markets",
};

export default function RootLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <html lang="en" className={cn("dark", "font-sans", inter.variable)}>
      <body className={`${inter.variable} ${geistMono.variable} font-sans antialiased`}>
        {children}
        {modal}
      </body>
    </html>
  );
}
