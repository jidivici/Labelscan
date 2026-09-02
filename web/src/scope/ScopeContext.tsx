import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import { useSearchParams } from 'wouter';

import { useAuth } from '../auth/AuthContext';
import { PROFESSION_CODES, type ProfessionCode, type Store } from '../types';

interface ScopeContextValue {
  stores: Store[];
  storesLoading: boolean;
  selectedStoreCode: string;
  selectedProfessionCode: ProfessionCode | '';
  setSelectedStoreCode: (code: string) => void;
  setSelectedProfessionCode: (code: ProfessionCode | '') => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const stores = useMemo(
    () => session?.user.accessible_stores.filter((store) => store.active) ?? [],
    [session?.user.accessible_stores],
  );
  const selectedStoreCode = searchParams.get('store') ?? '';
  const professionParam = searchParams.get('profession_scope') ?? '';
  const selectedProfessionCode: ProfessionCode | '' = PROFESSION_CODES.includes(professionParam as ProfessionCode)
    ? professionParam as ProfessionCode
    : '';

  const setSelectedStoreCode = useCallback((code: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (code) next.set('store', code); else next.delete('store');
      next.delete('page');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setSelectedProfessionCode = useCallback((code: ProfessionCode | '') => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (code) next.set('profession_scope', code); else next.delete('profession_scope');
      next.delete('page');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const value = useMemo(() => ({
    stores,
    storesLoading: false,
    selectedStoreCode,
    selectedProfessionCode,
    setSelectedStoreCode,
    setSelectedProfessionCode,
  }), [selectedProfessionCode, selectedStoreCode, setSelectedProfessionCode, setSelectedStoreCode, stores]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const value = useContext(ScopeContext);
  if (!value) throw new Error('useScope must be used inside ScopeProvider');
  return value;
}
