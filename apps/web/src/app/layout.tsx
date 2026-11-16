import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CodeXray | Real-Time GitHub Architecture Visualizer & AI Code Reviewer',
  description:
    'Interactive AST dependency graph analyzer, circular dependency detector, and Gemini AI Senior Engineer code reviewer for GitHub repositories.',
  other: {
    'color-scheme': 'dark',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="color-scheme" content="dark" />
      </head>
      <body className="bg-zinc-950 text-zinc-100 antialiased selection:bg-cyan-500/30 selection:text-cyan-200">
        {children}
      </body>
    </html>
  );
}
