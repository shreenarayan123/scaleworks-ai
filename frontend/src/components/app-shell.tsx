import { Link, useRouterState } from '@tanstack/react-router';
import { AudioLines, Headphones, Settings2, CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: s => s.location.pathname });
  return <div className="app-shell">
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="brand-symbol"><AudioLines size={21}/></span>Callertone<span className="brand-dot">.</span></Link>
      <div className="workspace"><span className="workspace-icon">W</span><div><strong>My workspace</strong></div></div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        <Button asChild variant="ghost" className={`nav-item ${pathname !== '/settings' ? 'nav-active' : ''}`}><Link to="/"><Headphones/>Calls</Link></Button>
        <Button asChild variant="ghost" className={`nav-item ${pathname === '/settings' ? 'nav-active' : ''}`}><Link to="/settings"><Settings2/>Settings</Link></Button>
      </nav>
      <div className="sidebar-bottom"><div className="profile"><span className="avatar">JD</span><div><strong>Jamie Davis</strong></div></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div><span className="breadcrumb-workspace">Workspace</span><span className="breadcrumb-divider">/</span><span>{pathname === '/settings' ? 'Settings' : pathname === '/' ? 'Calls' : 'Call review'}</span></div><span className="topbar-caption"><CircleHelp size={15}/>Your conversations, a little clearer.</span></header>{children}<footer className="app-footer"><span>Callertone</span><span>Better conversations. Stronger relationships.</span></footer></div>
  </div>;
}
