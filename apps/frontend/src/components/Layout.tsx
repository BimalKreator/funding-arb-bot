import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { NotificationCenter } from './NotificationCenter';

interface LayoutProps {
  children: ReactNode;
}

function handleLogout() {
  localStorage.removeItem('token');
  window.location.reload();
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-white/5 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex max-w-[300px] shrink-0 items-center">
            <img src="/logo.png" alt="Logo" className="h-12 w-full object-contain object-left" />
          </div>
          <nav className="flex flex-wrap items-center gap-4">
            <span className="text-sm text-zinc-400">Arbitrage Bot</span>
            <NotificationCenter />
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-400 transition hover:bg-white/10 hover:text-zinc-200"
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
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
