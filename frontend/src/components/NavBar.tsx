import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/", label: "Home" },
  { to: "/copilot", label: "Copilot" },
  { to: "/usage", label: "Token usage" },
];

export function NavBar() {
  const loc = useLocation();
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link to="/" className="font-display text-lg font-semibold tracking-tight text-white">
          Meeting<span className="text-accent-glow">Copilot</span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          {links.map(({ to, label }) => {
            const active = loc.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-white/10 text-white"
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
