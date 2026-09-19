import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "../../lib/cn";

export const Input = forwardRef(
  ({ label, error, hint, className, type = "text", icon: Icon, disabled, ...props }, ref) => {
    const [reveal, setReveal] = useState(false);
    const isPassword = type === "password";
    const resolvedType = isPassword && reveal ? "text" : type;

    return (
      <label className="block text-left">
        {label && (
          <span className="mb-1.5 block text-sm font-medium text-ink-700">{label}</span>
        )}
        <span className="relative flex items-center">
          {Icon && <Icon className="pointer-events-none absolute left-3 h-4 w-4 text-ink-400" />}
          <input
            ref={ref}
            type={resolvedType}
            disabled={disabled}
            className={cn(
              "h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-ink-900 placeholder:text-ink-400",
              "focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500",
              Icon && "pl-9",
              isPassword && "pr-9",
              error && "border-danger-600 focus:ring-danger-50",
              disabled && "cursor-not-allowed bg-surface-alt text-ink-500",
              className
            )}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setReveal((r) => !r)}
              className="absolute right-3 text-ink-400 hover:text-ink-700"
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
        </span>
        {error ? (
          <span className="mt-1.5 block text-xs text-danger-600">{error}</span>
        ) : hint ? (
          <span className="mt-1.5 block text-xs text-ink-500">{hint}</span>
        ) : null}
      </label>
    );
  }
);

Input.displayName = "Input";
export default Input;
