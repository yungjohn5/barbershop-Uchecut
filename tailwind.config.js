/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        paper: '#F4F1EC',
        ink: '#141414',
        amber: { DEFAULT: '#B8833E', dark: '#9A6C31' },
      },
      fontFamily: {
        serif: ['Gloock', '"DM Serif Display"', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
