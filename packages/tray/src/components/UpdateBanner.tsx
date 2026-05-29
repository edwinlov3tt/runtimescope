interface Props {
  current: string | null;
  latest: string | null;
}

export function UpdateBanner({ current, latest }: Props) {
  return (
    <div className="update" role="alert">
      <svg
        className="update-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M8 1.5v9M4 7l4 4 4-4M2.5 14h11"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="update-text">
        <span className="update-label">Update available</span>
        <span className="update-versions">
          {current ?? '?'} → {latest ?? '?'}
        </span>
      </div>
    </div>
  );
}
