import { useCallback, useState } from 'react';

export interface FilterPill {
  key: string;
  label: string;
  value: string;
}

export function useFilters() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterPill[]>([]);

  const addFilter = useCallback((pill: FilterPill) => {
    setFilters((prev) => {
      const existing = prev.findIndex((f) => f.key === pill.key);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = pill;
        return next;
      }
      return [...prev, pill];
    });
  }, []);

  const removeFilter = useCallback((key: string) => {
    setFilters((prev) => prev.filter((f) => f.key !== key));
  }, []);

  const clearAll = useCallback(() => {
    setSearch('');
    setFilters([]);
  }, []);

  return { search, setSearch, filters, addFilter, removeFilter, clearAll };
}
