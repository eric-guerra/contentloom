export const metadata = { title: 'ContentLoom review' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body style={{ margin: 0, fontFamily: 'system-ui', background: '#f6f7f9' }}>{children}</body></html>;
}
