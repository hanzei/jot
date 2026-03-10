/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        keep: {
          yellow: '#fbbc04',
          red: '#ea4335',
          green: '#34a853',
          blue: '#4285f4',
          purple: '#9aa0a6',
        }
      }
    },
  },
  plugins: [],
}