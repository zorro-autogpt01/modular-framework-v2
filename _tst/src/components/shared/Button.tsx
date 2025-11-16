import { clsx } from '@utils/helpers';
import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export default function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: PropsWithChildren<Props>) {
  const base = 'inline-flex items-center justify-center rounded-lg transition-colors focus-ring disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }[size];
  const variants = {
    primary: 'bg-blue-600 hover:bg-blue-700 text-white',
    secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-200'
  }[variant];
  return (
    <button className={clsx(base, sizes, variants, className)} {...rest}>
      {children}
    </button>
  );
}
