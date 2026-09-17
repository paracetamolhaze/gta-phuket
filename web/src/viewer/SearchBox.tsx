/** Debounced search over GET /api/ext/search. Picking a result flies the map. */

import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../shared/api';
import { viewerMessage } from '../shared/api';
import { categoryLabel, formatDistance } from '../shared/format';
import type { SearchResult } from '../shared/types';

const DEBOUNCE_MS = 350;
const MIN_QUERY = 2;

interface SearchResponse {
  results?: SearchResult[];
}

export interface SearchBoxProps {
  api: ApiClient;
  /** False until the Twitch JWT is in hand. */
  enabled: boolean;
  onSelect: (result: SearchResult) => void;
}

export default function SearchBox({ api, enabled, onSelect }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < MIN_QUERY) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .get<SearchResponse>(`/api/ext/search?q=${encodeURIComponent(q)}`, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          setResults(payload.results ?? []);
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setResults([]);
          setError(viewerMessage(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, api]);

  useEffect(() => {
    const onDocDown = (event: MouseEvent): void => {
      const node = boxRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const choose = (result: SearchResult): void => {
    setOpen(false);
    setQuery(result.name);
    onSelect(result);
  };

  const showPanel = open && query.trim().length >= MIN_QUERY;

  return (
    <div className="search" ref={boxRef}>
      <svg className="searchIcon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M15.8 15.8 21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <input
        className="searchInput"
        type="search"
        inputMode="search"
        autoComplete="off"
        spellCheck={false}
        placeholder="Куда отправить стримера?"
        aria-label="Поиск места"
        value={query}
        disabled={!enabled}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (event.key === 'Enter') {
            const first = results[0];
            if (first) choose(first);
          }
        }}
      />
      {query.length > 0 && (
        <button
          type="button"
          className="searchClear"
          aria-label="Очистить"
          onClick={() => {
            setQuery('');
            setResults([]);
            setOpen(false);
          }}
        >
          ×
        </button>
      )}

      {showPanel && (
        <div className="searchPanel panel scroll-thin" role="listbox">
          {loading && <div className="searchNote">Ищем…</div>}
          {!loading && error && <div className="searchNote searchNote--bad">{error}</div>}
          {!loading && !error && results.length === 0 && <div className="searchNote">Ничего не нашли</div>}
          {results.map((result) => {
            const label = categoryLabel(result.category);
            return (
              <button
                key={result.id}
                type="button"
                role="option"
                aria-selected={false}
                className="searchRow"
                onClick={() => choose(result)}
              >
                <span className="searchRowMain">
                  <span className="searchRowName">{result.name}</span>
                  {(label ?? result.address) && (
                    <span className="searchRowMeta">
                      {label}
                      {label && result.address ? ' · ' : ''}
                      {result.address}
                    </span>
                  )}
                </span>
                {result.approxDistanceMeters !== null && (
                  <span className="searchRowDist num">≈ {formatDistance(result.approxDistanceMeters)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
