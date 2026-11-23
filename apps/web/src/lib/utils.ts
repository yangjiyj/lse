import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind 友好的 className 合并（条件类 + 冲突消解）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
