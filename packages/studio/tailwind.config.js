/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        'app-bg': 'var(--bg-app)',
        'panel-bg': 'var(--bg-panel)',
        'card-bg': 'var(--bg-card)',
        primary: 'var(--color-primary)',
        secondary: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
      },
    },
  },
  plugins: [],
}
