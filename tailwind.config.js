/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#F4F1EC', deep: '#EAE4DA' },
        ink: { DEFAULT: '#141414', soft: '#2A2622' },
        amber: { DEFAULT: '#B8833E', dark: '#9A6C31', light: '#D9A863' },
        stone: { DEFAULT: '#8B7662' },
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
