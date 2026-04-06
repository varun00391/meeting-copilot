import { Outlet } from "react-router-dom";
import { NavBar } from "./NavBar";

export function Layout() {
  return (
    <div className="min-h-screen bg-ink-950">
      <NavBar />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
