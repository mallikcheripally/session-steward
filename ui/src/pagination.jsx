import { ChevronLeft, ChevronRight } from "lucide-react";

export default function Pagination({ page, pages, numbers, setPage, disabled = false }) {
  return <div className="pagination"><span>Page <strong>{page}</strong> of {pages}</span><div className="flex items-center gap-1"><button aria-label="Previous page" disabled={disabled || page === 1} onClick={() => setPage(page - 1)} className="page-button"><ChevronLeft size={15}/></button><div className="hidden items-center gap-1 sm:flex">{numbers.map((number) => <button key={number} disabled={disabled} onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined} className="page-button">{number}</button>)}</div><button aria-label="Next page" disabled={disabled || page === pages} onClick={() => setPage(page + 1)} className="page-button"><ChevronRight size={15}/></button></div></div>;
}
