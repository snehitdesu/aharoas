import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success" | "accent";
type Size = "sm" | "md" | "lg" | "xl";

const VARIANTS: Record<Variant, string> = {
  // Moonstone primary — the default call to action.
  primary: "bg-brand-600 text-white shadow-xs hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-600/40 disabled:shadow-none",
  // Neutral surface button.
  secondary: "bg-white text-ink-800 border border-ink-300 shadow-xs hover:bg-ink-50 hover:border-ink-400 active:bg-ink-100 disabled:text-ink-400 disabled:shadow-none",
  ghost: "bg-transparent text-ink-700 hover:bg-ink-100 active:bg-ink-200 disabled:text-ink-300",
  danger: "bg-bad-500 text-white shadow-xs hover:bg-bad-600 active:bg-bad-700 disabled:bg-bad-500/40 disabled:shadow-none",
  success: "bg-ok-500 text-white shadow-xs hover:bg-ok-600 active:bg-ok-700 disabled:bg-ok-500/40 disabled:shadow-none",
  // Vanilla highlight — reserved for premium / high-value emphasis actions.
  accent: "bg-vanilla-200 text-ink-900 shadow-xs hover:bg-vanilla-300 active:bg-vanilla-400 disabled:bg-vanilla-200/50 disabled:text-ink-400 disabled:shadow-none",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-sm",
  md: "h-[2.375rem] px-3.5 text-sm",
  lg: "h-11 px-4 text-[0.95rem]",
  xl: "h-14 px-5 text-base", // touch targets on POS action bar
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", loading = false, disabled, className = "", children, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex select-none items-center justify-center gap-2 rounded-md font-medium tracking-[-0.01em] outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 active:translate-y-px disabled:cursor-not-allowed disabled:active:translate-y-0 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
});
