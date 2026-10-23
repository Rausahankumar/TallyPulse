import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import Table from "../ui/Table";
import Select from "../ui/Select";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import { TableSkeleton } from "../ui/Skeleton";

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Generic server-side-paginated, server-side-searched report table —
// same interaction model as VoucherRegister (search box, page-size
// select, Prev/Next) but parameterized over `columns` so it can render
// the Product and Customer reports' different row shapes, without
// touching VoucherRegister itself (that component stays exactly as
// built for the Sales/Purchase Invoices tabs).
export default function ReportTable({
  columns,
  rowKey,
  searchPlaceholder,
  emptyTitle,
  emptyMessage,
  search,
  onSearchChange,
  limit,
  onLimitChange,
  page,
  onPageChange,
  state, // { data, pagination, loading, error }
}) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 w-full rounded-lg border border-surface-border bg-white pl-9 pr-8 text-[13px] text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>

        <Select
          value={String(limit)}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          className="!h-9 w-auto min-w-[90px]"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </Select>
      </div>

      {state.error ? (
        <div className="rounded-xl border border-danger-50 bg-danger-50 px-4 py-6 text-center text-[13px] text-danger-600">
          Couldn't load the report: {state.error.message}
        </div>
      ) : state.loading ? (
        <TableSkeleton />
      ) : state.data.length === 0 ? (
        <EmptyState
          title={search ? "Nothing matches your search" : emptyTitle}
          description={search ? `Nothing matches "${search}" in this range.` : emptyMessage}
        />
      ) : (
        <>
          <Table rowKey={rowKey} rows={state.data} columns={columns} />

          {state.pagination && state.pagination.totalPages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-500">
              <span>
                Page {state.pagination.page} of {state.pagination.totalPages} ·{" "}
                {state.pagination.total.toLocaleString("en-IN")} total
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ChevronLeft}
                  disabled={page <= 1}
                  onClick={() => onPageChange(Math.max(1, page - 1))}
                >
                  Prev
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= state.pagination.totalPages}
                  onClick={() => onPageChange(Math.min(state.pagination.totalPages, page + 1))}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
