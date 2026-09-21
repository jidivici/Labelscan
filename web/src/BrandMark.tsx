export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 100 100" role="presentation" focusable="false">
      <rect width="100" height="100" rx="18" fill="#087F72" />
      <path d="M27 40v-8a5 5 0 0 1 5-5h8M73 40v-8a5 5 0 0 0-5-5h-8M27 60v8a5 5 0 0 0 5 5h8M73 60v8a5 5 0 0 1-5 5h-8" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <path d="M37 38v24M44 38v24M50 38v24M58 38v24M65 38v24" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </svg>
    <span className="brand-scan-line" />
  </span>;
}
