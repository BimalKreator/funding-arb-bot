import type { ReactNode } from 'react';
import { NotificationCenter } from './NotificationCenter';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-white/5 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex shrink-0 items-center">
            <img src="/logo.png" alt="Logo" className="h-8 w-8 object-contain" />
          </div>
          <nav className="flex flex-wrap items-center gap-4">
            <span className="text-sm text-zinc-400">Arbitrage Bot</span>
            <NotificationCenter />
          </nav>
        </div>
      </header>
      <main className="flex-1">
        {children}
      </main>
      <footer className="border-t border-white/10 bg-white/5 py-4 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 text-center text-sm text-zinc-400 sm:px-6 lg:px-8">
          No trading logic — placeholder UI
        </div>
      </footer>
    </div>
  );
}
