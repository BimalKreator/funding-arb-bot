import type { ReactNode } from 'react';
import { NotificationCenter } from './NotificationCenter';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-white/5 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <h1 className="text-lg font-semibold text-white sm:text-xl">
            Funding Arb Bot
          </h1>
          <nav className="flex items-center gap-4">
            <span className="text-sm text-zinc-400">Screener</span>
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
