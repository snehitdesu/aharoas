import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg" | "xl";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50",
  secondary: "bg-white text-ink-900 border border-ink-300 hover:bg-ink-100 disabled:text-ink-500",
  ghost: "bg-transparent text-ink-700 hover:bg-ink-100 disabled:text-ink-300",
  danger: "bg-bad-500 text-white hover:bg-red-700 disabled:bg-bad-500/50",
  success: "bg-ok-500 text-white hover:bg-green-700 disabled:bg-ok-500/50",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-sm",
  md: "h-10 px-3.5 text-sm",
  lg: "h-12 px-4 text-base",
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
      className={`inline-flex select-none items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
});
