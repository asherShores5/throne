// Simple line icons for the 7 Bristol types (shapes, not emoji: they render the same everywhere).
import type { ReactElement } from "react";
// Decorative: the label next to each one is what VoiceOver reads.

const SHAPES: Record<number, ReactElement> = {
  1: (
    <>
      <circle cx="7" cy="11" r="3" /><circle cx="15" cy="8" r="2.6" /><circle cx="21" cy="13" r="3" /><circle cx="12" cy="19" r="2.8" />
    </>
  ),
  2: (
    <>
      <circle cx="6" cy="16" r="3.4" /><circle cx="11" cy="13" r="3.6" /><circle cx="17" cy="12" r="3.6" /><circle cx="22" cy="14" r="3.2" />
    </>
  ),
  3: (
    <>
      <rect x="3" y="10" width="22" height="8" rx="4" /><path d="M9 10v3M14 18v-3M19 10v3" strokeLinecap="round" />
    </>
  ),
  4: <path d="M3 18c4 0 4-8 9-8s5 8 10 8c2 0 3-1 3-2" strokeWidth="3.4" strokeLinecap="round" fill="none" />,
  5: (
    <>
      <ellipse cx="7" cy="15" rx="4" ry="3" /><ellipse cx="15" cy="11" rx="4" ry="3" /><ellipse cx="21" cy="17" rx="4" ry="3" />
    </>
  ),
  6: <path d="M4 18c0-3 2-4 4-4 0-3 3-5 6-4 2-2 6-1 6 2 3 0 5 2 4 5-1 2-3 2-5 2H7c-2 0-3-0-3-1z" />,
  7: (
    <>
      <path d="M3 20c0-2 5-3 11-3s11 1 11 3-5 3-11 3S3 22 3 20z" /><path d="M9 8c-1.5 2-2 3-2 4a2 2 0 0 0 4 0c0-1-.5-2-2-4zM18 5c-1.5 2-2 3-2 4a2 2 0 0 0 4 0c0-1-.5-2-2-4z" />
    </>
  ),
};

export function BristolIcon({ type }: { type: number }) {
  return (
    <svg className="bristol-icon" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      {SHAPES[type]}
    </svg>
  );
}
