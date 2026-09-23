import { useEffect, useRef, useState } from "react";
import { Search, X, ChevronLeft, ChevronRight } from "lucide-react";
import Table from "../ui/Table";
import Select from "../ui/Select";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import { TableSkeleton } from "../ui/Skeleton";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { formatCurrency } from "../../lib/format";

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Shared server-side-paginated, server-side-searched voucher list, used
// for both the Sales Invoices tab and the Purchase Bills tab — only the
// fetcher function and the "party" column label differ between the two.
//
// `fetcher({page, limit, search})` must return
// `{data, pagination: {page, limit, total, totalPages}}` — see
// api/vouchers.js. Nothing here fetches the whole collection: every
// page turn and every search keystroke (after debounce) is a fresh,
// tenant-scoped, paginated backend request.
export default function VoucherRegister({ fetcher, partyLabel, emptyMessage }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 350);

  const [state, setState] = useState({ data: [], pagination: null, loading: true, error: null });
  const requestIdRef = useRef(0);

  // Fetching a page of vouchers from the backend whenever page/limit/
  // search changes - synchronizing with an external system, the
  // documented case this lint rule allows an effect for (see the same
  // justified suppression in context/CompanyContext.jsx).
  useEffect(() => {
    const id = ++requestIdRef.current;
    // oxlint-disable-next-line react/set-state-in-effect
    setState((s) => ({ ...s, loading: true, error: null }));

    fetcher({ page, limit, search: debouncedSearch || undefined })
      .then((res) => {
        if (id !== requestIdRef.current) return; // a newer request already landed
        setState({ data: res.data, pagination: res.pagination, loading: false, error: null });
      })
      .catch((error) => {
        if (id !== requestIdRef.current) return;
        setState({ data: [], pagination: null, loading: false, error });
      });
    // A response for a stale request (page/search changed again, or the
    // component unmounted) is ignored above via the id check - nothing
    // to cancel client-side, but no stale response can ever overwrite
    // newer state.
  }, [fetcher, page, limit, debouncedSearch]);

  function handleSearchChange(value) {
    setSearchInput(value);
    setPage(1); // search changing always resets to page 1
  }

  function clearSearch() {
    setSearchInput("");
    setPage(1);
  }

  const pagination = state.pagination;
  const columns = [
    { key: "voucherNo", header: "Voucher No" },
    {
      key: "voucherDate",
      header: "Date",
      render: (r) => (r.voucherDate ? new Date(r.voucherDate).toLocaleDateString("en-GB") : "—"),
    },
    { key: "partyName", header: partyLabel },
    { key: "amount", header: "Amount", align: "right", render: (r) => formatCurrency(r.amount) },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={`Search by voucher no., ${partyLabel.toLowerCase()} or amount…`}
            className="h-9 w-full rounded-lg border border-surface-border bg-white pl-9 pr-8 text-[13px] text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500"
          />
          {searchInput && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>

        <Select
          value={String(limit)}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            setPage(1);
          }}
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
          Couldn't load vouchers: {state.error.message}
        </div>
      ) : state.loading ? (
        <TableSkeleton />
      ) : state.data.length === 0 ? (
        <EmptyState
          title={debouncedSearch ? "No vouchers match your search" : "No vouchers yet"}
          description={
            debouncedSearch
              ? `Nothing matches "${debouncedSearch}". Try a different voucher number, name or amount.`
              : emptyMessage
          }
        />
      ) : (
        <>
          <Table rowKey="tallyGuid" rows={state.data} columns={columns} />

          {pagination && pagination.totalPages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-500">
              <span>
                Page {pagination.page} of {pagination.totalPages} · {pagination.total.toLocaleString("en-IN")} total
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ChevronLeft}
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
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
