import type { ReactNode } from "react";

export const metadata = {
  title: "Magic Content",
  description: "Local content-intelligence dashboard for Instagram Reels.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
