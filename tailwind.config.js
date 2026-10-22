/** @type {import('tailwindcss').Config} */
// Theme colours are CSS variables (space-separated RGB) set in src/styles/input.css, so
// `bg-paper`, `text-ink/60` etc. follow light/dark mode. `night` and `cream` never change:
// use them where a colour must stay put (dark text on amber, shades over photos).
const themed = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: ['./src/views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: themed('paper'), deep: themed('paper-deep') },
        ink: { DEFAULT: themed('ink'), soft: themed('ink-soft') },
        surface: themed('surface'),
        amber: { DEFAULT: '#B8833E', dark: themed('amber-dark'), light: '#D9A863' },
        stone: { DEFAULT: themed('stone') },
        night: '#141414',
        cream: '#F4F1EC',
      },
      fontFamily: {
        serif: ['Gloock', '"DM Serif Display"', 'Georgia', 'serif'],
        accent: ['"DM Serif Display"', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        display: ['clamp(2.75rem, 7.2vw, 7.25rem)', { lineHeight: '0.98', letterSpacing: '-0.02em' }],
        title: ['clamp(2.25rem, 4.6vw, 4.5rem)', { lineHeight: '1.02', letterSpacing: '-0.015em' }],
      },
      transitionTimingFunction: {
        expo: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
