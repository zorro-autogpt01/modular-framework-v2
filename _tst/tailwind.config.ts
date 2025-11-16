import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        slate: {
          50: '#F8FAFC',
          300: '#CBD5E1',
          400: '#94A3B8',
          500: '#64748B',
          600: '#475569',
          700: '#334155',
          800: '#1E293B',
          900: '#0F172A',
        },
        blue: {
          400: '#60A5FA',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
        },
        emerald: { 500: '#10B981' },
        amber: { 500: '#F59E0B' },
        red: { 500: '#EF4444' },
        green: { 500: '#22C55E', 900: '#052e16', 300: '#86efac' },
        yellow: { 500: '#EAB308', 900: '#422006', 300: '#fde68a' },
        purple: { 900: '#2e1065', 300: '#d8b4fe' }
      },
      boxShadow: {
        sm: '0 1px 3px rgba(0,0,0,0.3)',
        md: '0 4px 6px rgba(0,0,0,0.3)',
        lg: '0 10px 15px rgba(0,0,0,0.4)',
        xl: '0 20px 25px rgba(0,0,0,0.5)'
      },
      borderRadius: {
        sm: '4px',
        lg: '8px',
        xl: '12px',
      },
      zIndex: {
        0: '0', 10: '10', 20: '20', 30: '30', 40: '40', 50: '50'
      }
    }
  },
  plugins: []
} satisfies Config;
