import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cloudflare Agents",
  description:
    "Build agents on Cloudflare—the platform designed for durable execution, serverless inference, and pricing that scales up (and down).",
  twitter: {
    card: "summary_large_image",
    description:
      "Build agents on Cloudflare—the platform designed for durable execution, serverless inference, and pricing that scales up (and down).",
    title: "Cloudflare Agents"
  },
  metadataBase: new URL("https://agents.cloudflare.com/")
};

const sans = localFont({
  src: [
    {
      path: "./_fonts/InterVariable.woff2",
      style: "normal"
    },
    {
      path: "./_fonts/InterVariable-Italic.woff2",
      style: "italic"
    }
  ],
  variable: "--font-sans"
});

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`antialiased ${sans.className}`}>{children}</body>
    </html>
  );
}
