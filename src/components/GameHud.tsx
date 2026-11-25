import { useEffect } from 'react';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  Lock,
  RotateCcw,
  Unlock,
  Wind,
} from 'lucide-react';
import type { HandHudStatus, HandTargetingHudSnapshot } from '../game/types';

interface GameHudProps {
  isPointerLocked: boolean;
  isExpanded: boolean;
  handTargeting: HandTargetingHudSnapshot;
  onToggleExpanded: () => void;
  onDropFromSky: () => void;
  onNudge: () => void;
  onResetBlocks: () => void;
  onTogglePointerLock: () => void;
}

function formatHandState(status: HandHudStatus): string {
  if (status.held) {
    if (status.mode === 'climb') return 'Climbing Ledge';
    if (status.mode === 'hang') return 'Hanging on Ledge';
    if (status.mode === 'push') return 'Pushing Block';
    if (status.mode === 'pull') return 'Pulling Block';
    return 'Holding Block';
  }
  if (status.locked) {
    return status.surfaceKind === 'ledge' ? 'Ledge Ready' : 'Target Ready';
  }
  if (status.outOfReach) return 'Out of Reach';
  if (status.active) return 'Aiming';
  return 'Idle';
}

export function GameHud({
  isPointerLocked,
  isExpanded,
  handTargeting,
  onToggleExpanded,
  onDropFromSky,
  onNudge,
  onResetBlocks,
  onTogglePointerLock,
}: GameHudProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (event.key === 'h' || event.key === 'H') {
        onToggleExpanded();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggleExpanded]);

  const anyHandActive = handTargeting.left.active || handTargeting.right.active;
  const bothLocked = handTargeting.left.locked && handTargeting.right.locked;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between p-5 sm:p-6">
      {/* Top-Left Minimal Wordmark & Quiet Hand Target Readout (Zero pills, zero pulsing dots) */}
      <header className="flex items-start justify-between">
        <div className="pointer-events-auto">
          <h1
            className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Wobblepeak
          </h1>
          <p className="mt-0.5 text-xs font-medium text-slate-700">
            Observatory Terrace · Grab, Push, Pull &amp; Climb
          </p>
          {(anyHandActive || handTargeting.hoverInReach) && (
            <div
              className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-medium text-slate-800"
              aria-live="polite"
            >
              {handTargeting.left.active && (
                <span
                  className={
                    handTargeting.left.held || handTargeting.left.locked
                      ? 'text-blue-700 font-semibold'
                      : handTargeting.left.outOfReach
                        ? 'text-slate-600'
                        : 'text-slate-800'
                  }
                >
                  Left Hand: {formatHandState(handTargeting.left)}
                </span>
              )}
              {handTargeting.left.active && handTargeting.right.active && (
                <span className="text-slate-400" aria-hidden="true">·</span>
              )}
              {handTargeting.right.active && (
                <span
                  className={
                    handTargeting.right.held || handTargeting.right.locked
                      ? 'text-orange-700 font-semibold'
                      : handTargeting.right.outOfReach
                        ? 'text-slate-600'
                        : 'text-slate-800'
                  }
                >
                  Right Hand: {formatHandState(handTargeting.right)}
                </span>
              )}
              {!anyHandActive && handTargeting.hoverInReach && (
                <span className="text-amber-800">
                  {handTargeting.hoverKind === 'ledge'
                    ? 'Ledge in reach · Hold LMB / RMB to grab, WASD to shimmy, Space to climb up'
                    : 'Block in reach · Hold LMB / RMB to push, pull, or lift'}
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Subtle Center Aim Reticle (only shown in Pointer-Lock free-look mode) */}
      {isPointerLocked && (
        <div
          className="pointer-events-none fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          aria-hidden="true"
        >
          <div
            className={`h-3 w-3 rounded-full border-2 transition-transform duration-150 ${
              bothLocked
                ? 'scale-125 border-emerald-600 bg-emerald-500/30'
                : handTargeting.left.locked
                  ? 'scale-115 border-blue-600 bg-blue-500/25'
                  : handTargeting.right.locked
                    ? 'scale-115 border-orange-600 bg-orange-500/25'
                    : handTargeting.hoverInReach
                      ? 'scale-110 border-amber-500 bg-amber-400/20'
                      : 'border-slate-900/65 bg-white/60'
            }`}
          />
        </div>
      )}

      {/* Bottom-Center Collapsible Control Dock (Zero Viewport Occlusion, no backdrop-filter over WebGL) */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          className="pointer-events-auto mb-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-900/12 bg-white/92 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors duration-150 hover:bg-white hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
        >
          {isExpanded ? (
            <>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Hide Controls</span>
            </>
          ) : (
            <>
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Show Controls</span>
            </>
          )}
        </button>

        <div
          className={`pointer-events-auto w-auto max-w-[94vw] transition-all duration-200 ease-out ${
            isExpanded
              ? 'translate-y-0 opacity-100'
              : 'pointer-events-none translate-y-6 opacity-0 hidden'
          }`}
        >
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-slate-900/12 bg-white/94 px-4 py-3 shadow-lg">
            {/* Compact Movement & Hand Targeting Controls Guide */}
            <div
              className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-xs text-slate-700"
              aria-label="Controls guide"
            >
              <span className="whitespace-nowrap">
                <strong className="font-semibold text-slate-900">WASD</strong> — Move
              </span>
              <span className="text-slate-300" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <strong className="font-semibold text-slate-900">SHIFT</strong> — Run
              </span>
              <span className="text-slate-300" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <strong className="font-semibold text-slate-900">SPACE</strong> — Jump / Pull Up
              </span>
              <span className="text-slate-300" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <strong className="font-semibold text-blue-700">LMB / Q</strong> — Left Grab
              </span>
              <span className="text-slate-300" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <strong className="font-semibold text-orange-700">RMB / E</strong> — Right Grab
              </span>
            </div>

            <div className="h-px w-full bg-slate-900/8" aria-hidden="true" />

            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onDropFromSky}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-blue-700 active:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Drop from Sky</span>
              </button>

              <button
                type="button"
                onClick={onNudge}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-900/12 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-800 transition-colors duration-150 hover:bg-slate-100 active:bg-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
              >
                <Wind className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Nudge Character</span>
              </button>

              <button
                type="button"
                onClick={onResetBlocks}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-900/12 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-800 transition-colors duration-150 hover:bg-slate-100 active:bg-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset Blocks</span>
              </button>

              <div className="mx-0.5 hidden h-5 w-px bg-slate-900/12 sm:block" aria-hidden="true" />

              <button
                type="button"
                onClick={onTogglePointerLock}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0 ${
                  isPointerLocked
                    ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800'
                    : 'border-slate-900/12 bg-slate-50 text-slate-800 hover:bg-slate-100'
                }`}
              >
                {isPointerLocked ? (
                  <>
                    <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Unlock Camera</span>
                  </>
                ) : (
                  <>
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Lock Camera</span>
                  </>
                )}
              </button>
            </div>

            <p className="text-center text-xs text-slate-500">
              Hold LMB/RMB to grab blocks or ledges · WASD to shimmy while hanging · Space to pull up onto ledges · Press H to hide dock
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
