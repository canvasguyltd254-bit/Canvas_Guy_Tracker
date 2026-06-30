import "./globals.css";

export const metadata = {
  title: "Canvas Guy Limited — Production Tracker",
  description: "Internal order and production management system",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
