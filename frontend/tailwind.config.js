/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["DM Sans", "system-ui", "sans-serif"],
        display: ["Outfit", "system-ui", "sans-serif"],
      },
      colors: {
        ink: {
          950: "#0a0c10",
          900: "#11141c",
          800: "#1a1f2e",
        },
        accent: {
          DEFAULT: "#6366f1",
          glow: "#818cf8",
        },
      },
      backgroundImage: {
        "grid-fade":
          "linear-gradient(to bottom, transparent, rgb(10 12 16)), radial-gradient(circle at 50% 0%, rgb(99 102 241 / 0.15), transparent 55%)",
      },
    },
  },
  plugins: [],
};
